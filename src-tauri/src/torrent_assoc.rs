//! Telling Windows that WinT opens `.torrent` files and `magnet:` links.
//!
//! Two separate things, and the difference matters because only one of them
//! is ours to decide:
//!
//! * **Registering** writes the handler under `HKEY_CURRENT_USER\Software\
//!   Classes` and lists WinT in `RegisteredApplications`. That is entirely
//!   within this user's own hive — no elevation, no effect on anybody else on
//!   the machine — and it is what makes WinT *appear* in "Open with" and in
//!   Windows' Default apps page.
//! * **Being the default** is not. Since Windows 10 the `UserChoice` key is
//!   signed by the shell, and an application that writes it is ignored or
//!   reset. So `choose_default` does the only honest thing: it opens the page
//!   where Windows lets the user pick, with WinT named, and `status` reads
//!   back what they chose.
//!
//! Nothing here runs on the thread that draws the window: every command is
//! `async` and does its registry work on `off_thread`.

use serde::Serialize;

/// The handler names WinT owns. Prefixed, because a ProgID is a machine-wide
/// namespace and `.torrent` is a name plenty of clients would like.
const PROGID_FILE: &str = "WinT.Torrent";
const PROGID_MAGNET: &str = "WinT.Magnet";
/// Where Windows' Default apps page looks for what WinT claims to handle.
const CAPABILITIES: &str = r"Software\WinT\Capabilities";

/// What Windows currently thinks, as the Settings tab shows it.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Assoc {
    /// The handler is written, and points at *this* copy of wint.exe.
    pub registered: bool,
    /// Another WinT registered itself; registering again points the keys here.
    pub other_exe: Option<String>,
    /// Windows opens `.torrent` files with WinT.
    pub default_file: bool,
    /// Windows opens `magnet:` links with WinT.
    pub default_magnet: bool,
    /// What opens them instead, when it is not WinT.
    pub file_owner: Option<String>,
    pub magnet_owner: Option<String>,
    /// Whether this user has already answered the one-time default question.
    pub asked: bool,
    /// False off Windows, where none of this exists.
    pub supported: bool,
}

/// Read what is registered and what the user has chosen.
#[tauri::command]
pub async fn torrent_assoc_status() -> Assoc {
    crate::off_thread(status).await.unwrap_or_default()
}

/// Write the handler into this user's hive. Returns the state afterwards, so
/// the page never has to ask a second time.
#[tauri::command]
pub async fn torrent_assoc_register() -> Result<Assoc, String> {
    crate::off_thread(|| register().map(|()| status()))
        .await
        .unwrap_or_else(|| Err("Registering torrent files timed out.".into()))
}

/// Take the handler back out, for a user who would rather WinT did not appear
/// in "Open with" at all.
#[tauri::command]
pub async fn torrent_assoc_unregister() -> Result<Assoc, String> {
    crate::off_thread(|| unregister().map(|()| status()))
        .await
        .unwrap_or_else(|| Err("Removing the torrent handler timed out.".into()))
}

/// Try to become the default, going as far as Windows still allows.
///
/// Three rungs, and it stops at the first that works:
///
/// 1. **The legacy association.** Writing the ProgID into
///    `HKCU\Software\Classes\.torrent` and taking over `magnet` is what
///    every torrent client did, and it still works for a type nobody has
///    explicitly chosen an app for. The previous value is kept so undoing
///    this puts it back.
/// 2. **The shell's own picker.** If the type has a signed `UserChoice`, the
///    legacy write is ignored, and the only thing that can change the choice
///    is the user making it. `SHOpenWithDialog` is the "How do you want to
///    open this?" dialog with *Always use this app* on it — one click, in the
///    place Windows expects the click.
/// 3. **The Default apps page**, if even that is refused.
///
/// The dialog is modal and waits for a person, so this must never be given a
/// deadline or run anywhere near the thread that draws the window.
#[tauri::command]
pub async fn torrent_assoc_choose_default() -> Result<Assoc, String> {
    crate::off_thread(|| {
        set_asked();
        register()?;
        // Windows protects the actual choice. Open WinT's own page in
        // Default apps, where the user can assign both entries explicitly.
        settings_page()?;
        Ok(status())
    })
    .await
    .unwrap_or_else(|| Err("Setting WinT as the default timed out.".into()))
}

