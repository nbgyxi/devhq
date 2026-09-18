//! Recent files and folders per app, for the sidebar's right-click menu.
//!
//! Two sources. Windows keeps a recent list for every app that has an
//! AppUserModelID — the one its taskbar jump list shows — and hands it out
//! through the documented `IApplicationDocumentLists`. Apps that keep their
//! history to themselves are read from their own files; so far that is the
//! VS Code family (Code, Code - Insiders, Cursor, Windsurf, ...), whose recent
//! folders live in a SQLite database under `%APPDATA%\<name>\User`.
//!
//! Everything here reads the disk or COM, so it is only called off-thread.

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentItem {
    /// What the menu shows: the file or folder name.
    pub name: String,
    /// The full path, handed back to open it.
    pub path: String,
    pub folder: bool,
}

/// How many of each list are worth a menu line.
const LIMIT: usize = 10;

fn item(path: String) -> RecentItem {
    let p = std::path::Path::new(&path);
    let name = p
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    RecentItem { folder: p.is_dir(), name, path }
}

/// The recent list Windows keeps for this AppUserModelID, newest first.
pub fn jump_list(aumid: &str) -> Vec<RecentItem> {
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Shell::Common::IObjectArray;
    use windows::Win32::UI::Shell::{
        ApplicationDocumentLists, IApplicationDocumentLists, IShellItem, IShellLinkW, ADLT_RECENT,
        SIGDN_FILESYSPATH,
    };
    let mut found = Vec::new();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(lists) = CoCreateInstance::<_, IApplicationDocumentLists>(
            &ApplicationDocumentLists,
            None,
            CLSCTX_INPROC_SERVER,
        ) else {
            return found;
        };
        if lists.SetAppID(&HSTRING::from(aumid)).is_err() {
            return found;
        }
        let Ok(array) = lists.GetList::<IObjectArray>(ADLT_RECENT, LIMIT as u32) else {
            return found;
        };
        let count = array.GetCount().unwrap_or(0);
        for index in 0..count {
            // An entry is a shell item or a shortcut; either way we want the
            // path of the file it stands for.
            let path = if let Ok(shell_item) = array.GetAt::<IShellItem>(index) {
                shell_item.GetDisplayName(SIGDN_FILESYSPATH).ok().and_then(|text| {
                    let path = text.to_string().ok();
                    CoTaskMemFree(Some(text.0 as *const _));
                    path
                })
            } else if let Ok(link) = array.GetAt::<IShellLinkW>(index) {
                let mut buffer = [0u16; 1024];
                link.GetPath(&mut buffer, std::ptr::null_mut(), 0).ok().map(|_| {
                    let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
                    String::from_utf16_lossy(&buffer[..len])
                })
            } else {
                None
            };
            if let Some(path) = path.filter(|path| !path.is_empty()) {
                found.push(item(path));
            }
        }
    }
    found
}

/// Recent folders, workspaces and files of a VS Code-family editor, found by
/// its exe name: `Code.exe` keeps them in `%APPDATA%\Code`, `Cursor.exe` in
/// `%APPDATA%\Cursor`, and so on. Remote entries (WSL, SSH, containers) are
/// left out: they have no local path to open.
pub fn vscode(exe: &str) -> Vec<RecentItem> {
    let Some(stem) = std::path::Path::new(exe).file_stem() else {
        return Vec::new();
    };
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return Vec::new();
    };
    let db = std::path::PathBuf::from(appdata)
        .join(stem)
        .join("User")
        .join("globalStorage")
        .join("state.vscdb");
    if !db.is_file() {
        return Vec::new();
    }
    let Some(text) = read_vscode_history(&db) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    value["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            entry["folderUri"]
                .as_str()
                .or_else(|| entry["workspace"]["configPath"].as_str())
                .or_else(|| entry["fileUri"].as_str())
        })
        .filter_map(file_uri_to_path)
        .take(LIMIT)
        .map(item)
        .collect()
}

fn read_vscode_history(db: &std::path::Path) -> Option<String> {
    use rusqlite::{Connection, OpenFlags};
    // Read-only, and never waiting long on the editor's own lock.
    let connection = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let _ = connection.busy_timeout(std::time::Duration::from_millis(200));
    connection
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
}

/// `file:///c%3A/code/devhq` to `c:\code\devhq`. Anything that is not a
/// local file URI is `None`.
fn file_uri_to_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file:///")?;
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&rest[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'/' { b'\\' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8(out).ok()
}
