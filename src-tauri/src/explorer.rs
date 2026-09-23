//! Backing for the Files tool: a plain filesystem browser.
//!
//! Everything here is one shallow `read_dir` of one folder. There is no
//! recursion and no sizing of folders - that is Disk Space Usage's job, and it
//! is exactly what makes a folder listing slow. A listing must come back fast
//! enough that clicking a tree node feels like the folder was already open.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Write};
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use zip::ZipArchive;

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
    /// A real `.zip` on disk that opens like a folder. Distinct from a plain
    /// directory so the type filter can still call it an archive.
    pub is_archive: bool,
    /// Lower-case extension without the dot. Empty for folders and for files
    /// that have none, which the front end treats as its own "no type" bucket.
    pub ext: String,
    pub bytes: u64,
    /// Milliseconds since the epoch, or 0 when the timestamp is unreadable.
    pub modified: u64,
    /// Creation time is optional work: it is only read when the user has made
    /// the Date created column visible.
    pub created: u64,
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

/// This PC: the real drives, and nothing else. There is no Quick Access and
/// no Libraries here, because neither is a path - the tool can only show
/// places you could type into an address bar.
pub fn roots() -> Vec<Root> {
    crate::disk_space::drives()
        .unwrap_or_default()
        .into_iter()
        .map(|drive| Root {
            path: drive.path,
            label: drive.label,
            icon: "hard_drive".into(),
            total_bytes: drive.total_bytes,
            free_bytes: drive.free_bytes,
        })
        .collect()
}

fn bookmarks_file(app_data: &Path) -> Option<PathBuf> {
    std::fs::create_dir_all(app_data).ok()?;
    Some(app_data.join("explorer-bookmarks.json"))
}

/// The folders pinned under the tree. They live in one small file next to the
/// app's other data rather than in the tool's browser storage: each isolated
/// tool and each pop-out runs in its own WebView2 environment with its own
/// storage, so anything kept there would be a different list in every window.
pub fn bookmarks(app_data: &Path) -> Vec<String> {
    let Some(file) = bookmarks_file(app_data) else {
        return seed();
    };
    match std::fs::read_to_string(&file) {
        Ok(text) => serde_json::from_str::<Vec<String>>(&text)
            .unwrap_or_default()
            .into_iter()
            .filter(|path| bookmarkable(path))
            .collect(),
        // No file yet means a first run, not an empty list: Desktop and
        // Downloads are where a file browser is opened for nine times out of
        // ten, so they are already there rather than waiting to be added.
        Err(_) => {
            let seeded = seed();
            let _ = std::fs::write(&file, serde_json::to_string(&seeded).unwrap_or_default());
            seeded
        }
    }
}

fn seed() -> Vec<String> {
    ["Desktop", "Downloads"]
        .into_iter()
        .filter_map(known_folder)
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

/// The tool owns the order, so it writes the whole list back rather than
/// asking for one to be added or removed.
pub fn bookmarks_set(app_data: &Path, paths: Vec<String>) -> Result<Vec<String>, String> {
    let kept: Vec<String> = paths
        .into_iter()
        .filter(|path| bookmarkable(path))
        .collect();
    let file = bookmarks_file(app_data).ok_or("There is nowhere to save bookmarks.")?;
    std::fs::write(
        &file,
        serde_json::to_string(&kept).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("The bookmarks could not be saved. {error}"))?;
    Ok(kept)
}

fn last_path_file(app_data: &Path) -> Option<PathBuf> {
    std::fs::create_dir_all(app_data).ok()?;
    Some(app_data.join("explorer-last-path.json"))
}

/// The folder Files last had open. Same reason as bookmarks: one file in
/// app data, shared by every Files window, so the next open lands where the
/// last one left off - not on This PC every time.
pub fn last_path(app_data: &Path) -> Option<String> {
    let file = last_path_file(app_data)?;
    let text = std::fs::read_to_string(file).ok()?;
    let path = serde_json::from_str::<String>(&text).ok()?;
    // An empty string means This PC, which is a real place to reopen on.
    if path.is_empty() {
        return Some(path);
    }
    browsable(&path).then_some(path)
}

pub fn last_path_set(app_data: &Path, path: String) -> Result<(), String> {
    if !path.is_empty() && !browsable(&path) {
        return Err("That folder is no longer there.".into());
    }
    let file = last_path_file(app_data).ok_or("There is nowhere to save the last folder.")?;
    std::fs::write(
        &file,
        serde_json::to_string(&path).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("The last folder could not be saved. {error}"))?;
    Ok(())
}

#[derive(Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub side_width: u32,
    pub preview_width: u32,
    #[serde(default = "default_column_widths")]
    pub column_widths: BTreeMap<String, u32>,
    #[serde(default)]
    pub created_column: bool,
    #[serde(default)]
    pub thumbs_on: bool,
    #[serde(default)]
    pub preview_pane: bool,
    #[serde(default)]
    pub show_hidden: bool,
    #[serde(default = "default_sort")]
    pub sort: String,
    #[serde(default)]
    pub desc: bool,
    #[serde(default = "default_window_width")]
    pub window_width: u32,
    #[serde(default = "default_window_height")]
    pub window_height: u32,
}

fn default_sort() -> String {
    "name".into()
}
fn default_window_width() -> u32 {
    960
}
fn default_window_height() -> u32 {
    720
}

fn default_column_widths() -> BTreeMap<String, u32> {
    [
        ("name", 320),
        ("type", 130),
        ("size", 92),
        ("modified", 148),
        ("created", 148),
    ]
    .into_iter()
    .map(|(name, width)| (name.to_string(), width))
    .collect()
}

const SIDE_DEFAULT: u32 = 268;
const PREVIEW_DEFAULT: u32 = 320;
const SIDE_MIN: u32 = 64;
const SIDE_MAX: u32 = 1200;
const PREVIEW_MIN: u32 = 64;
const PREVIEW_MAX: u32 = 1200;
const WINDOW_WIDTH_MIN: u32 = 480;
const WINDOW_HEIGHT_MIN: u32 = 320;
const WINDOW_SIZE_MAX: u32 = 10000;

