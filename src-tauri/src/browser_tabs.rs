//! Which sites each browser profile is actually for.
//!
//! Writing routing rules from nothing means remembering which sites you use
//! and which profile you use them in. Reading that off the machine instead is
//! the difference between a feature somebody configures once and a feature
//! they actually finish setting up: the browsers already know.
//!
//! ## Three sources, weakest claim last
//!
//! * **The address bar of each window**, through UI Automation — the same
//!   accessibility API a screen reader uses. Certainly open and certainly
//!   current, but only the tab in front: a window's background tabs are not
//!   in the accessibility tree as URLs at all.
//! * **Chromium's session file**, `User Data<Profile>SessionsSession_<n>`,
//!   which is what it restores from after a crash and therefore holds every
//!   tab. Undocumented, so the parser is timid: anything it cannot read
//!   confidently it skips. It also lags a few seconds behind reality.
//! * **The profile's history**, which both Chromium and Firefox keep in
//!   SQLite. Not open at all — but the best answer to what a profile is *for*,
//!   which is the question a routing rule actually asks. A site visited forty
//!   times in the work profile belongs there whether a tab is open or not.
//!
//! They are merged rather than chosen between, because each covers what the
//! others miss, and every suggestion says which of them it came from.
//!
//! Nothing is injected, no memory is read and no browser is modified. The
//! history file is locked while the browser runs, so it is copied, read once
//! and deleted.
//!
//! The profile a *window* belongs to comes from its AppUserModelID, which is
//! how the docked sidebar already tells two Chrome profiles apart. A session
//! file and a history file belong to their profile folder directly.
//!
//! ## The window must never block
//!
//! A UI Automation call crosses into another process and waits for it to
//! answer, and a history database is a file copy. A hung browser would
//! therefore hang whatever thread asked. Every one of these runs inside
//! `off_thread`, and the window sweep is bounded: only visible top-level
//! windows belonging to a known browser.

use serde::Serialize;

/// One site, and the browser profile it belongs to.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OpenTab {
    /// The URL, always with a scheme. Chromium's address bar hides `https://`
    /// and so hands one back without it; it is put back here so that what
    /// this returns is a link rather than something that looks like one.
    pub url: String,
    /// The host on its own, which is what a rule is usually written against.
    pub host: String,
    /// The window's title, minus the browser's name at the end of it.
    pub title: String,
    /// The browser and profile it is open in — the same shape a rule's target
    /// has, so a tab can become a rule without anything in between.
    pub exe: String,
    pub browser: String,
    pub profile: Option<String>,
    pub profile_name: Option<String>,
    /// True when this really is a tab that is open right now, false when it
    /// came out of the profile's history. The suggestions say which, because
    /// "you have this open" and "you go here a lot" are different reasons to
    /// agree with a rule.
    pub open: bool,
    /// How often this profile has visited the site. Zero for an open tab
    /// that history has nothing to say about.
    pub visits: u32,
}

/// Every browser window's active tab, one entry per window.
///
/// Empty off Windows, and empty rather than an error when UI Automation is
/// unavailable: a suggestion that cannot be made is not a failure the user
/// needs told about, it just means the list has nothing in it.
#[tauri::command]
pub async fn browser_open_tabs() -> Vec<OpenTab> {
    crate::off_thread(read_tabs).await.unwrap_or_default()
}

#[cfg(not(windows))]
fn read_tabs() -> Vec<OpenTab> {
    Vec::new()
}

/// A URL as the address bar gave it back, made into a real one.
///
/// Chromium shows `example.com/path` for an https page and `http://x` for an
/// insecure one, and shows a search phrase when that is what has been typed.
/// Anything that is not recognisably a web address is dropped rather than
/// guessed at: a rule written from a half-typed search term would match
/// nothing and confuse everything.
fn normalize(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 2048 {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Some(raw.to_string());
    }
    // Any other scheme is a page this cannot route anyway — `about:blank`,
    // `chrome://settings`, `file:///…`, an extension's own page.
    if lower.contains("://") || lower.starts_with("about:") || lower.starts_with("data:") {
        return None;
    }
    // What is left should look like `host[/path]`. A space means it is a
    // search, and a dotless first segment means it is not a host.
    let head = raw.split(['/', '?', '#']).next().unwrap_or(raw);
    if head.contains(' ') || !head.contains('.') || head.starts_with('.') || head.ends_with('.') {
        return None;
    }
    Some(format!("https://{raw}"))
}

