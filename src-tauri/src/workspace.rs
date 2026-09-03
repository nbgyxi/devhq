//! The workspace: one window per project, holding everything that project needs
//! at once — its files, its git history, a terminal, an AI chat and a browser
//! pointed at whatever the terminal just started serving.
//!
//! Almost nothing here is new machinery. The terminals are the same
//! Rust-owned sessions [`crate::term`] hands out, so a dev server keeps running
//! while its pane is moved or the window is closed and reopened; the AI chat is
//! a terminal on the `claude` profile; and the browser is a child webview
//! positioned over a hole in the page, the same trick embedded tools already
//! use in [`crate::tool_window`].
//!
//! What is new is the layout: five named slots the front end assigns panels to,
//! and the bounds bookkeeping that keeps the browser webview sitting exactly
//! where its slot is. A child webview floats above the page and cannot be
//! occluded by it, which is why the front end also gets to hide it outright -
//! during a drag, or when its slot is collapsed.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

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
) -> Result<String, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err("That folder no longer exists.".into());
    }
    let label = window_label(&path);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(label);
    }
    let title = name.unwrap_or_else(|| {
        dir.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone())
    });
    let page = format!(
        "workspace.html?path={}&name={}",
        urlencode(&path),
        urlencode(&title)
    );
    let opened = label.clone();
    // Building a webview pumps the event loop, so it cannot happen on the
    // thread that owns it - the window would appear with a webview that never
    // loads, and this command would never answer.
    off_thread(move || {
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(page.into()))
            .title(format!("{title} — workspace"))
            .inner_size(1440.0, 900.0)
            .min_inner_size(760.0, 480.0)
            .decorations(false)
            .background_color(tauri::webview::Color(12, 13, 17, 255))
            .build()
            .map(|window| {
                let _ = window.set_focus();
            })
            .map_err(|e| format!("Could not open the workspace: {e}"))
    })
    .await
    .unwrap_or_else(|| Err("Could not open the workspace.".to_string()))?;
    Ok(opened)
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
    off_thread(move || {
        host.add_child(
            WebviewBuilder::new(&label, WebviewUrl::External(target)),
            position,
            size,
        )
        .map(|_| ())
        .map_err(|e| format!("Could not open the browser panel: {e}"))
    })
    .await
    .unwrap_or_else(|| Err("Could not open the browser panel.".to_string()))
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
