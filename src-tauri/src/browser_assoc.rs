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

/// One line of the registration, as the Browser tool lists it: what Windows
/// was asked for, and what is there now.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// Plain words, not the key path — the path goes in `where`.
    pub label: String,
    /// The registry location, shown small, because this is the one screen
    /// where a user comparing two machines needs it.
    pub key: String,
    pub ok: bool,
    /// What was read, when something was.
    pub found: Option<String>,
}

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
    /// The copy of wint.exe the keys name, for a machine where a link goes to
    /// a WinT that is not this one.
    pub exe: Option<String>,
    /// This copy runs from an MSIX package. Every registry write it makes goes
    /// into the package's own virtualised hive, which it then reads back
    /// happily while the shell sees none of it — so the checks below can be
    /// green on a machine where Windows will never offer WinT at all. The
    /// claim that counts there is the one in the package manifest.
    pub packaged: bool,
    /// Each piece Windows needs before it will offer WinT for a scheme, read
    /// back one at a time. All true and still not offered is a Windows-side
    /// problem, not a missing key — which is the whole point of showing them.
    pub checks: Vec<Check>,
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
            // A packaged build never writes `registered` anywhere the shell
            // or it can see, so requiring it would mean the Store build was
            // never asked at all.
            && (assoc.registered || assoc.packaged)
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
    use super::{Assoc, Check, CAPABILITIES, CLIENT, PROGID_URL, REGISTERED};
    use crate::reg::{delete_tree, delete_value, get_sz, set_dword, set_sz};
    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Storage::Packaging::Appx::GetCurrentApplicationUserModelId;
    use windows::Win32::System::Registry::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER};
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
        // What Windows' own picker puts next to the entry. Without a friendly
        // name an entry can be left out of the list for a scheme entirely,
        // which looks exactly like not being registered at all.
        hkcu_set(&key, Some("FriendlyTypeName"), "WinT web link")?;
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

        // `InstallInfo` is what every real browser writes and what Windows
        // reads to decide the client is a browser that is *installed* rather
        // than a leftover key. `IconsVisible` is the value it actually looks
        // at; the commands exist because Windows expects the trio, and WinT
        // has no shortcuts of its own to hide or show, so they are harmless
        // no-ops that name this exe.
        let install = format!(r"{CLIENT}\InstallInfo");
        set_dword(HKEY_CURRENT_USER, &install, "IconsVisible", 1)?;
        hkcu_set(&install, Some("ReinstallCommand"), &format!("\"{exe}\""))?;
        hkcu_set(&install, Some("ShowIconsCommand"), &format!("\"{exe}\""))?;
        hkcu_set(&install, Some("HideIconsCommand"), &format!("\"{exe}\""))?;

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
        delete_tree(
            HKEY_CURRENT_USER,
            &format!(r"Software\Classes\{PROGID_URL}"),
        )?;
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

    /// This package's AppUserModelID, or `None` for an unpackaged build —
    /// where the call fails with `ERROR_NO_PACKAGE` and there would be nothing
    /// to compare against anyway.
    fn aumid() -> Option<String> {
        let mut len = 0u32;
        // The first call only asks how long the answer is.
        let _ = unsafe { GetCurrentApplicationUserModelId(&mut len, None) };
        if len == 0 {
            return None;
        }
        let mut buffer = vec![0u16; len as usize];
        if unsafe { GetCurrentApplicationUserModelId(&mut len, Some(PWSTR(buffer.as_mut_ptr()))) }
            .is_err()
        {
            return None;
        }
        buffer.truncate(len.saturating_sub(1) as usize);
        let id = String::from_utf16_lossy(&buffer);
        (!id.is_empty()).then_some(id)
    }

    /// Whether a ProgID the shell recorded in `UserChoice` means *this* WinT.
    ///
    /// Unpackaged, that is the ProgID we wrote. Packaged, it never is: the
    /// shell gives a package's handler a generated `AppX…` ProgID of its own,
    /// so a packaged WinT that really had been chosen would compare unequal to
    /// `WinT.Url` for good and go on reporting itself as not the default — and
    /// on going on asking. The generated key carries the AppUserModelID of the
    /// package behind it, and that is the thing worth comparing; the hash in
    /// its name is not ours to reproduce.
    fn progid_is_ours(progid: &str) -> bool {
        if progid.is_empty() {
            return false;
        }
        if progid.eq_ignore_ascii_case(PROGID_URL) {
            return true;
        }
        let Some(ours) = aumid() else {
            return false;
        };
        get_sz(
            HKEY_CLASSES_ROOT,
            &format!(r"{progid}\Application"),
            Some("AppUserModelID"),
        )
        .is_some_and(|id| id.eq_ignore_ascii_case(&ours))
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
        // `registered` is the proof the keys point here, and it is the right
        // gate for an unpackaged build. For a packaged one it proves nothing —
        // it reads the package's own virtualised hive — so what the shell
        // recorded is allowed to stand on its own there.
        let packaged = packaged();
        let claimed = |progid: &str| (packaged || registered) && progid_is_ours(progid);
        let default_http = claimed(&http);
        let default_https = claimed(&https);

        Assoc {
            registered,
            other_exe,
            default_http,
            default_https,
            http_owner: if default_http {
                None
            } else {
                owner_name(&http)
            },
            https_owner: if default_https {
                None
            } else {
                owner_name(&https)
            },
            asked: asked(),
            exe: exe().ok(),
            packaged,
            checks: checks(&http, &https),
            supported: true,
        }
    }

    /// Running from under `WindowsApps` is what an installed MSIX package
    /// looks like from the inside. The path is the honest test here: an API
    /// that asks the package identity would answer yes for a package that is
    /// merely registered, and what matters is where this exe is.
    fn packaged() -> bool {
        exe().is_ok_and(|path| path.to_ascii_lowercase().contains(r"\windowsapps\"))
    }

    /// Read every piece back rather than trusting that `register` wrote it.
    /// A machine where WinT never appears in the picker is answered by which
    /// of these lines is red — and when none of them is, by the last two,
    /// which say who owns the scheme instead.
    fn checks(http: &str, https: &str) -> Vec<Check> {
        let line = |label: &str, key: String, found: Option<String>, want: Option<&str>| {
            let ok = match (&found, want) {
                (Some(value), Some(want)) => value.eq_ignore_ascii_case(want),
                (Some(_), None) => true,
                (None, _) => false,
            };
            Check {
                label: label.to_string(),
                key,
                ok,
                found,
            }
        };
        let chosen = |label: &str, scheme: &str, progid: &str| Check {
            label: label.to_string(),
            key: format!(r"HKCU\…\UrlAssociations\{scheme}\UserChoice   ProgId"),
            ok: progid_is_ours(progid),
            found: (!progid.is_empty()).then(|| progid.to_string()),
        };
        let progid = format!(r"Software\Classes\{PROGID_URL}");
        vec![
            line(
                "Link handler",
                format!(r"HKCU\{progid}\shell\open\command"),
                hkcu_get(&format!(r"{progid}\shell\open\command"), None),
                None,
            ),
            line(
                "Handler name",
                format!(r"HKCU\{progid}   FriendlyTypeName"),
                hkcu_get(&progid, Some("FriendlyTypeName")),
                None,
            ),
            line(
                "Listed as a browser",
                format!(r"HKCU\{CLIENT}"),
                hkcu_get(CLIENT, None),
                None,
            ),
            line(
                "Counted as installed",
                format!(r"HKCU\{CLIENT}\InstallInfo   ReinstallCommand"),
                hkcu_get(&format!(r"{CLIENT}\InstallInfo"), Some("ReinstallCommand")),
                None,
            ),
            line(
                "Claims http",
                format!(r"HKCU\{CAPABILITIES}\URLAssociations   http"),
                hkcu_get(&format!(r"{CAPABILITIES}\URLAssociations"), Some("http")),
                Some(PROGID_URL),
            ),
            line(
                "Claims https",
                format!(r"HKCU\{CAPABILITIES}\URLAssociations   https"),
                hkcu_get(&format!(r"{CAPABILITIES}\URLAssociations"), Some("https")),
                Some(PROGID_URL),
            ),
            line(
                "Offered in Default apps",
                format!(r"HKCU\Software\RegisteredApplications   {REGISTERED}"),
                hkcu_get(r"Software\RegisteredApplications", Some(REGISTERED)),
                Some(CAPABILITIES),
            ),
            // Not compared against `PROGID_URL` like the lines above: a
            // packaged WinT is recorded under a generated `AppX…` ProgID, so
            // the question is whether the ProgID resolves to this WinT, not
            // whether it is spelled like ours.
            chosen("Windows opens http with", "http", http),
            chosen("Windows opens https with", "https", https),
        ]
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