/// The page's own title, without the browser's name that Windows puts on the
/// end of every one of its windows.
fn clean_title(title: &str, browser: &str) -> String {
    let mut title = title.trim();
    // Edge writes its window title as
    // `<page> and 4 more pages - <profile> - Microsoft Edge`. Each tail is
    // taken off in turn, longest-lived first, and only where it is really
    // there — a page whose own title ends in "Microsoft Edge" keeps it.
    for suffix in [format!(" - {browser}"), format!(" — {browser}")] {
        if let Some(head) = title.strip_suffix(suffix.as_str()) {
            title = head.trim_end();
            break;
        }
    }
    // What is left may still carry the profile Edge names and its tab count.
    // The profile is already known from the AppUserModelID, so it adds
    // nothing here and only makes the row longer.
    if let Some(cut) = title.rfind(" and ") {
        let tail = &title[cut + 5..];
        let counted = tail
            .split_whitespace()
            .next()
            .is_some_and(|count| !count.is_empty() && count.chars().all(|c| c.is_ascii_digit()));
        if counted && (tail.ends_with(" more page") || tail.ends_with(" more pages")) {
            title = title[..cut].trim_end();
        }
    }
    title.to_string()
}

#[cfg(windows)]
fn read_tabs() -> Vec<OpenTab> {
    use std::ffi::c_void;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation,
        UIA_ControlTypePropertyId, UIA_EditControlTypeId,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible,
    };

    // The browsers worth walking, by exe stem. Anything else on the desktop
    // is not a browser and its Edit controls are not address bars.
    let known: Vec<(String, String, String)> = crate::browser_rules::installed_browsers()
        .into_iter()
        .map(|browser| {
            let stem = std::path::Path::new(&browser.exe)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_ascii_lowercase();
            (stem, browser.exe, browser.name)
        })
        .collect();
    if known.is_empty() {
        return Vec::new();
    }

    // Collect the window handles first, so nothing that can block is done
    // inside the enumeration callback.
    let mut windows: Vec<isize> = Vec::new();
    unsafe extern "system" fn collect(hwnd: HWND, param: LPARAM) -> BOOL {
        unsafe {
            if IsWindowVisible(hwnd).as_bool() && GetWindowTextLengthW(hwnd) > 0 {
                let found = &mut *(param.0 as *mut Vec<isize>);
                found.push(hwnd.0 as isize);
            }
        }
        true.into()
    }
    unsafe {
        let _ = EnumWindows(
            Some(collect),
            LPARAM(&mut windows as *mut Vec<isize> as isize),
        );
    }

    let _apartment = crate::com::Apartment::single_threaded();
    let automation: IUIAutomation =
        match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
            Ok(automation) => automation,
            // No UI Automation on this machine. Nothing to suggest from, and
            // nothing worth saying about it.
            Err(_) => return Vec::new(),
        };
    let Ok(is_edit) = (unsafe {
        automation.CreatePropertyCondition(
            UIA_ControlTypePropertyId,
            &VARIANT::from(UIA_EditControlTypeId.0),
        )
    }) else {
        return Vec::new();
    };

    let mut tabs: Vec<OpenTab> = Vec::new();
    for raw in windows {
        let hwnd = HWND(raw as *mut c_void);
        let exe = unsafe { crate::appbar::window_exe(hwnd) };
        let stem = std::path::Path::new(&exe)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase();
        let Some((_, browser_exe, browser_name)) =
            known.iter().find(|(known, _, _)| known == &stem)
        else {
            continue;
        };

        let Some(url) = read_url(&automation, &is_edit, hwnd) else {
            continue;
        };
        let Some(host) = crate::browser_rules::host_of(&url) else {
            continue;
        };

        // Which profile's window this is. The sidebar already works this out
        // from the AppUserModelID, so a second answer is not invented here.
        let (profile, profile_name) = unsafe { crate::appbar::window_app_id(hwnd) }
            .and_then(|aumid| crate::appbar::browser_profile(&exe, &aumid))
            .map(|(dir, name)| (Some(dir), name))
            .unwrap_or((None, None));

        let mut title = vec![0u16; 512];
        let len = unsafe { GetWindowTextW(hwnd, &mut title) } as usize;
        let title = clean_title(
            &String::from_utf16_lossy(&title[..len.min(title.len())]),
            browser_name,
        );

        // Two windows on the same page in the same profile is one suggestion,
        // not two.
        if tabs.iter().any(|tab| {
            tab.url == url && tab.exe.eq_ignore_ascii_case(browser_exe) && tab.profile == profile
        }) {
            continue;
        }
        tabs.push(OpenTab {
            url,
            host,
            title,
            exe: browser_exe.clone(),
            browser: browser_name.clone(),
            profile,
            profile_name,
            open: true,
            visits: 0,
        });
    }
    // Three readings of the same machine, weakest claim last:
    //
    //  * the address bar of each window - certainly open, certainly current;
    //  * Chromium's session file - every tab, including the ones behind the
    //    one showing, though it lags a few seconds behind reality;
    //  * the profile's history - not open at all, but the best answer to
    //    what a profile is actually *for*, which is the question a routing
    //    rule asks.
    //
    // Merged rather than chosen between, because each covers what the others
    // miss. A URL seen by more than one keeps the strongest claim: open beats
    // history, and a visit count is kept wherever it was found.
    let mut all = tabs;
    for tab in session_tabs(&known).into_iter().chain(history_tabs(&known)) {
        match all.iter_mut().find(|known| {
            known.host == tab.host
                && known.exe.eq_ignore_ascii_case(&tab.exe)
                && known.profile == tab.profile
        }) {
            Some(found) => {
                found.open = found.open || tab.open;
                found.visits = found.visits.max(tab.visits);
                if found.title.is_empty() {
                    found.title = tab.title;
                }
            }
            None => all.push(tab),
        }
    }
    // Open first, then by how much the profile uses the site: the order the
    // suggestions are worth agreeing with.
    all.sort_by(|a, b| {
        b.open
            .cmp(&a.open)
            .then_with(|| b.visits.cmp(&a.visits))
            .then_with(|| a.host.cmp(&b.host))
    });
    all
}

