//! The one list of models WinT can use, and the one place the choice is kept.
//!
//! Three kinds of thing end up in the same list, because to the person
//! choosing one they are all just "what answers me":
//!
//! - `agent` - a coding-agent CLI they already installed and signed into
//!   (Claude Code, Codex, Gemini, Copilot, Cursor). WinT does not pick a model
//!   for these and does not pass one: the agent uses whatever it is configured
//!   to use, which is the point of installing it. One entry per agent.
//! - `api`   - a model reached directly with the person's own API key.
//! - `local` - a GGUF the app downloaded, run through the bundled llama.cpp.
//!
//! **Why this lives in Rust.** Every isolated tool runs in its own WebView2
//! data directory, so `localStorage` written by the main window never reaches
//! PC Detective or a workspace - see `tool-state.js`, which says the same
//! thing about tool handoff. A choice kept in the browser is therefore a
//! choice only the sidebar can see, which is exactly the split this replaces.
//! Keeping the list and the selection here is what makes "the same models
//! everywhere" true rather than three lists that happen to look alike.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

/// One thing the person can choose, whatever kind it is underneath.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    /// Stable across restarts and shared by every window. The prefix is what
    /// routing already keys on - `claude:`, `gpt:`, `codex:`, `cursor:` for
    /// API models, a bare id for a local GGUF - with `agent:` added for the
    /// CLIs. Existing ids keep working untouched.
    pub id: String,
    pub label: String,
    /// `agent` | `api` | `local`
    pub kind: &'static str,
    /// Which account or runtime it belongs to, for grouping in the screen.
    pub provider: &'static str,
    /// The line under the name: "Cloud", "4.7 GB · needs 8 GB", "Installed".
    pub detail: String,
    /// Usable right now - installed, keyed, or downloaded.
    pub ready: bool,
    /// When it is not ready, what would make it ready.
    pub hint: String,
    /// Off means the person turned it off here, so nowhere offers it even
    /// though it works. Separate from `ready`, which is about the machine.
    pub enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelList {
    pub models: Vec<ModelEntry>,
    /// The shared choice. Empty until something is chosen or defaulted.
    pub selected: String,
}

#[derive(Default, Deserialize, Serialize)]
struct Stored {
    #[serde(default)]
    selected: String,
    /// Ids the person switched off here. Absent means on, so a model added to
    /// the catalog later arrives enabled rather than silently missing.
    #[serde(default)]
    disabled: Vec<String>,
}

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join("ai-models.json"))
}

fn read_stored(app: &AppHandle) -> Stored {
    store_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_stored(app: &AppHandle, value: &Stored) -> Result<(), String> {
    let path = store_path(app).ok_or("There is nowhere to save the model choice.")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("Could not save the model choice: {e}"))
}

/// The agent CLIs, in the order the tools already show them. WinT passes no
/// model to these on purpose: the agent answers with whatever it is set up to
/// use, and taking that over would mean overriding a choice the person already
/// made in the agent itself.
fn agents() -> Vec<ModelEntry> {
    [
        ("claude", "Claude Code", crate::term::claude_program().is_some()),
        ("codex", "Codex", crate::codex::codex_path().is_some()),
        ("gemini", "Gemini", crate::gemini::gemini_path().is_some()),
        ("copilot", "GitHub Copilot", crate::copilot::copilot_path().is_some()),
        ("cursor", "Cursor Agent", crate::cursor::find_agent().is_some()),
    ]
    .into_iter()
    .map(|(id, label, installed)| ModelEntry {
        id: format!("agent:{id}"),
        label: label.into(),
        kind: "agent",
        provider: "agent",
        detail: if installed {
            "Installed · uses the model you configured in it".into()
        } else {
            "Not installed".into()
        },
        ready: installed,
        hint: if installed {
            String::new()
        } else {
            format!("Install {label} and sign in as yourself. WinT holds no key for it.")
        },
        enabled: true,
    })
    .collect()
}

/// Models reached with the person's own key. The ids are the ones the chat
/// router already understands, so nothing downstream has to learn a new shape.
const API_MODELS: &[(&str, &str, &str)] = &[
    ("claude:claude-sonnet-4-6", "Claude Sonnet 4.6", "anthropic"),
    ("gpt:gpt-5.6-luna", "GPT 5.6 Luna", "openai"),
    ("gpt:gpt-5.6-terra", "GPT 5.6 Terra", "openai"),
    ("gpt:gpt-5.6-sol", "GPT 5.6 Sol", "openai"),
    ("codex:gpt-5.3-codex", "Codex GPT-5.3", "openai"),
    ("cursor:agent", "Cursor Agent", "cursor"),
];

