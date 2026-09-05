//! The workspace: one window per project, holding everything that project needs
//! at once — its files, its git history, a terminal, agent chats
//! and a browser pointed at whatever the terminal just started serving.
//!
//! Almost nothing here is new machinery. The terminals are the same
//! Rust-owned sessions [`crate::term`] hands out, so a dev server keeps running
//! while its pane is moved or the window is closed and reopened; the chats
//! drive the CLIs the person already installed ([`crate::claude`],
//! [`crate::cursor`], [`crate::copilot`], [`crate::codex`], [`crate::gemini`]); and the browser is a child webview positioned over a
//! hole in the page, the same trick embedded tools already use in
//! [`crate::tool_window`].
//!
//! What is new is the layout: named slots the front end assigns panels to,
//! and the bounds bookkeeping that keeps the browser webview sitting exactly
//! where its slot is. A child webview floats above the page and cannot be
//! occluded by it, which is why the front end also gets to hide it outright -
//! during a drag, or when its slot is collapsed.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::off_thread;

/// One workspace per project path, so asking twice focuses the window that is
/// already open rather than opening a second view of the same folder.
fn window_label(path: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.to_lowercase().bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("workspace-{hash:016x}")
}

fn browser_label(window: &str) -> String {
    format!("{window}-browser")
}

#[tauri::command]
pub async fn workspace_open(
    app: AppHandle,
    path: String,
    name: Option<String>,
    theme: Option<String>,
    // Where this project's workspace was last left. Applied while the window
    // is built rather than after it appears, so it never shows at the default
    // size and then jumps.
    geometry: Option<WindowGeometry>,
) -> Result<String, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err("That folder no longer exists.".into());
    }
    let label = window_label(&path);
    // `get_webview_window` only answers for a window holding exactly one
    // webview, and a workspace stops being one the moment its browser panel is
    // added as a child. Asking for the *window* is the question that stays true
    // either way - otherwise opening an already-open workspace looked closed,
    // fell through to the builder, and failed on the label it had itself taken.
    if let Some(existing) = app.get_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(label);
    }
    let title = name.unwrap_or_else(|| {
        dir.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone())
    });
    let light = theme.as_deref() == Some("light");
    let page = format!(
        "workspace.html?path={}&name={}&theme={}",
        urlencode(&path),
        urlencode(&title),
        if light { "light" } else { "dark" }
    );
    // Match --bg in styles.css so the frame never flashes the wrong scheme.
    let background = if light {
        tauri::webview::Color(244, 245, 248, 255)
    } else {
        tauri::webview::Color(12, 13, 17, 255)
    };
    // Stamp the theme onto <html> before any stylesheet paints, same as a
    // popped-out tool window - the terminal panel keeps its own fixed palette
    // regardless, so this only affects the workspace chrome.
    let init_theme = format!(
        r#"document.documentElement.dataset.theme="{}";"#,
        if light { "light" } else { "dark" }
    );
    let opened = label.clone();
    let geometry = geometry.filter(WindowGeometry::is_usable);
    // Building a webview pumps the event loop, so it cannot happen on the
    // thread that owns it - the window would appear with a webview that never
    // loads, and this command would never answer.
    off_thread(move || {
        let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(page.into()))
            .title(format!("{title} — workspace"))
            .inner_size(1440.0, 900.0)
            .min_inner_size(760.0, 480.0)
            .decorations(false)
            .background_color(background)
            .initialization_script(&init_theme);
        if let Some(geometry) = &geometry {
            if let (Some(width), Some(height)) = (geometry.width, geometry.height) {
                builder = builder.inner_size(width.max(760.0), height.max(480.0));
            }
            if let (Some(x), Some(y)) = (geometry.x, geometry.y) {
                builder = builder.position(x, y);
            }
        }
        if let Some(icon) = crate::tool_window::taskbar_icon_for_tool("workspace") {
            builder = builder
                .icon(icon)
                .map_err(|e| format!("Could not set the window icon: {e}"))?;
        }
        match builder.build() {
            Ok(window) => {
                if geometry.as_ref().is_some_and(|geometry| geometry.maximized) {
                    let _ = window.maximize();
                }
                let _ = window.set_focus();
                Ok(())
            }
            // Two clicks in the same breath both find nothing open and both
            // build; the second loses. It asked for a window that is now there,
            // so give it that window rather than an error about a taken label.
            Err(e) => match app.get_window(&label) {
                Some(existing) => {
                    let _ = existing.unminimize();
                    let _ = existing.set_focus();
                    Ok(())
                }
                None => Err(format!("Could not open the workspace: {e}")),
            },
        }
    })
    .await
    .unwrap_or_else(|| Err("Could not open the workspace.".to_string()))?;
    Ok(opened)
}

