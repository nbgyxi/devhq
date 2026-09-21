//! Suggested apps for the sidebar's right-click window.
//!
//! Windows already counts how often every app is started and when it last
//! was: Explorer keeps that under `UserAssist` in the user's registry, for the
//! Start menu's own "most used" list. Each value's name is the app (an exe
//! path, a shortcut, or a Store app's AppUserModelID) in ROT13, and its data
//! carries the run count and the last run as a FILETIME. Apps with open
//! windows are left out: they are already on the rail.
//!
//! Everything here reads the registry or the shell namespace, so it is only
//! called off-thread.

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    /// The name the Start menu shows for it.
    pub name: String,
    /// A path, or an AppUserModelID; handed back to start it.
    pub target: String,
    pub runs: u32,
    /// Seconds since 1970, or 0 when Windows never wrote the time down.
    pub last_used: u64,
}

/// How many are worth offering.
const LIMIT: usize = 12;

/// Explorer's two UserAssist lists: programs started directly, and shortcuts.
const COUNT_KEYS: [&str; 2] = [
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist\{CEBFF5CD-ACE2-4F4F-9178-9926F41749EA}\Count",
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist\{F4E57C4B-2036-45F0-A9AB-443BCFE33D9F}\Count",
];

/// Paths are stored under a known-folder GUID rather than a drive letter.
const KNOWN_FOLDERS: [(&str, &str); 8] = [
    ("{6D809377-6AF0-444B-8957-A3773F02200E}", "ProgramW6432"),
    ("{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}", "ProgramFiles(x86)"),
    ("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}", r"SystemRoot\System32"),
    ("{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}", r"SystemRoot\SysWOW64"),
    ("{F38BF404-1D43-42F2-9305-67DE0B28FC23}", "SystemRoot"),
    ("{0139D44E-6AFE-49F2-8690-3DAFCAE6FFB8}", r"ProgramData\Microsoft\Windows\Start Menu\Programs"),
    ("{A77F5D77-2E2B-44C3-A6A2-ABA601054A51}", r"APPDATA\Microsoft\Windows\Start Menu\Programs"),
    ("{9E3995AB-1F9C-4F13-B827-48B24B6C7174}", r"APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned"),
];

/// Housekeeping that shows up in the counts but nobody means to reopen.
const NOISE: [&str; 12] = [
    "ueme_", "explorer.exe", "setup", "install", "unins", "update", "logonui", "searchhost",
    "shellexperiencehost", "startmenuexperiencehost", "wint.exe", "consent.exe",
];

fn rot13(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            'a'..='z' => (((c as u8 - b'a') + 13) % 26 + b'a') as char,
            'A'..='Z' => (((c as u8 - b'A') + 13) % 26 + b'A') as char,
            _ => c,
        })
        .collect()
}

fn expand_known_folder(name: &str) -> String {
    for (guid, var) in KNOWN_FOLDERS {
        if let Some(rest) = name.strip_prefix(guid) {
            let (var, tail) = var.split_once('\\').unwrap_or((var, ""));
            let Some(base) = std::env::var_os(var) else { return name.to_string() };
            let mut path = std::path::PathBuf::from(base);
            if !tail.is_empty() {
                path.push(tail);
            }
            return format!("{}{rest}", path.display());
        }
    }
    name.to_string()
}

fn is_path(target: &str) -> bool {
    target.len() > 2 && target.as_bytes()[1] == b':'
}

