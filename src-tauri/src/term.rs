//! Terminal sessions, and the commands the front end drives them with.
//!
//! The session — pseudoconsole, child process and screen — lives here in Rust,
//! keyed by id. A webview is only ever a view onto it. That is what makes
//! popping a terminal out of the main window cheap: the new window calls
//! [`term_attach`] and is handed the current screen, while the shell underneath
//! never notices it changed frames.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::conpty::{self, ConPty};
use crate::off_thread;
use crate::vt::{Cell, Grid, DEFAULT_COLOR};

/// How much history an attaching view is handed. The session keeps more than
/// this; the rest is simply older than anyone scrolls back to on open.
const ATTACH_HISTORY: usize = 1000;

/// Shells tried in order. The first that starts wins, so a machine with
/// PowerShell 7 gets it and everything else falls back to what ships with Windows.
const SHELLS: &[&str] = &["pwsh.exe -NoLogo", "powershell.exe -NoLogo"];

fn shell_command(profile: &str) -> Result<String, String> {
    match profile {
        "pwsh" => Ok("pwsh.exe -NoLogo".into()),
        "powershell" => Ok("powershell.exe -NoLogo".into()),
        "cmd" => Ok("cmd.exe".into()),
        "wsl" => Ok("wsl.exe --exec bash --login".into()),
        "git-bash" => {
            let mut candidates = Vec::new();
            for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
                if let Some(root) = std::env::var_os(variable) {
                    candidates.push(PathBuf::from(root).join("Git").join("bin").join("bash.exe"));
                }
            }
            if let Some(root) = std::env::var_os("LOCALAPPDATA") {
                candidates.push(
                    PathBuf::from(root)
                        .join("Programs")
                        .join("Git")
                        .join("bin")
                        .join("bash.exe"),
                );
            }
            let Some(bash) = candidates.into_iter().find(|path| path.is_file()) else {
                return Err("Git Bash was not found. Install Git for Windows or choose another shell.".into());
            };
            Ok(format!(r#""{}" --login -i"#, bash.display()))
        }
        _ => Err("Unknown terminal shell.".into()),
    }
}

struct Session {
    id: String,
    project_path: String,
    project_name: String,
    pty: Mutex<ConPty>,
    grid: Mutex<Grid>,
    alive: AtomicBool,
    pid: u32,
    command: String,
    /// Bytes written to the raw capture so far, which is what lets a resize be
    /// recorded at the point in the stream where it happened. Always counted;
    /// it means nothing when no capture is running.
    captured: AtomicU64,
}

fn registry() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("t{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

fn lookup(id: &str) -> Result<Arc<Session>, String> {
    registry()
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| "That terminal is gone.".to_string())
}

// ---- wire types --------------------------------------------------------

/// One stretch of cells sharing a colour and attributes, which is how a row
/// reaches the front end: a handful of runs instead of hundreds of cells.
#[derive(Serialize, Clone)]
struct Run {
    t: String,
    f: u32,
    b: u32,
    a: u8,
}

#[derive(Serialize, Clone)]
struct RowUpdate {
    y: usize,
    runs: Vec<Run>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TermInfo {
    pub id: String,
    pub project_path: String,
    pub project_name: String,
    pub title: String,
    pub pid: u32,
    pub alive: bool,
    pub command: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    info: TermInfo,
    cols: usize,
    rows: usize,
    history: Vec<Vec<Run>>,
    screen: Vec<RowUpdate>,
    cx: usize,
    cy: usize,
    cursor_visible: bool,
    cursor_style: u8,
    cursor_char: char,
    alt: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Update {
    id: String,
    rows: Vec<RowUpdate>,
    scrolled: Vec<Vec<Run>>,
    cx: usize,
    cy: usize,
    cursor_visible: bool,
    cursor_style: u8,
    cursor_char: char,
    alt: bool,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenArgs {
    pub project_path: String,
    pub project_name: Option<String>,
    /// A specific command to run instead of an interactive shell — an npm
    /// script, say. The session is otherwise identical.
    pub command: Option<String>,
    pub shell: Option<String>,
    pub cols: Option<usize>,
    pub rows: Option<usize>,
}

/// Packs a row into runs, dropping the trailing default-background blanks that
/// make up most of a typical line.
fn pack(cells: &[Cell]) -> Vec<Run> {
    let end = cells
        .iter()
        .rposition(|c| c.ch != ' ' || c.bg != DEFAULT_COLOR || c.attr != 0)
        .map(|i| i + 1)
        .unwrap_or(0);
    let mut runs: Vec<Run> = Vec::new();
    for cell in &cells[..end] {
        match runs.last_mut() {
            Some(run) if run.f == cell.fg && run.b == cell.bg && run.a == cell.attr => {
                run.t.push(cell.ch)
            }
            _ => runs.push(Run {
                t: cell.ch.to_string(),
                f: cell.fg,
                b: cell.bg,
                a: cell.attr,
            }),
        }
    }
    runs
}

impl Session {
    fn info(&self) -> TermInfo {
        let title = self.grid.lock().unwrap().title.clone();
        TermInfo {
            id: self.id.clone(),
            project_path: self.project_path.clone(),
            project_name: self.project_name.clone(),
            title,
            pid: self.pid,
            // A child that has exited without the reader noticing yet still
            // reads as dead, so a stale tab cannot look live.
            alive: self.alive.load(Ordering::Relaxed) && !self.pty.lock().unwrap().exited(),
            command: self.command.clone(),
        }
    }
}

// ---- commands ----------------------------------------------------------

/// Starting a shell means `CreateProcess` plus a pseudoconsole handshake, which
/// is far too slow to run on the thread that draws the window.
#[tauri::command]
pub async fn term_open(app: AppHandle, args: OpenArgs) -> Result<TermInfo, String> {
    tauri::async_runtime::spawn_blocking(move || term_open_sync(app, args))
        .await
        .unwrap_or_else(|_| Err("The shell could not be started.".into()))
}

fn term_open_sync(app: AppHandle, args: OpenArgs) -> Result<TermInfo, String> {
    let dir = PathBuf::from(&args.project_path);
    if !dir.is_dir() {
        return Err("Folder no longer exists.".into());
    }
    let cols = args.cols.unwrap_or(80).clamp(20, 500);
    let rows = args.rows.unwrap_or(24).clamp(5, 200);

    let (pty, command) = match &args.command {
        Some(cmd) => (ConPty::spawn(cmd, &dir, cols as u16, rows as u16)?, cmd.clone()),
        None => match args.shell.as_deref().unwrap_or("auto") {
            "auto" => spawn_shell(&dir, cols as u16, rows as u16)?,
            profile => {
                let shell = shell_command(profile)?;
                (ConPty::spawn(&shell, &dir, cols as u16, rows as u16)?, shell)
            }
        },
    };

    let id = next_id();
    let session = Arc::new(Session {
        id: id.clone(),
        project_path: args.project_path.clone(),
        project_name: args
            .project_name
            .unwrap_or_else(|| dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()),
        pid: pty.pid(),
        pty: Mutex::new(pty),
        grid: Mutex::new(Grid::new(cols, rows)),
        alive: AtomicBool::new(true),
        command,
        captured: AtomicU64::new(0),
    });
    registry().lock().unwrap().insert(id.clone(), session.clone());

    spawn_reader(app, session.clone());
    Ok(session.info())
}

/// Tries each candidate shell until one starts.
fn spawn_shell(dir: &Path, cols: u16, rows: u16) -> Result<(ConPty, String), String> {
    let mut last = String::from("No shell available.");
    for shell in SHELLS {
        match ConPty::spawn(shell, dir, cols, rows) {
            Ok(pty) => return Ok((pty, (*shell).to_string())),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// Opt-in raw capture of everything the pseudoconsole says, so a rendering bug
/// can be reproduced away from the window. Set `DEVHQ_TERM_LOG` to a directory;
/// each session then writes `<run>-<id>.bin` (the exact bytes) beside
/// `<run>-<id>.meta` (the size it started at, then one line per resize), which
/// `cargo run --example term_replay` replays. Unset — the normal case — this
/// costs one env lookup per session.
fn capture_dir() -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var_os("DEVHQ_TERM_LOG")?);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Session ids restart at `t1` every time the app starts, so a capture named
/// after the id alone is silently overwritten by the next run — and half-stale
/// pairs read as a bug that isn't there. Stamping the run keeps them apart.
fn capture_run() -> &'static str {
    static RUN: OnceLock<String> = OnceLock::new();
    RUN.get_or_init(|| {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("run{secs}")
    })
}

fn open_capture(session: &Session) -> Option<std::fs::File> {
    let dir = capture_dir()?;
    let (cols, rows) = {
        let grid = session.grid.lock().unwrap();
        (grid.cols, grid.rows)
    };
    let stem = format!("{}-{}", capture_run(), session.id);
    let _ = std::fs::write(dir.join(format!("{stem}.meta")), format!("{cols} {rows}\n"));
    std::fs::File::create(dir.join(format!("{stem}.bin"))).ok()
}

/// Notes a resize in the sidecar, stamped with how far into the byte stream it
/// landed. Resizes never appear in the bytes themselves, so without this a
/// replay silently runs the whole session at the size it opened at.
fn note_capture_resize(session: &Session, cols: usize, rows: usize) {
    let Some(dir) = capture_dir() else { return };
    let Ok(mut file) = std::fs::OpenOptions::new()
        .append(true)
        .open(dir.join(format!("{}-{}.meta", capture_run(), session.id)))
    else {
        return;
    };
    use std::io::Write;
    let at = session.captured.load(Ordering::Relaxed);
    let _ = writeln!(file, "resize {at} {cols} {rows}");
}

/// The reader thread: block on the pseudoconsole, feed the screen, ship the
/// rows that changed. Blocking on `ReadFile` is itself the coalescing — ConPTY
/// hands us one batched repaint per flush rather than a byte at a time.
fn spawn_reader(app: AppHandle, session: Arc<Session>) {
    let handle = session.pty.lock().unwrap().output();
    let mut capture = open_capture(&session);
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            let Some(n) = conpty::read_chunk(handle, &mut buf) else { break };
            if let Some(file) = capture.as_mut() {
                use std::io::Write;
                let _ = file.write_all(&buf[..n]);
                let _ = file.flush();
                session.captured.fetch_add(n as u64, Ordering::Relaxed);
            }
            let update = {
                let mut grid = session.grid.lock().unwrap();
                grid.feed(&buf[..n]);
                let scrolled = grid.take_scrolled().iter().map(|l| pack(l)).collect();
                let rows = grid
                    .take_dirty()
                    .into_iter()
                    .map(|y| RowUpdate { y, runs: pack(grid.row(y)) })
                    .collect();
                Update {
                    id: session.id.clone(),
                    rows,
                    scrolled,
                    cx: grid.cx,
                    cy: grid.cy,
                    cursor_visible: grid.cursor_visible,
                    cursor_style: grid.cursor_style,
                    cursor_char: grid.row(grid.cy)[grid.cx].ch,
                    alt: grid.alt,
                    title: grid.title.clone(),
                }
            };
            let _ = app.emit("term:update", update);
        }
        session.alive.store(false, Ordering::Relaxed);
        let _ = app.emit("term:exit", session.info());
    });
}

/// Everything a fresh view needs to draw the session as it stands.
#[tauri::command]
pub async fn term_attach(id: String) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || term_attach_sync(id))
        .await
        .unwrap_or_else(|_| Err("The terminal snapshot could not be read.".into()))
}

