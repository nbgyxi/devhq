//! The supervisor for the torrent engine, which runs in a process of its own.
//!
//! WinT does no BitTorrent work. `wint-torrent-helper.exe` does all of it —
//! trackers, peers, bencode from strangers, SHA-1 over whole disks, and the
//! writes — and this module is the only thing that talks to it: one pipe in,
//! one pipe out, JSON one object per line.
//!
//! The arrangement exists so the engine can be *wrong* without the window
//! suffering for it. Everything here is built on that:
//!
//! * **Nothing waits on the main thread.** Every command is `async` and does
//!   its blocking on `spawn_blocking`. The helper is spawned with pipes and no
//!   console, so it has no window, no message queue and nothing WinT's input
//!   queue could ever be attached to.
//! * **Every request has a deadline.** `request` waits on a channel with a
//!   timeout and gives up. A helper that never answers costs one blocking-pool
//!   thread for a few seconds, and nothing else.
//! * **Acceptance is the answer.** Starting, pausing and removing report that
//!   the instruction was delivered, not that it finished. What actually
//!   happened arrives in the next snapshot, like everything else.
//! * **One event stream, on a timer.** The helper sends aggregates ~3×/s; the
//!   emitter here forwards at most `EMIT_EVERY` and only the newest, so a UI
//!   that falls behind is never chased by a backlog.
//! * **The engine is watched.** Heartbeat, working set and the depth of the
//!   pending-request table are sampled every two seconds. Silence past
//!   `HEARTBEAT_DEAD` means the engine is declared not responding; the UI is
//!   told, and it is restarted. Because the torrents are persisted on the
//!   helper's side, a restart loses nothing.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

type Reply = Result<Value, String>;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

/// Most commands are a message to a running engine and come back at once.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// Adding is the slow one: a magnet has to find peers and pull the metadata
/// down before there is anything to answer with.
const ADD_TIMEOUT: Duration = Duration::from_secs(90);
/// How often the newest snapshot is forwarded to the webview. The helper's own
/// interval is a little faster, so this is the rate that actually governs.
const EMIT_EVERY: Duration = Duration::from_millis(300);
/// The helper beats once a second. Four missed in a row is a wedged engine.
const HEARTBEAT_DEAD: Duration = Duration::from_secs(5);
/// A working set past this is treated as a fault rather than a busy engine.
const MEMORY_CEILING_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// More requests outstanding than this means nothing is coming back.
const PENDING_CEILING: usize = 64;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

static APP: OnceLock<AppHandle> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// Set while `start` is putting a helper up, so the watchdog and a second
/// caller do not both try at once.
static STARTING: AtomicBool = AtomicBool::new(false);

fn last_engine_restart() -> &'static Mutex<Option<Instant>> {
    static LAST: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

// ---------------------------------------------------------------------------

/// What the UI is told about the engine itself, as opposed to the torrents.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    /// `stopped`, `starting`, `running`, `not-responding`, or `failed`.
    pub state: String,
    pub pid: Option<u32>,
    pub engine: Option<String>,
    /// Milliseconds since the last heartbeat, when one has ever arrived.
    pub last_beat_ms: Option<u64>,
    pub memory_bytes: u64,
    pub pending_requests: usize,
    pub restarts: u32,
    /// Why it is not running, when it is not.
    pub message: Option<String>,
}

struct Running {
    child: Child,
    pid: u32,
    engine: Option<String>,
    #[cfg(windows)]
    _kill_job: KillJob,
}

/// A Windows job whose last handle belongs to WinT. `KILL_ON_JOB_CLOSE` is
/// enforced by the kernel, so an abnormal WinT exit kills the helper even if
/// neither process gets a chance to run shutdown code.
#[cfg(windows)]
struct KillJob(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for KillJob {}

#[cfg(windows)]
impl Drop for KillJob {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn contain_helper(child: &Child) -> Result<KillJob, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        SetInformationJobObject,
    };
    use windows::core::PCWSTR;

    unsafe {
        let job = CreateJobObjectW(None, PCWSTR::null())
            .map_err(|error| format!("Windows could not contain the torrent engine: {error}"))?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if let Err(error) = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            std::ptr::addr_of!(limits).cast(),
            std::mem::size_of_val(&limits) as u32,
        ) {
            let _ = windows::Win32::Foundation::CloseHandle(job);
            return Err(format!("Windows could not secure the torrent engine: {error}"));
        }
        let process = HANDLE(child.as_raw_handle());
        if let Err(error) = AssignProcessToJobObject(job, process) {
            let _ = windows::Win32::Foundation::CloseHandle(job);
            return Err(format!("Windows could not contain the torrent engine: {error}"));
        }
        Ok(KillJob(job))
    }
}

