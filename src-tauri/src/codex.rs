//! OpenAI Codex CLI as a chat panel rather than a terminal.
//!
//! The same bargain as [`crate::claude`] and [`crate::cursor`]: the workspace
//! drives the CLI the person already installed, through its machine-readable
//! mode, and renders the conversation itself. WinT asks for no API key and
//! stores none — the CLI signs in as them (`codex login`) and this process
//! never sees a credential.
//!
//! Two things are deliberate and must stay that way:
//!
//! - **No `OPENAI_API_KEY` / `CODEX_API_KEY` is set.** The panel is their
//!   Codex, signed in as them.
//! - **The prompt goes in on stdin, never as an argument.** Every argument
//!   here is fixed text or a session id, so nothing anyone types has to
//!   survive a round trip through `cmd.exe`'s parser.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct RunningChild {
    generation: u64,
    child: Child,
}

fn running() -> &'static Mutex<std::collections::HashMap<String, RunningChild>> {
    static RUNNING: OnceLock<Mutex<std::collections::HashMap<String, RunningChild>>> =
        OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn next_generation() -> u64 {
    static GENERATION: AtomicU64 = AtomicU64::new(1);
    GENERATION.fetch_add(1, Ordering::Relaxed)
}

fn codex_home() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("CODEX_HOME") {
        return Some(PathBuf::from(home));
    }
    std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".codex"))
}

