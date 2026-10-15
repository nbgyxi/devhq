//! Screenshot: one shortcut freezes the screen, a drag picks the part that
//! matters, and that part is on the clipboard. The second shortcut does the
//! same and opens the part in a small editor instead.
//!
//! The selection is a native window rather than a webview. It has to be on
//! screen the moment the key goes down, cover every monitor at its own scale,
//! and show the screen as it was when the key was pressed - a context menu or
//! a tooltip that closes as focus moves is usually the very thing being shot.
//! A frozen bitmap drawn by GDI does all three; a webview would first have to
//! start, then be handed the picture.
//!
//! Everything here runs on a thread of its own: the hotkey only starts it.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, WebviewUrl, WebviewWindowBuilder};

/// One selection at a time: a second press while the overlay is up is the
/// same press again, not a second overlay stacked on the first.
static BUSY: AtomicBool = AtomicBool::new(false);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// The PNG each open editor was started with, until its window closes.
static SHOTS: Mutex<Option<HashMap<u64, Vec<u8>>>> = Mutex::new(None);
static BINDINGS: Mutex<Bindings> = Mutex::new(Bindings {
    slots: Vec::new(),
    ids: Vec::new(),
    light: false,
});
/// Set while the Screenshot tool page is waiting for a key: a screenshot
/// shortcut pressed then is what the user wants to bind, not a screenshot.
/// Windows hands a registered hotkey to WinT and never to the page, so this is
/// the only way the page can learn of it.
static RECORDING: AtomicBool = AtomicBool::new(false);
/// Set the first time a Print Screen shortcut reaches WinT, which settles
/// whether Windows' own Snipping Tool switch is in the way.
static PRINT_SCREEN_SEEN: AtomicBool = AtomicBool::new(false);

/// One screenshot shortcut slot, as the shell's Hotkeys settings hold it.
#[derive(Clone, Serialize, Deserialize)]
pub struct Slot {
    id: String,
    edit: bool,
    binding: String,
    /// Why Windows would not register this shortcut for WinT - usually that
    /// another program (Greenshot, ShareX, Snipping Tool) already holds it.
    #[serde(default)]
    error: String,
}

/// Every slot, and the global-shortcut id of each slot that is bound - in
/// step with `slots`, `None` where a slot is empty or did not parse.
struct Bindings {
    slots: Vec<Slot>,
    ids: Vec<Option<u32>>,
    light: bool,
}

/// What the shell shows in its status bar while a screenshot is under way.
#[derive(Clone, Serialize)]
struct Status {
    /// `selecting`, `done`, `cancelled` or `failed`.
    phase: &'static str,
    line: String,
}

fn status(app: &AppHandle, phase: &'static str, line: impl Into<String>) {
    let _ = app.emit(
        "screenshot:status",
        Status {
            phase,
            line: line.into(),
        },
    );
}

/// Whether a global hotkey is one of the screenshot shortcuts, and if so,
/// start it. Called from the global-shortcut handler; true when handled.
pub fn handle_hotkey(app: &AppHandle, id: u32) -> bool {
    let slot = match BINDINGS.lock() {
        Ok(bindings) => bindings
            .ids
            .iter()
            .position(|known| *known == Some(id))
            .map(|index| bindings.slots[index].clone()),
        Err(_) => return false,
    };
    let Some(slot) = slot else {
        return false;
    };
    if slot.binding.to_ascii_lowercase().contains("printscreen") {
        PRINT_SCREEN_SEEN.store(true, Ordering::Relaxed);
    }
    if RECORDING.load(Ordering::Relaxed) {
        let _ = app.emit("screenshot:recorded-key", slot.binding);
        return true;
    }
    start(app.clone(), slot.edit, 0);
    true
}

#[derive(Clone, Serialize)]
pub struct BindingState {
    slots: Vec<Slot>,
    /// True when Windows' own "Use the Print screen key to open screen
    /// capture" is switched on and no Print Screen shortcut has reached WinT
    /// yet - the one case where it is worth saying the key may be taken.
    #[serde(rename = "printScreenTaken")]
    print_screen_taken: bool,
}

fn binding_state(snipping_on: bool) -> BindingState {
    BindingState {
        slots: BINDINGS.lock().map(|b| b.slots.clone()).unwrap_or_default(),
        print_screen_taken: snipping_on && !PRINT_SCREEN_SEEN.load(Ordering::Relaxed),
    }
}

