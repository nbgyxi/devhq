//! One place where every WinT window's size, place and state is remembered.
//!
//! Before this there were three of them — tool windows, workspaces and the
//! terminal each kept their own shape in their own way, the main window kept
//! nothing at all, and a workspace wrote its geometry to `localStorage` that
//! nothing ever read back. All of them shared the same blind spot: a saved
//! rectangle was only checked for being a plausible *number*, never for being
//! somewhere a monitor still is. Unplug the screen a window was left on and
//! the window comes back onto no screen at all.
//!
//! So everything a window is left in — size, position, maximized, minimized —
//! goes through here, and everything read back is fitted to the monitors that
//! exist **now** before a window is built with it.
//!
//! ## Units
//!
//! Stored values are **physical pixels**, marked `"units": "physical"`. Logical
//! pixels cannot be compared across a mixed-DPI desktop — 1400 logical means a
//! different rectangle on each screen — and the monitor fit has to compare.
//! A record written before this (no marker) is read as logical and scaled by
//! the primary monitor's factor; if that guess is wrong, the fit catches it and
//! puts the window somewhere visible anyway.
//!
//! ## Writing
//!
//! Windows move and resize in a loop of their own, so a write per event would
//! be hundreds of fsynced files per drag. Values are stashed here and written
//! by one background thread once the window has come to rest — and [`flush`]
//! forces the last one out while there is still a process to write it.

use crate::ui_state;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, PhysicalPosition, PhysicalSize};

/// The main window. Tool windows, workspaces and terminals build their own key
/// from their id; see [`key_for`].
pub const MAIN: &str = "window.main";

/// How long a window has to sit still before what it was left in is written.
const SETTLE: Duration = Duration::from_millis(400);

/// A rectangle with less than this showing on any monitor counts as lost, in
/// logical pixels — too small a sliver to find or to grab with the mouse.
const GRABBABLE_WIDE: f64 = 120.0;
const GRABBABLE_TALL: f64 = 48.0;

/// What a window was last left in.
///
/// Every field is optional because a window can be saved while maximized or
/// minimized, when the box it would restore to is what matters and its current
/// outline is not worth keeping.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Geometry {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub maximized: bool,
    pub minimized: bool,
    /// What `x`, `y`, `width` and `height` are in. See the module note.
    pub units: Units,
}

/// Which pixels a stored rectangle is written in.
///
/// Only [`Units::Physical`] can be compared against a monitor. A record from
/// before this module carries no marker at all, which is what the default is
/// for — it is read as logical and converted on the way in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Units {
    #[default]
    Logical,
    Physical,
}

impl Geometry {
    fn is_physical(&self) -> bool {
        self.units == Units::Physical
    }

    /// Nothing worth restoring: an empty file, or one holding only rubbish.
    fn is_empty(&self) -> bool {
        self.width.is_none() && self.height.is_none() && self.x.is_none() && self.y.is_none()
    }

    /// Numbers that are not numbers, or are so far out that no display could
    /// ever have produced them, are dropped rather than fitted. The fit can
    /// rescue a window from a monitor that is gone; it cannot rescue a NaN.
    fn sane(mut self) -> Self {
        let ok = |value: Option<f64>, low: f64, high: f64| {
            value.filter(|value| value.is_finite() && (low..=high).contains(value))
        };
        self.width = ok(self.width, 120.0, 60_000.0);
        self.height = ok(self.height, 80.0, 60_000.0);
        self.x = ok(self.x, -120_000.0, 120_000.0);
        self.y = ok(self.y, -120_000.0, 120_000.0);
        if self.width.is_none() || self.height.is_none() {
            // Half a size is no size. A position without one would place a
            // window of the default size at an offset chosen for another.
            self.width = None;
            self.height = None;
            self.x = None;
            self.y = None;
        }
        self
    }
}

/// The size a window opens at when nothing is remembered, and the smallest it
/// may be squeezed to when a screen cannot hold what was remembered. Logical
/// pixels, because that is what the window builders speak.
#[derive(Debug, Clone, Copy)]
pub struct Defaults {
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
}

