//! Native clipboard history.
//!
//! The webview can only read the clipboard while a tool is open, and only
//! after Windows has prompted the user for permission. Windows itself will
//! tell any window that asks whenever the clipboard changes, so the history is
//! recorded here instead: a message-only window on its own thread holds a
//! clipboard-format listener for as long as WinT runs, and the front end only
//! ever reads what was already captured.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

/// Entries kept, newest first. Matches what the tool draws.
const MAX_CLIPS: usize = 250;
/// A single image larger than this is ignored — the same ceiling the tool
/// showed before, so a copied video frame cannot fill the history file.
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
/// Text longer than this is truncated; nothing past it is browsable anyway.
const MAX_TEXT_CHARS: usize = 200_000;
/// Images are dropped oldest-first once they add up to more than this, so the
/// history file stays something that can be written on every copy.
const MAX_IMAGE_TOTAL: usize = 48 * 1024 * 1024;
/// How much of that may survive a restart. Unpinned images past this stay in
/// the session's history only.
const MAX_IMAGE_PERSIST: usize = 8 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    /// `text`, `links`, `code` or `images`.
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub data_url: String,
    #[serde(default)]
    pub mime: String,
    #[serde(default)]
    pub size: usize,
    #[serde(default)]
    pub width: i32,
    #[serde(default)]
    pub height: i32,
    /// Milliseconds since the epoch, so the front end can format it directly.
    pub time: u64,
    #[serde(default)]
    pub pinned: bool,
}

struct Store {
    clips: Vec<Clip>,
    path: Option<PathBuf>,
}

static APP: OnceLock<AppHandle> = OnceLock::new();

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| {
        Mutex::new(Store {
            clips: Vec::new(),
            path: None,
        })
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn new_id() -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{}-{seq:x}", now_ms())
}

/// Mirrors the classification the tool used to do in the browser.
fn classify(text: &str) -> &'static str {
    let value = text.trim();
    if (value.starts_with("http://") || value.starts_with("https://"))
        && !value.chars().any(char::is_whitespace)
    {
        return "links";
    }
    if value.contains('\n') || value.contains(['{', '}', '(', ')', ';']) {
        return "code";
    }
    const KEYWORDS: [&str; 8] = [
        "const", "let", "fn", "class", "select", "git", "npm", "cargo",
    ];
    let lower = value.to_lowercase();
    if lower
        .split(|c: char| !c.is_alphanumeric())
        .any(|word| KEYWORDS.contains(&word))
    {
        return "code";
    }
    "text"
}

fn image_bytes(clip: &Clip) -> usize {
    if clip.kind == "images" {
        clip.data_url.len()
    } else {
        0
    }
}

/// Keeps the history inside its two ceilings: the entry count, and the room
/// images are allowed to take up. Pinned images survive the second.
fn trim(clips: &mut Vec<Clip>) {
    clips.truncate(MAX_CLIPS);
    let mut total: usize = clips.iter().map(image_bytes).sum();
    while total > MAX_IMAGE_TOTAL {
        let Some(index) = clips
            .iter()
            .rposition(|clip| clip.kind == "images" && !clip.pinned)
        else {
            break;
        };
        total -= image_bytes(&clips[index]);
        clips.remove(index);
    }
}

/// What is worth writing to disk. Images are kept across restarts only while
/// they fit the budget, because the file is rewritten on every copy and a
/// history full of screenshots would turn each one into a long disk write.
fn persistable(clips: &[Clip]) -> Vec<&Clip> {
    let mut budget = MAX_IMAGE_PERSIST;
    clips
        .iter()
        .filter(|clip| {
            let bytes = image_bytes(clip);
            if bytes == 0 || clip.pinned {
                return true;
            }
            if bytes > budget {
                return false;
            }
            budget -= bytes;
            true
        })
        .collect()
}

fn save(clips: &[Clip], path: Option<&PathBuf>) {
    let Some(path) = path else { return };
    let Ok(json) = serde_json::to_string(&persistable(clips)) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, json);
}

fn load(path: &PathBuf) -> Vec<Clip> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<Clip>>(&text).ok())
        .unwrap_or_default()
}

/// Records a clip and tells every window about it. Returns the stored entry,
/// which is the existing one moved back to the top when the same content was
/// copied again.
fn remember(mut clip: Clip) -> Option<Clip> {
    let stored = {
        let mut store = store().lock().ok()?;
        let duplicate = store.clips.iter().position(|row| {
            row.kind == clip.kind
                && if clip.kind == "images" {
                    row.data_url == clip.data_url
                } else {
                    row.text == clip.text
                }
        });
        if let Some(index) = duplicate {
            // Copying the same thing twice is one entry that moved, not two.
            // Windows also announces a single copy more than once, which is
            // what the short window here absorbs.
            if index == 0 && store.clips[0].time + 400 > clip.time {
                return None;
            }
            let mut existing = store.clips.remove(index);
            existing.time = clip.time;
            clip = existing;
        }
        store.clips.insert(0, clip);
        trim(&mut store.clips);
        let path = store.path.clone();
        save(&store.clips, path.as_ref());
        store.clips.first().cloned()
    }?;
    if let Some(app) = APP.get() {
        let _ = app.emit("clipboard:clip", stored.clone());
    }
    Some(stored)
}

