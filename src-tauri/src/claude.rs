//! Claude Code as a chat panel rather than a terminal.
//!
//! The workspace used to run the CLI's own interface in a pseudoconsole, which
//! meant a full-screen terminal app folded into a 50-column pane: theme
//! pickers, box drawing and wrapped banners, none of which anyone asked for.
//! This drives the same CLI through its machine-readable mode instead - one
//! JSON object per line - and the workspace renders the conversation itself.
//!
//! Two things are deliberate and must stay that way:
//!
//! - **`--bare` is never passed.** Bare mode reads neither the OAuth
//!   credentials nor the system keychain, so it only works with an API key in
//!   the environment. The entire point of driving the user's own CLI is that
//!   they are signed in as themselves and WinT never sees a key.
//! - **The prompt goes in on stdin, never as an argument.** Every argument
//!   here is fixed text or a session id, so nothing anyone types has to survive
//!   a round trip through `cmd.exe`'s parser.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The turn a tab currently has in flight, so it can be interrupted.
///
/// One per tab: a workspace can hold several Claude conversations open at
/// once (several tabs), and a second question in the *same* tab while the
/// first is still answering replaces it - but a question in another tab must
/// not touch this one.
fn running() -> &'static Mutex<std::collections::HashMap<String, Child>> {
    static RUNNING: OnceLock<Mutex<std::collections::HashMap<String, Child>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn claude_path() -> Option<PathBuf> {
    crate::term::claude_program()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    installed: bool,
    path: String,
    version: String,
}

/// Whether the CLI is here, and which one. The version doubles as a liveness
/// check: a shim on PATH that cannot actually run is not an install.
#[tauri::command]
pub async fn claude_status() -> ClaudeStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(path) = claude_path() else {
            return ClaudeStatus {
                installed: false,
                path: String::new(),
                version: String::new(),
            };
        };
        let version = command(&path)
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| crate::term::version_line(&String::from_utf8_lossy(&out.stdout)))
            .unwrap_or_default();
        ClaudeStatus {
            installed: !version.is_empty(),
            path: path.to_string_lossy().into_owned(),
            version,
        }
    })
    .await
    .unwrap_or(ClaudeStatus {
        installed: false,
        path: String::new(),
        version: String::new(),
    })
}

/// A command that runs `path`, whatever kind of file it is.
///
/// npm installs a CLI as a `.cmd` shim, which `CreateProcess` cannot start; an
/// `.exe` must not be wrapped, because that would leave a `cmd.exe` between us
/// and the process whose output we are reading. Nothing user-typed is ever
/// passed as an argument, so the wrapped form has nothing to misparse.
fn command(path: &std::path::Path) -> Command {
    let script = path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));
    let mut cmd = if script {
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/d").arg("/c").arg(path);
        cmd
    } else {
        Command::new(path)
    };
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Line {
    window: String,
    /// Which tab this turn belongs to, so a window with several Claude tabs
    /// open can route the line to the right conversation.
    tab: String,
    /// One line of the CLI's stream, unparsed. The front end owns the schema:
    /// it is Anthropic's, it grows, and a field this file does not know about
    /// is not a reason to drop the line.
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Ended {
    window: String,
    tab: String,
    code: i32,
    /// Anything the CLI wrote to stderr. Empty on a clean run; on a failed one
    /// it is the only place the reason exists.
    error: String,
}

/// Asks Claude one question and streams the answer back as events.
///
/// Returns as soon as the child is running - the conversation arrives on
/// `claude:line` and finishes with `claude:end`, so a turn that takes two
/// minutes does not sit inside a command that long.
#[tauri::command]
pub async fn claude_send(
    app: AppHandle,
    window: String,
    tab: String,
    prompt: String,
    cwd: String,
    session: Option<String>,
    resume: bool,
    permission_mode: Option<String>,
) -> Result<(), String> {
    let Some(path) = claude_path() else {
        return Err("Claude Code is not installed.".into());
    };
    if !std::path::Path::new(&cwd).is_dir() {
        return Err("That folder no longer exists.".into());
    }
    // A question asked in this tab while the last one is still answering
    // replaces it; a question in another tab is untouched.
    let _ = claude_cancel(tab.clone()).await;

    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = command(&path);
        cmd.current_dir(&cwd)
            .arg("-p")
            .arg("--output-format")
            .arg("stream-json")
            // `stream-json` carries only the result without it.
            .arg("--verbose")
            .arg("--include-partial-messages")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // The workspace mints the id and hands it over, rather than reading one
        // back off the stream. That is what lets the same conversation be
        // opened in a terminal and come back here: both name it.
        if let Some(id) = session.as_deref().filter(|id| is_session_id(id)) {
            cmd.arg(if resume { "--resume" } else { "--session-id" })
                .arg(id);
        }
        if let Some(mode) = permission_mode
            .as_deref()
            .filter(|mode| matches!(*mode, "acceptEdits" | "auto" | "dontAsk" | "plan"))
        {
            cmd.arg("--permission-mode").arg(mode);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not start Claude Code: {e}"))?;

        // The prompt goes in whole and the pipe is closed, which is what tells
        // the CLI the turn is complete. Nothing typed is ever an argument.
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes());
        }

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        running().lock().unwrap().insert(tab.clone(), child);

        // stderr on its own thread: a run that fails before it says anything on
        // stdout says why here, and a full pipe nobody drains would wedge it.
        let errors = std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(stderr) = stderr {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    text.push_str(&line);
                    text.push('\n');
                }
            }
            text
        });

        if let Some(stdout) = stdout {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                let _ = app.emit(
                    "claude:line",
                    Line {
                        window: window.clone(),
                        tab: tab.clone(),
                        line,
                    },
                );
            }
        }

        let code = running()
            .lock()
            .unwrap()
            .remove(&tab)
            .and_then(|mut child| child.wait().ok())
            .and_then(|status| status.code())
            .unwrap_or(-1);
        let error = errors.join().unwrap_or_default();
        let _ = app.emit(
            "claude:end",
            Ended {
                window,
                tab,
                code,
                error,
            },
        );
        Ok(())
    })
    .await
    .unwrap_or_else(|_| Err("Claude Code stopped unexpectedly.".into()))
}

