//! PC Detective: a coding agent the person already installed, pointed at
//! their own machine instead of a project.
//!
//! The agent does the looking and the fixing - it has a shell of its own, runs
//! PowerShell itself, and may kill, disable or remove what it finds. WinT only
//! starts one turn at a time, streams what the agent is doing back to the tool,
//! and hands the next turn the answer the person chose. Every turn continues
//! the same agent session, so nothing the agent learned is lost between choices.
//!
//! A turn runs in print mode, where nobody can answer the CLI's own prompts - a
//! permission it would ask for is simply refused. So every tool the audit needs
//! is allowed up front, and the agent asks the person *through its reply*: a
//! JSON block the tool renders as a question with answers, acted on next turn.
//!
//! Administrator rights are decided **once, before the audit starts**, and
//! never change afterwards. Elevating halfway would mean a new process and a
//! new context, which is exactly what the audit must not lose. An elevated
//! audit starts a small PowerShell host through a single `runas` prompt; that
//! host stays alive for the whole audit and runs every turn of the agent, so
//! there is one prompt, not one per turn.
//!
//! The host talks to WinT over two one-way named pipes. Both are created here
//! with `FILE_FLAG_FIRST_PIPE_INSTANCE` and a single instance, and each
//! connection is only accepted from the process `runas` actually started - a
//! pipe any process of this user could connect to would otherwise be a way to
//! run things as administrator without the prompt.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/* -------------------------------- repository agent-safety preflight */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoFinding {
    id: String,
    severity: &'static str,
    area: &'static str,
    title: String,
    why: String,
    #[serde(rename = "where")]
    where_: String,
    age: &'static str,
    is_new: bool,
    verdict: String,
    evidence: Vec<RepoEvidence>,
    fix: Option<serde_json::Value>,
    asks: Vec<String>,
    #[serde(rename = "static")]
    static_scan: bool,
}

#[derive(Serialize)]
struct RepoEvidence {
    label: String,
    value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPreflight {
    path: String,
    verdict: &'static str,
    files_scanned: usize,
    files_skipped: usize,
    findings: Vec<RepoFinding>,
    passed: Vec<serde_json::Value>,
}

fn repo_text_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    name.starts_with(".env")
        || name == "dockerfile"
        || name == "makefile"
        || matches!(
            ext.as_str(),
            "txt"
                | "md"
                | "json"
                | "jsonc"
                | "yaml"
                | "yml"
                | "toml"
                | "xml"
                | "config"
                | "conf"
                | "ini"
                | "properties"
                | "env"
                | "js"
                | "mjs"
                | "cjs"
                | "ts"
                | "tsx"
                | "jsx"
                | "py"
                | "rb"
                | "php"
                | "go"
                | "rs"
                | "java"
                | "kt"
                | "cs"
                | "fs"
                | "ps1"
                | "psm1"
                | "sh"
                | "bash"
                | "zsh"
                | "bat"
                | "cmd"
                | "sql"
                | "tf"
                | "hcl"
        )
}