/// Whether to put the question at startup, the way a torrent client does.
///
/// `registered` is the proxy for "this user has opened Torrents at least
/// once" — nothing else writes it — so an install that never touches torrents
/// is never asked about them.
#[tauri::command]
pub async fn torrent_assoc_should_ask() -> bool {
    crate::off_thread(|| {
        let assoc = status();
        assoc.supported
            && assoc.registered
            && !(assoc.default_file && assoc.default_magnet)
            && !asked()
    })
    .await
    .unwrap_or(false)
}

/// Remember that the question was answered. The answer itself does not
/// matter: changing associations later belongs in the Torrents settings, not
/// in another startup prompt.
#[tauri::command]
pub async fn torrent_assoc_mark_asked() {
    crate::off_thread(set_asked).await;
}

#[cfg(not(windows))]
fn status() -> Assoc {
    Assoc::default()
}

#[cfg(not(windows))]
fn register() -> Result<(), String> {
    Err("File associations are only supported on Windows.".into())
}

#[cfg(not(windows))]
fn unregister() -> Result<(), String> {
    Err("File associations are only supported on Windows.".into())
}

#[cfg(not(windows))]
fn asked() -> bool {
    true
}

#[cfg(not(windows))]
fn settings_page() -> Result<(), String> {
    Err("File associations are only supported on Windows.".into())
}

#[cfg(not(windows))]
fn set_asked() {}

#[cfg(windows)]
use imp::{asked, register, set_asked, settings_page, status, unregister};