fn term_attach_sync(id: String) -> Result<Snapshot, String> {
    let session = lookup(&id)?;
    // Taken before the grid is locked: `info` reads the title out of the grid
    // itself, and a std mutex is not reentrant.
    let info = session.info();
    let grid = session.grid.lock().unwrap();
    let history: Vec<Vec<Run>> = grid
        .scrollback
        .iter()
        .skip(grid.scrollback.len().saturating_sub(ATTACH_HISTORY))
        .map(|l| pack(l))
        .collect();
    let screen = (0..grid.rows).map(|y| RowUpdate { y, runs: pack(grid.row(y)) }).collect();
    Ok(Snapshot {
        info,
        cols: grid.cols,
        rows: grid.rows,
        history,
        screen,
        cx: grid.cx,
        cy: grid.cy,
        cursor_visible: grid.cursor_visible,
        cursor_style: grid.cursor_style,
        cursor_char: grid.row(grid.cy)[grid.cx].ch,
        alt: grid.alt,
    })
}

#[tauri::command]
pub fn term_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    let session = lookup(&id)?;
    if !session.alive.load(Ordering::Relaxed) {
        return Ok(());
    }
    let _ = app.emit("term:input", id.clone());
    let result = session.pty.lock().unwrap().write(data.as_bytes());
    result
}