fn repo_redact(line: &str) -> String {
    let mut out = line.trim().chars().take(220).collect::<String>();
    if let Some((left, _)) = out.split_once('=') {
        if ["key", "secret", "token", "password", "pwd", "connection"]
            .iter()
            .any(|k| left.to_ascii_lowercase().contains(k))
        {
            out = format!("{}=<redacted>", left.trim());
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn repo_add(
    findings: &mut Vec<RepoFinding>,
    severity: &'static str,
    id: &str,
    title: &str,
    why: &str,
    path: &Path,
    line: usize,
    sample: &str,
    verdict: &str,
) {
    let location = format!("{}:{}", path.display(), line);
    if let Some(found) = findings.iter_mut().find(|f| f.id == id) {
        if found.evidence.len() < 8 {
            found.evidence.push(RepoEvidence {
                label: "Also found".into(),
                value: location,
            });
        }
        return;
    }
    findings.push(RepoFinding {
        id: id.into(),
        severity,
        area: "Repository safety",
        title: title.into(),
        why: why.into(),
        where_: location.clone(),
        age: "in this checkout",
        is_new: true,
        verdict: verdict.into(),
        evidence: vec![
            RepoEvidence {
                label: "Location".into(),
                value: location,
            },
            RepoEvidence {
                label: "Matched text".into(),
                value: repo_redact(sample),
            },
        ],
        fix: None,
        asks: Vec::new(),
        static_scan: true,
    });
}

fn scan_repo(root: &Path) -> Result<RepoPreflight, String> {
    if !root.is_dir() {
        return Err("Choose a folder that exists.".into());
    }
    let root = root
        .canonicalize()
        .map_err(|e| format!("Could not open that folder: {e}"))?;
    let mut stack = vec![root.clone()];
    let mut findings = Vec::new();
    let (mut files_scanned, mut files_skipped) = (0usize, 0usize);
    let ignored = [
        ".git",
        "node_modules",
        "target",
        "dist",
        "build",
        ".next",
        ".nuxt",
        "vendor",
        ".venv",
        "venv",
        "coverage",
        "bin",
        "obj",
    ];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            files_skipped += 1;
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                files_skipped += 1;
                continue;
            };
            if kind.is_symlink() {
                files_skipped += 1;
                continue;
            }
            if kind.is_dir() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !ignored.iter().any(|x| name.eq_ignore_ascii_case(x)) {
                    stack.push(path);
                }
                continue;
            }
            if files_scanned >= 100_000 {
                files_skipped += 1;
                continue;
            }
            if !repo_text_file(&path) {
                files_skipped += 1;
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                files_skipped += 1;
                continue;
            };
            if meta.len() > 2 * 1024 * 1024 {
                files_skipped += 1;
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                files_skipped += 1;
                continue;
            };
            files_scanned += 1;
            let rel = path.strip_prefix(&root).unwrap_or(&path);
            let rel_lower = rel
                .to_string_lossy()
                .replace('\\', "/")
                .to_ascii_lowercase();
            for (i, line) in text.lines().enumerate() {
                let low = line.to_ascii_lowercase();
                let n = i + 1;
                let production =
                    low.contains("prod") || low.contains("production") || low.contains("live");
                if (low.contains("server=")
                    || low.contains("data source=")
                    || low.contains("mongodb+srv://")
                    || low.contains("postgres://")
                    || low.contains("postgresql://"))
                    && (production || low.contains("password=") || low.contains("user id="))
                {
                    repo_add(&mut findings, "high", "production-database", "Production-looking database connection", "An autonomous agent could run migrations, tests, seeds, or cleanup against real data.", rel, n, line, "Treat this checkout as connected to real data until the endpoint and account are proven isolated. Do not use auto mode.");
                }
                if low.contains("akia")
                    || low.contains("sk_live_")
                    || low.contains("ghp_")
                    || low.contains("github_pat_")
                    || low.contains("xoxb-")
                    || low.contains("-----begin private key-----")
                    || ((low.contains("api_key")
                        || low.contains("api-key")
                        || low.contains("client_secret")
                        || low.contains("access_token"))
                        && (line.contains('=') || line.contains(':'))
                        && !low.contains("example")
                        && !low.contains("your_"))
                {
                    repo_add(&mut findings, "high", "embedded-secret", "Credential or private key may be committed", "The value could grant an agent access outside this repository.", rel, n, line, "Rotate or revoke the credential, remove it from the checkout and history, and use a scoped secret store before running an agent.");
                }
                if production
                    && (low.contains("https://")
                        || low.contains("http://")
                        || low.contains("endpoint")
                        || low.contains("base_url")
                        || low.contains("baseurl"))
                {
                    repo_add(&mut findings, "medium", "production-api", "Production API endpoint referenced", "Code or tests may send writes, messages, payments, or deletions to a live service.", rel, n, line, "Confirm the client is read-only or replace the endpoint with a sandbox and deny outbound access during agent work.");
                }
                let destructive = low.contains("rm -rf")
                    || low.contains("remove-item") && low.contains("-recurse")
                    || low.contains("drop database")
                    || low.contains("drop table")
                    || low.contains("truncate table")
                    || low.contains("terraform destroy")
                    || low.contains("kubectl delete")
                    || low.contains("git push --force");
                if destructive {
                    repo_add(&mut findings, if production { "high" } else { "medium" }, "destructive-command", "Destructive command in repository automation", "An agent may invoke this command while testing, fixing, or following project instructions.", rel, n, line, "Review its target resolution and guardrails. Run agents with approvals and a filesystem/network sandbox until it is safe.");
                }
                if (rel_lower.ends_with("package.json")
                    && ["preinstall", "postinstall", "prepare"]
                        .iter()
                        .any(|k| low.contains(&format!("\"{k}\""))))
                    || (rel_lower.contains(".github/workflows/")
                        && (low.contains("workflow_run") || low.contains("pull_request_target")))
                {
                    repo_add(&mut findings, "medium", "automatic-execution", "Code can run automatically", "Installing dependencies or triggering CI may execute repository-controlled commands before they are reviewed.", rel, n, line, "Inspect the complete hook or workflow and install dependencies with scripts disabled until it is trusted.");
                }
                if (rel_lower.ends_with("agents.md")
                    || rel_lower.ends_with("claude.md")
                    || rel_lower.contains(".cursor/rules")
                    || rel_lower.contains(".github/copilot-instructions"))
                    && (low.contains("ignore previous")
                        || low.contains("without asking")
                        || low.contains("do not ask")
                        || low.contains("auto-approve")
                        || low.contains("danger-full-access")
                        || low.contains("send")
                            && (low.contains("secret") || low.contains("credential")))
                {
                    repo_add(&mut findings, "high", "agent-instruction-trap", "Repository instructions weaken agent safeguards", "Coding agents automatically consume instruction files; this text asks for reduced approval or sensitive behavior.", rel, n, line, "Read all repository agent instructions manually and remove or override unsafe directions before opening the repo in auto mode.");
                }
                if (rel_lower.contains("mcp") || rel_lower.contains("settings"))
                    && (low.contains("autoapprove")
                        || low.contains("alwaysallow")
                        || low.contains("dangerously")
                        || low.contains("allow-all"))
                {
                    repo_add(&mut findings, "high", "agent-permissions", "Agent tooling may be broadly auto-approved", "Repository settings can give tools network, shell, or data access without a confirmation step.", rel, n, line, "Use a user-controlled minimal tool allow-list and require approval for writes, shell commands, and network calls.");
                }
            }
        }
    }
    let verdict = if findings.iter().any(|f| f.severity == "high") {
        "stop"
    } else if findings.iter().any(|f| f.severity == "medium") {
        "review"
    } else {
        "clear"
    };
    let passed = vec![
        serde_json::json!({"name":"Read-only scan", "detail":"No repository code or scripts were executed"}),
        serde_json::json!({"name":"Generated dependencies skipped", "detail":"Vendor, build and dependency folders were excluded"}),
        serde_json::json!({"name":"Secret values redacted", "detail":"Evidence does not expose matched credential values"}),
    ];
    Ok(RepoPreflight {
        path: root.to_string_lossy().into_owned(),
        verdict,
        files_scanned,
        files_skipped,
        findings,
        passed,
    })
}