/// The shell hands over every screenshot slot whenever the hotkeys change.
/// The shortcuts are registered by the shell as usual; this only tells the
/// native handler which presses are screenshots, so the window is never
/// involved. Bindings that do not parse are left unbound and reported.
#[tauri::command]
pub async fn screenshot_global_bindings_set(
    app: AppHandle,
    slots: Vec<Slot>,
    theme: Option<String>,
) -> Result<(), String> {
    let mut errors = Vec::new();
    let ids = slots
        .iter()
        .map(|slot| {
            let binding = slot.binding.trim();
            if binding.is_empty() {
                return None;
            }
            match binding.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                Ok(shortcut) => Some(shortcut.id),
                Err(e) => {
                    errors.push(format!("{binding} is not a shortcut: {e}"));
                    None
                }
            }
        })
        .collect();
    {
        let mut bindings = BINDINGS
            .lock()
            .map_err(|_| "Screenshot shortcut state is unavailable.".to_string())?;
        bindings.slots = slots;
        bindings.ids = ids;
        bindings.light = theme.as_deref() == Some("light");
    }
    let snipping_on = crate::off_thread(win::print_screen_opens_snipping)
        .await
        .unwrap_or(false);
    let _ = app.emit("screenshot:bindings", binding_state(snipping_on));
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join(" "))
    }
}

/// The slots as the user bound them, for the tool page to show.
#[tauri::command]
pub async fn screenshot_bindings() -> BindingState {
    let snipping_on = crate::off_thread(win::print_screen_opens_snipping)
        .await
        .unwrap_or(false);
    binding_state(snipping_on)
}

/// The tool page picked a shortcut for a slot. The shell owns the hotkey
/// settings, so it is asked to make the change; it saves, registers, and the
/// new slots come back through `screenshot:bindings`.
#[tauri::command]
pub fn screenshot_binding_request(app: AppHandle, id: String, binding: String) {
    #[derive(Clone, Serialize)]
    struct Request {
        id: String,
        binding: String,
    }
    let _ = app.emit("screenshot:set-binding", Request { id, binding });
}

/// The tool page is waiting for a key, or has stopped waiting.
#[tauri::command]
pub fn screenshot_recording(on: bool) {
    RECORDING.store(on, Ordering::Relaxed);
}

/// Open the Windows settings page that has the Print screen switch.
#[tauri::command]
pub async fn screenshot_open_print_screen_setting() -> Result<(), String> {
    crate::off_thread(|| {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        std::process::Command::new("explorer.exe")
            .arg("ms-settings:easeofaccess-keyboard")
            .creation_flags(DETACHED_PROCESS)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Could not open Settings: {e}"))
    })
    .await
    .unwrap_or_else(|| Err("Could not open Settings.".into()))
}

/// Start a screenshot from a button or the command palette. `delay_ms` lets
/// whatever was clicked get out of the way before the screen is frozen.
#[tauri::command]
pub fn screenshot_start(app: AppHandle, edit: bool, delay_ms: Option<u64>) {
    start(app, edit, delay_ms.unwrap_or(0).min(10_000));
}

fn start(app: AppHandle, edit: bool, delay_ms: u64) {
    if BUSY.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(move || {
        if delay_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        }
        status(
            &app,
            "selecting",
            if edit {
                "Screenshot: drag over the part to edit - Esc cancels"
            } else {
                "Screenshot: drag over the part to copy - Esc cancels"
            },
        );
        let result = win::select();
        BUSY.store(false, Ordering::Release);
        match result {
            Ok(Some(shot)) => finish(&app, shot, edit),
            Ok(None) => status(&app, "cancelled", "Screenshot cancelled"),
            Err(error) => status(&app, "failed", format!("Screenshot failed: {error}")),
        }
    });
}

/// A selected part of the screen, as RGBA rows top to bottom.
pub struct Shot {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    /// The centre of the selection in physical screen pixels, so the editor
    /// opens on the monitor the shot was taken from.
    pub center: (i32, i32),
}

fn finish(app: &AppHandle, shot: Shot, edit: bool) {
    let size = format!("{} × {}", shot.width, shot.height);
    if !edit {
        let result = encode_png(&shot.rgba, shot.width, shot.height)
            .and_then(|png| win::set_clipboard_image(&shot.rgba, shot.width, shot.height, &png));
        match result {
            Ok(()) => status(
                app,
                "done",
                format!("Screenshot copied to the clipboard - {size}"),
            ),
            Err(error) => status(
                app,
                "failed",
                format!("Screenshot could not be copied: {error}"),
            ),
        }
        return;
    }
    let png = match encode_png(&shot.rgba, shot.width, shot.height) {
        Ok(png) => png,
        Err(error) => {
            status(
                app,
                "failed",
                format!("Screenshot could not be prepared: {error}"),
            );
            return;
        }
    };
    match open_editor(app, png, &shot) {
        Ok(()) => status(
            app,
            "done",
            format!("Screenshot opened in the editor - {size}"),
        ),
        Err(error) => status(
            app,
            "failed",
            format!("The screenshot editor could not open: {error}"),
        ),
    }
}

fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

