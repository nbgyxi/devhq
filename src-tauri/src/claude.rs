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

/// The turn a window currently has in flight, so it can be interrupted.
///
/// One per window: a workspace has a single chat, and a second question while
/// the first is still answering replaces it rather than racing it.
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
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
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
    /// One line of the CLI's stream, unparsed. The front end owns the schema:
    /// it is Anthropic's, it grows, and a field this file does not know about
    /// is not a reason to drop the line.
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Ended {
    window: String,
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
    // A question asked while the last one is still answering replaces it.
    let _ = claude_cancel(window.clone()).await;

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
        running().lock().unwrap().insert(window.clone(), child);

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
                        line,
                    },
                );
            }
        }

        let code = running()
            .lock()
            .unwrap()
            .remove(&window)
            .and_then(|mut child| child.wait().ok())
            .and_then(|status| status.code())
            .unwrap_or(-1);
        let error = errors.join().unwrap_or_default();
        let _ = app.emit(
            "claude:end",
            Ended {
                window,
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
pub async fn claude_cancel(window: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(mut child) = running().lock().unwrap().remove(&window) {
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