/// The size, place and maximized state a workspace window was last left in.
/// The front end owns it — it is saved beside that project's panel layout —
/// so the only job here is to refuse numbers that would put the window
/// somewhere it could not be found again.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct WindowGeometry {
    width: Option<f64>,
    height: Option<f64>,
    x: Option<f64>,
    y: Option<f64>,
    #[serde(default)]
    maximized: bool,
}

impl WindowGeometry {
    /// A monitor that is gone takes its coordinates with it, and a size saved
    /// on a screen that no longer exists can be bigger than every screen left.
    /// Rather than track monitors, keep the numbers plausible and let Windows
    /// do the rest — it already pulls a placed window back onto a screen.
    fn is_usable(geometry: &Self) -> bool {
        let sane_size = |value: Option<f64>| {
            value.is_none_or(|value| value.is_finite() && (200.0..=20_000.0).contains(&value))
        };
        let sane_pos = |value: Option<f64>| {
            value.is_none_or(|value| value.is_finite() && value.abs() <= 40_000.0)
        };
        sane_size(geometry.width)
            && sane_size(geometry.height)
            && sane_pos(geometry.x)
            && sane_pos(geometry.y)
    }
}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

// ---- the browser panel -------------------------------------------------

/// Creates the browser webview inside a workspace window, or moves the one that
/// is already there. The front end calls this whenever the slot holding the
/// browser changes size, which is often, so an existing webview is repositioned
/// rather than rebuilt - rebuilding would throw away the page being looked at.
#[tauri::command]
pub async fn workspace_browser_show(
    app: AppHandle,
    window: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = browser_label(&window);
    let position = LogicalPosition::new(x, y);
    let size = LogicalSize::new(width.max(1.0), height.max(1.0));
    if let Some(webview) = app.get_webview(&label) {
        webview.show().map_err(|e| e.to_string())?;
        webview.set_position(position).map_err(|e| e.to_string())?;
        webview.set_size(size).map_err(|e| e.to_string())?;
        return Ok(());
    }
    // A child webview is added to the *window*, not to the webview filling it —
    // the two are different handles for the same frame, and only the window can
    // hold more than one.
    let Some(host) = app.get_window(&window) else {
        return Err("That workspace is not open.".into());
    };
    let target = url
        .parse::<tauri::Url>()
        .map_err(|_| format!("`{url}` is not an address the browser can open."))?;
    // Every address the page goes to of its own accord - a link followed, a
    // redirect, a form posted - comes back out here. Without this the panel
    // knows only the address it was told to open, so the box above the page
    // says one thing while the page shows another, and Back has nothing to
    // put in the box when it lands.
    // A profile of its own, keyed by the window label - which is the project
    // path hashed, so it is the same folder every time this project is opened.
    // Without it every workspace shares the app's one WebView2 profile: one
    // cookie jar, one localStorage, so signing in to a site in one workspace
    // signs you in everywhere, and two projects can never hold two accounts.
    let data_directory = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("workspace-browsers")
        .join(profile_dir_name(&window));
    let reporter = app.clone();
    let owner = window.clone();
    let watcher = app.clone();
    let watched = window.clone();
    off_thread(move || {
        let make_builder = || {
            let reporter = reporter.clone();
            let owner = owner.clone();
            WebviewBuilder::new(&label, WebviewUrl::External(target.clone()))
                .data_directory(data_directory.clone())
                .on_navigation(move |url| {
                    report_url(&reporter, &owner, url.as_str());
                    true
                })
        };
        match host.add_child(make_builder(), position, size) {
            Ok(_) => Ok(()),
            Err(first_err) => {
                // A profile left half-written - by a killed process, say - fails
                // every later open of this same workspace's browser in exactly
                // the same way, and nothing else ever clears it. Wipe it and try
                // once more: the sign-ins kept there are worth less than a
                // browser panel that can never be opened again.
                let _ = std::fs::remove_dir_all(&data_directory);
                host.add_child(make_builder(), position, size)
                    .map(|_| ())
                    .map_err(|second_err| {
                        format!(
                            "Could not open the browser panel: {first_err} \
                             (also failed after clearing its saved profile: {second_err})"
                        )
                    })
            }
        }
        .inspect(|()| watch_url(watcher, watched))
    })
    .await
    .unwrap_or_else(|| Err("Could not open the browser panel.".to_string()))
}