fn open_editor(app: &AppHandle, png: Vec<u8>, shot: &Shot) -> Result<(), String> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    SHOTS
        .lock()
        .map_err(|_| "screenshot state is unavailable".to_string())?
        .get_or_insert_with(HashMap::new)
        .insert(id, png);
    let light = BINDINGS.lock().map(|b| b.light).unwrap_or(false);

    // Big enough to show the shot at its real size when it fits, never bigger
    // than most of the monitor it came from, and never too small for the
    // toolbar.
    let monitor = app
        .monitor_from_point(shot.center.0 as f64, shot.center.1 as f64)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let (scale, area) = monitor
        .as_ref()
        .map(|m| (m.scale_factor(), Some(*m.work_area())))
        .unwrap_or((1.0, None));
    let (max_w, max_h) = area
        .map(|a| {
            (
                a.size.width as f64 / scale * 0.85,
                a.size.height as f64 / scale * 0.85,
            )
        })
        .unwrap_or((1200.0, 800.0));
    let width = (shot.width as f64 / scale + 48.0).clamp(560.0, max_w.max(560.0));
    let height = (shot.height as f64 / scale + 140.0).clamp(380.0, max_h.max(380.0));

    let label = format!("shot-{id}");
    let page = format!(
        "screenshot-editor.html?id={id}&theme={}",
        if light { "light" } else { "dark" }
    );
    let background = if light {
        tauri::webview::Color(244, 245, 248, 255)
    } else {
        tauri::webview::Color(12, 13, 17, 255)
    };
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(page.into()))
        .title("Screenshot")
        .inner_size(width, height)
        .min_inner_size(520.0, 340.0)
        .decorations(false)
        .resizable(true)
        .background_color(background)
        .focused(true);
    builder = match area {
        Some(a) => {
            let x = a.position.x as f64 / scale + (a.size.width as f64 / scale - width) / 2.0;
            let y = a.position.y as f64 / scale + (a.size.height as f64 / scale - height) / 2.0;
            builder.position(x, y)
        }
        None => builder.center(),
    };
    let window = builder.build().map_err(|e| e.to_string())?;
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Ok(mut shots) = SHOTS.lock() {
                if let Some(shots) = shots.as_mut() {
                    shots.remove(&id);
                }
            }
        }
    });
    let _ = window.set_focus();
    Ok(())
}

/// The PNG an editor window was opened with, as raw bytes.
#[tauri::command]
pub fn screenshot_image(id: u64) -> Result<tauri::ipc::Response, String> {
    SHOTS
        .lock()
        .map_err(|_| "Screenshot state is unavailable.".to_string())?
        .as_ref()
        .and_then(|shots| shots.get(&id).cloned())
        .map(tauri::ipc::Response::new)
        .ok_or_else(|| "That screenshot is no longer there.".to_string())
}

fn raw_body(request: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        _ => Err("The image did not arrive as PNG bytes.".into()),
    }
}

/// Put the edited image on the clipboard. The page sends the PNG it drew.
#[tauri::command]
pub async fn screenshot_copy(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let png = raw_body(&request)?;
    crate::off_thread(move || {
        let image = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
            .map_err(|e| format!("The edited image could not be read: {e}"))?
            .to_rgba8();
        let (width, height) = image.dimensions();
        win::set_clipboard_image(image.as_raw(), width, height, &png)
    })
    .await
    .unwrap_or_else(|| Err("Copying the screenshot did not finish.".into()))
}

/// Save the edited image to Pictures\Screenshots and say where it went.
#[tauri::command]
pub async fn screenshot_save(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let png = raw_body(&request)?;
    crate::off_thread(move || {
        let folder = win::pictures_folder()?.join("Screenshots");
        std::fs::create_dir_all(&folder)
            .map_err(|e| format!("Could not create {}: {e}", folder.display()))?;
        let stamp = win::local_stamp();
        let mut path = folder.join(format!("WinT screenshot {stamp}.png"));
        let mut n = 2;
        while path.exists() {
            path = folder.join(format!("WinT screenshot {stamp} ({n}).png"));
            n += 1;
        }
        std::fs::write(&path, &png)
            .map_err(|e| format!("Could not save {}: {e}", path.display()))?;
        Ok(path.display().to_string())
    })
    .await
    .unwrap_or_else(|| Err("Saving the screenshot did not finish.".into()))
}

/// Show a saved screenshot in Explorer, selected.
#[tauri::command]
pub async fn screenshot_reveal(path: String) -> Result<(), String> {
    crate::off_thread(move || {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        if !std::path::Path::new(&path).exists() {
            return Err("That screenshot is no longer where it was saved.".into());
        }
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{path}"))
            .creation_flags(DETACHED_PROCESS)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Could not open Explorer: {e}"))
    })
    .await
    .unwrap_or_else(|| Err("Could not open Explorer.".into()))
}