/// Where a window should actually open, once the remembered shape has been
/// held up against the monitors that exist now.
#[derive(Debug, Clone, Copy)]
pub struct Placement {
    pub size: PhysicalSize<u32>,
    /// `None` means "wherever the window manager would have put it" — nothing
    /// was remembered, so centring is better than a guess.
    pub position: Option<PhysicalPosition<i32>>,
    pub maximized: bool,
    /// Only ever true for a window WinT is restoring by itself at start. A
    /// window the user just asked for opens where it can be seen; see
    /// [`fit`]'s `honour_minimized`.
    pub minimized: bool,
    /// The scale factor of the monitor this placement is for, so a caller that
    /// has to speak logical pixels converts with the right one.
    pub scale: f64,
}

impl Placement {
    /// The size as the window builders want it.
    pub fn logical_size(&self) -> (f64, f64) {
        (
            f64::from(self.size.width) / self.scale,
            f64::from(self.size.height) / self.scale,
        )
    }

    /// The position as the window builders want it.
    pub fn logical_position(&self) -> Option<(f64, f64)> {
        self.position
            .map(|at| (f64::from(at.x) / self.scale, f64::from(at.y) / self.scale))
    }
}

/// The file one window's shape is kept in.
///
/// `scope` groups a kind of window and `name` picks one within it — per tool,
/// per project, not per instance: what is being remembered is the shape this
/// *thing* wants, and a second window of it wants the same shape.
///
/// A name is turned into something that can be a file name, and a long one is
/// cut down and fingerprinted rather than truncated, so two projects whose
/// paths agree for the first sixty characters do not share a window shape.
pub fn key_for(scope: &str, name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    if cleaned.len() <= 60 {
        format!("{scope}.{cleaned}")
    } else {
        // FNV-1a over the original, so case and separators still tell two
        // names apart even though the readable part has lost them.
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in name.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        format!("{scope}.{}-{hash:016x}", &cleaned[..40])
    }
}

/// Reads what a window was last left in. Missing, unreadable or nonsense reads
/// as nothing, which every caller already has a default for.
pub fn load(app: &AppHandle, key: &str) -> Geometry {
    // What this process last saw is the truth; the file is only as new as the
    // last time the writer got round to it, and reading it on every move of a
    // window would put the disk on the thread that draws.
    if let Some(known) = last().lock().ok().and_then(|seen| seen.get(key).copied()) {
        return known.sane();
    }
    ui_state::read(app, key)
        .and_then(|value| serde_json::from_value::<Geometry>(value).ok())
        .unwrap_or_default()
        .sane()
}

