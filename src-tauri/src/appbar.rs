//! The docked sidebar.
//!
//! A shell AppBar: the same Windows API Explorer's own taskbar uses. Docking
//! with `SHAppBarMessage` is what makes this more than a topmost window —
//! Windows shrinks the work area, so maximizing an application stops at the
//! sidebar instead of disappearing under it.
//!
//! Every call here is a handful of user32/shell32 messages, which is why they
//! are allowed on the main thread: they cost microseconds and none of them
//! touch the disk, the network or another process. The one expensive step,
//! building the webview, goes off-thread like every other window in the app.
//!
//! Two things must always be undone, or they outlive the process and leave a
//! broken desktop behind until the user logs out: the reserved work area
//! (`ABM_REMOVE`) and the taskbar's auto-hide state. `undock` does both, and
//! `teardown` is called from every path that ends the app.

use std::ffi::c_void;
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Shell::{
    DefSubclassProc, RemoveWindowSubclass, SHAppBarMessage, SetWindowSubclass, ABE_LEFT, ABE_RIGHT,
    ABM_GETSTATE, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS, ABM_SETSTATE,
    ABM_WINDOWPOSCHANGED, ABN_FULLSCREENAPP, ABN_POSCHANGED, ABN_STATECHANGE, ABN_WINDOWARRANGE,
    ABS_ALWAYSONTOP, ABS_AUTOHIDE, APPBARDATA,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongW, SetWindowPos, GWL_EXSTYLE, HWND_BOTTOM, HWND_TOPMOST, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WM_APP, WM_DESTROY, WM_DISPLAYCHANGE, WM_DPICHANGED,
    WM_WINDOWPOSCHANGED, WS_EX_TOPMOST,
};

use crate::off_thread;

pub(crate) const SIDEBAR_LABEL: &str = "sidebar";

/// The private message the shell posts our appbar notifications to. It only
/// has to be unique within this window, and the window is ours alone.
const APPBAR_CALLBACK: u32 = WM_APP + 0x40;
const SUBCLASS_ID: usize = 0x5744;

/// Width in device-independent pixels, before the monitor's scaling.
const MIN_WIDTH: u32 = 48;
const MAX_WIDTH: u32 = 480;
const DEFAULT_WIDTH: u32 = 200;

/// The docked window, or 0 when nothing is docked. This is the single source
/// of truth for "are we an appbar right now", because the appbar registration
/// lives in the shell, not in this process.
static HOST: AtomicIsize = AtomicIsize::new(0);
static EDGE: AtomicU32 = AtomicU32::new(ABE_LEFT);
static WIDTH: AtomicU32 = AtomicU32::new(DEFAULT_WIDTH);
/// The taskbar's auto-hide state as we found it, so undocking can put it back.
/// `u32::MAX` means we have not touched it.
static TASKBAR_WAS: AtomicU32 = AtomicU32::new(u32::MAX);

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SidebarState {
    pub docked: bool,
    pub edge: String,
    pub width: u32,
    /// True while the real taskbar is auto-hidden, whoever set it that way.
    pub taskbar_auto_hidden: bool,
}

fn state() -> SidebarState {
    SidebarState {
        docked: HOST.load(Ordering::SeqCst) != 0,
        edge: if EDGE.load(Ordering::SeqCst) == ABE_RIGHT {
            "right".into()
        } else {
            "left".into()
        },
        width: WIDTH.load(Ordering::SeqCst),
        // Read from the shell, not from what we remember doing: a taskbar the
        // user (or a crashed run) had already set to auto-hide is hidden too.
        taskbar_auto_hidden: unsafe { taskbar_state() } & ABS_AUTOHIDE != 0,
    }
}

fn appbar_data(hwnd: HWND) -> APPBARDATA {
    APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        hWnd: hwnd,
        uCallbackMessage: APPBAR_CALLBACK,
        ..Default::default()
    }
}

/// Claim the edge and move the window onto it.
///
/// `ABM_QUERYPOS` lets the shell push us aside for appbars that were there
/// first; it is allowed to move the rectangle along the docking axis, so the
/// thickness is reapplied afterwards before `ABM_SETPOS` makes it final.
unsafe fn place(hwnd: HWND) {
    let edge = EDGE.load(Ordering::SeqCst);
    let dpi = match GetDpiForWindow(hwnd) {
        0 => 96,
        dpi => dpi,
    };
    let thickness = (WIDTH.load(Ordering::SeqCst) * dpi / 96) as i32;

    let mut monitor = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY), &mut monitor).as_bool() {
        return;
    }
    let screen = monitor.rcMonitor;

    let mut data = appbar_data(hwnd);
    data.uEdge = edge;
    data.rc = if edge == ABE_RIGHT {
        RECT {
            left: screen.right - thickness,
            top: screen.top,
            right: screen.right,
            bottom: screen.bottom,
        }
    } else {
        RECT {
            left: screen.left,
            top: screen.top,
            right: screen.left + thickness,
            bottom: screen.bottom,
        }
    };
    SHAppBarMessage(ABM_QUERYPOS, &mut data);
    if edge == ABE_RIGHT {
        data.rc.left = data.rc.right - thickness;
    } else {
        data.rc.right = data.rc.left + thickness;
    }
    SHAppBarMessage(ABM_SETPOS, &mut data);

    let rc = data.rc;
    // Asking for HWND_TOPMOST again does not just keep the rail topmost, it
    // raises it to the front of the topmost band — over the rail's own popup
    // menus, which are topmost windows too. The shell sends these
    // notifications every few seconds, so a menu would sink behind the bar
    // while it was still open. The z-order only needs setting when the window
    // is not topmost already.
    let topmost = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST.0 != 0;
    let _ = SetWindowPos(
        hwnd,
        if topmost { None } else { Some(HWND_TOPMOST) },
        rc.left,
        rc.top,
        rc.right - rc.left,
        rc.bottom - rc.top,
        if topmost { SWP_NOACTIVATE | SWP_NOZORDER } else { SWP_NOACTIVATE },
    );
}

/// Read the real taskbar's auto-hide / always-on-top state.
unsafe fn taskbar_state() -> u32 {
    let mut data = APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        ..Default::default()
    };
    SHAppBarMessage(ABM_GETSTATE, &mut data) as u32
}

unsafe fn set_taskbar_state(value: u32) {
    let mut data = APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        lParam: LPARAM(value as isize),
        ..Default::default()
    };
    SHAppBarMessage(ABM_SETSTATE, &mut data);
}

/// Ask the real taskbar to auto-hide, remembering what it was so undocking can
/// put it back. A taskbar that is already auto-hidden is left alone.
unsafe fn auto_hide_taskbar() {
    let now = taskbar_state();
    if now & ABS_AUTOHIDE != 0 {
        return;
    }
    remember_original(now);
    set_taskbar_state(now | ABS_AUTOHIDE | ABS_ALWAYSONTOP);
}

/// Bring the real taskbar back now, even if it was auto-hidden before we came
/// along. What it was is remembered, so undocking still puts it back.
unsafe fn show_taskbar() {
    let now = taskbar_state();
    if now & ABS_AUTOHIDE == 0 {
        return;
    }
    remember_original(now);
    set_taskbar_state(now & !ABS_AUTOHIDE);
}

/// The first change we make records the user's own state; later ones keep it.
fn remember_original(now: u32) {
    if TASKBAR_WAS
        .compare_exchange(u32::MAX, now, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        remember_taskbar(Some(now));
    }
}