mod win {
    use super::Shot;
    use std::cell::RefCell;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{
        COLORREF, HANDLE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
    };
    use windows::Win32::Graphics::Gdi::{
        BeginPaint, BitBlt, CombineRgn, CreateCompatibleDC, CreateDIBSection, CreateFontW,
        CreateRectRgn, CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, EndPaint, FillRect,
        FrameRect, GetDC, GetMonitorInfoW, GetUpdateRgn, InvalidateRgn, MonitorFromPoint,
        ReleaseDC, SelectClipRgn, SelectObject, SetBkMode, SetTextColor, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS,
        DEFAULT_CHARSET, DIB_RGB_COLORS, DT_CALCRECT, DT_CENTER, DT_NOPREFIX, DT_SINGLELINE,
        DT_VCENTER, FW_SEMIBOLD, HBITMAP, HDC, HRGN, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        OUT_DEFAULT_PRECIS, PAINTSTRUCT, RGN_DIFF, RGN_OR, RGN_XOR, ROP_CODE, SRCCOPY, TRANSPARENT,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::HiDpi::{
        GetDpiForWindow, SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, ReleaseCapture, SetCapture, SetFocus, VK_ESCAPE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos,
        GetMessageW, GetSystemMetrics, KillTimer, LoadCursorW, PostQuitMessage, RegisterClassW,
        SetForegroundWindow, SetTimer, ShowWindow, TranslateMessage, IDC_CROSS, MSG,
        SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_SHOW,
        WM_ERASEBKGND, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_PAINT,
        WM_RBUTTONUP, WM_TIMER, WNDCLASSW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    };

    const CLASS: PCWSTR = w!("WinTScreenshotOverlay");
    const ESC_TIMER: usize = 1;
    /// WinT's accent, as GDI wants it (0x00BBGGRR).
    const ACCENT: COLORREF = COLORREF(0x00FF_8B6D);

    /// A 32-bit top-down DIB section selected into a DC of its own.
    struct Surface {
        dc: HDC,
        bitmap: HBITMAP,
        bits: *mut u8,
        width: i32,
        height: i32,
    }

    impl Surface {
        unsafe fn new(width: i32, height: i32) -> Result<Self, String> {
            let screen = unsafe { GetDC(None) };
            let dc = unsafe { CreateCompatibleDC(Some(screen)) };
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let bitmap = unsafe {
                CreateDIBSection(Some(screen), &info, DIB_RGB_COLORS, &mut bits, None, 0)
            };
            unsafe { ReleaseDC(None, screen) };
            let bitmap = match bitmap {
                Ok(bitmap) if !bits.is_null() => bitmap,
                _ => {
                    let _ = unsafe { DeleteDC(dc) };
                    return Err("Windows would not hand over memory for the picture.".into());
                }
            };
            unsafe { SelectObject(dc, bitmap.into()) };
            Ok(Self {
                dc,
                bitmap,
                bits: bits.cast(),
                width,
                height,
            })
        }

        fn pixels(&self) -> &[u8] {
            unsafe {
                std::slice::from_raw_parts(self.bits, (self.width * self.height * 4) as usize)
            }
        }

        fn pixels_mut(&mut self) -> &mut [u8] {
            unsafe {
                std::slice::from_raw_parts_mut(self.bits, (self.width * self.height * 4) as usize)
            }
        }
    }

    impl Drop for Surface {
        fn drop(&mut self) {
            unsafe {
                let _ = DeleteDC(self.dc);
                let _ = DeleteObject(self.bitmap.into());
            }
        }
    }

    struct Overlay {
        /// The virtual screen's top-left corner in screen coordinates.
        origin: (i32, i32),
        bright: Surface,
        dim: Surface,
        back: Surface,
        /// The DPI the overlay is drawn at, for sizing the labels.
        scale: i32,
        /// Where the drag began and where the pointer is now, in client
        /// coordinates (which are the virtual screen, shifted to 0,0).
        anchor: Option<(i32, i32)>,
        pointer: (i32, i32),
        result: Option<RECT>,
        finished: bool,
    }

    thread_local! {
        static OVERLAY: RefCell<Option<Overlay>> = const { RefCell::new(None) };
    }

    fn normalized(a: (i32, i32), b: (i32, i32)) -> RECT {
        RECT {
            left: a.0.min(b.0),
            top: a.1.min(b.1),
            right: a.0.max(b.0) + 1,
            bottom: a.1.max(b.1) + 1,
        }
    }

    /// Freeze the screen, let the user pick part of it, and hand back that
    /// part. `None` when the selection was cancelled.
    pub fn select() -> Result<Option<Shot>, String> {
        unsafe {
            // Physical pixels throughout, on every monitor, whatever its scale.
            SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if width <= 0 || height <= 0 {
                return Err("Windows reported no screen to capture.".into());
            }

            let bright = Surface::new(width, height)?;
            let screen = GetDC(None);
            let copied = BitBlt(
                bright.dc,
                0,
                0,
                width,
                height,
                Some(screen),
                x,
                y,
                ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0),
            );
            ReleaseDC(None, screen);
            copied.map_err(|e| format!("Windows would not copy the screen: {e}"))?;

            // Everything outside the selection is drawn at half brightness.
            let mut dim = Surface::new(width, height)?;
            dim.pixels_mut().copy_from_slice(bright.pixels());
            for pixel in dim.pixels_mut().chunks_exact_mut(4) {
                pixel[0] >>= 1;
                pixel[1] >>= 1;
                pixel[2] >>= 1;
            }
            let back = Surface::new(width, height)?;

            let instance = GetModuleHandleW(None).map_err(|e| e.to_string())?;
            let class = WNDCLASSW {
                lpfnWndProc: Some(wndproc),
                hInstance: instance.into(),
                lpszClassName: CLASS,
                hCursor: LoadCursorW(None, IDC_CROSS).unwrap_or_default(),
                ..Default::default()
            };
            // Fails harmlessly on every shot after the first: the class is
            // already there.
            RegisterClassW(&class);

            let mut cursor = POINT::default();
            let _ = GetCursorPos(&mut cursor);
            OVERLAY.with(|cell| {
                *cell.borrow_mut() = Some(Overlay {
                    origin: (x, y),
                    bright,
                    dim,
                    back,
                    scale: 96,
                    anchor: None,
                    pointer: (cursor.x - x, cursor.y - y),
                    result: None,
                    finished: false,
                })
            });

            let window = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                CLASS,
                w!("WinT screenshot"),
                WS_POPUP,
                x,
                y,
                width,
                height,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .map_err(|e| {
                OVERLAY.with(|cell| cell.borrow_mut().take());
                format!("The selection could not be shown: {e}")
            })?;

            let dpi = GetDpiForWindow(window).max(96) as i32;
            let font = CreateFontW(
                -(13 * dpi / 72),
                0,
                0,
                0,
                FW_SEMIBOLD.0 as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                CLEARTYPE_QUALITY,
                0,
                w!("Segoe UI"),
            );
            OVERLAY.with(|cell| {
                if let Some(overlay) = cell.borrow_mut().as_mut() {
                    // Selected into the back buffer for the overlay's life:
                    // the hint and the size label are measured and drawn there.
                    SelectObject(overlay.back.dc, font.into());
                    SetBkMode(overlay.back.dc, TRANSPARENT);
                    SetTextColor(overlay.back.dc, COLORREF(0x00FF_FFFF));
                    overlay.scale = dpi;
                }
            });

            let _ = ShowWindow(window, SW_SHOW);
            let _ = SetForegroundWindow(window);
            let _ = SetFocus(Some(window));
            // Escape is also watched directly: if Windows refused to bring the
            // overlay forward, its key messages go to whatever had focus.
            SetTimer(Some(window), ESC_TIMER, 30, None);

            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            let _ = KillTimer(Some(window), ESC_TIMER);
            let _ = DestroyWindow(window);
            let overlay = OVERLAY.with(|cell| cell.borrow_mut().take());
            let shot = overlay
                .as_ref()
                .and_then(|overlay| overlay.result.map(|rect| crop(overlay, rect)));
            // The back buffer's DC goes first, so the font is no longer
            // selected anywhere when it is deleted.
            drop(overlay);
            let _ = DeleteObject(font.into());
            Ok(shot)
        }
    }