fn layout_file(app_data: &Path) -> Option<PathBuf> {
    std::fs::create_dir_all(app_data).ok()?;
    Some(app_data.join("explorer-layout.json"))
}

fn clamp_layout(layout: Layout) -> Layout {
    let defaults = default_column_widths();
    let column_widths = defaults
        .into_iter()
        .map(|(name, fallback)| {
            let width = layout
                .column_widths
                .get(&name)
                .copied()
                .unwrap_or(fallback)
                .clamp(64, 800);
            (name, width)
        })
        .collect();
    Layout {
        side_width: layout.side_width.clamp(SIDE_MIN, SIDE_MAX),
        preview_width: layout.preview_width.clamp(PREVIEW_MIN, PREVIEW_MAX),
        column_widths,
        created_column: layout.created_column,
        thumbs_on: layout.thumbs_on,
        preview_pane: layout.preview_pane,
        show_hidden: layout.show_hidden,
        sort: match layout.sort.as_str() {
            "name" | "type" | "size" | "modified" | "created" => layout.sort,
            _ => default_sort(),
        },
        desc: layout.desc,
        window_width: layout.window_width.clamp(WINDOW_WIDTH_MIN, WINDOW_SIZE_MAX),
        window_height: layout
            .window_height
            .clamp(WINDOW_HEIGHT_MIN, WINDOW_SIZE_MAX),
    }
}

/// How wide the folder tree and the preview pane are. The browse list takes
/// whatever is left. Kept in app data so every Files window agrees, the way
/// bookmarks and the last folder do.
pub fn layout(app_data: &Path) -> Layout {
    let defaults = Layout {
        side_width: SIDE_DEFAULT,
        preview_width: PREVIEW_DEFAULT,
        column_widths: default_column_widths(),
        created_column: false,
        thumbs_on: false,
        preview_pane: false,
        show_hidden: false,
        sort: default_sort(),
        desc: false,
        window_width: default_window_width(),
        window_height: default_window_height(),
    };
    let Some(file) = layout_file(app_data) else {
        return defaults;
    };
    match std::fs::read_to_string(file) {
        Ok(text) => serde_json::from_str::<Layout>(&text)
            .map(clamp_layout)
            .unwrap_or(defaults),
        Err(_) => defaults,
    }
}

pub fn layout_set(app_data: &Path, layout: Layout) -> Result<Layout, String> {
    let kept = clamp_layout(layout);
    let file = layout_file(app_data).ok_or("There is nowhere to save the layout.")?;
    std::fs::write(
        &file,
        serde_json::to_string(&kept).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("The layout could not be saved. {error}"))?;
    Ok(kept)
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

fn is_zip_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
}

fn is_zip_file(path: &Path) -> bool {
    path.is_file()
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(is_zip_name)
}

/// Bookmarks are places you return to: a real folder, or a zip that opens as
/// one. Paths *inside* a zip are not bookmarkable - they vanish when the
/// archive moves, and the pin would be a dead row.
fn bookmarkable(path: &str) -> bool {
    let item = Path::new(path);
    item.is_dir() || is_zip_file(item)
}

/// Anywhere Files can open: a directory, a zip, or a folder path inside a zip.
fn browsable(path: &str) -> bool {
    let item = Path::new(path);
    if item.is_dir() || is_zip_file(item) {
        return true;
    }
    match split_zip_path(path) {
        Some((archive, inner)) if !inner.is_empty() => {
            archive.is_file() && zip_has_prefix(&archive, &inner)
        }
        _ => false,
    }
}

/// Split `C:\a.zip\docs\x` into the archive file and the path inside it.
/// The archive is the longest existing `*.zip` file prefix; everything after
/// is the virtual path. Rejects `..` so a zip cannot climb out of itself.
fn split_zip_path(raw: &str) -> Option<(PathBuf, String)> {
    let normalized = raw.replace('/', "\\");
    let bytes = normalized.as_bytes();
    let lower = normalized.to_ascii_lowercase();
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find(".zip") {
        let idx = search_from + rel;
        let end = idx + 4;
        let boundary_ok = end == lower.len() || lower.as_bytes().get(end) == Some(&b'\\');
        if boundary_ok {
            let archive = PathBuf::from(&normalized[..end]);
            if archive.is_file() {
                let mut inner = normalized[end..].trim_start_matches('\\').to_string();
                if inner.split(['\\', '/']).any(|part| part == "..") {
                    return None;
                }
                inner = inner.replace('/', "\\");
                return Some((archive, inner));
            }
        }
        search_from = idx + 1;
        if search_from >= bytes.len() {
            break;
        }
    }
    None
}

fn inside_zip(path: &str) -> bool {
    matches!(split_zip_path(path), Some((_, inner)) if !inner.is_empty())
}

fn join_zip(archive: &Path, inner: &str) -> String {
    if inner.is_empty() {
        archive.to_string_lossy().into_owned()
    } else {
        format!(
            "{}\\{}",
            archive.to_string_lossy(),
            inner.replace('/', "\\")
        )
    }
}

fn zip_parent(archive: &Path, inner: &str) -> Option<String> {
    if inner.is_empty() {
        return archive
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
            .filter(|parent| !parent.is_empty());
    }
    match inner.rsplit_once('\\') {
        Some((parent, _)) => Some(join_zip(archive, parent)),
        None => Some(archive.to_string_lossy().into_owned()),
    }
}

fn open_zip(archive: &Path) -> Result<ZipArchive<File>, String> {
    let file = File::open(archive)
        .map_err(|error| format!("{} could not be opened. {error}", name_of(archive)))?;
    ZipArchive::new(file).map_err(|error| {
        format!(
            "{} is not a readable zip archive. {error}",
            name_of(archive)
        )
    })
}

