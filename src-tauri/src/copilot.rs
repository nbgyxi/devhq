//! GitHub Copilot CLI as a chat panel rather than a terminal.
//!
//! The same bargain as [`crate::claude`] and [`crate::cursor`]: the workspace
//! drives the CLI the person already installed, through its machine-readable
//! mode, and renders the conversation itself. WinT asks for no token and
//! stores none — the CLI signs in as them (`copilot login`) and this process
//! never sees a credential.
//!
//! Two things are deliberate and must stay that way:
//!
//! - **No `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` is set.** The
//!   panel is their Copilot, signed in as them.
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

fn running() -> &'static Mutex<std::collections::HashMap<String, Child>> {
    static RUNNING: OnceLock<Mutex<std::collections::HashMap<String, Child>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Everywhere a `copilot` might be, best guess first.
///
/// More than one can answer to the name. VS Code's Copilot Chat extension puts
/// its own `copilot.bat` launcher on PATH, and when the CLI it launches isn't
/// there that shim still exits 0 — it just prints "Cannot find GitHub Copilot
/// CLI". So the candidates are all tried, and the one that reports a version
/// wins, rather than whichever happens to sit earliest on PATH.
fn copilot_paths() -> Vec<PathBuf> {
    let mut paths =
        crate::term::find_programs_on_path(&["copilot.exe", "copilot.cmd", "copilot.bat"]);
    if let Some(npm) = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|roaming| roaming.join("npm").join("copilot.cmd"))
        .filter(|path| path.is_file())
    {
        if !paths.contains(&npm) {
            paths.push(npm);
        }
    }
    paths
}

fn copilot_path() -> Option<PathBuf> {
    let paths = copilot_paths();
    paths
        .iter()
        .find(|path| !version_of(path).is_empty())
        .or_else(|| paths.first())
        .cloned()
}

/// What `copilot --version` says, or nothing if it says anything but a version.
fn version_of(path: &Path) -> String {
    command(path)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| crate::term::version_line(&String::from_utf8_lossy(&out.stdout)))
        .unwrap_or_default()
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
pub struct CopilotStatus {
    installed: bool,
    path: String,
    version: String,
}

