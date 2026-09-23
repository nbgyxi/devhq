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
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
};
use windows::Win32::System::RemoteDesktop::{
    WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Shell::{
    DefSubclassProc, RemoveWindowSubclass, SHAppBarMessage, SetWindowSubclass, ABE_LEFT, ABE_RIGHT,
    ABM_GETSTATE, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS, ABM_SETSTATE,
    ABM_WINDOWPOSCHANGED, ABN_FULLSCREENAPP, ABN_POSCHANGED, ABN_STATECHANGE, ABN_WINDOWARRANGE,
    ABS_ALWAYSONTOP, ABS_AUTOHIDE, APPBARDATA,
};
use windows::Win32::UI::WindowsAndMessaging::{
    ChangeWindowMessageFilterEx, GetWindowLongW, PostMessageW, RegisterWindowMessageW,
    SetWindowPos, GWL_EXSTYLE, HWND_BOTTOM, HWND_TOPMOST, MSGFLT_ALLOW, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, SWP_NOZORDER, WM_APP, WM_DESTROY, WM_DISPLAYCHANGE, WM_DPICHANGED,
    WM_ENTERMENULOOP, WM_EXITMENULOOP, WM_WINDOWPOSCHANGED, WM_WTSSESSION_CHANGE, WS_EX_TOPMOST,
    WTS_SESSION_UNLOCK,
};

use windows::Win32::System::Threading::GetCurrentThreadId;

use crate::off_thread;

pub(crate) const SIDEBAR_LABEL: &str = "sidebar";

/// The private message the shell posts our appbar notifications to. It only
/// has to be unique within this window, and the window is ours alone.
const APPBAR_CALLBACK: u32 = WM_APP + 0x40;
const RECHECK_TASKBAR: u32 = WM_APP + 0x41;
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

/// True while this thread is inside a menu's modal loop.
///
/// `SHAppBarMessage` is not a message — it is a blocking round trip into
/// Explorer, and it may only be made from a thread that is free to answer
/// Explorer back. A tracking menu is exactly when this thread is not: it has
/// the mouse captured and the shell is busy with its own notification area,
/// so the call goes out and never returns. The window is then dead for good,
/// with no work in flight to point at and nothing left to do but kill it.
///
/// So while a menu is up, this thread makes no such call. What the shell
/// asked for is remembered and done when the menu closes.
static IN_MENU: AtomicBool = AtomicBool::new(false);
/// A shell notification that arrived while a menu was up.
static PLACE_DEFERRED: AtomicBool = AtomicBool::new(false);

/// Whether the real taskbar should be auto-hidden while we hold the edge, as
/// the last dock or configure asked for. Remembered because a shell that has
/// just restarted brings its taskbar back visible, and the sidebar has to ask
/// again for what the user already chose.
static HIDE_TASKBAR: AtomicBool = AtomicBool::new(true);

/// `TaskbarCreated`: the message a newly started Explorer broadcasts to every
/// top-level window. It is the only announcement that a new shell exists, and
/// registering the string is how a window gets to recognise it.
fn taskbar_created() -> u32 {
    static MSG: OnceLock<u32> = OnceLock::new();
    *MSG.get_or_init(|| unsafe { RegisterWindowMessageW(windows::core::w!("TaskbarCreated")) })
}

/// A broadcast from Explorer, which runs unelevated, is filtered out of an
/// elevated process unless the window asks for it by name. WinT can be run as
/// administrator, and a sidebar that silently never came back after a shell
/// restart would be the same bug either way.
unsafe fn allow_taskbar_created(hwnd: HWND) {
    let _ = ChangeWindowMessageFilterEx(hwnd, taskbar_created(), MSGFLT_ALLOW, None);
}

/// A new shell is up: whatever Explorer knew about this appbar died with the
/// old one. Registering again is the only way back — nothing is inherited,
/// and until it happens the reserved edge is gone and maximized windows run
/// underneath the rail.
///
/// This runs for any restart, not only the one the Clean Shell repair asks
/// for: an Explorer that crashed on its own leaves exactly the same hole.
unsafe fn reclaim(hwnd: HWND) {
    if HOST.load(Ordering::SeqCst) == 0 {
        return;
    }
    // The old registration is not removed first. `ABM_REMOVE` is a round trip
    // into the shell, and the shell it would be asking is the one that just
    // died or is still hanging — which is the call this file already warns
    // never comes back. The new Explorer has no record of us to clear.
    let mut data = appbar_data(hwnd);
    shell(ABM_NEW, "SHAppBarMessage ABM_NEW (shell restarted)", &mut data);
    if HIDE_TASKBAR.load(Ordering::SeqCst) {
        auto_hide_taskbar();
    }
    place(hwnd);
}

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

/// Every `SHAppBarMessage` in this file goes through here.
///
/// It is a blocking round trip into Explorer, and when it does not come back
/// the window is dead with nothing in flight to explain it. Naming the call
/// and the thread that made it is what turns that into a line in the log.
unsafe fn shell(message: u32, what: &'static str, data: &mut APPBARDATA) -> usize {
    let on_main = MAIN_THREAD.load(Ordering::SeqCst) == GetCurrentThreadId();
    let tracked = crate::health::native_started(what, on_main);
    let result = SHAppBarMessage(message, data);
    crate::health::native_finished(tracked);
    result
}

/// The thread that draws the window, noted the first time it docks, so a
/// blocking call can say which side of the rule it is on.
static MAIN_THREAD: AtomicU32 = AtomicU32::new(0);

fn appbar_data(hwnd: HWND) -> APPBARDATA {
    APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        hWnd: hwnd,
        uCallbackMessage: APPBAR_CALLBACK,
        ..Default::default()
    }
}

/// Tell the shell the bar has moved, without waiting for it to answer.
///
/// This one is only a nudge — nothing is read back — so it does not need
/// the drawing thread, and that thread must not be the one to block on it.
/// A drag or a resize sends a burst of these, so they settle into one call.
fn notify_pos_changed(hwnd: HWND) {
    static PENDING: AtomicBool = AtomicBool::new(false);
    if PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let raw = hwnd.0 as isize;
    std::thread::Builder::new()
        .name("wint-appbar-pos".into())
        .spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            PENDING.store(false, Ordering::SeqCst);
            unsafe {
                use windows::Win32::UI::WindowsAndMessaging::IsWindow;
                let hwnd = HWND(raw as *mut c_void);
                if !IsWindow(Some(hwnd)).as_bool() {
                    return;
                }
                let mut data = appbar_data(hwnd);
                shell(ABM_WINDOWPOSCHANGED, "SHAppBarMessage ABM_WINDOWPOSCHANGED", &mut data);
            }
        })
        .ok();
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
    shell(ABM_QUERYPOS, "SHAppBarMessage ABM_QUERYPOS", &mut data);
    if edge == ABE_RIGHT {
        data.rc.left = data.rc.right - thickness;
    } else {
        data.rc.right = data.rc.left + thickness;
    }
    shell(ABM_SETPOS, "SHAppBarMessage ABM_SETPOS", &mut data);

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

