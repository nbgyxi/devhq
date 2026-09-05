//! Cursor Agent as a chat panel rather than a terminal.
//!
//! The same bargain as [`crate::claude`]: the workspace drives the CLI the
//! person already installed, through its machine-readable mode, and renders
//! the conversation itself. WinT asks for no API key and stores none — the
//! CLI signs in as them (`agent login`) and this process never sees a token.
//!
//! Two things are deliberate and must stay that way:
//!
//! - **No `CURSOR_API_KEY` is set.** The assistant's cloud path can use a
//!   key the user pasted into Settings. This panel must not: it is the
//!   user's Cursor, signed in as them, the way the Claude panel is their
//!   Claude Code.
//! - **The prompt goes in on stdin, never as an argument.** Every argument
//!   here is fixed text or a session id, so nothing anyone types has to
//!   survive a round trip through `cmd.exe`'s parser.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The turn a tab currently has in flight, so it can be interrupted.
fn running() -> &'static Mutex<std::collections::HashMap<String, Child>> {
    static RUNNING: OnceLock<Mutex<std::collections::HashMap<String, Child>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// How the CLI is actually started: the installed `node.exe` plus `index.js`
/// when they are there, otherwise whatever `agent` is on PATH.
///
/// npm-style `.cmd` shims are not used in print mode. `CreateProcess` cannot
/// start them, and wrapping them in `cmd.exe` would leave a process between
/// us and the one whose output we are reading.
pub fn agent_command() -> (Command, String) {
    if let Some(found) = find_agent() {
        return found.command();
    }
    (Command::new("agent.exe"), "`agent`".into())
}

struct FoundAgent {
    node: PathBuf,
    script: PathBuf,
}

impl FoundAgent {
    fn command(&self) -> (Command, String) {
        let label = format!("{} (the installed `agent` CLI)", self.node.display());
        let mut command = Command::new(&self.node);
        command.arg(&self.script).env("CURSOR_INVOKED_AS", "agent");
        (command, label)
    }
}

fn find_agent() -> Option<FoundAgent> {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    let versions = local.join("cursor-agent").join("versions");
    let latest = std::fs::read_dir(&versions).ok()?.flatten().filter(|entry| {
        let path = entry.path();
        path.is_dir() && path.join("node.exe").is_file() && path.join("index.js").is_file()
    }).max_by_key(|entry| entry.file_name())?;
    Some(FoundAgent {
        node: latest.path().join("node.exe"),
        script: latest.path().join("index.js"),
    })
}

/// The `.cmd` shim the interactive interface is started through. A pane needs
/// a real console; the shim is what Cursor installed for that.
fn agent_shim() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|local| local.join("cursor-agent").join("agent.cmd"))
        .filter(|path| path.is_file())
        .or_else(|| crate::term::find_program_on_path(&["agent.cmd", "cursor-agent.cmd", "agent.exe"]))
}

