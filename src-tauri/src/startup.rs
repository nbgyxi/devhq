//! What starts with Windows, and what sits in the notification area.
//!
//! Two questions that turn out to be the same one. An icon in the tray is a
//! program that was started without being asked for, and the only way to stop
//! it is to find the entry that starts it. So this module reads both lists and
//! matches them up: every startup entry, every recorded tray icon, and which
//! entry each icon comes from.
//!
//! Turning an entry off is done the way Task Manager does it, by writing to
//! `Explorer\StartupApproved` under HKCU rather than deleting anything. The
//! original Run value or shortcut is left exactly where it was, which is what
//! makes this reversible — and what lets a machine-wide entry be switched off
//! for one user without administrator rights.

use serde::Serialize;
use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegEnumValueW, RegGetValueW, RegOpenKeyExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, REG_BINARY,
    REG_OPTION_NON_VOLATILE, RRF_RT_REG_BINARY,
};

/// The Run keys, in the order Windows reads them. Each is (hive, subkey, the
/// name shown for it, and the `StartupApproved` key its switch lives in).
const RUN_KEYS: &[(bool, &str, &str, &str)] = &[
    (
        false,
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        "Run (this user)",
        "Run",
    ),
    (
        true,
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        "Run (all users)",
        "Run",
    ),
    (
        true,
        r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run",
        "Run (all users, 32-bit)",
        "Run32",
    ),
];

const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Stable across reads: where it lives, and what it is called there.
    pub id: String,
    /// The value name, or the shortcut's file name without its extension.
    pub name: String,
    /// Exactly what Windows runs, arguments and all.
    pub command: String,
    /// The program the command starts, when it could be worked out.
    pub exe: String,
    /// What the program calls itself, from its version resource.
    pub description: String,
    /// Where the entry lives, in words.
    pub source: String,
    /// Whether it starts for everyone or only this user.
    pub machine_wide: bool,
    pub enabled: bool,
    /// Whether the program is running right now.
    pub running: bool,
    /// Whether it has an icon recorded in the notification area.
    pub tray: bool,
}

/// One icon the notification area has a record of.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrayIcon {
    pub exe: String,
    pub name: String,
    /// The tooltip Windows last saw on the icon, when it kept one.
    pub tooltip: String,
    /// Whether Windows shows it on the taskbar rather than in the overflow.
    pub promoted: bool,
    pub running: bool,
    /// The startup entry that starts it, when one of them does.
    pub startup_id: Option<String>,
    /// Where it starts from, in a few words.
    pub origin: String,
}