/// Every counted app: (target, runs, last run in unix seconds).
fn read_counts() -> Vec<(String, u32, u64)> {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Foundation::{ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    };
    let mut found = Vec::new();
    for sub in COUNT_KEYS {
        unsafe {
            let mut key = HKEY::default();
            if RegOpenKeyExW(HKEY_CURRENT_USER, &HSTRING::from(sub), Some(0), KEY_READ, &mut key)
                != ERROR_SUCCESS
            {
                continue;
            }
            for index in 0.. {
                let mut name = [0u16; 1024];
                let mut name_len = name.len() as u32;
                let mut data = [0u8; 128];
                let mut data_len = data.len() as u32;
                let status = RegEnumValueW(
                    key,
                    index,
                    Some(PWSTR(name.as_mut_ptr())),
                    &mut name_len,
                    None,
                    None,
                    Some(data.as_mut_ptr()),
                    Some(&mut data_len),
                );
                if status == ERROR_NO_MORE_ITEMS {
                    break;
                }
                // The Windows 7+ layout is 72 bytes; anything shorter is a
                // header or an older record.
                if status != ERROR_SUCCESS || data_len < 68 {
                    continue;
                }
                let runs = u32::from_le_bytes(data[4..8].try_into().unwrap());
                let filetime = u64::from_le_bytes(data[60..68].try_into().unwrap());
                let last = (filetime / 10_000_000).saturating_sub(11_644_473_600);
                let target =
                    expand_known_folder(&rot13(&String::from_utf16_lossy(&name[..name_len as usize])));
                found.push((target, runs, last));
            }
            let _ = RegCloseKey(key);
        }
    }
    found
}

/// The shell's display name for a path or an AppUserModelID, and its icon.
/// `None` when the shell no longer knows it: uninstalled, or moved.
pub(crate) unsafe fn shell_item(target: &str) -> Option<(String, Option<String>)> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHParseDisplayName, SHFILEINFOW, SHGFI_DISPLAYNAME, SHGFI_ICON,
        SHGFI_LARGEICON, SHGFI_PIDL,
    };
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;
    let parse = if is_path(target) {
        target.to_string()
    } else {
        format!(r"shell:AppsFolder\{target}")
    };
    let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
    SHParseDisplayName(&HSTRING::from(parse), None, &mut pidl, 0, None).ok()?;
    let mut info = SHFILEINFOW::default();
    let got = SHGetFileInfoW(
        PCWSTR(pidl as *const u16),
        Default::default(),
        Some(&mut info),
        std::mem::size_of::<SHFILEINFOW>() as u32,
        SHGFI_PIDL | SHGFI_DISPLAYNAME | SHGFI_ICON | SHGFI_LARGEICON,
    );
    CoTaskMemFree(Some(pidl as *const _));
    if got == 0 {
        return None;
    }
    let len = info.szDisplayName.iter().position(|&c| c == 0).unwrap_or(0);
    let name = String::from_utf16_lossy(&info.szDisplayName[..len]);
    let icon = if info.hIcon.is_invalid() {
        None
    } else {
        let url = crate::appbar::icon_to_data_url(info.hIcon);
        let _ = DestroyIcon(info.hIcon);
        url
    };
    let name = name
        .strip_suffix(".exe")
        .or_else(|| name.strip_suffix(".lnk"))
        .unwrap_or(&name)
        .to_string();
    (!name.is_empty()).then_some((name, icon))
}