unsafe fn restore_taskbar() {
    let was = TASKBAR_WAS.swap(u32::MAX, Ordering::SeqCst);
    if was != u32::MAX {
        set_taskbar_state(was);
        remember_taskbar(None);
    }
}

/// Where the taskbar's original state is written down while we have it hidden.
/// Memory alone is not enough: a crash, a kill from Task Manager or a dev
/// rebuild ends the process without undocking, the taskbar stays auto-hidden,
/// and the next dock would take that for the user's own choice and never undo
/// it. With the note on disk, the next start puts the taskbar back.
fn taskbar_note() -> Option<std::path::PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(
        std::path::PathBuf::from(local)
            .join("WinT")
            .join("runtime")
            .join("sidebar-taskbar"),
    )
}

/// Write or clear the note. Called from the window thread, so the file work is
/// handed to a thread of its own.
fn remember_taskbar(was: Option<u32>) {
    std::thread::spawn(move || {
        let Some(note) = taskbar_note() else { return };
        match was {
            Some(was) => {
                if let Some(dir) = note.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(&note, was.to_string());
            }
            None => {
                let _ = std::fs::remove_file(&note);
            }
        }
    });
}

/// Run once at startup, off the main thread: if a previous run hid the taskbar
/// and never got to put it back, put it back now.
pub(crate) fn recover_taskbar() {
    let Some(note) = taskbar_note() else { return };
    let Ok(text) = std::fs::read_to_string(&note) else { return };
    if let Ok(was) = text.trim().parse::<u32>() {
        if HOST.load(Ordering::SeqCst) == 0 && TASKBAR_WAS.load(Ordering::SeqCst) == u32::MAX {
            unsafe { set_taskbar_state(was) };
        }
    }
    let _ = std::fs::remove_file(&note);
}

/// Where the last edge and width are kept, so a dock at startup comes back
/// where the user left it.
fn geometry_file() -> Option<std::path::PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(std::path::PathBuf::from(local).join("WinT").join("sidebar-dock.json"))
}

fn remember_geometry(edge: String, width: u32) {
    std::thread::spawn(move || {
        let Some(file) = geometry_file() else { return };
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&file, serde_json::json!({ "edge": edge, "width": width }).to_string());
    });
}

/// Run once at startup, off the main thread: put back the last edge and width,
/// and dock straight away when "Dock when WinT starts" is on. The taskbar is
/// recovered first, so a run that died with it hidden is not mistaken for the
/// user's own choice.
pub(crate) fn dock_at_start(app: AppHandle) {
    std::thread::spawn(move || {
        recover_taskbar();
        if let Some(saved) = geometry_file()
            .and_then(|file| std::fs::read_to_string(file).ok())
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        {
            apply(
                saved["edge"].as_str().map(str::to_string),
                saved["width"].as_u64().map(|width| width as u32),
            );
        }
        let settings = load_settings();
        if settings["dockOnStart"].as_bool() != Some(true) {
            return;
        }
        let hide = settings["hideTaskbar"].as_bool().unwrap_or(true);
        let _ = tauri::async_runtime::block_on(sidebar_open(app, None, None, Some(hide)));
    });
}

/// Open the Start menu, exactly as pressing the Windows key does.
#[tauri::command]
pub async fn sidebar_start_menu() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_LWIN,
    };
    let key = |flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_LWIN,
                dwFlags: flags,
                ..Default::default()
            },
        },
    };
    let inputs = [key(Default::default()), key(KEYEVENTF_KEYUP)];
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

/// Open the notification area's "Show hidden icons" flyout. Win+B puts the
/// keyboard focus on that chevron, and Enter opens it - the same keys a user
/// would press. The shell needs a moment to move focus before Enter lands, so
/// this runs on a thread of its own rather than holding the caller.
#[tauri::command]
pub async fn sidebar_hidden_icons() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
        VK_B, VK_LWIN, VK_RETURN,
    };
    let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() },
                ..Default::default()
            },
        },
    };
    std::thread::spawn(move || unsafe {
        let focus = [key(VK_LWIN, false), key(VK_B, false), key(VK_B, true), key(VK_LWIN, true)];
        SendInput(&focus, std::mem::size_of::<INPUT>() as i32);
        std::thread::sleep(std::time::Duration::from_millis(150));
        let open = [key(VK_RETURN, false), key(VK_RETURN, true)];
        SendInput(&open, std::mem::size_of::<INPUT>() as i32);
    });
}