/// The pipe into the helper, behind a lock of its own rather than inside
/// `Engine`.
///
/// Writing to a pipe can block: if the helper ever stopped reading its stdin,
/// the write would wait for room in the buffer. Were that write done while
/// holding the `Engine` lock, a wedged helper would take the status reads, the
/// snapshot emitter and the watchdog down with it — the very things whose job
/// is to notice and report the wedge. Kept apart, a stuck write delays only
/// the next command, and the watchdog still runs, still says "not responding",
/// and still restarts the helper, which is what frees the write.
fn pipe() -> &'static Mutex<Option<ChildStdin>> {
    static PIPE: OnceLock<Mutex<Option<ChildStdin>>> = OnceLock::new();
    PIPE.get_or_init(|| Mutex::new(None))
}

/// Puts one line into the helper. The lock is only ever held for the length of
/// a write, so commands cannot interleave halfway through a line.
fn send_line(line: &str) -> Result<(), String> {
    let mut pipe = pipe()
        .lock()
        .map_err(|_| "The torrent engine's pipe could not be used.".to_string())?;
    let stdin = pipe
        .as_mut()
        .ok_or_else(|| "The torrent engine is not running.".to_string())?;
    writeln!(stdin, "{line}")
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("The torrent engine stopped listening: {e}"))
}

#[derive(Default)]
struct Engine {
    running: Option<Running>,
    state: String,
    message: Option<String>,
    last_beat: Option<Instant>,
    memory_bytes: u64,
    restarts: u32,
    /// When the restarts in the current window began, so a burst of failures
    /// can be told from one failure a day.
    restart_window_started: Option<Instant>,
    generation: u64,
    /// The newest snapshot, kept rather than queued: the emitter sends this
    /// and nothing older ever goes out.
    latest_snapshot: Option<Value>,
    /// Whether `latest_snapshot` has changed since it was last emitted.
    snapshot_dirty: bool,
}

fn engine() -> &'static Mutex<Engine> {
    static ENGINE: OnceLock<Mutex<Engine>> = OnceLock::new();
    ENGINE.get_or_init(|| {
        Mutex::new(Engine {
            state: "stopped".into(),
            ..Default::default()
        })
    })
}

/// Requests that have been sent and not yet answered. Kept apart from
/// `Engine` so that a reply can be delivered without waiting on that lock,
/// which a slow command may be holding.
fn pending() -> &'static Mutex<HashMap<u64, Sender<Reply>>> {
    static PENDING: OnceLock<Mutex<HashMap<u64, Sender<Reply>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// Finding and starting the helper
// ---------------------------------------------------------------------------

/// Where the helper lives. Next to `wint.exe` in a real install; in the
/// workspace's `target` directory when this is a development build.
fn helper_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let name = if cfg!(windows) {
        "wint-torrent-helper.exe"
    } else {
        "wint-torrent-helper"
    };
    let dir = exe.parent()?;
    // Installed: right next to `wint.exe`, which is where the bundle puts it.
    let beside = dir.join(name);
    if beside.is_file() {
        return Some(beside);
    }
    // Some bundle targets keep resources in a folder of their own.
    let resource = dir.join("resources").join(name);
    if resource.is_file() {
        return Some(resource);
    }
    // Development: `npm run dev` runs `target/debug/wint.exe`, but the helper
    // may have been built into either profile, so both are worth a look.
    if let Some(target) = dir.parent() {
        for profile in ["debug", "release"] {
            let built = target.join(profile).join(name);
            if built.is_file() {
                return Some(built);
            }
        }
    }
    None
}

