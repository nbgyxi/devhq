//! `wint-term-host.exe`: WinT's terminal engine with no window, driven over
//! stdio by the VS Code extension in `vscode-extension/`.
//!
//! One request per line on stdin, `{"id":1,"cmd":"open","args":{…}}`, answered
//! by one line on stdout, `{"id":1,"ok":…}` or `{"id":1,"error":"…"}`. Events
//! from the sessions arrive on the same stream between the replies, as
//! `{"event":"term:update","payload":{…}}` - the names and payloads the
//! terminal view already listens for inside WinT.
//!
//! The sessions belong to this process. When stdin closes - VS Code reloaded,
//! closed, or its extension host died - every shell is ended and the process
//! exits. What they printed is kept, so the panel can reopen them with their
//! scrollback.

use std::io::{BufRead, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wint_term::session::{self, Event, Launch, OpenArgs};

#[derive(Deserialize)]
struct Request {
    id: u64,
    cmd: String,
    #[serde(default)]
    args: Value,
}

#[derive(Deserialize)]
struct Id {
    id: String,
}

#[derive(Deserialize)]
struct Keystroke {
    id: String,
    data: String,
}

#[derive(Deserialize)]
struct Resize {
    id: String,
    cols: usize,
    rows: usize,
}

#[derive(Deserialize)]
struct Keys {
    keys: Vec<String>,
}

#[derive(Serialize)]
struct Reply<'a, T: Serialize> {
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    ok: Option<&'a T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

#[derive(Serialize)]
struct EventLine<'a, T: Serialize> {
    event: &'a str,
    payload: &'a T,
}

/// Writes one line, whole. The stdout lock is held for the line and the flush,
/// so a reply and an event written from two threads never interleave.
fn send(value: &impl Serialize) {
    let Ok(mut line) = serde_json::to_vec(value) else {
        return;
    };
    line.push(b'\n');
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(&line);
    let _ = out.flush();
}

fn reply<T: Serialize>(id: u64, result: Result<T, String>) {
    match result {
        Ok(value) => send(&Reply {
            id,
            ok: Some(&value),
            error: None,
        }),
        Err(message) => send(&Reply::<()> {
            id,
            ok: None,
            error: Some(&message),
        }),
    }
}

fn args<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| format!("Bad request: {e}"))
}

fn sink() -> session::Sink {
    std::sync::Arc::new(|event: Event| {
        let event_name = event.name();
        match &event {
            Event::Update(update) => send(&EventLine {
                event: event_name,
                payload: update,
            }),
            Event::Exit(info) => send(&EventLine {
                event: event_name,
                payload: info,
            }),
            Event::Serving(serving) => send(&EventLine {
                event: event_name,
                payload: serving,
            }),
            Event::PortTaken(taken) => send(&EventLine {
                event: event_name,
                payload: taken,
            }),
        }
    })
}

/// Everything but a keystroke. These can block - starting a process, waiting
/// for a resize to land, tearing a console down - so each runs on a thread of
/// its own and the next line on stdin is read straight away.
fn handle(request: Request) {
    let Request { id, cmd, args: raw } = request;
    match cmd.as_str() {
        "open" => reply(
            id,
            args::<OpenArgs>(raw).and_then(|open| session::open(open, Launch::default(), sink())),
        ),
        "attach" => reply(id, args::<Id>(raw).and_then(|a| session::attach(&a.id))),
        "info" => reply(id, args::<Id>(raw).and_then(|a| session::info(&a.id))),
        "serving" => reply(id, args::<Id>(raw).map(|a| session::serving(&a.id))),
        "resize" => reply(
            id,
            args::<Resize>(raw).and_then(|a| {
                let done = session::resize(&a.id, a.cols, a.rows)?;
                let _ = done.recv();
                Ok(())
            }),
        ),
        "close" => reply(
            id,
            args::<Id>(raw).map(|a| {
                session::close(&a.id);
            }),
        ),
        "list" => reply(id, Ok(session::list())),
        "shells" => reply(id, Ok(wint_term::shell::availability())),
        "history" => reply(id, Ok(wint_term::command_history::read())),
        "prune" => reply(
            id,
            args::<Keys>(raw).map(|a| wint_term::history::prune(&a.keys)),
        ),
        other => reply::<()>(id, Err(format!("Unknown command: {other}"))),
    }
}

/// The stream folder named on the command line, if it is one: a relative path
/// of plain names, so it can only ever land under WinT's own folder.
fn history_folder(mut argv: impl Iterator<Item = String>) -> String {
    let mut folder = String::from("vscode-sessions");
    while let Some(arg) = argv.next() {
        if arg != "--history-folder" {
            continue;
        }
        if let Some(name) = argv.next() {
            let plain = name.split(['/', '\\']).all(|part| {
                !part.is_empty()
                    && part
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            });
            if plain {
                folder = name;
            }
        }
    }
    folder
}

fn main() {
    // VS Code started from inside a WinT terminal inherits that terminal's
    // variables, and so would every shell here. They would send `wt` splits
    // to a WinT window that has nothing to do with this panel.
    for name in ["WINT_TERM_ID", "WINT_APP", "WINT_WT_QUEUE"] {
        std::env::remove_var(name);
    }
    // WinT prunes every stream in its own folder that it does not know, and
    // so does the panel. Each keeps to its own - and each VS Code workspace to
    // its own too, which the extension says by naming the folder:
    // `--history-folder vscode-sessions/<workspace>`.
    wint_term::history::set_folder(history_folder(std::env::args().skip(1)));

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(_) => continue,
        };
        // A keystroke is handled here, in the order it was read: handing it
        // to a thread would let two of them reach the shell the wrong way
        // round. It only posts to the session's queue, so it never blocks.
        if request.cmd == "write" {
            let id = request.id;
            reply(
                id,
                args::<Keystroke>(request.args)
                    .and_then(|a| session::write(&a.id, a.data.into_bytes())),
            );
            continue;
        }
        std::thread::spawn(move || handle(request));
    }
    session::shutdown();
}
