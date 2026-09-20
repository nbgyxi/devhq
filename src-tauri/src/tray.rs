//! What Windows has written down about the notification area.
//!
//! The tray's icons cannot be read from Explorer — there is no API that hands
//! them over. What Windows 11 does keep is the list itself: one key per icon
//! under `Control Panel\NotifyIconSettings`, naming the program that
//! registered it, the tooltip it last carried, and whether the icon is
//! promoted onto the taskbar or left in the overflow flyout.
//!
//! The sidebar uses this to draw its own tray; the Startup and tray tool uses
//! it to say where each icon comes from.

use std::collections::HashMap;

use windows::core::{GUID, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};
use windows::Win32::UI::Shell::{SHGetKnownFolderPath, KF_FLAG_DEFAULT};

const SETTINGS: &str = r"Control Panel\NotifyIconSettings";

/// One icon Windows has a record of.
#[derive(Clone)]
pub struct Icon {
    /// Full path of the program that registered it.
    pub exe: String,
    pub tooltip: String,
    /// Whether Windows shows it on the taskbar rather than behind the chevron.
    pub promoted: bool,
}

/// One string value out of one icon's key.
unsafe fn string_value(key: HKEY, sub: &HSTRING, name: &str) -> Option<String> {
    let mut data = [0u16; 1024];
    let mut size = std::mem::size_of_val(&data) as u32;
    if RegGetValueW(
        key,
        PCWSTR(sub.as_ptr()),
        &HSTRING::from(name),
        RRF_RT_REG_SZ,
        None,
        Some(data.as_mut_ptr().cast()),
        Some(&mut size),
    ) != ERROR_SUCCESS
    {
        return None;
    }
    // The size that comes back counts the terminating NUL.
    let chars = (size as usize / 2).saturating_sub(1).min(data.len());
    let text = String::from_utf16_lossy(&data[..chars]);
    (!text.is_empty()).then_some(text)
}

/// A path whose folder part is written as a KNOWNFOLDERID, resolved through
/// the shell rather than assumed.
fn expand(path: String) -> Option<String> {
    let Some((guid, rest)) = path.strip_prefix('{').and_then(|rest| rest.split_once("}\\")) else {
        return (!path.is_empty()).then_some(path);
    };
    let guid = GUID::try_from(guid).ok()?;
    let base = unsafe {
        let path = SHGetKnownFolderPath(&guid, KF_FLAG_DEFAULT, None).ok()?;
        path.to_string().ok()?
    };
    Some(format!("{}\\{rest}", base.trim_end_matches('\\')))
}

/// Every icon the notification area has a record of, newest state first
/// registered last — the order Windows keeps them in, which is nobody's.
pub fn icons() -> Vec<Icon> {
    let mut found = Vec::new();
    unsafe {
        let mut key = HKEY::default();
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            &HSTRING::from(SETTINGS),
            Some(0),
            KEY_READ,
            &mut key,
        ) != ERROR_SUCCESS
        {
            return found;
        }
        for index in 0.. {
            let mut name = [0u16; 256];
            let mut name_len = name.len() as u32;
            if RegEnumKeyExW(
                key,
                index,
                Some(PWSTR(name.as_mut_ptr())),
                &mut name_len,
                None,
                None,
                None,
                None,
            ) != ERROR_SUCCESS
            {
                break;
            }
            let sub = HSTRING::from(String::from_utf16_lossy(&name[..name_len as usize]));
            let Some(exe) = string_value(key, &sub, "ExecutablePath").and_then(expand) else {
                continue;
            };

            let mut promoted = 0u32;
            let mut size = std::mem::size_of::<u32>() as u32;
            let _ = RegGetValueW(
                key,
                PCWSTR(sub.as_ptr()),
                &HSTRING::from("IsPromoted"),
                RRF_RT_REG_DWORD,
                None,
                Some(std::ptr::addr_of_mut!(promoted).cast()),
                Some(&mut size),
            );

            found.push(Icon {
                tooltip: string_value(key, &sub, "InitialTooltip").unwrap_or_default(),
                promoted: promoted != 0,
                exe,
            });
        }
        let _ = RegCloseKey(key);
    }
    // One program can hold several icons, and a packaged app writes a fresh
    // record for every version it has ever run, so the recorded paths differ
    // while the program does not. The file name is what identifies a program
    // across all of that, and promoted anywhere counts as promoted.
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut merged: Vec<Icon> = Vec::new();
    for icon in found {
        let key = std::path::Path::new(&icon.exe)
            .file_name()
            .map(|name| name.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_else(|| icon.exe.to_ascii_lowercase());
        match seen.get(&key) {
            Some(&at) => {
                let existing: &mut Icon = &mut merged[at];
                existing.promoted |= icon.promoted;
                if existing.tooltip.is_empty() {
                    existing.tooltip = icon.tooltip;
                }
            }
            None => {
                seen.insert(key, merged.len());
                merged.push(icon);
            }
        }
    }
    merged
}

/// The same list as a lookup: full path and bare file name, both lowercased,
/// each mapped to whether the icon is promoted.
///
/// The file name is in there because a packaged app's recorded path carries
/// its version, so what Windows wrote down goes stale the moment it updates,
/// while its file name does not.
pub fn lookup() -> HashMap<String, bool> {
    let mut found = HashMap::new();
    for icon in icons() {
        let path = icon.exe.to_ascii_lowercase();
        if let Some(file) = std::path::Path::new(&path).file_name() {
            let file = file.to_string_lossy().into_owned();
            *found.entry(file).or_insert(icon.promoted) |= icon.promoted;
        }
        *found.entry(path).or_insert(icon.promoted) |= icon.promoted;
    }
    found
}