/// Put a window of ours back somewhere it can actually be seen, and say
/// whether it had to be moved.
///
/// Showing a window is not the same as being able to see it. A window left on
/// a monitor that was then unplugged - a laptop undocked, a second screen
/// switched off, a remote session resized - keeps the coordinates it had, and
/// those coordinates belong to no screen any more. Windows does not correct
/// them, and neither does restarting Explorer: the position is the window's
/// own. The result is a WinT that shows and hides and takes focus exactly as
/// it is told while never appearing anywhere.
///
/// Two things count as lost: no monitor covers any part of the window, or what
/// does overlap one is too small a sliver to grab with the mouse. A maximized
/// window is restored first, because `SetWindowPos` on a maximized window
/// leaves it in a half-maximized state.
pub(crate) unsafe fn ensure_on_screen(hwnd: HWND) -> bool {
    use windows::Win32::Graphics::Gdi::{MonitorFromRect, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL};
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsZoomed, ShowWindow, SW_RESTORE};

    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_err() {
        return false;
    }
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let nearest = MonitorFromRect(&rect, MONITOR_DEFAULTTONEAREST);
    if !GetMonitorInfoW(nearest, &mut info).as_bool() {
        return false;
    }
    let work = info.rcWork;
    let seen_wide = rect.right.min(work.right) - rect.left.max(work.left);
    let seen_tall = rect.bottom.min(work.bottom) - rect.top.max(work.top);
    let lost = MonitorFromRect(&rect, MONITOR_DEFAULTTONULL).is_invalid()
        || seen_wide < 120
        || seen_tall < 48;
    if !lost {
        return false;
    }
    if IsZoomed(hwnd).as_bool() {
        let _ = ShowWindow(hwnd, SW_RESTORE);
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
    }
    let (room_wide, room_tall) = (work.right - work.left, work.bottom - work.top);
    let width = (rect.right - rect.left).clamp(480, room_wide);
    let height = (rect.bottom - rect.top).clamp(320, room_tall);
    let _ = SetWindowPos(
        hwnd,
        None,
        work.left + ((room_wide - width) / 2).max(0),
        work.top + ((room_tall - height) / 2).max(0),
        width,
        height,
        SWP_NOZORDER,
    );
    true
}

/// Read the real taskbar's auto-hide / always-on-top state.
unsafe fn taskbar_state() -> u32 {
    let mut data = APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        ..Default::default()
    };
    shell(ABM_GETSTATE, "SHAppBarMessage ABM_GETSTATE", &mut data) as u32
}

unsafe fn set_taskbar_state(value: u32) {
    let mut data = APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        lParam: LPARAM(value as isize),
        ..Default::default()
    };
    shell(ABM_SETSTATE, "SHAppBarMessage ABM_SETSTATE", &mut data);
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

/// Windows can clear auto-hide while restoring Explorer after lock or sleep.
/// Reassert only the state WinT owns; otherwise the user's taskbar preference
/// remains untouched.
unsafe fn ensure_taskbar_hidden() {
    if HIDE_TASKBAR.load(Ordering::SeqCst) && taskbar_state() & ABS_AUTOHIDE == 0 {
        auto_hide_taskbar();
    }
}