/// The folder a workspace's browser profile lives in.
///
/// The label arrives from the front end, and a folder name is not the place to
/// trust a string that came from a page - anything that is not plainly a label
/// is folded away, so no caller can steer this out of the profiles directory.
fn profile_dir_name(window: &str) -> String {
    let cleaned: String = window
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "workspace".to_string()
    } else {
        cleaned
    }
}

/// Where the browser panel has got to, whether or not anyone steered it there.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserUrl {
    window: String,
    url: String,
}

/// Tells the workspace page where its browser panel is.
///
/// Broadcast, not addressed. Every other stream in this app - the terminals,
/// the agent chats - emits to everyone and lets each page keep the events
/// carrying its own label, because a window label and a webview label are not
/// the same kind of name and picking the wrong one fails silently.
fn report_url(app: &AppHandle, window: &str, url: &str) {
    let _ = app.emit(
        "workspace:browser-url",
        BrowserUrl {
            window: window.to_string(),
            url: url.to_string(),
        },
    );
}

/// Watches where the page actually is, for as long as it is there.
///
/// [`WebviewBuilder::on_navigation`] fires before a document navigation, which
/// is most of what a browser does and none of what a single-page app does:
/// a router that rewrites the address with `history.pushState` never leaves
/// the document, so nothing is ever "navigated". Reading the address back is
/// the only account of it that is true either way.
///
/// Four times a second, off the main thread, and silent unless the answer
/// changed - the page only hears about it when there is something to hear.
/// It ends itself when the webview goes away, or when a newer one has taken
/// over the same slot.
fn watch_url(app: AppHandle, window: String) {
    let generation = {
        let mut generations = watching().lock().unwrap();
        let next = generations.entry(window.clone()).or_insert(0);
        *next += 1;
        *next
    };
    std::thread::spawn(move || {
        let label = browser_label(&window);
        let mut last = String::new();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(250));
            if watching().lock().unwrap().get(&window) != Some(&generation) {
                return;
            }
            let Some(webview) = app.get_webview(&label) else {
                return;
            };
            let Ok(url) = webview.url() else {
                continue;
            };
            let url = url.to_string();
            if url == last || url == "about:blank" {
                continue;
            }
            last = url.clone();
            report_url(&app, &window, &url);
        }
    });
}

/// Which watcher is the live one for a window, so a browser panel closed and
/// opened again does not end up with two threads reporting the same page.
fn watching() -> &'static std::sync::Mutex<std::collections::HashMap<String, u64>> {
    static WATCHING: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, u64>>> =
        std::sync::OnceLock::new();
    WATCHING.get_or_init(Default::default)
}

