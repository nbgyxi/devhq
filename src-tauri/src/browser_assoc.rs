//! Telling Windows that WinT is a web browser.
//!
//! WinT does not render a page. What it is, once Windows hands it an `http:`
//! or `https:` link, is the thing that decides *which* browser — and which
//! profile of it — the link belongs in. `browser_rules` makes that decision;
//! this module is only the part that gets the link delivered here at all.
//!
//! The split is the same as `torrent_assoc`, and for the same reason:
//!
//! * **Registering** writes the handler under `HKEY_CURRENT_USER\Software\
//!   Classes` and `…\Software\Clients\StartMenuInternet`, and lists WinT in
//!   `RegisteredApplications`. That is this user's own hive — no elevation,
//!   nobody else on the machine affected — and it is what makes WinT *appear*
//!   in Windows' "Default apps → Web browser" list at all.
//! * **Being the default** is not ours. Since Windows 10 the `UserChoice` key
//!   is signed by the shell, and an application that writes it is ignored or
//!   reset. So `choose_default` does the only honest thing: it opens the page
//!   where Windows lets the user pick, with WinT named, and `status` reads
//!   back what they chose.
//!
//! A browser needs more than a ProgID. Without the `StartMenuInternet` client
//! key and `URLAssociations` for both `http` and `https`, Windows will not
//! offer the app under "Web browser" no matter what else is registered.
//!
//! Nothing here runs on the thread that draws the window: every command is
//! `async` and does its registry work on `off_thread`.

use serde::Serialize;

/// The handler WinT owns for a web link. Prefixed, because a ProgID is a
/// machine-wide namespace.
const PROGID_URL: &str = "WinT.Url";
/// The client key Windows reads to know WinT is a browser at all.
const CLIENT: &str = r"Software\Clients\StartMenuInternet\WinT";
/// Where the Default apps page looks for what WinT-as-a-browser claims.
const CAPABILITIES: &str = r"Software\Clients\StartMenuInternet\WinT\Capabilities";
/// The name under `RegisteredApplications`. Deliberately not `WinT`, which
/// `torrent_assoc` already owns for a different set of capabilities.
const REGISTERED: &str = "WinT.Browser";

/// What Windows currently thinks, as the Browser tool shows it.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Assoc {
    /// The handler is written, and points at *this* copy of wint.exe.
    pub registered: bool,
    /// Another WinT registered itself; registering again points the keys here.
    pub other_exe: Option<String>,
    /// Windows opens `http:` links with WinT.
    pub default_http: bool,
    /// Windows opens `https:` links with WinT.
    pub default_https: bool,
    /// What opens them instead, when it is not WinT.
    pub http_owner: Option<String>,
    pub https_owner: Option<String>,
    /// Whether this user has already answered the one-time default question.
    pub asked: bool,
    /// False off Windows, where none of this exists.
    pub supported: bool,
}

/// Read what is registered and what the user has chosen.
#[tauri::command]
pub async fn browser_assoc_status() -> Assoc {
    crate::off_thread(status).await.unwrap_or_default()
}

/// Write the handler into this user's hive. Returns the state afterwards, so
/// the page never has to ask a second time.
#[tauri::command]
pub async fn browser_assoc_register() -> Result<Assoc, String> {
    crate::off_thread(|| register().map(|()| status()))
        .await
        .unwrap_or_else(|| Err("Registering WinT as a browser timed out.".into()))
}

/// Take the handler back out, for a user who would rather WinT did not appear
/// among the browsers at all.
#[tauri::command]
pub async fn browser_assoc_unregister() -> Result<Assoc, String> {
    crate::off_thread(|| unregister().map(|()| status()))
        .await
        .unwrap_or_else(|| Err("Removing the browser handler timed out.".into()))
}

/// Go as far towards being the default as Windows still allows: register, then
/// open Default apps at WinT so the user can make the choice that is theirs.
///
/// The Settings page is a window with a person in front of it, so this must
/// never be given a deadline or run anywhere near the thread that draws the
/// window.
#[tauri::command]
pub async fn browser_assoc_choose_default() -> Result<Assoc, String> {
    crate::off_thread(|| {
        set_asked();
        register()?;
        settings_page()?;
        Ok(status())
    })
    .await
    .unwrap_or_else(|| Err("Setting WinT as the default browser timed out.".into()))
}

