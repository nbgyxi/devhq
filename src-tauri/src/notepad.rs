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

/// Past this a file is not a note somebody typed, and reading every one of
/// them on each open would be the tool's slowest step.
const MAX_NOTE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_NOTES: usize = 500;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    /// The full path, which is also the note's id.
    pub path: String,
    pub text: String,
    /// Milliseconds since the epoch, for the order of the tabs.
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

fn read(path: &Path) -> Result<Note, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    if meta.len() > MAX_NOTE_BYTES {
        return Err(format!("{} is too large to open as a note.", path.display()));
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("Could not read {} as text: {e}", path.display()))?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Ok(Note { path: path.to_string_lossy().into_owned(), text, modified })
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