/// Everything the shell tells an appbar about, and nothing else. This runs on
/// the thread that draws the window, so it may only send messages — never do
/// work, never call back into the webview.
unsafe extern "system" fn sidebar_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    match msg {
        APPBAR_CALLBACK => {
            match wparam.0 as u32 {
                // Another appbar appeared, moved or resized: re-claim our edge.
                ABN_POSCHANGED | ABN_WINDOWARRANGE | ABN_STATECHANGE => place(hwnd),
                // A game or a video went fullscreen. Staying topmost would draw
                // this bar over it, so drop to the bottom until it comes back.
                ABN_FULLSCREENAPP => {
                    let insert_after = if lparam.0 == 0 { HWND_TOPMOST } else { HWND_BOTTOM };
                    let _ = SetWindowPos(
                        hwnd,
                        Some(insert_after),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
                _ => {}
            }
            return LRESULT(0);
        }
        // A monitor was added, removed, rescaled or re-resolutioned; the edge
        // we are docked to has moved underneath us.
        WM_DISPLAYCHANGE | WM_DPICHANGED => place(hwnd),
        WM_WINDOWPOSCHANGED => {
            let mut data = appbar_data(hwnd);
            SHAppBarMessage(ABM_WINDOWPOSCHANGED, &mut data);
        }
        // The window is going away without anyone calling `sidebar_close` —
        // the app is exiting, or the webview died. Give the work area back.
        WM_DESTROY => undock(hwnd),
        _ => {}
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

unsafe fn undock(hwnd: HWND) {
    if HOST.swap(0, Ordering::SeqCst) == 0 {
        return;
    }
    let mut data = appbar_data(hwnd);
    SHAppBarMessage(ABM_REMOVE, &mut data);
    let _ = RemoveWindowSubclass(hwnd, Some(sidebar_proc), SUBCLASS_ID);
    restore_taskbar();
}

/// Register as an appbar (once) and take the edge. Must run on the main thread:
/// the subclass belongs to the thread that owns the window.
unsafe fn dock(hwnd: HWND, hide_taskbar: bool) {
    let raw = hwnd.0 as isize;
    if HOST.swap(raw, Ordering::SeqCst) != raw {
        let mut data = appbar_data(hwnd);
        SHAppBarMessage(ABM_NEW, &mut data);
        let _ = SetWindowSubclass(hwnd, Some(sidebar_proc), SUBCLASS_ID, 0);
    }
    if hide_taskbar {
        auto_hide_taskbar();
    } else {
        restore_taskbar();
    }
    place(hwnd);
}

/// Called from the main thread while the app is shutting down. Anything left
/// registered here would keep the work area shrunk until the user logs out.
pub(crate) fn teardown() {
    let raw = HOST.load(Ordering::SeqCst);
    unsafe {
        if raw != 0 {
            undock(HWND(raw as *mut c_void));
        }
        restore_taskbar();
    }
}

/// Run `work` on the thread that owns the window, with the window's handle,
/// and wait until it has run. `run_on_main_thread` only posts the work: a
/// command that answered straight after it would report the state from before
/// the dock or undock, which is why the tool page used to need two presses.
/// The wait happens off the async runtime. `HWND` is a raw pointer and not
/// `Send`, so it travels as an integer.
async fn on_window_thread<F>(app: &AppHandle, raw: isize, work: F) -> Result<(), String>
where
    F: FnOnce(HWND) + Send + 'static,
{
    let (done, finished) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        work(HWND(raw as *mut c_void));
        let _ = done.send(());
    })
    .map_err(|e| e.to_string())?;
    off_thread(move || finished.recv().is_ok())
        .await
        .filter(|ran| *ran)
        .map(|_| ())
        .ok_or_else(|| "The window thread did not answer.".to_string())
}

fn apply(edge: Option<String>, width: Option<u32>) {
    if let Some(edge) = edge {
        EDGE.store(
            if edge == "right" { ABE_RIGHT } else { ABE_LEFT },
            Ordering::SeqCst,
        );
    }
    if let Some(width) = width {
        WIDTH.store(width.clamp(MIN_WIDTH, MAX_WIDTH), Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn sidebar_state() -> SidebarState {
    state()
}

/// Dock the sidebar to a screen edge, building its window the first time.
#[tauri::command]
pub async fn sidebar_open(
    app: AppHandle,
    edge: Option<String>,
    width: Option<u32>,
    hide_taskbar: Option<bool>,
) -> Result<SidebarState, String> {
    apply(edge, width);
    let hide_taskbar = hide_taskbar.unwrap_or(true);

    let window = match app.get_webview_window(SIDEBAR_LABEL) {
        Some(window) => window,
        None => {
            let build = app.clone();
            off_thread(move || {
                WebviewWindowBuilder::new(
                    &build,
                    SIDEBAR_LABEL,
                    WebviewUrl::App("sidebar.html".into()),
                )
                .title("WinT Sidebar")
                .inner_size(f64::from(WIDTH.load(Ordering::SeqCst)), 720.0)
                .decorations(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .shadow(false)
                .background_color(tauri::webview::Color(12, 13, 17, 255))
                .build()
                .map(|_| ())
                .map_err(|e| format!("Could not open the sidebar: {e}"))
            })
            .await
            .unwrap_or_else(|| Err("Could not open the sidebar.".into()))?;
            app.get_webview_window(SIDEBAR_LABEL)
                .ok_or_else(|| "The sidebar was built without a window.".to_string())?
        }
    };

    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    // Dock before showing: a window that appears centred and then jumps to the
    // edge is the flash this ordering exists to avoid.
    on_window_thread(&app, hwnd, move |hwnd| unsafe { dock(hwnd, hide_taskbar) }).await?;
    window.show().map_err(|e| e.to_string())?;
    Ok(changed(&app))
}

/// Change the edge, the width or the taskbar setting of a sidebar that is
/// already docked. `hide_taskbar` hides the real taskbar, or puts it back the
/// way it was, straight away.
#[tauri::command]
pub async fn sidebar_configure(
    app: AppHandle,
    edge: Option<String>,
    width: Option<u32>,
    hide_taskbar: Option<bool>,
) -> Result<SidebarState, String> {
    apply(edge, width);
    if let Some(window) = app.get_webview_window(SIDEBAR_LABEL) {
        if HOST.load(Ordering::SeqCst) != 0 {
            let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
            on_window_thread(&app, hwnd, move |hwnd| unsafe {
                match hide_taskbar {
                    Some(true) => auto_hide_taskbar(),
                    Some(false) => show_taskbar(),
                    None => {}
                }
                place(hwnd)
            })
            .await?;
        }
    }
    Ok(changed(&app))
}

/// Give the work area back, put the taskbar the way we found it, and close the
/// window. The window is destroyed rather than hidden so nothing is left
/// holding an edge the shell still believes in.
#[tauri::command]
pub async fn sidebar_close(app: AppHandle) -> Result<SidebarState, String> {
    if let Some(window) = app.get_webview_window(SIDEBAR_LABEL) {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        on_window_thread(&app, hwnd, |hwnd| unsafe { undock(hwnd) }).await?;
        let _ = window.destroy();
    } else {
        teardown();
    }
    Ok(changed(&app))
}

/// Tell every page what the sidebar looks like now. The rail and the Docked
/// Sidebar tool page can each change it, and each must follow what the other
/// did without asking.
fn changed(app: &AppHandle) -> SidebarState {
    use tauri::Emitter;
    let now = state();
    remember_geometry(now.edge.clone(), now.width);
    let _ = app.emit("sidebar:state", now.clone());
    now
}

/// Bring a window to the front from a click on the rail, and report whether
/// Windows let it. `SetForegroundWindow` is refused unless the caller's input
/// queue is the one Windows considers active, so ours is briefly attached to
/// the current foreground window's — the same step Search's global shortcut
/// takes. `SwitchToThisWindow` is the last resort.
unsafe fn bring_forward(hwnd: HWND) -> bool {
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, IsIconic,
        SetForegroundWindow, ShowWindow, SwitchToThisWindow, SW_RESTORE, SW_SHOW,
    };
    let _ = ShowWindow(hwnd, if IsIconic(hwnd).as_bool() { SW_RESTORE } else { SW_SHOW });
    let current = GetCurrentThreadId();
    let foreground = GetForegroundWindow();
    let foreground_thread = if foreground.0.is_null() {
        0
    } else {
        GetWindowThreadProcessId(foreground, None)
    };
    let attached = foreground_thread != 0
        && foreground_thread != current
        && AttachThreadInput(current, foreground_thread, true).as_bool();
    let _ = BringWindowToTop(hwnd);
    let mut done = SetForegroundWindow(hwnd).as_bool();
    if attached {
        let _ = AttachThreadInput(current, foreground_thread, false);
    }
    if !done {
        SwitchToThisWindow(hwnd, true);
        done = GetForegroundWindow() == hwnd;
    }
    done
}

/// The last window other than the sidebar that had the foreground. Clicking
/// the rail activates the sidebar itself, so "is this the active window?" has
/// to be answered from before the click — which is what lets a second click
/// on the active window minimize it, the way the taskbar does.
static LAST_FOREGROUND: AtomicIsize = AtomicIsize::new(0);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenWindow {
    /// The HWND as a string: JS numbers cannot hold every pointer exactly.
    pub id: String,
    pub title: String,
    /// Full path of the owning executable, empty when access is denied.
    pub exe: String,
    /// What the window is, stable across runs: the AppUserModelID Windows
    /// groups taskbar buttons by (one per Edge or Chrome profile, one per
    /// installed web app), or the exe when the window sets none.
    pub app: String,
    pub active: bool,
    pub minimized: bool,
}

/// Is this a window the taskbar would show a button for? These are the shell's
/// own rules: visible, not cloaked (a window on another virtual desktop or a
/// suspended UWP app), titled, and either unowned and not a tool window, or
/// explicitly asking for a button with `WS_EX_APPWINDOW`.
unsafe fn is_taskbar_window(hwnd: HWND) -> bool {
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindow, GetWindowLongW, GetWindowTextLengthW, IsWindowVisible, GWL_EXSTYLE, GW_OWNER,
        WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };
    if !IsWindowVisible(hwnd).as_bool() || GetWindowTextLengthW(hwnd) == 0 {
        return false;
    }
    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    let app_window = ex & WS_EX_APPWINDOW.0 != 0;
    if !app_window {
        if ex & WS_EX_TOOLWINDOW.0 != 0 {
            return false;
        }
        if GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.0.is_null()) {
            return false;
        }
    }
    let mut cloaked = 0u32;
    let _ = DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        std::ptr::addr_of_mut!(cloaked).cast(),
        std::mem::size_of::<u32>() as u32,
    );
    cloaked == 0
}

unsafe fn window_exe(hwnd: HWND) -> String {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
        return String::new();
    };
    let mut buffer = [0u16; 1024];
    let mut len = buffer.len() as u32;
    let ok = QueryFullProcessImageNameW(
        process,
        PROCESS_NAME_WIN32,
        PWSTR(buffer.as_mut_ptr()),
        &mut len,
    )
    .is_ok();
    let _ = CloseHandle(process);
    if ok {
        String::from_utf16_lossy(&buffer[..len as usize])
    } else {
        String::new()
    }
}