pub fn history() -> Vec<Clip> {
    store()
        .lock()
        .map(|store| store.clips.clone())
        .unwrap_or_default()
}

fn mutate<F: FnOnce(&mut Vec<Clip>)>(change: F) -> Vec<Clip> {
    let Ok(mut store) = store().lock() else {
        return Vec::new();
    };
    change(&mut store.clips);
    let path = store.path.clone();
    save(&store.clips, path.as_ref());
    store.clips.clone()
}

pub fn set_pinned(id: &str, pinned: bool) -> Vec<Clip> {
    mutate(|clips| {
        if let Some(clip) = clips.iter_mut().find(|clip| clip.id == id) {
            clip.pinned = pinned;
        }
    })
}

pub fn forget(id: &str) -> Vec<Clip> {
    mutate(|clips| clips.retain(|clip| clip.id != id))
}

/// Forgets everything the user has not pinned.
pub fn clear() -> Vec<Clip> {
    mutate(|clips| clips.retain(|clip| clip.pinned))
}

/// Starts the listener. Reading the saved history and opening the message-only
/// window both happen on the listener's own thread, so startup never waits.
pub fn start(app_handle: AppHandle) {
    let _ = APP.set(app_handle.clone());
    std::thread::spawn(move || {
        let path = app_handle
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.join("clipboard-history.json"));
        if let Ok(mut store) = store().lock() {
            let mut clips = path.as_ref().map(load).unwrap_or_default();
            trim(&mut clips);
            store.clips = clips;
            store.path = path;
        }
        #[cfg(windows)]
        win::listen();
    });
}