#[tauri::command]
pub async fn audit_repo_preflight(path: String) -> Result<RepoPreflight, String> {
    tauri::async_runtime::spawn_blocking(move || scan_repo(Path::new(&path)))
        .await
        .unwrap_or_else(|_| Err("The repository scan stopped unexpectedly.".into()))
}

/* ------------------------------------------------------------ the agents */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditAgent {
    id: &'static str,
    label: &'static str,
    installed: bool,
}

/// Which agent CLIs are on this machine. Presence only: the tool asks for a
/// choice, and a version check per CLI would make that choice wait.
#[tauri::command]
pub async fn audit_agents() -> Vec<AuditAgent> {
    tauri::async_runtime::spawn_blocking(|| {
        vec![
            AuditAgent {
                id: "claude",
                label: "Claude Code",
                installed: crate::term::claude_program().is_some(),
            },
            AuditAgent {
                id: "codex",
                label: "Codex",
                installed: crate::codex::codex_path().is_some(),
            },
            AuditAgent {
                id: "gemini",
                label: "Gemini",
                installed: crate::gemini::gemini_path().is_some(),
            },
            AuditAgent {
                id: "copilot",
                label: "GitHub Copilot",
                installed: crate::copilot::copilot_path().is_some(),
            },
            AuditAgent {
                id: "cursor",
                label: "Cursor Agent",
                installed: crate::cursor::find_agent().is_some(),
            },
        ]
    })
    .await
    .unwrap_or_default()
}

fn is_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn quote(value: &Path) -> String {
    format!("\"{}\"", value.display())
}

/// The whole command line for one turn, as `cmd.exe /s /c` runs it.
///
/// One string rather than a program and arguments, because the elevated host
/// has to run exactly the same thing and a string is what survives the pipe.
/// Nothing in it is typed by anyone: the prompt goes in on stdin, and the only
/// variable part is a session id that has already been checked.
fn turn_line(agent: &str, session: Option<&str>, first: bool) -> Result<String, String> {
    let session = session.filter(|id| is_session_id(id));
    let line = match agent {
        "claude" => {
            let path = crate::term::claude_program().ok_or("Claude Code is not installed.")?;
            let mut line = format!(
                "{} -p --output-format stream-json --verbose \
                 --allowedTools \"Bash,PowerShell,Read,Grep,Glob,LS,Edit,Write\"",
                quote(&path)
            );
            if let Some(id) = session {
                line.push_str(if first {
                    " --session-id "
                } else {
                    " --resume "
                });
                line.push_str(id);
            }
            line
        }
        "codex" => {
            let path = crate::codex::codex_path().ok_or("Codex is not installed.")?;
            let mut line = format!(
                "{} exec --json --skip-git-repo-check --sandbox danger-full-access",
                quote(&path)
            );
            if let (Some(id), false) = (session, first) {
                line.push_str(" resume ");
                line.push_str(id);
            }
            line.push_str(" -");
            line
        }
        "gemini" => {
            let path = crate::gemini::gemini_path().ok_or("Antigravity CLI is not installed.")?;
            let mut line = format!(
                "{} --input-format stream-json --output-format stream-json --dangerously-skip-permissions",
                quote(&path)
            );
            if let (Some(id), false) = (session, first) {
                line.push_str(" --conversation ");
                line.push_str(id);
            }
            line
        }
        "copilot" => {
            let path =
                crate::copilot::copilot_path().ok_or("GitHub Copilot CLI is not installed.")?;
            let mut line = format!(
                "{} --output-format json --allow-all --no-ask-user",
                quote(&path)
            );
            if let (Some(id), false) = (session, first) {
                line.push_str(&format!(" --resume={id}"));
            }
            line
        }
        "cursor" => {
            let found = crate::cursor::find_agent().ok_or("Cursor Agent is not installed.")?;
            let mut line = format!(
                "set \"CURSOR_INVOKED_AS=agent\"&& {} {} --print --output-format stream-json --force --trust",
                quote(&found.node),
                quote(&found.script)
            );
            if let Some(id) = session {
                line.push_str(" --resume ");
                line.push_str(id);
            }
            line
        }
        _ => return Err("That agent is not one the audit knows.".into()),
    };
    Ok(line)
}