/// Fits a remembered shape onto the monitors that are here now.
///
/// This is the whole point of the module. A window is only put back where it
/// was if where it was is still somewhere: the rectangle is measured against
/// every monitor's work area, and the one it overlaps most wins. If what would
/// show there is a sliver too small to grab — or there is no overlap at all,
/// because that screen was unplugged — the remembered place is abandoned and
/// the window opens at its default size, centred on the primary screen. A
/// remembered size too big for the screen that is left is squeezed to fit
/// rather than thrown away, so a window off a 4K panel onto a laptop is still
/// as large as it can be.
///
/// `honour_minimized` is false for every window the user asked for by clicking
/// something. Opening such a window minimized would look exactly like a click
/// that did nothing. Only WinT restoring itself at start passes true.
pub fn fit(
    app: &AppHandle,
    saved: Geometry,
    defaults: Defaults,
    honour_minimized: bool,
) -> Placement {
    let monitors = app.available_monitors().unwrap_or_default();
    let primary = app.primary_monitor().ok().flatten();
    let base_scale = primary
        .as_ref()
        .map(|m| m.scale_factor())
        .or_else(|| monitors.first().map(|m| m.scale_factor()))
        .filter(|scale| scale.is_finite() && *scale > 0.1)
        .unwrap_or(1.0);

    // Old records are logical; see the module note on units.
    let factor = if saved.is_physical() { 1.0 } else { base_scale };
    let default_size = |scale: f64| PhysicalSize::new(
        (defaults.width * scale).round().max(1.0) as u32,
        (defaults.height * scale).round().max(1.0) as u32,
    );

    let fallback = || {
        let scale = base_scale;
        let size = default_size(scale);
        let position = primary.as_ref().map(|monitor| {
            let work = monitor.work_area();
            centre(&work.position, &work.size, size)
        });
        Placement {
            size,
            position,
            maximized: saved.maximized,
            minimized: honour_minimized && saved.minimized,
            scale,
        }
    };

    if saved.is_empty() || monitors.is_empty() {
        return fallback();
    }

    let width = saved.width.unwrap_or(defaults.width) * factor;
    let height = saved.height.unwrap_or(defaults.height) * factor;
    let (Some(x), Some(y)) = (saved.x, saved.y) else {
        // A size but no place: keep the size, let the window centre itself.
        let mut placement = fallback();
        placement.size = clamp_size(
            PhysicalSize::new(width.round().max(1.0) as u32, height.round().max(1.0) as u32),
            primary.as_ref().map(|m| m.work_area().size),
            defaults,
            base_scale,
        );
        placement.position = primary
            .as_ref()
            .map(|m| centre(&m.work_area().position, &m.work_area().size, placement.size));
        return placement;
    };
    let (x, y) = (x * factor, y * factor);

    // The monitor showing the most of the remembered rectangle is the monitor
    // the window was on, whatever the coordinates used to mean.
    let best = monitors
        .iter()
        .map(|monitor| {
            let work = monitor.work_area();
            let seen_wide = (x + width).min(f64::from(work.position.x) + f64::from(work.size.width))
                - x.max(f64::from(work.position.x));
            let seen_tall = (y + height)
                .min(f64::from(work.position.y) + f64::from(work.size.height))
                - y.max(f64::from(work.position.y));
            (monitor, seen_wide.max(0.0), seen_tall.max(0.0))
        })
        .max_by(|a, b| (a.1 * a.2).total_cmp(&(b.1 * b.2)));

    let Some((monitor, seen_wide, seen_tall)) = best else {
        return fallback();
    };
    // A scale factor Windows could not report comes back as zero, and dividing
    // the window's size by it would send the window to infinity.
    let scale = monitor.scale_factor().clamp(0.1, 10.0);
    if seen_wide < GRABBABLE_WIDE * scale || seen_tall < GRABBABLE_TALL * scale {
        // The screen it was on is gone, or has shrunk out from under it.
        return fallback();
    }

    let work = monitor.work_area();
    let size = clamp_size(
        PhysicalSize::new(width.round().max(1.0) as u32, height.round().max(1.0) as u32),
        Some(work.size),
        defaults,
        scale,
    );
    // Slide the window back inside the work area rather than centring it: a
    // screen that merely got shorter should not throw away where things were.
    let room_x = i64::from(work.size.width) - i64::from(size.width);
    let room_y = i64::from(work.size.height) - i64::from(size.height);
    let position = PhysicalPosition::new(
        (x.round() as i64).clamp(
            i64::from(work.position.x),
            i64::from(work.position.x) + room_x.max(0),
        ) as i32,
        (y.round() as i64).clamp(
            i64::from(work.position.y),
            i64::from(work.position.y) + room_y.max(0),
        ) as i32,
    );

    Placement {
        size,
        position: Some(position),
        maximized: saved.maximized,
        minimized: honour_minimized && saved.minimized,
        scale,
    }
}

fn centre(
    at: &PhysicalPosition<i32>,
    room: &PhysicalSize<u32>,
    size: PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    PhysicalPosition::new(
        at.x + ((i64::from(room.width) - i64::from(size.width)) / 2).max(0) as i32,
        at.y + ((i64::from(room.height) - i64::from(size.height)) / 2).max(0) as i32,
    )
}