fn silent(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorStatus {
    installed: bool,
    path: String,
    version: String,
    signed_in: bool,
    email: String,
}

/// Whether the CLI is here, which one, and whether it is signed in.
///
/// The version doubles as a liveness check. Sign-in is a separate question:
/// an install that cannot talk to Cursor yet is still an install, and the
/// panel offers `agent login` rather than pretending nothing is there.
#[tauri::command]
pub async fn cursor_status() -> CursorStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(found) = find_agent() else {
            return CursorStatus {
                installed: false,
                path: String::new(),
                version: String::new(),
                signed_in: false,
                email: String::new(),
            };
        };
        let (mut version_cmd, _) = found.command();
        let version = silent(&mut version_cmd)
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| crate::term::version_line(&String::from_utf8_lossy(&out.stdout)))
            .unwrap_or_default();
        if version.is_empty() {
            return CursorStatus {
                installed: false,
                path: found.node.to_string_lossy().into_owned(),
                version: String::new(),
                signed_in: false,
                email: String::new(),
            };
        }
        let (mut status_cmd, _) = found.command();
        let status = silent(&mut status_cmd)
            .args(["status", "--format", "json"])
            .stdin(Stdio::null())
            .output()
            .ok()
            .and_then(|out| serde_json::from_slice::<serde_json::Value>(&out.stdout).ok());
        let signed_in = status
            .as_ref()
            .and_then(|value| value.get("isAuthenticated"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let email = status
            .as_ref()
            .and_then(|value| value.pointer("/userInfo/email"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        CursorStatus {
            installed: true,
            path: found.node.to_string_lossy().into_owned(),
            version,
            signed_in,
            email,
        }
    })
    .await
    .unwrap_or(CursorStatus {
        installed: false,
        path: String::new(),
        version: String::new(),
        signed_in: false,
        email: String::new(),
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Line {
    window: String,
    tab: String,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Ended {
    window: String,
    tab: String,
    code: i32,
    error: String,
}

/// Asks Cursor one question and streams the answer back as events.
///
/// Returns as soon as the child is running — the conversation arrives on
/// `cursor:line` and finishes with `cursor:end`.
#[tauri::command]
pub async fn cursor_send(
    app: AppHandle,
    window: String,
    tab: String,
    prompt: String,
    cwd: String,
    session: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    if find_agent().is_none() {
        return Err("Cursor Agent is not installed.".into());
    }
    if !Path::new(&cwd).is_dir() {
        return Err("That folder no longer exists.".into());
    }
    let _ = cursor_cancel(tab.clone()).await;

    tauri::async_runtime::spawn_blocking(move || {
        let session = session
            .filter(|id| is_session_id(id))
            .or_else(|| create_chat(&cwd).ok());

        let (mut cmd, how) = agent_command();
        silent(&mut cmd)
            .current_dir(&cwd)
            .arg("--print")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--stream-partial-output")
            // Edits land without a prompt, and so do commands, because in this
            // mode there is nobody to ask. The way to be asked is the CLI's
            // own interface, on this same conversation.
            .arg("--force")
            .arg("--trust")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(id) = session.as_deref() {
            cmd.arg("--resume").arg(id);
        }
        if let Some(model) = model.as_deref().filter(|model| is_model_id(model)) {
            cmd.arg("--model").arg(model);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not start Cursor Agent using {how}: {e}"))?;

        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes());
        }

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        running().lock().unwrap().insert(tab.clone(), child);

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
                    "cursor:line",
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
            "cursor:end",
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
    .unwrap_or_else(|_| Err("Cursor Agent stopped unexpectedly.".into()))
}

/// Mints a conversation id the CLI will actually accept.
///
/// The workspace used to invent a UUID and hand it over, the way Claude
/// Code's `--session-id` works. Cursor's print mode has no equivalent — it
/// only resumes ids it created — so an empty chat is opened first and the
/// id comes back.
fn create_chat(cwd: &str) -> Result<String, String> {
    let (mut cmd, how) = agent_command();
    let output = silent(&mut cmd)
        .current_dir(cwd)
        .arg("create-chat")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Could not start a Cursor conversation using {how}: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        for key in ["id", "session_id", "chatId", "chat_id"] {
            if let Some(id) = value.get(key).and_then(serde_json::Value::as_str).filter(|id| is_session_id(id)) {
                return Ok(id.to_string());
            }
        }
    }
    stdout
        .split_whitespace()
        .find(|token| is_session_id(token))
        .map(str::to_string)
        .ok_or_else(|| {
            let err = String::from_utf8_lossy(&output.stderr);
            let reason = err.trim();
            if reason.is_empty() {
                "Cursor Agent did not return a conversation id.".into()
            } else {
                reason.to_string()
            }
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorLaunch {
    command: String,
    session: String,
}

/// The command line that opens a conversation in a real terminal.
///
/// `--resume` is how the chat and the CLI's own interface stay the same
/// conversation. Signing in is a different command (`login`) and does not
/// need a session.
#[tauri::command]
pub async fn cursor_terminal_command(
    cwd: String,
    session: Option<String>,
    login: bool,
    model: Option<String>,
) -> Result<CursorLaunch, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if login {
            return Ok(CursorLaunch {
                command: terminal_command("login")?,
                session: session.filter(|id| is_session_id(id)).unwrap_or_default(),
            });
        }
        let id = session
            .filter(|id| is_session_id(id))
            .map(Ok)
            .unwrap_or_else(|| create_chat(&cwd))?;
        let model_arg = model.as_deref().filter(|model| is_model_id(model))
            .map(|model| format!(" --model {model}")).unwrap_or_default();
        Ok(CursorLaunch {
            command: terminal_command(&format!("--resume {id}{model_arg}"))?,
            session: id,
        })
    })
    .await
    .unwrap_or_else(|_| Err("Could not prepare Cursor's terminal.".into()))
}

fn is_model_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 100
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// A command line ConPTY can start. Extra arguments have to live *inside*
/// the `cmd /k` string when the CLI is a `.cmd` shim, or they are eaten by
/// `cmd.exe` and the pane opens onto Cursor with no conversation.
fn terminal_command(args: &str) -> Result<String, String> {
    let extra = if args.is_empty() { String::new() } else { format!(" {args}") };
    if let Some(shim) = agent_shim() {
        let path = shim.display();
        if shim
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        {
            return Ok(format!("cmd.exe /d /k \"\"{path}\"{extra}\""));
        }
        return Ok(format!("\"{path}\"{extra}"));
    }
    let found = find_agent().ok_or("Cursor Agent is not installed.")?;
    Ok(format!(
        "cmd.exe /d /k \"set CURSOR_INVOKED_AS=agent&& \"{}\" \"{}\"{extra}\"",
        found.node.display(),
        found.script.display()
    ))
}

fn is_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[tauri::command]
pub async fn cursor_cancel(tab: String) -> Result<(), String> {
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

/// Installs the CLI the way Cursor publishes it, reporting as it goes.
///
/// This is the whole of what WinT does about installing: it runs the
/// published command and shows the output. Signing in is Cursor's own job.
#[tauri::command]
pub async fn cursor_install(app: AppHandle, window: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("powershell.exe");
        silent(&mut cmd)
            .arg("-NoLogo")
            .arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-Command")
            .arg("irm 'https://cursor.com/install?win32=true' | iex")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not run the Cursor Agent installer: {e}"))?;

        let say = |line: String, done: bool, ok: bool| {
            let _ = app.emit(
                "cursor:install",
                InstallProgress {
                    window: window.clone(),
                    line,
                    done,
                    ok,
                },
            );
        };

        let stderr = child.stderr.take();
        let app2 = app.clone();
        let window2 = window.clone();
        let errors = std::thread::spawn(move || {
            if let Some(stderr) = stderr {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let _ = app2.emit(
                        "cursor:install",
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

// The CLI keeps every conversation under `~/.cursor/chats/<hash>/<id>/`,
// with a `meta.json` (title, dates, the folder it belonged to) and a
// `prompt_history.json` (what was actually typed). Reading those is what
// lets the panel offer the conversations this project has had before —
// including ones held in a terminal, since both surfaces are the same CLI.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorSession {
    id: String,
    title: String,
    modified: u64,
    turns: u32,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    #[serde(default)]
    title: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    has_conversation: bool,
    #[serde(default)]
    updated_at_ms: u64,
    #[serde(default)]
    created_at_ms: u64,
}

fn chats_root() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".cursor").join("chats"))
}

fn same_cwd(meta: &str, cwd: &str) -> bool {
    let a: String = meta.chars().map(|c| if c == '/' { '\\' } else { c }).flat_map(char::to_lowercase).collect();
    let b: String = cwd.chars().map(|c| if c == '/' { '\\' } else { c }).flat_map(char::to_lowercase).collect();
    a.trim_end_matches('\\') == b.trim_end_matches('\\')
}

fn prompt_history(dir: &Path) -> Vec<String> {
    let path = dir.join("prompt_history.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<String>>(&text)
        .unwrap_or_default()
        .into_iter()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

/// The conversations this project has had, newest first.
#[tauri::command]
pub async fn cursor_sessions(cwd: String) -> Vec<CursorSession> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(root) = chats_root() else {
            return Vec::new();
        };
        let Ok(hashes) = std::fs::read_dir(&root) else {
            return Vec::new();
        };
        let mut sessions: Vec<CursorSession> = hashes
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .flat_map(|hash| std::fs::read_dir(hash.path()).into_iter().flatten().flatten())
            .filter_map(|entry| {
                let dir = entry.path();
                if !dir.is_dir() {
                    return None;
                }
                let id = dir.file_name()?.to_str()?.to_string();
                if !is_session_id(&id) {
                    return None;
                }
                let meta: Meta = serde_json::from_str(&std::fs::read_to_string(dir.join("meta.json")).ok()?).ok()?;
                if !meta.cwd.is_empty() && !same_cwd(&meta.cwd, &cwd) {
                    return None;
                }
                let prompts = prompt_history(&dir);
                if !meta.has_conversation && prompts.is_empty() {
                    return None;
                }
                let title = if meta.title.trim().is_empty() {
                    prompts.first().cloned().unwrap_or_else(|| "Untitled conversation".into())
                } else {
                    meta.title
                };
                let mut title = title.split_whitespace().collect::<Vec<_>>().join(" ");
                title.truncate(160);
                Some(CursorSession {
                    id,
                    title,
                    modified: if meta.updated_at_ms > 0 { meta.updated_at_ms } else { meta.created_at_ms },
                    turns: prompts.len().min(999) as u32,
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

#[derive(Serialize)]
pub struct CursorTurn {
    role: String,
    text: String,
}

/// A past conversation, replayed into the chat log.
///
/// Only the questions: the CLI keeps the answers in a sqlite file this
/// does not open, and they are still in the conversation `--resume` picks
/// up. Live, the answers are drawn as they arrive.
#[tauri::command]
pub async fn cursor_transcript(cwd: String, session: String) -> Result<Vec<CursorTurn>, String> {
    if !is_session_id(&session) {
        return Err("That is not a conversation.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(root) = chats_root() else {
            return Err("Cursor's conversations are not on this computer.".into());
        };
        let Ok(hashes) = std::fs::read_dir(&root) else {
            return Err("Could not read Cursor's conversations.".into());
        };
        for hash in hashes.flatten() {
            let dir = hash.path().join(&session);
            if !dir.is_dir() {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(dir.join("meta.json")) {
                if let Ok(meta) = serde_json::from_str::<Meta>(&text) {
                    if !meta.cwd.is_empty() && !same_cwd(&meta.cwd, &cwd) {
                        continue;
                    }
                }
            }
            let turns = prompt_history(&dir)
                .into_iter()
                .map(|text| CursorTurn {
                    role: "you".into(),
                    text,
                })
                .collect();
            return Ok(turns);
        }
        Err("That conversation is no longer on disk.".into())
    })
    .await
    .unwrap_or_else(|_| Err("Could not read that conversation.".into()))
}