/* ------------------------------------------------------------ the session */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditStart {
    /// The folder the audit keeps its log and report in, and the one
    /// every agent turn runs in - so the agent is not started inside somebody's
    /// project.
    dir: String,
    elevated: bool,
    computer: String,
}

/// Where every audit keeps its files: `%LOCALAPPDATA%\WinT\audits`.
fn audits_root() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("WinT")
        .join("audits")
}

/// Working directories to start the agent in, best first. The audit folder is
/// where the agent writes, so it is always tried first - but on a PC where
/// `%LOCALAPPDATA%` is redirected to a share, or points at a profile that has
/// been moved or emptied, `CreateProcess` rejects it with "the directory name
/// is invalid" and no agent of any kind can start. That is the PC's problem,
/// not the audit's: the agent is handed absolute paths and never depends on
/// where it was started, so any real local folder will do to keep going.
fn cwd_choices(dir: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut add = |path: PathBuf| {
        let text = path.to_string_lossy().into_owned();
        if !text.is_empty() && !out.contains(&text) {
            out.push(text);
        }
    };
    add(PathBuf::from(dir));
    add(std::env::temp_dir());
    if let Some(root) = std::env::var_os("SystemRoot") {
        add(PathBuf::from(root).join("Temp"));
    }
    add(PathBuf::from(r"C:\"));
    out
}

/// What the person is told when Windows refuses every one of them. The front
/// end matches on "Could not start the agent" to offer the setup guide, so the
/// elevated host's copy of this message says the same thing.
fn start_failed(dir: &str, why: &str) -> String {
    format!("Could not start the agent. Windows refused every working directory WinT tried, including its audit folder {dir}. ({why})")
}

/* ------------------------------------------ repairing a PC that starts nothing */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairStep {
    /// `ok` - it was already fine. `fixed` - WinT put it back.
    /// `bad` - broken, and not something WinT may fix on its own.
    status: &'static str,
    label: String,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repair {
    steps: Vec<RepairStep>,
    /// Whether an agent can be started at all now. False means scanning again
    /// is pointless until the person changes something themselves.
    usable: bool,
}

/// Can a process actually be started with this folder as its working
/// directory? The only honest test is to start one: `is_dir` answers yes for a
/// redirected folder that `CreateProcess` then refuses, which is the whole
/// reason the audit failed in the first place.
fn can_start_in(path: &Path) -> Result<(), String> {
    Command::new("cmd.exe")
        .raw_arg("/d /s /c \"exit\"")
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|mut child| {
            let _ = child.wait();
        })
        .map_err(|e| e.to_string())
}

/// Creates the folder if it is missing, then proves it by starting a process
/// in it, and says which of those two things happened.
fn repair_dir(label: &str, path: &Path) -> (RepairStep, bool) {
    let missing = !path.is_dir();
    let made = missing && std::fs::create_dir_all(path).is_ok();
    let shown = path.display();
    let step = match can_start_in(path) {
        Ok(()) if made => RepairStep {
            status: "fixed",
            label: label.into(),
            detail: format!(
                "{shown} was missing. WinT created it, and a program starts there now."
            ),
        },
        Ok(()) => RepairStep {
            status: "ok",
            label: label.into(),
            detail: format!("{shown} is there and a program starts in it."),
        },
        Err(why) => RepairStep {
            status: "bad",
            label: label.into(),
            detail: format!("Windows will not start a program in {shown}. ({why})"),
        },
    };
    let good = step.status != "bad";
    (step, good)
}

/// What the Fix button in the setup guide runs. Everything it does is safe to
/// do twice and stays inside folders Windows already expects to exist: it puts
/// back the two that a cleanup tool deletes, proves each candidate by starting
/// a process in it, and reports what it cannot repair. It deliberately never
/// touches the registry - Local AppData pointing at a share is a decision
/// somebody made about this PC, not a fault WinT may quietly undo.
#[tauri::command]
pub async fn audit_repair() -> Result<Repair, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut steps = Vec::new();
        let mut usable = false;

        for (label, path) in [
            ("The audit folder", audits_root()),
            ("The TEMP folder", std::env::temp_dir()),
        ] {
            let (step, good) = repair_dir(label, &path);
            usable |= good;
            steps.push(step);
        }

        // A last resort that exists on every Windows install. If even this is
        // refused, nothing is wrong with the folders and the PC itself is.
        let (step, good) = repair_dir("A fallback folder", Path::new(r"C:\Windows\Temp"));
        usable |= good;
        steps.push(step);

        // Not repaired, only reported: this is the usual cause on a managed PC,
        // and putting it back is the person's call, not WinT's.
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = local.to_string_lossy().into_owned();
            let redirected = local.starts_with(r"\\") || local.to_lowercase().contains("onedrive");
            steps.push(if redirected {
                RepairStep {
                    status: "bad",
                    label: "Local AppData is not a local folder".into(),
                    detail: format!("It points at {local}. Windows cannot reliably start a program there, which is why no agent starts on this PC. Point Local AppData back at the local profile - WinT will not change that for you."),
                }
            } else {
                RepairStep {
                    status: "ok",
                    label: "Local AppData is a local folder".into(),
                    detail: format!("It points at {local}."),
                }
            });
        }

        Ok(Repair { steps, usable })
    })
    .await
    .unwrap_or_else(|_| Err("The check could not be run.".into()))
}