    fn crop(overlay: &Overlay, rect: RECT) -> Shot {
        let source = &overlay.bright;
        let left = rect.left.clamp(0, source.width);
        let top = rect.top.clamp(0, source.height);
        let right = rect.right.clamp(left, source.width);
        let bottom = rect.bottom.clamp(top, source.height);
        let width = (right - left) as usize;
        let height = (bottom - top) as usize;
        let stride = source.width as usize * 4;
        let pixels = source.pixels();
        let mut rgba = Vec::with_capacity(width * height * 4);
        for row in top as usize..bottom as usize {
            let start = row * stride + left as usize * 4;
            for bgra in pixels[start..start + width * 4].chunks_exact(4) {
                rgba.extend_from_slice(&[bgra[2], bgra[1], bgra[0], 255]);
            }
        }
        Shot {
            width: width as u32,
            height: height as u32,
            rgba,
            center: (
                overlay.origin.0 + (left + right) / 2,
                overlay.origin.1 + (top + bottom) / 2,
            ),
        }
    }

    fn finish(window: HWND, overlay: &mut Overlay, result: Option<RECT>) {
        if overlay.finished {
            return;
        }
        overlay.finished = true;
        overlay.result = result;
        unsafe {
            let _ = ReleaseCapture();
            let _ = ShowWindow(window, windows::Win32::UI::WindowsAndMessaging::SW_HIDE);
            PostQuitMessage(0);
        }
    }