/// A path as the registry holds it, with any `%VARIABLE%` in it filled in.
/// Windows expands these when it runs the entry; a reader that does not is
/// left holding a path that matches nothing and has no icon.
fn expand_env(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut rest = path;
    while let Some(start) = rest.find('%') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else { break };
        let name = &after[..end];
        match std::env::var(name) {
            Ok(value) => {
                out.push_str(&rest[..start]);
                out.push_str(&value);
            }
            // Not a variable at all (a stray percent sign): keep it as it was.
            Err(_) => out.push_str(&rest[..start + 1 + end + 1]),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// The command a Run value holds, reduced to the program it starts.
pub fn command_exe(command: &str) -> String {
    let command = command.trim();
    if let Some(rest) = command.strip_prefix('"') {
        return rest.split('"').next().unwrap_or_default().to_string();
    }
    // Unquoted and with spaces: Windows tries each prefix, and so do we —
    // "C:\Program Files\App\app.exe -tray" has its space inside the path.
    let lower = command.to_ascii_lowercase();
    if let Some(end) = lower.find(".exe") {
        return command[..end + 4].to_string();
    }
    command.split_whitespace().next().unwrap_or_default().to_string()
}

fn open(machine: bool, sub: &str, access: u32) -> Option<HKEY> {
    unsafe {
        let mut key = HKEY::default();
        let hive = if machine { HKEY_LOCAL_MACHINE } else { HKEY_CURRENT_USER };
        (RegOpenKeyExW(
            hive,
            &HSTRING::from(sub),
            Some(0),
            windows::Win32::System::Registry::REG_SAM_FLAGS(access),
            &mut key,
        ) == ERROR_SUCCESS)
            .then_some(key)
    }
}

/// Every value in one Run key: (name, command).
fn run_values(machine: bool, sub: &str) -> Vec<(String, String)> {
    let Some(key) = open(machine, sub, KEY_READ.0) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    unsafe {
        for index in 0.. {
            let mut name = [0u16; 512];
            let mut name_len = name.len() as u32;
            let mut data = [0u16; 2048];
            let mut data_len = std::mem::size_of_val(&data) as u32;
            if RegEnumValueW(
                key,
                index,
                Some(PWSTR(name.as_mut_ptr())),
                &mut name_len,
                None,
                None,
                Some(data.as_mut_ptr().cast()),
                Some(&mut data_len),
            ) != ERROR_SUCCESS
            {
                break;
            }
            let name = String::from_utf16_lossy(&name[..name_len as usize]);
            let chars = (data_len as usize / 2).saturating_sub(1).min(data.len());
            let command = String::from_utf16_lossy(&data[..chars]);
            let command = command.trim_end_matches('\0').to_string();
            if !name.is_empty() && !command.is_empty() {
                found.push((name, command));
            }
        }
        let _ = RegCloseKey(key);
    }
    found
}

/// Windows' own on/off switch for one entry. Absent means never switched off.
fn approved(kind: &str, name: &str) -> bool {
    let Some(key) = open(false, &format!("{APPROVED}\\{kind}"), KEY_READ.0) else {
        return true;
    };
    let mut data = [0u8; 32];
    let mut size = data.len() as u32;
    let status = unsafe {
        RegGetValueW(
            key,
            PCWSTR::null(),
            &HSTRING::from(name),
            RRF_RT_REG_BINARY,
            None,
            Some(data.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    unsafe {
        let _ = RegCloseKey(key);
    }
    if status != ERROR_SUCCESS || size == 0 {
        return true;
    }
    // The first byte is a flag word: the low bit is what Task Manager flips.
    data[0] & 1 == 0
}

/// Flip Windows' own switch for one entry, leaving the entry itself alone.
fn set_approved(kind: &str, name: &str, enabled: bool) -> Result<(), String> {
    unsafe {
        let mut key = HKEY::default();
        let status = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            &HSTRING::from(format!("{APPROVED}\\{kind}")),
            None,
            None,
            REG_OPTION_NON_VOLATILE,
            windows::Win32::System::Registry::REG_SAM_FLAGS(KEY_SET_VALUE.0),
            None,
            &mut key,
            None,
        );
        if status != ERROR_SUCCESS {
            return Err("Windows would not let that switch be written.".into());
        }
        // Enabled is a flag word and nothing else; disabled records when it
        // was switched off, exactly as Task Manager writes it.
        let mut value = [0u8; 12];
        value[0] = if enabled { 2 } else { 3 };
        if !enabled {
            // A FILETIME is 100ns ticks since 1601; the offset to the Unix
            // epoch is the usual 11,644,473,600 seconds.
            let unix = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_secs())
                .unwrap_or_default();
            let ticks = (unix + 11_644_473_600) * 10_000_000;
            value[4..12].copy_from_slice(&ticks.to_le_bytes());
        }
        let status = RegSetValueExW(key, &HSTRING::from(name), None, REG_BINARY, Some(&value));
        let _ = RegCloseKey(key);
        if status != ERROR_SUCCESS {
            return Err("Windows would not let that switch be written.".into());
        }
    }
    Ok(())
}

/// The names of a key's subkeys.
fn sub_keys(machine: bool, sub: &str) -> Vec<String> {
    let Some(key) = open(machine, sub, KEY_READ.0) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    unsafe {
        for index in 0.. {
            let mut name = [0u16; 512];
            let mut len = name.len() as u32;
            if windows::Win32::System::Registry::RegEnumKeyExW(
                key,
                index,
                Some(PWSTR(name.as_mut_ptr())),
                &mut len,
                None,
                None,
                None,
                None,
            ) != ERROR_SUCCESS
            {
                break;
            }
            found.push(String::from_utf16_lossy(&name[..len as usize]));
        }
        let _ = RegCloseKey(key);
    }
    found
}

/// One string value, with any `%VARIABLE%` in it filled in.
fn string_value(machine: bool, sub: &str, name: &str) -> Option<String> {
    let key = open(machine, sub, KEY_READ.0)?;
    let mut data = [0u16; 2048];
    let mut size = std::mem::size_of_val(&data) as u32;
    let status = unsafe {
        RegGetValueW(
            key,
            PCWSTR::null(),
            &HSTRING::from(name),
            windows::Win32::System::Registry::RRF_RT_REG_SZ
                | windows::Win32::System::Registry::RRF_RT_REG_EXPAND_SZ,
            None,
            Some(data.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    unsafe {
        let _ = RegCloseKey(key);
    }
    if status != ERROR_SUCCESS {
        return None;
    }
    let chars = (size as usize / 2).saturating_sub(1).min(data.len());
    let text = expand_env(&String::from_utf16_lossy(&data[..chars]));
    (!text.is_empty()).then_some(text)
}

/// The two Startup folders, as (path, shown name, whether it is for everyone).
fn startup_folders() -> Vec<(std::path::PathBuf, &'static str, bool)> {
    let mut found = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        found.push((
            std::path::PathBuf::from(appdata)
                .join(r"Microsoft\Windows\Start Menu\Programs\Startup"),
            "Startup folder (this user)",
            false,
        ));
    }
    if let Some(common) = std::env::var_os("ProgramData") {
        found.push((
            std::path::PathBuf::from(common)
                .join(r"Microsoft\Windows\Start Menu\Programs\Startup"),
            "Startup folder (all users)",
            true,
        ));
    }
    found
}

/// The program a `.lnk` starts. Startup folders are full of them.
fn shortcut_target(lnk: &std::path::Path) -> Option<String> {
    use windows::core::Interface;
    use windows::Win32::System::Com::{
        CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    unsafe {
        let _apartment = crate::com::Apartment::multi_threaded();
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        link.cast::<IPersistFile>()
            .ok()?
            .Load(&HSTRING::from(lnk.to_string_lossy().as_ref()), STGM_READ)
            .ok()?;
        let mut buffer = [0u16; 1024];
        link.GetPath(&mut buffer, std::ptr::null_mut(), 0).ok()?;
        let len = buffer.iter().position(|&c| c == 0).unwrap_or(0);
        let path = String::from_utf16_lossy(&buffer[..len]);
        (!path.is_empty()).then_some(path)
    }
}

/// Every image name running right now, lowercased.
fn running_images() -> std::collections::HashSet<String> {
    let mut found = std::collections::HashSet::new();
    let Some(text) = crate::util::run_lossy("tasklist", &["/fo", "csv", "/nh"], None) else {
        return found;
    };
    for line in text.lines() {
        if let Some(name) = line.split("\",\"").next() {
            let name = name.trim_matches('"').trim().to_ascii_lowercase();
            if !name.is_empty() {
                found.insert(name);
            }
        }
    }
    found
}

fn file_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Everything that starts with Windows, from the places a user can switch.
pub fn entries() -> Vec<Entry> {
    let running = running_images();
    let tray: std::collections::HashSet<String> = crate::tray::icons()
        .into_iter()
        .map(|icon| file_name(&icon.exe))
        .filter(|name| !name.is_empty())
        .collect();
    let mut found = Vec::new();

    for (machine, sub, label, approval) in RUN_KEYS {
        for (name, command) in run_values(*machine, sub) {
            let exe = expand_env(&command_exe(&command));
            let image = file_name(&exe);
            found.push(Entry {
                id: format!("run:{}:{approval}:{name}", if *machine { "hklm" } else { "hkcu" }),
                description: crate::appbar::exe_description(&exe).unwrap_or_default(),
                running: running.contains(&image),
                tray: tray.contains(&image),
                enabled: approved(approval, &name),
                name,
                command,
                exe,
                source: (*label).to_string(),
                machine_wide: *machine,
            });
        }
    }

    for (folder, label, machine) in startup_folders() {
        let Ok(items) = std::fs::read_dir(&folder) else {
            continue;
        };
        for item in items.flatten() {
            let path = item.path();
            let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if file.eq_ignore_ascii_case("desktop.ini") {
                continue;
            }
            let exe = if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("lnk")) {
                shortcut_target(&path).unwrap_or_default()
            } else {
                path.to_string_lossy().into_owned()
            };
            let image = file_name(&exe);
            found.push(Entry {
                id: format!("folder:{file}"),
                name: path
                    .file_stem()
                    .map(|stem| stem.to_string_lossy().into_owned())
                    .unwrap_or_else(|| file.clone()),
                description: crate::appbar::exe_description(&exe).unwrap_or_default(),
                running: running.contains(&image),
                tray: tray.contains(&image),
                enabled: approved("StartupFolder", &file),
                command: if exe.is_empty() { path.to_string_lossy().into_owned() } else { exe.clone() },
                exe,
                source: label.to_string(),
                machine_wide: machine,
            });
        }
    }

    found.sort_by_key(|entry| entry.name.to_lowercase());
    found
}

/// Turn one entry on or off. The id is the one `entries` gave out.
pub fn set_enabled(id: &str, enabled: bool) -> Result<(), String> {
    if let Some(rest) = id.strip_prefix("run:") {
        let mut parts = rest.splitn(3, ':');
        let (Some(_hive), Some(approval), Some(name)) = (parts.next(), parts.next(), parts.next())
        else {
            return Err("That startup entry is not one this can switch.".into());
        };
        return set_approved(approval, name, enabled);
    }
    if let Some(file) = id.strip_prefix("folder:") {
        return set_approved("StartupFolder", file, enabled);
    }
    Err("That startup entry is not one this can switch.".into())
}

/// The notification area's own list, matched up with what starts it.
pub fn tray_icons() -> Vec<TrayIcon> {
    let running = running_images();
    let entries = entries();
    let mut found: Vec<TrayIcon> = crate::tray::icons()
        .into_iter()
        .map(|icon| {
            let image = file_name(&icon.exe);
            let startup = entries
                .iter()
                .find(|entry| !image.is_empty() && file_name(&entry.exe) == image);
            let is_running = running.contains(&image);
            TrayIcon {
                name: crate::appbar::exe_description(&icon.exe).unwrap_or_else(|| {
                    std::path::Path::new(&icon.exe)
                        .file_stem()
                        .map(|stem| stem.to_string_lossy().into_owned())
                        .unwrap_or_default()
                }),
                // Short enough to sit in a pill. Everything with no startup
                // entry was started by something this cannot switch: a
                // service, a scheduled task, or the user opening it.
                origin: match &startup {
                    Some(entry) => entry.source.clone(),
                    None => "No startup entry".into(),
                },
                startup_id: startup.map(|entry| entry.id.clone()),
                running: is_running,
                exe: icon.exe,
                tooltip: icon.tooltip,
                promoted: icon.promoted,
            }
        })
        .collect();
    // What is in the tray right now comes first; the rest is history — every
    // program that has ever put an icon there, which is worth keeping because
    // it is how something that only appears once a week is found.
    found.sort_by(|a, b| {
        b.running
            .cmp(&a.running)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    found
}

/// One program's own icon, for a row in the tool.
pub fn icon(exe: &str) -> Option<String> {
    crate::appbar::program_icon(exe)
}

/// Close a program that is running now: every process of it, asked politely.
///
/// A window gets `WM_CLOSE`, which is what clicking its X does — the program
/// saves what it needs to and exits on its own terms. A process with no window
/// has nothing to ask, so it is left alone and said so; killing something that
/// cannot be asked is not what a button called Close should do, and the tray
/// app that ignores the request is still switched off for next time.
pub fn close(exe: &str) -> Result<String, String> {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, PostMessageW, WM_CLOSE};
    let wanted = file_name(exe);
    if wanted.is_empty() {
        return Err("There is no program on that entry to close.".into());
    }

    unsafe extern "system" fn collect(hwnd: HWND, found: LPARAM) -> windows::core::BOOL {
        let found = &mut *(found.0 as *mut Vec<isize>);
        found.push(hwnd.0 as isize);
        true.into()
    }
    let mut handles: Vec<isize> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(std::ptr::addr_of_mut!(handles) as isize));
    }

    let mut asked = 0;
    for raw in handles {
        let hwnd = HWND(raw as *mut std::ffi::c_void);
        let owner = unsafe { crate::appbar::window_program(hwnd) };
        if file_name(&owner) != wanted {
            continue;
        }
        // Posted, not sent: a program that stops to ask "save changes?" must
        // not hold this thread while the user decides.
        if unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) }.is_ok() {
            asked += 1;
        }
    }
    if asked > 0 {
        return Ok(format!(
            "Asked {wanted} to close ({asked} window{}).",
            if asked == 1 { "" } else { "s" }
        ));
    }

    // No window to ask. A tray app of the older kind has none — its only
    // window is a message sink, which is not something that can be asked to
    // close — so the process is ended instead. Nothing of this kind holds
    // unsaved work, and the alternative is a Close button that does nothing.
    let mut ended = 0;
    let mut refused = Vec::new();
    for pid in process_ids(&wanted) {
        match crate::procs::kill(pid, "", &wanted) {
            Ok(()) => ended += 1,
            Err(error) => refused.push(error),
        }
    }
    if ended > 0 {
        return Ok(format!(
            "{wanted} had no window to ask, so it was ended ({ended} process{}).",
            if ended == 1 { "" } else { "es" }
        ));
    }
    Err(refused
        .into_iter()
        .next()
        .unwrap_or_else(|| format!("{wanted} is not running any more.")))
}

/// The ids of every process running one program, by image name.
fn process_ids(image: &str) -> Vec<u32> {
    let Some(text) = crate::util::run_lossy("tasklist", &["/fo", "csv", "/nh"], None) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for line in text.lines() {
        // "name.exe","1234","Console","1","12,345 K"
        let mut cells = line.split("\",\"");
        let (Some(name), Some(pid)) = (cells.next(), cells.next()) else {
            continue;
        };
        if !name.trim_matches('"').trim().eq_ignore_ascii_case(image) {
            continue;
        }
        if let Ok(pid) = pid.trim_matches('"').trim().parse::<u32>() {
            found.push(pid);
        }
    }
    found
}

/// What Windows would run to remove a program, from the same Uninstall keys
/// that Apps & features is built from.
///
/// The match is by install location: a program's uninstall entry is the one
/// whose folder the exe sits inside, which is right far more often than
/// matching names is. Nothing here removes anything itself — it starts the
/// vendor's own uninstaller, with its own prompts, exactly as double-clicking
/// it in Apps & features would.
fn uninstall_command(exe: &str) -> Option<(String, String)> {
    const UNINSTALL_KEYS: &[(bool, &str)] = &[
        (false, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
        (true, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
        (true, r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
    ];
    let exe_lower = exe.to_ascii_lowercase();
    let mut best: Option<(usize, String, String)> = None;
    for (machine, sub) in UNINSTALL_KEYS {
        for key in sub_keys(*machine, sub) {
            let path = format!("{sub}\\{key}");
            let Some(command) = string_value(*machine, &path, "UninstallString")
                .or_else(|| string_value(*machine, &path, "QuietUninstallString"))
            else {
                continue;
            };
            let name = string_value(*machine, &path, "DisplayName").unwrap_or_else(|| key.clone());
            let Some(location) = string_value(*machine, &path, "InstallLocation")
                .map(|location| location.trim_end_matches('\\').to_ascii_lowercase())
                .filter(|location| location.len() > 3)
            else {
                continue;
            };
            if !exe_lower.starts_with(&format!("{location}\\")) {
                continue;
            }
            // The deepest install location that still contains the program is
            // the one that belongs to it, not its publisher's parent folder.
            if best.as_ref().map_or(true, |(len, _, _)| location.len() > *len) {
                best = Some((location.len(), name, command));
            }
        }
    }
    best.map(|(_, name, command)| (name, command))
}

/// Start the vendor's uninstaller for a program, or say there is none.
pub fn uninstall(exe: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    let Some((name, command)) = uninstall_command(exe) else {
        // A packaged app has no uninstall entry of its own; Windows' own list
        // is where it is removed from.
        std::process::Command::new("explorer.exe")
            .arg("ms-settings:appsfeatures")
            .spawn()
            .map_err(|e| format!("Could not open Apps & features: {e}"))?;
        return Err("No uninstaller is registered for it — opening Windows' own app list instead.".into());
    };
    // The string is a command line, not a path: it carries its own arguments
    // ("...\unins000.exe" /SILENT), so the shell parses it rather than us.
    std::process::Command::new("cmd.exe")
        .args(["/c", "start", "", &command])
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map_err(|e| format!("Could not start the uninstaller: {e}"))?;
    Ok(format!("Started the uninstaller for {name}. It takes over from here."))
}

/// Show one program in Explorer, selected, so the user can see where it lives.
pub fn reveal(path: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    if path.is_empty() || !std::path::Path::new(path).exists() {
        return Err("That program is not where the entry says it is.".into());
    }
    std::process::Command::new("explorer.exe")
        .arg(format!("/select,{path}"))
        .creation_flags(DETACHED_PROCESS)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open Explorer: {e}"))
}
