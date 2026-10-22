//! The Notepad tool: plain text notes, each one a file.
//!
//! New notes are saved as `.txt` files in a folder the user chooses, and every
//! `.txt` in that folder is a note - there is no index beside them, so a file
//! dropped in from Explorer shows up as a tab. A file opened from anywhere
//! else stays where it is and is saved back to its own path.

use crate::off_thread;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Past this a file is more than a textarea can hold.
const MAX_NOTE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_NOTES: usize = 500;
/// What a tab is drawn from and what the editor shows at once: many screens
/// of text, read in a moment however large the file is.
const HEAD_BYTES: u64 = 128 * 1024;
/// The rest of a large file comes in pieces this size, so its progress can
/// be shown and no single answer holds anything up.
const PART_BYTES: u64 = 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    /// The full path, which is also the note's id.
    pub path: String,
    /// The start of the file - all of it once `next` has reached `size`.
    pub text: String,
    /// Milliseconds since the epoch, for the order of the tabs.
    pub modified: u64,
    /// The file's size in bytes.
    pub size: u64,
    /// Where in the file the rest starts.
    pub next: u64,
}

/// A piece of a file, read from an offset.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub text: String,
    pub next: u64,
    pub size: u64,
    pub modified: u64,
}

fn absolute(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(format!("{} is not a full path.", path.display()))
    }
}

/// Up to `max` bytes from `offset`, ending on a whole character so the parts
/// join back into exactly the file's text.
fn read_part(path: &Path, offset: u64, max: u64) -> Result<Part, String> {
    use std::io::{Read, Seek, SeekFrom};
    let fail = |e: std::io::Error| format!("Could not read {}: {e}", path.display());
    let mut file = std::fs::File::open(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    let meta = file.metadata().map_err(fail)?;
    let size = meta.len();
    if size > MAX_NOTE_BYTES {
        return Err(format!("{} is too large to open as a note.", path.display()));
    }
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    file.seek(SeekFrom::Start(offset)).map_err(fail)?;
    let mut bytes = Vec::with_capacity(max.min(size.saturating_sub(offset)) as usize);
    file.take(max).read_to_end(&mut bytes).map_err(fail)?;
    let at_end = offset + bytes.len() as u64 >= size;
    let used = match std::str::from_utf8(&bytes) {
        Ok(_) => bytes.len(),
        // A character cut in two by the end of the part waits for the next.
        Err(e) if e.error_len().is_none() && !at_end => e.valid_up_to(),
        Err(_) => return Err(format!("Could not read {} as text: it is not UTF-8.", path.display())),
    };
    bytes.truncate(used);
    let text = String::from_utf8(bytes).map_err(|_| format!("Could not read {} as text.", path.display()))?;
    Ok(Part { text, next: offset + used as u64, size, modified })
}

/// Only the start of the file: a tab needs no more, and a large file's rest
/// is fetched when it is opened.
fn read(path: &Path) -> Result<Note, String> {
    let head = read_part(path, 0, HEAD_BYTES)?;
    Ok(Note { path: path.to_string_lossy().into_owned(), text: head.text, modified: head.modified, size: head.size, next: head.next })
}

fn list(folder: &str) -> Result<Vec<Note>, String> {
    let dir = absolute(folder)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not open {folder}: {e}"))?;
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Could not read {folder}: {e}"))?;
    let notes = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("txt")))
        .filter_map(|path| read(&path).ok())
        .take(MAX_NOTES)
        .collect();
    Ok(notes)
}

/// Through a temporary file and a rename, so a WinT killed mid-save leaves the
/// previous text rather than half of the new one.
fn save(path: &str, text: &str) -> Result<(), String> {
    let path = absolute(path)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    let fail = |e: std::io::Error| format!("Could not save {}: {e}", path.display());
    let mut temporary = path.clone().into_os_string();
    temporary.push(".wint-tmp");
    let temporary = PathBuf::from(temporary);
    {
        let mut file = std::fs::File::create(&temporary).map_err(fail)?;
        file.write_all(text.as_bytes()).map_err(fail)?;
        file.sync_all().map_err(fail)?;
    }
    std::fs::rename(&temporary, &path).map_err(fail)
}