/// Hides the browser without destroying it, so the page survives.
///
/// A child webview is drawn over the page and cannot be covered by it. That is
/// exactly wrong while a panel is being dragged across the window, or while a
/// divider is being pulled through where the browser sits — so those moments
/// hide it and put it back afterwards.
#[tauri::command]
pub async fn workspace_browser_hide(app: AppHandle, window: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&browser_label(&window)) {
        webview.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn workspace_browser_navigate(app: AppHandle, window: String, url: String) -> Result<(), String> {
    let Some(webview) = app.get_webview(&browser_label(&window)) else {
        return Err("The browser panel is not open.".into());
    };
    let target = url
        .parse::<tauri::Url>()
        .map_err(|_| format!("`{url}` is not an address the browser can open."))?;
    webview.navigate(target).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn workspace_browser_reload(app: AppHandle, window: String) -> Result<(), String> {
    let Some(webview) = app.get_webview(&browser_label(&window)) else {
        return Ok(());
    };
    webview
        .eval("location.reload()")
        .map_err(|e| e.to_string())
}

/// Back and forward through the page's own history.
///
/// The panel cannot keep this list itself: a link followed inside the page is
/// a navigation nothing on this side ever hears about. The page knows, so the
/// page is asked - the same way reloading is.
#[tauri::command]
pub async fn workspace_browser_back(app: AppHandle, window: String) -> Result<(), String> {
    step_history(app, window, "back")
}

#[tauri::command]
pub async fn workspace_browser_forward(app: AppHandle, window: String) -> Result<(), String> {
    step_history(app, window, "forward")
}

fn step_history(app: AppHandle, window: String, way: &str) -> Result<(), String> {
    let Some(webview) = app.get_webview(&browser_label(&window)) else {
        return Ok(());
    };
    webview
        .eval(format!("history.{way}()"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn workspace_browser_close(app: AppHandle, window: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&browser_label(&window)) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---- the file panel ----------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    path: String,
    directory: bool,
    size: u64,
}

/// Folders WinT does not expand on its own. They are the ones that are always
/// enormous and never what someone opened a workspace to look at; a file list
/// that spends two seconds counting `node_modules` is a file list nobody waits
/// for. They are still listed - just never walked into by the "reveal" path.
const NOISE: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
];

fn is_noise(name: &str) -> bool {
    NOISE.iter().any(|entry| name.eq_ignore_ascii_case(entry))
}

/// One level of a folder, directories first and then files, each alphabetical.
///
/// One level only, on purpose: the tree is expanded by clicking, so a folder
/// nobody opened costs nothing, and no single call can walk into something the
/// size of `node_modules`.
#[tauri::command]
pub async fn workspace_list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = Path::new(&path);
        if !dir.is_dir() {
            return Err("That folder no longer exists.".to_string());
        }
        let reader = std::fs::read_dir(dir).map_err(|e| format!("Could not read the folder: {e}"))?;
        let mut rows: Vec<DirEntry> = reader
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                let meta = entry.metadata().ok()?;
                Some(DirEntry {
                    path: entry.path().to_string_lossy().into_owned(),
                    directory: meta.is_dir(),
                    size: if meta.is_dir() { 0 } else { meta.len() },
                    name,
                })
            })
            .collect();
        rows.sort_by(|a, b| {
            b.directory
                .cmp(&a.directory)
                // Noise sinks below everything else it would otherwise sit
                // between, because it is never the row being looked for.
                .then(is_noise(&a.name).cmp(&is_noise(&b.name)))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(rows)
    })
    .await
    .unwrap_or_else(|_| Err("Could not read the folder.".to_string()))
}

/// The text of a file, for the preview a click in the file list opens.
///
/// Capped, and only for files that are actually text: a workspace is not an
/// editor, and reading a 400 MB database dump into a webview to show the first
/// screen of it is not a thing to do by accident.
#[tauri::command]
pub async fn workspace_read_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        const CAP: u64 = 2 * 1024 * 1024;
        let file = Path::new(&path);
        let meta = std::fs::metadata(file).map_err(|e| format!("Could not open the file: {e}"))?;
        if meta.len() > CAP {
            return Err(format!(
                "That file is {} MB. The workspace previews files up to 2 MB.",
                meta.len() / 1_000_000
            ));
        }
        let bytes = std::fs::read(file).map_err(|e| format!("Could not read the file: {e}"))?;
        if bytes.contains(&0) {
            return Err("That looks like a binary file, so there is nothing to show.".into());
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await
    .unwrap_or_else(|_| Err("Could not read the file.".to_string()))
}