/// The URL out of one browser window's address bar.
///
/// The address bar is the first Edit descendant holding something that reads
/// as a web address. Searching by name would need the localized name of the
/// control in whatever language Windows is in; searching by what the value
/// looks like does not.
#[cfg(windows)]
fn read_url(
    automation: &windows::Win32::UI::Accessibility::IUIAutomation,
    is_edit: &windows::Win32::UI::Accessibility::IUIAutomationCondition,
    hwnd: windows::Win32::Foundation::HWND,
) -> Option<String> {
    use windows::Win32::UI::Accessibility::{
        IUIAutomationValuePattern, TreeScope_Descendants, UIA_ValuePatternId,
    };

    let element = unsafe { automation.ElementFromHandle(hwnd) }.ok()?;
    let edits = unsafe { element.FindAll(TreeScope_Descendants, is_edit) }.ok()?;
    let count = unsafe { edits.Length() }.ok()?;
    // A browser window has one or two Edit controls; a cap keeps a window
    // that somehow has hundreds from costing anything noticeable.
    for index in 0..count.min(8) {
        let Ok(edit) = (unsafe { edits.GetElement(index) }) else {
            continue;
        };
        let Ok(pattern) =
            (unsafe { edit.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) })
        else {
            continue;
        };
        let Ok(value) = (unsafe { pattern.CurrentValue() }) else {
            continue;
        };
        if let Some(url) = normalize(&value.to_string()) {
            return Some(url);
        }
    }
    None
}


// ---- every tab, not just the one showing ------------------------------------
//
// UI Automation can only reach the address bar, which holds the tab in front.
// The rest of a window's tabs are not in the accessibility tree as URLs at all
// — the tab strip exposes their titles and nothing more.
//
// Chromium does write them down, though: `User Data\<Profile>\Sessions\
// Session_<n>` is the file it restores from after a crash, and it holds a
// navigation record per tab. It is an undocumented format and this parser is
// deliberately timid about it — anything it cannot read confidently it skips,
// and a file it cannot make sense of at all yields nothing rather than
// guesses. The address-bar read stays regardless, so a browser whose session
// file is unreadable still contributes the tab in front of the user.
//
// The file also lags: Chromium flushes session updates every few seconds, so a
// tab opened a moment ago may not be in it yet.

/// `SNSS`, the magic every session file starts with.
const SNSS_MAGIC: &[u8; 4] = b"SNSS";
/// The command that records where a tab has navigated to. Its payload is a
/// pickle: the tab's id, the entry index, then the URL.
const COMMAND_UPDATE_TAB_NAVIGATION: u8 = 6;
/// The command that records a tab being closed. Without honouring it, every
/// tab closed since the browser started would be suggested as though it were
/// still open.
const COMMAND_TAB_CLOSED: u8 = 16;

