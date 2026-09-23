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
        register()?;
        take_default()?;
        // Nothing left to ask: the legacy write was enough.
        let after = status();
        if after.default_file && after.default_magnet {
            return Ok(after);
        }
        ask_windows(&after)?;
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
            && !asked_never()
    })
    .await
    .unwrap_or(false)
}

/// Remember the answer to that question. `never` is the difference between
/// "not now" — asked again next start, which is the point of asking at start
/// — and "stop asking me".
#[tauri::command]
pub async fn torrent_assoc_stop_asking(never: bool) {
    crate::off_thread(move || set_asked_never(never)).await;
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
fn take_default() -> Result<(), String> {
    Err("File associations are only supported on Windows.".into())
}

#[cfg(not(windows))]
fn ask_windows(_assoc: &Assoc) -> Result<(), String> {
    Err("File associations are only supported on Windows.".into())
}

#[cfg(not(windows))]
fn asked_never() -> bool {
    true
}

#[cfg(not(windows))]
fn set_asked_never(_never: bool) {}

#[cfg(windows)]
use imp::{
    ask_windows, asked_never, register, set_asked_never, status, take_default, unregister,
};

#[cfg(windows)]
mod imp {
    use super::{Assoc, CAPABILITIES, PROGID_FILE, PROGID_MAGNET};
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegDeleteKeyValueW, RegDeleteTreeW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER,
        REG_SZ, RRF_RT_REG_SZ,
    };
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::UI::Shell::{
        SHChangeNotify, SHOpenWithDialog, OAIF_REGISTER_EXT, OPENASINFO, OPEN_AS_INFO_FLAGS,
        SHCNE_ASSOCCHANGED, SHCNF_IDLIST,
    };

    /// `OAIF_FORCE_ASSOCIATION_UI`. Documented, and the one flag that matters
    /// here, but missing from the Win32 metadata the `windows` crate is
    /// generated from - so it is written out rather than imported.
    const OAIF_FORCE_ASSOCIATION_UI: OPEN_AS_INFO_FLAGS = OPEN_AS_INFO_FLAGS(0x10);

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
                name_h.as_ref().map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr())),
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
                name_h.as_ref().map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr())),
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
        result.ok().map_err(|e| format!("Could not remove {sub}: {e}"))
    }

    fn delete_value(sub: &str, name: &str) {
        let sub_h = HSTRING::from(sub);
        let name_h = HSTRING::from(name);
        // Missing is the expected case on a fresh install; there is nothing
        // to report either way.
        let _ = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, PCWSTR(sub_h.as_ptr()), PCWSTR(name_h.as_ptr())) };
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
        set_sz(r"Software\Classes\.torrent\OpenWithProgids", Some(PROGID_FILE), "")?;
        set_sz(r"Software\Classes\.torrent", Some("Content Type"), "application/x-bittorrent")?;

        // What the Default apps page reads. Without the Capabilities keys and
        // the RegisteredApplications entry, WinT is not something the user
        // can pick there at all.
        set_sz(CAPABILITIES, Some("ApplicationName"), "WinT")?;
        set_sz(
            CAPABILITIES,
            Some("ApplicationDescription"),
            "Opens torrent files and magnet links in WinT's Torrents tool.",
        )?;
        set_sz(&format!(r"{CAPABILITIES}\FileAssociations"), Some(".torrent"), PROGID_FILE)?;
        set_sz(&format!(r"{CAPABILITIES}\URLAssociations"), Some("magnet"), PROGID_MAGNET)?;
        set_sz(r"Software\RegisteredApplications", Some("WinT"), CAPABILITIES)?;

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
        Some(if label.trim().is_empty() { progid.to_string() } else { label })
    }

    pub fn status() -> Assoc {
        let command = get_sz(&format!(r"Software\Classes\{PROGID_FILE}\shell\open\command"), None);
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
            file_owner: if default_file { None } else { owner_name(&file_choice) },
            magnet_owner: if default_magnet { None } else { owner_name(&magnet_choice) },
            supported: true,
        }
    }

    /// Where the value `.torrent` and `magnet` had before WinT took them is
    /// kept, so that giving them back is possible.
    const BACKUP: &str = r"Software\WinT\AssociationBackup";

    /// The association every torrent client used before `UserChoice` existed,
    /// and which still decides the matter for a type the user has never been
    /// asked about. Writing it is not a hijack: it loses to any explicit
    /// choice, silently, which is exactly the behaviour wanted.
    pub fn take_default() -> Result<(), String> {
        let command = open_command(&exe()?);

        // .torrent: the extension key's default value names the ProgID.
        let previous = get_sz(r"Software\Classes\.torrent", None).unwrap_or_default();
        if !previous.is_empty() && previous != PROGID_FILE {
            set_sz(BACKUP, Some(".torrent"), &previous)?;
        }
        set_sz(r"Software\Classes\.torrent", None, PROGID_FILE)?;

        // magnet: a protocol has no ProgID indirection - the scheme key *is*
        // the handler, so what is replaced is the command itself.
        let previous =
            get_sz(r"Software\Classes\magnet\shell\open\command", None).unwrap_or_default();
        if !previous.is_empty() && !previous.eq_ignore_ascii_case(&command) {
            set_sz(BACKUP, Some("magnet"), &previous)?;
        }
        set_sz(r"Software\Classes\magnet", None, "URL:Magnet Protocol")?;
        set_sz(r"Software\Classes\magnet", Some("URL Protocol"), "")?;
        set_sz(r"Software\Classes\magnet\shell\open\command", None, &command)?;

        notify_shell();
        Ok(())
    }

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
            let _ = set_sz(r"Software\Classes\magnet\shell\open\command", None, &previous);
        } else if get_sz(r"Software\Classes\magnet\shell\open\command", None)
            .is_some_and(|found| found.to_ascii_lowercase().contains("wint.exe"))
        {
            let _ = delete_tree(r"Software\Classes\magnet");
        }
        let _ = delete_tree(BACKUP);
    }

    /// A file for the shell's picker to be about. `SHOpenWithDialog` asks
    /// about a *file* and reads nothing but its extension - but it shows the
    /// name, so the name is written to be read by whoever it is shown to.
    fn sample_torrent() -> Result<std::path::PathBuf, String> {
        let dir = std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .ok_or("Windows did not provide LOCALAPPDATA.")?
            .join("WinT")
            .join("runtime");
        std::fs::create_dir_all(&dir).map_err(|e| format!("Could not prepare the picker: {e}"))?;
        let path = dir.join("Torrent files.torrent");
        if !path.exists() {
            // Enough bencode to be a torrent rather than an empty file, in
            // case anything on the way to the dialog looks inside.
            std::fs::write(&path, b"d4:infod4:name4:WinT12:piece lengthi16384e6:pieces0:eee")
                .map_err(|e| format!("Could not prepare the picker: {e}"))?;
        }
        Ok(path)
    }

    /// The shell's own "How do you want to open this?", with *Always use this
    /// app* on it. This is the furthest an application is allowed to go: the
    /// dialog is the shell's, the choice is the user's, and `UserChoice` is
    /// written by Windows rather than by us.
    ///
    /// Modal. It sits here until somebody answers it, which is why the
    /// command that calls it carries no deadline.
    fn open_with_dialog(path: &std::path::Path) -> Result<(), String> {
        let file = HSTRING::from(path.as_os_str());
        // The dialog is a shell object and wants an apartment. A thread from
        // the blocking pool may never have had one; one that already did
        // answers RPC_E_CHANGED_MODE, which is not an error here - it only
        // means the uninitialise below is somebody else's to do.
        let owned = unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).is_ok()
        };
        let info = OPENASINFO {
            pcszFile: PCWSTR(file.as_ptr()),
            pcszClass: PCWSTR::null(),
            // FORCE_ASSOCIATION_UI is what puts the "always" tick on it.
            // Without it, a type that already has an owner simply opens in
            // that owner and the user is never asked anything.
            oaifInFlags: OAIF_FORCE_ASSOCIATION_UI | OAIF_REGISTER_EXT,
        };
        let result = unsafe { SHOpenWithDialog(None, &info) };
        if owned {
            unsafe { CoUninitialize() };
        }
        result.map_err(|e| format!("Windows would not show the Open with dialog: {e}"))
    }

    /// Rung two, then rung three. Only a type that is still not WinT's is
    /// asked about, so somebody who already has magnet links is asked about
    /// `.torrent` alone.
    pub fn ask_windows(assoc: &Assoc) -> Result<(), String> {
        if !assoc.default_file {
            if let Ok(sample) = sample_torrent() {
                if open_with_dialog(&sample).is_ok() {
                    notify_shell();
                    // They have now been asked in the place Windows keeps the
                    // answer. Whatever they picked stands.
                    if status().default_file {
                        return Ok(());
                    }
                }
            }
        }
        settings_page()
    }

    /// Rung three: Windows' own Default apps page, opened at WinT.
    fn settings_page() -> Result<(), String> {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        // Named, so the page opens on WinT rather than at the top of a list
        // of every app on the machine. Explorer resolves an ms-settings: URI.
        std::process::Command::new("explorer.exe")
            .arg("ms-settings:defaultapps?registeredAppName=WinT")
            .creation_flags(DETACHED_PROCESS)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Could not open Windows' Default apps page: {e}"))
    }

    /// "Stop asking me." Kept in WinT's own key rather than a file, because
    /// it is read on the way up and the registry is already open here.
    pub fn asked_never() -> bool {
        get_sz(r"Software\WinT", Some("TorrentDefaultAsk")).as_deref() == Some("never")
    }

    pub fn set_asked_never(never: bool) {
        if never {
            let _ = set_sz(r"Software\WinT", Some("TorrentDefaultAsk"), "never");
        } else {
            delete_value(r"Software\WinT", "TorrentDefaultAsk");
        }
    }
}