fn zip_has_prefix(archive: &Path, inner: &str) -> bool {
    let Ok(mut zip) = open_zip(archive) else {
        return false;
    };
    let prefix = inner.replace('\\', "/").trim_matches('/').to_string();
    let dir_prefix = format!("{prefix}/");
    for index in 0..zip.len() {
        let Ok(entry) = zip.by_index(index) else {
            continue;
        };
        let Some(name) = entry.enclosed_name() else {
            continue;
        };
        let name = name.to_string_lossy().replace('\\', "/");
        if name == prefix || name.trim_end_matches('/') == prefix || name.starts_with(&dir_prefix) {
            return true;
        }
    }
    false
}

struct ZipChild {
    is_dir: bool,
    bytes: u64,
    has_children: bool,
}

fn list_zip(archive: &Path, inner: &str, dirs_only: bool) -> Result<Listing, String> {
    let mut zip = open_zip(archive)?;
    let prefix = if inner.is_empty() {
        String::new()
    } else {
        format!("{}/", inner.replace('\\', "/").trim_matches('/'))
    };
    let mut children: BTreeMap<String, ZipChild> = BTreeMap::new();
    for index in 0..zip.len() {
        let Ok(entry) = zip.by_index(index) else {
            continue;
        };
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        let name = enclosed.to_string_lossy().replace('\\', "/");
        if !prefix.is_empty() && !name.starts_with(&prefix) {
            continue;
        }
        let rest = &name[prefix.len()..];
        if rest.is_empty() {
            continue;
        }
        let mut parts = rest.split('/').filter(|part| !part.is_empty());
        let Some(first) = parts.next() else {
            continue;
        };
        if first == "." || first == ".." {
            continue;
        }
        let deeper = parts.next().is_some();
        let explicit_dir = entry.is_dir() || name.ends_with('/');
        if deeper || explicit_dir {
            children
                .entry(first.to_string())
                .and_modify(|child| {
                    child.is_dir = true;
                    child.has_children = child.has_children || deeper;
                })
                .or_insert(ZipChild {
                    is_dir: true,
                    bytes: 0,
                    has_children: deeper,
                });
        } else if !dirs_only {
            children.entry(first.to_string()).or_insert(ZipChild {
                is_dir: false,
                bytes: entry.size(),
                has_children: false,
            });
        }
    }
    let mut out = Vec::with_capacity(children.len());
    for (name, child) in children {
        if dirs_only && !child.is_dir {
            continue;
        }
        let child_inner = if inner.is_empty() {
            name.clone()
        } else {
            format!("{inner}\\{name}")
        };
        out.push(Entry {
            ext: extension(&name, child.is_dir),
            has_children: child.is_dir && child.has_children,
            path: join_zip(archive, &child_inner),
            name,
            is_dir: child.is_dir,
            is_archive: false,
            bytes: if child.is_dir { 0 } else { child.bytes },
            modified: 0,
            created: 0,
            hidden: false,
            readonly: true,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(Listing {
        parent: zip_parent(archive, inner),
        path: join_zip(archive, inner),
        entries: out,
        skipped: 0,
    })
}

/// Pull one zip member out to a temp file so the rest of the app can open or
/// preview it like a normal path. Cached by archive+member so a second look
/// at the same picture does not unpack it again.
pub fn materialize(raw_path: String) -> Result<String, String> {
    let path = PathBuf::from(raw_path.replace('/', "\\"));
    if path.is_file() {
        return Ok(path.to_string_lossy().into_owned());
    }
    let Some((archive, inner)) = split_zip_path(&path.to_string_lossy()) else {
        return Err("That file is no longer available.".into());
    };
    if inner.is_empty() {
        return Ok(archive.to_string_lossy().into_owned());
    }
    let real = materialize_zip_member(&archive, &inner)?;
    Ok(real.to_string_lossy().into_owned())
}

fn materialize_zip_member(archive: &Path, inner: &str) -> Result<PathBuf, String> {
    let inner_norm = inner.replace('\\', "/");
    if inner_norm.split('/').any(|part| part == "..") {
        return Err("That path is not allowed inside the zip.".into());
    }
    let file_name = Path::new(&inner_norm)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "That zip entry has no file name.".to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(archive.to_string_lossy().as_bytes());
    hasher.update(b"\0");
    hasher.update(inner_norm.as_bytes());
    let digest = hex_digest(&hasher.finalize());
    let dest_dir = std::env::temp_dir().join("wint-zip").join(&digest[..16]);
    let dest = dest_dir.join(&file_name);
    if dest.is_file() {
        return Ok(dest);
    }
    std::fs::create_dir_all(&dest_dir)
        .map_err(|error| format!("A temporary folder could not be created. {error}"))?;
    let mut zip = open_zip(archive)?;
    let mut found = None;
    for index in 0..zip.len() {
        let Ok(entry) = zip.by_index(index) else {
            continue;
        };
        if entry.is_dir() {
            continue;
        }
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        let name = enclosed.to_string_lossy().replace('\\', "/");
        if name == inner_norm || name.trim_end_matches('/') == inner_norm {
            found = Some(index);
            break;
        }
    }
    let index = found.ok_or_else(|| format!("{file_name} is not in that zip."))?;
    let mut entry = zip
        .by_index(index)
        .map_err(|error| format!("{file_name} could not be read. {error}"))?;
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut bytes)
        .map_err(|error| format!("{file_name} could not be read. {error}"))?;
    let mut out = File::create(&dest)
        .map_err(|error| format!("{file_name} could not be unpacked. {error}"))?;
    out.write_all(&bytes)
        .map_err(|error| format!("{file_name} could not be unpacked. {error}"))?;
    Ok(dest)
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// One shallow listing of one folder. `dirs_only` is what the tree asks for:
/// it skips the files entirely, which is the difference between opening a
/// branch and listing a folder of ten thousand files to show none of them.
///
/// A `.zip` file is listed and opened the same way as a folder: the path
/// `archive.zip\inner` is virtual, built from the zip's central directory.
pub fn list(raw_path: String, dirs_only: bool, include_created: bool) -> Result<Listing, String> {
    let path = PathBuf::from(raw_path.replace('/', "\\"));
    if path.is_dir() {
        return list_dir(path, dirs_only, include_created);
    }
    if is_zip_file(&path) {
        return list_zip(&path, "", dirs_only);
    }
    if let Some((archive, inner)) = split_zip_path(&path.to_string_lossy()) {
        return list_zip(&archive, &inner, dirs_only);
    }
    Err("That folder is no longer available.".into())
}

fn list_dir(path: PathBuf, dirs_only: bool, include_created: bool) -> Result<Listing, String> {
    let raw = path.to_string_lossy().into_owned();
    let entries = std::fs::read_dir(&path).map_err(|error| readable(&raw, error))?;
    let mut out = Vec::new();
    let mut skipped = 0u64;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            skipped += 1;
            continue;
        };
        let is_dir = meta.is_dir();
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_archive = !is_dir && is_zip_name(&name);
        if dirs_only && !is_dir && !is_archive {
            continue;
        }
        let (hidden, readonly) = flags(&meta);
        let child = entry.path();
        out.push(Entry {
            ext: if is_archive {
                "zip".into()
            } else {
                extension(&name, is_dir)
            },
            // Never open every child directory while listing its parent. On a
            // network share that turns one click into hundreds of round trips.
            // A folder is expanded lazily; an empty branch simply opens empty.
            has_children: is_dir || is_archive,
            path: child.to_string_lossy().into_owned(),
            name,
            is_dir: is_dir || is_archive,
            is_archive,
            bytes: if is_dir && !is_archive { 0 } else { meta.len() },
            modified: modified_ms(&meta),
            created: if include_created {
                meta.created()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or(0)
            } else {
                0
            },
            hidden,
            readonly: readonly || is_archive,
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
        path: raw,
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

/// A thumbnail for one file, as a `data:` URL.
///
/// Prefer Windows' own picture (`IShellItemImageFactory`) so Explorer's cache
/// is reused when it has one. When the shell has nothing yet - common for a
/// file that has never been opened in Explorer - decode the image ourselves
/// and shrink it, rather than telling the user there is no preview of a PNG.
///
/// A data URL rather than a path, for the reason `workspace_read_image` gives:
/// nothing in `src/` can point an `<img>` at a real path without opening the
/// asset protocol to the whole disk, and a thumbnail is small enough to hand
/// over inline.
#[cfg(windows)]
pub fn thumbnail(raw_path: String, size: u32) -> Result<Option<String>, String> {
    // The shell parses this path itself and is stricter than the rest of
    // Windows: a forward slash anywhere in it is rejected outright with "the
    // parameter is incorrect", even though every std::fs call accepts one.
    let normalized = raw_path.replace('/', "\\");
    let path = if let Some((archive, inner)) = split_zip_path(&normalized) {
        if inner.is_empty() {
            return Ok(None);
        }
        materialize_zip_member(&archive, &inner)?
    } else {
        PathBuf::from(normalized)
    };
    if !path.is_file() {
        return Ok(None);
    }
    if let Some(url) = shell_thumbnail(&path, size)? {
        return Ok(Some(url));
    }
    decode_thumbnail(&path, size)
}

#[cfg(windows)]
fn shell_thumbnail(path: &Path, size: u32) -> Result<Option<String>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, DIB_RGB_COLORS,
    };
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK,
        SIIGBF_THUMBNAILONLY,
    };

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // These threads are pooled and shared with everything else that talks to
    // the shell, so the apartment is entered through the guard: it leaves only
    // what it entered. Tearing down an apartment this call did not create
    // takes the reference another caller is still holding, and the crash lands
    // somewhere else entirely.
    let _apartment = crate::com::Apartment::single_threaded();
    let result = (|| -> Result<Option<String>, String> {
        // A file the shell will not even name is a file with no thumbnail,
        // not an error worth showing: the row keeps its type icon either way,
        // and one unreadable file must not colour the whole folder red.
        let factory: IShellItemImageFactory =
            match unsafe { SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None) } {
                Ok(factory) => factory,
                Err(_) => return Ok(None),
            };
        let wanted = SIZE {
            cx: size as i32,
            cy: size as i32,
        };
        // THUMBNAILONLY: a real extracted picture, never the generic type
        // icon. When the cache is empty the call fails and the decode path
        // below builds one from the file instead.
        let bitmap =
            match unsafe { factory.GetImage(wanted, SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK) } {
                Ok(bitmap) => bitmap,
                Err(_) => return Ok(None),
            };
        let mut info = BITMAP::default();
        let read = unsafe {
            GetObjectW(
                bitmap.into(),
                std::mem::size_of::<BITMAP>() as i32,
                Some(std::ptr::addr_of_mut!(info).cast()),
            )
        };
        if read == 0 || info.bmWidth <= 0 || info.bmHeight <= 0 {
            unsafe {
                let _ = DeleteObject(bitmap.into());
            }
            return Ok(None);
        }
        let (width, height) = (info.bmWidth as u32, info.bmHeight as u32);
        let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
        let mut header = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                // A negative height asks GDI for a top-down buffer, which is
                // the order PNG wants; bottom-up would have to be flipped.
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0,
                ..Default::default()
            },
            ..Default::default()
        };
        let screen = unsafe { GetDC(None) };
        let copied = unsafe {
            GetDIBits(
                screen,
                bitmap,
                0,
                height,
                Some(pixels.as_mut_ptr().cast()),
                std::ptr::addr_of_mut!(header),
                DIB_RGB_COLORS,
            )
        };
        unsafe {
            ReleaseDC(None, screen);
            let _ = DeleteObject(bitmap.into());
        }
        if copied == 0 {
            return Ok(None);
        }
        // GDI hands back BGRA; PNG wants RGBA. A bitmap carrying no alpha
        // channel at all comes back with every alpha byte zero, so that case
        // is read as opaque rather than drawn as an invisible square.
        let blank_alpha = pixels.iter().skip(3).step_by(4).all(|&alpha| alpha == 0);
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            if blank_alpha {
                pixel[3] = 255;
            }
        }
        rgba_to_data_url(width, height, &pixels)
    })();
    result
}

