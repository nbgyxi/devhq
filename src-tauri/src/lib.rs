mod ai;
pub mod analytics;
mod assistant;
mod cli_registration;
#[cfg(windows)]
pub mod conpty;
mod cwd;
pub mod disk_space;
pub mod dns;
mod download;
pub mod git;
pub mod github;
#[cfg(windows)]
mod jump_list;
pub mod network;
mod path_ping;
#[cfg(windows)]
mod picker;
pub mod procs;
#[cfg(windows)]
mod shells;
mod tech;
#[cfg(windows)]
mod workspace;
mod term;
pub mod todo;
mod tool_window;
mod util;
#[cfg(windows)]
pub mod vt;
pub mod windows_tools;

use procs::{ProcessSnapshot, RunningProc};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

fn show_main_window(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("wint-tray") {
        let _ = tray.set_visible(false);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn minimize_to_tray(app: AppHandle) {
    if let Some(tray) = app.tray_by_id("wint-tray") {
        let _ = tray.set_visible(true);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[derive(Default)]
struct PendingTool(Mutex<Option<String>>);

#[derive(Default)]
struct SearchGlobalShortcut(Mutex<Option<u32>>);

#[tauri::command]
fn search_global_binding_set(
    state: tauri::State<'_, SearchGlobalShortcut>,
    binding: String,
) -> Result<(), String> {
    let id = if binding.trim().is_empty() {
        None
    } else {
        Some(
            binding
                .parse::<tauri_plugin_global_shortcut::Shortcut>()
                .map_err(|e| format!("That Search shortcut is invalid: {e}"))?
                .id,
        )
    };
    *state.0.lock().map_err(|_| "Search shortcut state is unavailable.".to_string())? = id;
    Ok(())
}

fn tool_arg(args: &[String]) -> Option<String> {
    args.iter()
        .find_map(|arg| arg.strip_prefix("--open-tool=").map(str::to_owned))
}

fn deliver_tool_arg(app: &AppHandle, args: &[String]) {
    deliver_tool_arg_for(app, args, "")
}

/// `token` names the queued request, and is what the window answers on so the
/// `wt` still waiting in the shell learns what happened. Empty for arguments
/// that arrived on a command line, where there is nobody left to tell.
fn deliver_tool_arg_for(app: &AppHandle, args: &[String], token: &str) {
    if let Some(mut request) = wt_request_arg(args) {
        request.token = token.to_string();
        let _ = app.emit("term:wt-request", request);
        return;
    }
    let Some(id) = tool_arg(args) else { return };
    if let Ok(mut pending) = app.state::<PendingTool>().0.lock() {
        *pending = Some(id.clone());
    }
    show_main_window(app);
    let _ = app.emit("tray:open-tool", id);
}

/// A request the `wt` proxy left behind is only worth acting on while the
/// terminal that sent it can still be looked at. One that nothing picked up in
/// half a minute is from a window that has gone, and is dropped rather than
/// replayed into whatever is open now.
fn wt_request_is_stale(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|data| data.modified())
        .map(|written| written.elapsed().unwrap_or_default() > Duration::from_secs(30))
        .unwrap_or(true)
}

fn start_wt_request_queue(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(local) = std::env::var_os("LOCALAPPDATA") else { return };
        let queue = PathBuf::from(local).join("WinT").join("runtime").join("requests");
        let _ = std::fs::create_dir_all(&queue);
        let mut reported = false;
        let mut passes: u32 = 0;
        loop {
            passes = passes.wrapping_add(1);
            if passes % 50 == 0 { sweep_wt_replies(); }
            // The windows are deliberately not a condition for staying here.
            // Ending this thread the first time none could be found - during
            // startup, or for the instant one is being replaced - took every
            // `wt` command for the rest of the run down with it, silently: the
            // proxy went on writing requests that nobody was left to read.
            match std::fs::read_dir(&queue) {
                Ok(entries) => {
                    reported = false;
                    for entry in entries.flatten() {
                        let path = entry.path();
                        let valid = path.file_name().and_then(|name| name.to_str())
                            .is_some_and(|name| name.starts_with("wt-") && name.ends_with(".json"));
                        if !valid { continue; }
                        // Nothing can act on it yet. Leave it where it is and
                        // take it on a later pass rather than dropping it.
                        if app.webview_windows().is_empty() {
                            if wt_request_is_stale(&path) { let _ = std::fs::remove_file(&path); }
                            continue;
                        }
                        let token = path
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or_default()
                            .to_string();
                        if let Ok(bytes) = std::fs::read(&path) {
                            if let Ok(args) = serde_json::from_slice::<Vec<String>>(&bytes) {
                                deliver_tool_arg_for(&app, &args, &token);
                            }
                        }
                        // Removed last: the proxy waits for the file to go, and
                        // that is what tells the shell the command was taken.
                        let _ = std::fs::remove_file(path);
                    }
                }
                Err(error) => {
                    if !reported {
                        eprintln!("WinT: the wt request queue at {} cannot be read: {error}", queue.display());
                        reported = true;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    });
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct WtRequest {
    term_id: String,
    /// The queued file this came from. The window that acts on the request
    /// answers on this name, and `wt` is still in the shell waiting for it.
    token: String,
    window: String,
    maximized: bool,
    fullscreen: bool,
    focus: bool,
    position: Option<String>,
    dimensions: Option<String>,
    actions: Vec<WtAction>,
}

#[derive(Clone, Serialize, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
struct WtAction {
    kind: String,
    cwd: String,
    title: String,
    profile: String,
    command: String,
    direction: String,
    target: Option<usize>,
    size: Option<f64>,
    duplicate: bool,
    tab_color: String,
    color_scheme: String,
}

fn quote_windows_arg(value: &str) -> String {
    if !value.is_empty() && !value.chars().any(|c| c.is_whitespace() || c == '"') {
        return value.to_string();
    }
    let mut out = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
        } else if ch == '"' {
            out.push_str(&"\\".repeat(slashes * 2 + 1));
            out.push('"');
            slashes = 0;
        } else {
            out.push_str(&"\\".repeat(slashes));
            slashes = 0;
            out.push(ch);
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

fn is_wt_action(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "new-tab"
            | "nt"
            | "split-pane"
            | "sp"
            | "focus-tab"
            | "ft"
            | "move-focus"
            | "mf"
            | "move-pane"
            | "mp"
            | "swap-pane"
    )
}

fn wt_request_arg(args: &[String]) -> Option<WtRequest> {
    let term_id = args
        .iter()
        .find_map(|arg| arg.strip_prefix("--wint-wt="))?
        .to_string();
    let mut request = WtRequest {
        term_id,
        token: String::new(),
        window: "0".into(),
        maximized: false,
        fullscreen: false,
        focus: false,
        position: None,
        dimensions: None,
        actions: Vec::new(),
    };
    let clean = args
        .iter()
        .skip(1)
        .filter(|arg| !arg.starts_with("--wint-wt="))
        .cloned()
        .collect::<Vec<_>>();
    let mut groups = Vec::<Vec<String>>::new();
    let mut group = Vec::new();
    for arg in clean {
        if arg == ";" || arg == "\\;" {
            if !group.is_empty() {
                groups.push(group);
                group = Vec::new();
            }
        } else {
            group.push(arg);
        }
    }
    if !group.is_empty() {
        groups.push(group);
    }
    if groups.is_empty() {
        request.actions.push(WtAction {
            kind: "new-tab".into(),
            ..Default::default()
        });
        return Some(request);
    }
    for (group_index, words) in groups.into_iter().enumerate() {
        let mut action = WtAction::default();
        let mut index = 0;
        if group_index == 0 {
            while index < words.len() && !is_wt_action(&words[index]) {
                let word = &words[index];
                let next = || words.get(index + 1).cloned();
                match word.as_str() {
                    "--help" | "-h" | "-?" | "/?" => {
                        request.actions.push(WtAction {
                            kind: "help".into(),
                            ..Default::default()
                        });
                        return Some(request);
                    }
                    "--window" | "-w" => {
                        request.window = next()?;
                        index += 2;
                    }
                    "--maximized" | "-M" => {
                        request.maximized = true;
                        index += 1;
                    }
                    "--fullscreen" | "-F" => {
                        request.fullscreen = true;
                        index += 1;
                    }
                    "--focus" | "-f" => {
                        request.focus = true;
                        index += 1;
                    }
                    "--pos" => {
                        request.position = next();
                        index += 2;
                    }
                    "--size" => {
                        request.dimensions = next();
                        index += 2;
                    }
                    _ => break,
                }
            }
        }
        if words.get(index).is_some_and(|word| is_wt_action(word)) {
            action.kind = match words[index].to_ascii_lowercase().as_str() {
                "nt" => "new-tab",
                "sp" => "split-pane",
                "ft" => "focus-tab",
                "mf" => "move-focus",
                "mp" => "move-pane",
                other => other,
            }
            .into();
            index += 1;
        } else if group_index == 0 {
            action.kind = "new-tab".into();
        } else {
            return None;
        }
        let mut command = Vec::new();
        while index < words.len() {
            let word = &words[index];
            let lower = word.to_ascii_lowercase();
            let next = || words.get(index + 1).cloned();
            match lower.as_str() {
                "--profile" | "-p" => {
                    action.profile = next()?;
                    index += 2;
                }
                _ if action.kind == "split-pane" && (word == "-D" || lower == "--duplicate") => {
                    action.duplicate = true;
                    index += 1;
                }
                "--startingdirectory" | "-d" => {
                    action.cwd = next()?;
                    index += 2;
                }
                "--title" => {
                    action.title = next()?;
                    index += 2;
                }
                "--tabcolor" => {
                    action.tab_color = next()?;
                    index += 2;
                }
                "--colorscheme" => {
                    action.color_scheme = next()?;
                    index += 2;
                }
                "--horizontal" | "-h" => {
                    action.direction = "horizontal".into();
                    index += 1;
                }
                "--vertical" | "-v" => {
                    action.direction = "vertical".into();
                    index += 1;
                }
                "--size" | "-s" if action.kind == "split-pane" => {
                    action.size = next()?.parse().ok();
                    index += 2;
                }
                "--target" | "--tab" | "-t" => {
                    action.target = next()?.parse().ok();
                    index += 2;
                }
                "--suppressapplicationtitle"
                | "--useapplicationtitle"
                | "--appendcommandline"
                | "--inheritenvironment"
                | "!--reloadenvironment" => {
                    index += 1;
                }
                _ if matches!(action.kind.as_str(), "move-focus" | "swap-pane") => {
                    action.direction = word.clone();
                    index += 1;
                }
                _ => {
                    command.extend_from_slice(&words[index..]);
                    break;
                }
            }
        }
        action.command = command
            .iter()
            .map(|arg| quote_windows_arg(arg))
            .collect::<Vec<_>>()
            .join(" ");
        request.actions.push(action);
    }
    (!request.actions.is_empty()).then_some(request)
}

fn wt_reply_dir() -> Option<PathBuf> {
    Some(
        PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
            .join("WinT")
            .join("runtime")
            .join("replies"),
    )
}

/// What became of a `wt` command, written back for the proxy still holding the
/// shell's prompt. A pane that could not start has to be reported where the
/// command was typed - a dialog in the window is no use to a script, and the
/// exit status is what a script reads.
#[tauri::command]
async fn wt_report(token: String, ok: bool, message: String) -> Result<(), String> {
    // The token names a file, and it arrives from a window. It may only ever
    // be one of the queue's own names.
    let named = token.starts_with("wt-")
        && token.ends_with(".json")
        && !token.contains(['/', '\\', ':'])
        && token.len() < 128;
    if !named {
        return Err("That is not a wt request.".into());
    }
    off_thread(move || {
        let replies = wt_reply_dir().ok_or("The local application-data folder is unavailable.")?;
        std::fs::create_dir_all(&replies).map_err(|e| e.to_string())?;
        let body = serde_json::json!({ "ok": ok, "message": message }).to_string();
        // Written aside and renamed, so the proxy never reads half an answer.
        let pending = replies.join(format!(".{token}.tmp"));
        std::fs::write(&pending, body).map_err(|e| e.to_string())?;
        std::fs::rename(&pending, replies.join(&token)).map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|| Err("Could not answer that wt command.".into()))
}

/// Answers nobody came back for - the shell was closed while `wt` waited, or
/// the proxy was killed. They are worthless after a few seconds and must not
/// pile up in a folder WinT reads on a timer.
fn sweep_wt_replies() {
    let Some(replies) = wt_reply_dir() else { return };
    let Ok(entries) = std::fs::read_dir(&replies) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if wt_request_is_stale(&path) {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod wt_compat_tests {
    use super::*;

    #[test]
    fn parses_the_existing_mock_server_split_command() {
        let args = [
            "wint-desktop.exe",
            "--wint-wt=t7",
            "--window",
            "0",
            "split-pane",
            "--profile",
            "PowerShell",
            "--startingDirectory",
            r"C:\code\app\client",
            "--title",
            "Angular frontend",
            "pwsh",
            "-noExit",
            "-ExecutionPolicy",
            "RemoteSigned",
            "-Command",
            "pnpm",
            "start",
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
        let request = wt_request_arg(&args).unwrap();
        assert_eq!(request.term_id, "t7");
        assert_eq!(request.actions[0].kind, "split-pane");
        assert_eq!(request.actions[0].cwd, r"C:\code\app\client");
        assert_eq!(
            request.actions[0].command,
            "pwsh -noExit -ExecutionPolicy RemoteSigned -Command pnpm start"
        );
    }
}

#[tauri::command]
fn take_startup_tool(state: tauri::State<'_, PendingTool>) -> Option<String> {
    state.0.lock().ok()?.take()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayTool {
    id: String,
    name: String,
}

#[tauri::command]
fn tray_set_recent_tools(app: AppHandle, tools: Vec<TrayTool>) -> Result<(), String> {
    use tauri::menu::MenuBuilder;

    #[cfg(windows)]
    {
        let packaged_icons = app
            .path()
            .resource_dir()
            .ok()
            .map(|path| path.join("tool-icons"));
        jump_list::set_recent_tools(&tools, packaged_icons)?;
    }

    let mut menu = MenuBuilder::new(&app).text("tray-open", "Open WinT");
    for tool in tools.into_iter().take(6) {
        menu = menu.text(format!("tray-tool:{}", tool.id), tool.name);
    }
    menu = menu.separator().text("tray-quit", "Quit");
    let menu = menu.build().map_err(|error| error.to_string())?;
    let tray = app
        .tray_by_id("wint-tray")
        .ok_or_else(|| "WinT tray icon is unavailable".to_string())?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())
}

#[tauri::command]
async fn cli_status() -> Result<cli_registration::CliStatus, String> {
    off_thread(cli_registration::status)
        .await
        .unwrap_or_else(|| Err("Could not inspect the CLI registration.".into()))
}

#[tauri::command]
async fn cli_install(app: AppHandle) -> Result<cli_registration::CliStatus, String> {
    off_thread(move || cli_registration::install(app))
        .await
        .unwrap_or_else(|| Err("Could not install the CLI.".into()))
}

#[tauri::command]
async fn cli_uninstall() -> Result<cli_registration::CliStatus, String> {
    off_thread(cli_registration::uninstall)
        .await
        .unwrap_or_else(|| Err("Could not remove the CLI.".into()))
}

/// Directories that are never projects themselves and are never worth
/// descending into when looking for one.
const NOISE: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "venv",
    ".venv",
    "__pycache__",
    "bin",
    "obj",
    "coverage",
    ".next",
    ".nuxt",
    ".cache",
    ".idea",
    ".vs",
    ".vscode",
];

/// Any one of these in a directory makes it a project, even without a `.git`.
const MARKERS: &[&str] = &[
    "package.json",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "requirements.txt",
    "Pipfile",
    "setup.py",
    "pom.xml",
    "build.gradle",
    "Gemfile",
    "composer.json",
    "deno.json",
    "Makefile",
    "CMakeLists.txt",
    "manifest.json",
    "Dockerfile",
    "index.html",
    "CLAUDE.md",
    ".claude",
    ".gitignore",
];

/// How many worker threads fan out over the discovered projects. Each project's
/// work is dominated by waiting on `git`, so oversubscribing the CPU count is
/// the point rather than a mistake.
const WORKERS: usize = 12;

/// Finished projects are shipped to the front end in batches, so a few hundred
/// of them do not become a few hundred separate IPC round trips.
const BATCH: usize = 16;
const BATCH_MS: u64 = 40;

/// Every scan gets a token, and starting one bumps the counter. Workers left
/// over from an earlier scan notice they are stale and stop, so a rescan never
/// has to wait for the run it replaces.
static SCAN_TOKEN: AtomicU64 = AtomicU64::new(0);

fn scan_is_current(token: u64) -> bool {
    SCAN_TOKEN.load(Ordering::SeqCst) == token
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Runs blocking work off the UI thread. Every command that touches the disk or
/// spawns a process goes through here, because a synchronous `#[tauri::command]`
/// runs on the main thread and freezes the window for as long as it takes.
async fn off_thread<T, F>(work: F) -> Option<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work).await.ok()
}

#[tauri::command]
async fn assistant_status(app: AppHandle) -> assistant::Status {
    let Ok(root) = app.path().app_data_dir() else {
        return assistant::Status::default();
    };
    off_thread(move || ai::status(root))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn assistant_cloud_status() -> ai::cloud::CloudStatus {
    off_thread(ai::cloud::status).await.unwrap_or_default()
}

#[tauri::command]
async fn assistant_cloud_configure(
    provider: String,
    key: String,
) -> Result<ai::cloud::CloudStatus, String> {
    off_thread(move || ai::cloud::configure(&provider, key))
        .await
        .unwrap_or_else(|| Err("The API key could not be saved.".into()))
}

#[tauri::command]
async fn assistant_cloud_remove(provider: String) -> Result<ai::cloud::CloudStatus, String> {
    off_thread(move || ai::cloud::remove(&provider))
        .await
        .unwrap_or_else(|| Err("The API key could not be removed.".into()))
}

#[tauri::command]
fn assistant_pull(app: AppHandle, model: String) -> Result<(), String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    ai::pull(app, root, model)
}

#[cfg(windows)]
#[tauri::command]
async fn shell_downloads() -> Vec<shells::ShellDownload> {
    off_thread(shells::catalog).await.unwrap_or_default()
}

#[cfg(windows)]
#[tauri::command]
fn shell_download_start(app: AppHandle, profile: String) -> Result<(), String> {
    shells::install(app, profile)
}

#[cfg(windows)]
#[tauri::command]
fn shell_download_cancel() {
    shells::cancel();
}

#[cfg(windows)]
#[tauri::command]
async fn shell_download_remove(profile: String) -> Result<(), String> {
    off_thread(move || shells::remove(&profile))
        .await
        .unwrap_or_else(|| Err("The shell could not be removed.".into()))
}

#[tauri::command]
fn assistant_pull_cancel() {
    ai::cancel_pull();
}

#[tauri::command]
async fn assistant_model_delete(app: AppHandle, model: String) -> Result<(), String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    off_thread(move || ai::delete_model(root, model))
        .await
        .unwrap_or_else(|| Err("The model deletion did not finish.".into()))
}

#[tauri::command]
fn assistant_chat(
    app: AppHandle,
    request_id: String,
    model: String,
    question: String,
    prompt: String,
    project_context: String,
    roots: Vec<String>,
    areas: Vec<ai::RouteOption>,
    think: bool,
    tool_call_cap: usize,
) -> Result<(), String> {
    if model.starts_with("claude:")
        || model.starts_with("codex:")
        || model.starts_with("gpt:")
        || model.starts_with("cursor:")
    {
        let cloud_prompt = format!("{}\n\nWinT project context:\n{}", prompt, project_context);
        return ai::cloud::chat(app, request_id, model, cloud_prompt, roots, tool_call_cap);
    }
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    ai::chat(
        app,
        root,
        request_id,
        model,
        question,
        prompt,
        project_context,
        roots,
        areas,
        think,
        tool_call_cap,
    )
}

#[tauri::command]
fn assistant_chat_cancel() {
    ai::cancel_chat();
    ai::cloud::cancel();
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub path: String,
    /// Parent folder name when the project sits one level below the scan root,
    /// empty for a direct child.
    pub group: String,
    pub description: String,
    pub version: String,
    pub package_manager: String,
    pub scripts: Vec<[String; 2]>,
    pub dep_count: u32,
    pub dev_dep_count: u32,
    pub flags: Vec<String>,
    pub tech: Vec<tech::Tech>,
    pub git: Option<git::GitInfo>,
    /// Filled in by the process sweep, which runs beside the per-project work
    /// and arrives in its own event.
    pub running: Vec<RunningProc>,
    pub ports: Vec<u16>,
    /// The command that starts this project, empty when nothing in the folder
    /// says how to. Worked out here, once, rather than guessed in the front end.
    pub run_cmd: String,
    /// Newest mtime among the project's top-level entries, in epoch ms.
    pub touched_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub root: String,
    pub scanned_at_ms: u64,
    pub duration_ms: u64,
    pub projects: Vec<Project>,
    pub error: String,
}

/// One discovered folder, sent before any of its details are known so the
/// window can draw the whole list as skeletons straight away.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stub {
    pub name: String,
    pub path: String,
    pub group: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProcPatch {
    path: String,
    running: Vec<RunningProc>,
    ports: Vec<u16>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanStart {
    token: u64,
    roots: Vec<String>,
    scanned_at_ms: u64,
    stubs: Vec<Stub>,
    error: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanBatch {
    token: u64,
    projects: Vec<Project>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanProcs {
    token: u64,
    items: Vec<ProcPatch>,
}

/// A named step of the scan, so the window can say what it is actually doing
/// rather than showing an unlabelled spinner.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanPhase {
    token: u64,
    key: String,
    label: String,
    done: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanDone {
    token: u64,
    duration_ms: u64,
    error: String,
    cancelled: bool,
}

/// Starts a scan and returns its token immediately. Nothing is scanned on the
/// caller's thread: the folder list arrives as `scan:start`, projects fill in
/// through `scan:project`, running processes through `scan:procs`, and
/// `scan:done` closes it out.
/// The version the app was built as - `tauri.conf.json`'s, which is the one
/// `package-msix.ps1 -BumpVersion` moves and the one the installer carries.
/// The status bar shows this rather than a copy kept in the front end, so the
/// number on screen cannot drift from the number that shipped.
#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// True only for binaries built by `package-msix.ps1`, which sets
/// `WINT_OFFICIAL_BUILD` for that compile. A `npm run dev` or plain release
/// build leaves it unset, so What's new never treats a local exe as a Store
/// package.
fn is_official_build() -> bool {
    option_env!("WINT_OFFICIAL_BUILD").is_some()
}

#[tauri::command]
fn app_is_official_build() -> bool {
    is_official_build()
}

/// SHA-256 of the running exe. Only meaningful for an official Store package:
/// the checksum cannot be baked into the frontend before the build (putting it
/// in `changelog.js` would change the binary), so What's new hashes this
/// process instead. `package-msix.ps1` records the same number in the source
/// after the package exists, for anyone reading the repo. Dev builds skip this.
fn hash_running_exe() -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let path = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
async fn app_build_checksum() -> Result<String, String> {
    if !is_official_build() {
        return Ok(String::new());
    }
    off_thread(hash_running_exe)
        .await
        .unwrap_or_else(|| Err("The checksum did not finish.".into()))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageView {
    /// The anonymous id the front end keeps for this install. Never anything
    /// that could name the machine or the person at it.
    pub visitor_id: String,
    /// The screen, as a route: `/overview`, `/project`, `/settings`.
    pub path: String,
}

/// Reports one page view to PageRain. The front end owns the anonymous id and
/// the screen name; this only carries them off the UI thread and onto the
/// network, because the window's own `fetch` is refused by CORS.
///
/// Nothing waits on the answer and a failure is never surfaced: a page view
/// that does not arrive must not cost the user anything.
#[tauri::command]
async fn analytics_page_view(view: PageView) {
    off_thread(move || {
        if let Err(why) = analytics::page_view(&view.visitor_id, &view.path) {
            eprintln!("analytics: {why}");
        }
    })
    .await;
}

#[tauri::command]
fn scan(app: AppHandle, roots: Vec<String>) -> u64 {
    let token = SCAN_TOKEN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || scan_stream(&app, roots, token));
    token
}

/// Retires the running scan. Its workers see a stale token on their next step
/// and stop, and nothing further is emitted for it.
#[tauri::command]
fn scan_cancel() {
    SCAN_TOKEN.fetch_add(1, Ordering::SeqCst);
}

fn emit_scan<T: Serialize + Clone>(app: &AppHandle, token: u64, event: &str, payload: T) {
    if scan_is_current(token) {
        let _ = app.emit(event, payload);
    }
}

fn flush_batch(app: &AppHandle, token: u64, batch: &mut Vec<Project>) {
    if batch.is_empty() {
        return;
    }
    let projects = std::mem::take(batch);
    emit_scan(app, token, "scan:project", ScanBatch { token, projects });
}

fn phase(app: &AppHandle, token: u64, key: &str, label: &str, done: bool) {
    emit_scan(
        app,
        token,
        "scan:phase",
        ScanPhase {
            token,
            key: key.into(),
            label: label.into(),
            done,
        },
    );
}

fn scan_stream(app: &AppHandle, roots: Vec<String>, token: u64) {
    let started = Instant::now();
    let now_ms = epoch_ms();
    let (present, missing): (Vec<String>, Vec<String>) = roots
        .iter()
        .cloned()
        .partition(|root| Path::new(root).is_dir());

    // A folder that is not there is worth saying out loud, but it only stops
    // the scan when it leaves nothing to look at.
    let error = if !missing.is_empty() {
        format!("{} does not exist.", missing.join(", "))
    } else if roots.is_empty() {
        "Add a folder to scan.".to_string()
    } else {
        String::new()
    };

    if present.is_empty() {
        emit_scan(
            app,
            token,
            "scan:start",
            ScanStart {
                token,
                roots,
                scanned_at_ms: now_ms,
                stubs: Vec::new(),
                error: error.clone(),
            },
        );
        emit_scan(
            app,
            token,
            "scan:done",
            ScanDone {
                token,
                duration_ms: 0,
                error,
                cancelled: false,
            },
        );
        return;
    }

    phase(
        app,
        token,
        "discover",
        &format!("Listing folders in {}", present.join(", ")),
        false,
    );
    let dirs = discover_roots(&present);
    if !scan_is_current(token) {
        return;
    }
    phase(
        app,
        token,
        "discover",
        &format!("Found {} folders", dirs.len()),
        true,
    );
    let stubs: Vec<Stub> = dirs
        .iter()
        .map(|(path, group)| Stub {
            name: dir_name(path),
            path: path.to_string_lossy().into_owned(),
            group: group.clone(),
        })
        .collect();
    emit_scan(
        app,
        token,
        "scan:start",
        ScanStart {
            token,
            roots,
            scanned_at_ms: now_ms,
            stubs,
            error,
        },
    );

    let (tx, rx) = channel::<Project>();
    std::thread::scope(|scope| {
        let dirs = &dirs;

        // Walking the process table is the slowest single step and nothing else
        // depends on it, so it runs beside the per-project work and patches the
        // cards whenever it lands.
        scope.spawn(move || {
            phase(app, token, "procs", "Scanning running processes", false);
            let snapshot = ProcessSnapshot::capture();
            if !scan_is_current(token) {
                return;
            }
            let items: Vec<ProcPatch> = dirs
                .iter()
                .filter_map(|(path, _)| {
                    let path = path.to_string_lossy().into_owned();
                    let running = snapshot.matching(&path);
                    if running.is_empty() {
                        return None;
                    }
                    let mut ports: Vec<u16> =
                        running.iter().flat_map(|p| p.ports.clone()).collect();
                    ports.sort_unstable();
                    ports.dedup();
                    Some(ProcPatch {
                        path,
                        running,
                        ports,
                    })
                })
                .collect();
            let matched = items.len();
            emit_scan(app, token, "scan:procs", ScanProcs { token, items });
            phase(
                app,
                token,
                "procs",
                &format!("{matched} projects have something running"),
                true,
            );
        });

        phase(
            app,
            token,
            "inspect",
            "Reading git status and project metadata",
            false,
        );

        // Fan out across a fixed pool: each worker claims whole stripes of the
        // list so no shared queue or extra dependency is needed.
        for worker in 0..WORKERS.min(dirs.len().max(1)) {
            let tx = tx.clone();
            scope.spawn(move || {
                for (path, group) in dirs.iter().skip(worker).step_by(WORKERS) {
                    if !scan_is_current(token) {
                        return;
                    }
                    if tx.send(inspect_project(path, group)).is_err() {
                        return;
                    }
                }
            });
        }
        drop(tx);

        let mut batch: Vec<Project> = Vec::with_capacity(BATCH);
        loop {
            match rx.recv_timeout(Duration::from_millis(BATCH_MS)) {
                Ok(project) => {
                    batch.push(project);
                    if batch.len() >= BATCH {
                        flush_batch(app, token, &mut batch);
                    }
                }
                Err(RecvTimeoutError::Timeout) => flush_batch(app, token, &mut batch),
                Err(RecvTimeoutError::Disconnected) => {
                    flush_batch(app, token, &mut batch);
                    phase(app, token, "inspect", "Read every project", true);
                    break;
                }
            }
        }
    });

    emit_scan(
        app,
        token,
        "scan:done",
        ScanDone {
            token,
            duration_ms: started.elapsed().as_millis() as u64,
            error: String::new(),
            cancelled: false,
        },
    );
}

/// The scan as one blocking call, for `examples/scan_cli.rs`.
pub fn scan_root(root: String) -> ScanResult {
    let started = Instant::now();
    let now_ms = epoch_ms();
    let root_path = PathBuf::from(&root);

    if !root_path.is_dir() {
        return ScanResult {
            root,
            scanned_at_ms: now_ms,
            duration_ms: 0,
            projects: Vec::new(),
            error: "That folder does not exist.".into(),
        };
    }

    let dirs = discover(&root_path);
    let snapshot = ProcessSnapshot::capture();
    let mut projects: Vec<Project> = Vec::with_capacity(dirs.len());
    std::thread::scope(|scope| {
        let dirs = &dirs;
        let handles: Vec<_> = (0..WORKERS.min(dirs.len().max(1)))
            .map(|worker| {
                scope.spawn(move || {
                    dirs.iter()
                        .skip(worker)
                        .step_by(WORKERS)
                        .map(|(path, group)| inspect_project(path, group))
                        .collect::<Vec<Project>>()
                })
            })
            .collect();
        for handle in handles {
            if let Ok(part) = handle.join() {
                projects.extend(part);
            }
        }
    });

    for project in &mut projects {
        project.running = snapshot.matching(&project.path);
        let mut ports: Vec<u16> = project
            .running
            .iter()
            .flat_map(|p| p.ports.clone())
            .collect();
        ports.sort_unstable();
        ports.dedup();
        project.ports = ports;
    }
    projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    ScanResult {
        root,
        scanned_at_ms: now_ms,
        duration_ms: started.elapsed().as_millis() as u64,
        projects,
        error: String::new(),
    }
}

fn dir_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Everything about one project that can be learned without the process table.
fn inspect_project(path: &Path, group: &str) -> Project {
    let report = tech::inspect(path);
    let path_str = path.to_string_lossy().to_string();
    let run_cmd = detect_run(path, &report);

    Project {
        name: dir_name(path),
        path: path_str,
        group: group.to_string(),
        description: report.description,
        version: report.version,
        package_manager: report.package_manager,
        scripts: report.scripts,
        dep_count: report.dep_count,
        dev_dep_count: report.dev_dep_count,
        flags: report.flags,
        tech: report.tech,
        git: git::read(path),
        running: Vec::new(),
        ports: Vec::new(),
        run_cmd,
        touched_ms: newest_child_mtime(path),
    }
}

/// Node scripts that mean "start this thing", best first.
const RUN_SCRIPTS: &[&str] = &["dev", "start", "develop", "serve", "watch"];

/// How this project is started, as a line to type at a shell.
///
/// The answer has to come from what is actually on disk - a `dev` script that
/// is really declared, a `Cargo.toml` that is really there - because the Run
/// button offers to type it for real. When nothing in the folder says how the
/// project runs, the answer is empty and the button says so rather than
/// guessing at something that would only fail in the user's face.
fn detect_run(path: &Path, report: &tech::TechReport) -> String {
    // Expo before the scripts. Its `start` script is usually `expo start`, but
    // going through the package manager loses the CLI's own argument handling,
    // and `npx` is how the Expo docs say to start one.
    if report.tech.iter().any(|t| t.name == "Expo") {
        return "npx expo start".into();
    }
    let mut script = "";
    for want in RUN_SCRIPTS {
        if report.scripts.iter().any(|s| s[0] == *want) {
            script = want;
            break;
        }
    }
    if !script.is_empty() {
        let pm = match report.package_manager.as_str() {
            "pnpm" => "pnpm",
            "yarn" => "yarn",
            "bun" => "bun",
            // No lockfile at all still means npm, which is what a bare
            // package.json is run with by default.
            _ => "npm",
        };
        // Classic yarn has no `run` in front of a user script.
        return if pm == "yarn" {
            format!("yarn {script}")
        } else {
            format!("{pm} run {script}")
        };
    }
    if path.join("Cargo.toml").exists() {
        return "cargo run".into();
    }
    if path.join("src-tauri/Cargo.toml").exists() {
        return "cargo tauri dev".into();
    }
    if path.join("go.mod").exists() {
        return "go run .".into();
    }
    if path.join("manage.py").exists() {
        return "python manage.py runserver".into();
    }
    for entry in ["main.py", "app.py"] {
        if path.join(entry).exists() {
            return format!("python {entry}");
        }
    }
    for compose in ["docker-compose.yml", "docker-compose.yaml", "compose.yml"] {
        if path.join(compose).exists() {
            return "docker compose up".into();
        }
    }
    // Only a target that is really declared - `make dev` on a Makefile without
    // one is just an error with extra steps.
    if let Ok(text) = std::fs::read_to_string(path.join("Makefile")) {
        for target in ["dev", "run", "start"] {
            if text
                .lines()
                .any(|line| line.starts_with(&format!("{target}:")))
            {
                return format!("make {target}");
            }
        }
    }
    String::new()
}

/// Every scan root's projects, in the order the roots were given and without
/// repeating a folder that two roots both reach.
fn discover_roots(roots: &[String]) -> Vec<(PathBuf, String)> {
    let mut found = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    for root in roots {
        for (path, group) in discover(Path::new(root)) {
            if seen.insert(path.clone()) {
                found.push((path, group));
            }
        }
    }
    found
}

/// Projects directly under `root`, plus one extra level for folders that are
/// only containers (a group directory holding several repos).
fn discover(root: &Path) -> Vec<(PathBuf, String)> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_candidate_dir(&path) {
            continue;
        }
        if is_project(&path) {
            found.push((path, String::new()));
            continue;
        }
        let group = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let Ok(children) = std::fs::read_dir(&path) else {
            continue;
        };
        for child in children.flatten() {
            let child = child.path();
            if is_candidate_dir(&child) && is_project(&child) {
                found.push((child, group.clone()));
            }
        }
    }
    found
}

fn is_candidate_dir(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    !name.starts_with('.') && !NOISE.iter().any(|n| n.eq_ignore_ascii_case(name))
}

fn is_project(path: &Path) -> bool {
    path.join(".git").exists() || MARKERS.iter().any(|m| path.join(m).exists())
}

/// Newest mtime among a project's top-level entries. Recursing would mean
/// walking `node_modules` and `target`, which costs far more than the extra
/// precision is worth.
fn newest_child_mtime(path: &Path) -> u64 {
    let mut newest = util::mtime_ms(path);
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let child = entry.path();
            let Some(name) = child.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if NOISE.iter().any(|n| n.eq_ignore_ascii_case(name)) {
                continue;
            }
            newest = newest.max(util::mtime_ms(&child));
        }
    }
    newest
}

/// A sensible starting folder: the common Windows code roots if one exists,
/// otherwise the user profile.
#[tauri::command]
async fn default_root() -> String {
    off_thread(default_root_sync)
        .await
        .unwrap_or_else(|| "C:\\".to_string())
}

pub fn default_root_sync() -> String {
    for candidate in ["C:\\code", "C:\\dev", "C:\\src", "C:\\projects"] {
        if Path::new(candidate).is_dir() {
            return candidate.to_string();
        }
    }
    std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".to_string())
}

/// The native folder picker, opened from the folder editor and from the first
/// run. Returns the chosen folder, or `None` when the dialog was dismissed.
/// The dialog runs off the UI thread, so the window keeps drawing while it is
/// on screen.
#[cfg(windows)]
#[tauri::command]
async fn pick_folder(app: AppHandle, start: Option<String>) -> Result<Option<String>, String> {
    // The handle travels as an integer because `HWND` is not `Send`; the picker
    // thread only ever uses it to own the dialog.
    let owner = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|hwnd| hwnd.0 as isize)
        .unwrap_or(0);
    off_thread(move || picker::pick_folder(owner, start))
        .await
        .unwrap_or_else(|| Err("Could not open the folder picker.".into()))
}

/// Off Windows there is no picker to show, so the typed path is all there is.
#[cfg(not(windows))]
#[tauri::command]
async fn pick_folder(_start: Option<String>) -> Result<Option<String>, String> {
    Err("Choosing a folder is only available on Windows - type the path instead.".into())
}

/// Native Save As for utility-tool output. Returns the path written, or `None`
/// when the dialog was dismissed. Dialog + write run off the UI thread.
#[cfg(windows)]
#[tauri::command]
async fn save_text_file(
    app: AppHandle,
    text: String,
    default_name: String,
) -> Result<Option<String>, String> {
    let owner = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|hwnd| hwnd.0 as isize)
        .unwrap_or(0);
    off_thread(move || picker::save_text_file(owner, default_name, text))
        .await
        .unwrap_or_else(|| Err("Could not open the save dialog.".into()))
}

#[cfg(not(windows))]
#[tauri::command]
async fn save_text_file(_text: String, _default_name: String) -> Result<Option<String>, String> {
    Err("Saving a file is only available on Windows.".into())
}

/// Opens a project in Explorer, VS Code or a terminal. `target` is validated
/// against a fixed set so the front end can never name an arbitrary program.
#[tauri::command]
async fn open_in(path: String, target: String) -> Result<(), String> {
    off_thread(move || open_in_sync(path, target))
        .await
        .unwrap_or_else(|| Err("Could not start that program.".into()))
}

pub fn open_in_sync(path: String, target: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("That item no longer exists.".into());
    }
    let ok = match target.as_str() {
        "explorer" => util::run_lossy("explorer", &[&path], None).is_some(),
        "reveal" => util::run_lossy("explorer", &["/select,", &path], None).is_some(),
        "vscode" => util::run_lossy("cmd", &["/c", "code", &path], None).is_some(),
        "terminal" => util::run_lossy(
            "cmd",
            &["/c", "start", "cmd", "/K", &format!("cd /d \"{path}\"")],
            None,
        )
        .is_some(),
        other => return Err(format!("Unknown target: {other}")),
    };
    if ok {
        Ok(())
    } else {
        Err(format!("Could not open with {target}."))
    }
}

#[tauri::command]
async fn disk_space_drives() -> Result<Vec<disk_space::Drive>, String> {
    off_thread(disk_space::drives)
        .await
        .unwrap_or_else(|| Err("Could not read the available drives.".into()))
}

#[tauri::command]
async fn disk_space_scan(path: String) -> Result<disk_space::SpaceScan, String> {
    off_thread(move || disk_space::scan(path))
        .await
        .unwrap_or_else(|| Err("The disk scan did not finish.".into()))
}

static DISK_SCAN_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DiskSpaceItemEvent {
    scan_id: u64,
    token: String,
    item: disk_space::SpaceItem,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DiskSpaceDoneEvent {
    scan_id: u64,
    token: String,
    result: Option<disk_space::SpaceScan>,
    error: Option<String>,
}

#[tauri::command]
fn disk_space_scan_start(app: AppHandle, path: String, token: String) -> u64 {
    let scan_id = DISK_SCAN_ID.fetch_add(1, Ordering::Relaxed);
    std::thread::spawn(move || {
        let item_app = app.clone();
        let item_token = token.clone();
        let result = disk_space::scan_stream(
            path,
            |item| {
                let _ = item_app.emit(
                    "disk-space:item",
                    DiskSpaceItemEvent {
                        scan_id,
                        token: item_token.clone(),
                        item,
                    },
                );
            },
            move || DISK_SCAN_ID.load(Ordering::Relaxed) == scan_id + 1,
        );
        let payload = match result {
            Ok(result) => DiskSpaceDoneEvent {
                scan_id,
                token: token.clone(),
                result: Some(result),
                error: None,
            },
            Err(error) => DiskSpaceDoneEvent {
                scan_id,
                token: token.clone(),
                result: None,
                error: Some(error),
            },
        };
        let _ = app.emit("disk-space:done", payload);
    });
    scan_id
}

#[tauri::command]
fn disk_space_scan_cancel() {
    DISK_SCAN_ID.fetch_add(1, Ordering::Relaxed);
}

/// A patch big enough to be worth reading and small enough to hand a webview
/// in one piece. Past this the front end says so rather than pretending the
/// part it got is all there was.
const MAX_DIFF_BYTES: usize = 400 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    /// The unified patch, staged and unstaged together.
    pub text: String,
    pub truncated: bool,
    pub files: u32,
}

/// The working tree's actual patch - what changed, not just how much.
#[tauri::command]
async fn git_diff(path: String) -> Result<Diff, String> {
    off_thread(move || git_diff_sync(path))
        .await
        .unwrap_or_else(|| Err("Could not read the diff.".into()))
}

pub fn git_diff_sync(path: String) -> Result<Diff, String> {
    let dir = PathBuf::from(&path);
    if !dir.join(".git").exists() {
        return Err("Not a git repository.".into());
    }
    // Two calls rather than one against `HEAD`, so a repository with nothing
    // committed yet still shows its staged work instead of failing on a
    // revision that does not exist.
    let unstaged = util::run_lossy("git", &["diff", "--no-color"], Some(&dir)).unwrap_or_default();
    let staged =
        util::run_lossy("git", &["diff", "--cached", "--no-color"], Some(&dir)).unwrap_or_default();

    let mut text = String::new();
    if !staged.trim().is_empty() {
        text.push_str(staged.trim_end());
        text.push('\n');
    }
    text.push_str(&unstaged);
    let files = text
        .lines()
        .filter(|l| l.starts_with("diff --git "))
        .count() as u32;

    let truncated = text.len() > MAX_DIFF_BYTES;
    if truncated {
        // Cut on a character boundary, or the webview is handed invalid UTF-8.
        let mut end = MAX_DIFF_BYTES;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    Ok(Diff {
        text,
        truncated,
        files,
    })
}

/// What `git pull` did: whether it worked, the line worth showing for it, and
/// the project re-read afterwards so the card stops claiming it is behind.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub ok: bool,
    pub summary: String,
    pub project: Option<Project>,
}

/// `git pull` in one project's folder.
#[tauri::command]
async fn git_pull(path: String, group: String) -> Result<PullResult, String> {
    off_thread(move || git_pull_sync(path, group))
        .await
        .unwrap_or_else(|| Err("Could not run git pull.".into()))
}

pub fn git_pull_sync(path: String, group: String) -> Result<PullResult, String> {
    let dir = PathBuf::from(&path);
    if !dir.join(".git").exists() {
        return Err("Not a git repository.".into());
    }

    let mut cmd = std::process::Command::new("git");
    cmd.arg("pull").current_dir(&dir);
    // Nothing here may sit waiting for a human: no editor for a merge message,
    // no credential or host-key prompt. A pull that would need one fails and
    // says so instead of hanging a window that must never block.
    cmd.env("GIT_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd
        .output()
        .map_err(|_| "Could not start git.".to_string())?;
    let ok = out.status.success();
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let summary = pull_summary(&stdout, &stderr, ok);

    // Only a pull that worked can have changed anything worth re-reading.
    let project = ok.then(|| inspect_project(&dir, &group));
    Ok(PullResult {
        ok,
        summary,
        project,
    })
}

/// The one line of git's output worth putting in the status bar.
fn pull_summary(stdout: &str, stderr: &str, ok: bool) -> String {
    if ok && stdout.contains("Already up to date") {
        return "Already up to date".to_string();
    }
    let pick = |text: &str| {
        text.lines()
            .map(str::trim)
            .find(|line| {
                !line.is_empty()
                    && !line.starts_with("From ")
                    && !line.starts_with("remote:")
                    && !line.starts_with("Receiving")
                    && !line.starts_with("Resolving")
                    && !line.starts_with("Unpacking")
                    && !line.starts_with("Counting")
                    && !line.starts_with("Compressing")
                    && !line.starts_with("hint:")
                    && !line.starts_with("warning:")
            })
            .map(str::to_string)
    };
    let line = if ok {
        pick(stdout).or_else(|| pick(stderr))
    } else {
        pick(stderr).or_else(|| pick(stdout))
    };
    line.unwrap_or_else(|| {
        if ok {
            "Pulled".into()
        } else {
            "git pull failed".into()
        }
    })
}

/// Every `TODO` / `FIXME` left in a project's own source.
#[tauri::command]
async fn todos(path: String) -> Result<todo::TodoReport, String> {
    off_thread(move || {
        let dir = PathBuf::from(&path);
        if !dir.is_dir() {
            return Err("Folder no longer exists.".into());
        }
        Ok(todo::scan(&dir))
    })
    .await
    .unwrap_or_else(|| Err("Could not read the project.".into()))
}

/// The source around one TODO, so a note can be read in the code it was left in.
#[tauri::command]
async fn todo_excerpt(path: String, file: String, line: u32) -> Result<todo::Excerpt, String> {
    off_thread(move || {
        let dir = PathBuf::from(&path);
        if !dir.is_dir() {
            return Err("Folder no longer exists.".into());
        }
        todo::excerpt(&dir, &file, line)
    })
    .await
    .unwrap_or_else(|| Err("Could not read the file.".into()))
}

#[tauri::command]
async fn port_list() -> Vec<procs::ProcessEntry> {
    off_thread(procs::port_list).await.unwrap_or_default()
}

#[tauri::command]
async fn port_kill(
    pid: u32,
    expected_executable: String,
    expected_process: String,
    tree: bool,
) -> Result<(), String> {
    off_thread(move || {
        if tree {
            procs::kill_tree(pid, &expected_executable, &expected_process)
        } else {
            procs::kill(pid, &expected_executable, &expected_process)
        }
    })
    .await
    .unwrap_or_else(|| Err("Could not terminate the process.".into()))
}

/// The live readings behind the explorer's sparklines. Called every couple of
/// seconds with only the PIDs on screen, so it stays a handful of native calls.
#[tauri::command]
async fn port_sample(pids: Vec<u32>) -> Vec<procs::ProcSample> {
    off_thread(move || procs::sample(pids))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn term_close_snapshot(id: String) -> Result<Vec<procs::ProcessIdentity>, String> {
    off_thread(move || {
        let descendants = procs::descendants(term::term_pid(&id)?);
        term::term_close_now(id)?;
        Ok(descendants)
    })
    .await
    .unwrap_or_else(|| Err("Could not close the terminal.".into()))
}

#[cfg(windows)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellHistoryEntry {
    command: String,
    shell: String,
}

/// Imports the histories the installed shells already own. This is read on a
/// worker only when Ctrl+R is first opened; history files can be large and must
/// never pause the window thread.
#[cfg(windows)]
#[tauri::command]
async fn term_command_history() -> Vec<ShellHistoryEntry> {
    off_thread(|| {
        let profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
        let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
        let mut sources = Vec::new();
        if let Some(root) = appdata {
            sources.push((
                root.join("Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt"),
                "pwsh",
            ));
            sources.push((root.join("nushell/history.txt"), "nu"));
        }
        if let Some(root) = profile {
            sources.push((root.join(".bash_history"), "bash"));
        }
        let mut entries = Vec::new();
        for (path, shell) in sources {
            let Ok(text) = std::fs::read_to_string(path) else {
                continue;
            };
            entries.extend(text.lines().rev().take(10_000).filter_map(|line| {
                let command = line.trim();
                (!command.is_empty()).then(|| ShellHistoryEntry {
                    command: command.to_string(),
                    shell: shell.to_string(),
                })
            }));
        }
        entries
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn process_survivors(expected: Vec<procs::ProcessIdentity>) -> Vec<procs::ProcessIdentity> {
    off_thread(move || procs::survivors(expected))
        .await
        .unwrap_or_default()
}

/* ------------------------------------------------------------------- dns

Every one of these talks to the network, the process table or a file in
System32, so every one of them is `async` and does its work on a pool
thread. A DNS query that times out must cost the window nothing. */

/// Every record type for one name, from one resolver. `server` is an IP, or
/// empty for whatever Windows is configured to use.
#[tauri::command]
async fn dns_lookup(name: String, server: String, types: Vec<String>) -> dns::Lookup {
    off_thread(move || dns::lookup(&name, &server, &types))
        .await
        .unwrap_or_else(|| dns::lookup("", "", &[]))
}

/// The same question put to this machine's resolver and to the public ones, so
/// disagreement is visible rather than guessed at.
#[tauri::command]
async fn dns_compare(name: String, rtype: String) -> Vec<dns::ResolverAnswer> {
    off_thread(move || dns::compare(&name, &rtype))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn dns_reverse(address: String) -> dns::Lookup {
    off_thread(move || dns::reverse(&address))
        .await
        .unwrap_or_else(|| dns::reverse(""))
}

#[tauri::command]
async fn dns_flush() -> String {
    off_thread(dns::flush_cache)
        .await
        .unwrap_or_else(|| "Could not flush the cache".into())
}

#[tauri::command]
async fn dns_hosts_read() -> dns::HostsFile {
    off_thread(dns::hosts_read)
        .await
        .unwrap_or_else(dns::hosts_read)
}

/// Writes the hosts file back, taking a copy first and asking Windows for
/// administrator rights only if the plain write is refused.
#[tauri::command]
async fn dns_hosts_write(request: dns::HostsWrite) -> dns::HostsWriteResult {
    off_thread(move || dns::hosts_write(request))
        .await
        .unwrap_or_else(|| dns::HostsWriteResult {
            ok: false,
            elevated: false,
            backup: String::new(),
            error: "The write did not finish.".into(),
            file: dns::hosts_read(),
        })
}

/// The text of one of the copies this tool took, so a restore can be staged
/// and looked at before it is applied like any other edit.
#[tauri::command]
async fn dns_hosts_backup(id: String) -> Result<String, String> {
    off_thread(move || dns::backup_text(&id))
        .await
        .unwrap_or_else(|| Err("Could not read the backup.".into()))
}

/// The names the scanned projects talk to, so the tool opens on something
/// worth looking up rather than an empty field.
#[tauri::command]
async fn dns_project_domains(paths: Vec<String>, names: Vec<String>) -> Vec<dns::ProjectDomain> {
    off_thread(move || dns::project_domains(paths, names))
        .await
        .unwrap_or_default()
}

/* --------------------------------------------------------- Windows tools */

#[tauri::command]
async fn event_log_query(
    query: windows_tools::EventQuery,
) -> Result<Vec<windows_tools::EventRecord>, String> {
    off_thread(move || windows_tools::event_query(query))
        .await
        .unwrap_or_else(|| Err("The Event Log query did not finish.".into()))
}

#[tauri::command]
async fn registry_list(path: String) -> Result<Vec<windows_tools::RegistryItem>, String> {
    off_thread(move || windows_tools::registry_list(&path))
        .await
        .unwrap_or_else(|| Err("The registry query did not finish.".into()))
}

#[tauri::command]
async fn registry_change(change: windows_tools::RegistryChange) -> windows_tools::ToolResult {
    off_thread(move || windows_tools::registry_change(change))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn system_report() -> Result<windows_tools::SystemReport, String> {
    off_thread(windows_tools::system_report)
        .await
        .unwrap_or_else(|| Err("The system scan did not finish.".into()))
}

#[tauri::command]
async fn repair_run(id: String) -> windows_tools::ToolResult {
    off_thread(move || windows_tools::repair_run(&id))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn log_tail(path: String, lines: u32) -> Result<windows_tools::LogTail, String> {
    off_thread(move || windows_tools::log_tail(&path, lines))
        .await
        .unwrap_or_else(|| Err("The log read did not finish.".into()))
}

#[tauri::command]
async fn lock_inspect(path: String) -> Result<Vec<windows_tools::LockProcess>, String> {
    off_thread(move || windows_tools::lock_inspect(&path))
        .await
        .unwrap_or_else(|| Err("The lock inspection did not finish.".into()))
}

#[tauri::command]
async fn audio_devices() -> Result<Vec<windows_tools::AudioDevice>, String> {
    off_thread(windows_tools::audio_devices)
        .await
        .unwrap_or_else(|| Err("The audio device scan did not finish.".into()))
}

#[tauri::command]
async fn audio_set_default(id: String) -> windows_tools::ToolResult {
    off_thread(move || windows_tools::audio_set_default(&id))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn audio_set_volume(id: String, volume: u32) -> windows_tools::ToolResult {
    off_thread(move || windows_tools::audio_set_volume(&id, volume))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn audio_set_muted(id: String, muted: bool) -> windows_tools::ToolResult {
    off_thread(move || windows_tools::audio_set_muted(&id, muted))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn audio_test(id: String, flow: String) -> windows_tools::ToolResult {
    off_thread(move || windows_tools::audio_test(&id, &flow))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn repair_targets(id: String) -> Result<Vec<windows_tools::RepairTarget>, String> {
    off_thread(move || windows_tools::repair_targets(&id))
        .await
        .unwrap_or_else(|| Err("The device scan did not finish.".into()))
}

#[tauri::command]
async fn repair_target_run(id: String, target: String) -> windows_tools::ToolResult {
    off_thread(move || windows_tools::repair_target_run(&id, &target))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn active_window_snapshot() -> Result<windows_tools::ActiveWindow, String> {
    off_thread(windows_tools::active_window)
        .await
        .unwrap_or_else(|| Err("The active-window check did not finish.".into()))
}

#[tauri::command]
fn keep_awake_set(
    system: bool,
    display: bool,
    away_mode: bool,
) -> Result<windows_tools::KeepAwakeResult, String> {
    windows_tools::keep_awake_set(system, display, away_mode)
}

/* ------------------------------------------------------------- the network

Every one of these drives `pktmon`, which means spawning a process and, for
the capture itself, reading a pipe for as long as it runs. That reading has
a thread of its own inside `network`; the commands here only ever start,
stop or ask, and none of them holds the window. */

/// Whether pktmon is here, and whether it will talk to us. Asked when the tool
/// is opened, so the page can explain itself before offering a button that was
/// never going to work.
#[tauri::command]
async fn net_capability() -> network::Capability {
    off_thread(network::capability).await.unwrap_or_default()
}

#[tauri::command]
async fn net_components() -> Result<Vec<network::Component>, String> {
    off_thread(network::components)
        .await
        .unwrap_or_else(|| Err("The component list did not finish.".into()))
}

/// Starts a capture. Returns once pktmon is up; the frames themselves arrive
/// as `net:frames` events.
#[tauri::command]
async fn net_start(
    app: AppHandle,
    options: network::StartOptions,
) -> Result<network::Started, String> {
    off_thread(move || network::start(app, options))
        .await
        .unwrap_or_else(|| Err("The capture did not start.".into()))
}

#[tauri::command]
async fn net_stop() -> Result<String, String> {
    off_thread(network::stop)
        .await
        .unwrap_or_else(|| Err("The capture did not stop cleanly.".into()))
}

#[tauri::command]
async fn net_clear() {
    off_thread(network::clear).await;
}

/// The frames already in the ring, for a tool opened onto a capture that was
/// running before anybody looked at it.
#[tauri::command]
async fn net_backlog(limit: usize) -> Vec<network::Frame> {
    off_thread(move || network::backlog(limit))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn net_rate() -> network::Rate {
    off_thread(network::rate).await.unwrap_or_default()
}

/// Writes the ring out as pcapng. An empty `path` puts it under the captures
/// folder under a stamped name.
#[tauri::command]
async fn net_export(path: String) -> Result<network::Exported, String> {
    off_thread(move || network::export(Some(path)))
        .await
        .unwrap_or_else(|| Err("The export did not finish.".into()))
}

#[tauri::command]
fn path_ping_start(app: AppHandle, options: path_ping::Options) -> Result<u64, String> {
    path_ping::start(app, options)
}

#[tauri::command]
fn path_ping_cancel() {
    path_ping::cancel();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(PendingTool::default())
        .manage(SearchGlobalShortcut::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            deliver_tool_arg(app, &args);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let search_id = app
                        .state::<SearchGlobalShortcut>()
                        .0
                        .lock()
                        .ok()
                        .and_then(|value| *value);
                    if search_id == Some(shortcut.id) {
                        tool_window::focus_search_from_global(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

            let args: Vec<String> = std::env::args().collect();
            start_wt_request_queue(app.handle().clone());
            if let Some(id) = tool_arg(&args) {
                if let Ok(mut pending) = app.state::<PendingTool>().0.lock() {
                    *pending = Some(id);
                }
            }

            let open = MenuItem::with_id(app, "tray-open", "Open WinT", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::with_id("wint-tray")
                .tooltip("WinT")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    let id = event.id().as_ref();
                    if id == "tray-open" {
                        show_main_window(app);
                    } else if id == "tray-quit" {
                        // Follow the normal close path so terminal and network
                        // sessions are cleaned up before the process exits.
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.destroy();
                        }
                        app.exit(0);
                    } else if let Some(tool_id) = id.strip_prefix("tray-tool:") {
                        show_main_window(app);
                        let _ = app.emit("tray:open-tool", tool_id);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            let tray = tray.build(app)?;
            tray.set_visible(false)?;
            Ok(())
        });

    #[cfg(windows)]
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            scan,
            minimize_to_tray,
            tray_set_recent_tools,
            take_startup_tool,
            wt_report,
            cli_status,
            cli_install,
            cli_uninstall,
            assistant_status,
            assistant_cloud_status,
            assistant_cloud_configure,
            assistant_cloud_remove,
            assistant_pull,
            assistant_pull_cancel,
            assistant_model_delete,
            assistant_chat,
            assistant_chat_cancel,
            app_version,
            app_is_official_build,
            app_build_checksum,
            disk_space_drives,
            disk_space_scan,
            disk_space_scan_start,
            disk_space_scan_cancel,
            analytics_page_view,
            scan_cancel,
            default_root,
            pick_folder,
            save_text_file,
            open_in,
            git_diff,
            git_pull,
            git::git_workspace,
            git::git_action,
            todos,
            todo_excerpt,
            port_list,
            port_kill,
            port_sample,
            term_close_snapshot,
            term_command_history,
            term::term_prune_history,
            process_survivors,
            term::term_shell_availability,
            shell_downloads,
            shell_download_start,
            shell_download_cancel,
            shell_download_remove,
            term::term_open,
            term::term_attach,
            term::term_serving,
            workspace::workspace_open,
            workspace::workspace_browser_show,
            workspace::workspace_browser_hide,
            workspace::workspace_browser_navigate,
            workspace::workspace_browser_reload,
            workspace::workspace_browser_close,
            workspace::workspace_list_dir,
            workspace::workspace_read_file,
            term::term_write,
            term::term_resize,
            term::term_close,
            term::term_list,
            term::term_popout,
            term::term_drag_preview,
            term::term_dock,
            tool_window::tool_popout,
            tool_window::tool_focus,
            tool_window::tool_drag_preview,
            tool_window::tool_dock,
            tool_window::tool_embedded_show,
            tool_window::tool_embedded_hide,
            tool_window::tool_embedded_destroy,
            tool_window::tool_bridge_state_put,
            tool_window::tool_bridge_state_take,
            tool_window::search_show,
            tool_window::search_hide,
            tool_window::search_prepare,
            tool_window::changelog_show,
            tool_window::changelog_hide,
            search_global_binding_set,
            dns_lookup,
            dns_compare,
            dns_reverse,
            dns_flush,
            dns_hosts_read,
            dns_hosts_write,
            dns_hosts_backup,
            dns_project_domains,
            net_capability,
            net_components,
            net_start,
            net_stop,
            net_clear,
            net_backlog,
            net_rate,
            net_export,
            path_ping_start,
            path_ping_cancel,
            event_log_query,
            registry_list,
            registry_change,
            system_report,
            repair_run,
            log_tail,
            lock_inspect,
            audio_devices,
            audio_set_default,
            audio_set_volume,
            audio_set_muted,
            audio_test,
            repair_targets,
            repair_target_run,
            active_window_snapshot,
            keep_awake_set,
            github::github_status,
            github::github_api
        ])
        .on_window_event(|window, event| {
            // The main window going away means the app is going away, so every
            // shell goes with it — a popped-out terminal must never outlive it.
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == "main" {
                // Destroy bypasses each pop-out's close-to-dock handler; there
                // is no main window left to receive that handoff.
                for (label, child) in window.app_handle().webview_windows() {
                    if label.starts_with("term-") {
                        let _ = child.destroy();
                    }
                }
                tool_window::destroy_all(&window.app_handle());
                term::shutdown();
                // A pktmon session outliving the window would go on
                // filtering this machine's traffic with nothing left to
                // show for it.
                network::shutdown();
            }
        });

    #[cfg(not(windows))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        scan,
        minimize_to_tray,
        tray_set_recent_tools,
        take_startup_tool,
        wt_report,
        cli_status,
        cli_install,
        cli_uninstall,
        assistant_status,
        assistant_cloud_status,
        assistant_cloud_configure,
        assistant_cloud_remove,
        assistant_pull,
        assistant_pull_cancel,
        assistant_model_delete,
        assistant_chat,
        assistant_chat_cancel,
        app_version,
        app_is_official_build,
        app_build_checksum,
        disk_space_drives,
        disk_space_scan,
        disk_space_scan_start,
        disk_space_scan_cancel,
        analytics_page_view,
        scan_cancel,
        default_root,
        pick_folder,
        save_text_file,
        open_in,
        git_diff,
        git_pull,
        git::git_workspace,
        git::git_action,
        todos,
        todo_excerpt,
        dns_lookup,
        dns_compare,
        dns_reverse,
        dns_flush,
        dns_hosts_read,
        dns_hosts_write,
        dns_hosts_backup,
        dns_project_domains,
        net_capability,
        net_components,
        net_start,
        net_stop,
        net_clear,
        net_backlog,
        net_rate,
        net_export,
        path_ping_start,
        path_ping_cancel,
        event_log_query,
        registry_list,
        registry_change,
        system_report,
        repair_run,
        log_tail,
        lock_inspect,
        github::github_status,
        github::github_api,
        audio_devices,
        audio_set_default,
        audio_set_volume,
        audio_set_muted,
        audio_test,
        repair_targets,
        repair_target_run,
        tool_window::tool_popout,
        tool_window::tool_focus,
        tool_window::tool_drag_preview,
        tool_window::tool_dock,
        tool_window::tool_embedded_show,
        tool_window::tool_embedded_hide
        ,tool_window::tool_embedded_destroy
        ,tool_window::tool_bridge_state_put
        ,tool_window::tool_bridge_state_take
        ,tool_window::search_show
        ,tool_window::search_hide
        ,tool_window::search_prepare
        ,tool_window::changelog_show
        ,tool_window::changelog_hide
        ,search_global_binding_set
        ,term::term_serving
        ,workspace::workspace_open
        ,workspace::workspace_browser_show
        ,workspace::workspace_browser_hide
        ,workspace::workspace_browser_navigate
        ,workspace::workspace_browser_reload
        ,workspace::workspace_browser_close
        ,workspace::workspace_list_dir
        ,workspace::workspace_read_file
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running WinT");
}
