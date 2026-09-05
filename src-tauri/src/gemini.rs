//! Google Gemini CLI as a chat panel rather than a terminal.
//!
//! The same bargain as [`crate::claude`] and [`crate::cursor`]: the workspace
//! drives the CLI the person already installed, through its machine-readable
//! mode, and renders the conversation itself. WinT asks for no API key and
//! stores none — the CLI signs in as them and this process never sees a token.
//!
//! Two things are deliberate and must stay that way:
//!
//! - **No `GEMINI_API_KEY` / `GOOGLE_API_KEY` is set.** The panel is their
//!   Gemini CLI, authenticated as them.
//! - **The prompt goes in on stdin, never as an argument.** Every argument
//!   here is fixed text or a session id, so nothing anyone types has to
//!   survive a round trip through `cmd.exe`'s parser.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn running() -> &'static Mutex<std::collections::HashMap<String, Child>> {
    static RUNNING: OnceLock<Mutex<std::collections::HashMap<String, Child>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn gemini_path() -> Option<PathBuf> {
    crate::term::find_program_on_path(&["gemini.exe", "gemini.cmd", "gemini.bat"]).or_else(|| {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|roaming| roaming.join("npm").join("gemini.cmd"))
            .filter(|path| path.is_file())
    })
}

fn command(path: &Path) -> Command {
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiStatus {
    installed: bool,
    path: String,
    version: String,
}

#[tauri::command]
pub async fn gemini_status() -> GeminiStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(path) = gemini_path() else {
            return GeminiStatus {
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
        GeminiStatus {
            installed: !version.is_empty(),
            path: path.to_string_lossy().into_owned(),
            version,
        }
    })
    .await
    .unwrap_or(GeminiStatus {
        installed: false,
        path: String::new(),
        version: String::new(),
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

/// Asks Gemini one question and streams the answer back as events.
#[tauri::command]
pub async fn gemini_send(
    app: AppHandle,
    window: String,
    tab: String,
    prompt: String,
    cwd: String,
    session: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    let Some(path) = gemini_path() else {
        return Err("Gemini CLI is not installed.".into());
    };
    if !Path::new(&cwd).is_dir() {
        return Err("That folder no longer exists.".into());
    }
    let _ = gemini_cancel(tab.clone()).await;

    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = command(&path);
        cmd.current_dir(&cwd)
            .arg("--output-format")
            .arg("stream-json")
            // Edits and commands land without a prompt, because in this mode
            // there is nobody to ask. The way to be asked is the CLI itself.
            .arg("--yolo")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(id) = session.as_deref().filter(|id| is_session_id(id)) {
            cmd.arg("--resume").arg(id);
        }
        if let Some(model) = model.as_deref().filter(|model| is_model_id(model)) {
            cmd.arg("--model").arg(model);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not start Gemini CLI: {e}"))?;

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
                    "gemini:line",
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
            "gemini:end",
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
    .unwrap_or_else(|_| Err("Gemini CLI stopped unexpectedly.".into()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiLaunch {
    command: String,
    session: String,
}

fn terminal_command(path: &Path, args: &str) -> String {
    let extra = if args.is_empty() {
        String::new()
    } else {
        format!(" {args}")
    };
    let display = path.display();
    if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
    {
        format!("cmd.exe /d /k \"\"{display}\"{extra}\"")
    } else {
        format!("\"{display}\"{extra}")
    }
}

#[tauri::command]
pub async fn gemini_terminal_command(
    session: Option<String>,
    login: bool,
    model: Option<String>,
) -> Result<GeminiLaunch, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = gemini_path().ok_or("Gemini CLI is not installed.")?;
        // Auth is interactive inside the CLI (`/auth` or first-run login).
        // Opening the CLI itself is the sign-in path.
        let id = session.filter(|id| is_session_id(id)).unwrap_or_default();
        let model_arg = model.as_deref().filter(|model| is_model_id(model))
            .map(|model| format!("--model {model}")).unwrap_or_default();
        let command = if login || id.is_empty() {
            terminal_command(&path, &model_arg)
        } else {
            terminal_command(&path, &format!("--resume {id} {model_arg}").trim().to_string())
        };
        Ok(GeminiLaunch {
            command,
            session: id,
        })
    })
    .await
    .unwrap_or_else(|_| Err("Could not prepare Gemini's terminal.".into()))
}

fn is_model_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 100
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn is_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[tauri::command]
pub async fn gemini_cancel(tab: String) -> Result<(), String> {
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

#[tauri::command]
pub async fn gemini_install(app: AppHandle, window: String) -> Result<(), String> {
    let npm = crate::term::find_program_on_path(&["npm.cmd", "npm.exe", "npm"])
        .ok_or("Node.js is not installed, so npm cannot run. Install Node.js from nodejs.org.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = command(&npm)
            .arg("install")
            .arg("-g")
            .arg("@google/gemini-cli")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not run npm: {e}"))?;

        let say = |line: String, done: bool, ok: bool| {
            let _ = app.emit(
                "gemini:install",
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
                        "gemini:install",
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

// Sessions live under `~/.gemini/tmp/<project_id>/chats/session-*.json`.
// Older installs name the folder with SHA-256 of the absolute cwd; newer ones
// use a short slug. Sessions for this project are found by matching the hash
// first, then by scanning any chats folder whose files we can open.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiSession {
    id: String,
    title: String,
    modified: u64,
    turns: u32,
}

fn gemini_home() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("GEMINI_HOME") {
        return Some(PathBuf::from(home));
    }
    std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".gemini"))
}

fn project_hash(cwd: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(cwd.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn session_summary(path: &Path) -> Option<(String, String, u32)> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let id = value
        .get("sessionId")
        .or_else(|| value.get("session_id"))
        .and_then(|v| v.as_str())
        .filter(|id| is_session_id(id))?
        .to_string();
    let messages = value
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut title = String::new();
    let mut turns = 0u32;
    for message in &messages {
        let kind = message
            .get("type")
            .or_else(|| message.get("role"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if kind != "user" {
            continue;
        }
        let content = message_text(message);
        if content.trim().is_empty() {
            continue;
        }
        turns += 1;
        if title.is_empty() {
            title = content.split_whitespace().collect::<Vec<_>>().join(" ");
            title.truncate(160);
        }
    }
    Some((id, title, turns))
}

fn message_text(message: &serde_json::Value) -> String {
    match message.get("content") {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| {
                if let Some(text) = block.as_str() {
                    return Some(text.to_string());
                }
                block
                    .get("text")
                    .and_then(|t| t.as_str())
                    .map(str::to_string)
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => message
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

#[tauri::command]
pub async fn gemini_sessions(cwd: String) -> Vec<GeminiSession> {
    tauri::async_runtime::spawn_blocking(move || {
        let hash = project_hash(&cwd);
        let preferred = gemini_home()
            .map(|home| home.join("tmp").join(&hash).join("chats"))
            .filter(|path| path.is_dir());

        let mut sessions: Vec<GeminiSession> = Vec::new();
        let dirs = if let Some(dir) = preferred {
            vec![dir]
        } else {
            // No hash match yet — avoid listing every project's chats. An
            // empty list is correct until this project has talked to Gemini.
            return Vec::new();
        };

        for dir in dirs {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !(name.starts_with("session-") && name.ends_with(".json")) {
                    continue;
                }
                let Some((id, title, turns)) = session_summary(&path) else {
                    continue;
                };
                let modified = entry
                    .metadata()
                    .ok()
                    .and_then(|meta| meta.modified().ok())
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|since| since.as_millis() as u64)
                    .unwrap_or(0);
                sessions.push(GeminiSession {
                    id,
                    title: if title.is_empty() {
                        "Untitled conversation".into()
                    } else {
                        title
                    },
                    modified,
                    turns,
                });
            }
        }
        sessions.sort_by_key(|session| std::cmp::Reverse(session.modified));
        sessions.truncate(40);
        sessions
    })
    .await
    .unwrap_or_default()
}

#[derive(Serialize)]
pub struct GeminiTurn {
    role: String,
    text: String,
}

#[tauri::command]
pub async fn gemini_transcript(cwd: String, session: String) -> Result<Vec<GeminiTurn>, String> {
    if !is_session_id(&session) {
        return Err("That is not a conversation.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let hash = project_hash(&cwd);
        let dir = gemini_home()
            .map(|home| home.join("tmp").join(hash).join("chats"))
            .filter(|path| path.is_dir())
            .ok_or("Gemini's conversations are not on this computer.")?;
        let prefix: String = session.chars().take(8).collect();
        let mut found = None;
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if name == format!("session-{session}.json").to_ascii_lowercase()
                || name.ends_with(&format!("-{prefix}.json").to_ascii_lowercase())
            {
                if let Some((id, _, _)) = session_summary(&path) {
                    if id == session {
                        found = Some(path);
                        break;
                    }
                }
            }
        }
        let path = found.ok_or("That conversation is no longer on disk.")?;
        let text = std::fs::read_to_string(&path).map_err(|e| format!("Could not read it: {e}"))?;
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("Could not read it: {e}"))?;
        let messages = value
            .get("messages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut turns: Vec<GeminiTurn> = Vec::new();
        for message in messages {
            let kind = message
                .get("type")
                .or_else(|| message.get("role"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let content = message_text(&message);
            if content.trim().is_empty() {
                continue;
            }
            match kind {
                "user" => turns.push(GeminiTurn {
                    role: "you".into(),
                    text: content,
                }),
                "gemini" | "model" | "assistant" => match turns.last_mut() {
                    Some(last) if last.role == "claude" => {
                        last.text.push_str("\n\n");
                        last.text.push_str(&content);
                    }
                    _ => turns.push(GeminiTurn {
                        role: "claude".into(),
                        text: content,
                    }),
                },
                _ => {}
            }
        }
        Ok(turns)
    })
    .await
    .unwrap_or_else(|_| Err("Could not read that conversation.".into()))
}