pub(crate) fn list_windows(sidebar: isize) -> Vec<OpenWindow> {
    use windows::core::BOOL;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetForegroundWindow, GetWindowTextW, IsIconic,
    };

    unsafe extern "system" fn collect(hwnd: HWND, found: LPARAM) -> BOOL {
        let found = &mut *(found.0 as *mut Vec<isize>);
        if is_taskbar_window(hwnd) {
            found.push(hwnd.0 as isize);
        }
        true.into()
    }

    // Reading a window's AppUserModelID goes through a COM property store.
    // The blocking pool's threads may already be in an apartment; a second
    // init is harmless and a failed one only costs us the IDs.
    let _apartment = crate::com::Apartment::multi_threaded();
    let mut handles: Vec<isize> = Vec::new();
    unsafe {
        let foreground = GetForegroundWindow().0 as isize;
        if foreground != 0 && foreground != sidebar {
            LAST_FOREGROUND.store(foreground, Ordering::SeqCst);
        }
        let _ = EnumWindows(Some(collect), LPARAM(std::ptr::addr_of_mut!(handles) as isize));
    }
    let active = LAST_FOREGROUND.load(Ordering::SeqCst);
    handles
        .into_iter()
        .filter(|&raw| raw != sidebar)
        .map(|raw| unsafe {
            let hwnd = HWND(raw as *mut c_void);
            let mut title = [0u16; 512];
            let len = GetWindowTextW(hwnd, &mut title).max(0) as usize;
            let exe = window_exe(app_window(hwnd));
            OpenWindow {
                id: raw.to_string(),
                title: String::from_utf16_lossy(&title[..len]),
                exe: exe.clone(),
                app: app_id(hwnd).unwrap_or(exe),
                active: raw == active,
                minimized: IsIconic(hwnd).as_bool(),
            }
        })
        .collect()
}

pub(crate) fn sidebar_window_handle(app: &AppHandle) -> isize {
    sidebar_hwnd(app)
}

/// The docked sidebar's handle, or 0, for code with no `AppHandle` to hand.
pub(crate) fn docked_handle() -> isize {
    HOST.load(Ordering::SeqCst)
}

/// A window's title and the path of the program behind it, whether or not it
/// is visible.
pub(crate) unsafe fn window_title_and_exe(hwnd: HWND) -> (String, String) {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowTextW;
    let mut title = [0u16; 512];
    let len = GetWindowTextW(hwnd, &mut title).max(0) as usize;
    (String::from_utf16_lossy(&title[..len]), window_exe(app_window(hwnd)))
}

fn sidebar_hwnd(app: &AppHandle) -> isize {
    app.get_webview_window(SIDEBAR_LABEL)
        .and_then(|window| window.hwnd().ok())
        .map_or(0, |hwnd| hwnd.0 as isize)
}

/// Every window the taskbar would show, in Z-order (the most recently used
/// first). Cheap, but it opens a process handle per window, so off-thread.
#[tauri::command]
pub async fn sidebar_windows(app: AppHandle) -> Vec<OpenWindow> {
    let sidebar = sidebar_hwnd(&app);
    off_thread(move || list_windows(sidebar)).await.unwrap_or_default()
}

/// Bring a window forward, restoring it if minimized, or minimize it when it
/// was already the active one — the taskbar's own click behaviour.
#[tauri::command]
pub async fn sidebar_activate(id: String) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        IsIconic, IsWindow, ShowWindow, SW_MINIMIZE,
    };
    let raw: isize = id.parse().map_err(|_| "Not a window.".to_string())?;
    off_thread(move || unsafe {
        let hwnd = HWND(raw as *mut c_void);
        if !IsWindow(Some(hwnd)).as_bool() {
            return Err("That window has closed.".to_string());
        }
        if !IsIconic(hwnd).as_bool() && LAST_FOREGROUND.load(Ordering::SeqCst) == raw {
            let _ = ShowWindow(hwnd, SW_MINIMIZE);
            LAST_FOREGROUND.store(0, Ordering::SeqCst);
            return Ok(());
        }
        bring_forward(hwnd);
        LAST_FOREGROUND.store(raw, Ordering::SeqCst);
        Ok(())
    })
    .await
    .unwrap_or_else(|| Err("Could not switch windows.".into()))
}

/// A Store app's top-level window belongs to `ApplicationFrameHost.exe`; the
/// app itself lives in a `CoreWindow` child owned by another process. Answer
/// with that child when there is one, so the icon and exe are the app's.
unsafe fn app_window(hwnd: HWND) -> HWND {
    use windows::core::BOOL;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GetClassNameW, GetWindowThreadProcessId,
    };
    unsafe extern "system" fn find(child: HWND, found: LPARAM) -> BOOL {
        let found = &mut *(found.0 as *mut (u32, isize));
        let mut class = [0u16; 64];
        let len = GetClassNameW(child, &mut class).max(0) as usize;
        let mut pid = 0u32;
        GetWindowThreadProcessId(child, Some(&mut pid));
        if String::from_utf16_lossy(&class[..len]) == "Windows.UI.Core.CoreWindow" && pid != found.0 {
            found.1 = child.0 as isize;
            return false.into();
        }
        true.into()
    }
    let mut frame_pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut frame_pid));
    let mut found = (frame_pid, 0isize);
    let _ = EnumChildWindows(Some(hwnd), Some(find), LPARAM(std::ptr::addr_of_mut!(found) as isize));
    if found.1 != 0 {
        HWND(found.1 as *mut c_void)
    } else {
        hwnd
    }
}

/// The icon the window itself shows in its title bar and taskbar button —
/// not its exe's, which is wrong for browsers' PWAs, Explorer folders, every
/// app hosted by another process, and any window that sets its own icon.
unsafe fn window_icon(hwnd: HWND) -> Option<windows::Win32::UI::WindowsAndMessaging::HICON> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassLongPtrW, SendMessageTimeoutW, GCLP_HICON, GCLP_HICONSM, HICON, ICON_BIG,
        ICON_SMALL, ICON_SMALL2, SMTO_ABORTIFHUNG, SMTO_BLOCK, WM_GETICON,
    };
    // A hung window must not hang the list: ask briefly and give up.
    for kind in [ICON_BIG, ICON_SMALL2, ICON_SMALL] {
        let mut result = 0usize;
        let ok = SendMessageTimeoutW(
            hwnd,
            WM_GETICON,
            WPARAM(kind as usize),
            LPARAM(0),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            100,
            Some(&mut result),
        );
        if ok.0 != 0 && result != 0 {
            return Some(HICON(result as *mut c_void));
        }
    }
    for index in [GCLP_HICON, GCLP_HICONSM] {
        let icon = GetClassLongPtrW(hwnd, index);
        if icon != 0 {
            return Some(HICON(icon as *mut c_void));
        }
    }
    None
}

