//! Focus mode. One press hides every window that matches the user's rules -
//! by program (`chrome.exe`) or by a word in the title - and the next press
//! puts them all back.
//!
//! Hidden means `SW_HIDE`, not minimized: a hidden window has no taskbar
//! button, is skipped by Alt+Tab, and drops off the sidebar's own list,
//! because every one of those only shows visible windows.
//!
//! The rules live in a file of their own, and so does a short history of the
//! windows seen lately, so the tool can offer "hide this" on a window that is
//! not even open right now.
//!
//! Every show and hide is `ShowWindowAsync`: it only posts the request to
//! the window's own thread. Plain `ShowWindow` on another process's window
//! waits for that process to answer, so one hung app would hang WinT with it.
//!
//! The hidden handles are written to disk as they are hidden. A WinT that
//! quits puts them back on the way out, and one that died without the chance
//! does it on the next start, so a window can never be left hidden with
//! nothing that knows it is there.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::HWND;

use crate::off_thread;

static HIDDEN: Mutex<Vec<isize>> = Mutex::new(Vec::new());
static SETTINGS: Mutex<Option<FocusSettings>> = Mutex::new(None);
/// Windows seen lately, keyed by exe and title together.
static RECENT: Mutex<Option<HashMap<String, SeenWindow>>> = Mutex::new(None);

