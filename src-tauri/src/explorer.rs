//! Backing for the Files tool: a plain filesystem browser.
//!
//! Everything here is one shallow `read_dir` of one folder. There is no
//! recursion and no sizing of folders - that is Disk Space Usage's job, and it
//! is exactly what makes a folder listing slow. A listing must come back fast
//! enough that clicking a tree node feels like the folder was already open.
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Root {
    pub path: String,
    pub label: String,
    pub icon: String,
    /// "drive" roots carry their free/total so the tree can say how full they
    /// are; a plain folder root leaves both at zero.
    pub total_bytes: u64,
    pub free_bytes: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Lower-case extension without the dot. Empty for folders and for files
    /// that have none, which the front end treats as its own "no type" bucket.
    pub ext: String,
    pub bytes: u64,
    /// Milliseconds since the epoch, or 0 when the timestamp is unreadable.
    pub modified: u64,
    pub hidden: bool,
    pub readonly: bool,
    /// Only meaningful for folders: whether the tree should offer an expander.
    /// Unknown (a folder that could not be peeked into) is reported as `true`
    /// so the arrow is there and expanding it says what went wrong.
    pub has_children: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
    /// Entries whose metadata Windows refused. They are counted rather than
    /// listed, so a protected folder reads as "3 items could not be read"
    /// instead of silently showing fewer files than it holds.
    pub skipped: u64,
}

fn known_folder(name: &str) -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;
    let path = if name.is_empty() {
        home
    } else {
        home.join(name)
    };
    path.is_dir().then_some(path)
}

/// The tree's top level: the user's own folders first, then the real drives.
/// Nothing here is a shell namespace - every root is a path that exists.
pub fn roots() -> Vec<Root> {
    let mut out = Vec::new();
    for (folder, label, icon) in [
        ("", "Home", "home"),
        ("Desktop", "Desktop", "desktop_windows"),
        ("Documents", "Documents", "description"),
        ("Downloads", "Downloads", "download"),
        ("Pictures", "Pictures", "image"),
    ] {
        if let Some(path) = known_folder(folder) {
            out.push(Root {
                path: path.to_string_lossy().into_owned(),
                label: label.into(),
                icon: icon.into(),
                total_bytes: 0,
                free_bytes: 0,
            });
        }
    }
    for drive in crate::disk_space::drives().unwrap_or_default() {
        out.push(Root {
            path: drive.path,
            label: drive.label,
            icon: "hard_drive".into(),
            total_bytes: drive.total_bytes,
            free_bytes: drive.free_bytes,
        });
    }
    out
}

#[cfg(windows)]
fn flags(meta: &std::fs::Metadata) -> (bool, bool) {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    const READONLY: u32 = 0x1;
    let attrs = meta.file_attributes();
    (
        attrs & (HIDDEN | SYSTEM) != 0,
        attrs & READONLY != 0 && !meta.is_dir(),
    )
}

#[cfg(not(windows))]
fn flags(meta: &std::fs::Metadata) -> (bool, bool) {
    (false, meta.permissions().readonly() && !meta.is_dir())
}

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn extension(name: &str, is_dir: bool) -> String {
    if is_dir {
        return String::new();
    }
    // A leading dot is a name, not an extension: `.gitignore` is not a file of
    // type "gitignore", and grouping every dotfile under its own type would
    // scatter them across the type filter.
    Path::new(name)
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// Whether a folder holds at least one subfolder, without walking it. The peek
/// stops after 512 entries: past that the arrow is a guess, and guessing "yes"
/// costs one wasted click while guessing "no" hides a real subtree.
fn has_subfolder(path: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(path) else {
        return true;
    };
    for (seen, entry) in entries.flatten().enumerate() {
        if seen >= 512 {
            return true;
        }
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            return true;
        }
    }
    false
}

/// One shallow listing of one folder. `dirs_only` is what the tree asks for:
/// it skips the files entirely, which is the difference between opening a
/// branch and listing a folder of ten thousand files to show none of them.
pub fn list(raw_path: String, dirs_only: bool) -> Result<Listing, String> {
    let path = PathBuf::from(&raw_path);
    if !path.is_dir() {
        return Err("That folder is no longer available.".into());
    }
    let entries = std::fs::read_dir(&path).map_err(|error| readable(&raw_path, error))?;
    let mut out = Vec::new();
    let mut skipped = 0u64;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            skipped += 1;
            continue;
        };
        let is_dir = meta.is_dir();
        if dirs_only && !is_dir {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let (hidden, readonly) = flags(&meta);
        let child = entry.path();
        out.push(Entry {
            ext: extension(&name, is_dir),
            has_children: is_dir && has_subfolder(&child),
            path: child.to_string_lossy().into_owned(),
            name,
            is_dir,
            bytes: if is_dir { 0 } else { meta.len() },
            modified: modified_ms(&meta),
            hidden,
            readonly,
        });
    }
    // Folders first, then by name. Every other order the front end offers is a
    // re-sort of this list, so the default arrives already correct.
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(Listing {
        parent: path
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
            .filter(|parent| !parent.is_empty()),
        path: path.to_string_lossy().into_owned(),
        entries: out,
        skipped,
    })
}

/// Windows' own words for a failed `read_dir` are "Access is denied. (os error
/// 5)", which tells the user nothing they can act on.
fn readable(path: &str, error: std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => {
            format!("Windows would not let this app read {path}.")
        }
        std::io::ErrorKind::NotFound => format!("{path} no longer exists."),
        _ => format!("{path} could not be read. {error}"),
    }
}