/// A folder handed back by the front end, accepted only if it is one of ours.
fn audit_dir(dir: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(dir);
    let inside = path.parent().is_some_and(|parent| parent == audits_root());
    if inside && path.is_dir() {
        Ok(path)
    } else {
        Err("The audit folder is gone. Scan again.".into())
    }
}

fn is_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !value.starts_with('.')
}

struct Broker {
    requests: File,
    replies: Option<File>,
}

fn broker() -> &'static Mutex<Option<Broker>> {
    static BROKER: OnceLock<Mutex<Option<Broker>>> = OnceLock::new();
    BROKER.get_or_init(|| Mutex::new(None))
}

fn direct() -> &'static Mutex<Option<Child>> {
    static DIRECT: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
    DIRECT.get_or_init(|| Mutex::new(None))
}

/// Starts an audit. With `elevated`, this is where the one administrator
/// prompt happens; declining it fails the start rather than quietly carrying on
/// without rights the person asked for.
#[tauri::command]
pub async fn audit_begin(elevated: bool, stamp: String) -> Result<AuditStart, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_token(&stamp) {
            return Err("That audit name is not valid.".into());
        }
        cancel_now();
        let dir = audits_root().join(&stamp);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Could not prepare the audit folder: {e}"))?;
        let already = crate::dns::is_elevated();
        // Scanning again with the same rights keeps the administrator session,
        // so a second scan does not mean a second Windows prompt.
        let running = broker().lock().unwrap().is_some();
        if !elevated || already {
            stop_broker();
        } else if !running {
            let started = start_broker(&dir)?;
            *broker().lock().unwrap() = Some(started);
        }
        Ok(AuditStart {
            dir: dir.to_string_lossy().into_owned(),
            elevated: elevated || already,
            computer: std::env::var("COMPUTERNAME").unwrap_or_default(),
        })
    })
    .await
    .unwrap_or_else(|_| Err("The audit could not start.".into()))
}

/// Ends the audit: the elevated host, if there is one, exits when its pipes
/// close.
#[tauri::command]
pub async fn audit_end() {
    let _ = tauri::async_runtime::spawn_blocking(|| {
        cancel_now();
        stop_broker();
    })
    .await;
}

fn stop_broker() {
    broker().lock().unwrap().take();
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnLine {
    run: String,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnEnd {
    run: String,
    code: i32,
    error: String,
}

/// Runs one turn of the agent and streams it back.
///
/// Returns as soon as the turn is running: every line of the CLI's stream
/// arrives on `audit:line` and the turn finishes with `audit:end`. `run` is the
/// front end's token for the turn, so a line from a cancelled turn cannot land
/// in the next one.
#[tauri::command]
pub async fn audit_turn(
    app: AppHandle,
    run: String,
    agent: String,
    prompt: String,
    dir: String,
    session: Option<String>,
    first: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = audit_dir(&dir)?.to_string_lossy().into_owned();
        let mut session = session;
        // Cursor names a conversation before it has one; everyone else names
        // it in the stream of the first turn.
        if agent == "cursor" && session.is_none() {
            let id = crate::cursor::create_chat(&dir)?;
            let _ = app.emit(
                "audit:line",
                TurnLine {
                    run: run.clone(),
                    line: serde_json::json!({ "session_id": id }).to_string(),
                },
            );
            session = Some(id);
        }
        let line = turn_line(&agent, session.as_deref(), first)?;
        let prompt = if agent == "gemini" {
            serde_json::json!({ "event": "user", "message": { "content": prompt } }).to_string()
                + "\n"
        } else {
            prompt
        };
        let elevated = broker().lock().unwrap().is_some();
        if elevated {
            run_elevated(app, run, line, prompt, dir)
        } else {
            run_direct(app, run, line, prompt, dir)
        }
    })
    .await
    .unwrap_or_else(|_| Err("The agent could not be started.".into()))
}