/// Writes the preview's edited text back to disk. Capped the same as the read
/// side, and only ever called with a path the preview already read — there is
/// no path picker here, so nothing this command touches was not already open.
#[tauri::command]
pub async fn workspace_write_file(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        const CAP: usize = 2 * 1024 * 1024;
        if contents.len() > CAP {
            return Err(format!(
                "That file would be {} MB. The workspace saves files up to 2 MB.",
                contents.len() / 1_000_000
            ));
        }
        std::fs::write(&path, contents).map_err(|e| format!("Could not save the file: {e}"))
    })
    .await
    .unwrap_or_else(|_| Err("Could not save the file.".to_string()))
}

/// Base64, written out here rather than pulled in as a dependency: this is the
/// only place in the app that needs it, and it is twenty lines.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

/// An image file as a `data:` URL, for the same preview.
///
/// A data URL rather than a path because the preview is a page, not the
/// filesystem: nothing in `src/` can point an `<img>` at `C:\…` without the
/// asset protocol being opened up to the whole disk, and a picture small enough
/// to look at is small enough to hand over inline.
#[tauri::command]
pub async fn workspace_read_image(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        const CAP: u64 = 16 * 1024 * 1024;
        let file = Path::new(&path);
        let ext = file
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let mime = match ext.as_str() {
            "png" | "apng" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "avif" => "image/avif",
            "ico" => "image/x-icon",
            "svg" => "image/svg+xml",
            other => return Err(format!("The workspace cannot show a .{other} file.")),
        };
        let meta = std::fs::metadata(file).map_err(|e| format!("Could not open the image: {e}"))?;
        if meta.len() > CAP {
            return Err(format!(
                "That image is {} MB. The workspace shows images up to 16 MB.",
                meta.len() / 1_000_000
            ));
        }
        let bytes = std::fs::read(file).map_err(|e| format!("Could not read the image: {e}"))?;
        Ok(format!("data:{mime};base64,{}", base64(&bytes)))
    })
    .await
    .unwrap_or_else(|_| Err("Could not read the image.".to_string()))
}

/* ------------------------------------------------------- chat attachments */

//  A coding agent is driven here by a prompt on a command line, and a command
//  line carries text. So everything the composer accepts - an image off the
//  clipboard, a file dragged onto the window, a paste too big to read - becomes
//  a *file on disk*, and the prompt carries its path. Every one of these CLIs
//  reads a path it is handed, which is why this needs no per-agent code.
//
//  Files dragged in are already on disk and are used where they lie; only what
//  arrives as bytes is written out, into a folder of the app's own under TEMP
//  that is swept as it is used.

/// One thing attached to the next prompt.
#[derive(Serialize)]
pub struct Attachment {
    pub path: String,
    pub name: String,
    /// `"image"` or `"text"` - all the composer distinguishes, because it is
    /// all that changes how the chip is drawn.
    pub kind: &'static str,
    pub size: u64,
}

/// Images the agents can be pointed at. Anything else has to be text.
const IMAGE_EXTS: &[&str] = &[
    "png", "apng", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico", "svg",
];

const IMAGE_CAP: u64 = 16 * 1024 * 1024;
const TEXT_CAP: u64 = 4 * 1024 * 1024;

/// Where written-out attachments live: one folder under TEMP, swept of
/// anything older than a week every time it is used, so a year of pasted
/// screenshots does not quietly become someone else's problem to find.
fn attachments_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("wint-attachments");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not make room for the attachment: {e}"))?;
    const WEEK: u64 = 7 * 24 * 60 * 60;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let stale = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age.as_secs() > WEEK);
            if stale {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(dir)
}

/// A name that is safe to write and does not tread on a file already there.
fn free_path(dir: &Path, name: &str) -> PathBuf {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || FORBIDDEN.contains(c) { '-' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    let cleaned = if cleaned.is_empty() { "attachment".to_string() } else { cleaned };
    let (stem, ext) = match cleaned.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (cleaned.clone(), String::new()),
    };
    let mut candidate = dir.join(&cleaned);
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    candidate
}

