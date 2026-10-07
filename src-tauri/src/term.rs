//! Terminal sessions, and the commands the front end drives them with.
//!
//! The session itself - pseudoconsole, child process and screen - lives in the
//! `wint-term` crate (`term-core/`), which `wint-term-host.exe` shares with the
//! VS Code panel. What is here is the part that is WinT's own: turning a
//! session's events into Tauri events, the `wt` compatibility proxy every
//! hosted shell gets, and the windows a terminal can be popped out into.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::off_thread;
pub use wint_term::session::{OpenArgs, TermInfo};
use wint_term::session::{self, Event, Launch, Snapshot};
pub use wint_term::shell::{claude_program, find_program_on_path, find_programs_on_path};
use wint_term::shell::{self as shell_paths, ShellAvailability};

/// Whether the installed proxy is already the one that would be copied over
/// it. `CopyFileW` carries the source's write time across, so the pair a copy
/// produced still matches years later.
fn same_file(source: &Path, installed: &Path) -> bool {
    let (Ok(from), Ok(to)) = (std::fs::metadata(source), std::fs::metadata(installed)) else {
        return false;
    };
    from.len() == to.len() && from.modified().ok() == to.modified().ok()
}

/// Replaces the proxy, including while a copy of it is running - which is the
/// normal case now that `wt` waits at the prompt for WinT's answer. A running
/// image cannot be written over, but Windows will happily rename one, so the
/// old file is moved aside and left for whoever is still in it.
fn install_wt_proxy(source: &Path, installed: &Path) -> Result<(), String> {
    if installed.is_file() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let aside = installed.with_file_name(format!("wt.old-{stamp}"));
        if std::fs::rename(installed, &aside).is_err() {
            // Not renameable either: overwrite it directly and let the error,
            // if there is one, be the one that is reported.
            std::fs::copy(source, installed).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    std::fs::copy(source, installed)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// The proxies moved aside by an update, once nothing is running them. Failing
/// to delete one means it is still in use, which is fine - the next terminal
/// opened tries again.
fn sweep_replaced_proxies(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with("wt.old-") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Installs a tiny `wt` compatibility command in an app-owned runtime folder.
/// Its directory is prepended only to shells hosted by WinT, so normal
/// Windows Terminal use elsewhere is unaffected.
fn wt_compat_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = crate::shells::runtime_root();
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Could not create the terminal runtime folder: {e}"))?;
    let mut candidates = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("wint-cli.exe"));
        candidates.push(resources.join("resources").join("wint-cli.exe"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(directory) = exe.parent() {
            candidates.push(directory.join("wint-cli.exe"));
            if let Some(target) = directory.parent() {
                candidates.push(target.join("debug").join("wint-cli.exe"));
                candidates.push(target.join("release").join("wint-cli.exe"));
            }
        }
    }
    let installed = root.join("wt.exe");
    let source = candidates.into_iter().find(|path| path.is_file());
    match source {
        // The copy is skipped when the proxy is already this build's. It used
        // to run on every terminal opened, which is both a needless copy of a
        // few megabytes and a fight with a `wt` that happens to be running.
        Some(source) if !same_file(&source, &installed) => {
            if let Err(error) = install_wt_proxy(&source, &installed) {
                // A proxy is already there and doing its job. Refusing to open
                // a shell because the spare copy could not be refreshed helps
                // nobody: the terminal is the point, the shim is a convenience.
                if !installed.is_file() {
                    return Err(format!(
                        "Could not install WinT's wt compatibility proxy: {error}"
                    ));
                }
            }
        }
        None if !installed.is_file() => {
            return Err("This build does not contain the WinT CLI used by terminal compatibility. Run npm run cli:build and restart WinT.".to_string());
        }
        _ => {}
    }
    let old_cmd = root.join("wt.cmd");
    if old_cmd.is_file() {
        let _ = std::fs::remove_file(old_cmd);
    }
    sweep_replaced_proxies(&root);
    Ok(root)
}

pub fn term_pid(id: &str) -> Result<u32, String> {
    session::pid(id)
}

/// Hands a session's events to every window, under the names the views listen
/// for. Emitting only queues the event, so the reader thread is never held up
/// by a window that is busy drawing.
fn sink(app: AppHandle) -> session::Sink {
    Arc::new(move |event: Event| {
        let name = event.name();
        let _ = match event {
            Event::Update(update) => app.emit(name, update),
            Event::Exit(info) => app.emit(name, info),
            Event::Serving(serving) => app.emit(name, serving),
            Event::PortTaken(taken) => app.emit(name, taken),
        };
    })
}

/// Lets the engine find the shells WinT downloaded. Said every time a shell is
/// looked for because it costs nothing after the first.
fn know_managed_shells() {
    shell_paths::set_managed_lookup(crate::shells::managed_exe);
}

// ---- commands ----------------------------------------------------------

#[tauri::command]
pub async fn term_shell_availability() -> Vec<ShellAvailability> {
    tauri::async_runtime::spawn_blocking(|| {
        know_managed_shells();
        shell_paths::availability()
    })
    .await
    .unwrap_or_default()
}

/// Starting a shell means `CreateProcess` plus a pseudoconsole handshake, which
/// is far too slow to run on the thread that draws the window.
#[tauri::command]
pub async fn term_open(app: AppHandle, args: OpenArgs) -> Result<TermInfo, String> {
    tauri::async_runtime::spawn_blocking(move || term_open_sync(app, args))
        .await
        .unwrap_or_else(|_| Err("The shell could not be started.".into()))
}

fn term_open_sync(app: AppHandle, args: OpenArgs) -> Result<TermInfo, String> {
    know_managed_shells();
    let compat = wt_compat_dir(&app)?;
    let wt_queue = compat.join(format!("requests-{}", std::process::id()));
    let app_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let launch = Launch {
        env: vec![
            ("WINT_APP".into(), app_exe.to_string_lossy().into_owned()),
            ("WINT_WT_QUEUE".into(), wt_queue.to_string_lossy().into_owned()),
        ],
        path_prefix: Some(compat),
        // The `wt` proxy reads this to say which terminal a split belongs to.
        id_variable: Some("WINT_TERM_ID"),
    };
    session::open(args, launch, sink(app))
}

/// Where this terminal last said it was serving, for a view that arrived after
/// it said so. Without this, opening a workspace on a project whose dev server is
/// already running would leave the browser panel blank until the next restart.
#[tauri::command]
pub async fn term_serving(id: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || session::serving(&id))
        .await
        .unwrap_or_default()
}

/// Everything a fresh view needs to draw the session as it stands.
#[tauri::command]
pub async fn term_attach(id: String) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || session::attach(&id))
        .await
        .unwrap_or_else(|_| Err("The terminal snapshot could not be read.".into()))
}