/// The command line that opens a conversation in a real terminal.
///
/// `--resume` takes a session id in the interactive interface as well as in
/// `-p`, and looks for it across every project on the machine - which is what
/// makes the chat and a terminal two views of one conversation rather than two
/// conversations. The way out of anything the chat cannot do is the CLI itself:
/// approving a command it wants to run, signing in, a slash command, plan mode.
#[tauri::command]
pub fn claude_terminal_command(session: Option<String>) -> Result<String, String> {
    let path = claude_path().ok_or("Claude Code is not installed.")?;
    let quoted = format!("\"{}\"", path.display());
    let program = if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
    {
        // A shim is a script, so it needs the interpreter - and the whole line
        // has to be quoted again, because `cmd /c` strips one layer.
        format!("cmd.exe /d /k \"{quoted}\"")
    } else {
        quoted
    };
    match session.as_deref().filter(|id| is_session_id(id)) {
        Some(id) => Ok(format!("{program} --resume {id}")),
        None => Ok(program),
    }
}

/// Session ids come back from the CLI and go straight out again; this is the
/// gate that keeps `--resume` from ever carrying something else.
fn is_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[tauri::command]
pub async fn claude_cancel(tab: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(mut child) = running().lock().unwrap().remove(&tab) {
            let _ = child.kill();
            let _ = child.wait();
        }
    })
    .await
    .map_err(|_| "Could not stop that turn.".to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    window: String,
    line: String,
    done: bool,
    ok: bool,
}