/// The helper's own folder: its session, its settings, its queue. WinT reads
/// none of it — it belongs to the process that survives WinT restarting.
fn state_dir() -> Option<PathBuf> {
    let dir = APP.get()?.path().app_data_dir().ok()?.join("torrent");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

pub fn init(app: AppHandle) {
    let _ = APP.set(app);
}

/// Put a helper up. Safe to call when one is already running — it returns the
/// current status instead of starting a second.
fn start() -> EngineStatus {
    if STARTING.swap(true, Ordering::SeqCst) {
        return status();
    }
    // From here on every path has to clear STARTING, so the work is wrapped.
    let result = start_inner();
    STARTING.store(false, Ordering::SeqCst);
    result
}

fn start_inner() -> EngineStatus {
    {
        let Ok(engine) = engine().lock() else {
            return EngineStatus {
                state: "failed".into(),
                message: Some("The torrent engine's state could not be read.".into()),
                ..Default::default()
            };
        };
        if engine.running.is_some() && engine.state == "running" {
            drop(engine);
            return status();
        }
    }
    stop_inner("restarting");

    let Some(exe) = helper_path() else {
        return set_failed("The torrent engine is missing from this installation.");
    };
    let Some(dir) = state_dir() else {
        return set_failed("Windows did not provide a folder to keep torrents in.");
    };

    let mut command = Command::new(&exe);
    command
        .arg("--state-dir")
        .arg(&dir)
        .arg("--snapshot-ms")
        .arg("300")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // The helper's own complaints go nowhere. Nothing here reads them, and
        // an unread pipe that fills would block the process that writes it.
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console, and therefore no window and no message queue: there is
        // nothing about this process that WinT's input queue could attach to.
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return set_failed(&format!("The torrent engine would not start: {error}")),
    };
    #[cfg(windows)]
    let kill_job = match contain_helper(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            return set_failed(&error);
        }
    };
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        return set_failed("The torrent engine started without a pipe to talk over.");
    };
    let pid = child.id();

    let generation = {
        let Ok(mut engine) = engine().lock() else {
            let _ = child.kill();
            return set_failed("The torrent engine's state could not be read.");
        };
        engine.generation += 1;
        let generation = engine.generation;
        if let Ok(mut pipe) = pipe().lock() {
            *pipe = Some(stdin);
        }
        engine.running = Some(Running {
            child,
            pid,
            engine: None,
            #[cfg(windows)]
            _kill_job: kill_job,
        });
        engine.state = "starting".into();
        engine.message = None;
        engine.last_beat = Some(Instant::now());
        engine.snapshot_dirty = false;
        engine.latest_snapshot = None;
        generation
    };

    // The reader. One thread, one helper; it ends when the pipe does.
    std::thread::Builder::new()
        .name("torrent-reader".into())
        .spawn(move || read_lines(generation, BufReader::new(stdout)))
        .ok();

    watchdog();
    emitter();
    status()
}

fn set_failed(message: &str) -> EngineStatus {
    if let Ok(mut engine) = engine().lock() {
        engine.state = "failed".into();
        engine.message = Some(message.to_string());
        engine.running = None;
    }
    let status = status();
    broadcast(&status);
    status
}

/// Take the helper down. `shutdown` first so it can write its state out; the
/// handle is killed if it does not go.
fn stop_inner(reason: &str) {
    let mut running = match engine().lock() {
        Ok(mut engine) => {
            engine.state = if reason == "restarting" {
                "starting".into()
            } else {
                "stopped".into()
            };
            engine.running.take()
        }
        Err(_) => None,
    };
    if let Some(running) = running.as_mut() {
        let _ = send_line(&json!({ "id": 0, "op": "shutdown", "arg": {} }).to_string());
        // Dropping the pipe closes the helper's stdin, which is its other cue
        // to go, and releases the handle before the process is killed.
        if let Ok(mut pipe) = pipe().lock() {
            *pipe = None;
        }
        // A moment to let it land, then the handle goes regardless. Waiting on
        // a process that may be mid-hash-check is exactly what this module
        // exists to avoid, so there is no `wait()` here.
        std::thread::sleep(Duration::from_millis(120));
        let _ = running.child.kill();
        let _ = running.child.try_wait();
    }
    // Everything still waiting is never going to be answered now.
    if let Ok(mut pending) = pending().lock() {
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err("The torrent engine was restarted.".into()));
        }
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