#[tauri::command]
pub async fn copilot_status() -> CopilotStatus {
    tauri::async_runtime::spawn_blocking(|| {
        for path in copilot_paths() {
            let version = version_of(&path);
            if !version.is_empty() {
                return CopilotStatus {
                    installed: true,
                    path: path.to_string_lossy().into_owned(),
                    version,
                };
            }
        }
        CopilotStatus {
            installed: false,
            path: String::new(),
            version: String::new(),
        }
    })
    .await
    .unwrap_or(CopilotStatus {
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

/// Asks Copilot one question and streams the answer back as events.
#[tauri::command]
pub async fn copilot_send(
    app: AppHandle,
    window: String,
    tab: String,
    prompt: String,
    cwd: String,
    session: Option<String>,
) -> Result<(), String> {
    let Some(path) = copilot_path() else {
        return Err("GitHub Copilot CLI is not installed.".into());
    };
    if !Path::new(&cwd).is_dir() {
        return Err("That folder no longer exists.".into());
    }
    let _ = copilot_cancel(tab.clone()).await;

    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = command(&path);
        cmd.current_dir(&cwd)
            // Piped stdin is the non-interactive prompt; `-p` would take the
            // text as an argument and ignore the pipe.
            .arg("--output-format")
            .arg("json")
            .arg("--allow-all")
            .arg("--no-ask-user")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(id) = session.as_deref().filter(|id| is_session_id(id)) {
            cmd.arg(format!("--resume={id}"));
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not start GitHub Copilot CLI: {e}"))?;

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
                    "copilot:line",
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
            "copilot:end",
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
    .unwrap_or_else(|_| Err("GitHub Copilot CLI stopped unexpectedly.".into()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotLaunch {
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
        // Extra args must live inside the `cmd /k` string, or `cmd.exe` eats them.
        format!("cmd.exe /d /k \"\"{display}\"{extra}\"")
    } else {
        format!("\"{display}\"{extra}")
    }
}

#[tauri::command]
pub async fn copilot_terminal_command(
    session: Option<String>,
    login: bool,
) -> Result<CopilotLaunch, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = copilot_path().ok_or("GitHub Copilot CLI is not installed.")?;
        if login {
            return Ok(CopilotLaunch {
                command: terminal_command(&path, "login"),
                session: session.filter(|id| is_session_id(id)).unwrap_or_default(),
            });
        }
        let id = session.filter(|id| is_session_id(id)).unwrap_or_default();
        let command = if id.is_empty() {
            terminal_command(&path, "")
        } else {
            terminal_command(&path, &format!("--resume={id}"))
        };
        Ok(CopilotLaunch {
            command,
            session: id,
        })
    })
    .await
    .unwrap_or_else(|_| Err("Could not prepare Copilot's terminal.".into()))
}

fn is_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[tauri::command]
pub async fn copilot_cancel(tab: String) -> Result<(), String> {
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
pub async fn copilot_install(app: AppHandle, window: String) -> Result<(), String> {
    let npm = crate::term::find_program_on_path(&["npm.cmd", "npm.exe", "npm"])
        .ok_or("Node.js is not installed, so npm cannot run. Install Node.js from nodejs.org.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = command(&npm)
            .arg("install")
            .arg("-g")
            .arg("@github/copilot")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not run npm: {e}"))?;

        let say = |line: String, done: bool, ok: bool| {
            let _ = app.emit(
                "copilot:install",
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
                        "copilot:install",
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

// Sessions live under `~/.copilot/session-state/<id>/` with `workspace.yaml`
// (which folder the chat belonged to) and `events.jsonl` (what was said).

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotSession {
    id: String,
    title: String,
    modified: u64,
    turns: u32,
}

fn sessions_root() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("COPILOT_HOME") {
        return Some(PathBuf::from(home).join("session-state"));
    }
    std::env::var_os("USERPROFILE")
        .map(|home| PathBuf::from(home).join(".copilot").join("session-state"))
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

fn workspace_cwd(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("workspace.yaml")).ok()?;
    for key in ["cwd:", "workingDirectory:", "root:", "path:", "directory:"] {
        for line in text.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix(key) {
                let value = rest.trim().trim_matches('"').trim_matches('\'');
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

fn session_prompts(dir: &Path) -> Vec<String> {
    let path = dir.join("events.jsonl");
    let Ok(file) = std::fs::File::open(&path) else {
        return Vec::new();
    };
    let mut prompts = Vec::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let kind = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if kind != "user.message" && kind != "user" {
            continue;
        }
        let data = value.get("data").unwrap_or(&value);
        let text = data
            .get("content")
            .or_else(|| data.get("text"))
            .or_else(|| data.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if !text.is_empty() {
            prompts.push(text.to_string());
        }
    }
    prompts
}

#[tauri::command]
pub async fn copilot_sessions(cwd: String) -> Vec<CopilotSession> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(root) = sessions_root() else {
            return Vec::new();
        };
        let Ok(entries) = std::fs::read_dir(&root) else {
            return Vec::new();
        };
        let mut sessions: Vec<CopilotSession> = entries
            .flatten()
            .filter_map(|entry| {
                let dir = entry.path();
                if !dir.is_dir() {
                    return None;
                }
                let id = dir.file_name()?.to_str()?.to_string();
                if !is_session_id(&id) {
                    return None;
                }
                if let Some(meta_cwd) = workspace_cwd(&dir) {
                    if !same_cwd(&meta_cwd, &cwd) {
                        return None;
                    }
                }
                let prompts = session_prompts(&dir);
                if prompts.is_empty() && !dir.join("events.jsonl").is_file() {
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
                let mut title = prompts
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "Untitled conversation".into());
                title = title.split_whitespace().collect::<Vec<_>>().join(" ");
                title.truncate(160);
                Some(CopilotSession {
                    id,
                    title,
                    modified,
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
pub struct CopilotTurn {
    role: String,
    text: String,
}

#[tauri::command]
pub async fn copilot_transcript(cwd: String, session: String) -> Result<Vec<CopilotTurn>, String> {
    if !is_session_id(&session) {
        return Err("That is not a conversation.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = sessions_root().ok_or("Copilot's conversations are not on this computer.")?;
        let dir = root.join(&session);
        if !dir.is_dir() {
            return Err("That conversation is no longer on disk.".into());
        }
        if let Some(meta_cwd) = workspace_cwd(&dir) {
            if !same_cwd(&meta_cwd, &cwd) {
                return Err("That conversation belongs to another folder.".into());
            }
        }
        let path = dir.join("events.jsonl");
        let file = std::fs::File::open(&path).map_err(|e| format!("Could not read it: {e}"))?;
        let mut turns: Vec<CopilotTurn> = Vec::new();
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let kind = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let data = value.get("data").unwrap_or(&value);
            let text = data
                .get("content")
                .or_else(|| data.get("text"))
                .or_else(|| data.get("deltaContent"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if text.is_empty() {
                continue;
            }
            match kind {
                "user.message" | "user" => turns.push(CopilotTurn {
                    role: "you".into(),
                    text: text.to_string(),
                }),
                "assistant.message" | "assistant" => match turns.last_mut() {
                    Some(last) if last.role == "claude" => {
                        last.text.push_str("\n\n");
                        last.text.push_str(text);
                    }
                    _ => turns.push(CopilotTurn {
                        role: "claude".into(),
                        text: text.to_string(),
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
