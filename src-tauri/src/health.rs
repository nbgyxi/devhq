//! Why the window stopped answering.
//!
//! A freeze leaves nothing behind. By the time anyone can describe it the
//! moment is gone, and the next run starts clean — so this records, while the
//! app runs, the few things that turn "it froze" into a cause:
//!
//! - **Every piece of off-thread work**, because all of it goes through one
//!   door (`off_thread`). What is running, since when, and from which line of
//!   which file — no call site has to say so, the caller's location is taken
//!   from the compiler.
//! - **The main thread's pulse.** The watchdog asks the thread that draws the
//!   window to answer, every second. When an answer takes longer than a blink,
//!   the window was not repainting, and that is written down with everything
//!   that was in flight at the time — which is the list the cause is in.
//! - **Panics**, with their location and backtrace. A panic in a command
//!   thread is otherwise silent.
//!
//! It all lands in one file under `%LOCALAPPDATA%\WinT\logs`, kept small
//! enough to read and rotated once so a crash cannot be pushed out of it by
//! whatever the app did next. Nothing here reaches the network, and the log
//! holds paths and command names, never file contents.

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Work in flight, by a number handed out in order.
static IN_FLIGHT: Mutex<Option<HashMap<u64, Job>>> = Mutex::new(None);
static NEXT_JOB: AtomicU64 = AtomicU64::new(1);
static STARTED: Mutex<Option<Instant>> = Mutex::new(None);

/// How long the main thread has to answer before the window counts as stuck.
const STUCK_MS: u64 = 1_500;
/// How long a single piece of off-thread work may take before it is worth a line.
const SLOW_MS: u128 = 2_000;
const MAX_BYTES: u64 = 512 * 1024;

#[derive(Clone)]
struct Job {
    /// `file:line` of whoever asked for the work.
    origin: &'static str,
    at: Instant,
}

fn log_dir() -> Option<std::path::PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(std::path::PathBuf::from(local).join("WinT").join("logs"))
}

pub fn log_path() -> Option<std::path::PathBuf> {
    Some(log_dir()?.join("health.log"))
}

fn stamp() -> String {
    // Local wall-clock time is what a user comparing this against "it froze
    // around three" needs, and the offset is whatever Windows says it is.
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    let (h, m, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    format!("{h:02}:{m:02}:{s:02}.{:03}Z", now.subsec_millis())
}

/// One line in the log. Never fails loudly: a diagnostic that takes the app
/// down with it would be worse than the fault it is recording.
pub fn record(kind: &str, text: impl AsRef<str>) {
    let Some(path) = log_path() else { return };
    let line = format!("{} {:<9} {}\n", stamp(), kind, text.as_ref());
    let _ = (|| -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // One rotation, so the file a crash is in survives the next session.
        if std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) > MAX_BYTES {
            let _ = std::fs::rename(&path, path.with_extension("log.1"));
        }
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
        file.write_all(line.as_bytes())
    })();
}

/// Start recording: a panic hook, and the line that separates this run from
/// whatever the file already held. `version` is the app's own, which lives in
/// `tauri.conf.json` — the crate's version is a different number and would
/// make every line in here disagree with the one in the status bar.
pub fn start(version: &str) {
    *STARTED.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    *IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()) = Some(HashMap::new());
    record(
        "start",
        format!(
            "WinT {version} on {}",
            std::env::var("COMPUTERNAME").unwrap_or_else(|_| "this PC".into())
        ),
    );

    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let where_at = info
            .location()
            .map(|at| format!("{}:{}", at.file(), at.line()))
            .unwrap_or_else(|| "unknown".into());
        let what = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "a panic with no message".into());
        record("PANIC", format!("{what} — at {where_at}"));
        record("PANIC", format!("in flight: {}", in_flight_summary()));
        // The default hook prints and, where it is asked to, captures the
        // backtrace; it runs after this so the log has the cause first.
        previous(info);
    }));
}

/// Note the start of a piece of off-thread work; the returned id ends it.
pub fn job_started(origin: &'static str) -> u64 {
    let id = NEXT_JOB.fetch_add(1, Ordering::Relaxed);
    if let Some(jobs) = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        jobs.insert(id, Job { origin, at: Instant::now() });
    }
    id
}

pub fn job_finished(id: u64) {
    let Some(job) = IN_FLIGHT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
        .and_then(|jobs| jobs.remove(&id))
    else {
        return;
    };
    let took = job.at.elapsed().as_millis();
    if took >= SLOW_MS {
        record("slow", format!("{} took {took} ms", job.origin));
    }
}

/// What is running right now, oldest first — the list a freeze's cause is in.
pub fn in_flight_summary() -> String {
    let guard = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    let Some(jobs) = guard.as_ref() else {
        return "nothing recorded".into();
    };
    if jobs.is_empty() {
        return "nothing".into();
    }
    let mut rows: Vec<(u128, &'static str)> =
        jobs.values().map(|job| (job.at.elapsed().as_millis(), job.origin)).collect();
    rows.sort_by_key(|(ms, _)| std::cmp::Reverse(*ms));
    rows.iter()
        .take(12)
        .map(|(ms, origin)| format!("{origin} ({ms} ms)"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Watch the thread that draws the window, for as long as the app runs.
///
/// The test is the only one that matches what a user means by frozen: ask that
/// thread to run something trivial and see how long it takes to come back. A
/// thread busy in a shell call, a COM call or a wait answers late or not at
/// all, and the delay is the freeze, measured rather than guessed.
pub fn watch(app: tauri::AppHandle) {
    static WATCHING: AtomicBool = AtomicBool::new(false);
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("wint-watchdog".into())
        .spawn(move || {
            // Reported once per episode, not once per second, and again with
            // the total when the window comes back.
            let mut stuck_since: Option<Instant> = None;
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let asked = Instant::now();
                let answered = std::sync::Arc::new(AtomicBool::new(false));
                let flag = answered.clone();
                if app.run_on_main_thread(move || flag.store(true, Ordering::SeqCst)).is_err() {
                    // The event loop is gone: the app is on its way out.
                    return;
                }
                // Wait for the answer, but never longer than one report is worth.
                let deadline = asked + Duration::from_secs(10);
                while !answered.load(Ordering::SeqCst) && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(20));
                }
                let took = asked.elapsed();
                if took >= Duration::from_millis(STUCK_MS) {
                    if stuck_since.is_none() {
                        stuck_since = Some(asked);
                        record(
                            "STUCK",
                            format!(
                                "the window did not repaint for {} ms — in flight: {}",
                                took.as_millis(),
                                in_flight_summary()
                            ),
                        );
                    }
                } else if let Some(since) = stuck_since.take() {
                    record(
                        "recovered",
                        format!("the window answers again after {} ms", since.elapsed().as_millis()),
                    );
                }
            }
        })
        .ok();
}

/// What the App health page shows.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub path: String,
    /// Newest last, as the file holds them.
    pub lines: Vec<String>,
    pub in_flight: String,
    /// Seconds this session has been running.
    pub uptime: u64,
}

/// The log's tail and what is happening right now.
pub fn report(limit: usize) -> Report {
    let path = log_path();
    let text = path
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default();
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    if lines.len() > limit {
        lines.drain(..lines.len() - limit);
    }
    Report {
        path: path.map(|path| path.display().to_string()).unwrap_or_default(),
        lines,
        in_flight: in_flight_summary(),
        uptime: STARTED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .map(|at| at.elapsed().as_secs())
            .unwrap_or(0),
    }
}
