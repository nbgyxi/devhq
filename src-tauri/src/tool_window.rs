//! Popped-out tool windows.
//!
//! Unlike terminals, a tool has no Rust-owned session to attach to — each
//! window mounts its own copy of the tool. These commands only create, focus
//! and destroy the webview that hosts it.

use std::path::{Path, PathBuf};

use tauri::image::Image;
use tauri::{AppHandle, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::off_thread;

fn label_for(id: &str) -> String {
    format!("tool-{id}")
}

fn icons_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("icons")
}

fn load_png_icon(path: &Path) -> Option<Image<'static>> {
    if !path.is_file() {
        return None;
    }
    Image::from_path(path).ok().map(|img| img.to_owned())
}

/// Taskbar icon — always the dark-scheme glyph (teal on transparent).
/// Windows taskbars are usually dark even when the app window is in light mode.
fn taskbar_icon_for_tool(id: &str) -> Option<Image<'static>> {
    let tools = icons_dir().join("tools").join("dark");
    load_png_icon(&tools.join(format!("{id}.png")))
        .or_else(|| load_png_icon(&tools.join("_default.png")))
}

/// Opens a tool in its own undecorated window. Re-focuses an existing one.
/// `theme` is `"light"` or `"dark"` so the native webview colour matches the
/// app before HTML has painted — otherwise light mode flashes black.
#[tauri::command]
pub async fn tool_popout(
    app: AppHandle,
    id: String,
    title: String,
    theme: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    if id.is_empty() || id.chars().any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/' | ':'))) {
        return Err("That tool cannot be opened in its own window.".into());
    }
    let label = label_for(&id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }
    let light = theme.as_deref() == Some("light");
    let page = format!(
        "tool.html?id={}&theme={}",
        urlencoding_lite(&id),
        if light { "light" } else { "dark" }
    );
    let window_title = if title.trim().is_empty() {
        id.clone()
    } else {
        title
    };
    // Match --bg in styles.css so the frame never flashes the wrong scheme.
    let background = if light {
        tauri::webview::Color(244, 245, 248, 255)
    } else {
        tauri::webview::Color(12, 13, 17, 255)
    };
    // Stamp the theme onto <html> before any stylesheet paints — otherwise the
    // bundled dark default shows for a frame even when the opener asked for light.
    let init_theme = format!(
        r#"document.documentElement.dataset.theme="{}";"#,
        if light { "light" } else { "dark" }
    );
    off_thread(move || {
        let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(page.into()))
            .title(window_title)
            .inner_size(960.0, 720.0)
            .min_inner_size(480.0, 320.0)
            .decorations(false)
            // Hidden until tool.html paints theme + chrome, then JS calls show().
            // Otherwise Windows flashes white → conf black → theme grey → content.
            .visible(false)
            .background_color(background)
            .initialization_script(&init_theme);
        if let (Some(x), Some(y)) = (x, y) {
            builder = builder.position(x, y);
        }
        if let Some(icon) = taskbar_icon_for_tool(&id) {
            builder = builder.icon(icon).map_err(|e| format!("Could not set the window icon: {e}"))?;
        }
        builder
            .build()
            .map(|_| ())
            .map_err(|e| format!("Could not open the window: {e}"))
    })
    .await
    .unwrap_or_else(|| Err("Could not open the window.".to_string()))
}

/// Focus an already-open tool window without creating one.
#[tauri::command]
pub async fn tool_focus(app: AppHandle, id: String) -> Result<(), String> {
    let label = label_for(&id);
    off_thread(move || {
        if let Some(window) = app.get_webview_window(&label) {
            window.set_focus().map_err(|e| e.to_string())
        } else {
            Err("That tool is not open in its own window.".into())
        }
    })
    .await
    .unwrap_or_else(|| Err("Could not focus the window.".to_string()))
}

/// Tiny always-on-top drag image while a pin is dragged over the desktop.
#[tauri::command]
pub async fn tool_drag_preview(
    app: AppHandle,
    action: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    off_thread(move || {
        const LABEL: &str = "tool-drag-preview";
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
        WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("tool-drag.html".into()))
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
    .unwrap_or_else(|| Err("Could not show the tool drag preview.".to_string()))
}

/// Destroys the popped-out window when the tool docks back into DevHQ.
#[tauri::command]
pub async fn tool_dock(app: AppHandle, id: String) -> Result<(), String> {
    let label = label_for(&id);
    off_thread(move || {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.destroy();
        }
    })
    .await;
    Ok(())
}

/// Percent-encode a tool id for the query string without pulling in a crate.
fn urlencoding_lite(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Kill every tool pop-out when the main window goes away.
pub fn destroy_all(app: &AppHandle) {
    for (label, child) in app.webview_windows() {
        if label.starts_with("tool-") {
            let _ = child.destroy();
        }
    }
}