/// A keystroke, posted to the session's queue.
///
/// This one stays synchronous, and that is the point: the window thread is what
/// defines the order keystrokes were typed in, and handing them to a thread
/// pool would let two of them reach the shell the wrong way round. All it does
/// here is post to a queue - no lock the pseudoconsole holds, no write that can
/// block on a full pipe.
#[tauri::command]
pub fn term_write(id: String, data: String) -> Result<(), String> {
    session::write(&id, data.into_bytes())
}

/// Resizes go through the same queue as the keystrokes, so a shell is never
/// told about a size in a different order than the window applied it. The
/// promise still resolves only once the grid really is that size - which is
/// what the front end repaints against - but the wait is on a pool thread.
#[tauri::command]
pub async fn term_resize(id: String, cols: usize, rows: usize) -> Result<(), String> {
    let done = session::resize(&id, cols, rows)?;
    let _ = tauri::async_runtime::spawn_blocking(move || done.recv()).await;
    Ok(())
}

/// Tearing a pseudoconsole down blocks until the console's own pump lets go, so
/// this never runs on the window thread. `term_close_snapshot` already calls
/// the inner form from a pool thread; the command is the direct route.
#[tauri::command]
pub async fn term_close(id: String) -> Result<(), String> {
    off_thread(move || term_close_now(id)).await;
    Ok(())
}

pub fn term_close_now(id: String) -> Result<(), String> {
    session::close(&id);
    Ok(())
}

/// Drops the streams of terminals nobody is going to open again - a terminal
/// closed while the app was not running, or one lost to a crash. The window
/// sends the keys it still knows about as it restores them.
#[tauri::command]
pub async fn term_prune_history(keys: Vec<String>) {
    off_thread(move || wint_term::history::prune(&keys)).await;
}

/// The command histories the installed shells keep, for Ctrl+R. Read on a
/// worker only when Ctrl+R is first opened; the files can be large.
#[tauri::command]
pub async fn term_command_history() -> Vec<wint_term::command_history::ShellHistoryEntry> {
    off_thread(wint_term::command_history::read)
        .await
        .unwrap_or_default()
}