fn read_lines(generation: u64, reader: BufReader<std::process::ChildStdout>) {
    for line in reader.lines() {
        let Ok(line) = line else { break };
        // A helper that was replaced while this thread was blocked on `lines`
        // must not write over the new one's state.
        if engine().lock().map(|e| e.generation).unwrap_or(0) != generation {
            return;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };

        if let Some(event) = message.get("event").and_then(Value::as_str) {
            let data = message.get("data").cloned().unwrap_or(Value::Null);
            match event {
                "snapshot" => {
                    if let Ok(mut engine) = engine().lock() {
                        engine.latest_snapshot = Some(data);
                        engine.snapshot_dirty = true;
                        engine.last_beat = Some(Instant::now());
                        if engine.state != "running" {
                            engine.state = "running".into();
                            engine.message = None;
                        }
                    }
                }
                "heartbeat" | "ready" => {
                    if let Ok(mut engine) = engine().lock() {
                        engine.last_beat = Some(Instant::now());
                        if event == "ready" {
                            engine.state = "running".into();
                            engine.message = None;
                            let name = data
                                .get("engine")
                                .and_then(Value::as_str)
                                .map(str::to_owned);
                            if let Some(running) = engine.running.as_mut() {
                                running.engine = name;
                            }
                        }
                    }
                    if event == "ready" {
                        broadcast(&status());
                    }
                }
                _ => {}
            }
            continue;
        }

        let Some(id) = message.get("id").and_then(Value::as_u64) else { continue };
        let reply = if message.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(message.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(message
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("The torrent engine refused that.")
                .to_string())
        };
        let waiting = pending().lock().ok().and_then(|mut p| p.remove(&id));
        if let Some(tx) = waiting {
            let _ = tx.send(reply);
        }
    }

    // The pipe closed: the helper is gone. Say so, and let the watchdog be the
    // one that decides about restarting.
    let mut changed = false;
    let mut auto_restart = false;
    if let Ok(mut engine) = engine().lock() {
        if engine.generation == generation {
            engine.running = None;
            // `starting` is an intentional restart already in progress.
            // Only a helper that vanished while running is self-healed here.
            if engine.state == "running" {
                let repeated = last_engine_restart()
                    .lock()
                    .ok()
                    .and_then(|last| *last)
                    .is_some_and(|last| last.elapsed() < Duration::from_secs(60));
                if repeated {
                    engine.state = "failed".into();
                    engine.message = Some(
                        "The torrent engine stopped again within a minute. Restart it when you are ready."
                            .into(),
                    );
                } else {
                    if let Ok(mut last) = last_engine_restart().lock() {
                        *last = Some(Instant::now());
                    }
                    engine.restarts = engine.restarts.saturating_add(1);
                    engine.state = "starting".into();
                    engine.message = Some("The torrent engine stopped and is restarting.".into());
                    auto_restart = true;
                }
                changed = true;
            }
        }
    }
    if changed {
        broadcast(&status());
    }
    if auto_restart {
        std::thread::Builder::new()
            .name("torrent-auto-restart".into())
            .spawn(|| {
                let restarted = start();
                broadcast(&restarted);
            })
            .ok();
    }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// Send one command and wait for its reply, or for the deadline.
///
/// This blocks the calling thread, which is why every caller reaches it
/// through `spawn_blocking`. It is never called on the thread that draws.
fn request(op: &str, arg: Value, timeout: Duration) -> Result<Value, String> {
    // A pending table this deep means replies have stopped coming back. Refuse
    // rather than add to it and hold another thread for the full timeout.
    let depth = pending().lock().map(|p| p.len()).unwrap_or(0);
    if depth >= PENDING_CEILING {
        return Err("The torrent engine is not keeping up. Restart it to carry on.".into());
    }

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx): (Sender<Reply>, Receiver<Reply>) = channel();
    if let Ok(mut pending) = pending().lock() {
        pending.insert(id, tx);
    }

    // Goes out through the pipe's own lock, never the engine's: see `pipe`.
    let written = send_line(&json!({ "id": id, "op": op, "arg": arg }).to_string());
    if let Err(error) = written {
        if let Ok(mut pending) = pending().lock() {
            pending.remove(&id);
        }
        return Err(error);
    }

    match rx.recv_timeout(timeout) {
        Ok(reply) => reply,
        Err(RecvTimeoutError::Timeout) => {
            if let Ok(mut pending) = pending().lock() {
                pending.remove(&id);
            }
            Err(format!(
                "The torrent engine did not answer within {} seconds.",
                timeout.as_secs()
            ))
        }
        Err(RecvTimeoutError::Disconnected) => {
            if let Ok(mut pending) = pending().lock() {
                pending.remove(&id);
            }
            Err("The torrent engine stopped before answering.".into())
        }
    }
}