#[cfg(windows)]
mod imp {
    use super::{Assoc, CAPABILITIES, PROGID_FILE, PROGID_MAGNET};
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegDeleteKeyValueW, RegDeleteTreeW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER,
        REG_SZ, RRF_RT_REG_SZ,
    };
    use windows::Win32::UI::Shell::{
        SHChangeNotify, ShellExecuteW, SHCNE_ASSOCCHANGED, SHCNF_IDLIST,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    /// `RegSetKeyValueW` creates the subkey it is given, so this is the only
    /// writer needed. `name` is `None` for a key's own default value.
    fn set_sz(sub: &str, name: Option<&str>, value: &str) -> Result<(), String> {
        let sub_h = HSTRING::from(sub);
        let name_h = name.map(HSTRING::from);
        let value_h = HSTRING::from(value);
        // What Windows wants is bytes, including the terminator.
        let bytes = ((value_h.len() + 1) * 2) as u32;
        unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                PCWSTR(sub_h.as_ptr()),
                name_h
                    .as_ref()
                    .map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr())),
                REG_SZ.0,
                Some(value_h.as_ptr().cast()),
                bytes,
            )
        }
        .ok()
        .map_err(|e| format!("Could not write {sub}: {e}"))
    }

    fn get_sz(sub: &str, name: Option<&str>) -> Option<String> {
        let sub_h = HSTRING::from(sub);
        let name_h = name.map(HSTRING::from);
        let mut buf = vec![0u16; 2048];
        let mut size = (buf.len() * 2) as u32;
        let result = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(sub_h.as_ptr()),
                name_h
                    .as_ref()
                    .map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr())),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if result != ERROR_SUCCESS {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }

    fn delete_tree(sub: &str) -> Result<(), String> {
        let sub_h = HSTRING::from(sub);
        let result = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(sub_h.as_ptr())) };
        if result == ERROR_FILE_NOT_FOUND {
            return Ok(());
        }
        result
            .ok()
            .map_err(|e| format!("Could not remove {sub}: {e}"))
    }

    fn delete_value(sub: &str, name: &str) {
        let sub_h = HSTRING::from(sub);
        let name_h = HSTRING::from(name);
        // Missing is the expected case on a fresh install; there is nothing
        // to report either way.
        let _ = unsafe {
            RegDeleteKeyValueW(
                HKEY_CURRENT_USER,
                PCWSTR(sub_h.as_ptr()),
                PCWSTR(name_h.as_ptr()),
            )
        };
    }

    fn exe() -> Result<String, String> {
        std::env::current_exe()
            .map(|path| path.display().to_string())
            .map_err(|e| format!("Could not find WinT's exe: {e}"))
    }

    /// `"C:\...\wint.exe" "%1"` — one argument, quoted, because a torrent
    /// lives in Downloads and half the paths there have a space in them.
    fn open_command(exe: &str) -> String {
        format!("\"{exe}\" \"%1\"")
    }

    pub fn register() -> Result<(), String> {
        let exe = exe()?;
        let command = open_command(&exe);
        let icon = format!("\"{exe}\",0");

        for (progid, label, is_url) in [
            (PROGID_FILE, "BitTorrent file", false),
            (PROGID_MAGNET, "Magnet link", true),
        ] {
            let key = format!(r"Software\Classes\{progid}");
            set_sz(&key, None, label)?;
            set_sz(&format!(r"{key}\DefaultIcon"), None, &icon)?;
            set_sz(&format!(r"{key}\shell\open\command"), None, &command)?;
            // A protocol handler is marked by this value being present at
            // all; what it contains is never read.
            if is_url {
                set_sz(&key, Some("URL Protocol"), "")?;
            }
        }

        // Offers WinT under "Open with" for .torrent without taking the
        // extension over: whatever opens one today still opens one.
        set_sz(
            r"Software\Classes\.torrent\OpenWithProgids",
            Some(PROGID_FILE),
            "",
        )?;
        set_sz(
            r"Software\Classes\.torrent",
            Some("Content Type"),
            "application/x-bittorrent",
        )?;

        // What the Default apps page reads. Without the Capabilities keys and
        // the RegisteredApplications entry, WinT is not something the user
        // can pick there at all.
        set_sz(CAPABILITIES, Some("ApplicationName"), "WinT")?;
        set_sz(
            CAPABILITIES,
            Some("ApplicationDescription"),
            "Opens torrent files and magnet links in WinT's Torrents tool.",
        )?;
        set_sz(
            &format!(r"{CAPABILITIES}\FileAssociations"),
            Some(".torrent"),
            PROGID_FILE,
        )?;
        set_sz(
            &format!(r"{CAPABILITIES}\URLAssociations"),
            Some("magnet"),
            PROGID_MAGNET,
        )?;
        set_sz(
            r"Software\RegisteredApplications",
            Some("WinT"),
            CAPABILITIES,
        )?;

        notify_shell();
        Ok(())
    }

    pub fn unregister() -> Result<(), String> {
        // Before the handler goes, whatever it displaced comes back.
        give_back_default();
        delete_tree(&format!(r"Software\Classes\{PROGID_FILE}"))?;
        delete_tree(&format!(r"Software\Classes\{PROGID_MAGNET}"))?;
        delete_tree(r"Software\WinT\Capabilities")?;
        delete_value(r"Software\Classes\.torrent\OpenWithProgids", PROGID_FILE);
        delete_value(r"Software\RegisteredApplications", "WinT");
        notify_shell();
        Ok(())
    }

    /// Explorer caches associations per process. Without this the icon and
    /// the double-click behaviour would only change at the next sign-in.
    fn notify_shell() {
        unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
    }

    /// The ProgID the shell records once the user has picked — for the
    /// extension, and for the protocol. Read, never written: writing
    /// `UserChoice` is what a hijacker does, and Windows undoes it.
    fn user_choice_file() -> Option<String> {
        get_sz(
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.torrent\UserChoice",
            Some("ProgId"),
        )
    }

    fn user_choice_magnet() -> Option<String> {
        get_sz(
            r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\magnet\UserChoice",
            Some("ProgId"),
        )
    }

    /// A ProgID in words the user would recognise, for saying what has it
    /// instead of WinT. Falls back to the ProgID itself, which is at least a
    /// name they can search for.
    fn owner_name(progid: &str) -> Option<String> {
        if progid.is_empty() {
            return None;
        }
        let label = get_sz(&format!(r"Software\Classes\{progid}"), None).unwrap_or_default();
        Some(if label.trim().is_empty() {
            progid.to_string()
        } else {
            label
        })
    }

    pub fn status() -> Assoc {
        let command = get_sz(
            &format!(r"Software\Classes\{PROGID_FILE}\shell\open\command"),
            None,
        );
        let expected = exe().map(|exe| open_command(&exe)).unwrap_or_default();
        let (registered, other_exe) = match command.as_deref() {
            None | Some("") => (false, None),
            Some(found) if found.eq_ignore_ascii_case(&expected) => (true, None),
            // Registered, but by another copy of WinT. Counted as not
            // registered, because clicking a torrent starts that one.
            Some(found) => (false, Some(found.to_string())),
        };

        let file_choice = user_choice_file().unwrap_or_default();
        let magnet_choice = user_choice_magnet().unwrap_or_default();
        let default_file = registered && file_choice == PROGID_FILE;
        let default_magnet = registered && magnet_choice == PROGID_MAGNET;

        Assoc {
            registered,
            other_exe,
            default_file,
            default_magnet,
            file_owner: if default_file {
                None
            } else {
                owner_name(&file_choice)
            },
            magnet_owner: if default_magnet {
                None
            } else {
                owner_name(&magnet_choice)
            },
            asked: asked(),
            supported: true,
        }
    }

    /// Where the value `.torrent` and `magnet` had before WinT took them is
    /// kept, so that giving them back is possible.
    const BACKUP: &str = r"Software\WinT\AssociationBackup";

    /// Put back whatever had these before WinT did. Anything with no backup
    /// recorded is left alone rather than guessed at.
    fn give_back_default() {
        if let Some(previous) = get_sz(BACKUP, Some(".torrent")) {
            let _ = set_sz(r"Software\Classes\.torrent", None, &previous);
        } else if get_sz(r"Software\Classes\.torrent", None).as_deref() == Some(PROGID_FILE) {
            // WinT put its own name there and displaced nothing; an empty
            // default is what the key looked like before.
            let _ = set_sz(r"Software\Classes\.torrent", None, "");
        }
        if let Some(previous) = get_sz(BACKUP, Some("magnet")) {
            let _ = set_sz(
                r"Software\Classes\magnet\shell\open\command",
                None,
                &previous,
            );
        } else if get_sz(r"Software\Classes\magnet\shell\open\command", None)
            .is_some_and(|found| found.to_ascii_lowercase().contains("wint.exe"))
        {
            let _ = delete_tree(r"Software\Classes\magnet");
        }
        let _ = delete_tree(BACKUP);
    }

    /// Windows' own Default apps page, opened directly at WinT.
    pub fn settings_page() -> Result<(), String> {
        // WinT is registered in HKCU, so Windows requires registeredAppUser.
        // ShellExecute dispatches the URI to Settings itself; passing it to
        // explorer.exe can open an ordinary folder window instead.
        let verb = HSTRING::from("open");
        let uri = HSTRING::from("ms-settings:defaultapps?registeredAppUser=WinT");
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
    /// shared by every window. The old `never` value also means answered.
    pub fn asked() -> bool {
        get_sz(r"Software\WinT", Some("TorrentDefaultAsk")).is_some()
    }

    pub fn set_asked() {
        let _ = set_sz(r"Software\WinT", Some("TorrentDefaultAsk"), "answered");
    }
}