/// Explorer may apply its saved taskbar state just after the unlock message,
/// so check after that restore has had a moment to settle.
fn recheck_taskbar_after_unlock(hwnd: HWND) {
    let raw = hwnd.0 as isize;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(750));
        unsafe {
            let _ = PostMessageW(
                Some(HWND(raw as *mut c_void)),
                RECHECK_TASKBAR,
                WPARAM(0),
                LPARAM(0),
            );
        }
    });
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
    // Registered at run time, so it cannot be a match arm.
    if msg == taskbar_created() {
        reclaim(hwnd);
        return DefSubclassProc(hwnd, msg, wparam, lparam);
    }
    match msg {
        APPBAR_CALLBACK => {
            match wparam.0 as u32 {
                // Another appbar appeared, moved or resized: re-claim our edge.
                // `place` asks the shell for a rectangle and waits for the
                // answer, so it waits for the menu instead. Nothing is lost by
                // waiting: moving the bar out from under an open menu is not
                // something to do anyway.
                ABN_POSCHANGED | ABN_WINDOWARRANGE | ABN_STATECHANGE => {
                    if wparam.0 as u32 == ABN_STATECHANGE {
                        ensure_taskbar_hidden();
                    }
                    if IN_MENU.load(Ordering::SeqCst) {
                        PLACE_DEFERRED.store(true, Ordering::SeqCst);
                    } else {
                        place(hwnd);
                    }
                }
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
        WM_DISPLAYCHANGE | WM_DPICHANGED => {
            if IN_MENU.load(Ordering::SeqCst) {
                PLACE_DEFERRED.store(true, Ordering::SeqCst);
            } else {
                place(hwnd);
            }
        }
        WM_WTSSESSION_CHANGE if wparam.0 as u32 == WTS_SESSION_UNLOCK => {
            recheck_taskbar_after_unlock(hwnd);
        }
        RECHECK_TASKBAR => ensure_taskbar_hidden(),
        WM_WINDOWPOSCHANGED => notify_pos_changed(hwnd),
        // A menu is opening. Every menu on the rail goes through here,
        // including the one a right-click on a tray icon opens, which is
        // where this thread and Explorer used to meet head on.
        WM_ENTERMENULOOP => IN_MENU.store(true, Ordering::SeqCst),
        WM_EXITMENULOOP => {
            IN_MENU.store(false, Ordering::SeqCst);
            if PLACE_DEFERRED.swap(false, Ordering::SeqCst) {
                place(hwnd);
            }
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
    let _ = WTSUnRegisterSessionNotification(hwnd);
    shell(ABM_REMOVE, "SHAppBarMessage ABM_REMOVE", &mut data);
    let _ = RemoveWindowSubclass(hwnd, Some(sidebar_proc), SUBCLASS_ID);
    restore_taskbar();
}

/// Register as an appbar (once) and take the edge. Must run on the main thread:
/// the subclass belongs to the thread that owns the window.
unsafe fn dock(hwnd: HWND, hide_taskbar: bool) {
    MAIN_THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
    HIDE_TASKBAR.store(hide_taskbar, Ordering::SeqCst);
    let raw = hwnd.0 as isize;
    if HOST.swap(raw, Ordering::SeqCst) != raw {
        let mut data = appbar_data(hwnd);
        shell(ABM_NEW, "SHAppBarMessage ABM_NEW", &mut data);
        let _ = SetWindowSubclass(hwnd, Some(sidebar_proc), SUBCLASS_ID, 0);
        let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
        allow_taskbar_created(hwnd);
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

/// Draw a cheap, click-through outline at the width a sidebar drag would use.
/// This is a separate window because the useful part of a wider preview lies
/// outside the appbar's current bounds. It never registers with Explorer and
/// therefore never moves the work area or any maximized windows.
#[tauri::command]
pub async fn sidebar_resize_preview(app: AppHandle, width: Option<u32>) -> Result<(), String> {
    const LABEL: &str = "sidebar-resize-preview";
    let Some(width) = width else {
        if let Some(preview) = app.get_webview_window(LABEL) {
            let _ = preview.hide();
        }
        return Ok(());
    };

    let sidebar = app
        .get_webview_window(SIDEBAR_LABEL)
        .ok_or_else(|| "The sidebar is not open.".to_string())?;
    let scale = sidebar.scale_factor().map_err(|e| e.to_string())?;
    let position = sidebar
        .outer_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let size = sidebar
        .outer_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let width = f64::from(width.clamp(MIN_WIDTH, MAX_WIDTH));
    let x = if EDGE.load(Ordering::SeqCst) == ABE_RIGHT {
        position.x + size.width - width
    } else {
        position.x
    };

    let preview = match app.get_webview_window(LABEL) {
        Some(preview) => preview,
        None => WebviewWindowBuilder::new(
            &app,
            LABEL,
            WebviewUrl::App("sidebar-resize-preview.html".into()),
        )
        .title("Sidebar size preview")
        .inner_size(width, size.height)
        .position(x, position.y)
        .decorations(false)
        .resizable(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .shadow(true)
        .build()
        .map_err(|e| format!("Could not show the sidebar preview: {e}"))?,
    };
    preview
        .set_ignore_cursor_events(true)
        .map_err(|e| e.to_string())?;
    preview
        .set_size(LogicalSize::new(width, size.height))
        .map_err(|e| e.to_string())?;
    preview
        .set_position(LogicalPosition::new(x, position.y))
        .map_err(|e| e.to_string())?;
    preview.show().map_err(|e| e.to_string())
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
                    Some(true) => {
                        HIDE_TASKBAR.store(true, Ordering::SeqCst);
                        auto_hide_taskbar()
                    }
                    Some(false) => {
                        HIDE_TASKBAR.store(false, Ordering::SeqCst);
                        show_taskbar()
                    }
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
    if let Some(preview) = app.get_webview_window("sidebar-resize-preview") {
        let _ = preview.destroy();
    }
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
/// Windows let it. Keep this best-effort and asynchronous: attaching input
/// queues to an app that is stalled while restoring can stall the sidebar's
/// drawing thread as well.
unsafe fn bring_forward(hwnd: HWND) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, IsIconic, SetForegroundWindow,
        ShowWindowAsync, SW_RESTORE, SW_SHOW,
    };
    // A tray-hidden target can be busy or hung while restoring. Never attach
    // its input queue to ours: that makes its wait the sidebar's wait too and
    // wedges the rail even though this function is running off-thread.
    let _ = ShowWindowAsync(hwnd, if IsIconic(hwnd).as_bool() { SW_RESTORE } else { SW_SHOW });
    let _ = BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd).as_bool() || GetForegroundWindow() == hwnd
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
    /// The workspace/folder shown by editors whose windows otherwise share
    /// one app identity. Empty for apps where the app identity is sufficient.
    pub workspace: String,
    pub active: bool,
    pub minimized: bool,
}

/// VS Code gives every window the same AppUserModelID. Its default title ends
/// in `<folder or workspace> - Visual Studio Code`, while the part before that
/// may change whenever the active file changes. Keep only the workspace part
/// so sidebar order follows the project rather than EnumWindows order.
fn editor_workspace(exe: &str, title: &str) -> String {
    let stem = std::path::Path::new(exe)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(stem.as_str(), "code" | "code-insiders" | "code - insiders" | "codium" | "vscodium") {
        return String::new();
    }
    let parts: Vec<&str> = title.split(" - ").collect();
    if parts.len() < 2 {
        return String::new();
    }
    parts[parts.len() - 2]
        .trim_start_matches(['●', '○', '*', ' '])
        .trim()
        .to_string()
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

/// The smallest a restored window can be and still be a window somebody was
/// looking at. Message sinks and the hidden helpers a tray app keeps around
/// are 0x0 or a few pixels square.
const REAL_WINDOW_MIN: i32 = 160;

/// Framework-owned top-level windows that exist only to receive notification
/// area messages. Some of them have a caption and a plausible restored size,
/// so the normal window-shape checks cannot distinguish them from an app's
/// hidden main window.
fn is_tray_message_window(class: &str) -> bool {
    class.eq_ignore_ascii_case("QTrayIconMessageWindow")
}

/// Whether this window is one the user could actually be shown — whether or
/// not it is on screen right now, because a tray app's main window is hidden
/// by definition.
///
/// A title and a caption are not enough on their own. Steam, and most of the
/// older tray apps, keep hidden windows that have both: a broadcast sink, an
/// overlay host, an IPC window, all titled after the app and all with a
/// caption style they never draw. Bringing one of those forward is what put a
/// tiny empty window on screen instead of the app. What separates them from
/// the real thing is that they were never given a size.
unsafe fn showable_window(hwnd: HWND) -> bool {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetWindow, GetWindowLongW, GetWindowPlacement, GetWindowRect,
        GetWindowTextLengthW, IsWindow, GWL_EXSTYLE, GWL_STYLE, GW_OWNER, WINDOWPLACEMENT,
        WS_CAPTION, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };
    if !IsWindow(Some(hwnd)).as_bool() || GetWindowTextLengthW(hwnd) == 0 {
        return false;
    }
    let mut class = [0u16; 256];
    let class_len = GetClassNameW(hwnd, &mut class).max(0) as usize;
    if is_tray_message_window(&String::from_utf16_lossy(&class[..class_len])) {
        return false;
    }
    if GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_CAPTION.0 == 0 {
        return false;
    }
    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if ex & WS_EX_APPWINDOW.0 == 0 {
        // A tool window is a palette, and an owned window is a dialog or a
        // popup belonging to something else — neither is the app itself.
        if ex & WS_EX_TOOLWINDOW.0 != 0 {
            return false;
        }
        if GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.0.is_null()) {
            return false;
        }
    }
    // The restored rectangle, not the current one: a window hidden in the tray
    // still remembers the size it had when it was last on screen, while a sink
    // never had one.
    let mut placement = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        ..Default::default()
    };
    let rect = if GetWindowPlacement(hwnd, &mut placement).is_ok() {
        placement.rcNormalPosition
    } else {
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        rect
    };
    rect.right - rect.left >= REAL_WINDOW_MIN && rect.bottom - rect.top >= REAL_WINDOW_MIN
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
            let title = String::from_utf16_lossy(&title[..len]);
            OpenWindow {
                id: raw.to_string(),
                workspace: editor_workspace(&exe, &title),
                title,
                exe: exe.clone(),
                app: window_app_id(hwnd).unwrap_or(exe),
                active: raw == active,
                minimized: IsIconic(hwnd).as_bool(),
            }
        })
        .collect()
}