fn api(cloud: &crate::ai::cloud::CloudStatus) -> Vec<ModelEntry> {
    API_MODELS
        .iter()
        .map(|(id, label, provider)| {
            let keyed = match *provider {
                "anthropic" => cloud.claude_configured(),
                "openai" => cloud.openai_configured(),
                _ => cloud.cursor_configured(),
            };
            let account = match *provider {
                "anthropic" => "Anthropic",
                "openai" => "OpenAI",
                _ => "Cursor",
            };
            ModelEntry {
                id: (*id).into(),
                label: (*label).into(),
                kind: "api",
                provider,
                detail: if keyed {
                    format!("Cloud · your {account} key")
                } else {
                    format!("Needs an {account} key")
                },
                ready: keyed,
                hint: if keyed {
                    String::new()
                } else {
                    format!("Add your {account} API key above to use this.")
                },
                enabled: true,
            }
        })
        .collect()
}

fn local(status: &crate::assistant::Status) -> Vec<ModelEntry> {
    status
        .catalog_entries()
        .into_iter()
        .map(|(id, label, size, memory, installed)| ModelEntry {
            id,
            label,
            kind: "local",
            provider: "local",
            detail: if installed {
                format!("Downloaded · {size} · needs {memory}")
            } else {
                format!("{size} download · needs {memory}")
            },
            ready: installed,
            hint: if installed {
                String::new()
            } else {
                "Download it below. It then runs on this PC, with nothing sent anywhere.".into()
            },
            enabled: true,
        })
        .collect()
}

/// Everything, every time. Which of these a given place can actually run is
/// that place's business - the list itself is the same wherever it is asked
/// for, so a model chosen in Settings is a model the person then sees in the
/// sidebar, in a workspace and in PC Detective.
pub fn list(app: &AppHandle, root: PathBuf) -> ModelList {
    let cloud = crate::ai::cloud::status();
    let status = crate::ai::status(root);
    let mut models = agents();
    models.extend(api(&cloud));
    models.extend(local(&status));

    let stored = read_stored(app);
    for entry in &mut models {
        entry.enabled = !stored.disabled.contains(&entry.id);
    }

    // A selection that no longer exists - a deleted model, a removed key, one
    // switched off here - must not leave every place pointing at nothing, so
    // fall back to the first thing that is actually usable.
    let usable = |m: &ModelEntry| m.ready && m.enabled;
    let selected = if models.iter().any(|m| m.id == stored.selected && usable(m)) {
        stored.selected
    } else {
        models
            .iter()
            .find(|m| usable(m))
            .map(|m| m.id.clone())
            .unwrap_or_default()
    };
    ModelList { models, selected }
}

/// Turns one entry on or off everywhere. Off is stored rather than on, so
/// anything added to the catalog in a later version arrives switched on
/// instead of quietly missing from a list the person never edited.
pub fn set_enabled(app: &AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let mut stored = read_stored(app);
    stored.disabled.retain(|existing| *existing != id);
    if !enabled {
        stored.disabled.push(id);
    }
    write_stored(app, &stored)?;
    let _ = app.emit("ai:model-changed", stored.selected.clone());
    Ok(())
}

/// Records the shared choice and tells every window, including the isolated
/// tool webviews that cannot see the main window's storage.
pub fn select(app: &AppHandle, id: String) -> Result<(), String> {
    // Read first: the choice and the on/off list live in the same file, and
    // writing one must not wipe the other.
    let mut stored = read_stored(app);
    stored.selected = id.clone();
    write_stored(app, &stored)?;
    let _ = app.emit("ai:model-changed", id);
    Ok(())
}

/// What one agent's Verify button reports.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCheck {
    /// `missing` - nothing on PATH. `broken` - found, but it will not run.
    /// `signed-out` - it runs and says it is not signed in.
    /// `ready` - it runs, and nothing is known to be wrong with it.
    pub state: &'static str,
    pub summary: String,
    pub version: String,
    /// What the button on the message does: "" for nothing to do,
    /// `install`, `reinstall`, or `signin`. The person should never have to
    /// read a paragraph and go and do it themselves - if WinT knows what is
    /// wrong, it knows what would fix it.
    pub fix: &'static str,
    /// Words for that button.
    pub fix_label: String,
}

