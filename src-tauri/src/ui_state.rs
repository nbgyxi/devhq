//! Small pieces of front-end state that must survive the window closing.
//!
//! The webviews keep their own preferences in `localStorage`, which is the
//! right place for anything whose loss would not be noticed. It is the wrong
//! place for anything the user would call *saved*: WebView2 writes it to disk
//! when it gets round to it, so a change made shortly before the window went
//! away — the last tick of a checkbox, the width a column was just dragged to,
//! the size a window was just given — was simply gone on the next start.
//!
//! Everything here is written through a temporary file and fsynced before the
//! command answers, so the value is on disk by the time the page is told it
//! was stored, whatever happens to WinT a moment later.

use crate::off_thread;
use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// One file per key, so a corrupt or half-written value can only ever cost the
/// one thing it holds.
fn path_for(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
    let key = sanitize(key)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Windows did not provide a folder to save in: {e}"))?
        .join("ui-state");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create the save folder: {e}"))?;
    Ok(dir.join(format!("{key}.json")))
}

/// Keys come from the front end, and a key is a file name here. Anything that
/// could climb out of the folder is refused rather than mangled, so a caller
/// never quietly writes somewhere else.
fn sanitize(key: &str) -> Result<String, String> {
    let ok = !key.is_empty()
        && key.len() <= 120
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !key.contains("..");
    if ok {
        Ok(key.to_ascii_lowercase())
    } else {
        Err(format!("{key} is not a name this can be saved under."))
    }
}

/// Reads one value, on the calling thread. For the window-building path, which
/// is already off the main thread and needs the answer before it can place the
/// window. A missing or unreadable file reads as nothing: state that cannot be
/// read is state the caller falls back to its default for.
pub fn read(app: &AppHandle, key: &str) -> Option<Value> {
    let path = path_for(app, key).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Writes one value, on the calling thread. See the module note on why this
/// goes all the way to the platter.
pub fn write(app: &AppHandle, key: &str, value: &Value) -> Result<(), String> {
    let path = path_for(app, key)?;
    let temporary = path.with_extension("json.tmp");
    let text = serde_json::to_string(value).map_err(|e| e.to_string())?;
    {
        let mut file = std::fs::File::create(&temporary)
            .map_err(|e| format!("Could not save that setting: {e}"))?;
        file.write_all(text.as_bytes())
            .map_err(|e| format!("Could not save that setting: {e}"))?;
        // A rename alone is not enough: the directory entry can land while the
        // contents are still in a cache the machine loses on the way down.
        file.sync_all()
            .map_err(|e| format!("Could not save that setting: {e}"))?;
    }
    // Rename over the old file, so a WinT killed mid-write leaves the previous
    // value intact rather than half of the new one.
    std::fs::rename(&temporary, &path).map_err(|e| format!("Could not save that setting: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn ui_state_get(app: AppHandle, key: String) -> Result<Option<Value>, String> {
    Ok(off_thread(move || read(&app, &key)).await.flatten())
}

#[tauri::command]
pub async fn ui_state_set(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    off_thread(move || write(&app, &key, &value))
        .await
        .unwrap_or_else(|| Err("That setting could not be saved.".into()))
}