/// The characters Windows will not have in a file name.
const FORBIDDEN: &str = "\\/:*?\"<>|";

/// Which kind of attachment a file on disk is - and whether it is one at all.
///
/// Extension decides for images. Everything else has to prove it is text by
/// not having a NUL byte in its first few kilobytes, the same test the file
/// preview uses: a dropped `.rs`, `.log` or extensionless `Makefile` is worth
/// attaching, a dropped `.exe` is not.
fn attachment_kind(path: &Path) -> Result<&'static str, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if IMAGE_EXTS.contains(&ext.as_str()) {
        return Ok("image");
    }
    let mut head = std::fs::read(path).map_err(|e| format!("Could not read that file: {e}"))?;
    head.truncate(8192);
    if head.contains(&0) {
        return Err("That looks like a binary file, so there is nothing to attach.".into());
    }
    Ok("text")
}

/// A file on disk as the composer's idea of an attachment, or the reason it
/// cannot be one.
fn describe(path: PathBuf) -> Result<Attachment, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("Could not open that file: {e}"))?;
    if meta.is_dir() {
        return Err("A folder cannot be attached - drop the files inside it.".into());
    }
    let kind = attachment_kind(&path)?;
    let cap = if kind == "image" { IMAGE_CAP } else { TEXT_CAP };
    if meta.len() > cap {
        return Err(format!(
            "That file is {} MB. Attachments go up to {} MB.",
            meta.len() / 1_000_000,
            cap / 1_000_000
        ));
    }
    Ok(Attachment {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "attachment".into()),
        path: path.to_string_lossy().into_owned(),
        kind,
        size: meta.len(),
    })
}

/// Vet a file dropped onto the window. Nothing is copied: the file is already
/// somewhere, and the prompt can just as well say where.
#[tauri::command]
pub async fn workspace_attach_path(path: String) -> Result<Attachment, String> {
    tauri::async_runtime::spawn_blocking(move || describe(PathBuf::from(path)))
        .await
        .unwrap_or_else(|_| Err("Could not attach that file.".to_string()))
}

/// Write bytes off the clipboard out as a file and attach that - a pasted
/// screenshot has no path of its own until it is given one.
#[tauri::command]
pub async fn workspace_attach_bytes(name: String, data: String) -> Result<Attachment, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = unbase64(&data).ok_or("That paste could not be decoded.")?;
        if bytes.len() as u64 > IMAGE_CAP {
            return Err(format!(
                "That paste is {} MB. Attachments go up to {} MB.",
                bytes.len() as u64 / 1_000_000,
                IMAGE_CAP / 1_000_000
            ));
        }
        let file = free_path(&attachments_dir()?, &name);
        std::fs::write(&file, &bytes).map_err(|e| format!("Could not save the attachment: {e}"))?;
        describe(file)
    })
    .await
    .unwrap_or_else(|_| Err("Could not save the attachment.".to_string()))
}

/// The same, for a paste too long to sit in the composer: it becomes a text
/// file the agent reads rather than a wall the reader has to scroll past.
#[tauri::command]
pub async fn workspace_attach_text(name: String, text: String) -> Result<Attachment, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if text.len() as u64 > TEXT_CAP {
            return Err(format!(
                "That paste is {} MB. Attachments go up to {} MB.",
                text.len() as u64 / 1_000_000,
                TEXT_CAP / 1_000_000
            ));
        }
        let file = free_path(&attachments_dir()?, &name);
        std::fs::write(&file, text.as_bytes())
            .map_err(|e| format!("Could not save the attachment: {e}"))?;
        describe(file)
    })
    .await
    .unwrap_or_else(|_| Err("Could not save the attachment.".to_string()))
}

/// The other half of [`base64`], for bytes arriving from the webview. Same
/// reasoning as that one: twenty lines beats a dependency.
fn unbase64(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' => continue,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}