/// A reader over the little-endian, 4-byte-aligned encoding Chromium's
/// `Pickle` uses. Every read is checked; running off the end is an ordinary
/// outcome for a file being written while it is read.
struct Pickle<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Pickle<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }

    fn u32(&mut self) -> Option<u32> {
        let end = self.at.checked_add(4)?;
        let value = u32::from_le_bytes(self.bytes.get(self.at..end)?.try_into().ok()?);
        self.at = end;
        Some(value)
    }

    /// A pickled string: a length, the bytes, then padding to the next
    /// four-byte boundary.
    fn string(&mut self) -> Option<String> {
        let len = self.u32()? as usize;
        // A session file holds URLs, not documents. A length beyond this is a
        // misread rather than a very long address.
        if len > 64 * 1024 {
            return None;
        }
        let end = self.at.checked_add(len)?;
        let text = String::from_utf8_lossy(self.bytes.get(self.at..end)?).into_owned();
        self.at = end + (4 - (len % 4)) % 4;
        Some(text)
    }
}

/// Every URL Chromium's session file says this profile has open, newest
/// navigation per tab.
fn session_urls(profile_dir: &std::path::Path) -> Vec<String> {
    let Some(file) = newest_session_file(profile_dir) else {
        return Vec::new();
    };
    let Ok(bytes) = std::fs::read(&file) else {
        return Vec::new();
    };
    // Magic, then a version this does not otherwise care about.
    if bytes.len() < 8 || &bytes[..4] != SNSS_MAGIC {
        return Vec::new();
    }
    let mut at = 8usize;
    // Latest navigation per tab, and the tabs that have since been closed.
    let mut latest: Vec<(u32, u32, String)> = Vec::new();
    let mut closed: Vec<u32> = Vec::new();
    while at + 2 <= bytes.len() {
        let size = u16::from_le_bytes([bytes[at], bytes[at + 1]]) as usize;
        at += 2;
        if size == 0 || at + size > bytes.len() {
            break;
        }
        let command = &bytes[at..at + size];
        at += size;
        let Some((id, payload)) = command.split_first() else {
            continue;
        };
        match *id {
            COMMAND_UPDATE_TAB_NAVIGATION => {
                let mut pickle = Pickle::new(payload);
                // The pickle's own length header, then the fields.
                if pickle.u32().is_none() {
                    continue;
                }
                let Some(tab) = pickle.u32() else { continue };
                let Some(index) = pickle.u32() else { continue };
                let Some(url) = pickle.string() else { continue };
                if !url.starts_with("http://") && !url.starts_with("https://") {
                    continue;
                }
                // One entry per tab: a tab that has been navigated five times
                // is one tab showing the fifth page, not five suggestions.
                match latest.iter_mut().find(|(known, _, _)| *known == tab) {
                    Some(entry) if entry.1 <= index => *entry = (tab, index, url),
                    Some(_) => {}
                    None => latest.push((tab, index, url)),
                }
            }
            COMMAND_TAB_CLOSED => {
                let mut pickle = Pickle::new(payload);
                if pickle.u32().is_none() {
                    continue;
                }
                if let Some(tab) = pickle.u32() {
                    closed.push(tab);
                }
            }
            _ => {}
        }
    }
    latest
        .into_iter()
        .filter(|(tab, _, _)| !closed.contains(tab))
        .map(|(_, _, url)| url)
        .collect()
}

/// The session file Chromium is currently writing: the newest `Session_*` in
/// the profile's `Sessions` folder.
fn newest_session_file(profile_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut best: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for entry in std::fs::read_dir(profile_dir.join("Sessions")).ok()?.flatten() {
        let path = entry.path();
        if !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("Session_"))
        {
            continue;
        }
        let Ok(when) = entry.metadata().and_then(|meta| meta.modified()) else {
            continue;
        };
        if best.as_ref().map_or(true, |(known, _)| when > *known) {
            best = Some((when, path));
        }
    }
    best.map(|(_, path)| path)
}