/// Reads whatever is on the clipboard right now, for the tool's capture
/// button. `Ok(None)` means the clipboard held nothing WinT can keep.
pub fn capture() -> Result<Option<Clip>, String> {
    #[cfg(windows)]
    {
        Ok(win::read_clipboard()?.and_then(remember))
    }
    #[cfg(not(windows))]
    Ok(None)
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let trio = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let packed = ((trio[0] as u32) << 16) | ((trio[1] as u32) << 8) | trio[2] as u32;
        out.push(BASE64[(packed >> 18) as usize & 63] as char);
        out.push(BASE64[(packed >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            BASE64[(packed >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64[packed as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(windows)]
mod win {
    use super::{base64, classify, new_id, now_ms, remember, Clip, MAX_IMAGE_BYTES, MAX_TEXT_CHARS};
    use windows::core::w;
    use windows::Win32::Foundation::{HGLOBAL, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::DataExchange::{
        AddClipboardFormatListener, CloseClipboard, GetClipboardData, IsClipboardFormatAvailable,
        OpenClipboard, RegisterClipboardFormatW,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
        TranslateMessage, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW,
    };

    const CF_UNICODETEXT: u32 = 13;
    const CF_DIB: u32 = 8;
    const CF_DIBV5: u32 = 17;
    const WM_CLIPBOARDUPDATE: u32 = 0x031D;

    /// Runs for the life of the app: a window that draws nothing and exists
    /// only to be told that the clipboard changed.
    pub fn listen() {
        unsafe {
            let Ok(instance) = GetModuleHandleW(None) else {
                return;
            };
            let class = WNDCLASSW {
                lpfnWndProc: Some(wndproc),
                hInstance: instance.into(),
                lpszClassName: w!("WinTClipboardListener"),
                ..Default::default()
            };
            if RegisterClassW(&class) == 0 {
                return;
            }
            let Ok(window) = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("WinTClipboardListener"),
                w!("WinT clipboard"),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                Some(instance.into()),
                None,
            ) else {
                return;
            };
            if AddClipboardFormatListener(window).is_err() {
                return;
            }
            // Whatever is already on the clipboard counts as the first entry.
            if let Ok(Some(clip)) = read_clipboard() {
                remember(clip);
            }
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }

    unsafe extern "system" fn wndproc(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_CLIPBOARDUPDATE {
            if let Ok(Some(clip)) = read_clipboard() {
                remember(clip);
            }
            return LRESULT(0);
        }
        unsafe { DefWindowProcW(window, message, wparam, lparam) }
    }

    /// The clipboard is one system-wide lock that the copying app may still be
    /// holding when it announces the change, so a refused open is retried
    /// rather than dropped.
    fn open_clipboard() -> bool {
        for attempt in 0..12 {
            if unsafe { OpenClipboard(None) }.is_ok() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(10 + attempt * 5));
        }
        false
    }

    fn clipboard_bytes(format: u32) -> Option<Vec<u8>> {
        unsafe {
            let handle = GetClipboardData(format).ok()?;
            let global = HGLOBAL(handle.0);
            let size = GlobalSize(global);
            if size == 0 {
                return None;
            }
            let pointer = GlobalLock(global);
            if pointer.is_null() {
                return None;
            }
            let bytes = std::slice::from_raw_parts(pointer as *const u8, size).to_vec();
            let _ = GlobalUnlock(global);
            Some(bytes)
        }
    }

    pub fn read_clipboard() -> Result<Option<Clip>, String> {
        if !open_clipboard() {
            return Err("Windows would not hand over the clipboard.".into());
        }
        let clip = read_open_clipboard();
        unsafe {
            let _ = CloseClipboard();
        }
        Ok(clip)
    }

    fn read_open_clipboard() -> Option<Clip> {
        let png = unsafe { RegisterClipboardFormatW(w!("PNG")) };
        let available = |format: u32| unsafe { IsClipboardFormatAvailable(format).is_ok() };

        // A browser or a screenshot tool offers real PNG bytes; anything else
        // offers a device-independent bitmap, which only needs its file header
        // put back to become something the webview can draw.
        if png != 0 && available(png) {
            if let Some(bytes) = clipboard_bytes(png) {
                if bytes.len() <= MAX_IMAGE_BYTES {
                    let (width, height) = png_size(&bytes);
                    return Some(image_clip(&bytes, "image/png", width, height));
                }
            }
        }
        for format in [CF_DIBV5, CF_DIB] {
            if !available(format) {
                continue;
            }
            let Some(bytes) = clipboard_bytes(format) else {
                continue;
            };
            if let Some((bmp, width, height)) = dib_to_bmp(&bytes) {
                if bmp.len() <= MAX_IMAGE_BYTES {
                    return Some(image_clip(&bmp, "image/bmp", width, height));
                }
            }
        }
        if available(CF_UNICODETEXT) {
            let bytes = clipboard_bytes(CF_UNICODETEXT)?;
            let wide: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .take_while(|unit| *unit != 0)
                .collect();
            let mut text = String::from_utf16_lossy(&wide);
            if text.trim().is_empty() {
                return None;
            }
            if text.chars().count() > MAX_TEXT_CHARS {
                text = text.chars().take(MAX_TEXT_CHARS).collect();
            }
            return Some(Clip {
                id: new_id(),
                kind: classify(&text).into(),
                size: text.len(),
                mime: "text/plain".into(),
                text,
                data_url: String::new(),
                width: 0,
                height: 0,
                time: now_ms(),
                pinned: false,
            });
        }
        None
    }

    fn image_clip(bytes: &[u8], mime: &str, width: i32, height: i32) -> Clip {
        Clip {
            id: new_id(),
            kind: "images".into(),
            text: String::new(),
            data_url: format!("data:{mime};base64,{}", base64(bytes)),
            mime: mime.into(),
            size: bytes.len(),
            width,
            height,
            time: now_ms(),
            pinned: false,
        }
    }

    fn read_i32(bytes: &[u8], at: usize) -> i32 {
        i32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
    }

    fn png_size(bytes: &[u8]) -> (i32, i32) {
        if bytes.len() < 24 {
            return (0, 0);
        }
        let big =
            |at: usize| i32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
        (big(16), big(20))
    }

    /// Puts a `BITMAPFILEHEADER` back in front of a clipboard DIB. The only
    /// real work is finding where the pixels start, which depends on the
    /// header version, the colour masks and the palette.
    fn dib_to_bmp(bytes: &[u8]) -> Option<(Vec<u8>, i32, i32)> {
        if bytes.len() < 40 {
            return None;
        }
        let header_size = read_i32(bytes, 0) as usize;
        if header_size < 40 || bytes.len() <= header_size {
            return None;
        }
        let width = read_i32(bytes, 4);
        let height = read_i32(bytes, 8);
        let bit_count = u16::from_le_bytes([bytes[14], bytes[15]]) as usize;
        let compression = read_i32(bytes, 16) as u32;
        let colors_used = read_i32(bytes, 32) as usize;
        let mut offset = 14 + header_size;
        if header_size == 40 {
            // BI_BITFIELDS and BI_ALPHABITFIELDS keep their masks after the
            // header; later header versions carry them inside it.
            offset += match compression {
                3 => 12,
                6 => 16,
                _ => 0,
            };
        }
        if bit_count <= 8 {
            let colors = if colors_used > 0 {
                colors_used
            } else {
                1usize << bit_count
            };
            offset += colors * 4;
        }
        if offset < 14 || offset - 14 >= bytes.len() {
            return None;
        }
        let mut pixels = bytes.to_vec();
        if bit_count == 32 && compression == 0 {
            // BI_RGB leaves the fourth byte undefined, and a capture that
            // filled it with zeroes would otherwise draw as fully transparent.
            for pixel in pixels[offset - 14..].chunks_exact_mut(4) {
                pixel[3] = 255;
            }
        }
        let mut out = Vec::with_capacity(14 + pixels.len());
        out.extend_from_slice(b"BM");
        out.extend_from_slice(&((14 + pixels.len()) as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        out.extend_from_slice(&pixels);
        Some((out, width, height.abs()))
    }
}
