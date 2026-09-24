//! The handful of registry calls the association modules share.
//!
//! Small on purpose. Everything here takes the root key explicitly, because
//! the difference between `HKEY_CURRENT_USER` and `HKEY_LOCAL_MACHINE` is the
//! difference between "what this user chose" and "what is installed on this
//! machine", and a helper that picked one for you would hide that.
//!
//! Nothing here goes near the thread that draws the window on its own: the
//! callers are all inside `off_thread`.

use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS};
use windows::Win32::System::Registry::{
    RegCloseKey, RegDeleteKeyValueW, RegDeleteTreeW, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW,
    RegSetKeyValueW, HKEY, KEY_READ, REG_SZ, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
};

/// `RegSetKeyValueW` creates the subkey it is given, so this is the only
/// writer needed. `name` is `None` for a key's own default value.
pub fn set_sz(root: HKEY, sub: &str, name: Option<&str>, value: &str) -> Result<(), String> {
    let sub_h = HSTRING::from(sub);
    let name_h = name.map(HSTRING::from);
    let value_h = HSTRING::from(value);
    // What Windows wants is bytes, including the terminator.
    let bytes = ((value_h.len() + 1) * 2) as u32;
    unsafe {
        RegSetKeyValueW(
            root,
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

/// One string value, or nothing. `REG_EXPAND_SZ` is accepted and expanded,
/// because half the `shell\open\command` values on a machine are written with
/// `%ProgramFiles%` in them and a path with a literal `%` in it opens nothing.
pub fn get_sz(root: HKEY, sub: &str, name: Option<&str>) -> Option<String> {
    let sub_h = HSTRING::from(sub);
    let name_h = name.map(HSTRING::from);
    let mut buf = vec![0u16; 2048];
    let mut size = (buf.len() * 2) as u32;
    let result = unsafe {
        RegGetValueW(
            root,
            PCWSTR(sub_h.as_ptr()),
            name_h
                .as_ref()
                .map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr())),
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
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

pub fn delete_tree(root: HKEY, sub: &str) -> Result<(), String> {
    let sub_h = HSTRING::from(sub);
    let result = unsafe { RegDeleteTreeW(root, PCWSTR(sub_h.as_ptr())) };
    if result == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    result
        .ok()
        .map_err(|e| format!("Could not remove {sub}: {e}"))
}

/// Missing is the expected case on a fresh install; there is nothing to report
/// either way.
pub fn delete_value(root: HKEY, sub: &str, name: &str) {
    let sub_h = HSTRING::from(sub);
    let name_h = HSTRING::from(name);
    let _ = unsafe { RegDeleteKeyValueW(root, PCWSTR(sub_h.as_ptr()), PCWSTR(name_h.as_ptr())) };
}

/// The names of the immediate subkeys of one key, in registry order. An empty
/// list for a key that is not there, which is the ordinary answer for a hive
/// that simply has nothing installed under it.
pub fn subkeys(root: HKEY, sub: &str) -> Vec<String> {
    let sub_h = HSTRING::from(sub);
    let mut key = HKEY::default();
    let opened = unsafe { RegOpenKeyExW(root, PCWSTR(sub_h.as_ptr()), None, KEY_READ, &mut key) };
    if opened != ERROR_SUCCESS {
        return Vec::new();
    }
    let mut names = Vec::new();
    let mut index = 0u32;
    loop {
        // 256 is the registry's own limit on a key name, plus the terminator.
        let mut buf = [0u16; 257];
        let mut len = buf.len() as u32;
        let result = unsafe {
            RegEnumKeyExW(
                key,
                index,
                Some(PWSTR(buf.as_mut_ptr())),
                &mut len,
                None,
                None,
                None,
                None,
            )
        };
        if result == ERROR_MORE_DATA {
            // Cannot happen at 257 wide characters, but skipping one entry
            // beats stopping the whole enumeration on it.
            index += 1;
            continue;
        }
        if result != ERROR_SUCCESS {
            break;
        }
        names.push(String::from_utf16_lossy(&buf[..len as usize]));
        index += 1;
    }
    unsafe { let _ = RegCloseKey(key); };
    names
}