/// Renames a note in place: the new name is a file name, never a path, so a
/// rename can only ever move the file within its own folder. An existing file
/// is never overwritten - except the note itself, for a change of case.
fn rename(path: &str, name: &str) -> Result<String, String> {
    let from = absolute(path)?;
    let name = name.trim();
    if name.is_empty() || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) || name == "." || name == ".." {
        return Err(format!("{name} cannot be used as a file name."));
    }
    let dir = from.parent().ok_or("That note has no folder.")?;
    let to = dir.join(name);
    if to == from {
        return Ok(to.to_string_lossy().into_owned());
    }
    let same_file = to.to_string_lossy().eq_ignore_ascii_case(&from.to_string_lossy());
    if to.exists() && !same_file {
        return Err(format!("There is already a file called {name} there."));
    }
    std::fs::rename(&from, &to).map_err(|e| format!("Could not rename to {name}: {e}"))?;
    Ok(to.to_string_lossy().into_owned())
}

/// Only a note in the notes folder can be deleted from the tool. A file opened
/// from elsewhere is only ever closed, never removed. Deleted notes go to the
/// Recycle Bin.
fn delete(folder: &str, path: &str) -> Result<(), String> {
    let folder = absolute(folder)?;
    let path = absolute(path)?;
    if path.parent() != Some(folder.as_path()) {
        return Err("Only notes in the notes folder can be deleted here.".into());
    }
    if !path.exists() {
        return Ok(());
    }
    // One click on a tab deletes, so the file goes to the Recycle Bin, where
    // a wrong click can be undone.
    #[cfg(windows)]
    return crate::explorer::delete(vec![path.to_string_lossy().into_owned()], true);
    #[cfg(not(windows))]
    std::fs::remove_file(&path).map_err(|e| format!("Could not delete {}: {e}", path.display()))
}

/// Where notes go until the user picks somewhere else: a folder of its own
/// under Documents, so the files are easy to find without WinT.
#[tauri::command]
pub async fn notepad_default_folder(app: AppHandle) -> Result<String, String> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| format!("Windows did not provide a folder for notes: {e}"))?;
    Ok(base.join("WinT Notes").to_string_lossy().into_owned())
}

/// Every note in the folder, and every file opened from elsewhere that can
/// still be read. A file that has gone missing is left out, not an error.
#[tauri::command]
pub async fn notepad_list(folder: String, opened: Vec<String>) -> Result<Vec<Note>, String> {
    off_thread(move || {
        let mut notes = list(&folder)?;
        for path in opened {
            if notes.iter().any(|note| note.path.eq_ignore_ascii_case(&path)) {
                continue;
            }
            if let Ok(note) = absolute(&path).and_then(|p| read(&p)) {
                notes.push(note);
            }
        }
        Ok(notes)
    })
    .await
    .unwrap_or_else(|| Err("The notes could not be read.".into()))
}

#[tauri::command]
pub async fn notepad_read(path: String) -> Result<Note, String> {
    off_thread(move || absolute(&path).and_then(|p| read(&p)))
        .await
        .unwrap_or_else(|| Err("That file could not be read.".into()))
}

/// The next piece of a file whose start came with the list.
#[tauri::command]
pub async fn notepad_read_part(path: String, offset: u64) -> Result<Part, String> {
    off_thread(move || absolute(&path).and_then(|p| read_part(&p, offset, PART_BYTES)))
        .await
        .unwrap_or_else(|| Err("That file could not be read.".into()))
}

#[tauri::command]
pub async fn notepad_save(path: String, text: String) -> Result<(), String> {
    off_thread(move || save(&path, &text))
        .await
        .unwrap_or_else(|| Err("The note could not be saved.".into()))
}

/// Answers with the note's new full path.
#[tauri::command]
pub async fn notepad_rename(path: String, name: String) -> Result<String, String> {
    off_thread(move || rename(&path, &name))
        .await
        .unwrap_or_else(|| Err("The note could not be renamed.".into()))
}

#[tauri::command]
pub async fn notepad_delete(folder: String, path: String) -> Result<(), String> {
    off_thread(move || delete(&folder, &path))
        .await
        .unwrap_or_else(|| Err("The note could not be deleted.".into()))
}

/// The open dialog, on a worker thread like every other picker in WinT.
#[cfg(windows)]
#[tauri::command]
pub async fn notepad_pick(app: AppHandle) -> Result<Vec<String>, String> {
    let owner = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|hwnd| hwnd.0 as isize)
        .unwrap_or(0);
    off_thread(move || crate::picker::pick_text_files(owner))
        .await
        .unwrap_or_else(|| Err("Could not open the file picker.".into()))
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn notepad_pick() -> Result<Vec<String>, String> {
    Err("Opening files is only available on Windows.".into())
}