/// Whether to put the question to the user on the way up.
///
/// `registered` is the proof that the Browser tool has been opened at least
/// once — nothing else writes it — so an install that never asked to route
/// links is never asked about links.
#[tauri::command]
pub async fn browser_assoc_should_ask() -> bool {
    crate::off_thread(|| {
        let assoc = status();
        assoc.supported
            && assoc.registered
            && !(assoc.default_http && assoc.default_https)
            && !asked()
    })
    .await
    .unwrap_or(false)
}

/// Remember that the question was answered. The answer itself does not matter:
/// changing this later belongs in the Browser tool, not in another prompt.
#[tauri::command]
pub async fn browser_assoc_mark_asked() {
    crate::off_thread(set_asked).await;
}

#[cfg(not(windows))]
fn status() -> Assoc {
    Assoc::default()
}

#[cfg(not(windows))]
fn register() -> Result<(), String> {
    Err("Browser associations are only supported on Windows.".into())
}

#[cfg(not(windows))]
fn unregister() -> Result<(), String> {
    Err("Browser associations are only supported on Windows.".into())
}

#[cfg(not(windows))]
fn asked() -> bool {
    true
}

#[cfg(not(windows))]
fn settings_page() -> Result<(), String> {
    Err("Browser associations are only supported on Windows.".into())
}

#[cfg(not(windows))]
fn set_asked() {}

#[cfg(windows)]
use imp::{asked, register, set_asked, settings_page, status, unregister};