/// Draw an icon into a 32-bit buffer and encode it. `DrawIconEx` handles every
/// icon format, old masked ones included, which reading the bitmaps does not.
pub(crate) unsafe fn icon_to_data_url(icon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<String> {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, DIB_RGB_COLORS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DrawIconEx, DI_NORMAL};
    const SIZE: i32 = 32;
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: SIZE,
            biHeight: -SIZE,
            biPlanes: 1,
            biBitCount: 32,
            ..Default::default()
        },
        ..Default::default()
    };
    let dc = CreateCompatibleDC(None);
    let mut bits: *mut c_void = std::ptr::null_mut();
    let Ok(bitmap) = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) else {
        let _ = DeleteDC(dc);
        return None;
    };
    let old = SelectObject(dc, bitmap.into());
    let drawn = DrawIconEx(dc, 0, 0, icon, SIZE, SIZE, 0, None, DI_NORMAL).is_ok();
    let mut pixels = std::slice::from_raw_parts(bits as *const u8, (SIZE * SIZE * 4) as usize).to_vec();
    SelectObject(dc, old);
    let _ = DeleteObject(bitmap.into());
    let _ = DeleteDC(dc);
    if !drawn {
        return None;
    }
    // BGRA to RGBA. An icon with no alpha channel draws with every alpha byte
    // zero; its opaque pixels are then the ones that are not black.
    let blank_alpha = pixels.iter().skip(3).step_by(4).all(|&alpha| alpha == 0);
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        if blank_alpha && (pixel[0] | pixel[1] | pixel[2]) != 0 {
            pixel[3] = 255;
        }
    }
    crate::explorer::rgba_to_data_url(SIZE as u32, SIZE as u32, &pixels).ok().flatten()
}

/// The program behind a window, whatever kind of window it is: the owner is
/// followed first, so a tool window or a dialog answers with its application.
pub(crate) unsafe fn window_program(hwnd: HWND) -> String {
    window_exe(app_window(hwnd))
}

/// The icon a program file carries.
///
/// `explorer::thumbnail` cannot answer this and is not meant to: it asks the
/// shell for a real extracted picture and refuses the generic type icon, which
/// for a program is the only thing there is. This reads the icon resource out
/// of the file instead, which is what Explorer draws for an exe.
pub(crate) fn program_icon(exe: &str) -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::ExtractIconExW;
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, HICON};
    if exe.is_empty() {
        return None;
    }
    let path = HSTRING::from(exe);
    let mut large = HICON::default();
    unsafe {
        if ExtractIconExW(&path, 0, Some(&mut large), None, 1) == 0 || large.is_invalid() {
            return None;
        }
        let url = icon_to_data_url(large);
        let _ = DestroyIcon(large);
        url
    }
}

/// The icon for one window's button: its own icon when it has one, else the
/// icon of the program behind it.
#[tauri::command]
pub async fn sidebar_window_icon(id: String) -> Option<String> {
    let raw: isize = id.parse().ok()?;
    off_thread(move || unsafe {
        let hwnd = HWND(raw as *mut c_void);
        let app = app_window(hwnd);
        if app == hwnd {
            if let Some(url) = window_icon(hwnd).and_then(|icon| icon_to_data_url(icon)) {
                return Some(url);
            }
        }
        // The program's own icon, not a thumbnail of it: the shell's thumbnail
        // call refuses the generic type icon, which for a program is the only
        // picture there is. A tray app whose window carries no icon — it has
        // no window worth the name — would otherwise come back blank.
        program_icon(&window_exe(app))
    })
    .await
    .flatten()
}

// ---- settings ------------------------------------------------------------------
// Which buttons the rail shows and how big it draws them. They live here rather
// than in either page's storage: the Docked Sidebar tool runs in an isolated
// webview with a data directory of its own, so the two pages share no storage
// and no `storage` events. The tool writes through this command, and the rail
// hears about it as an event the moment it lands.

static SETTINGS: std::sync::Mutex<Option<serde_json::Value>> = std::sync::Mutex::new(None);

fn settings_file() -> Option<std::path::PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(std::path::PathBuf::from(local).join("WinT").join("sidebar-settings.json"))
}

fn load_settings() -> serde_json::Value {
    let mut cached = SETTINGS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(value) = cached.as_ref() {
        return value.clone();
    }
    let value = settings_file()
        .and_then(|file| std::fs::read_to_string(file).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    *cached = Some(value.clone());
    value
}

/// The saved settings, `{}` until something has been changed. Each page fills
/// in its own defaults, so a missing key is never an error.
#[tauri::command]
pub async fn sidebar_settings() -> serde_json::Value {
    off_thread(load_settings).await.unwrap_or_else(|| serde_json::json!({}))
}

/// Save the settings and hand them to the rail straight away.
#[tauri::command]
pub async fn sidebar_settings_set(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    use tauri::Emitter;
    *SETTINGS.lock().unwrap_or_else(|e| e.into_inner()) = Some(settings.clone());
    // To every page: the rail applies it, and a second copy of the tool page
    // (popped out, say) stays in step.
    let _ = app.emit("sidebar:settings", settings.clone());
    off_thread(move || {
        let file = settings_file().ok_or("Windows did not provide LOCALAPPDATA.")?;
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&file, settings.to_string()).map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|| Err("Could not save the sidebar settings.".into()))
}

/// The window's AppUserModelID, when it sets one of its own. This is what the
/// taskbar groups buttons by, and it is the only reliable way to tell browser
/// profiles apart: Edge and Chrome give every profile its own ID, so a work
/// window and a personal one keep separate places in the rail across runs.
unsafe fn app_id(hwnd: HWND) -> Option<String> {
    use windows::core::GUID;
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
    use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};
    // PKEY_AppUserModel_ID, spelled out so it needs no extra crate feature.
    const APP_ID: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0x9F4C2855_9F79_4B39_A8D0_E1D42DE1D5F3),
        pid: 5,
    };
    let store: IPropertyStore = SHGetPropertyStoreForWindow(hwnd).ok()?;
    let value = store.GetValue(&APP_ID).ok()?;
    let text = PropVariantToStringAlloc(&value).ok()?;
    let id = text.to_string().ok();
    CoTaskMemFree(Some(text.0 as *const c_void));
    id.filter(|id| !id.is_empty())
}

// ---- the right-click menu --------------------------------------------------------
// What the taskbar's jump list offers for every app, without the per-app list
// Windows keeps privately: start another copy of the app, and the window's own
// minimize, restore and close. The menu itself is drawn by the page as a native
// popup, so it can spill past the edge of a narrow rail.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowMenu {
    /// The app's own name, as its exe describes itself ("Visual Studio Code"),
    /// else the exe's file name. Empty when neither could be read.
    pub name: String,
    /// Whether a new copy can be started at all: an elevated window hides its
    /// exe from us, and a Store app with no AppUserModelID has no way in.
    pub can_launch: bool,
    pub minimized: bool,
}