fn codex_path() -> Option<PathBuf> {
    crate::term::find_program_on_path(&["codex.exe", "codex.cmd", "codex.bat"])
        .or_else(|| {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .map(|local| local.join("Programs").join("OpenAI").join("Codex").join("bin").join("codex.exe"))
                .filter(|path| path.is_file())
        })
        .or_else(|| {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .map(|local| local.join("OpenAI").join("Codex").join("bin").join("codex.exe"))
                .filter(|path| path.is_file())
        })
        .or_else(|| {
            codex_home()
                .map(|home| home.join("packages").join("standalone").join("current").join("bin").join("codex.exe"))
                .filter(|path| path.is_file())
        })
        .or_else(|| {
            std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .map(|roaming| roaming.join("npm").join("codex.cmd"))
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
pub struct CodexStatus {
    installed: bool,
    path: String,
    version: String,
}

#[tauri::command]
pub async fn codex_status() -> CodexStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(path) = codex_path() else {
            return CodexStatus {
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
        CodexStatus {
            installed: !version.is_empty(),
            path: path.to_string_lossy().into_owned(),
            version,
        }
    })
    .await
    .unwrap_or(CodexStatus {
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

/// Asks Codex one question and streams the answer back as events.
#[tauri::command]
pub async fn codex_send(
    app: AppHandle,
    window: String,
    tab: String,
    prompt: String,
    cwd: String,
    session: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    let Some(path) = codex_path() else {
        return Err("Codex CLI is not installed.".into());
    };
    if !Path::new(&cwd).is_dir() {
        return Err("That folder no longer exists.".into());
    }
    let _ = codex_cancel(tab.clone()).await;

    tauri::async_runtime::spawn_blocking(move || {
        let generation = next_generation();
        let mut cmd = command(&path);
        cmd.current_dir(&cwd)
            .arg("exec")
            .arg("--json")
            // `--sandbox` belongs to `codex exec`, so it must precede the
            // `resume` subcommand. Putting it after the session id makes
            // resumed turns fail before Codex reads their prompt.
            .arg("--sandbox")
            .arg("workspace-write");
        if let Some(model) = model.as_deref().filter(|model| is_model_id(model)) {
            cmd.arg("--model").arg(model);
        }
        if let Some(id) = session.as_deref().filter(|id| is_session_id(id)) {
            cmd.arg("resume").arg(id);
        }
        cmd
            // Edits land without a prompt, because in this mode there is
            // nobody to ask. The way to be asked is the CLI itself.
            // `-` tells exec that stdin is the prompt, not extra context for a
            // prompt that was passed as an argument.
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not start Codex CLI: {e}"))?;

        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes());
        }

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        running()
            .lock()
            .unwrap()
            .insert(tab.clone(), RunningChild { generation, child });

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
                    "codex:line",
                    Line {
                        window: window.clone(),
                        tab: tab.clone(),
                        line,
                    },
                );
            }
        }

        // A cancelled turn may finish its stdout loop after a replacement has
        // already been put under the same tab id. Only reap the process this
        // invocation inserted; otherwise the old cleanup steals and waits on
        // the new turn, leaving process ownership out of sync.
        let own_child = {
            let mut running = running().lock().unwrap();
            if running
                .get(&tab)
                .is_some_and(|entry| entry.generation == generation)
            {
                running.remove(&tab).map(|entry| entry.child)
            } else {
                None
            }
        };
        let code = own_child
            .and_then(|mut child| child.wait().ok())
            .and_then(|status| status.code())
            .unwrap_or(-1);
        let error = errors.join().unwrap_or_default();
        let _ = app.emit(
            "codex:end",
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
    .unwrap_or_else(|_| Err("Codex CLI stopped unexpectedly.".into()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLaunch {
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
pub async fn codex_terminal_command(
    session: Option<String>,
    login: bool,
    model: Option<String>,
) -> Result<CodexLaunch, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = codex_path().ok_or("Codex CLI is not installed.")?;
        if login {
            return Ok(CodexLaunch {
                command: terminal_command(&path, "login"),
                session: session.filter(|id| is_session_id(id)).unwrap_or_default(),
            });
        }
        let id = session.filter(|id| is_session_id(id)).unwrap_or_default();
        let model_arg = model.as_deref().filter(|model| is_model_id(model))
            .map(|model| format!("--model {model}")).unwrap_or_default();
        let command = if id.is_empty() {
            terminal_command(&path, &model_arg)
        } else {
            terminal_command(&path, &format!("{model_arg} resume {id}").trim().to_string())
        };
        Ok(CodexLaunch {
            command,
            session: id,
        })
    })
    .await
    .unwrap_or_else(|_| Err("Could not prepare Codex's terminal.".into()))
}

fn is_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[tauri::command]
pub async fn codex_cancel(tab: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(mut entry) = running().lock().unwrap().remove(&tab) {
            let _ = entry.child.kill();
            let _ = entry.child.wait();
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

/// Installs the CLI the way OpenAI publishes it, reporting as it goes.
#[tauri::command]
pub async fn codex_install(app: AppHandle, window: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("powershell.exe");
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.arg("-NoLogo")
            .arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-Command")
            .arg("irm 'https://chatgpt.com/codex/install.ps1' | iex")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not run the Codex installer: {e}"))?;

        let say = |line: String, done: bool, ok: bool| {
            let _ = app.emit(
                "codex:install",
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
                        "codex:install",
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

// Sessions live under `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`.
// The first line is `session_meta` with the id and the folder the chat belonged
// to. Reading those is what lets the panel offer this project's conversations.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSession {
    id: String,
    title: String,
    modified: u64,
    turns: u32,
}

fn same_cwd(meta: &str, cwd: &str) -> bool {
    let a: String = meta
        .chars()
        .map(|c| if c == '/' { '\\' } else { c })
        .flat_map(char::to_lowercase)
        .collect();
    let b: String = cwd
        .chars()
        .map(|c| if c == '/' { '\\' } else { c })
        .flat_map(char::to_lowercase)
        .collect();
    a.trim_end_matches('\\') == b.trim_end_matches('\\')
}

fn payload_text(value: &serde_json::Value) -> String {
    match value.get("message").or_else(|| value.get("text")) {
        Some(serde_json::Value::String(text)) => text.clone(),
        _ => match value.get("content") {
            Some(serde_json::Value::String(text)) => text.clone(),
            Some(serde_json::Value::Array(blocks)) => blocks
                .iter()
                .filter_map(|block| {
                    block
                        .get("text")
                        .and_then(|t| t.as_str())
                        .or_else(|| block.as_str())
                })
                .collect::<Vec<_>>()
                .join("\n\n"),
            _ => String::new(),
        },
    }
}

fn is_spoken(text: &str) -> bool {
    let text = text.trim();
    !text.is_empty() && !text.starts_with('<')
}

fn session_meta(path: &Path) -> Option<(String, String)> {
    let file = std::fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().map_while(Result::ok).take(8) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
            continue;
        }
        let payload = value.get("payload")?;
        let id = payload
            .get("id")
            .or_else(|| payload.get("thread_id"))
            .and_then(|v| v.as_str())
            .filter(|id| is_session_id(id))?
            .to_string();
        let cwd = payload
            .get("cwd")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        return Some((id, cwd));
    }
    None
}

fn summarise(path: &Path) -> (String, u32) {
    let Ok(file) = std::fs::File::open(path) else {
        return (String::new(), 0);
    };
    let mut title = String::new();
    let mut turns = 0u32;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if !is_user_line(&value) {
            continue;
        }
        let payload = value.get("payload").unwrap_or(&value);
        let text = payload_text(payload);
        if !is_spoken(&text) {
            continue;
        }
        turns += 1;
        if title.is_empty() {
            title = text.split_whitespace().collect::<Vec<_>>().join(" ");
            title.truncate(160);
        }
        if turns >= 999 {
            break;
        }
    }
    (title, turns)
}

fn is_user_line(value: &serde_json::Value) -> bool {
    let kind = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let payload = value.get("payload").unwrap_or(value);
    let inner = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let role = payload.get("role").and_then(|r| r.as_str()).unwrap_or("");
    matches!(kind, "event_msg" | "response_item")
        && (inner == "user_message" || inner == "user" || role == "user")
}

fn is_model_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 100
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn is_agent_line(value: &serde_json::Value) -> bool {
    let kind = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let payload = value.get("payload").unwrap_or(value);
    let inner = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let role = payload.get("role").and_then(|r| r.as_str()).unwrap_or("");
    matches!(kind, "event_msg" | "response_item")
        && (matches!(inner, "agent_message" | "assistant") || role == "assistant")
}

#[cfg(test)]
mod tests {
    use super::{is_agent_line, is_user_line, payload_text};
    use serde_json::json;

    #[test]
    fn recognises_current_response_item_messages_by_role() {
        let user = json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "Fix the history"}]
            }
        });
        let assistant = json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "Fixed"}]
            }
        });

        assert!(is_user_line(&user));
        assert!(!is_agent_line(&user));
        assert!(is_agent_line(&assistant));
        assert!(!is_user_line(&assistant));
        assert_eq!(payload_text(&user["payload"]), "Fix the history");
        assert_eq!(payload_text(&assistant["payload"]), "Fixed");
    }

    #[test]
    fn still_recognises_legacy_event_messages_by_type() {
        let user = json!({
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "Hello"}
        });
        let assistant = json!({
            "type": "event_msg",
            "payload": {"type": "agent_message", "message": "Hi"}
        });

        assert!(is_user_line(&user));
        assert!(is_agent_line(&assistant));
    }
}

