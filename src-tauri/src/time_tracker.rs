//! Active-window time tracking.
//!
//! The tracker belongs to the backend, like Keep Awake and Input Stall Watch:
//! it samples from the moment it is switched on until it is switched off,
//! whether the tool is open, the window is minimised or every window has been
//! popped out, and a tracker left on starts again with WinT.
//!
//! It used to live in the webview - a `setInterval` writing to that webview's
//! IndexedDB. That gave every window its own idea of whether tracking was on
//! and its own copy of the history, and a popped-out tool could not sample at
//! all while still drawing a "Tracking" button. There is one sampler now, one
//! history, and one answer to "is it on", which every window reads.
//!
//! One thread, only while enabled. Each tick reads the foreground window and
//! how long the user has been idle; a tick that lands on the same application
//! and title as the last one extends that session rather than starting a new
//! one, so a morning in one editor is a session, not seven hundred rows.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// How often the foreground window is read.
const SAMPLE_MS: u64 = 5_000;
/// No input for this long and the time stops counting.
const IDLE_MS: u64 = 5 * 60 * 1000;
/// A tick this soon after the last one may extend its session.
const JOIN_MS: u64 = SAMPLE_MS * 5 / 2;
/// Sessions older than this are dropped.
const KEEP_DAYS: u64 = 90;
/// A ceiling for the file, whatever the age cutoff lets through.
const MAX_SESSIONS: usize = 50_000;
/// The history is rewritten at most this often while sampling; a session being
/// extended every five seconds is not worth a disk write every five seconds.
const FLUSH_MS: u64 = 30_000;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: u64,
    /// Unix ms.
    pub start: u64,
    pub end: u64,
    pub title: String,
    pub process: String,
    pub path: String,
    pub pid: u32,
}

/// What every window draws the tracker from.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    /// When sampling last started, Unix ms. Zero while off.
    pub started_at: u64,
    /// Idle time at the last tick; `IDLE_MS` or more means nothing is counting.
    pub idle_ms: u64,
    pub idle_after_ms: u64,
    pub sample_ms: u64,
    pub total: usize,
    /// The session the last tick landed in, if it was counting.
    pub live: Option<Session>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Saved {
    enabled: bool,
    sessions: Vec<Session>,
}