/// Every tab of every Chromium profile on this PC, from the session files.
///
/// Attributed by profile folder rather than by window, because a session file
/// belongs to a profile and says nothing about which window a tab is in —
/// which is exactly the attribution a routing rule needs anyway.
#[cfg(windows)]
fn session_tabs(known: &[(String, String, String)]) -> Vec<OpenTab> {
    let mut found = Vec::new();
    for (_, exe, name) in known {
        if crate::browser_rules::kind_of(exe) != "chromium" {
            continue;
        }
        for data in crate::appbar::user_data_dirs(exe) {
            let Ok(entries) = std::fs::read_dir(&data) else {
                continue;
            };
            let before = found.len();
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let dir = entry.file_name().to_string_lossy().into_owned();
                if dir != "Default" && !dir.starts_with("Profile ") {
                    continue;
                }
                let profile_name = crate::appbar::profile_name(&data, &dir);
                for url in session_urls(&path) {
                    let Some(host) = crate::browser_rules::host_of(&url) else {
                        continue;
                    };
                    found.push(OpenTab {
                        url,
                        host,
                        title: String::new(),
                        exe: exe.clone(),
                        browser: name.clone(),
                        profile: Some(dir.clone()),
                        profile_name: profile_name.clone(),
                        open: true,
                        visits: 0,
                    });
                }
            }
            // The first user-data folder that really had profiles in it is
            // this install's; the rest of the candidates are other browsers.
            if found.len() > before {
                break;
            }
        }
    }
    found
}

// ---- what this profile is actually used for ---------------------------------
//
// The session file says what is open now. History says what a profile is *for*,
// which is the better question when the job is proposing routing rules: a site
// visited forty times in the work profile belongs there whether or not a tab
// happens to be open on it this minute.
//
// Both browsers keep it in SQLite, which this app already links. The file is
// locked while the browser runs, so it is copied first — a few megabytes, read
// once, off-thread, and deleted straight after.

/// How far back to look. Long enough to cover a working week off, short enough
/// that a site somebody stopped using is not still shaping their routing.
const HISTORY_DAYS: i64 = 60;
/// Per profile. Enough to cover what anyone actually uses; the rows are
/// grouped by host afterwards, so this is far more than the suggestions shown.
const HISTORY_ROWS: usize = 600;

/// Chromium counts microseconds from 1601; Unix counts seconds from 1970.
const EPOCH_OFFSET_MICROS: i64 = 11_644_473_600_000_000;

fn unix_micros_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_micros() as i64)
        .unwrap_or_default()
}

/// Read one history database, whatever shape it is in.
///
/// `since` is in the units that database uses, and the query names its own
/// columns, because Chromium and Firefox agree on nothing but SQLite.
fn read_history(db: &std::path::Path, query: &str, since: i64) -> Vec<(String, String, u32)> {
    if !db.is_file() {
        return Vec::new();
    }
    // The browser holds the file open and locked. Copying it is the supported
    // way to read one, and it is what every history viewer does.
    let Ok(temp) = tempfile::Builder::new().prefix("wint-history").tempdir() else {
        return Vec::new();
    };
    let copy = temp.path().join("history.db");
    if std::fs::copy(db, &copy).is_err() {
        return Vec::new();
    }
    // A WAL means the newest visits are in a side file; without it they are
    // simply missing, which is a smaller problem than failing to open.
    for side in ["-wal", "-shm"] {
        let mut from = db.as_os_str().to_os_string();
        from.push(side);
        let mut to = copy.as_os_str().to_os_string();
        to.push(side);
        let _ = std::fs::copy(from, to);
    }
    let Ok(connection) = rusqlite::Connection::open(&copy) else {
        return Vec::new();
    };
    let Ok(mut statement) = connection.prepare(query) else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([since, HISTORY_ROWS as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            row.get::<_, i64>(2)?.clamp(0, i64::from(u32::MAX)) as u32,
        ))
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok).collect()
}

/// Every Chromium and Firefox profile's history, as tabs.
///
/// `visits` carries how often the site was opened, which is what makes one
/// suggestion more worth agreeing with than another.
fn history_tabs(known: &[(String, String, String)]) -> Vec<OpenTab> {
    const CHROMIUM_QUERY: &str = "SELECT url, title, visit_count FROM urls \
         WHERE last_visit_time > ?1 AND visit_count > 0 \
         ORDER BY visit_count DESC LIMIT ?2";
    const FIREFOX_QUERY: &str = "SELECT url, title, visit_count FROM moz_places \
         WHERE last_visit_date > ?1 AND visit_count > 0 \
         ORDER BY visit_count DESC LIMIT ?2";

    let cutoff_unix = unix_micros_now() - HISTORY_DAYS * 24 * 60 * 60 * 1_000_000;
    let mut found = Vec::new();
    for (_, exe, name) in known {
        let kind = crate::browser_rules::kind_of(exe);
        let profiles: Vec<(std::path::PathBuf, String, Option<String>)> = match kind.as_str() {
            "chromium" => chromium_profile_dirs(exe),
            "firefox" => firefox_profile_dirs(exe),
            _ => Vec::new(),
        };
        for (dir, profile, profile_name) in profiles {
            let (db, query, since) = match kind.as_str() {
                "chromium" => (
                    dir.join("History"),
                    CHROMIUM_QUERY,
                    cutoff_unix + EPOCH_OFFSET_MICROS,
                ),
                _ => (dir.join("places.sqlite"), FIREFOX_QUERY, cutoff_unix),
            };
            for (url, title, visits) in read_history(&db, query, since) {
                let Some(host) = crate::browser_rules::host_of(&url) else {
                    continue;
                };
                found.push(OpenTab {
                    url,
                    host,
                    title,
                    exe: exe.clone(),
                    browser: name.clone(),
                    profile: Some(profile.clone()),
                    profile_name: profile_name.clone(),
                    open: false,
                    visits,
                });
            }
        }
    }
    found
}