/// Saves the report or the log into the audit's folder and returns its path.
#[tauri::command]
pub async fn audit_save(dir: String, name: String, text: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_token(&name) {
            return Err("That file name is not valid.".into());
        }
        let path = audit_dir(&dir)?.join(name);
        std::fs::write(&path, text).map_err(|e| format!("Could not save: {e}"))?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .unwrap_or_else(|_| Err("Could not save.".into()))
}

/// Past audits, newest first: the `summary.json` each run keeps beside its
/// full `run.json`, with the folder it came from. Only summaries are read, so
/// listing stays quick however long the logs get.
#[tauri::command]
pub async fn audit_history() -> Vec<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(|| {
        let Ok(entries) = std::fs::read_dir(audits_root()) else {
            return Vec::new();
        };
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort();
        dirs.reverse();
        dirs.into_iter()
            .take(200)
            .filter_map(|dir| {
                let text = std::fs::read_to_string(dir.join("summary.json")).ok()?;
                let mut value: serde_json::Value = serde_json::from_str(&text).ok()?;
                value
                    .as_object_mut()?
                    .insert("dir".into(), dir.to_string_lossy().into_owned().into());
                Some(value)
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// One past audit in full.
#[tauri::command]
pub async fn audit_load(dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read_to_string(audit_dir(&dir)?.join("run.json"))
            .map_err(|e| format!("Could not read that audit: {e}"))
    })
    .await
    .unwrap_or_else(|_| Err("Could not read that audit.".into()))
}

/// Deletes a past audit: its run, its report and its log.
#[tauri::command]
pub async fn audit_delete(dir: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::remove_dir_all(audit_dir(&dir)?)
            .map_err(|e| format!("Could not delete that audit: {e}"))
    })
    .await
    .unwrap_or_else(|_| Err("Could not delete that audit.".into()))
}

#[tauri::command]
pub async fn audit_cancel() {
    let _ = tauri::async_runtime::spawn_blocking(cancel_now).await;
}

fn cancel_now() {
    if let Some(child) = direct().lock().unwrap().as_mut() {
        // `cmd.exe` is the child; the agent is its child. The tree has to go.
        let _ = Command::new("taskkill.exe")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let _ = child.kill();
    }
    if let Some(broker) = broker().lock().unwrap().as_mut() {
        let _ = broker.requests.write_all(b"cancel\n");
    }
}

fn run_direct(
    app: AppHandle,
    run: String,
    line: String,
    prompt: String,
    dir: String,
) -> Result<(), String> {
    cancel_now();
    let mut started = None;
    let mut why = String::new();
    for cwd in cwd_choices(&dir) {
        match Command::new("cmd.exe")
            .raw_arg(format!("/d /s /c \"{line}\""))
            .current_dir(&cwd)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => {
                started = Some(child);
                break;
            }
            Err(e) => why = e.to_string(),
        }
    }
    let mut child = started.ok_or_else(|| start_failed(&dir, &why))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes());
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *direct().lock().unwrap() = Some(child);

    std::thread::spawn(move || {
        let errors = std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut stderr) = stderr {
                let _ = stderr.read_to_string(&mut text);
            }
            text
        });
        if let Some(stdout) = stdout {
            // Lossy: one badly encoded byte in a path must not end the stream.
            let mut reader = BufReader::new(stdout);
            let mut bytes = Vec::new();
            while reader.read_until(b'\n', &mut bytes).is_ok_and(|n| n > 0) {
                let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
                bytes.clear();
                if !line.trim().is_empty() {
                    let _ = app.emit(
                        "audit:line",
                        TurnLine {
                            run: run.clone(),
                            line,
                        },
                    );
                }
            }
        }
        let code = direct()
            .lock()
            .unwrap()
            .take()
            .and_then(|mut child| child.wait().ok())
            .and_then(|status| status.code())
            .unwrap_or(-1);
        let error = errors.join().unwrap_or_default();
        let _ = app.emit("audit:end", TurnEnd { run, code, error });
    });
    Ok(())
}