#[cfg(windows)]
mod imp {
    use super::{Assoc, CAPABILITIES, CLIENT, PROGID_URL, REGISTERED};
    use crate::reg::{delete_tree, delete_value, get_sz, set_sz};
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::System::Registry::HKEY_CURRENT_USER;
    use windows::Win32::UI::Shell::{
        SHChangeNotify, ShellExecuteW, SHCNE_ASSOCCHANGED, SHCNF_IDLIST,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn hkcu_set(sub: &str, name: Option<&str>, value: &str) -> Result<(), String> {
        set_sz(HKEY_CURRENT_USER, sub, name, value)
    }

    fn hkcu_get(sub: &str, name: Option<&str>) -> Option<String> {
        get_sz(HKEY_CURRENT_USER, sub, name)
    }

    fn exe() -> Result<String, String> {
        std::env::current_exe()
            .map(|path| path.display().to_string())
            .map_err(|e| format!("Could not find WinT's exe: {e}"))
    }

    /// `"C:\...\wint.exe" "%1"` — the URL as one quoted argument, because a
    /// link is full of characters a bare argument would not survive.
    fn open_command(exe: &str) -> String {
        format!("\"{exe}\" \"%1\"")
    }

    pub fn register() -> Result<(), String> {
        let exe = exe()?;
        let command = open_command(&exe);
        let icon = format!("\"{exe}\",0");

        // The ProgID: what a URL association actually points at.
        let key = format!(r"Software\Classes\{PROGID_URL}");
        hkcu_set(&key, None, "WinT web link")?;
        // Present at all is what marks a protocol handler; the contents are
        // never read.
        hkcu_set(&key, Some("URL Protocol"), "")?;
        hkcu_set(&format!(r"{key}\DefaultIcon"), None, &icon)?;
        hkcu_set(&format!(r"{key}\shell\open\command"), None, &command)?;

        // The client key. Without this Windows does not consider WinT a
        // browser, and never offers it under "Web browser" however complete
        // the rest of the registration is.
        hkcu_set(CLIENT, None, "WinT")?;
        hkcu_set(&format!(r"{CLIENT}\DefaultIcon"), None, &icon)?;
        hkcu_set(
            &format!(r"{CLIENT}\shell\open\command"),
            None,
            &format!("\"{exe}\""),
        )?;

        hkcu_set(CAPABILITIES, Some("ApplicationName"), "WinT")?;
        hkcu_set(CAPABILITIES, Some("ApplicationIcon"), &icon)?;
        hkcu_set(
            CAPABILITIES,
            Some("ApplicationDescription"),
            "Sends each link to the browser and profile you chose for it, and asks when it is a site with no rule yet.",
        )?;
        hkcu_set(
            &format!(r"{CAPABILITIES}\StartMenu"),
            Some("StartMenuInternet"),
            "WinT",
        )?;
        for scheme in ["http", "https"] {
            hkcu_set(
                &format!(r"{CAPABILITIES}\URLAssociations"),
                Some(scheme),
                PROGID_URL,
            )?;
        }
        hkcu_set(
            r"Software\RegisteredApplications",
            Some(REGISTERED),
            CAPABILITIES,
        )?;

        notify_shell();
        Ok(())
    }

    pub fn unregister() -> Result<(), String> {
        delete_tree(HKEY_CURRENT_USER, &format!(r"Software\Classes\{PROGID_URL}"))?;
        delete_tree(HKEY_CURRENT_USER, CLIENT)?;
        delete_value(
            HKEY_CURRENT_USER,
            r"Software\RegisteredApplications",
            REGISTERED,
        );
        notify_shell();
        Ok(())
    }

    /// Explorer caches associations per process. Without this, the change
    /// would only be noticed at the next sign-in.
    fn notify_shell() {
        unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
    }

    /// The ProgID the shell records once the user has picked. Read, never
    /// written: writing `UserChoice` is what a hijacker does, and Windows
    /// undoes it.
    fn user_choice(scheme: &str) -> Option<String> {
        hkcu_get(
            &format!(
                r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\{scheme}\UserChoice"
            ),
            Some("ProgId"),
        )
    }

    /// A ProgID in words the user would recognise, for saying what has the
    /// scheme instead of WinT. Falls back to the ProgID, which is at least a
    /// name they can search for.
    fn owner_name(progid: &str) -> Option<String> {
        if progid.is_empty() {
            return None;
        }
        let label = hkcu_get(&format!(r"Software\Classes\{progid}"), None).unwrap_or_default();
        Some(if label.trim().is_empty() {
            progid.to_string()
        } else {
            label
        })
    }

    pub fn status() -> Assoc {
        let command = hkcu_get(
            &format!(r"Software\Classes\{PROGID_URL}\shell\open\command"),
            None,
        );
        let expected = exe().map(|exe| open_command(&exe)).unwrap_or_default();
        let (registered, other_exe) = match command.as_deref() {
            None | Some("") => (false, None),
            Some(found) if found.eq_ignore_ascii_case(&expected) => (true, None),
            // Registered, but by another copy of WinT. Counted as not
            // registered, because a link would open that one.
            Some(found) => (false, Some(found.to_string())),
        };

        let http = user_choice("http").unwrap_or_default();
        let https = user_choice("https").unwrap_or_default();
        let default_http = registered && http == PROGID_URL;
        let default_https = registered && https == PROGID_URL;

        Assoc {
            registered,
            other_exe,
            default_http,
            default_https,
            http_owner: if default_http { None } else { owner_name(&http) },
            https_owner: if default_https {
                None
            } else {
                owner_name(&https)
            },
            asked: asked(),
            supported: true,
        }
    }

    /// Windows' own Default apps page, opened directly at WinT.
    pub fn settings_page() -> Result<(), String> {
        // WinT is registered in HKCU, so Windows requires registeredAppUser.
        // ShellExecute dispatches the URI to Settings itself; handing it to
        // explorer.exe can open an ordinary folder window instead.
        let verb = HSTRING::from("open");
        let uri = HSTRING::from(format!(
            "ms-settings:defaultapps?registeredAppUser={REGISTERED}"
        ));
        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(verb.as_ptr()),
                PCWSTR(uri.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if result.0 as isize <= 32 {
            Err(format!(
                "Windows could not open Default apps (shell error {}).",
                result.0 as isize
            ))
        } else {
            Ok(())
        }
    }

    /// Kept in WinT's own key because it is read on the way up and must be
    /// shared by every window.
    pub fn asked() -> bool {
        hkcu_get(r"Software\WinT", Some("BrowserDefaultAsk")).is_some()
    }

    pub fn set_asked() {
        let _ = hkcu_set(r"Software\WinT", Some("BrowserDefaultAsk"), "answered");
    }
}