    /// The whole monitor under a point, in client coordinates.
    fn monitor_at(overlay: &Overlay, point: (i32, i32)) -> RECT {
        unsafe {
            let monitor = MonitorFromPoint(
                POINT {
                    x: point.0 + overlay.origin.0,
                    y: point.1 + overlay.origin.1,
                },
                MONITOR_DEFAULTTONEAREST,
            );
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            let _ = GetMonitorInfoW(monitor, &mut info);
            let r = info.rcMonitor;
            RECT {
                left: r.left - overlay.origin.0,
                top: r.top - overlay.origin.1,
                right: r.right - overlay.origin.0,
                bottom: r.bottom - overlay.origin.1,
            }
        }
    }

    fn point_of(lparam: LPARAM) -> (i32, i32) {
        let value = lparam.0 as u32;
        ((value & 0xFFFF) as i16 as i32, (value >> 16) as i16 as i32)
    }

    unsafe extern "system" fn wndproc(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let handled = OVERLAY.with(|cell| {
            // Win32 calls made while handling a message - ReleaseCapture,
            // SetCapture, ShowWindow - send messages of their own straight
            // back into this procedure. Those find the overlay already in use
            // and go to the default handler; borrowing again would panic, and
            // a panic cannot unwind out of a window procedure.
            let mut borrow = cell.try_borrow_mut().ok()?;
            let overlay = borrow.as_mut()?;
            match message {
                WM_ERASEBKGND => Some(LRESULT(1)),
                WM_PAINT => {
                    paint(window, overlay);
                    Some(LRESULT(0))
                }
                WM_LBUTTONDOWN => {
                    let point = point_of(lparam);
                    let before = decor(overlay);
                    overlay.anchor = Some(point);
                    overlay.pointer = point;
                    unsafe { SetCapture(window) };
                    invalidate_change(window, overlay, &before, &decor(overlay));
                    Some(LRESULT(0))
                }
                WM_MOUSEMOVE => {
                    let point = point_of(lparam);
                    if point == overlay.pointer {
                        return Some(LRESULT(0));
                    }
                    let before = decor(overlay);
                    overlay.pointer = point;
                    invalidate_change(window, overlay, &before, &decor(overlay));
                    Some(LRESULT(0))
                }
                WM_LBUTTONUP => {
                    let point = point_of(lparam);
                    let Some(anchor) = overlay.anchor else {
                        return Some(LRESULT(0));
                    };
                    // A click without a drag takes the whole monitor under it.
                    let rect = if (point.0 - anchor.0).abs() < 4 && (point.1 - anchor.1).abs() < 4 {
                        monitor_at(overlay, point)
                    } else {
                        normalized(anchor, point)
                    };
                    finish(window, overlay, Some(rect));
                    Some(LRESULT(0))
                }
                WM_RBUTTONUP => {
                    finish(window, overlay, None);
                    Some(LRESULT(0))
                }
                WM_KEYDOWN if wparam.0 == VK_ESCAPE.0 as usize => {
                    finish(window, overlay, None);
                    Some(LRESULT(0))
                }
                WM_TIMER if wparam.0 == ESC_TIMER => {
                    if unsafe { GetAsyncKeyState(VK_ESCAPE.0 as i32) } as u16 & 0x8000 != 0 {
                        finish(window, overlay, None);
                    }
                    Some(LRESULT(0))
                }
                _ => None,
            }
        });
        handled.unwrap_or_else(|| unsafe { DefWindowProcW(window, message, wparam, lparam) })
    }

    /// What is drawn over the dimmed screen right now: the selection with its
    /// size, or the crosshair with the hint. Worked out once and used twice -
    /// to know which pixels a mouse move changes, and to draw them.
    struct Decor {
        selection: Option<RECT>,
        cross: Option<(i32, i32)>,
        pill: RECT,
        text: String,
    }

    fn decor(overlay: &Overlay) -> Decor {
        let scale = overlay.scale;
        let bounds = monitor_at(overlay, overlay.pointer);
        let (selection, cross, text, center_x, top) = match overlay.anchor {
            Some(anchor) => {
                let rect = normalized(anchor, overlay.pointer);
                let text = format!("{} × {}", rect.right - rect.left, rect.bottom - rect.top);
                (
                    Some(rect),
                    None,
                    text,
                    (rect.left + rect.right) / 2,
                    rect.bottom + 8 * scale / 96,
                )
            }
            None => (
                None,
                Some(overlay.pointer),
                "Drag to select  ·  Click for the whole screen  ·  Esc to cancel".to_string(),
                (bounds.left + bounds.right) / 2,
                bounds.top + 24 * scale / 96,
            ),
        };
        // The font is selected into the back buffer for good, so it measures.
        let mut wide: Vec<u16> = text.encode_utf16().collect();
        let mut measure = RECT::default();
        unsafe {
            DrawTextW(
                overlay.back.dc,
                &mut wide,
                &mut measure,
                DT_SINGLELINE | DT_NOPREFIX | DT_CALCRECT,
            )
        };
        let w = measure.right - measure.left + 20 * scale / 96;
        let h = measure.bottom - measure.top + 10 * scale / 96;
        let left =
            (center_x - w / 2).clamp(bounds.left + 4, (bounds.right - w - 4).max(bounds.left + 4));
        let top = top.clamp(bounds.top + 4, (bounds.bottom - h - 4).max(bounds.top + 4));
        Decor {
            selection,
            cross,
            pill: RECT {
                left,
                top,
                right: left + w,
                bottom: top + h,
            },
            text,
        }
    }