fn run_elevated(
    app: AppHandle,
    run: String,
    line: String,
    prompt: String,
    dir: String,
) -> Result<(), String> {
    let (mut replies, mut requests) = {
        let mut guard = broker().lock().unwrap();
        let broker = guard
            .as_mut()
            .ok_or("The administrator session has ended.")?;
        let replies = broker
            .replies
            .take()
            .ok_or("The agent is still answering the last step.")?;
        let requests = broker.requests.try_clone().map_err(|e| e.to_string())?;
        (replies, requests)
    };
    let request = serde_json::json!({
        "args": format!("/d /s /c \"{line}\""),
        "cwd": dir,
        "stdin": prompt,
    })
    .to_string();
    let sent = requests
        .write_all(format!("{}\n", crate::workspace::base64(request.as_bytes())).as_bytes())
        .and_then(|_| requests.flush());
    if let Err(e) = sent {
        stop_broker();
        return Err(format!("The administrator session has ended: {e}"));
    }

    std::thread::spawn(move || {
        let decode = |text: &str| {
            crate::workspace::unbase64(text)
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .unwrap_or_default()
        };
        let mut ended = None;
        {
            let mut reader = BufReader::new(&mut replies);
            let mut raw = String::new();
            loop {
                raw.clear();
                match reader.read_line(&mut raw) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let text = raw.trim_end();
                if let Some(body) = text.strip_prefix("L ") {
                    let line = decode(body);
                    if !line.trim().is_empty() {
                        let _ = app.emit(
                            "audit:line",
                            TurnLine {
                                run: run.clone(),
                                line,
                            },
                        );
                    }
                } else if let Some(rest) = text.strip_prefix("E ") {
                    let (code, error) = rest.split_once(' ').unwrap_or((rest, ""));
                    ended = Some((code.parse().unwrap_or(-1), decode(error)));
                    break;
                }
            }
        }
        match ended {
            Some((code, error)) => {
                if let Some(broker) = broker().lock().unwrap().as_mut() {
                    broker.replies = Some(replies);
                }
                let _ = app.emit("audit:end", TurnEnd { run, code, error });
            }
            None => {
                stop_broker();
                let _ = app.emit(
                    "audit:end",
                    TurnEnd {
                        run,
                        code: -1,
                        error: "The administrator session closed unexpectedly.".into(),
                    },
                );
            }
        }
    });
    Ok(())
}

/* --------------------------------------------------- the elevated host */