/// `FileDescription` from the exe's version resource, in its first language.
pub(crate) fn exe_description(exe: &str) -> Option<String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
    };
    unsafe {
        let path = HSTRING::from(exe);
        let size = GetFileVersionInfoSizeW(&path, None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(&path, None, size, data.as_mut_ptr().cast()).ok()?;
        let mut ptr: *mut c_void = std::ptr::null_mut();
        let mut len = 0u32;
        let key = HSTRING::from(r"\VarFileInfo\Translation");
        if !VerQueryValueW(data.as_ptr().cast(), PCWSTR(key.as_ptr()), &mut ptr, &mut len).as_bool()
            || len < 4
        {
            return None;
        }
        let lang = *(ptr as *const u16);
        let codepage = *(ptr as *const u16).add(1);
        let key = HSTRING::from(format!(r"\StringFileInfo\{lang:04x}{codepage:04x}\FileDescription"));
        if !VerQueryValueW(data.as_ptr().cast(), PCWSTR(key.as_ptr()), &mut ptr, &mut len).as_bool()
            || len == 0
        {
            return None;
        }
        let text = std::slice::from_raw_parts(ptr as *const u16, len as usize);
        let text = String::from_utf16_lossy(text).trim_end_matches('\0').trim().to_string();
        (!text.is_empty()).then_some(text)
    }
}

/// A Store app runs out of `WindowsApps`, where its exe cannot be started
/// directly; it has to be activated through its AppUserModelID instead.
fn is_packaged(exe: &str) -> bool {
    let lower = exe.to_ascii_lowercase();
    lower.is_empty() || lower.contains(r"\windowsapps\") || lower.ends_with(r"\applicationframehost.exe")
}

/// What the right-click menu needs to know about one window.
#[tauri::command]
pub async fn sidebar_window_menu(id: String) -> Result<WindowMenu, String> {
    use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindow};
    let raw: isize = id.parse().map_err(|_| "Not a window.".to_string())?;
    off_thread(move || unsafe {
        let hwnd = HWND(raw as *mut c_void);
        if !IsWindow(Some(hwnd)).as_bool() {
            return Err("That window has closed.".to_string());
        }
        let exe = window_exe(app_window(hwnd));
        let packaged = is_packaged(&exe);
        let name = exe_description(&exe).unwrap_or_else(|| {
            std::path::Path::new(&exe)
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
        Ok(WindowMenu {
            name,
            can_launch: !packaged || app_id(hwnd).is_some(),
            minimized: IsIconic(hwnd).as_bool(),
        })
    })
    .await
    .unwrap_or_else(|| Err("Could not read that window.".into()))
}

/// Start another copy of the app behind a window, the way clicking its name in
/// the taskbar's jump list does. Most apps (VS Code, browsers, Explorer,
/// terminals) answer a second start with a new window.
#[tauri::command]
pub async fn sidebar_launch_new(id: String, path: Option<String>) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    let raw: isize = id.parse().map_err(|_| "Not a window.".to_string())?;
    off_thread(move || unsafe {
        let hwnd = HWND(raw as *mut c_void);
        let exe = window_exe(app_window(hwnd));
        // A recent item goes to the app it was listed under. A Store app
        // cannot be handed a path on its command line, so its item opens
        // with whatever Windows opens that file with.
        let mut command = if let Some(path) = path {
            let mut command = if is_packaged(&exe) {
                std::process::Command::new("explorer.exe")
            } else {
                std::process::Command::new(&exe)
            };
            command.arg(path);
            command
        } else if is_packaged(&exe) {
            let aumid = app_id(hwnd).ok_or("This app cannot be started from here.")?;
            let mut command = std::process::Command::new("explorer.exe");
            command.arg(format!(r"shell:AppsFolder\{aumid}"));
            command
        } else {
            let mut command = std::process::Command::new(&exe);
            if let Some(dir) = std::path::Path::new(&exe).parent() {
                command.current_dir(dir);
            }
            command
        };
        command
            .creation_flags(DETACHED_PROCESS)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Could not start it: {e}"))
    })
    .await
    .unwrap_or_else(|| Err("Could not start it.".into()))
}

/// The app's recent files and folders for the menu: the editor's own history
/// when it keeps one (VS Code and its forks), else the list Windows keeps for
/// its taskbar jump list.
#[tauri::command]
pub async fn sidebar_window_recent(id: String) -> Vec<crate::recent::RecentItem> {
    let Ok(raw) = id.parse::<isize>() else {
        return Vec::new();
    };
    off_thread(move || unsafe {
        let hwnd = HWND(raw as *mut c_void);
        let exe = window_exe(app_window(hwnd));
        let own = crate::recent::vscode(&exe);
        if !own.is_empty() {
            return own;
        }
        app_id(hwnd).map(|aumid| crate::recent::jump_list(&aumid)).unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// Minimize, restore, maximize or close one window from the menu.
#[tauri::command]
pub async fn sidebar_window_command(id: String, command: String) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        IsWindow, PostMessageW, ShowWindow, SW_MAXIMIZE, SW_MINIMIZE, WM_CLOSE,
    };
    let raw: isize = id.parse().map_err(|_| "Not a window.".to_string())?;
    off_thread(move || unsafe {
        let hwnd = HWND(raw as *mut c_void);
        if !IsWindow(Some(hwnd)).as_bool() {
            return Err("That window has closed.".to_string());
        }
        match command.as_str() {
            "minimize" => {
                let _ = ShowWindow(hwnd, SW_MINIMIZE);
            }
            "maximize" => {
                let _ = ShowWindow(hwnd, SW_MAXIMIZE);
                bring_forward(hwnd);
            }
            "restore" => {
                bring_forward(hwnd);
            }
            // Posted, not sent: an app that asks "save changes?" must not
            // hold this thread while the user decides.
            "close" => {
                PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)).map_err(|e| e.to_string())?;
            }
            other => return Err(format!("Unknown window command: {other}")),
        }
        Ok(())
    })
    .await
    .unwrap_or_else(|| Err("Could not reach that window.".into()))
}

// ---- suggested apps -------------------------------------------------------------
// Right-clicking the rail anywhere but a window opens a panel inside the rail
// of apps the user probably wants next. The list comes back without icons so
// the names show at once; each icon is read on its own.