const RECENT_LIMIT: usize = 200;
const SAMPLE_EVERY: Duration = Duration::from_secs(5);

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FocusSettings {
    /// Exe names, `chrome.exe` or just `chrome`.
    pub apps: Vec<String>,
    /// Matched anywhere in a window's title.
    pub words: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusState {
    /// How many windows are hidden right now; 0 when nothing is.
    pub hidden: usize,
    /// What the last press did.
    pub message: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeenWindow {
    pub title: String,
    /// The full path, for the icon.
    pub exe: String,
    /// Seconds since 1970.
    pub last_seen: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusWindow {
    /// The HWND while it is open; empty for one only remembered.
    pub id: String,
    pub title: String,
    pub exe: String,
    pub last_seen: u64,
    pub open: bool,
    /// Hidden by Focus mode right now.
    pub hidden: bool,
    /// Hidden, matching the rules, but not on Focus mode's list: left behind
    /// by a WinT that died before it could write it down or bring it back.
    pub stray: bool,
}

fn data_file(name: &str) -> Option<std::path::PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(std::path::PathBuf::from(local).join("WinT").join(name))
}

fn write_file(name: &str, text: String) {
    let Some(file) = data_file(name) else { return };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(file, text);
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn remember_hidden(hidden: &[isize]) {
    if hidden.is_empty() {
        if let Some(file) = data_file("focus-hidden.json") {
            let _ = std::fs::remove_file(file);
        }
        return;
    }
    write_file("focus-hidden.json", serde_json::to_string(hidden).unwrap_or_default());
}

fn load_settings() -> FocusSettings {
    let mut cached = SETTINGS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(settings) = cached.as_ref() {
        return settings.clone();
    }
    let settings: FocusSettings = data_file("focus-mode.json")
        .and_then(|file| std::fs::read_to_string(file).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    *cached = Some(settings.clone());
    settings
}

fn exe_stem(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// The rules, lowercased and trimmed, with `.exe` taken off program names.
fn rules() -> (Vec<String>, Vec<String>) {
    let settings = load_settings();
    let clean = |items: Vec<String>| -> Vec<String> {
        items
            .into_iter()
            .map(|item| item.trim().to_lowercase())
            .filter(|item| !item.is_empty())
            .collect()
    };
    let apps = clean(settings.apps)
        .into_iter()
        .map(|app| app.strip_suffix(".exe").map(str::to_owned).unwrap_or(app))
        .collect();
    (apps, clean(settings.words))
}

fn matches(title: &str, exe: &str, apps: &[String], words: &[String]) -> bool {
    let title = title.to_lowercase();
    let exe = exe_stem(exe);
    (!exe.is_empty() && apps.contains(&exe))
        || words.iter().any(|word| title.contains(word.as_str()))
}

/// The open windows, less WinT's own: hiding the window that holds the
/// button would leave nothing to press to get it back.
fn open_windows(sidebar: isize) -> Vec<crate::appbar::OpenWindow> {
    let own = std::env::current_exe()
        .map(|path| path.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    crate::appbar::list_windows(sidebar)
        .into_iter()
        .filter(|window| window.exe.to_lowercase() != own)
        .collect()
}

fn hide_matching(sidebar: isize) -> FocusState {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindowAsync, SW_HIDE};
    let (apps, words) = rules();
    if apps.is_empty() && words.is_empty() {
        return FocusState {
            hidden: 0,
            message: "No Focus mode rules yet - pick programs or title words in the Focus mode tool.".into(),
        };
    }
    let mut hidden = HIDDEN.lock().unwrap_or_else(|e| e.into_inner());
    for window in open_windows(sidebar) {
        if !matches(&window.title, &window.exe, &apps, &words) {
            continue;
        }
        let Ok(raw) = window.id.parse::<isize>() else { continue };
        // Written down before it is hidden, never after: a WinT that dies
        // between the two must still know about every window it hid.
        if !hidden.contains(&raw) {
            hidden.push(raw);
            remember_hidden(&hidden);
        }
        unsafe {
            let _ = ShowWindowAsync(HWND(raw as *mut c_void), SW_HIDE);
        }
    }
    let count = hidden.len();
    FocusState {
        hidden: count,
        message: match count {
            0 => "Nothing open matched the Focus mode rules.".into(),
            1 => "1 window hidden. Press again to bring it back.".into(),
            n => format!("{n} windows hidden. Press again to bring them back."),
        },
    }
}

/// Show every hidden window again, without taking focus from whatever the
/// user is in now. Windows that closed while hidden are simply skipped.
///
/// Showing the window is not always enough for the taskbar: Explorer can
/// miss a window that another process hid and showed again, leaving it on
/// screen with no button. `ITaskbarList::AddTab` puts the button back. It
/// talks to Explorer, not to the window's app, so a hung app cannot stall it.
fn reveal(handles: &[isize]) -> usize {
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::{ITaskbarList, TaskbarList};
    use windows::Win32::UI::WindowsAndMessaging::{IsWindow, ShowWindowAsync, SW_SHOWNA};
    let taskbar: Option<ITaskbarList> = unsafe {
        let _apartment = crate::com::Apartment::multi_threaded();
        CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)
            .ok()
            .filter(|list: &ITaskbarList| list.HrInit().is_ok())
    };
    let mut shown = 0;
    for &raw in handles {
        let hwnd = HWND(raw as *mut c_void);
        unsafe {
            if IsWindow(Some(hwnd)).as_bool() {
                let _ = ShowWindowAsync(hwnd, SW_SHOWNA);
                if let Some(list) = &taskbar {
                    let _ = list.AddTab(hwnd);
                }
                shown += 1;
            }
        }
    }
    shown
}

/// Leaving Focus mode shows exactly the windows it hid. Windows hidden for
/// any other reason - an app minimized to its tray icon, say - are left
/// alone; the tool lists those that match the rules, to show by hand.
fn reveal_all() -> FocusState {
    let handles = std::mem::take(&mut *HIDDEN.lock().unwrap_or_else(|e| e.into_inner()));
    let shown = reveal(&handles);
    remember_hidden(&[]);
    FocusState {
        hidden: 0,
        message: match shown {
            1 => "1 window is back.".into(),
            n => format!("{n} windows are back."),
        },
    }
}

fn hidden_count() -> usize {
    HIDDEN.lock().map(|list| list.len()).unwrap_or(0)
}

/// Hide the matching windows, or - when some are already hidden - bring them
/// back. The result also goes out as `focus-mode:state` so the rail and the
/// tool follow a press made from the shortcut.
#[tauri::command]
pub async fn focus_mode_toggle(app: AppHandle) -> Result<FocusState, String> {
    let sidebar = crate::appbar::sidebar_window_handle(&app);
    let state = off_thread(move || {
        if hidden_count() > 0 { reveal_all() } else { hide_matching(sidebar) }
    })
    .await
    .ok_or("Focus mode could not run.")?;
    let _ = app.emit("focus-mode:state", state.clone());
    Ok(state)
}

#[tauri::command]
pub async fn focus_mode_state() -> FocusState {
    FocusState { hidden: hidden_count(), message: String::new() }
}

#[tauri::command]
pub async fn focus_mode_settings() -> FocusSettings {
    off_thread(load_settings).await.unwrap_or_default()
}

/// Save the rules and hand them to every page straight away.
#[tauri::command]
pub async fn focus_mode_settings_set(app: AppHandle, settings: FocusSettings) -> Result<(), String> {
    *SETTINGS.lock().unwrap_or_else(|e| e.into_inner()) = Some(settings.clone());
    let _ = app.emit("focus-mode:settings", settings.clone());
    off_thread(move || write_file("focus-mode.json", serde_json::to_string(&settings).unwrap_or_default()))
        .await
        .ok_or_else(|| "Could not save the Focus mode rules.".to_string())
}

/// Every window open now, then the ones seen lately that are not, newest
/// first - what the tool offers to build rules from.
#[tauri::command]
pub async fn focus_mode_windows(app: AppHandle) -> Vec<FocusWindow> {
    let sidebar = crate::appbar::sidebar_window_handle(&app);
    off_thread(move || {
        let open = open_windows(sidebar);
        record(&open);
        let hidden = HIDDEN.lock().map(|list| list.clone()).unwrap_or_default();
        let stamp = now();
        let mut result: Vec<FocusWindow> = open
            .into_iter()
            .map(|window| FocusWindow {
                id: window.id,
                title: window.title,
                exe: window.exe,
                last_seen: stamp,
                open: true,
                hidden: false,
                stray: false,
            })
            .collect();
        // Hidden windows are not visible, so the listing above skipped them.
        for raw in hidden {
            let hwnd = HWND(raw as *mut c_void);
            let (title, exe) = unsafe { crate::appbar::window_title_and_exe(hwnd) };
            result.push(FocusWindow { id: raw.to_string(), title, exe, last_seen: stamp, open: true, hidden: true, stray: false });
        }
        let (apps, words) = rules();
        for raw in stray_windows(&apps, &words) {
            let hwnd = HWND(raw as *mut c_void);
            let (title, exe) = unsafe { crate::appbar::window_title_and_exe(hwnd) };
            result.push(FocusWindow { id: raw.to_string(), title, exe, last_seen: stamp, open: true, hidden: true, stray: true });
        }
        let showing: std::collections::HashSet<String> =
            result.iter().map(|window| key(&window.exe, &window.title)).collect();
        let mut past: Vec<SeenWindow> = RECENT
            .lock()
            .ok()
            .and_then(|recent| recent.as_ref().map(|map| map.values().cloned().collect()))
            .unwrap_or_default();
        past.retain(|seen| !showing.contains(&key(&seen.exe, &seen.title)));
        past.sort_by_key(|seen| std::cmp::Reverse(seen.last_seen));
        result.extend(past.into_iter().map(|seen| FocusWindow {
            id: String::new(),
            title: seen.title,
            exe: seen.exe,
            last_seen: seen.last_seen,
            open: false,
            hidden: false,
            stray: false,
        }));
        result
    })
    .await
    .unwrap_or_default()
}

/// Hidden top-level windows that match the rules but that Focus mode does not
/// know it hid. Only windows shaped like a taskbar window count - titled,
/// captioned, unowned, not a tool window - which leaves out the countless
/// invisible helper windows every app keeps.
fn stray_windows(apps: &[String], words: &[String]) -> Vec<isize> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowLongW, GetWindowTextLengthW, IsWindowVisible, GWL_EXSTYLE,
        GWL_STYLE, GW_OWNER, WS_CAPTION, WS_EX_TOOLWINDOW,
    };
    unsafe extern "system" fn collect(hwnd: HWND, found: LPARAM) -> BOOL {
        let found = &mut *(found.0 as *mut Vec<isize>);
        let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if !IsWindowVisible(hwnd).as_bool()
            && GetWindowTextLengthW(hwnd) > 0
            && style & WS_CAPTION.0 == WS_CAPTION.0
            && ex & WS_EX_TOOLWINDOW.0 == 0
            && !GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.0.is_null())
        {
            found.push(hwnd.0 as isize);
        }
        true.into()
    }
    if apps.is_empty() && words.is_empty() {
        return Vec::new();
    }
    let mut handles: Vec<isize> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(std::ptr::addr_of_mut!(handles) as isize));
    }
    let known = HIDDEN.lock().map(|list| list.clone()).unwrap_or_default();
    handles
        .into_iter()
        .filter(|raw| !known.contains(raw))
        .filter(|&raw| {
            let (title, exe) = unsafe { crate::appbar::window_title_and_exe(HWND(raw as *mut c_void)) };
            matches(&title, &exe, apps, words)
        })
        .collect()
}