/// Sessions for one project, or every session when `project_path` is omitted.
/// Every `info` reads a title out of a grid the reader thread is writing to,
/// so the list waits on those locks - off the window thread it goes.
#[tauri::command]
pub async fn term_list(project_path: Option<String>) -> Vec<TermInfo> {
    off_thread(move || {
        session::list()
            .into_iter()
            .filter(|info| match &project_path {
                Some(p) => crate::util::norm(&info.project_path) == crate::util::norm(p),
                None => true,
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Where a popped-out terminal's shape is kept. One entry for all of them:
/// the pages that own these windows report under the same name.
fn popout_geometry_key() -> String {
    crate::window_geometry::key_for("terminal-window", "popout")
}

/// Opens a session in its own window. The session is untouched — this only
/// creates a second view, so a build keeps running while it moves.
/// Building a webview has to pump the event loop, so it cannot run on the
/// thread that owns it: from a synchronous command the window appears but its
/// webview never loads, leaving a black frame — and the front end never gets
/// its reply either. Hence `async` plus [`off_thread`].
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn term_popout(
    app: AppHandle,
    id: String,
    x: Option<f64>,
    y: Option<f64>,
    position: Option<String>,
    dimensions: Option<String>,
    maximized: Option<bool>,
    fullscreen: Option<bool>,
    focus: Option<bool>,
    // The window whose dock this terminal is leaving. It travels with the
    // window, so that docking back lands in the dock it came from rather than
    // in whichever window happened to hear the broadcast.
    origin: Option<String>,
) -> Result<(), String> {
    let info = session::info(&id)?;
    let label = format!("term-{id}");
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }
    let title = Path::new(info.project_path.trim_end_matches(['\\', '/']))
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| info.project_name.clone());
    // The shape a terminal window was last left in, fitted to the monitors that
    // are here now. One shape for every popped-out terminal: what is being
    // remembered is how big a terminal wants to be, and the next one wants the
    // same. A drag still lands where it was dropped — see below.
    let placement = {
        let app = app.clone();
        crate::off_thread(move || {
            let saved = crate::window_geometry::load(&app, &popout_geometry_key());
            crate::window_geometry::fit(
                &app,
                saved,
                crate::window_geometry::Defaults {
                    width: 900.0,
                    height: 600.0,
                    min_width: 400.0,
                    min_height: 200.0,
                },
                // Dragging a terminal out is asking to see it.
                false,
            )
        })
        .await
        .ok_or("Could not work out where that window belongs.")?
    };
    off_thread(move || {
        let (saved_width, saved_height) = placement.logical_size();
        let mut builder = WebviewWindowBuilder::new(
            &app,
            &label,
            WebviewUrl::App(
                match origin.as_deref().filter(|value| !value.is_empty()) {
                    Some(origin) => format!("terminal.html?id={id}&origin={origin}"),
                    None => format!("terminal.html?id={id}"),
                }
                .into(),
            ),
        )
        .title(title)
        .inner_size(saved_width, saved_height)
        .min_inner_size(400.0, 200.0)
        .decorations(false)
        .background_color(tauri::webview::Color(12, 13, 17, 255));
        let pair = |value: Option<String>| {
            value.and_then(|value| {
                let (a, b) = value.split_once(',')?;
                Some((a.trim().parse::<f64>().ok()?, b.trim().parse::<f64>().ok()?))
            })
        };
        // The dock this terminal is leaving knows the size it was showing at,
        // and that beats the remembered one: the window should be the panel it
        // was a moment ago, not the last terminal window somebody closed.
        if let Some((cols, rows)) = pair(dimensions) {
            builder = builder.inner_size((cols * 9.0).max(400.0), (rows * 18.0).max(200.0));
        }
        // Likewise the place: a terminal dragged out belongs under the pointer
        // that dropped it. Only a pop-out with nothing to say falls back to
        // where the last terminal window was.
        if let Some((px, py)) = pair(position) {
            builder = builder.position(px, py);
        } else if let (Some(x), Some(y)) = (x, y) {
            builder = builder.position(x, y);
        } else if let Some((px, py)) = placement.logical_position() {
            builder = builder.position(px, py);
        }
        builder
            .build()
            .and_then(|window| {
                if maximized.unwrap_or(placement.maximized) {
                    window.maximize()?;
                }
                if fullscreen.unwrap_or(false) {
                    window.set_fullscreen(true)?;
                }
                if focus.unwrap_or(true) {
                    window.set_focus()?;
                }
                Ok(())
            })
            .map_err(|e| format!("Could not open the window: {e}"))
    })
    .await
    .unwrap_or_else(|| Err("Could not open the window.".to_string()))
}

/// A terminal with nowhere to dock: a fresh shell in the user's home folder,
/// straight into a window of its own. The sidebar's terminal button asks for
/// this, and so does the "New terminal window" command — bound system-wide it
/// is a shell anywhere, without the main window coming forward first.
#[tauri::command]
pub async fn sidebar_open_terminal(app: AppHandle) -> Result<(), String> {
    let home = std::env::var("USERPROFILE")
        .map_err(|_| "No home folder to open a shell in.".to_string())?;
    let args = OpenArgs {
        project_path: home,
        project_name: Some("Home".into()),
        command: None,
        shell: None,
        cols: None,
        rows: None,
        history_key: None,
    };
    let info = term_open(app.clone(), args).await?;
    term_popout(
        app,
        info.id,
        None,
        None,
        None,
        None,
        None,
        None,
        Some(true),
        None,
    )
    .await
}

// ---- administrator terminals -------------------------------------------
//
// An elevated pseudoconsole is not something this process can make.
// `CreateProcessW` in `conpty.rs` cannot raise integrity — only
// `ShellExecuteEx` with the `runas` verb can — and `ShellExecuteEx` offers no
// `STARTUPINFOEX`, so it has no way to hand its child a pseudoconsole. Nor can
// a high-integrity child be attached to one owned by a medium-integrity
// process.
//
// So an administrator terminal here is not a session relayed out of this
// process. It is a second WinT, elevated, hosting its own pseudoconsole
// natively. Nothing crosses the integrity boundary — there is no pipe this
// process could write into, and so no way for anything running as the user to
// drive an administrator shell without Windows having asked first. That is the
// whole reason for doing it this way rather than brokering a pty back here.
//
// The cost is that such a terminal lives in its own window and cannot dock
// into this one: the session belongs to the other process, and a dock's
// registry only ever holds its own. `popout.js` hides the dock button when it
// is the elevated instance drawing the window.

const ADMIN_FLAG: &str = "--admin-term";
const ADMIN_CWD: &str = "--admin-cwd=";
const ADMIN_SHELL: &str = "--admin-shell=";

/// What an elevated WinT was started to open.
pub struct AdminRequest {
    pub cwd: String,
    pub shell: String,
}

fn flag_value(args: &[String], prefix: &str) -> String {
    args.iter()
        .find_map(|arg| arg.strip_prefix(prefix))
        .unwrap_or_default()
        .to_string()
}

/// The administrator terminal this process exists to be, if it is one. Checked
/// before the app is built: an instance in this mode registers no
/// single-instance plugin, opens no main window and starts none of the
/// background workers, because it is one terminal and nothing else.
pub fn admin_request(args: &[String]) -> Option<AdminRequest> {
    args.iter().any(|arg| arg == ADMIN_FLAG).then(|| {
        let shell = flag_value(args, ADMIN_SHELL);
        AdminRequest {
            cwd: flag_value(args, ADMIN_CWD),
            shell: if shell.is_empty() {
                "auto".to_string()
            } else {
                shell
            },
        }
    })
}

/// Percent-encodes what goes in the query string. A Windows path carries
/// backslashes, spaces and the odd `#`, none of which survive being pasted into
/// a URL untouched.
fn query_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The window an elevated WinT draws: one popped-out terminal, marked as
/// administrator, and no dock behind it.
pub fn open_admin_window(app: &AppHandle, request: &AdminRequest) -> Result<(), String> {
    let title = Path::new(request.cwd.trim_end_matches(['\\', '/']))
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Terminal".to_string());
    WebviewWindowBuilder::new(
        app,
        // Under `term-` so capabilities/default.json grants it what every
        // popped-out terminal gets. No session id is ever "admin".
        "term-admin",
        WebviewUrl::App(
            format!(
                "terminal.html?admin=1&cwd={}&shell={}",
                query_escape(&request.cwd),
                query_escape(&request.shell)
            )
            .into(),
        ),
    )
    .title(format!("{title} — Administrator"))
    .inner_size(900.0, 600.0)
    .min_inner_size(400.0, 200.0)
    .decorations(false)
    .background_color(tauri::webview::Color(12, 13, 17, 255))
    .build()
    .map(|window| {
        let _ = window.set_focus();
    })
    .map_err(|e| format!("Could not open the administrator terminal: {e}"))
}

/// Asks Windows for an elevated WinT that opens one terminal. The UAC prompt is
/// the whole of the security here, and it is Windows' own — this returns the
/// moment the prompt is answered, either way.
#[tauri::command]
pub async fn term_open_admin(project_path: String, shell: Option<String>) -> Result<(), String> {
    let dir = PathBuf::from(&project_path);
    if !dir.is_dir() {
        return Err("Folder no longer exists.".into());
    }
    let shell = shell.unwrap_or_else(|| "auto".to_string());
    off_thread(move || launch_elevated(&project_path, &shell))
        .await
        .unwrap_or_else(|| Err("The administrator terminal could not be started.".into()))
}

#[cfg(windows)]
fn launch_elevated(cwd: &str, shell: &str) -> Result<(), String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let exe = HSTRING::from(
        std::env::current_exe()
            .map_err(|e| format!("WinT could not find its own program: {e}"))?
            .to_string_lossy()
            .into_owned(),
    );
    // A backslash right before a closing quote escapes it, so `"C:\"` would
    // swallow the rest of the line. `C:\.` is the same folder and parses cleanly.
    // Neither a path nor a profile name can contain a quote of its own.
    let cwd = if cwd.ends_with('\\') {
        format!("{cwd}.")
    } else {
        cwd.to_string()
    };
    let params = HSTRING::from(format!(
        "{ADMIN_FLAG} {ADMIN_CWD}\"{cwd}\" {ADMIN_SHELL}\"{shell}\""
    ));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: w!("runas"),
        lpFile: PCWSTR(exe.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    unsafe {
        // Declining the prompt is a choice, not a failure worth a dialog. The
        // front end says so in the status bar and nothing else happens.
        ShellExecuteExW(&mut info)
            .map_err(|_| "The administrator prompt was dismissed.".to_string())?;
        if info.hProcess.is_invalid() {
            return Err("Windows did not start the administrator terminal.".into());
        }
        // Not waited on: the elevated WinT owns that window for as long as the
        // terminal in it lives, which is not something this process waits out.
        let _ = CloseHandle(info.hProcess);
    }
    Ok(())
}

#[cfg(not(windows))]
fn launch_elevated(_cwd: &str, _shell: &str) -> Result<(), String> {
    Err("Administrator terminals are a Windows feature.".into())
}

/// A small native drag image used once a dock tab leaves the main webview.
/// Unlike an HTML element it can remain visible over the Windows desktop.
#[tauri::command]
pub async fn term_drag_preview(
    app: AppHandle,
    action: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    off_thread(move || {
        const LABEL: &str = "term-drag-preview";
        if action == "close" {
            if let Some(window) = app.get_webview_window(LABEL) {
                let _ = window.destroy();
            }
            return Ok(());
        }
        if let Some(window) = app.get_webview_window(LABEL) {
            return window
                .set_position(LogicalPosition::new(x, y))
                .map_err(|e| e.to_string());
        }
        if action == "move" {
            return Ok(());
        }
        WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("terminal-drag.html".into()))
            .inner_size(245.0, 38.0)
            .position(x, y)
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .shadow(true)
            .build()
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|| Err("Could not show the terminal drag preview.".to_string()))
}

/// Closes the popped-out window for a session, used when it docks back in.
///
/// `destroy` rather than `close`: closing only *asks*, and the window answers a
/// close request by announcing a dock - which lands right back here. The panel
/// already holds the session by this point, so the window is simply gone.
#[tauri::command]
pub async fn term_dock(app: AppHandle, id: String, focus: Option<String>) -> Result<(), String> {
    off_thread(move || {
        if let Some(win) = app.get_webview_window(&format!("term-{id}")) {
            let _ = win.destroy();
        }
        // Focus the window the terminal is docking into: the workspace it came
        // from, or the main window if nowhere else claims it.
        if let Some(focus_label) = focus.as_ref() {
            if let Some(win) = app.get_webview_window(focus_label) {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
                return;
            }
        }
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
        }
    })
    .await;
    Ok(())
}

/// Kills every session. Called as the app exits so no orphaned shell outlives
/// the window that owned it.
pub fn shutdown() {
    session::shutdown();
}

/// The version out of a `--version` run, or nothing if it doesn't look like one.
///
/// Exit code zero is not proof a CLI is there. VS Code's Copilot Chat extension
/// puts a `copilot.bat` launcher on PATH that exits 0 while printing
/// "Cannot find GitHub Copilot CLI (…)" — taken at face value that sentence
/// became the version, the panel called the CLI installed and offered a chat
/// that could never answer. A real version carries a number, so that is what
/// this looks for: the first line holding a `<digits>.<digits>`.
pub fn version_line(stdout: &str) -> String {
    stdout
        .lines()
        .map(str::trim)
        .find(|line| {
            let bytes = line.as_bytes();
            bytes
                .windows(3)
                .any(|w| w[0].is_ascii_digit() && w[1] == b'.' && w[2].is_ascii_digit())
        })
        .unwrap_or("")
        .to_string()
}
