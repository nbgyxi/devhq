//! Popped-out tool windows.
//!
//! Unlike terminals, a tool has no Rust-owned session to attach to — each
//! window mounts its own copy of the tool. These commands only create, focus
//! and destroy the webview that hosts it.

use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tauri::image::Image;
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::off_thread;

const SEARCH_LABEL: &str = "global-search";
const CHANGELOG_LABEL: &str = "version-history";

#[cfg(windows)]
fn foreground_search_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::Input::KeyboardAndMouse::{SetActiveWindow, SetFocus};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
        SetWindowPos, ShowWindow, ShowWindowAsync, SwitchToThisWindow, HWND_TOPMOST, SWP_NOMOVE,
        SWP_NOSIZE, SWP_SHOWWINDOW, SW_RESTORE,
    };

    window.show().map_err(|e| e.to_string())?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    unsafe {
        let current_thread = GetCurrentThreadId();
        let foreground = GetForegroundWindow();
        let foreground_thread = if foreground.0.is_null() {
            0
        } else {
            GetWindowThreadProcessId(foreground, None)
        };
        let target_thread = GetWindowThreadProcessId(hwnd, None);
        let attached_foreground = foreground_thread != 0
            && foreground_thread != current_thread
            && AttachThreadInput(current_thread, foreground_thread, true).as_bool();
        let attached_target = target_thread != 0
            && target_thread != current_thread
            && AttachThreadInput(current_thread, target_thread, true).as_bool();

        let _ = ShowWindow(hwnd, SW_RESTORE);
        let _ = ShowWindowAsync(hwnd, SW_RESTORE);
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        // SetForegroundWindow may be denied when Windows hands a registered
        // hotkey to a background process. This is the native shell-switch path
        // used only for the explicitly configured global Search shortcut.
        SwitchToThisWindow(hwnd, true);
        let _ = SetActiveWindow(hwnd);
        let _ = SetFocus(Some(hwnd));

        if attached_target {
            let _ = AttachThreadInput(current_thread, target_thread, false);
        }
        if attached_foreground {
            let _ = AttachThreadInput(current_thread, foreground_thread, false);
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn focus_search_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    foreground_search_window(window)?;
    window.set_focus().map_err(|e| e.to_string())?;
    let webview: &tauri::Webview = window.as_ref();
    webview.set_focus().map_err(|e| e.to_string())?;
    // WebViewWindow::set_focus targets the outer HWND and Webview::set_focus
    // asks Wry to focus its host. WebView2 still has its own keyboard-focus
    // state; MoveFocus is the controller operation that makes document focus
    // real (and therefore allows text and Escape events into the page).
    window
        .with_webview(|platform| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::
                COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;
            let _ = platform
                .controller()
                .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn focus_search_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    let webview: &tauri::Webview = window.as_ref();
    webview.set_focus().map_err(|e| e.to_string())
}

pub(crate) fn focus_search_from_global(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SEARCH_LABEL) {
        // This runs inside the plugin's native hotkey callback, potentially on
        // Tauri's UI thread. Never call with_webview here: it dispatches to that
        // same thread and can deadlock the entire application.
        #[cfg(windows)]
        let _ = foreground_search_window(&window);
        #[cfg(not(windows))]
        let _ = focus_search_window(&window);
    }
}

/// Create the Search HWND before registering a global shortcut. Windows only
/// grants foreground activation during the native hotkey callback; having the
/// window ready lets that callback focus it synchronously.
#[tauri::command]
pub async fn search_prepare(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window(SEARCH_LABEL).is_some() {
        return Ok(());
    }
    let build_app = app.clone();
    off_thread(move || {
        WebviewWindowBuilder::new(
            &app,
            SEARCH_LABEL,
            WebviewUrl::App("search.html?theme=dark&prepared=1".into()),
        )
        .title("Search DevHQ")
        .inner_size(680.0, 520.0)
        .min_inner_size(520.0, 320.0)
        .decorations(false)
        .transparent(false)
        .resizable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .center()
        .background_color(tauri::webview::Color(12, 13, 17, 255))
        .initialization_script(r#"document.documentElement.dataset.theme="dark";"#)
        .build()
        .map(|_| ())
        .map_err(|e| format!("Could not prepare Search: {e}"))
    })
    .await
    .unwrap_or_else(|| Err("Could not prepare Search.".to_string()))?;
    if build_app.get_webview_window(SEARCH_LABEL).is_none() {
        return Err("Search was prepared without a window.".into());
    }
    Ok(())
}

/// Open the shell-owned command palette in its own native window. It is a
/// sibling of the main window, so it can sit above isolated child webviews
/// without hiding or resizing them.
#[tauri::command]
pub async fn search_show(
    app: AppHandle,
    theme: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SEARCH_LABEL) {
        let light = theme.as_deref() == Some("light");
        window
            .eval(&format!(
                r#"document.documentElement.dataset.theme="{}";"#,
                if light { "light" } else { "dark" }
            ))
            .map_err(|e| e.to_string())?;
        if let (Some(x), Some(y)) = (x, y) {
            window
                .set_position(LogicalPosition::new(x, y))
                .map_err(|e| e.to_string())?;
        } else {
            window.center().map_err(|e| e.to_string())?;
        }
        focus_search_window(&window)?;
        return Ok(());
    }
    let light = theme.as_deref() == Some("light");
    let background = if light {
        tauri::webview::Color(244, 245, 248, 255)
    } else {
        tauri::webview::Color(12, 13, 17, 255)
    };
    let page = format!("search.html?theme={}", if light { "light" } else { "dark" });
    let init_theme = format!(
        r#"document.documentElement.dataset.theme="{}";"#,
        if light { "light" } else { "dark" }
    );
    let build_app = app.clone();
    off_thread(move || {
        let mut builder = WebviewWindowBuilder::new(&app, SEARCH_LABEL, WebviewUrl::App(page.into()))
            .title("Search DevHQ")
            .inner_size(680.0, 520.0)
            .min_inner_size(520.0, 320.0)
            .decorations(false)
            .transparent(false)
            .resizable(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .background_color(background)
            .initialization_script(&init_theme);
        builder = if let (Some(x), Some(y)) = (x, y) {
            builder.position(x, y)
        } else {
            builder.center()
        };
        builder
            .build()
            .map(|_| ())
            .map_err(|e| format!("Could not open Search: {e}"))
    })
    .await
    .unwrap_or_else(|| Err("Could not open Search.".to_string()))?;
    let window = build_app
        .get_webview_window(SEARCH_LABEL)
        .ok_or_else(|| "Search was created without a window.".to_string())?;
    focus_search_window(&window)
}

#[tauri::command]
pub fn search_hide(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SEARCH_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Show release history in a native sibling window so child tool webviews can
/// never cover it.
#[tauri::command]
pub async fn changelog_show(app: AppHandle, theme: Option<String>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(CHANGELOG_LABEL) {
        let light = theme.as_deref() == Some("light");
        window.eval(&format!(
            r#"document.documentElement.dataset.theme="{}";"#,
            if light { "light" } else { "dark" }
        )).map_err(|e| e.to_string())?;
        focus_search_window(&window)?;
        return Ok(());
    }
    let light = theme.as_deref() == Some("light");
    let background = if light { tauri::webview::Color(244, 245, 248, 255) } else { tauri::webview::Color(12, 13, 17, 255) };
    let page = format!("changelog.html?theme={}", if light { "light" } else { "dark" });
    let build_app = app.clone();
    off_thread(move || {
        WebviewWindowBuilder::new(&app, CHANGELOG_LABEL, WebviewUrl::App(page.into()))
            .title("What's new in DevHQ")
            .inner_size(560.0, 680.0)
            .min_inner_size(440.0, 360.0)
            .decorations(false)
            .resizable(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .center()
            .background_color(background)
            .build().map(|_| ()).map_err(|e| format!("Could not open What's new: {e}"))
    }).await.unwrap_or_else(|| Err("Could not open What's new.".to_string()))?;
    let window = build_app.get_webview_window(CHANGELOG_LABEL)
        .ok_or_else(|| "What's new was created without a window.".to_string())?;
    focus_search_window(&window)
}

#[tauri::command]
pub fn changelog_hide(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(CHANGELOG_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn label_for(id: &str) -> String {
    format!("tool-{id}")
}

fn embedded_label_for(id: &str) -> String {
    format!("embedded-tool-{id}")
}

fn bridge_states() -> &'static Mutex<HashMap<String, serde_json::Value>> {
    static STATES: OnceLock<Mutex<HashMap<String, serde_json::Value>>> = OnceLock::new();
    STATES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Renderer-neutral handoff storage. Browser storage belongs to a WebView2
/// environment and therefore cannot cross the isolation boundary.
#[tauri::command]
pub fn tool_bridge_state_put(id: String, state: serde_json::Value) -> Result<(), String> {
    bridge_states().lock().map_err(|_| "Tool state is unavailable.".to_string())?.insert(id, state);
    Ok(())
}

#[tauri::command]
pub fn tool_bridge_state_take(id: String) -> Result<Option<serde_json::Value>, String> {
    Ok(bridge_states().lock().map_err(|_| "Tool state is unavailable.".to_string())?.remove(&id))
}

/// Show one tool inside the main window while keeping its JavaScript in a
/// separate child webview. A blocked tool renderer therefore cannot block the
/// shell renderer. The shell remains responsible for the child's rectangle.
#[tauri::command]
pub async fn tool_embedded_show(
    app: AppHandle,
    id: String,
    session: String,
    theme: Option<String>,
    pinned: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if id.is_empty() || id.chars().any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))) {
        return Err("That tool id cannot be isolated.".into());
    }
    if session.len() < 16 || session.chars().any(|c| !c.is_ascii_alphanumeric()) {
        return Err("That tool session is invalid.".into());
    }
    let label = embedded_label_for(&id);
    let position = LogicalPosition::new(x.max(0.0), y.max(0.0));
    let size = LogicalSize::new(width.max(1.0), height.max(1.0));
    let light = theme.as_deref() == Some("light");
    let background = if light {
        tauri::webview::Color(244, 245, 248, 255)
    } else {
        tauri::webview::Color(12, 13, 17, 255)
    };
    if let Some(webview) = app.get_webview(&label) {
        webview
            .eval(&format!(
                r#"document.documentElement.dataset.theme="{}";"#,
                if light { "light" } else { "dark" }
            ))
            .map_err(|e| e.to_string())?;
        webview
            .set_background_color(Some(background))
            .map_err(|e| e.to_string())?;
        webview.set_position(position).map_err(|e| e.to_string())?;
        webview.set_size(size).map_err(|e| e.to_string())?;
        webview.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "The main window is not available.".to_string())?;
    // A child webview using the main view's WebView2 environment can share its
    // renderer process. A synchronous loop in either view then stalls both.
    // A dedicated data directory creates a distinct WebView2 environment and
    // therefore a real renderer/process boundary for the isolated tool.
    let data_directory = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("isolated-webviews")
        .join(&id);
    let page = format!(
        "tool-embedded.html?id={}&theme={}&pinned={}&session={}",
        urlencoding_lite(&id),
        if light { "light" } else { "dark" },
        if pinned { "1" } else { "0" },
        urlencoding_lite(&session)
    );
    let init_theme = format!(
        r#"document.documentElement.dataset.theme="{}";"#,
        if light { "light" } else { "dark" }
    );
    let builder = WebviewBuilder::new(&label, WebviewUrl::App(page.into()))
        .data_directory(data_directory)
        .initialization_script(&init_theme)
        .background_color(background);
    window
        .add_child(builder, position, size)
        .map(|_| ())
        .map_err(|e| format!("Could not create the isolated tool: {e}"))
}

#[tauri::command]
pub fn tool_embedded_hide(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&embedded_label_for(&id)) {
        webview.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Destroy an isolated renderer without asking its JavaScript to cooperate.
/// Its WebView2 data directory remains, so persistent tool data survives.
#[tauri::command]
pub fn tool_embedded_destroy(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&embedded_label_for(&id)) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
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
    if id.is_empty()
        || id
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/' | ':')))
    {
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
            builder = builder
                .icon(icon)
                .map_err(|e| format!("Could not set the window icon: {e}"))?;
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
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
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
