//! What is open in the browsers on this PC, right now.
//!
//! Writing a routing rule from nothing means remembering which sites you use
//! and which profile you use them in. Reading them off the screen instead is
//! the difference between a feature somebody configures once and a feature
//! they actually finish setting up: the browsers are already open, already
//! sorted into profiles, and already showing exactly the sites worth having a
//! rule for.
//!
//! ## What this can and cannot see
//!
//! **The active tab of each browser window, and nothing else.** There is no
//! way to read a Chromium window's background tabs from outside the process
//! without turning on its remote debugging port, which is not something an
//! app should do to somebody's browser. So a window with twelve tabs
//! contributes the one that is showing.
//!
//! That is a real limit and the UI says so rather than implying a full list.
//! It is also enough: the tab somebody is looking at is a fair sample of what
//! that profile is for.
//!
//! ## How it reads them
//!
//! UI Automation, the same accessibility API a screen reader uses. Each
//! browser window's address bar is an Edit control with a Value pattern, and
//! the value is the URL. Nothing is injected, no memory is read and no
//! browser is modified — this is the supported way to ask a window what it is
//! showing.
//!
//! The profile a window belongs to comes from its AppUserModelID, which is
//! how the docked sidebar already tells two Chrome profiles apart.
//!
//! ## The window must never block
//!
//! A UI Automation call crosses into another process and waits for it to
//! answer. A hung browser would therefore hang whatever thread asked. Every
//! call here is made from `off_thread`, and the whole sweep is bounded: it
//! only looks at visible top-level windows belonging to a known browser.

use serde::Serialize;

/// One browser window's active tab.
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
        });
    }
    // Grouped by where they are open, which is the order the suggestions read
    // best in: everything one profile is being used for, together.
    tabs.sort_by(|a, b| {
        a.browser
            .to_ascii_lowercase()
            .cmp(&b.browser.to_ascii_lowercase())
            .then_with(|| a.profile_name.cmp(&b.profile_name))
            .then_with(|| a.host.cmp(&b.host))
    });

    tabs
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