/// Checks one agent properly, rather than only whether a file exists.
///
/// Running `--version` is the honest test of an install: a shim on PATH that
/// cannot run is not an install. Sign-in is a second question, and only Cursor
/// answers it without being asked to do work - so for the others WinT says
/// what it actually knows instead of inventing a probe that costs the person
/// a request, or guessing at a login flag that may not exist.
pub fn verify_agent(id: &str) -> AgentCheck {
    let (label, path) = match id {
        "claude" => ("Claude Code", crate::term::claude_program()),
        "codex" => ("Codex", crate::codex::codex_path()),
        "gemini" => ("Gemini", crate::gemini::gemini_path()),
        "copilot" => ("GitHub Copilot", crate::copilot::copilot_path()),
        "cursor" => (
            "Cursor Agent",
            crate::cursor::find_agent().map(|found| found.script),
        ),
        _ => {
            return AgentCheck {
                state: "missing",
                summary: "That is not an agent WinT knows.".into(),
                version: String::new(),
                fix: "",
                fix_label: String::new(),
            }
        }
    };
    let Some(path) = path else {
        return AgentCheck {
            state: "missing",
            summary: format!("{label} is not installed."),
            version: String::new(),
            fix: "install",
            fix_label: "Install".into(),
        };
    };

    // Cursor is the one that reports sign-in cheaply, through the same check
    // the workspace Agent panel already uses - and the one whose sign-in WinT
    // can start, because the CLI has a `login` command of its own.
    if id == "cursor" {
        let found = crate::cursor::find_agent();
        let (signed, email) = found.as_ref().map(crate::cursor::signed_in).unwrap_or_default();
        return if signed {
            AgentCheck {
                state: "ready",
                summary: if email.is_empty() {
                    "Installed and signed in.".into()
                } else {
                    format!("Installed and signed in as {email}.")
                },
                version: String::new(),
                fix: "",
                fix_label: String::new(),
            }
        } else {
            AgentCheck {
                state: "signed-out",
                summary: "Installed, but not signed in.".into(),
                version: String::new(),
                fix: "signin",
                fix_label: "Sign in".into(),
            }
        };
    }

    let version = version_of(&path);
    if version.is_empty() {
        return AgentCheck {
            state: "broken",
            summary: format!("Found at {}, but it will not run.", path.display()),
            version: String::new(),
            fix: "reinstall",
            fix_label: "Reinstall".into(),
        };
    }

    // It is installed and it runs. WinT cannot cheaply tell whether it is
    // signed in, and saying so at length would be a warning about nothing on a
    // row that works - so this reads as fine, because it is. An agent that is signed
    // out surfaces that on first use, where it can be acted on.
    AgentCheck {
        state: "ready",
        summary: format!("Installed and working ({version})."),
        version,
        fix: "",
        fix_label: String::new(),
    }
}

/// `--version`, with everything that can go wrong treated as "no version".
///
/// A batch file has to go through `cmd.exe`: `CreateProcess` cannot execute
/// one, so running it directly fails and a perfectly good install looks
/// broken. GitHub Copilot ships exactly that - a `copilot.bat` inside the VS
/// Code extension - which is why this mirrors what `copilot.rs` already does
/// for its own version check.
fn version_of(path: &std::path::Path) -> String {
    use std::process::{Command, Stdio};
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
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
    cmd.arg("--version").stdin(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd.output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| crate::term::version_line(&String::from_utf8_lossy(&out.stdout)))
        .unwrap_or_default()
}

/// Starts an agent's own sign-in, in a console window of its own.
///
/// Signing in genuinely cannot be done for the person - it ends in a browser,
/// with their account - but nothing up to that point should be their job. So
/// rather than printing a command to go and type, WinT runs it and puts the
/// window in front of them. `CREATE_NEW_CONSOLE` is the point: the process has
/// to be visible, because the sign-in prints a URL and waits.
pub fn signin_agent(id: &str) -> Result<(), String> {
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    if id != "cursor" {
        return Err("That agent signs in the first time you use it, not from here.".into());
    }
    let line = crate::cursor::login_command()?;
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("cmd.exe");
    #[cfg(windows)]
    cmd.raw_arg(format!("/d /c start \"Sign in\" {line}"));
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NEW_CONSOLE);
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not start the sign-in: {e}"))
}