/// Installs the CLI with npm, reporting as it goes.
///
/// This is the whole of what WinT does about installing: it runs the published
/// command and shows the output. Signing in is Claude's own job and happens the
/// first time the CLI runs.
#[tauri::command]
pub async fn claude_install(app: AppHandle, window: String) -> Result<(), String> {
    let npm = crate::term::find_program_on_path(&["npm.cmd", "npm.exe", "npm"])
        .ok_or("Node.js is not installed, so npm cannot run. Install Node.js from nodejs.org.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = command(&npm)
            .arg("install")
            .arg("-g")
            .arg("@anthropic-ai/claude-code")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not run npm: {e}"))?;

        let say = |line: String, done: bool, ok: bool| {
            let _ = app.emit(
                "claude:install",
                InstallProgress {
                    window: window.clone(),
                    line,
                    done,
                    ok,
                },
            );
        };

        // npm says most of what it says on stderr, so both are followed and
        // both are shown - the distinction means nothing to whoever is reading.
        let stderr = child.stderr.take();
        let app2 = app.clone();
        let window2 = window.clone();
        let errors = std::thread::spawn(move || {
            if let Some(stderr) = stderr {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let _ = app2.emit(
                        "claude:install",
                        InstallProgress {
                            window: window2.clone(),
                            line,
                            done: false,
                            ok: true,
                        },
                    );
                }
            }
        });
        if let Some(stdout) = child.stdout.take() {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                say(line, false, true);
            }
        }
        let ok = child.wait().map(|s| s.success()).unwrap_or(false);
        let _ = errors.join();
        say(String::new(), true, ok);
        Ok(())
    })
    .await
    .unwrap_or_else(|_| Err("The install stopped unexpectedly.".into()))
}

/* ------------------------------------------------------- previous chats */

// The CLI keeps every conversation as a JSONL transcript under
// `~/.claude/projects/<the cwd, punctuation turned to dashes>/<session id>.jsonl`.
// Reading them is what lets the panel offer the conversations this project has
// had before - the ones held in a terminal included, since both surfaces are
// the same CLI writing to the same place.

/// The folder the CLI keeps this project's transcripts in.
///
/// The name is the working directory with every character that is not a letter
/// or a digit turned into a dash, so `C:\code\devhq` becomes `C--code-devhq`.
/// Windows hands the name back in whatever case it was created with, so the
/// folder is matched case-insensitively rather than trusted to be spelled the
/// same way twice.
fn transcript_dir(cwd: &str) -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from)?;
    let projects = home.join(".claude").join("projects");
    let slug: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let exact = projects.join(&slug);
    if exact.is_dir() {
        return Some(exact);
    }
    std::fs::read_dir(&projects)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case(&slug))
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSession {
    id: String,
    /// The first thing the person actually typed, which is what a conversation
    /// is remembered by. Empty when there is nothing in it but tool noise.
    title: String,
    /// Last write, in milliseconds since the epoch. The front end owns how a
    /// date is spelled, because it owns the language the window is in.
    modified: u64,
    /// How many questions were asked, so an afternoon's work does not look the
    /// same in the list as one abandoned line.
    turns: u32,
}

/// One transcript line, matched on the few fields this needs. The rest of the
/// schema is large and growing, and is ignored rather than parsed.
#[derive(serde::Deserialize)]
struct Entry {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    message: Option<serde_json::Value>,
    #[serde(default, rename = "isMeta")]
    is_meta: bool,
    /// The name the CLI gave the conversation itself, on its own line. It is
    /// written again as the conversation goes on, so the last one is the one
    /// that has read the most of it.
    #[serde(default, rename = "aiTitle")]
    ai_title: Option<String>,
}

/// The text blocks of a message, whether its content is a bare string or the
/// list of blocks. A tool result is not something anybody said, so it is not
/// one of them.
fn text_blocks(message: &serde_json::Value) -> Vec<&str> {
    match message.get("content") {
        Some(serde_json::Value::String(text)) => vec![text.as_str()],
        Some(serde_json::Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
            .collect(),
        _ => Vec::new(),
    }
}

fn message_text(message: &serde_json::Value) -> String {
    text_blocks(message).join("\n\n")
}

/// What the person actually typed.
///
/// A question reaches the CLI wrapped in blocks nobody wrote by hand - the
/// file open in the editor, the reminders injected into a turn - and the
/// typed one is somewhere among them, not necessarily first. So the envelopes
/// are dropped one block at a time; judging the message by how it starts
/// throws away every question asked with a file open.
fn spoken_text(message: &serde_json::Value) -> String {
    text_blocks(message)
        .into_iter()
        .filter(|block| is_spoken(block))
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Whether a block of user text is something the person typed, rather than one
/// of the envelopes the CLI wraps around it: IDE notices, slash command
/// plumbing, the reminders injected into a turn.
fn is_spoken(text: &str) -> bool {
    let text = text.trim();
    !text.is_empty() && !text.starts_with('<') && !text.starts_with("Caveat:")
}

/// The conversations this project has had, newest first.
#[tauri::command]
pub async fn claude_sessions(cwd: String) -> Vec<ClaudeSession> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(dir) = transcript_dir(&cwd) else {
            return Vec::new();
        };
        let mut sessions: Vec<ClaudeSession> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
            })
            .filter_map(|entry| {
                let path = entry.path();
                let id = path.file_stem()?.to_str()?.to_string();
                if !is_session_id(&id) {
                    return None;
                }
                let modified = entry
                    .metadata()
                    .ok()?
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|since| since.as_millis() as u64)
                    .unwrap_or(0);
                let (title, turns) = summarise(&path);
                Some(ClaudeSession {
                    id,
                    title,
                    modified,
                    turns,
                })
            })
            .collect();
        sessions.sort_by_key(|session| std::cmp::Reverse(session.modified));
        sessions.truncate(40);
        sessions
    })
    .await
    .unwrap_or_default()
}