/// Runs in the elevated PowerShell. Reads one request per line, runs the turn
/// with its stdout streamed back line by line, and watches for `cancel` while
/// the turn runs. When WinT's end of the pipe closes, it kills whatever is
/// running and exits - it must never outlive the audit.
const HOST_PS: &str = r#"
$ErrorActionPreference = 'Stop'
$enc = New-Object System.Text.UTF8Encoding($false)
$inPipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', '__REQ__', [System.IO.Pipes.PipeDirection]::In)
$inPipe.Connect(60000)
$outPipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', '__REP__', [System.IO.Pipes.PipeDirection]::Out)
$outPipe.Connect(60000)
$reader = New-Object System.IO.StreamReader($inPipe, $enc)
$writer = New-Object System.IO.StreamWriter($outPipe, $enc)
$writer.AutoFlush = $true
function B64([string]$s) { [Convert]::ToBase64String($enc.GetBytes($s)) }
$pending = $null
while ($true) {
  if ($null -eq $pending) { $pending = $reader.ReadLineAsync() }
  $line = $pending.Result
  $pending = $null
  if ($null -eq $line) { break }
  if ($line -eq 'cancel' -or $line -eq '') { continue }
  $req = $enc.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
  # The audit folder is where the agent writes, so it is tried first - but an
  # elevated session can be handed a path Windows will not start a process in
  # (a redirected %LOCALAPPDATA%, a profile that has moved), and the audit must
  # not die because of it. The agent works in absolute paths either way.
  $cwd = [string]$req.cwd
  if ($cwd -and -not (Test-Path -LiteralPath $cwd -PathType Container)) {
    try { New-Item -ItemType Directory -Force -Path $cwd | Out-Null } catch { }
  }
  $p = $null
  $why = ''
  foreach ($try in @($cwd, $env:TEMP, "$env:SystemRoot\Temp", 'C:\') | Where-Object { $_ } | Select-Object -Unique) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo('cmd.exe', [string]$req.args)
    $psi.WorkingDirectory = $try
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $enc
    $psi.StandardErrorEncoding = $enc
    try { $p = [System.Diagnostics.Process]::Start($psi); break } catch { $why = "$_" }
  }
  if ($null -eq $p) {
    $writer.WriteLine('E -1 ' + (B64 ("Could not start the agent. Windows refused every working directory WinT tried, including its audit folder " + $cwd + ". (" + $why + ")")))
    continue
  }
  $bytes = $enc.GetBytes([string]$req.stdin)
  $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  $p.StandardInput.Close()
  $errTask = $p.StandardError.ReadToEndAsync()
  $closed = $false
  while ($true) {
    $next = $p.StandardOutput.ReadLineAsync()
    while (-not $next.Wait(200)) {
      if ($null -eq $pending) { $pending = $reader.ReadLineAsync() }
      if ($pending.IsCompleted) {
        $cmd = $pending.Result
        $pending = $null
        if ($null -eq $cmd) { $closed = $true }
        if ($closed -or $cmd -eq 'cancel') { & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null }
      }
    }
    if ($null -eq $next.Result) { break }
    $writer.WriteLine('L ' + (B64 $next.Result))
  }
  $p.WaitForExit()
  $writer.WriteLine('E ' + $p.ExitCode + ' ' + (B64 $errTask.Result))
  if ($closed) { break }
}
"#;

fn pipe_name(dir: &Path, which: &str) -> String {
    let leaf = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    format!("wint-audit-{}-{leaf}-{which}", std::process::id())
}

fn start_broker(dir: &Path) -> Result<Broker, String> {
    use std::os::windows::io::FromRawHandle;
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId,
        PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
    };
    use windows::Win32::System::Threading::{GetProcessId, WaitForSingleObject};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let req_name = pipe_name(dir, "req");
    let rep_name = pipe_name(dir, "rep");
    let create = |name: &str, access| -> Result<HANDLE, String> {
        let full = HSTRING::from(format!(r"\\.\pipe\{name}"));
        let handle = unsafe {
            CreateNamedPipeW(
                &full,
                access | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                64 * 1024,
                64 * 1024,
                0,
                None,
            )
        };
        if handle.is_invalid() {
            Err("Could not open a channel to the administrator session.".into())
        } else {
            Ok(handle)
        }
    };
    // WinT writes requests (outbound here, `In` for the host) and reads replies.
    let req = create(&req_name, PIPE_ACCESS_OUTBOUND)?;
    let rep = match create(&rep_name, PIPE_ACCESS_INBOUND) {
        Ok(h) => h,
        Err(e) => {
            unsafe {
                let _ = CloseHandle(req);
            }
            return Err(e);
        }
    };
    let close_both = || unsafe {
        let _ = CloseHandle(req);
        let _ = CloseHandle(rep);
    };

    let script = HOST_PS
        .replace("__REQ__", &req_name)
        .replace("__REP__", &rep_name);
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    let params = HSTRING::from(format!(
        "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand {}",
        crate::workspace::base64(&utf16)
    ));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: w!("runas"),
        lpFile: w!("powershell.exe"),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if ShellExecuteExW(&mut info).is_err() || info.hProcess.is_invalid() {
            close_both();
            return Err(
                "The administrator prompt was declined, so the audit did not start.".into(),
            );
        }
    }
    let process = info.hProcess;
    let expected = unsafe { GetProcessId(process) };

    // If the host dies before it connects, nothing would ever unblock
    // `ConnectNamedPipe`. The watchdog connects to both pipes itself in that
    // case; the process id check below then refuses the connection.
    let connected = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let watch = {
        let connected = connected.clone();
        let raw = process.0 as isize;
        let (req_name, rep_name) = (req_name.clone(), rep_name.clone());
        std::thread::spawn(move || {
            let process = HANDLE(raw as *mut _);
            for _ in 0..120 {
                if connected.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                // WAIT_OBJECT_0: the host exited without connecting.
                if unsafe { WaitForSingleObject(process, 500) }.0 == 0 {
                    break;
                }
            }
            if !connected.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = std::fs::OpenOptions::new()
                    .read(true)
                    .open(format!(r"\\.\pipe\{req_name}"));
                let _ = std::fs::OpenOptions::new()
                    .write(true)
                    .open(format!(r"\\.\pipe\{rep_name}"));
            }
        })
    };

    let accept = |pipe: HANDLE| -> bool {
        unsafe {
            // ERROR_PIPE_CONNECTED means the client beat us to it, which is fine.
            let ok = ConnectNamedPipe(pipe, None).is_ok()
                || windows::Win32::Foundation::GetLastError()
                    == windows::Win32::Foundation::ERROR_PIPE_CONNECTED;
            let mut pid = 0u32;
            ok && GetNamedPipeClientProcessId(pipe, &mut pid).is_ok()
                && pid == expected
                && expected != 0
        }
    };
    let good = accept(req) && accept(rep);
    connected.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = watch.join();
    unsafe {
        let _ = CloseHandle(process);
    }
    if !good {
        close_both();
        return Err("The administrator session did not start.".into());
    }
    let requests = unsafe { File::from_raw_handle(req.0 as _) };
    let replies = unsafe { File::from_raw_handle(rep.0 as _) };
    Ok(Broker {
        requests,
        replies: Some(replies),
    })
}