/// The ranked list, without icons. Apps with a window open are left out.
#[tauri::command]
pub async fn sidebar_suggestions(app: AppHandle) -> Vec<crate::suggest::Suggestion> {
    let sidebar = sidebar_hwnd(&app);
    off_thread(move || {
        let running = list_windows(sidebar)
            .into_iter()
            .flat_map(|win| [win.exe.to_ascii_lowercase(), win.app.to_ascii_lowercase()])
            .filter(|key| !key.is_empty())
            .collect();
        crate::suggest::suggestions(&running)
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn sidebar_suggest_icon(target: String) -> Option<String> {
    off_thread(move || crate::suggest::icon(&target)).await.flatten()
}

#[tauri::command]
pub async fn sidebar_suggest_launch(target: String) -> Result<(), String> {
    off_thread(move || crate::suggest::launch(&target))
        .await
        .unwrap_or_else(|| Err("Could not start it.".into()))
}

// ---- the network pill ------------------------------------------------------------
// The rail's approximation of the taskbar's network icon: what this machine is
// connected through, and — on a click — who is talking over it right now.
// Both are read off-thread and cached by the page, because a native menu
// cannot show a spinner once it is open.

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetStatus {
    /// `wifi`, `wired` or `offline` — which glyph the button draws.
    pub kind: String,
    /// The SSID on Wi-Fi, else the adapter's own description.
    pub name: String,
    /// Signal strength in percent, 0 when the link is not wireless.
    pub signal: u32,
    pub ipv4: String,
    pub gateway: String,
}

/// A fixed-size C string out of an IP Helper struct. Its bytes are `CHAR`,
/// which the windows crate spells as `i8`.
fn c_string(bytes: &[i8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    let bytes: Vec<u8> = bytes[..end].iter().map(|&b| b as u8).collect();
    String::from_utf8_lossy(&bytes).trim().to_string()
}

/// The adapter carrying the default route: the first one with an address and a
/// gateway that are not all zeroes. `GetAdaptersInfo` is IPv4-only, which is
/// exactly what a one-line readout wants.
fn default_adapter() -> Option<(u32, String, String, String)> {
    use windows::Win32::Foundation::ERROR_BUFFER_OVERFLOW;
    use windows::Win32::NetworkManagement::IpHelper::{GetAdaptersInfo, IP_ADAPTER_INFO};
    unsafe {
        let mut len = 0u32;
        if GetAdaptersInfo(None, &mut len) != ERROR_BUFFER_OVERFLOW.0 || len == 0 {
            return None;
        }
        // The list is a chain of structs inside one buffer, so the buffer has
        // to stay aligned for `IP_ADAPTER_INFO` rather than be plain bytes.
        let count = (len as usize).div_ceil(std::mem::size_of::<IP_ADAPTER_INFO>()) + 1;
        let mut buffer: Vec<IP_ADAPTER_INFO> = vec![std::mem::zeroed(); count];
        len = (count * std::mem::size_of::<IP_ADAPTER_INFO>()) as u32;
        if GetAdaptersInfo(Some(buffer.as_mut_ptr()), &mut len) != 0 {
            return None;
        }
        let mut node = buffer.as_ptr();
        while !node.is_null() {
            let adapter = &*node;
            let ip = c_string(&adapter.IpAddressList.IpAddress.String);
            let gateway = c_string(&adapter.GatewayList.IpAddress.String);
            if !ip.is_empty() && ip != "0.0.0.0" && !gateway.is_empty() && gateway != "0.0.0.0" {
                return Some((adapter.Type, c_string(&adapter.Description), ip, gateway));
            }
            node = adapter.Next;
        }
    }
    None
}

/// What the rail's network button shows: the link this machine is on.
#[tauri::command]
pub async fn sidebar_network() -> NetStatus {
    off_thread(|| {
        // IF_TYPE_IEEE80211, spelled out so it needs no extra crate feature.
        const WIRELESS: u32 = 71;
        let Some((kind, description, ipv4, gateway)) = default_adapter() else {
            return NetStatus {
                kind: "offline".into(),
                name: "No network".into(),
                ..Default::default()
            };
        };
        let wireless = kind == WIRELESS;
        let (ssid, signal) = if wireless {
            crate::wifi::current().unwrap_or_default()
        } else {
            Default::default()
        };
        NetStatus {
            kind: if wireless { "wifi".into() } else { "wired".into() },
            name: if ssid.is_empty() { description } else { ssid },
            signal,
            ipv4,
            gateway,
        }
    })
    .await
    .unwrap_or_default()
}

/// Every network in range. The radio is asked to look again at the same
/// time, so opening the menu twice in a row shows a fresher list the second
/// time — a scan takes seconds, which is longer than a menu waits.
#[tauri::command]
pub async fn sidebar_wifi_networks() -> Vec<crate::wifi::Network> {
    off_thread(|| {
        let found = crate::wifi::networks();
        crate::wifi::scan();
        found
    })
    .await
    .unwrap_or_default()
}

/// Join a network Windows already has a profile for.
#[tauri::command]
pub async fn sidebar_wifi_connect(ssid: String) -> Result<(), String> {
    off_thread(move || crate::wifi::connect(&ssid))
        .await
        .unwrap_or_else(|| Err("Could not reach the Wi-Fi service.".into()))
}

/// Drop the current Wi-Fi connection. Windows reconnects on its own if the
/// profile says to, which is its business, not the rail's.
#[tauri::command]
pub async fn sidebar_wifi_disconnect() -> Result<(), String> {
    off_thread(crate::wifi::disconnect)
        .await
        .unwrap_or_else(|| Err("Could not reach the Wi-Fi service.".into()))
}

/// Windows' own Wi-Fi flyout, for a network this rail cannot join on its own:
/// a new one, which needs its password typed somewhere trustworthy.
#[tauri::command]
pub async fn sidebar_wifi_picker() -> Result<(), String> {
    off_thread(crate::wifi::open_picker)
        .await
        .unwrap_or_else(|| Err("Could not open the Wi-Fi list.".into()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    /// The image name of the process holding the socket, as tasklist spells it.
    pub process: String,
    pub pid: u32,
    /// `address:port` of the far end.
    pub remote: String,
    /// How many sockets this process holds open to that same address.
    pub count: u32,
    /// A window of the same program, when it has one, so that clicking the row
    /// jumps to the app behind the traffic.
    pub window: Option<String>,
}

/// Every established connection, one row per process and far end. This shells
/// out to `netstat` and `tasklist`, so it never runs on the thread that draws
/// the window.
#[tauri::command]
pub async fn sidebar_connections(app: AppHandle) -> Vec<Connection> {
    use std::collections::HashMap;
    let sidebar = sidebar_hwnd(&app);
    off_thread(move || {
        let mut names: HashMap<u32, String> = HashMap::new();
        if let Some(text) = crate::util::run_lossy("tasklist", &["/fo", "csv", "/nh"], None) {
            for line in text.lines() {
                // "name.exe","1234","Console","1","12,345 K"
                let mut cells = line.split("\",\"");
                let (Some(name), Some(pid)) = (cells.next(), cells.next()) else {
                    continue;
                };
                if let Ok(pid) = pid.trim_matches('"').trim().parse::<u32>() {
                    names.insert(pid, name.trim_matches('"').to_string());
                }
            }
        }
        // A window to jump to, keyed by the file name of the program behind it.
        // The socket usually belongs to a child process with no window of its
        // own — every browser works this way — so this matches the program,
        // not the process.
        let mut windows: HashMap<String, String> = HashMap::new();
        for win in list_windows(sidebar) {
            if let Some(file) = std::path::Path::new(&win.exe).file_name() {
                windows
                    .entry(file.to_string_lossy().to_ascii_lowercase())
                    .or_insert(win.id);
            }
        }

        let Some(text) = crate::util::run_lossy("netstat", &["-ano", "-p", "TCP"], None) else {
            return Vec::new();
        };
        let mut grouped: HashMap<(u32, String), u32> = HashMap::new();
        for line in text.lines() {
            let fields: Vec<&str> = line.split_whitespace().collect();
            // TCP  <local>  <remote>  ESTABLISHED  <pid>
            if fields.len() < 5 || !fields[0].eq_ignore_ascii_case("tcp") {
                continue;
            }
            if !fields[3].eq_ignore_ascii_case("ESTABLISHED") {
                continue;
            }
            let Ok(pid) = fields[4].parse::<u32>() else {
                continue;
            };
            let remote = fields[2];
            // A developer's machine talks to itself constantly — a dev server,
            // a database, a language server. None of that is what "who is on
            // the network?" means, so loopback is left out.
            if remote.starts_with("127.") || remote.starts_with("[::1]") {
                continue;
            }
            *grouped.entry((pid, remote.to_string())).or_default() += 1;
        }
        let mut rows: Vec<Connection> = grouped
            .into_iter()
            .map(|((pid, remote), count)| {
                let process = names
                    .get(&pid)
                    .cloned()
                    .unwrap_or_else(|| format!("pid {pid}"));
                let window = windows.get(&process.to_ascii_lowercase()).cloned();
                Connection { process, pid, remote, count, window }
            })
            .collect();
        // Busiest first, so the top of the menu is the app doing the talking.
        rows.sort_by(|a, b| {
            b.count
                .cmp(&a.count)
                .then_with(|| a.process.to_lowercase().cmp(&b.process.to_lowercase()))
                .then_with(|| a.remote.cmp(&b.remote))
        });
        rows.truncate(40);
        rows
    })
    .await
    .unwrap_or_default()
}

// ---- the notification area ---------------------------------------------------------
// The tray's icons cannot be drawn by anyone but Explorer — there is no API
// that hands them over. What Windows 11 does write down is the list itself:
// one key per icon under `Control Panel\NotifyIconSettings`, naming the program
// that registered it and whether the icon is promoted onto the taskbar or kept
// in the overflow flyout. That is the list this section shows, matched against
// the programs that are actually running, so the rail carries the same icons
// the tray does and splits them the same way.
//
// Where that key does not exist, the rail falls back to the shape a
// tray-resident app has: running, owns windows, and not one of them is a window
// the taskbar would show a button for.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayApp {
    /// A window of the app, for its icon and for showing it again.
    pub id: String,
    /// What the program calls itself, else its file name.
    pub name: String,
    pub exe: String,
    /// Whether the window behind `id` is one that can be put on screen: a
    /// titled, captioned window rather than a message sink.
    pub can_show: bool,
    /// Whether Windows keeps this icon on the taskbar rather than in the
    /// overflow — which is what the rail shows without being expanded.
    pub promoted: bool,
}

/// What the notification area holds: every running program with a tray icon.
#[tauri::command]
pub async fn sidebar_tray_apps() -> Vec<TrayApp> {
    use std::collections::HashMap;
    use windows::core::BOOL;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetShellWindow, GetWindowLongW, GetWindowTextLengthW, GWL_STYLE, WS_CAPTION,
    };

    unsafe extern "system" fn collect(hwnd: HWND, found: LPARAM) -> BOOL {
        let found = &mut *(found.0 as *mut Vec<isize>);
        found.push(hwnd.0 as isize);
        true.into()
    }

    /// One program, across every window and process it owns.
    struct Group {
        /// Whether the taskbar shows a button for any of its windows.
        shown: bool,
        exe: String,
        best: isize,
        can_show: bool,
    }

    off_thread(move || {
        let mut handles: Vec<isize> = Vec::new();
        let shell = unsafe {
            let _ = EnumWindows(Some(collect), LPARAM(std::ptr::addr_of_mut!(handles) as isize));
            // The desktop's own window belongs to Explorer, which owns several
            // of the tray's icons (volume, network, safely remove). Leaving the
            // shell out is what keeps those from being listed as an app.
            window_exe(GetShellWindow()).to_ascii_lowercase()
        };
        let own = std::env::current_exe()
            .map(|path| path.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();

        // Grouped by program rather than by process: a browser's socket-owning
        // child has hidden windows of its own while the browser is plainly on
        // screen, and that child is not an app in the tray.
        let mut apps: HashMap<String, Group> = HashMap::new();
        for raw in handles {
            let hwnd = HWND(raw as *mut c_void);
            let (exe, shown, titled, captioned) = unsafe {
                (
                    window_exe(app_window(hwnd)),
                    is_taskbar_window(hwnd),
                    GetWindowTextLengthW(hwnd) > 0,
                    GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_CAPTION.0 != 0,
                )
            };
            if exe.is_empty() {
                continue;
            }
            let key = exe.to_ascii_lowercase();
            if key == own || key == shell {
                continue;
            }
            let entry = apps.entry(key).or_insert(Group {
                shown: false,
                exe: exe.clone(),
                best: raw,
                can_show: false,
            });
            entry.shown |= shown;
            // The window worth offering is one that could actually appear.
            if titled && captioned && !entry.can_show {
                entry.best = raw;
                entry.can_show = true;
            }
        }

        let icons = crate::tray::lookup();
        let mut rows: Vec<TrayApp> = apps
            .into_iter()
            .filter_map(|(key, group)| {
                let promoted = if icons.is_empty() {
                    // No list to match against: fall back to the shape of a
                    // tray app, and treat none of them as promoted.
                    if group.shown || !group.can_show {
                        return None;
                    }
                    false
                } else {
                    let file = std::path::Path::new(&key)
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    *icons.get(&key).or_else(|| icons.get(&file))?
                };
                Some(TrayApp {
                    id: group.best.to_string(),
                    name: exe_description(&group.exe).unwrap_or_else(|| {
                        std::path::Path::new(&group.exe)
                            .file_stem()
                            .map(|stem| stem.to_string_lossy().into_owned())
                            .unwrap_or_default()
                    }),
                    exe: group.exe,
                    can_show: group.can_show,
                    promoted,
                })
            })
            .collect();
        // The icons Windows keeps on the taskbar come first, exactly as they
        // do there; the rest are what the rail's own chevron reveals.
        rows.sort_by(|a, b| {
            b.promoted
                .cmp(&a.promoted)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        rows
    })
    .await
    .unwrap_or_default()
}

/// Show a tray app. Its window is put back on screen when it has one; when it
/// has none — a tray app whose only windows are message sinks, which is most
/// of the ones written before Windows 10 — the program is started again
/// instead. Nearly every app of this kind is single-instance and answers a
/// second start by showing itself, which is the same thing clicking its tray
/// icon would have done. Nothing here can click the icon itself: Windows keeps
/// the tray's callbacks to Explorer.
#[tauri::command]
pub async fn sidebar_reveal(id: String, exe: Option<String>) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, GetWindowTextLengthW, IsWindow, GWL_STYLE, WS_CAPTION,
    };
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    let raw: isize = id.parse().map_err(|_| "Not a window.".to_string())?;
    off_thread(move || unsafe {
        let hwnd = HWND(raw as *mut c_void);
        let showable = IsWindow(Some(hwnd)).as_bool()
            && GetWindowTextLengthW(hwnd) > 0
            && GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_CAPTION.0 != 0;
        if showable {
            bring_forward(hwnd);
            return Ok(());
        }
        let exe = exe
            .filter(|exe| !exe.is_empty())
            .or_else(|| Some(window_exe(app_window(hwnd))).filter(|exe| !exe.is_empty()))
            .ok_or("That app has no window to show.")?;
        let mut command = std::process::Command::new(&exe);
        if let Some(dir) = std::path::Path::new(&exe).parent() {
            command.current_dir(dir);
        }
        command
            .creation_flags(DETACHED_PROCESS)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Could not open it: {e}"))
    })
    .await
    .unwrap_or_else(|| Err("Could not reach that app.".into()))
}