/// Send a command, start the engine first if it is not up.
fn request_started(op: &str, arg: Value, timeout: Duration) -> Result<Value, String> {
    let up = engine()
        .lock()
        .map(|e| e.running.is_some() && e.state == "running")
        .unwrap_or(false);
    if !up {
        let status = start();
        if status.state == "failed" {
            return Err(status
                .message
                .unwrap_or_else(|| "The torrent engine is not running.".into()));
        }
        // Give a just-started engine a moment to say `ready`, but no more than
        // the request would have waited for anyway.
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            let ready = engine().lock().map(|e| e.state == "running").unwrap_or(false);
            if ready {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    request(op, arg, timeout)
}

// ---------------------------------------------------------------------------
// Status, emitting, watching
// ---------------------------------------------------------------------------

pub fn status() -> EngineStatus {
    let Ok(engine) = engine().lock() else {
        return EngineStatus {
            state: "failed".into(),
            message: Some("The torrent engine's state could not be read.".into()),
            ..Default::default()
        };
    };
    EngineStatus {
        state: engine.state.clone(),
        pid: engine.running.as_ref().map(|r| r.pid),
        engine: engine.running.as_ref().and_then(|r| r.engine.clone()),
        last_beat_ms: engine
            .last_beat
            .map(|at| at.elapsed().as_millis().min(u64::MAX as u128) as u64),
        memory_bytes: engine.memory_bytes,
        pending_requests: pending().lock().map(|p| p.len()).unwrap_or(0),
        restarts: engine.restarts,
        message: engine.message.clone(),
    }
}

fn broadcast(status: &EngineStatus) {
    if let Some(app) = APP.get() {
        let _ = app.emit("torrent:engine", status.clone());
    }
}

/// Forwards the newest snapshot, and only the newest, on a fixed interval.
/// Started once; it keeps running and simply has nothing to send while the
/// engine is down.
fn emitter() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("torrent-emitter".into())
        .spawn(|| {
            // Slowed down when the snapshot is big. Whatever is sent has to be
            // parsed by the webview on the thread that draws it, so a session
            // with thousands of torrents would spend a slice of every frame on
            // JSON if the rate never changed. Fewer, larger updates keep the
            // page reacting; the numbers are a little less live, which is the
            // right thing to give up.
            let mut every = EMIT_EVERY;
            loop {
                std::thread::sleep(every);
                let snapshot = match engine().lock() {
                    Ok(mut engine) if engine.snapshot_dirty => {
                        engine.snapshot_dirty = false;
                        engine.latest_snapshot.clone()
                    }
                    _ => None,
                };
                let Some(snapshot) = snapshot else { continue };
                let rows = snapshot
                    .get("torrents")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0);
                every = match rows {
                    0..=499 => EMIT_EVERY,
                    500..=1999 => Duration::from_millis(700),
                    _ => Duration::from_millis(1500),
                };
                if let Some(app) = APP.get() {
                    let _ = app.emit("torrent:snapshot", snapshot);
                }
            }
        })
        .ok();
}