#[tauri::command]
pub fn term_resize(id: String, cols: usize, rows: usize) -> Result<(), String> {
    let session = lookup(&id)?;
    let cols = cols.clamp(20, 500);
    let rows = rows.clamp(5, 200);
    note_capture_resize(&session, cols, rows);
    session.grid.lock().unwrap().resize(cols, rows);
    let result = session.pty.lock().unwrap().resize(cols as u16, rows as u16);
    result
}

#[tauri::command]
pub fn term_close(id: String) -> Result<(), String> {
    if let Some(session) = registry().lock().unwrap().remove(&id) {
        session.alive.store(false, Ordering::Relaxed);
        session.pty.lock().unwrap().close();
    }
    Ok(())
}

/// Sessions for one project, or every session when `project_path` is omitted.
#[tauri::command]
pub fn term_list(project_path: Option<String>) -> Vec<TermInfo> {
    let sessions: Vec<Arc<Session>> = registry().lock().unwrap().values().cloned().collect();
    let mut out: Vec<TermInfo> = sessions
        .iter()
        .filter(|s| match &project_path {
            Some(p) => crate::util::norm(&s.project_path) == crate::util::norm(p),
            None => true,
        })
        .map(|s| s.info())
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Opens a session in its own window. The session is untouched — this only
/// creates a second view, so a build keeps running while it moves.
/// Building a webview has to pump the event loop, so it cannot run on the
/// thread that owns it: from a synchronous command the window appears but its
/// webview never loads, leaving a black frame — and the front end never gets
/// its reply either. Hence `async` plus [`off_thread`].
#[tauri::command]
pub async fn term_popout(
    app: AppHandle,
    id: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    let session = lookup(&id)?;
    let label = format!("term-{id}");
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }
    let title = format!("{} — {}", session.project_name, session.command);
    off_thread(move || {
        let mut builder = WebviewWindowBuilder::new(
            &app,
            &label,
            WebviewUrl::App(format!("terminal.html?id={id}").into()),
        )
        .title(title)
        .inner_size(900.0, 600.0)
        .min_inner_size(400.0, 200.0)
        .decorations(false)
        .background_color(tauri::webview::Color(12, 13, 17, 255));
        if let (Some(x), Some(y)) = (x, y) {
            builder = builder.position(x, y);
        }
        builder.build()
        .and_then(|window| {
            window.set_focus()?;
            Ok(())
        })
        .map_err(|e| format!("Could not open the window: {e}"))
    })
    .await
    .unwrap_or_else(|| Err("Could not open the window.".to_string()))
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
pub async fn term_dock(app: AppHandle, id: String) -> Result<(), String> {
    off_thread(move || {
        if let Some(win) = app.get_webview_window(&format!("term-{id}")) {
            let _ = win.destroy();
        }
    })
    .await;
    Ok(())
}

/// Kills every session. Called as the app exits so no orphaned shell outlives
/// the window that owned it.
pub fn shutdown() {
    let sessions: Vec<_> = registry().lock().unwrap().drain().map(|(_, session)| session).collect();
    for session in &sessions {
        session.alive.store(false, Ordering::Relaxed);
        session.pty.lock().unwrap().terminate_child();
    }
    std::thread::spawn(move || {
        for session in sessions {
            session.pty.lock().unwrap().close();
        }
    });
}