#[cfg(test)]
mod sidebar_order_tests {
    use super::{editor_workspace, is_tray_message_window};

    #[test]
    fn vscode_workspace_ignores_the_active_file() {
        let exe = r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe";
        assert_eq!(editor_workspace(exe, "app.rs - devhq - Visual Studio Code"), "devhq");
        assert_eq!(editor_workspace(exe, "README.md - another - Visual Studio Code"), "another");
    }

    #[test]
    fn vscode_folder_only_title_is_supported() {
        assert_eq!(editor_workspace(r"C:\Code.exe", "devhq - Visual Studio Code"), "devhq");
        assert_eq!(editor_workspace(r"C:\Code - Insiders.exe", "devhq - Visual Studio Code - Insiders"), "devhq");
    }

    #[test]
    fn other_apps_do_not_get_title_based_identity() {
        assert_eq!(editor_workspace(r"C:\notepad.exe", "notes - work - Notepad"), "");
    }

    #[test]
    fn qt_tray_message_sink_is_not_a_user_window() {
        assert!(is_tray_message_window("QTrayIconMessageWindow"));
        assert!(is_tray_message_window("qtrayiconmessagewindow"));
        assert!(!is_tray_message_window("Qt5152QWindowIcon"));
    }
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

/// The AppUserModelID of the *package* a window's process runs under.
///
/// Most packaged apps never set an ID on the window itself — Notepad is one —
/// because the shell reads it off the process instead. Asking the window is
/// still worth doing first: a browser sets a per-profile ID there, which is
/// finer than the one ID its package would give.
unsafe fn process_app_id(hwnd: HWND) -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS};
    use windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buffer = [0u16; 512];
    let mut len = buffer.len() as u32;
    let status = GetApplicationUserModelId(process, &mut len, Some(PWSTR(buffer.as_mut_ptr())));
    let _ = CloseHandle(process);
    if status != ERROR_SUCCESS || len == 0 {
        // Not a packaged process at all, which is the ordinary answer.
        return None;
    }
    // The length counts the terminator.
    let id = String::from_utf16_lossy(&buffer[..(len as usize).saturating_sub(1)]);
    (!id.is_empty()).then_some(id)
}