/// Shrink an image file ourselves when the shell has no thumbnail yet.
/// Soft-fails on anything that is not a plain bitmap format we know: SVG,
/// RAW and HEIC stay as "no preview" rather than taking down the call.
fn decode_thumbnail(path: &Path, size: u32) -> Result<Option<String>, String> {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    const KNOWN: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"];
    if !KNOWN.contains(&ext.as_str()) {
        return Ok(None);
    }
    // A 40 megapixel RAW mistaken for a JPEG must not be pulled across the
    // bridge whole. Anything past this is left for a proper viewer.
    const MAX_BYTES: u64 = 40 * 1024 * 1024;
    let Ok(meta) = std::fs::metadata(path) else {
        return Ok(None);
    };
    if meta.len() > MAX_BYTES {
        return Ok(None);
    }
    let Ok(image) = image::open(path) else {
        return Ok(None);
    };
    let edge = size.max(1);
    let thumb = image.thumbnail(edge, edge);
    let rgba = thumb.to_rgba8();
    rgba_to_data_url(rgba.width(), rgba.height(), rgba.as_raw())
}

pub(crate) fn rgba_to_data_url(
    width: u32,
    height: u32,
    pixels: &[u8],
) -> Result<Option<String>, String> {
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| format!("The thumbnail could not be encoded. {error}"))?;
        writer
            .write_image_data(pixels)
            .map_err(|error| format!("The thumbnail could not be encoded. {error}"))?;
    }
    Ok(Some(format!(
        "data:image/png;base64,{}",
        crate::workspace::base64(&png)
    )))
}