/// The apps most likely to be wanted next: started often, and recently,
/// weighted so last week's habit beats last year's. `running` holds the
/// lowercased exe paths and AppUserModelIDs of open windows, which are left
/// out.
pub fn suggestions(running: &std::collections::HashSet<String>) -> Vec<Suggestion> {
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        );
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let running_stems: std::collections::HashSet<String> = running
        .iter()
        .filter_map(|app| std::path::Path::new(app).file_stem())
        .map(|stem| stem.to_string_lossy().into_owned())
        .collect();

    let mut counted = read_counts();
    counted.retain(|(target, runs, last)| {
        let lower = target.to_ascii_lowercase();
        let stem = std::path::Path::new(&lower)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        (*runs > 0 || *last > 0)
            && !NOISE.iter().any(|noise| lower.contains(noise))
            && !running.contains(&lower)
            && !(lower.ends_with(".exe") && running_stems.contains(&stem))
            && (!is_path(target) || std::path::Path::new(target).exists())
    });
    let score = |runs: u32, last: u64| {
        let days = now.saturating_sub(last) as f64 / 86_400.0;
        f64::from(runs).ln_1p() + 4.0 / (1.0 + days)
    };
    counted.sort_by(|a, b| score(b.1, b.2).total_cmp(&score(a.1, a.2)));

    // The same app is often counted two or three times over - by its exe, by
    // its Start menu shortcut and by its AppUserModelID. Entries that come
    // down to the same exe are one app: it keeps its best rank and takes the
    // shortcut's name, which is the one the Start menu shows ("Paint.NET",
    // not "paintdotnet"). Anything else is told apart by name.
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut out: Vec<Suggestion> = Vec::new();
    for (target, runs, last) in counted.into_iter().take(LIMIT * 6) {
        let lower = target.to_ascii_lowercase();
        let exe = if lower.ends_with(".lnk") {
            unsafe { shortcut_target(&target) }.map(|path| path.to_ascii_lowercase())
        } else if lower.ends_with(".exe") {
            Some(lower.clone())
        } else {
            None
        };
        if let Some(exe) = &exe {
            let stem = std::path::Path::new(exe)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            if running.contains(exe) || running_stems.contains(&stem) {
                continue;
            }
        }
        let Some((name, _)) = (unsafe { shell_item(&target) }) else { continue };
        let name_key = format!("name:{}", name.to_lowercase());
        let exe_key = exe.map(|exe| format!("exe:{exe}"));
        let known = seen
            .get(&name_key)
            .or_else(|| exe_key.as_ref().and_then(|key| seen.get(key)))
            .copied();
        let index = match known {
            Some(index) => {
                if lower.ends_with(".lnk") {
                    out[index].name = name.clone();
                    out[index].target = target;
                }
                out[index].runs = out[index].runs.max(runs);
                out[index].last_used = out[index].last_used.max(last);
                index
            }
            None => {
                if running_stems.contains(&name.to_lowercase()) {
                    continue;
                }
                out.push(Suggestion { name: name.clone(), target, runs, last_used: last });
                out.len() - 1
            }
        };
        seen.insert(format!("name:{}", out[index].name.to_lowercase()), index);
        seen.insert(name_key, index);
        if let Some(key) = exe_key {
            seen.insert(key, index);
        }
    }
    out.truncate(LIMIT);
    out
}

/// The program a `.lnk` shortcut starts, or `None` when it is not a plain
/// program shortcut (an advertised installer shortcut, a URL).
unsafe fn shortcut_target(lnk: &str) -> Option<String> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER, STGM_READ};
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
    link.cast::<IPersistFile>().ok()?.Load(&HSTRING::from(lnk), STGM_READ).ok()?;
    let mut buffer = [0u16; 1024];
    link.GetPath(&mut buffer, std::ptr::null_mut(), 0).ok()?;
    let len = buffer.iter().position(|&c| c == 0).unwrap_or(0);
    let path = String::from_utf16_lossy(&buffer[..len]);
    path.to_ascii_lowercase().ends_with(".exe").then_some(path)
}

/// A suggestion's icon, asked for one at a time so the names show first.
pub fn icon(target: &str) -> Option<String> {
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        );
        shell_item(target).and_then(|(_, icon)| icon)
    }
}

/// Start a suggestion: an exe directly, anything else (a shortcut, a Store
/// app) the way Explorer would.
pub fn launch(target: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    let mut command = if is_path(target) && target.to_ascii_lowercase().ends_with(".exe") {
        let mut command = std::process::Command::new(target);
        if let Some(dir) = std::path::Path::new(target).parent() {
            command.current_dir(dir);
        }
        command
    } else {
        let mut command = std::process::Command::new("explorer.exe");
        command.arg(if is_path(target) {
            target.to_string()
        } else {
            format!(r"shell:AppsFolder\{target}")
        });
        command
    };
    command
        .creation_flags(DETACHED_PROCESS)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not start it: {e}"))
}