/// What the shell calls this window's app, however the app says so: the ID the
/// window sets, the one the window inside its frame sets, or the one its
/// package was installed under. This is the one thing the rail identifies an
/// app by — the key its row keeps its place under, and the way back in for a
/// pinned app whose windows have all closed.
pub(crate) unsafe fn window_app_id(hwnd: HWND) -> Option<String> {
    let inner = app_window(hwnd);
    app_id(hwnd)
        .or_else(|| (inner != hwnd).then(|| app_id(inner)).flatten())
        .or_else(|| process_app_id(inner))
        .or_else(|| (inner != hwnd).then(|| process_app_id(hwnd)).flatten())
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
    /// What starts this app with no window to go by: its exe, or its
    /// AppUserModelID when the exe cannot be run directly. A pin keeps this,
    /// so a pinned app can still be started once its last window is gone.
    /// Empty when there is no way in.
    pub target: String,
    /// What has to go on the target's command line for it to come back as the
    /// same thing this window is — the browser profile, today. Usually empty.
    pub args: Vec<String>,
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

// ---- browser profiles ------------------------------------------------------------
// A Chromium browser gives every profile its own AppUserModelID — Edge's
// second profile is `MSEdge.UserData.Profile1` — so the rail already tells two
// profiles apart and each can be pinned on its own. Its exe, though, is one
// exe: started with no argument it opens whichever profile it feels like, so
// a pin made from the second profile's window opened the first one.
//
// The profile is read back out of the AppUserModelID. Its last part is the
// profile's folder under the browser's user data with everything but letters
// and digits taken out ("Profile 1"), and starting the exe with
// `--profile-directory=Profile 1` opens that profile and no other.

/// The exes this is worth trying at all. Every one of them is Chromium, lays
/// its install out the same way and writes the same kind of AppUserModelID.
const CHROMIUM_EXES: [&str; 6] =
    ["msedge", "chrome", "brave", "vivaldi", "opera", "thorium"];

/// Where a Chromium browser keeps its profiles. It is read off the exe's own
/// path rather than a list of browsers: every one of them installs as
/// `…\<Vendor>\<Product>\Application\<browser>.exe` and keeps its profiles in
/// `%LOCALAPPDATA%\<Vendor>\<Product>\User Data`. Taking the vendor and the
/// product from the path is what makes a side-by-side channel — Chrome Beta,
/// Chrome SxS, Edge Dev — find its own profiles instead of stable's, and what
/// makes a per-user install (Chrome puts itself under Local AppData) work
/// without a second entry. The candidates are tried in order and the first
/// folder that is really there wins.
fn user_data_dirs(exe: &str) -> Vec<std::path::PathBuf> {
    let path = std::path::Path::new(exe);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
    if !CHROMIUM_EXES.contains(&stem.as_str()) {
        return Vec::new();
    }
    let Some(local) = std::env::var_os("LOCALAPPDATA") else { return Vec::new() };
    let local = std::path::Path::new(&local);
    let mut candidates = Vec::new();
    // `…\Google\Chrome\Application\chrome.exe` → `Google\Chrome`, and the
    // product on its own for the browsers that skip the vendor folder.
    if let Some(product) = path.parent().filter(|dir| dir.ends_with("Application")).and_then(std::path::Path::parent)
    {
        if let Some(name) = product.file_name() {
            if let Some(vendor) = product.parent().and_then(std::path::Path::file_name) {
                candidates.push(local.join(vendor).join(name).join("User Data"));
            }
            candidates.push(local.join(name).join("User Data"));
        }
    }
    // An install that is laid out some other way still has the usual home.
    for tail in match stem.as_str() {
        "msedge" => &[r"Microsoft\Edge\User Data"][..],
        "chrome" => &[r"Google\Chrome\User Data"][..],
        "brave" => &[r"BraveSoftware\Brave-Browser\User Data"][..],
        "vivaldi" => &[r"Vivaldi\User Data"][..],
        "opera" => &[r"Opera Software\Opera Stable"][..],
        _ => &[][..],
    } {
        candidates.push(local.join(tail));
    }
    candidates.retain(|dir| dir.is_dir());
    candidates.dedup();
    candidates
}

/// The folder name a profile's part of an AppUserModelID is made from.
fn profile_id(dir: &str) -> String {
    dir.chars().filter(char::is_ascii_alphanumeric).collect::<String>().to_ascii_lowercase()
}

/// The browser profile a window belongs to: the folder to start the browser
/// with, and the name the user gave that profile ("Gyxi"). `None` for anything
/// that is not a Chromium window.
fn browser_profile(exe: &str, aumid: &str) -> Option<(String, Option<String>)> {
    // `MSEdge.UserData.Profile1`: the browser, the user data folder, the
    // profile folder — each with everything but letters and digits taken out.
    let parts: Vec<String> = aumid.split('.').map(profile_id).collect();
    let tail = parts.last().filter(|tail| !tail.is_empty())?;
    let browser = std::path::Path::new(exe)
        .file_stem()
        .map(|stem| profile_id(&stem.to_string_lossy()));
    for data in user_data_dirs(exe) {
        // Chromium omits the user-data and profile suffixes for its original
        // profile: Edge calls it simply `MSEdge`, while its other profiles are
        // `MSEdge.UserData.Profile1`, etc. It still needs an explicit
        // `--profile-directory=Default` when launched from a pin; a plain
        // start may reuse whichever profile was active last.
        if parts.len() == 1
            && browser.as_deref() == Some(tail)
            && data.join("Default").is_dir()
        {
            return Some(("Default".into(), profile_name(&data, "Default")));
        }
        // The folder the AppUserModelID was built from has to be the folder
        // being read, or this is a different install of the same browser —
        // stable's profiles answering for Canary's, or a browser started
        // against some other `--user-data-dir` altogether.
        let named = data.file_name().map(|name| profile_id(&name.to_string_lossy()));
        if parts.len() > 2 && named.as_deref() != parts.get(parts.len() - 2).map(String::as_str) {
            continue;
        }
        let dir = std::fs::read_dir(&data)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .find(|name| &profile_id(name) == tail);
        if let Some(dir) = dir {
            let name = profile_name(&data, &dir);
            return Some((dir, name));
        }
    }
    None
}

/// What the browser calls a profile, out of its `Local State`. The name the
/// user typed, else nothing — the folder name on its own ("Profile 7") says
/// no more than the row already does.
fn profile_name(data: &std::path::Path, dir: &str) -> Option<String> {
    let text = std::fs::read_to_string(data.join("Local State")).ok()?;
    let state: serde_json::Value = serde_json::from_str(&text).ok()?;
    let info = state.get("profile")?.get("info_cache")?.get(dir)?;
    let name = info
        .get("shortcut_name")
        .and_then(serde_json::Value::as_str)
        .filter(|name| !name.is_empty())
        .or_else(|| info.get("name").and_then(serde_json::Value::as_str))?;
    (!name.is_empty() && name != dir).then(|| name.to_string())
}

/// The arguments that start one window's app as the same profile it is.
unsafe fn profile_args(hwnd: HWND, exe: &str) -> Vec<String> {
    let Some(aumid) = window_app_id(hwnd) else { return Vec::new() };
    match browser_profile(exe, &aumid) {
        Some((dir, _)) => vec![format!("--profile-directory={dir}")],
        None => Vec::new(),
    }
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
        let target = if packaged { window_app_id(hwnd).unwrap_or_default() } else { exe.clone() };
        // A browser profile is its own app on the rail, so it is named as one:
        // "Gyxi — Microsoft Edge", not a second row called Microsoft Edge.
        let profile = window_app_id(hwnd).and_then(|aumid| browser_profile(&exe, &aumid));
        let name = match &profile {
            Some((_, Some(profile))) => format!("{profile} — {name}"),
            _ => name,
        };
        let args = match &profile {
            Some((dir, _)) => vec![format!("--profile-directory={dir}")],
            None => Vec::new(),
        };
        Ok(WindowMenu {
            name,
            can_launch: !target.is_empty(),
            minimized: IsIconic(hwnd).as_bool(),
            target,
            args,
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
        // A new window of a browser profile has to name that profile, or the
        // browser opens whichever one it opened last.
        let profile = profile_args(hwnd, &exe);
        let mut command = if let Some(path) = path {
            let mut command = if is_packaged(&exe) {
                std::process::Command::new("explorer.exe")
            } else {
                std::process::Command::new(&exe)
            };
            if !is_packaged(&exe) {
                command.args(&profile);
            }
            command.arg(path);
            command
        } else if is_packaged(&exe) {
            let aumid = window_app_id(hwnd).ok_or("This app cannot be started from here.")?;
            let mut command = std::process::Command::new("explorer.exe");
            command.arg(format!(r"shell:AppsFolder\{aumid}"));
            command
        } else {
            let mut command = std::process::Command::new(&exe);
            command.args(&profile);
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
        window_app_id(hwnd).map(|aumid| crate::recent::jump_list(&aumid)).unwrap_or_default()
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
pub async fn sidebar_suggest_launch(
    target: String,
    args: Option<Vec<String>>,
    name: Option<String>,
    app: Option<String>,
) -> Result<(), String> {
    let mut args = args.unwrap_or_default();
    off_thread(move || unsafe {
        // What a pin stands for is its AppUserModelID, and for a browser that
        // is one per profile — so the profile can be worked out here even for
        // a pin made before any of this existed and saved with no arguments
        // of its own. Without it such a pin falls back on the window it finds,
        // which is whichever profile happened to be open.
        if args.is_empty() {
            if let Some((dir, _)) = app
                .as_deref()
                .filter(|app| !crate::suggest::is_path(app))
                .and_then(|app| browser_profile(&target, app))
            {
                args = vec![format!("--profile-directory={dir}")];
            }
        }
        // The app may be running already with nothing on screen — sitting in
        // the tray, which is where Signal, Teams and Discord spend most of
        // their time. Starting a second copy of one of those is what put an
        // empty frame on screen: the new process hands over to the one that
        // is already there and leaves, and what it leaves behind is a window
        // nobody ever drew. So the window is looked for first and put back
        // exactly the way the rail's tray does it; only an app with no window
        // anywhere is started.
        //
        // A pin carrying arguments is skipped: those say which browser
        // profile it stands for, and a window that is already up may well be
        // a different one.
        let path = crate::suggest::is_path(&target) && target.to_ascii_lowercase().ends_with(".exe");
        if args.is_empty() && path {
            let want = app.as_deref().filter(|app| !crate::suggest::is_path(app));
            if let Some(found) = app_window_for(&target, name.as_deref().unwrap_or_default(), want) {
                return reveal_app(found, Some(target), name);
            }
        }
        crate::suggest::launch(&target, &args)
    })
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
pub async fn sidebar_tray_apps(app: AppHandle) -> Vec<TrayApp> {
    use std::collections::HashMap;
    use windows::core::BOOL;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetShellWindow,
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
        /// How good `best` is: 2 for a window the taskbar would show, 1 for
        /// one that is hidden but real, 0 for nothing worth offering.
        rank: u8,
    }

    // WinT's own windows are left out below: the rail is drawn by one of
    // them, and the tools it opens are not apps in the notification area. The
    // one exception is the main window once it has gone to the tray — WinT is
    // then a tray app like any other, and a rail that shows every one of them
    // has to show itself too.
    // `get_window`, never `get_webview_window`: the latter answers with
    // nothing as soon as the main window hosts an embedded tool, because a
    // window only counts as a webview window while every webview on it
    // carries the window's own label. That is why this drew no row — the rail
    // asked while a tool was open, and Tauri said WinT had no main window.
    let main = app.get_window("main");
    let own_window = main
        .as_ref()
        .filter(|window| !window.is_visible().unwrap_or(true))
        .and_then(|window| window.hwnd().ok())
        .map(|hwnd| hwnd.0 as isize);
    // Said out loud, because this is the one row whose absence cannot be seen
    // by looking at the rail: there is no way to tell a WinT that decided not
    // to draw itself from a WinT that never asked.
    crate::health::record(
        "tray",
        match (&main, own_window) {
            (None, _) => "the rail found no main window to draw for WinT".to_string(),
            (Some(_), Some(raw)) => {
                format!("WinT is in the notification area; the rail draws {raw:#x} for it")
            }
            (Some(_), None) => "WinT's main window is on screen, so the rail leaves it out".to_string(),
        },
    );

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
            let (exe, shown, showable) = unsafe {
                (
                    window_exe(app_window(hwnd)),
                    is_taskbar_window(hwnd),
                    showable_window(hwnd),
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
                rank: 0,
            });
            entry.shown |= shown;
            // The window worth offering is the best one the program has, not
            // the first that looked plausible. A program keeps several, and
            // EnumWindows hands them over in Z-order, so the hidden helper
            // sitting in front of the real window used to win.
            let rank = if shown {
                2
            } else if showable {
                1
            } else {
                0
            };
            if rank > entry.rank {
                entry.best = raw;
                entry.rank = rank;
            }
        }

        let icons = crate::tray::lookup();
        let mut rows: Vec<TrayApp> = apps
            .into_iter()
            .filter_map(|(key, group)| {
                let promoted = if icons.is_empty() {
                    // No list to match against: fall back to the shape of a
                    // tray app, and treat none of them as promoted.
                    if group.shown || group.rank == 0 {
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
                    can_show: group.rank > 0,
                    promoted,
                })
            })
            .collect();
        if let Some(raw) = own_window {
            let file = std::path::Path::new(&own)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            rows.push(TrayApp {
                id: raw.to_string(),
                name: exe_description(&own).unwrap_or_else(|| "WinT".to_string()),
                exe: own.clone(),
                can_show: true,
                // Windows writes the icon's record down in its own time, and a
                // record that is not there yet must not cost WinT the only row
                // that brings it back: unknown counts as promoted, so the row
                // is there without the rail being expanded.
                promoted: icons
                    .get(&own)
                    .or_else(|| icons.get(&file))
                    .copied()
                    .unwrap_or(true),
            });
        }
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

/// Every process that a process running `exe` started, directly or through
/// something it started in turn — and those processes themselves.
///
/// A tray app's real window often belongs to a helper it launched rather than
/// to the exe the notification area has on record. Steam is the clearest case:
/// the only titled window `steam.exe` keeps is a hidden sink called "Untitled",
/// while the window everyone means by "Steam" belongs to `steamwebhelper.exe`.
unsafe fn family_pids(exe: &str) -> std::collections::HashSet<u32> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut family = std::collections::HashSet::new();
    let want = std::path::Path::new(exe)
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_else(|| exe.to_ascii_lowercase());
    let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
        return family;
    };
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut parents: Vec<(u32, u32)> = Vec::new();
    if Process32FirstW(snapshot, &mut entry).is_ok() {
        loop {
            let len = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_ascii_lowercase();
            if name == want {
                family.insert(entry.th32ProcessID);
            }
            parents.push((entry.th32ProcessID, entry.th32ParentProcessID));
            if Process32NextW(snapshot, &mut entry).is_err() {
                break;
            }
        }
    }
    let _ = windows::Win32::Foundation::CloseHandle(snapshot);
    // Walk down: a child of anything already in the family joins it, until a
    // pass adds nobody. The table is small and the loop is bounded by it.
    loop {
        let before = family.len();
        for (pid, parent) in &parents {
            if family.contains(parent) {
                family.insert(*pid);
            }
        }
        if family.len() == before {
            break;
        }
    }
    family
}

/// Whether the window is on screen right now - drawn, or minimized to the
/// taskbar, but in either case a window Windows is keeping for the user. A
/// window hidden to the tray is not, and neither is a packaged app suspended
/// in the background, which Windows cloaks rather than hides.
unsafe fn on_screen(hwnd: HWND) -> bool {
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    if !IsWindowVisible(hwnd).as_bool() {
        return false;
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

/// The command that opens a packaged app the way the Start menu does, when the
/// window belongs to one and it says which package it is.
unsafe fn shell_activation(hwnd: HWND) -> Option<std::process::Command> {
    // Not is_packaged: that counts an unreadable path as packaged, which is
    // right for the menu that would rather offer a launch than refuse one, and
    // wrong here - an elevated window hides its path too, and it is a plain
    // program whose window should simply be brought forward.
    let exe = window_exe(app_window(hwnd)).to_ascii_lowercase();
    if !exe.contains(r"\windowsapps\") && !exe.ends_with(r"\applicationframehost.exe") {
        return None;
    }
    let aumid = window_app_id(hwnd)?;
    let mut command = std::process::Command::new("explorer.exe");
    command.arg(format!(r"shell:AppsFolder\{aumid}"));
    Some(command)
}

unsafe fn window_pid(hwnd: HWND) -> u32 {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    pid
}

/// How good a window is as the answer to "show me that app". Higher wins;
/// `None` is a window the user could not be shown at all.
///
/// Ranked the way somebody looking at the screen would rank them: a window
/// named after the app beats one that is not, a window the program asked the
/// taskbar to carry beats one it never did, and the program's own window beats
/// a helper's. Size settles the rest — the real window is the big one.
unsafe fn reveal_rank(hwnd: HWND, want_exe: &str, name: &str) -> Option<(u8, u8, u8, i64)> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowPlacement, GetWindowTextW, WINDOWPLACEMENT, WS_EX_APPWINDOW,
    };
    if !showable_window(hwnd) {
        return None;
    }
    let mut text = [0u16; 256];
    let len = GetWindowTextW(hwnd, &mut text).max(0) as usize;
    let title = String::from_utf16_lossy(&text[..len]).to_ascii_lowercase();
    let name = name.trim().to_ascii_lowercase();
    // "Untitled" is not the app's name; "Steam" is. Two characters is the
    // shortest either side can be and still mean anything.
    let named = u8::from(
        name.len() >= 2 && title.len() >= 2 && (title.contains(&name) || name.contains(&title)),
    );
    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    let taskbar = u8::from(ex & WS_EX_APPWINDOW.0 != 0 || is_taskbar_window(hwnd));
    let own = u8::from(window_exe(app_window(hwnd)).to_ascii_lowercase() == want_exe);
    let mut placement = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        ..Default::default()
    };
    let area = if GetWindowPlacement(hwnd, &mut placement).is_ok() {
        let rect = placement.rcNormalPosition;
        i64::from(rect.right - rect.left) * i64::from(rect.bottom - rect.top)
    } else {
        0
    };
    Some((named, taskbar, own, area))
}

/// Show a tray app. Its window is put back on screen when it has one; when it
/// has none — a tray app whose only windows are message sinks, which is most
/// of the ones written before Windows 10 — the program is started again
/// instead. Nearly every app of this kind is single-instance and answers a
/// second start by showing itself, which is the same thing clicking its tray
/// icon would have done. Nothing here can click the icon itself: Windows keeps
/// the tray's callbacks to Explorer.
///
/// Which window is decided by looking at all of them, not by trusting the one
/// the list happened to record: that handle is a moment old, and for a program
/// that splits itself across processes it was never the right one to begin
/// with.
#[tauri::command]
pub async fn sidebar_reveal(
    app: AppHandle,
    id: String,
    exe: Option<String>,
    name: Option<String>,
) -> Result<(), String> {
    let raw: isize = id.parse().map_err(|_| "Not a window.".to_string())?;
    // WinT itself: its main window was hidden rather than minimized, so
    // putting it back is Tauri's job — and that is also what retires the
    // tray icon it left behind.
    let own = std::env::current_exe()
        .map(|path| path.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !own.is_empty() && exe.as_deref().map(str::to_ascii_lowercase).as_deref() == Some(own.as_str())
    {
        crate::show_main_window(&app);
        return Ok(());
    }
    off_thread(move || unsafe { reveal_app(HWND(raw as *mut c_void), exe, name) })
        .await
        .unwrap_or_else(|| Err("Could not reach that app.".into()))
}

/// The body of `sidebar_reveal`, and what a pin falls back on: `hwnd` is a
/// window of the app to start from, or a null handle when all that is known is
/// which program it is.
/// The window that best answers "show me that app", among every window the
/// program and the processes it started own — on screen, minimized, or hidden
/// in the tray. `None` when the app has no window worth showing anywhere,
/// which is when it has to be started instead.
///
/// `want_app` is the AppUserModelID the caller is after, when it knows one. A
/// window wearing that ID wins over every other window of the same program,
/// which is what keeps one browser profile from answering for another: they
/// are one exe and one process, told apart by nothing else.
pub(crate) unsafe fn app_window_for(exe: &str, name: &str, want_app: Option<&str>) -> Option<HWND> {
    use windows::core::BOOL;
    use windows::Win32::UI::WindowsAndMessaging::EnumWindows;

    unsafe extern "system" fn collect(hwnd: HWND, found: LPARAM) -> BOOL {
        let found = &mut *(found.0 as *mut Vec<isize>);
        found.push(hwnd.0 as isize);
        true.into()
    }

    let want = exe.to_ascii_lowercase();
    if want.is_empty() {
        return None;
    }
    // The program's own processes and everything they started: the window
    // worth showing can belong to either.
    let family = family_pids(&want);
    let mut handles: Vec<isize> = Vec::new();
    let _ = EnumWindows(Some(collect), LPARAM(std::ptr::addr_of_mut!(handles) as isize));
    let wanted = want_app.map(str::to_ascii_lowercase).filter(|app| !app.is_empty());
    type WindowRank = (u8, (u8, u8, u8, i64));
    let mut best: Option<(WindowRank, HWND)> = None;
    for other in handles {
        let candidate = HWND(other as *mut c_void);
        if window_exe(app_window(candidate)).to_ascii_lowercase() != want
            && !family.contains(&window_pid(candidate))
        {
            continue;
        }
        let Some(rank) = reveal_rank(candidate, &want, name) else {
            continue;
        };
        // An AppUserModelID is a constraint, not merely a ranking hint. Edge
        // profiles share an exe (and commonly a process family), so falling
        // back to another ID here makes a Niels pin reveal Stayify. With no
        // window for the requested profile the caller must launch that
        // profile instead.
        let same = match wanted.as_deref() {
            Some(app) => {
                if !window_app_id(candidate)
                    .is_some_and(|id| id.eq_ignore_ascii_case(app))
                {
                    continue;
                }
                1
            }
            None => 0,
        };
        if best.map_or(true, |(had, _)| (same, rank) > had) {
            best = Some(((same, rank), candidate));
        }
    }
    best.map(|(_, found)| found)
}

unsafe fn reveal_app(hwnd: HWND, exe: Option<String>, name: Option<String>) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;

    let own_exe = if hwnd.0.is_null() { String::new() } else { window_exe(app_window(hwnd)) };
    let want = exe
        .clone()
        .filter(|exe| !exe.is_empty())
        .unwrap_or(own_exe)
        .to_ascii_lowercase();
    let name = name.unwrap_or_default();
    if !want.is_empty() {
        if let Some(found) = app_window_for(&want, &name, None) {
            // A packaged app keeps a window it has never drawn: Windows
            // starts it in the background at sign-in and leaves it
            // suspended until the shell activates it. Showing that window
            // ourselves puts a black rectangle on screen - the frame is
            // real, the app behind it was never asked to paint. Windows
            // Defender is one. So a window that is not on screen already
            // is opened the way the Start menu opens it, by its
            // AppUserModelID, and the app puts up its own window.
            if !on_screen(found) {
                if let Some(mut command) = shell_activation(found) {
                    return command
                        .creation_flags(DETACHED_PROCESS)
                        .spawn()
                        .map(|_| ())
                        .map_err(|e| format!("Could not open it: {e}"));
                }
                // Do not ShowWindow a desktop app's tray-hidden main window.
                // Frameworks such as Qt need the application to run its own
                // restore handler; forcing qBittorrent's HWND visible, for
                // example, produces a captioned but completely blank window.
                // Starting its executable again delivers that request to the
                // existing single-instance process, like opening it from the
                // Start menu, so it restores and repaints itself properly.
                let mut command = std::process::Command::new(&want);
                if let Some(dir) = std::path::Path::new(&want).parent() {
                    command.current_dir(dir);
                }
                return command
                    .creation_flags(DETACHED_PROCESS)
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| format!("Could not open it: {e}"));
            }
            bring_forward(found);
            return Ok(());
        }
    }
    if showable_window(hwnd) {
        if !on_screen(hwnd) {
            if let Some(mut command) = shell_activation(hwnd) {
                return command
                    .creation_flags(DETACHED_PROCESS)
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| format!("Could not open it: {e}"));
            }
        }
        bring_forward(hwnd);
        return Ok(());
    }
    let exe = exe
        .filter(|exe| !exe.is_empty())
        .or_else(|| {
            (!hwnd.0.is_null())
                .then(|| window_exe(app_window(hwnd)))
                .filter(|exe| !exe.is_empty())
        })
        .ok_or("That app has no window to show.")?;
    // An exe under WindowsApps cannot be started by its path: the package
    // has to be activated, or Windows answers with nothing at all.
    let activation = (!hwnd.0.is_null()).then(|| shell_activation(hwnd)).flatten();
    let mut command = match activation {
        Some(command) if is_packaged(&exe) => command,
        _ => {
            let mut command = std::process::Command::new(&exe);
            if let Some(dir) = std::path::Path::new(&exe).parent() {
                command.current_dir(dir);
            }
            command
        }
    };
    command
        .creation_flags(DETACHED_PROCESS)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open it: {e}"))
}