fn rollout_files() -> Vec<PathBuf> {
    let Some(root) = codex_home().map(|home| home.join("sessions")) else {
        return Vec::new();
    };
    if !root.is_dir() {
        return Vec::new();
    }
    let mut files = Vec::new();
    let Ok(years) = std::fs::read_dir(&root) else {
        return files;
    };
    for year in years.flatten() {
        let year_path = year.path();
        if !year_path.is_dir() {
            continue;
        }
        let Ok(months) = std::fs::read_dir(&year_path) else {
            continue;
        };
        for month in months.flatten() {
            let month_path = month.path();
            if !month_path.is_dir() {
                continue;
            }
            let Ok(days) = std::fs::read_dir(&month_path) else {
                continue;
            };
            for day in days.flatten() {
                let day_path = day.path();
                if !day_path.is_dir() {
                    continue;
                }
                let Ok(entries) = std::fs::read_dir(&day_path) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                        files.push(path);
                    }
                }
            }
        }
    }
    files
}

#[tauri::command]
pub async fn codex_sessions(cwd: String) -> Vec<CodexSession> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut sessions: Vec<CodexSession> = rollout_files()
            .into_iter()
            .filter_map(|path| {
                let (id, meta_cwd) = session_meta(&path)?;
                if !meta_cwd.is_empty() && !same_cwd(&meta_cwd, &cwd) {
                    return None;
                }
                let modified = std::fs::metadata(&path)
                    .ok()?
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|since| since.as_millis() as u64)
                    .unwrap_or(0);
                let (title, turns) = summarise(&path);
                Some(CodexSession {
                    id,
                    title: if title.is_empty() {
                        "Untitled conversation".into()
                    } else {
                        title
                    },
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

#[derive(Serialize)]
pub struct CodexTurn {
    role: String,
    text: String,
}

#[tauri::command]
pub async fn codex_transcript(cwd: String, session: String) -> Result<Vec<CodexTurn>, String> {
    if !is_session_id(&session) {
        return Err("That is not a conversation.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let path = rollout_files()
            .into_iter()
            .find(|path| {
                session_meta(path).is_some_and(|(id, meta_cwd)| {
                    id == session && (meta_cwd.is_empty() || same_cwd(&meta_cwd, &cwd))
                })
            })
            .ok_or("That conversation is no longer on disk.")?;
        let file = std::fs::File::open(&path).map_err(|e| format!("Could not read it: {e}"))?;
        let mut turns: Vec<CodexTurn> = Vec::new();
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let payload = value.get("payload").unwrap_or(&value);
            let text = payload_text(payload);
            if text.trim().is_empty() {
                continue;
            }
            if is_user_line(&value) {
                if is_spoken(&text) {
                    turns.push(CodexTurn {
                        role: "you".into(),
                        text,
                    });
                }
            } else if is_agent_line(&value) {
                match turns.last_mut() {
                    Some(last) if last.role == "claude" => {
                        last.text.push_str("\n\n");
                        last.text.push_str(&text);
                    }
                    _ => turns.push(CodexTurn {
                        role: "claude".into(),
                        text,
                    }),
                }
            }
        }
        Ok(turns)
    })
    .await
    .unwrap_or_else(|_| Err("Could not read that conversation.".into()))
}