/// Heartbeat, working set and pending depth, every two seconds.
fn watchdog() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("torrent-watchdog".into())
        .spawn(|| {
            loop {
                std::thread::sleep(Duration::from_secs(2));
                let mut fault: Option<String> = None;
                let mut allow_restart = false;

                {
                    let Ok(mut engine) = engine().lock() else { continue };
                    let Some(running) = engine.running.as_ref() else { continue };
                    let pid = running.pid;
                    // Measuring the child's memory from out here, rather than
                    // asking it, is deliberate: a wedged process still has a
                    // working set, and would never answer the question.
                    let memory = memory_of(pid);
                    engine.memory_bytes = memory;

                    let silent = engine
                        .last_beat
                        .map(|at| at.elapsed() > HEARTBEAT_DEAD)
                        .unwrap_or(false);
                    let depth = pending().lock().map(|p| p.len()).unwrap_or(0);

                    if silent {
                        fault = Some("The torrent engine stopped answering.".into());
                    } else if memory > MEMORY_CEILING_BYTES {
                        fault = Some(format!(
                            "The torrent engine was using {} MB and was restarted.",
                            memory / (1024 * 1024)
                        ));
                    } else if depth >= PENDING_CEILING {
                        fault = Some("The torrent engine stopped replying to commands.".into());
                    }

                    if fault.is_some() {
                        allow_restart = last_engine_restart()
                            .lock()
                            .ok()
                            .and_then(|last| *last)
                            .map_or(true, |last| last.elapsed() >= Duration::from_secs(60));
                        if allow_restart {
                            if let Ok(mut last) = last_engine_restart().lock() {
                                *last = Some(Instant::now());
                            }
                            engine.restarts = engine.restarts.saturating_add(1);
                        }
                        engine.state = "not-responding".into();
                        engine.message = fault.clone();
                    }
                }

                if let Some(fault) = fault {
                    broadcast(&status());
                    if allow_restart {
                        stop_inner("restarting");
                        start();
                        broadcast(&status());
                    } else {
                        stop_inner("stopped");
                        if let Ok(mut engine) = engine().lock() {
                            engine.state = "failed".into();
                            engine.message = Some(format!(
                                "{fault} It failed again within a minute; restart it when you are ready."
                            ));
                        }
                        broadcast(&status());
                    }
                }
            }
        })
        .ok();
}

#[cfg(windows)]
fn memory_of(pid: u32) -> u64 {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return 0;
        };
        let mut counters = PROCESS_MEMORY_COUNTERS::default();
        let sized = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let measured = GetProcessMemoryInfo(handle, &mut counters, sized).is_ok();
        let _ = CloseHandle(handle);
        if measured { counters.WorkingSetSize as u64 } else { 0 }
    }
}

#[cfg(not(windows))]
fn memory_of(_pid: u32) -> u64 {
    0
}

/// Called when WinT is closing, so the engine writes its state out and goes
/// rather than being orphaned.
pub fn shutdown() {
    stop_inner("stopped");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Every one of these is `async` and does its waiting on the blocking pool,
/// so none of them can hold the thread that draws the window.
macro_rules! off {
    ($body:expr) => {
        tauri::async_runtime::spawn_blocking(move || $body)
            .await
            .map_err(|e| e.to_string())?
    };
}

#[tauri::command]
pub async fn torrent_status() -> EngineStatus {
    tauri::async_runtime::spawn_blocking(status)
        .await
        .unwrap_or_default()
}

/// Bring the engine up and answer with what it says about itself. This is the
/// tool's first call; until it returns, the page shows skeletons.
#[tauri::command]
pub async fn torrent_start() -> Result<EngineStatus, String> {
    off!({
        let status = start();
        if status.state == "failed" {
            return Err(status
                .message
                .unwrap_or_else(|| "The torrent engine would not start.".into()));
        }
        // `hello` doubles as the proof that it is actually answering, not
        // merely that a process exists.
        let _ = request_started("hello", json!({}), REQUEST_TIMEOUT)?;
        Ok(self::status())
    })
}

/// Stop the engine without removing its persisted torrents. Starting it again
/// resumes the same queue.
#[tauri::command]
pub async fn torrent_stop() -> EngineStatus {
    tauri::async_runtime::spawn_blocking(|| {
        stop_inner("stopped");
        let status = self::status();
        broadcast(&status);
        status
    })
    .await
    .unwrap_or_else(|_| self::status())
}

/// Put it down and bring it back. What the "restart the engine?" button calls.
#[tauri::command]
pub async fn torrent_restart() -> Result<EngineStatus, String> {
    off!({
        stop_inner("restarting");
        if let Ok(mut last) = last_engine_restart().lock() {
            *last = Some(Instant::now());
        }
        if let Ok(mut engine) = engine().lock() {
            engine.restarts = 0;
            engine.restart_window_started = None;
        }
        let status = start();
        if status.state == "failed" {
            return Err(status
                .message
                .unwrap_or_else(|| "The torrent engine would not start.".into()));
        }
        Ok(status)
    })
}

/// Forget one torrent's saved piece map and restart the helper. On the next
/// load librqbit verifies that torrent from disk; every other torrent keeps
/// its fast-resume data.
#[tauri::command]
pub async fn torrent_recheck(info_hash: String) -> Result<EngineStatus, String> {
    off!({
        if info_hash.len() != 40 || !info_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("That torrent has an invalid info hash.".into());
        }
        stop_inner("restarting");
        let dir = state_dir().ok_or("The torrent state folder is unavailable.")?;
        let bitfield = dir.join(format!("{}.bitv", info_hash.to_ascii_lowercase()));
        if bitfield.exists() {
            std::fs::remove_file(&bitfield)
                .map_err(|e| format!("Could not reset that torrent's saved check: {e}"))?;
        }
        std::fs::write(dir.join(format!("recheck-{}", info_hash.to_ascii_lowercase())), [])
            .map_err(|e| format!("Could not schedule that file check: {e}"))?;
        let status = start();
        if status.state == "failed" {
            return Err(status.message.unwrap_or_else(|| "The torrent engine would not restart.".into()));
        }
        Ok(status)
    })
}