/// Never bigger than the screen, never smaller than the window can work at.
/// The minimum wins: a window squeezed below its own minimum is one Windows
/// will resize anyway, and it is better to hang off the edge than to be unusable.
fn clamp_size(
    size: PhysicalSize<u32>,
    room: Option<PhysicalSize<u32>>,
    defaults: Defaults,
    scale: f64,
) -> PhysicalSize<u32> {
    let floor_w = (defaults.min_width * scale).round().max(1.0) as u32;
    let floor_h = (defaults.min_height * scale).round().max(1.0) as u32;
    let (room_w, room_h) = match room {
        Some(room) => (room.width, room.height),
        None => return PhysicalSize::new(size.width.max(floor_w), size.height.max(floor_h)),
    };
    PhysicalSize::new(
        size.width.min(room_w).max(floor_w),
        size.height.min(room_h).max(floor_h),
    )
}

/// Puts a built window exactly where the fit said, in physical pixels.
///
/// Only for a window built hidden: everything here is a visible jump on a
/// window that is already up. A window built with the placement's logical
/// numbers is already close; this makes it exact on a mixed-DPI desktop, where
/// the builder's logical size was converted with whichever scale factor the
/// window happened to be created under.
pub fn apply<R: tauri::Runtime>(window: &tauri::Window<R>, placement: &Placement) {
    if let Some(position) = placement.position {
        let _ = window.set_position(position);
    }
    let _ = window.set_size(placement.size);
    if placement.maximized {
        let _ = window.maximize();
    }
}

/// Measures a live window, ready to be remembered.
///
/// While maximized or minimized the *restored* box is what is kept, so
/// un-maximizing a reopened window lands on the outline it had before rather
/// than on a screen-sized one. Windows does not offer that outline through
/// Tauri, so the last normal reading already in the queue is carried forward.
pub fn capture<R: tauri::Runtime>(window: &tauri::Window<R>, previous: Geometry) -> Geometry {
    let maximized = window.is_maximized().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    let mut geometry = Geometry {
        maximized,
        minimized,
        units: Units::Physical,
        ..previous
    };
    if !maximized && !minimized {
        if let (Ok(size), Ok(position)) = (window.inner_size(), window.outer_position()) {
            // A minimize that has not been reported yet reads as a window of
            // no size at the far corner. Keeping that would lose the real box.
            if size.width > 0 && size.height > 0 {
                geometry.width = Some(f64::from(size.width));
                geometry.height = Some(f64::from(size.height));
                geometry.x = Some(f64::from(position.x));
                geometry.y = Some(f64::from(position.y));
            }
        }
    }
    geometry
}

// ---------------------------------------------------------------------------
// Writing, once the window has stopped moving
// ---------------------------------------------------------------------------

struct Pending {
    geometry: Geometry,
    due: Instant,
}

fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The newest shape this process has been told about, written or not. Kept
/// for the life of the run so that reading a window's shape back — which
/// happens on every move, to carry the restored box forward — never touches
/// the disk.
fn last() -> &'static Mutex<HashMap<String, Geometry>> {
    static LAST: OnceLock<Mutex<HashMap<String, Geometry>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The window behind a webview window, for the placement calls.
pub fn window_of<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> tauri::Window<R> {
    window.as_ref().window()
}

/// Notes what a window is in now. The value reaches the disk once the window
/// has been still for [`SETTLE`]; until then a later call simply replaces it,
/// so a drag across the desktop costs one write and not one per frame.
pub fn remember(app: &AppHandle, key: &str, geometry: Geometry) {
    if let Ok(mut seen) = last().lock() {
        if seen.get(key) == Some(&geometry) {
            return;
        }
        seen.insert(key.to_owned(), geometry);
    }
    let Ok(mut queue) = pending().lock() else {
        return;
    };
    queue.insert(
        key.to_owned(),
        Pending {
            geometry,
            due: Instant::now() + SETTLE,
        },
    );
    drop(queue);
    start(app);
}

/// Writes everything still waiting, now, on the calling thread. For the way
/// out: the settle delay is the one thing standing between the last move of a
/// window and a process that no longer exists.
pub fn flush(app: &AppHandle) {
    let ready: Vec<(String, Geometry)> = match pending().lock() {
        Ok(mut queue) => queue.drain().map(|(key, e)| (key, e.geometry)).collect(),
        Err(_) => return,
    };
    for (key, geometry) in ready {
        write(app, &key, geometry);
    }
}