#[cfg(not(windows))]
pub fn thumbnail(raw_path: String, size: u32) -> Result<Option<String>, String> {
    let normalized = raw_path.replace('/', "\\");
    let path = if let Some((archive, inner)) = split_zip_path(&normalized) {
        if inner.is_empty() {
            return Ok(None);
        }
        materialize_zip_member(&archive, &inner)?
    } else {
        PathBuf::from(normalized)
    };
    if !path.is_file() {
        return Ok(None);
    }
    Ok(decode_thumbnail(&path, size)?)
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn delete_outright(paths: &[&String]) -> Result<(), String> {
    for path in paths {
        let item = Path::new(path.as_str());
        let outcome = if item.is_dir() {
            std::fs::remove_dir_all(item)
        } else {
            std::fs::remove_file(item)
        };
        outcome.map_err(|error| format!("{} could not be deleted. {error}", name_of(item)))?;
    }
    Ok(())
}

/// Deletes files and folders, either to the Recycle Bin or for good.
///
/// The Recycle Bin is not something this app can imitate with `std::fs`: only
/// the shell writes the record that lets Windows put a file back afterwards.
/// So the two answers are genuinely different calls, and `recycle` picks one.
#[cfg(windows)]
pub fn delete(paths: Vec<String>, recycle: bool) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
    };

    if let Some(path) = paths.iter().find(|path| inside_zip(path)) {
        return Err(format!(
            "{} is inside a zip — delete the archive itself, not the files in it.",
            name_of(Path::new(path.as_str()))
        ));
    }
    let targets: Vec<&String> = paths
        .iter()
        .filter(|path| Path::new(path.as_str()).exists())
        .collect();
    if targets.is_empty() {
        return Ok(());
    }
    if !recycle {
        return delete_outright(&targets);
    }
    // SHFileOperation takes the whole list in one double-null-terminated
    // buffer, so one answer covers one trip to the Recycle Bin.
    let mut from: Vec<u16> = Vec::new();
    for path in &targets {
        from.extend(std::ffi::OsStr::new(path.as_str()).encode_wide());
        from.push(0);
    }
    from.push(0);
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        // FOF_ALLOWUNDO is the Recycle Bin: without it the shell deletes
        // outright, which is the other branch of this function.
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI).0 as u16,
        ..Default::default()
    };
    let code = unsafe { SHFileOperationW(std::ptr::addr_of_mut!(op)) };
    if code != 0 {
        return Err(format!(
            "Windows would not move {} to the Recycle Bin (error {code}).",
            if targets.len() == 1 {
                name_of(Path::new(targets[0].as_str()))
            } else {
                format!("{} items", targets.len())
            }
        ));
    }
    if op.fAnyOperationsAborted.as_bool() {
        return Err("The delete was stopped before it finished.".into());
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn delete(paths: Vec<String>, _recycle: bool) -> Result<(), String> {
    if let Some(path) = paths.iter().find(|path| inside_zip(path)) {
        return Err(format!(
            "{} is inside a zip — delete the archive itself, not the files in it.",
            name_of(Path::new(path.as_str()))
        ));
    }
    let targets: Vec<&String> = paths
        .iter()
        .filter(|path| Path::new(path.as_str()).exists())
        .collect();
    delete_outright(&targets)
}

fn refuse_zip(paths: &[String], what: &str) -> Result<(), String> {
    match paths.iter().find(|path| inside_zip(path)) {
        Some(path) => Err(format!(
            "{} is inside a zip — files in an archive cannot be {what} here.",
            name_of(Path::new(path.as_str()))
        )),
        None => Ok(()),
    }
}

/// Renames one file or folder in place and returns its new path. A new name
/// is a name, not a path: anything that would move the item elsewhere is
/// refused instead of quietly obeyed.
pub fn rename(path: String, new_name: String) -> Result<String, String> {
    refuse_zip(std::slice::from_ref(&path), "renamed")?;
    let name = new_name.trim().trim_end_matches(['.', ' ']);
    if name.is_empty() || name == "." || name == ".." {
        return Err("A name cannot be empty.".into());
    }
    if let Some(bad) = name
        .chars()
        .find(|c| "\\/:*?\"<>|".contains(*c) || c.is_control())
    {
        return Err(format!("A name cannot contain {bad}"));
    }
    let from = PathBuf::from(&path);
    let parent = from
        .parent()
        .ok_or("The top of a drive cannot be renamed.")?;
    let to = parent.join(name);
    // A change of case only is the same item to Windows, so it must not be
    // mistaken for a clash with itself.
    let same_item = to
        .to_string_lossy()
        .eq_ignore_ascii_case(&from.to_string_lossy());
    if to.exists() && !same_item {
        return Err(format!("{name} already exists here."));
    }
    std::fs::rename(&from, &to).map_err(|error| readable(&path, error))?;
    Ok(to.to_string_lossy().into_owned())
}

/// Explorer-style batch rename. The first selected item takes `base`; later
/// items take `base (2)`, `base (3)` and so on. File extensions are preserved.
/// Every destination is checked before the first rename so a clash cannot
/// leave half of the selection renamed.
pub fn rename_many(paths: Vec<String>, base: String) -> Result<Vec<String>, String> {
    refuse_zip(&paths, "renamed")?;
    if paths.len() < 2 {
        return Err("Select at least two items for a batch rename.".into());
    }
    let stem = base.trim().trim_end_matches(['.', ' ']);
    if stem.is_empty() || stem == "." || stem == ".." {
        return Err("A name cannot be empty.".into());
    }
    if let Some(bad) = stem
        .chars()
        .find(|c| "\\/:*?\"<>|".contains(*c) || c.is_control())
    {
        return Err(format!("A name cannot contain {bad}"));
    }
    let mut moves = Vec::with_capacity(paths.len());
    for (index, raw) in paths.iter().enumerate() {
        let from = PathBuf::from(raw);
        let parent = from
            .parent()
            .ok_or("The top of a drive cannot be renamed.")?;
        let suffix = if index == 0 {
            String::new()
        } else {
            format!(" ({})", index + 1)
        };
        let extension = if from.is_file() {
            from.extension()
                .map(|value| format!(".{}", value.to_string_lossy()))
                .unwrap_or_default()
        } else {
            String::new()
        };
        let to = parent.join(format!("{stem}{suffix}{extension}"));
        let belongs_to_batch = paths.iter().any(|candidate| {
            Path::new(candidate)
                .to_string_lossy()
                .eq_ignore_ascii_case(&to.to_string_lossy())
        });
        if to.exists() && !belongs_to_batch {
            return Err(format!("{} already exists here.", name_of(&to)));
        }
        moves.push((from, to));
    }
    // First move to unique temporary names so swaps and case-only changes are
    // safe. If a final move fails, make a best effort to restore every source.
    let nonce = format!(
        "wint-rename-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let staged: Vec<(PathBuf, PathBuf, PathBuf)> = moves
        .into_iter()
        .enumerate()
        .map(|(index, (from, to))| {
            let temp = from
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(format!(".{nonce}-{index}.tmp"));
            (from, temp, to)
        })
        .collect();
    for (index, (from, temp, _)) in staged.iter().enumerate() {
        if let Err(error) = std::fs::rename(from, temp) {
            for (restore, staged_path, _) in staged[..index].iter().rev() {
                let _ = std::fs::rename(staged_path, restore);
            }
            return Err(format!("{} could not be renamed. {error}", name_of(from)));
        }
    }
    for (_, temp, to) in &staged {
        if let Err(error) = std::fs::rename(temp, to) {
            for (from, staged_path, final_path) in staged.iter() {
                if staged_path.exists() {
                    let _ = std::fs::rename(staged_path, from);
                } else if final_path.exists() {
                    let _ = std::fs::rename(final_path, from);
                }
            }
            return Err(format!("{} could not be renamed. {error}", name_of(to)));
        }
    }
    Ok(staged
        .into_iter()
        .map(|(_, _, to)| to.to_string_lossy().into_owned())
        .collect())
}

/// Makes "New folder" - or "New folder (2)" and so on when that is taken -
/// and returns its path so the list can put it straight into rename.
pub fn new_folder(dir: String) -> Result<String, String> {
    refuse_zip(std::slice::from_ref(&dir), "changed")?;
    let base = PathBuf::from(&dir);
    for n in 1..1000 {
        let name = if n == 1 {
            "New folder".to_string()
        } else {
            format!("New folder ({n})")
        };
        let path = base.join(name);
        if path.exists() {
            continue;
        }
        std::fs::create_dir(&path).map_err(|error| readable(&dir, error))?;
        return Ok(path.to_string_lossy().into_owned());
    }
    Err("Could not find a free name for a new folder.".into())
}

/// Copies or moves items into a folder through the shell, which is what gives
/// the familiar progress window, the "replace or skip" question and Ctrl+Z in
/// Windows Explorer afterwards. Copying into the folder the items already sit
/// in makes "- Copy" duplicates, the way Explorer does.
#[cfg(windows)]
pub fn transfer(paths: Vec<String>, dest: String, copy: bool) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMMKDIR, FOF_RENAMEONCOLLISION, FO_COPY,
        FO_MOVE, SHFILEOPSTRUCTW,
    };

    refuse_zip(&paths, if copy { "copied" } else { "moved" })?;
    refuse_zip(std::slice::from_ref(&dest), "changed")?;
    let dest_dir = PathBuf::from(&dest);
    if !dest_dir.is_dir() {
        return Err(format!("{} is not a folder.", name_of(&dest_dir)));
    }
    let same = |a: &Path, b: &Path| {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    };
    let sources: Vec<&String> = paths
        .iter()
        .filter(|path| {
            let item = Path::new(path.as_str());
            // Moving an item to where it already is, or a folder into itself,
            // is nothing to do rather than an error to show.
            let already_there = item.parent().is_some_and(|parent| same(parent, &dest_dir));
            item.exists() && !dest_dir.starts_with(item) && (copy || !already_there)
        })
        .collect();
    if sources.is_empty() {
        return Ok(());
    }
    let into_own_folder = sources.iter().any(|path| {
        Path::new(path.as_str())
            .parent()
            .is_some_and(|parent| same(parent, &dest_dir))
    });
    let wide = |items: &[&String]| {
        let mut buffer: Vec<u16> = Vec::new();
        for item in items {
            buffer.extend(std::ffi::OsStr::new(item.as_str()).encode_wide());
            buffer.push(0);
        }
        buffer.push(0);
        buffer
    };
    let from = wide(&sources);
    let to = wide(&[&dest]);
    let mut flags = FOF_ALLOWUNDO | FOF_NOCONFIRMMKDIR;
    if into_own_folder {
        flags |= FOF_RENAMEONCOLLISION;
    }
    let mut op = SHFILEOPSTRUCTW {
        wFunc: if copy { FO_COPY } else { FO_MOVE },
        pFrom: PCWSTR(from.as_ptr()),
        pTo: PCWSTR(to.as_ptr()),
        fFlags: flags.0 as u16,
        ..Default::default()
    };
    let code = unsafe { SHFileOperationW(std::ptr::addr_of_mut!(op)) };
    if code != 0 && !op.fAnyOperationsAborted.as_bool() {
        return Err(format!(
            "Windows could not {} the items (error {code}).",
            if copy { "copy" } else { "move" }
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn transfer(_paths: Vec<String>, _dest: String, _copy: bool) -> Result<(), String> {
    Err("Copying and moving is only available on Windows.".into())
}

#[derive(Serialize)]
pub struct Clip {
    pub paths: Vec<String>,
    pub cut: bool,
}

#[cfg(windows)]
fn preferred_effect_format() -> u32 {
    use windows::core::w;
    unsafe {
        windows::Win32::System::DataExchange::RegisterClipboardFormatW(w!("Preferred DropEffect"))
    }
}

/// The Windows clipboard, opened with a few retries: another program holding
/// it for a moment is normal, not a failure.
#[cfg(windows)]
fn with_clipboard<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    use windows::Win32::System::DataExchange::{CloseClipboard, OpenClipboard};
    let mut opened = false;
    for _ in 0..10 {
        if unsafe { OpenClipboard(None) }.is_ok() {
            opened = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    if !opened {
        return Err("Another program is holding the clipboard.".into());
    }
    let result = work();
    let _ = unsafe { CloseClipboard() };
    result
}

/// Puts files on the Windows clipboard the way Explorer does - a file list
/// plus "cut" or "copy" - so they paste into Explorer, another Files window or
/// anything else that takes files.
#[cfg(windows)]
pub fn clipboard_set(paths: Vec<String>, cut: bool) -> Result<(), String> {
    use windows::Win32::Foundation::{HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{EmptyClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::UI::Shell::DROPFILES;

    refuse_zip(&paths, if cut { "cut" } else { "copied" })?;
    let global = |bytes: &[u8]| -> Result<HGLOBAL, String> {
        unsafe {
            let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(|e| e.to_string())?;
            let target = GlobalLock(handle) as *mut u8;
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), target, bytes.len());
            let _ = GlobalUnlock(handle);
            Ok(handle)
        }
    };
    let header = std::mem::size_of::<DROPFILES>();
    let mut drop = vec![0u8; header];
    drop[0..4].copy_from_slice(&(header as u32).to_le_bytes());
    // fWide is the last field of the header.
    drop[header - 4..header].copy_from_slice(&1u32.to_le_bytes());
    for path in &paths {
        for unit in std::ffi::OsStr::new(path.as_str()).encode_wide().chain([0]) {
            drop.extend(unit.to_le_bytes());
        }
    }
    drop.extend([0, 0]);
    let effect: u32 = if cut { 2 } else { 1 };
    let files = global(&drop)?;
    let mode = global(&effect.to_le_bytes())?;
    with_clipboard(|| unsafe {
        EmptyClipboard().map_err(|e| e.to_string())?;
        // CF_HDROP
        SetClipboardData(15, Some(HANDLE(files.0))).map_err(|e| e.to_string())?;
        SetClipboardData(preferred_effect_format(), Some(HANDLE(mode.0)))
            .map_err(|e| e.to_string())?;
        Ok(())
    })
}

/// The files on the Windows clipboard, if it holds any - whoever put them there.
#[cfg(windows)]
pub fn clipboard_get() -> Result<Option<Clip>, String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::GetClipboardData;
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    with_clipboard(|| unsafe {
        let Ok(handle) = GetClipboardData(15) else {
            return Ok(None);
        };
        let drop = HDROP(handle.0);
        let count = DragQueryFileW(drop, u32::MAX, None);
        let mut paths = Vec::new();
        for index in 0..count {
            let len = DragQueryFileW(drop, index, None) as usize;
            let mut buffer = vec![0u16; len + 1];
            DragQueryFileW(drop, index, Some(&mut buffer));
            paths.push(String::from_utf16_lossy(&buffer[..len]));
        }
        let cut = match GetClipboardData(preferred_effect_format()) {
            Ok(mode) => {
                let global = HGLOBAL(mode.0);
                let data = GlobalLock(global) as *const u32;
                let value = if data.is_null() {
                    1
                } else {
                    data.read_unaligned()
                };
                let _ = GlobalUnlock(global);
                value & 2 != 0
            }
            Err(_) => false,
        };
        Ok((!paths.is_empty()).then_some(Clip { paths, cut }))
    })
}

#[cfg(not(windows))]
pub fn clipboard_set(_paths: Vec<String>, _cut: bool) -> Result<(), String> {
    Err("The file clipboard is only available on Windows.".into())
}

#[cfg(not(windows))]
pub fn clipboard_get() -> Result<Option<Clip>, String> {
    Ok(None)
}

/// Hands files to Windows as a real drag, so they can be dropped on Windows
/// Explorer, the desktop, another Files window or any program that takes
/// files. Must run on the window's own thread - that is where the mouse
/// button is held - and returns once the drop lands. Windows keeps the window
/// painting through the drag, the same as Explorer's own drags.
#[cfg(windows)]
pub fn drag_out(paths: &[String]) -> Result<&'static str, String> {
    use windows::core::{implement, BOOL, HRESULT, PCWSTR};
    use windows::Win32::Foundation::{
        DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, S_OK,
    };
    use windows::Win32::System::Com::IDataObject;
    use windows::Win32::System::Ole::{
        DoDragDrop, IDropSource, IDropSource_Impl, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_MOVE,
        DROPEFFECT_NONE,
    };
    use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
    use windows::Win32::UI::Shell::{
        BHID_DataObject, ILCreateFromPathW, ILFree, SHCreateShellItemArrayFromIDLists,
    };

    #[implement(IDropSource)]
    struct Source;
    impl IDropSource_Impl for Source_Impl {
        fn QueryContinueDrag(&self, escape: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
            if escape.as_bool() {
                DRAGDROP_S_CANCEL
            } else if keys.0 & MK_LBUTTON.0 == 0 {
                DRAGDROP_S_DROP
            } else {
                S_OK
            }
        }
        fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    refuse_zip(paths, "dragged out")?;
    let mut pidls = Vec::new();
    for path in paths {
        let wide: Vec<u16> = std::ffi::OsStr::new(path.as_str())
            .encode_wide()
            .chain([0])
            .collect();
        let pidl = unsafe { ILCreateFromPathW(PCWSTR(wide.as_ptr())) };
        if !pidl.is_null() {
            pidls.push(pidl as *const _);
        }
    }
    let result = (|| {
        if pidls.is_empty() {
            return Err("Nothing to drag.".to_string());
        }
        let items =
            unsafe { SHCreateShellItemArrayFromIDLists(&pidls) }.map_err(|e| e.to_string())?;
        let data: IDataObject =
            unsafe { items.BindToHandler(None, &BHID_DataObject) }.map_err(|e| e.to_string())?;
        let source: IDropSource = Source.into();
        let mut effect = DROPEFFECT_NONE;
        let _ = unsafe {
            DoDragDrop(
                &data,
                &source,
                DROPEFFECT_COPY | DROPEFFECT_MOVE,
                &mut effect,
            )
        };
        Ok(if effect.0 & DROPEFFECT_MOVE.0 != 0 {
            "move"
        } else if effect.0 & DROPEFFECT_COPY.0 != 0 {
            "copy"
        } else {
            "none"
        })
    })();
    for pidl in pidls {
        unsafe { ILFree(Some(pidl)) };
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole GDI path in one go: a real PNG on disk must come back as a
    /// data URL that decodes to a PNG. It is the only way to check the
    /// bitmap conversion without opening the app.
    #[test]
    #[cfg(windows)]
    fn thumbnails_a_real_image() {
        let icon = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("src")
            .join("wint-icon.png");
        assert!(icon.is_file(), "test fixture missing: {}", icon.display());
        let made = thumbnail(icon.to_string_lossy().into_owned(), 64)
            .expect("the thumbnail call itself failed");
        let url = made.expect("Windows returned no thumbnail for a PNG");
        assert!(url.starts_with("data:image/png;base64,"));
        assert!(
            url.len() > 200,
            "suspiciously small thumbnail: {}",
            url.len()
        );
    }

    #[test]
    fn thumbnail_of_a_folder_is_none() {
        let dir = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(thumbnail(dir, 64).expect("call failed").is_none());
    }

    #[test]
    fn delete_removes_a_file_outright() {
        let file =
            std::env::temp_dir().join(format!("wint-explorer-test-{}.txt", std::process::id()));
        std::fs::write(&file, b"delete me").unwrap();
        delete(vec![file.to_string_lossy().into_owned()], false).unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn deleting_something_already_gone_is_not_an_error() {
        let missing = std::env::temp_dir().join("wint-explorer-does-not-exist-xyz");
        delete(vec![missing.to_string_lossy().into_owned()], true).unwrap();
    }

    #[test]
    fn batch_rename_numbers_items_and_preserves_extensions() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("one.txt");
        let second = dir.path().join("two.png");
        std::fs::write(&first, b"one").unwrap();
        std::fs::write(&second, b"two").unwrap();
        let renamed = rename_many(
            vec![
                first.to_string_lossy().into_owned(),
                second.to_string_lossy().into_owned(),
            ],
            "report".into(),
        )
        .unwrap();
        assert_eq!(Path::new(&renamed[0]).file_name().unwrap(), "report.txt");
        assert_eq!(
            Path::new(&renamed[1]).file_name().unwrap(),
            "report (2).png"
        );
        assert!(Path::new(&renamed[0]).is_file());
        assert!(Path::new(&renamed[1]).is_file());
    }

    #[test]
    fn batch_rename_checks_every_destination_before_moving() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("one.txt");
        let second = dir.path().join("two.txt");
        let collision = dir.path().join("report (2).txt");
        for path in [&first, &second, &collision] {
            std::fs::write(path, b"x").unwrap();
        }
        assert!(rename_many(
            vec![
                first.to_string_lossy().into_owned(),
                second.to_string_lossy().into_owned()
            ],
            "report".into(),
        )
        .is_err());
        assert!(first.is_file());
        assert!(second.is_file());
    }
}