/// Every Chromium profile folder of one install, with the names to call them.
fn chromium_profile_dirs(exe: &str) -> Vec<(std::path::PathBuf, String, Option<String>)> {
    #[cfg(not(windows))]
    {
        let _ = exe;
        return Vec::new();
    }
    #[cfg(windows)]
    {
        let mut found = Vec::new();
        for data in crate::appbar::user_data_dirs(exe) {
            let Ok(entries) = std::fs::read_dir(&data) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let dir = entry.file_name().to_string_lossy().into_owned();
                if dir != "Default" && !dir.starts_with("Profile ") {
                    continue;
                }
                let name = crate::appbar::profile_name(&data, &dir);
                found.push((path, dir, name));
            }
            if !found.is_empty() {
                break;
            }
        }
        found
    }
}

/// The same for Firefox, whose profiles are named in an ini file and live in
/// folders whose names nobody would recognise.
fn firefox_profile_dirs(exe: &str) -> Vec<(std::path::PathBuf, String, Option<String>)> {
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return Vec::new();
    };
    let stem = std::path::Path::new(exe)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    let vendor: &str = match stem.as_str() {
        "librewolf" => "librewolf",
        "waterfox" => "Waterfox",
        "zen" => "zen",
        "floorp" => "Floorp",
        _ => r"Mozilla\Firefox",
    };
    let root = std::path::PathBuf::from(&appdata).join(vendor);
    let Ok(text) = std::fs::read_to_string(root.join("profiles.ini")) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for block in text.split('[') {
        if !block.starts_with("Profile") {
            continue;
        }
        let value = |key: &str| {
            block
                .lines()
                .find_map(|line| line.strip_prefix(key).map(|value| value.trim().to_string()))
        };
        let (Some(name), Some(path)) = (value("Name="), value("Path=")) else {
            continue;
        };
        // `IsRelative=0` means an absolute path; anything else is under the
        // profiles root.
        let dir = if value("IsRelative=").as_deref() == Some("0") {
            std::path::PathBuf::from(&path)
        } else {
            root.join(path.replace('/', "\\"))
        };
        if dir.is_dir() {
            found.push((dir, name.clone(), Some(name)));
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_bar_value_becomes_a_real_link() {
        assert_eq!(
            normalize("example.com/a/b"),
            Some("https://example.com/a/b".into())
        );
        assert_eq!(
            normalize("https://x.com/home"),
            Some("https://x.com/home".into())
        );
        assert_eq!(
            normalize("http://localhost.dev:3000"),
            Some("http://localhost.dev:3000".into())
        );
    }

    #[test]
    fn anything_that_is_not_a_link_is_dropped() {
        // A half-typed search, an internal page, an empty bar.
        assert_eq!(normalize("how to write a rule"), None);
        assert_eq!(normalize("chrome://settings"), None);
        assert_eq!(normalize("about:blank"), None);
        assert_eq!(normalize("  "), None);
        // No dot, so not a host — `localhost` alone is not routable either.
        assert_eq!(normalize("localhost:3000"), None);
    }

    #[test]
    fn the_browsers_name_comes_off_the_title() {
        assert_eq!(
            clean_title("Inbox (3) - Google Chrome", "Google Chrome"),
            "Inbox (3)"
        );
        assert_eq!(clean_title("Inbox (3)", "Google Chrome"), "Inbox (3)");
        // Edge's tab count comes off too, but only when it really is one.
        assert_eq!(
            clean_title("Inbox and 4 more pages - Microsoft Edge", "Microsoft Edge"),
            "Inbox"
        );
        assert_eq!(
            clean_title("Fry and more pages of chips", "Google Chrome"),
            "Fry and more pages of chips"
        );
    }
}