/// Show one hidden window again - one Focus mode hid, or one left behind.
#[tauri::command]
pub async fn focus_mode_show(app: AppHandle, id: String) -> Result<FocusState, String> {
    let raw: isize = id.parse().map_err(|_| "Not a window.".to_string())?;
    let state = off_thread(move || {
        reveal(&[raw]);
        let mut hidden = HIDDEN.lock().unwrap_or_else(|e| e.into_inner());
        hidden.retain(|&known| known != raw);
        remember_hidden(&hidden);
        FocusState { hidden: hidden.len(), message: "The window is back.".into() }
    })
    .await
    .ok_or("Could not reach that window.")?;
    let _ = app.emit("focus-mode:state", state.clone());
    Ok(state)
}

/// A program's icon, for a remembered window whose handle is gone.
#[tauri::command]
pub async fn focus_mode_icon(exe: String) -> Option<String> {
    if exe.is_empty() {
        return None;
    }
    off_thread(move || crate::explorer::thumbnail(exe, 32).ok().flatten()).await.flatten()
}

fn key(exe: &str, title: &str) -> String {
    format!("{}\u{1}{}", exe.to_lowercase(), title)
}

fn load_recent(map: &mut Option<HashMap<String, SeenWindow>>) -> &mut HashMap<String, SeenWindow> {
    map.get_or_insert_with(|| {
        data_file("focus-recent.json")
            .and_then(|file| std::fs::read_to_string(file).ok())
            .and_then(|text| serde_json::from_str::<Vec<SeenWindow>>(&text).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|seen| (key(&seen.exe, &seen.title), seen))
            .collect()
    })
}