    /// The pixels a decor covers that differ from the plain dimmed screen.
    fn decor_region(decor: &Decor, overlay: &Overlay) -> HRGN {
        unsafe {
            let p = decor.pill;
            let region = CreateRectRgn(p.left, p.top, p.right, p.bottom);
            let add = |r: RECT| {
                let part = CreateRectRgn(r.left, r.top, r.right, r.bottom);
                CombineRgn(Some(region), Some(region), Some(part), RGN_OR);
                let _ = DeleteObject(part.into());
            };
            if let Some(s) = decor.selection {
                add(RECT {
                    left: s.left - 1,
                    top: s.top - 1,
                    right: s.right + 1,
                    bottom: s.bottom + 1,
                });
            }
            if let Some((x, y)) = decor.cross {
                add(RECT {
                    left: 0,
                    top: y,
                    right: overlay.back.width,
                    bottom: y + 1,
                });
                add(RECT {
                    left: x,
                    top: 0,
                    right: x + 1,
                    bottom: overlay.back.height,
                });
            }
            region
        }
    }

    /// Repaint only what changed between two decors: old and new together
    /// would mean redrawing the whole selection on every mouse move, which on
    /// three 4K screens is enough to feel.
    fn invalidate_change(window: HWND, overlay: &Overlay, before: &Decor, after: &Decor) {
        unsafe {
            let old = decor_region(before, overlay);
            let new = decor_region(after, overlay);
            let changed = CreateRectRgn(0, 0, 0, 0);
            CombineRgn(Some(changed), Some(old), Some(new), RGN_XOR);
            // The edges and the size label are drawn on top of the selection,
            // so they change even where both regions agree.
            let edges = |decor: &Decor| {
                let p = decor.pill;
                let region = CreateRectRgn(p.left, p.top, p.right, p.bottom);
                if let Some(s) = decor.selection {
                    let outer = CreateRectRgn(s.left - 1, s.top - 1, s.right + 1, s.bottom + 1);
                    let inner = CreateRectRgn(s.left + 1, s.top + 1, s.right - 1, s.bottom - 1);
                    CombineRgn(Some(outer), Some(outer), Some(inner), RGN_DIFF);
                    CombineRgn(Some(region), Some(region), Some(outer), RGN_OR);
                    let _ = DeleteObject(outer.into());
                    let _ = DeleteObject(inner.into());
                }
                CombineRgn(Some(changed), Some(changed), Some(region), RGN_OR);
                let _ = DeleteObject(region.into());
            };
            edges(before);
            edges(after);
            let _ = InvalidateRgn(window, Some(changed), false);
            for region in [old, new, changed] {
                let _ = DeleteObject(region.into());
            }
        }
    }

    fn paint(window: HWND, overlay: &mut Overlay) {
        unsafe {
            // Only the update region is rebuilt in the back buffer; GDI clips
            // the full-size copies below to it.
            let dirty = CreateRectRgn(0, 0, 0, 0);
            GetUpdateRgn(window, dirty, false);
            let mut ps = PAINTSTRUCT::default();
            let target = BeginPaint(window, &mut ps);
            let (w, h) = (overlay.back.width, overlay.back.height);
            let back = overlay.back.dc;
            SelectClipRgn(back, Some(dirty));
            let _ = BitBlt(back, 0, 0, w, h, Some(overlay.dim.dc), 0, 0, SRCCOPY);

            let decor = decor(overlay);
            let brush = CreateSolidBrush(ACCENT);
            if let Some(rect) = decor.selection {
                let _ = BitBlt(
                    back,
                    rect.left,
                    rect.top,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                    Some(overlay.bright.dc),
                    rect.left,
                    rect.top,
                    SRCCOPY,
                );
                let outer = RECT {
                    left: rect.left - 1,
                    top: rect.top - 1,
                    right: rect.right + 1,
                    bottom: rect.bottom + 1,
                };
                FrameRect(back, &outer, brush);
            }
            if let Some((px, py)) = decor.cross {
                FillRect(
                    back,
                    &RECT {
                        left: 0,
                        top: py,
                        right: w,
                        bottom: py + 1,
                    },
                    brush,
                );
                FillRect(
                    back,
                    &RECT {
                        left: px,
                        top: 0,
                        right: px + 1,
                        bottom: h,
                    },
                    brush,
                );
            }
            let _ = DeleteObject(brush.into());
            let pill_brush = CreateSolidBrush(COLORREF(0x0020_1A18));
            FillRect(back, &decor.pill, pill_brush);
            let _ = DeleteObject(pill_brush.into());
            let mut wide: Vec<u16> = decor.text.encode_utf16().collect();
            let mut text_rect = decor.pill;
            DrawTextW(
                back,
                &mut wide,
                &mut text_rect,
                DT_SINGLELINE | DT_NOPREFIX | DT_CENTER | DT_VCENTER,
            );
            SelectClipRgn(back, None);

            let _ = BitBlt(target, 0, 0, w, h, Some(back), 0, 0, SRCCOPY);
            let _ = EndPaint(window, &ps);
            let _ = DeleteObject(dirty.into());
        }
    }

