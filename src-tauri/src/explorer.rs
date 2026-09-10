//! Backing for the Files tool: a plain filesystem browser.
//!
//! Everything here is one shallow `read_dir` of one folder. There is no
//! recursion and no sizing of folders - that is Disk Space Usage's job, and it
//! is exactly what makes a folder listing slow. A listing must come back fast
//! enough that clicking a tree node feels like the folder was already open.
use serde::Serialize;
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

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
            .filter(|path| Path::new(path).is_dir())
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
        .filter(|path| Path::new(path).is_dir())
        .collect();
    let file = bookmarks_file(app_data).ok_or("There is nowhere to save bookmarks.")?;
    std::fs::write(
        &file,
        serde_json::to_string(&kept).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("The bookmarks could not be saved. {error}"))?;
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

/// A thumbnail for one file, as a `data:` URL.
///
/// Windows draws it, not this app: `IShellItemImageFactory` returns the same
/// picture Explorer shows, out of the same cache, already scaled down. Reading
/// the file and shrinking it here would mean pulling whole 20 MB photographs
/// through the bridge to draw them 28 pixels wide.
///
/// A data URL rather than a path, for the reason `workspace_read_image` gives:
/// nothing in `src/` can point an `<img>` at a real path without opening the
/// asset protocol to the whole disk, and a thumbnail is small enough to hand
/// over inline.
#[cfg(windows)]
pub fn thumbnail(raw_path: String, size: u32) -> Result<Option<String>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, DIB_RGB_COLORS,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK,
        SIIGBF_THUMBNAILONLY,
    };

    // The shell parses this path itself and is stricter than the rest of
    // Windows: a forward slash anywhere in it is rejected outright with "the
    // parameter is incorrect", even though every std::fs call accepts one.
    let path = PathBuf::from(raw_path.replace('/', "\\"));
    if !path.is_file() {
        return Ok(None);
    }
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // Every call lands on a spawn_blocking thread that has never seen COM, so
    // it is initialised here and torn down before the thread goes back.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
    let result = (|| -> Result<Option<String>, String> {
        // A file the shell will not even name is a file with no thumbnail,
        // not an error worth showing: the row keeps its type icon either way,
        // and one unreadable file must not colour the whole folder red.
        let factory: IShellItemImageFactory =
            match unsafe { SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None) } {
                Ok(factory) => factory,
                Err(_) => return Ok(None),
            };
        // THUMBNAILONLY stops Windows falling back to the generic icon for the
        // file type. This tool draws its own type icons, and a second-rate
        // copy of one is worse than none at all.
        let bitmap = match unsafe {
            factory.GetImage(
                SIZE {
                    cx: size as i32,
                    cy: size as i32,
                },
                SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK,
            )
        } {
            Ok(bitmap) => bitmap,
            // No thumbnail is an ordinary answer, not a failure: plenty of
            // files have none, and the row simply keeps its type icon.
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
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder
                .write_header()
                .map_err(|error| format!("The thumbnail could not be encoded. {error}"))?;
            writer
                .write_image_data(&pixels)
                .map_err(|error| format!("The thumbnail could not be encoded. {error}"))?;
        }
        Ok(Some(format!(
            "data:image/png;base64,{}",
            crate::workspace::base64(&png)
        )))
    })();
    unsafe { CoUninitialize() };
    result
}

#[cfg(not(windows))]
pub fn thumbnail(_raw_path: String, _size: u32) -> Result<Option<String>, String> {
    Ok(None)
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
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
        FO_DELETE, SHFILEOPSTRUCTW,
    };

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
    let targets: Vec<&String> = paths
        .iter()
        .filter(|path| Path::new(path.as_str()).exists())
        .collect();
    delete_outright(&targets)
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
        assert!(url.len() > 200, "suspiciously small thumbnail: {}", url.len());
    }

    #[test]
    fn thumbnail_of_a_folder_is_none() {
        let dir = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(thumbnail(dir, 64).expect("call failed").is_none());
    }

    #[test]
    fn delete_removes_a_file_outright() {
        let file = std::env::temp_dir().join(format!("wint-explorer-test-{}.txt", std::process::id()));
        std::fs::write(&file, b"delete me").unwrap();
        delete(vec![file.to_string_lossy().into_owned()], false).unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn deleting_something_already_gone_is_not_an_error() {
        let missing = std::env::temp_dir().join("wint-explorer-does-not-exist-xyz");
        delete(vec![missing.to_string_lossy().into_owned()], true).unwrap();
    }
}