/// Note the open windows in the history, keeping the newest few hundred.
/// Written to disk only when a window the history did not have turns up.
fn record(open: &[crate::appbar::OpenWindow]) {
    let mut guard = RECENT.lock().unwrap_or_else(|e| e.into_inner());
    let recent = load_recent(&mut guard);
    let stamp = now();
    let mut added = false;
    for window in open.iter().filter(|window| !window.title.is_empty()) {
        let entry = recent.entry(key(&window.exe, &window.title)).or_insert_with(|| {
            added = true;
            SeenWindow { title: window.title.clone(), exe: window.exe.clone(), last_seen: stamp }
        });
        entry.last_seen = stamp;
    }
    if recent.len() > RECENT_LIMIT {
        let mut stamps: Vec<u64> = recent.values().map(|seen| seen.last_seen).collect();
        stamps.sort_unstable_by(|a, b| b.cmp(a));
        let cutoff = stamps[RECENT_LIMIT - 1];
        recent.retain(|_, seen| seen.last_seen >= cutoff);
    }
    if added {
        let list: Vec<&SeenWindow> = recent.values().collect();
        write_file("focus-recent.json", serde_json::to_string(&list).unwrap_or_default());
    }
}

/// On the way out: nothing may stay hidden once WinT is gone.
pub(crate) fn teardown() {
    reveal_all();
}

/// On start: a WinT that died with windows hidden left their handles behind.
/// Then this thread stays on, noting the open windows every few seconds so
/// the tool's "recent" list covers windows opened while it was not looking.
pub(crate) fn recover() {
    if let Some(file) = data_file("focus-hidden.json") {
        if let Ok(text) = std::fs::read_to_string(&file) {
            let handles: Vec<isize> = serde_json::from_str(&text).unwrap_or_default();
            reveal(&handles);
            let _ = std::fs::remove_file(file);
        }
    }
    loop {
        record(&open_windows(crate::appbar::docked_handle()));
        std::thread::sleep(SAMPLE_EVERY);
    }
}