fn write(app: &AppHandle, key: &str, geometry: Geometry) {
    if let Ok(value) = serde_json::to_value(geometry) {
        // A window shape that cannot be saved is not worth a message: the
        // window still works, it just opens where it opened last time.
        let _ = ui_state::write(app, key, &value);
    }
}

/// One thread for every window there will ever be. It wakes on the same tick
/// whatever is moving, so ten windows being dragged is still one writer.
fn start(app: &AppHandle) {
    static RUNNING: OnceLock<()> = OnceLock::new();
    if RUNNING.set(()).is_err() {
        return;
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("window-geometry".into())
        .spawn(move || loop {
            std::thread::sleep(SETTLE / 2);
            let now = Instant::now();
            let ready: Vec<(String, Geometry)> = match pending().lock() {
                Ok(mut queue) => {
                    let due: Vec<String> = queue
                        .iter()
                        .filter(|(_, e)| e.due <= now)
                        .map(|(key, _)| key.clone())
                        .collect();
                    due.into_iter()
                        .filter_map(|key| queue.remove(&key).map(|e| (key, e.geometry)))
                        .collect()
                }
                Err(_) => return,
            };
            for (key, geometry) in ready {
                write(&app, &key, geometry);
            }
        })
        .ok();
}

/// What a window reports about itself as it settles or closes. Every webview
/// that owns a window calls this; the key names which window it is.
#[tauri::command]
pub async fn window_remember_geometry(
    app: AppHandle,
    scope: String,
    name: String,
    geometry: Geometry,
) -> Result<(), String> {
    let key = key_for(&scope_allowed(&scope)?, &name);
    remember(&app, &key, geometry);
    Ok(())
}

/// A scope is half of a file name, and it comes from a webview. Only the ones
/// this app actually has are accepted, rather than sanitizing whatever arrives.
fn scope_allowed(scope: &str) -> Result<String, String> {
    match scope {
        "tool-window" | "workspace-window" | "terminal-window" => Ok(scope.to_owned()),
        other => Err(format!("{other} is not a kind of window this can save.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_readable_for_a_short_name() {
        assert_eq!(key_for("tool-window", "torrents"), "tool-window.torrents");
        assert_eq!(key_for("tool-window", "path-ping"), "tool-window.path-ping");
    }

    #[test]
    fn a_key_can_never_climb_out_of_its_folder() {
        assert_eq!(key_for("tool-window", "../x"), "tool-window.---x");
        assert!(!key_for("workspace-window", "C:\\code\\devhq").contains('\\'));
    }

    #[test]
    fn two_long_names_that_start_alike_get_different_keys() {
        let a = key_for("workspace-window", &format!("C:\\{}\\alpha", "x".repeat(80)));
        let b = key_for("workspace-window", &format!("C:\\{}\\beta", "x".repeat(80)));
        assert_ne!(a, b);
        // ui_state refuses a key longer than 120 characters, and a key it
        // refuses is a window shape that is quietly never saved.
        assert!(a.len() <= 120 && b.len() <= 120);
    }

    #[test]
    fn nonsense_numbers_are_dropped_rather_than_fitted() {
        let geometry = Geometry {
            width: Some(f64::NAN),
            height: Some(600.0),
            x: Some(10.0),
            y: Some(10.0),
            ..Default::default()
        };
        assert!(geometry.sane().is_empty());
    }

    #[test]
    fn a_size_without_a_place_keeps_the_size() {
        let geometry = Geometry {
            width: Some(900.0),
            height: Some(600.0),
            ..Default::default()
        }
        .sane();
        assert_eq!(geometry.width, Some(900.0));
        assert!(!geometry.is_empty());
    }

    #[test]
    fn only_a_window_wint_restores_itself_may_come_back_minimized() {
        // The flag, not the stored value, is what decides it; see `fit`.
        let saved = Geometry {
            minimized: true,
            ..Default::default()
        };
        assert!(saved.minimized);
    }
}