#[derive(Default)]
struct State {
    app: Option<AppHandle>,
    enabled: bool,
    /// Bumped to retire the running sampler; a tick from an older generation
    /// stops instead of recording.
    generation: u64,
    started_at: u64,
    idle_ms: u64,
    /// Newest first, the order the tool draws them in.
    sessions: Vec<Session>,
    dirty: bool,
    last_flush: u64,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| {
        let mut st = State::default();
        if let Some(saved) = read_saved() {
            st.enabled = saved.enabled;
            st.sessions = saved.sessions;
            prune(&mut st.sessions);
            let next = st.sessions.iter().map(|row| row.id).max().unwrap_or(0) + 1;
            NEXT_ID.store(next, Ordering::Relaxed);
        }
        Mutex::new(st)
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn saved_file() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(|root| PathBuf::from(root).join("WinT").join("time-tracker.json"))
}

fn read_saved() -> Option<Saved> {
    serde_json::from_str(&std::fs::read_to_string(saved_file()?).ok()?).ok()
}

/// Drops what is past the age cutoff, then whatever is left over the ceiling.
fn prune(sessions: &mut Vec<Session>) {
    let cutoff = now_ms().saturating_sub(KEEP_DAYS * 86_400_000);
    sessions.retain(|row| row.end >= cutoff);
    sessions.truncate(MAX_SESSIONS);
}

fn save(st: &mut State) {
    st.dirty = false;
    st.last_flush = now_ms();
    let Some(path) = saved_file() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let saved = Saved {
        enabled: st.enabled,
        sessions: st.sessions.clone(),
    };
    if let Ok(text) = serde_json::to_string(&saved) {
        let _ = std::fs::write(path, text);
    }
}

fn status(st: &State) -> Status {
    Status {
        enabled: st.enabled,
        started_at: st.started_at,
        idle_ms: st.idle_ms,
        idle_after_ms: IDLE_MS,
        sample_ms: SAMPLE_MS,
        total: st.sessions.len(),
        live: if st.enabled && st.idle_ms < IDLE_MS {
            st.sessions.first().cloned()
        } else {
            None
        },
    }
}

fn snapshot() -> Status {
    state().lock().map(|st| status(&st)).unwrap_or_default()
}

fn app_handle() -> Option<AppHandle> {
    state().lock().ok().and_then(|st| st.app.clone())
}

fn emit(event: &str, payload: Status) {
    if let Some(app) = app_handle() {
        let _ = app.emit(event, payload);
    }
}

#[cfg(windows)]
fn foreground() -> Result<crate::windows_tools::ActiveWindow, String> {
    crate::windows_tools::active_window()
}

#[cfg(not(windows))]
fn foreground() -> Result<crate::windows_tools::ActiveWindow, String> {
    Err("Active-window tracking needs Windows.".into())
}

/// One tick: read the foreground window, then either extend the newest session
/// or start one. Returns what every window should be told about this tick.
fn tick() -> Option<Status> {
    let shot = foreground().ok()?;
    let now = now_ms();
    let mut st = state().lock().ok()?;
    st.idle_ms = shot.idle_ms;
    // A locked desktop has no title to attribute the time to, and an idle one
    // is time the user was not there for.
    if shot.title.is_empty() || shot.idle_ms >= IDLE_MS {
        return Some(status(&st));
    }
    let active_at = now.saturating_sub(shot.idle_ms);
    let process = if shot.process.is_empty() {
        "Unknown".to_string()
    } else {
        shot.process.clone()
    };
    let joins = st.sessions.first().is_some_and(|last| {
        last.process == process
            && last.title == shot.title
            && active_at.saturating_sub(last.end) < JOIN_MS
    });
    if joins {
        if let Some(last) = st.sessions.first_mut() {
            last.end = last.end.max(active_at);
        }
    } else {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        st.sessions.insert(
            0,
            Session {
                id,
                start: active_at,
                end: active_at + SAMPLE_MS,
                title: shot.title,
                process,
                path: shot.path,
                pid: shot.pid,
            },
        );
        prune(&mut st.sessions);
    }
    st.dirty = true;
    if now.saturating_sub(st.last_flush) >= FLUSH_MS {
        save(&mut st);
    }
    Some(status(&st))
}

fn start() {
    let generation = {
        let Ok(mut st) = state().lock() else { return };
        st.generation += 1;
        st.enabled = true;
        st.started_at = now_ms();
        st.idle_ms = 0;
        st.last_flush = now_ms();
        st.generation
    };
    std::thread::Builder::new()
        .name("time-tracker".into())
        .spawn(move || sampler(generation))
        .ok();
}

fn sampler(generation: u64) {
    loop {
        {
            let Ok(st) = state().lock() else { return };
            if st.generation != generation {
                return;
            }
        }
        if let Some(status) = tick() {
            emit("time-tracker:sample", status);
        }
        std::thread::sleep(Duration::from_millis(SAMPLE_MS));
    }
}

fn stop() {
    let Ok(mut st) = state().lock() else { return };
    st.enabled = false;
    st.generation += 1;
    st.started_at = 0;
    st.idle_ms = 0;
    save(&mut st);
}

/// Called once at startup: remembers the app for events and resumes a tracker
/// that was left on.
pub fn resume(app: AppHandle) {
    let resume = {
        let Ok(mut st) = state().lock() else { return };
        st.app = Some(app);
        st.enabled
    };
    if resume {
        start();
    }
}

/// Anything the last flush did not cover has to be written down before the
/// process goes.
pub fn shutdown() {
    if let Ok(mut st) = state().lock() {
        if st.dirty {
            save(&mut st);
        }
    }
}

#[tauri::command]
pub async fn time_tracker_status() -> Status {
    tauri::async_runtime::spawn_blocking(snapshot)
        .await
        .unwrap_or_default()
}

/// The history, newest first. `since` is a Unix-ms floor on a session's end,
/// so the tool asks only for the range it is drawing.
#[tauri::command]
pub async fn time_tracker_sessions(since: u64) -> Vec<Session> {
    tauri::async_runtime::spawn_blocking(move || {
        state()
            .lock()
            .map(|st| {
                st.sessions
                    .iter()
                    .filter(|row| row.end >= since)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// Switches tracking on or off and tells every window, so a toggle in the tool
/// and the switch on Home can never disagree.
#[tauri::command]
pub async fn time_tracker_set(enabled: bool) -> Status {
    tauri::async_runtime::spawn_blocking(move || {
        let begin = {
            let Ok(st) = state().lock() else {
                return Status::default();
            };
            enabled && !st.enabled
        };
        if begin {
            start();
            if let Ok(mut st) = state().lock() {
                save(&mut st);
            }
        } else if !enabled {
            stop();
        }
        let status = snapshot();
        emit("time-tracker:changed", status.clone());
        status
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn time_tracker_clear() -> Status {
    tauri::async_runtime::spawn_blocking(|| {
        if let Ok(mut st) = state().lock() {
            st.sessions.clear();
            save(&mut st);
        }
        let status = snapshot();
        emit("time-tracker:changed", status.clone());
        status
    })
    .await
    .unwrap_or_default()
}