    /// Puts an image on the clipboard twice: as a bitmap, which every program
    /// takes, and as PNG, which browsers and chat apps prefer.
    pub fn set_clipboard_image(
        rgba: &[u8],
        width: u32,
        height: u32,
        png: &[u8],
    ) -> Result<(), String> {
        use windows::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW,
            SetClipboardData,
        };
        use windows::Win32::System::Memory::{
            GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
        };
        const CF_DIB: u32 = 8;

        // A bottom-up 32-bit DIB with every alpha byte opaque.
        let header = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: height as i32,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: width * height * 4,
            ..Default::default()
        };
        let mut dib = Vec::with_capacity(40 + rgba.len());
        dib.extend_from_slice(unsafe {
            std::slice::from_raw_parts(
                (&header as *const BITMAPINFOHEADER).cast::<u8>(),
                std::mem::size_of::<BITMAPINFOHEADER>(),
            )
        });
        let stride = width as usize * 4;
        for row in rgba.chunks_exact(stride).rev() {
            for pixel in row.chunks_exact(4) {
                dib.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
            }
        }

        let global = |bytes: &[u8]| -> Result<HANDLE, String> {
            unsafe {
                let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(|e| e.to_string())?;
                let target = GlobalLock(handle) as *mut u8;
                if target.is_null() {
                    return Err("Windows would not lend memory for the clipboard.".into());
                }
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), target, bytes.len());
                let _ = GlobalUnlock(handle);
                Ok(HANDLE(handle.0))
            }
        };
        let dib = global(&dib)?;
        let png_handle = global(png)?;

        let mut opened = false;
        for attempt in 0..12 {
            if unsafe { OpenClipboard(None) }.is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10 + attempt * 5));
        }
        if !opened {
            return Err("Another program is holding the clipboard.".into());
        }
        let result = unsafe {
            (|| {
                EmptyClipboard().map_err(|e| e.to_string())?;
                SetClipboardData(CF_DIB, Some(dib)).map_err(|e| e.to_string())?;
                let format = RegisterClipboardFormatW(w!("PNG"));
                if format != 0 {
                    let _ = SetClipboardData(format, Some(png_handle));
                }
                Ok(())
            })()
        };
        unsafe {
            let _ = CloseClipboard();
        }
        result
    }

    /// The user's Pictures folder, wherever it has been moved to.
    pub fn pictures_folder() -> Result<std::path::PathBuf, String> {
        use windows::Win32::System::Com::CoTaskMemFree;
        use windows::Win32::UI::Shell::{FOLDERID_Pictures, SHGetKnownFolderPath, KF_FLAG_DEFAULT};
        unsafe {
            let path = SHGetKnownFolderPath(&FOLDERID_Pictures, KF_FLAG_DEFAULT, None)
                .map_err(|e| format!("Windows did not say where Pictures is: {e}"))?;
            let text = path.to_string().map_err(|e| e.to_string());
            CoTaskMemFree(Some(path.0 as *const _));
            Ok(std::path::PathBuf::from(text?))
        }
    }

    /// `2026-10-13 141502`, in local time.
    pub fn local_stamp() -> String {
        let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
        format!(
            "{:04}-{:02}-{:02} {:02}{:02}{:02}",
            t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
        )
    }

    /// Whether Windows' "Use the Print screen key to open screen capture" is
    /// switched on. Only an explicit 1 counts: with the value missing a
    /// registered Print Screen hotkey has been seen to reach WinT, so guessing
    /// "on" there warned about a key that worked.
    pub fn print_screen_opens_snipping() -> bool {
        use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
        let mut value: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let read = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                w!(r"Control Panel\Keyboard"),
                w!("PrintScreenKeyForSnippingEnabled"),
                RRF_RT_REG_DWORD,
                None,
                Some((&mut value as *mut u32).cast()),
                Some(&mut size),
            )
        };
        read.is_ok() && value != 0
    }
}