/// What a transcript is called and how big it is.
///
/// Transcripts run to megabytes and this reads one per conversation in the
/// list, so it goes line by line rather than slurping the file, and stops
/// counting once the number has stopped being worth showing.
fn summarise(path: &std::path::Path) -> (String, u32) {
    let Ok(file) = std::fs::File::open(path) else {
        return (String::new(), 0);
    };
    // The CLI names conversations itself, and its name is better than the
    // first thing anybody typed - it has read the whole thing. The first
    // question is what stands in until it has.
    let mut named = String::new();
    let mut first = String::new();
    let mut turns = 0u32;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(entry) = serde_json::from_str::<Entry>(&line) else {
            continue;
        };
        if entry.is_meta {
            continue;
        }
        if let Some(title) = entry.ai_title.filter(|title| !title.trim().is_empty()) {
            named = title.trim().to_string();
            continue;
        }
        if entry.kind != "user" {
            continue;
        }
        let Some(message) = entry.message.as_ref() else {
            continue;
        };
        let text = spoken_text(message);
        if text.is_empty() {
            continue;
        }
        turns += 1;
        if first.is_empty() {
            first = text.split_whitespace().collect::<Vec<_>>().join(" ");
            first.truncate(160);
        }
    }
    let mut title = if named.is_empty() { first } else { named };
    title.truncate(160);
    (title, turns)
}

/// One turn of a past conversation, in the shape the panel draws.
#[derive(Serialize)]
pub struct ClaudeTurn {
    role: String,
    text: String,
}

/// A past conversation, replayed into the chat log.
///
/// Only what the panel can draw: what was asked and what was answered. The
/// tool calls are left out - live they say the work is moving, but a week
/// later they are noise between the answers.
#[tauri::command]
pub async fn claude_transcript(cwd: String, session: String) -> Result<Vec<ClaudeTurn>, String> {
    if !is_session_id(&session) {
        return Err("That is not a conversation.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let path = transcript_dir(&cwd)
            .map(|dir| dir.join(format!("{session}.jsonl")))
            .filter(|path| path.is_file())
            .ok_or("That conversation is no longer on disk.")?;
        let file = std::fs::File::open(&path).map_err(|e| format!("Could not read it: {e}"))?;
        let mut turns: Vec<ClaudeTurn> = Vec::new();
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(entry) = serde_json::from_str::<Entry>(&line) else {
                continue;
            };
            if entry.is_meta {
                continue;
            }
            let Some(message) = entry.message.as_ref() else {
                continue;
            };
            match entry.kind.as_str() {
                "user" => {
                    let text = spoken_text(message);
                    if text.is_empty() {
                        continue;
                    }
                    turns.push(ClaudeTurn {
                        role: "you".into(),
                        text,
                    });
                }
                "assistant" if !message_text(message).trim().is_empty() => {
                    let text = message_text(message);
                    // One answer arrives as several blocks; the panel drew them
                    // as a single bubble when it was live, so it does here too.
                    match turns.last_mut() {
                        Some(last) if last.role == "claude" => {
                            last.text.push_str("\n\n");
                            last.text.push_str(&text);
                        }
                        _ => turns.push(ClaudeTurn {
                            role: "claude".into(),
                            text,
                        }),
                    }
                }
                _ => {}
            }
        }
        Ok(turns)
    })
    .await
    .unwrap_or_else(|_| Err("Could not read that conversation.".into()))
}