/// Add a magnet link, a torrent URL, or a local `.torrent` file. The engine
/// reads the file itself — WinT never parses it.
#[tauri::command]
pub async fn torrent_add(
    url: Option<String>,
    path: Option<String>,
    output_folder: Option<String>,
    paused: Option<bool>,
) -> Result<Value, String> {
    off!({
        let mut arg = json!({ "paused": paused.unwrap_or(false) });
        if let Some(url) = url {
            arg["url"] = Value::String(url);
        }
        if let Some(path) = path {
            arg["path"] = Value::String(path);
        }
        if let Some(folder) = output_folder {
            arg["outputFolder"] = Value::String(folder);
        }
        request_started("add", arg, ADD_TIMEOUT)
    })
}

/// Start, pause or remove. These answer as soon as the engine has taken the
/// instruction; the result shows up in the next snapshot.
#[tauri::command]
pub async fn torrent_action(
    id: u64,
    action: String,
    delete_files: Option<bool>,
) -> Result<Value, String> {
    off!({
        let op = match action.as_str() {
            "start" => "start",
            "pause" => "pause",
            "remove" => "remove",
            other => return Err(format!("There is no torrent action called {other}.")),
        };
        request(
            op,
            json!({ "id": id, "deleteFiles": delete_files.unwrap_or(false) }),
            REQUEST_TIMEOUT,
        )
    })
}

/// Which files of a torrent to fetch.
#[tauri::command]
pub async fn torrent_only_files(
    id: u64,
    include: Option<Vec<u64>>,
    exclude: Option<Vec<u64>>,
) -> Result<Value, String> {
    off!(request(
        "only_files",
        json!({
            "id": id,
            "include": include.unwrap_or_default(),
            "exclude": exclude.unwrap_or_default(),
        }),
        REQUEST_TIMEOUT
    ))
}

/// The file list for one torrent, fetched when it is selected and never
/// streamed — it is the part that is long enough to be worth asking for.
#[tauri::command]
pub async fn torrent_details(id: u64) -> Result<Value, String> {
    off!(request("details", json!({ "id": id }), REQUEST_TIMEOUT))
}

/// Where one torrent's files actually are.
///
/// The answer carries `root` — the folder holding this torrent and nothing
/// else — which is what Explorer opens and what a delete acts on. It is absent
/// for a torrent that sits loose in the download folder, because the download
/// folder itself must never be what a "remove this torrent" deletes.
#[tauri::command]
pub async fn torrent_paths(id: u64) -> Result<Value, String> {
    off!(request("paths", json!({ "id": id }), REQUEST_TIMEOUT))
}

/// One file's absolute path, for opening it. Asked for on a double-click.
#[tauri::command]
pub async fn torrent_file_path(id: u64, index: u64) -> Result<Value, String> {
    off!(request("file_path", json!({ "id": id, "index": index }), REQUEST_TIMEOUT))
}

/// Per-peer detail for one torrent, on demand only.
#[tauri::command]
pub async fn torrent_peers(id: u64) -> Result<Value, String> {
    off!(request("peers", json!({ "id": id }), REQUEST_TIMEOUT))
}

/// Change settings. Only the keys given are touched.
#[tauri::command]
pub async fn torrent_settings(patch: Value) -> Result<Value, String> {
    off!(request_started("settings", patch, REQUEST_TIMEOUT))
}