// ---- the volume, the battery and the language --------------------------------------
// The three indicators Windows keeps beside the network in its own tray. The
// readings are cheap, but each goes off-thread all the same: Core Audio can
// block while a device is being switched, and the rail must not.

/// The default playback device's level, for the rail's volume tile.
#[tauri::command]
pub async fn sidebar_volume() -> crate::indicators::Volume {
    off_thread(crate::indicators::volume)
        .await
        .unwrap_or_default()
}

/// Move the master volume from the rail's menu.
#[tauri::command]
pub async fn sidebar_set_volume(level: u32) -> Result<(), String> {
    off_thread(move || crate::indicators::set_volume(level))
        .await
        .unwrap_or_else(|| Err("Could not reach the audio service.".into()))
}

/// Mute or unmute the default playback device.
#[tauri::command]
pub async fn sidebar_set_muted(muted: bool) -> Result<(), String> {
    off_thread(move || crate::indicators::set_muted(muted))
        .await
        .unwrap_or_else(|| Err("Could not reach the audio service.".into()))
}

/// What is left in the battery, and whether it is filling or emptying.
#[tauri::command]
pub async fn sidebar_battery() -> crate::indicators::Battery {
    off_thread(crate::indicators::battery)
        .await
        .unwrap_or_default()
}

/// Every keyboard layout loaded, with the one being typed in marked.
#[tauri::command]
pub async fn sidebar_layouts() -> Vec<crate::indicators::Layout> {
    off_thread(crate::indicators::layouts)
        .await
        .unwrap_or_default()
}

/// Switch the window in front to another keyboard layout.
#[tauri::command]
pub async fn sidebar_set_layout(id: String) -> Result<(), String> {
    off_thread(move || crate::indicators::set_layout(&id))
        .await
        .unwrap_or_else(|| Err("Could not change the keyboard layout.".into()))
}

/// Open the Windows page behind one of these tiles: sound, power, battery or
/// language.
#[tauri::command]
pub async fn sidebar_open_settings(page: String) -> Result<(), String> {
    off_thread(move || crate::indicators::open_settings(&page))
        .await
        .unwrap_or_else(|| Err("Could not open that settings page.".into()))
}
