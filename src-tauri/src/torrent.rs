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

use std::collections::{HashMap, VecDeque};
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

type Reply = Result<Value, String>;

use serde::Serialize;
use serde_json::{json, Value};
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
/// How long a helper may take to say anything at all before it is treated as
/// dead. Far longer than `HEARTBEAT_DEAD`, because the two measure different
/// things: that one is the gap between beats from an engine already up, this
/// one covers building the session — bootstrapping the DHT, reading the saved
/// torrents and resuming them — which on a large queue is not quick. Holding a
/// starting engine to the running engine's timeout killed it mid-start-up and
/// restarted it into the same wall, forever.
const STARTUP_GRACE: Duration = Duration::from_secs(90);
/// A watchdog pass this much later than the one before it did not measure a
/// quiet engine; it measured time nobody was running. The machine slept, or
/// WinT's own main thread was stuck, and both freeze the helper's beats along
/// with everything else. The clock is re-armed instead of the engine being
/// killed for having been asleep.
const RESUME_GAP: Duration = Duration::from_secs(20);
/// How long a silent engine is given to answer a `ping` before it is declared
/// dead. `ping` is answered without touching the session, so a helper busy
/// hash-checking still replies at once — and an engine that answers is alive
/// whatever its beats are doing.
const PING_TIMEOUT: Duration = Duration::from_millis(1500);
/// A working set past this is treated as a fault rather than a busy engine.
const MEMORY_CEILING_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// More requests outstanding than this means nothing is coming back.
const PENDING_CEILING: usize = 64;
/// Enough recent evidence to diagnose a failure without allowing a noisy
/// dependency to grow the supervisor forever.
const DIAGNOSTIC_LINES: usize = 40;
/// Pipe records are length-bounded before allocation. A corrupt helper must
/// not be able to make WinT allocate an arbitrary amount of memory by writing
/// one line without a newline.
const MAX_PROTOCOL_LINE: usize = 32 * 1024 * 1024;
const MAX_STDERR_LINE: usize = 16 * 1024;
/// Consecutive failures are retried increasingly slowly, so a corrupt session
/// or an unavailable disk cannot turn recovery into a busy crash loop. The
/// last step repeats, so the slowest the supervisor ever retries is once a
/// minute.
const RESTART_BACKOFF_SECS: [u64; 6] = [1, 2, 5, 10, 30, 60];
/// How long to wait for a killed helper to actually exit before starting its
/// replacement. The new one binds the same DHT port, and the old one holds it
/// until the kernel has torn the process down.
const EXIT_GRACE: Duration = Duration::from_millis(1500);
/// A helper that has been answering for this long counts as having worked,
/// and the failure count goes back to zero. It is measured from the moment it
/// reported ready, not from when the process was spawned: a helper that comes
/// up and wedges without ever answering has not succeeded at anything.
///
/// Requiring a sustained run rather than resetting on ready alone is what
/// stops a helper that reaches ready and then dies seconds later from
/// resetting the ladder on every attempt and retrying forever.
const HEALTHY_RUN: Duration = Duration::from_secs(120);
/// After this many consecutive failures the supervisor stops on its own and
/// says so. Backing off alone still retries forever, and a helper that can
/// never start (a missing runtime, a corrupt session) would spawn a process a
/// minute for as long as WinT is open. Recovery is meant to ride out a crash,
/// not to hide a broken install.
const MAX_CONSECUTIVE_FAILURES: u32 = 8;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

static APP: OnceLock<AppHandle> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// Set while `start` is putting a helper up, so the watchdog and a second
/// caller do not both try at once.
static STARTING: AtomicBool = AtomicBool::new(false);
/// Set when a write to the helper fails. Writing happens under the pipe lock,
/// and the engine lock is taken while holding the pipe lock in `start_inner`;
/// taking them the other way round here would be a lock-order inversion and a
/// deadlock. A flag costs no lock, and the watchdog is already the one place
/// that turns a fault into a restart.
static PIPE_BROKEN: AtomicBool = AtomicBool::new(false);

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
    /// What the helper says it is doing: `resuming` while it builds its
    /// session, `live` once there is something to take snapshots of. A
    /// resuming engine sends no snapshots, and the page needs to know that
    /// this is work rather than silence.
    pub phase: Option<String>,
    /// How many saved torrents that resume is working through.
    pub resuming: usize,
    pub memory_bytes: u64,
    pub pending_requests: usize,
    pub restarts: u32,
    /// Milliseconds since this helper process was spawned.
    pub uptime_ms: Option<u64>,
    /// Milliseconds since a torrent snapshot (not merely a heartbeat) arrived.
    pub last_snapshot_ms: Option<u64>,
    /// Recent lifecycle, protocol and stderr lines, oldest first.
    pub diagnostics: Vec<String>,
    /// Why it is not running, when it is not.
    pub message: Option<String>,
}

struct Running {
    child: Child,
    pid: u32,
    engine: Option<String>,
    started: Instant,
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
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    };

    unsafe {
        let job = CreateJobObjectW(None, PCWSTR::null())
            .map_err(|error| format!("Windows could not contain the torrent engine: {error}"))?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        limits.ProcessMemoryLimit = MEMORY_CEILING_BYTES as usize;
        if let Err(error) = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            std::ptr::addr_of!(limits).cast(),
            std::mem::size_of_val(&limits) as u32,
        ) {
            let _ = windows::Win32::Foundation::CloseHandle(job);
            return Err(format!(
                "Windows could not secure the torrent engine: {error}"
            ));
        }
        let process = HANDLE(child.as_raw_handle());
        if let Err(error) = AssignProcessToJobObject(job, process) {
            let _ = windows::Win32::Foundation::CloseHandle(job);
            return Err(format!(
                "Windows could not contain the torrent engine: {error}"
            ));
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
        .map_err(|e| {
            // The reader at the other end is gone. Telling the caller is not
            // enough: without this the engine sits broken until someone
            // presses Restart, because nothing else notices a failed write.
            PIPE_BROKEN.store(true, Ordering::SeqCst);
            format!("The torrent engine stopped listening: {e}")
        })
}

#[derive(Default)]
struct Engine {
    running: Option<Running>,
    state: String,
    message: Option<String>,
    last_beat: Option<Instant>,
    /// The helper's own word for what it is doing. See `EngineStatus::phase`.
    phase: Option<String>,
    resuming: usize,
    last_snapshot: Option<Instant>,
    memory_bytes: u64,
    restarts: u32,
    /// Failures since the last helper that stayed up. This drives the backoff
    /// ladder and the point at which the supervisor gives up; `restarts` is
    /// the lifetime count the UI shows and never paces anything.
    consecutive_failures: u32,
    /// When the current helper first reported ready. The watchdog clears the
    /// failure count once this is `HEALTHY_RUN` old, so a machine left awake
    /// for months never carries an old crash toward the give-up limit.
    healthy_since: Option<Instant>,
    generation: u64,
    /// The newest snapshot, kept rather than queued: the emitter sends this
    /// and nothing older ever goes out.
    latest_snapshot: Option<Value>,
    /// Whether `latest_snapshot` has changed since it was last emitted.
    snapshot_dirty: bool,
    diagnostics: VecDeque<String>,
}

fn diagnose(message: impl Into<String>) {
    let message = message.into();
    if let Ok(mut engine) = engine().lock() {
        if engine.diagnostics.len() == DIAGNOSTIC_LINES {
            engine.diagnostics.pop_front();
        }
        engine.diagnostics.push_back(message.clone());
    }
    // The in-memory tail makes troubleshooting immediate in the torrent UI;
    // the health log survives both the helper and WinT itself going down.
    crate::health::note(format!("torrent   {message}"));
}

/// How long to wait before the nth consecutive retry.
fn restart_delay(failures: u32) -> Duration {
    let step = (failures.saturating_sub(1) as usize).min(RESTART_BACKOFF_SECS.len() - 1);
    Duration::from_secs(RESTART_BACKOFF_SECS[step])
}

/// Record a death and decide what happens next.
///
/// Every path that loses the helper comes through here — the pipe closing, a
/// watchdog fault, a failed write — so the backoff, the give-up point and the
/// message the user reads are defined once rather than three times.
///
/// Returns the delay to restart after, or `None` when the supervisor has
/// given up and the user has to ask. The caller holds the engine lock.
fn note_failure(engine: &mut Engine, fault: &str) -> Option<Duration> {
    engine.healthy_since = None;
    engine.restarts = engine.restarts.saturating_add(1);
    engine.consecutive_failures = engine.consecutive_failures.saturating_add(1);
    if engine.consecutive_failures > MAX_CONSECUTIVE_FAILURES {
        engine.state = "failed".into();
        engine.message = Some(format!(
            "{fault} It has failed {} times in a row, so WinT has stopped restarting it. Use Restart the engine to try again.",
            engine.consecutive_failures
        ));
        return None;
    }

    let delay = restart_delay(engine.consecutive_failures);
    engine.state = "starting".into();
    engine.message = Some(format!(
        "{fault} Retrying in {} seconds (attempt {}).",
        delay.as_secs(),
        engine.consecutive_failures
    ));
    Some(delay)
}

fn restart_later(generation: u64, delay: Duration) {
    std::thread::Builder::new()
        .name("torrent-auto-restart".into())
        .spawn(move || {
            if !delay.is_zero() {
                std::thread::sleep(delay);
            }
            let still_needed = engine()
                .lock()
                .map(|engine| engine.generation == generation && engine.running.is_none())
                .unwrap_or(false);
            if still_needed {
                let restarted = start();
                broadcast(&restarted);
            }
        })
        .ok();
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
        // Any live helper, not only one that has finished starting. Asking
        // for "running" here meant a caller arriving during the start-up
        // window — before the first `ready` — killed the helper that was
        // coming up and spawned another over it. The two then raced for the
        // DHT's UDP port and the second died with "only one usage of each
        // socket address".
        if engine.running.is_some() && engine.state != "failed" {
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

    PIPE_BROKEN.store(false, Ordering::SeqCst);

    // Before binding anything: a helper from a WinT that did not shut down
    // cleanly still owns the DHT port, and the one about to start would fail
    // on it. `stop_inner` above has already taken ours down, so anything
    // still answering to that name is an orphan.
    let strays = kill_stray_helpers(None);
    if strays > 0 {
        diagnose(format!(
            "Killed {strays} torrent engine(s) left over from an earlier session."
        ));
        // Terminate is asynchronous; give the kernel the same moment to
        // release their sockets that a helper we stopped ourselves gets.
        std::thread::sleep(EXIT_GRACE.min(Duration::from_millis(500)));
    }

    let mut command = Command::new(&exe);
    command
        .arg("--state-dir")
        .arg(&dir)
        .arg("--snapshot-ms")
        .arg("300")
        // The engine's own diagnostics, on stderr, drained into the health
        // log. Set in the environment rather than hard-coded in the helper so
        // it can be turned up without a rebuild.
        .env(
            "RUST_LOG",
            std::env::var("WINT_TORRENT_LOG")
                .unwrap_or_else(|_| "warn,wint_torrent_helper=info,librqbit=info".into()),
        )
        // A panic in the engine should name a line, not just say it panicked.
        .env("RUST_BACKTRACE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Drain stderr on its own thread. Besides preventing a full pipe from
        // wedging the helper, these are usually the only useful words left by
        // a panic or a failed tracker/session initialization.
        .stderr(Stdio::piped());
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
    let stderr = child.stderr.take();
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
            started: Instant::now(),
            #[cfg(windows)]
            _kill_job: kill_job,
        });
        engine.state = "starting".into();
        engine.message = None;
        // Not `Some(now)`: it has not spoken yet, and saying it had makes the
        // start-up wait indistinguishable from a live engine going quiet.
        engine.last_beat = None;
        engine.last_snapshot = None;
        // A new helper has not proved anything yet.
        engine.healthy_since = None;
        // It is about to rebuild its session, and says so itself on its first
        // beat. Until then nothing is claimed on its behalf.
        engine.phase = None;
        engine.resuming = 0;
        engine.snapshot_dirty = false;
        engine.latest_snapshot = None;
        generation
    };

    diagnose(format!(
        "Started torrent engine PID {pid} (generation {generation})."
    ));

    if let Some(stderr) = stderr {
        std::thread::Builder::new()
            .name("torrent-stderr".into())
            .spawn(move || {
                let mut reader = BufReader::new(stderr);
                while let Ok(Some((line, truncated))) = bounded_line(&mut reader, MAX_STDERR_LINE) {
                    if engine().lock().map(|e| e.generation).unwrap_or(0) != generation {
                        return;
                    }
                    let line = line.trim();
                    if !line.is_empty() {
                        diagnose(format!(
                            "Engine stderr: {line}{}",
                            if truncated { " [line truncated]" } else { "" }
                        ));
                    }
                }
            })
            .ok();
    }

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
            engine.state = match reason {
                "restarting" => "starting".into(),
                // The supervisor has given up. Saying "starting" here would
                // overwrite that and promise a restart nothing will perform.
                "failed" => "failed".into(),
                _ => "stopped".into(),
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
        // Poll, briefly, for the process to actually be gone. Its UDP sockets
        // belong to the kernel until then, and the replacement binds the same
        // DHT port: spawning over a process that has been asked to die but has
        // not finished is what produces "only one usage of each socket
        // address". Bounded, because a helper that will not die must not hold
        // the rest of the app up — the job object collects it either way.
        let deadline = Instant::now() + EXIT_GRACE;
        while Instant::now() < deadline {
            match running.child.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            }
        }
    }
    // Closing the pipe ourselves fails the shutdown write above. That is this
    // function working, not a fault for the watchdog to act on.
    PIPE_BROKEN.store(false, Ordering::SeqCst);
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

fn bounded_line<R: BufRead>(reader: &mut R, limit: usize) -> io::Result<Option<(String, bool)>> {
    let mut bytes = Vec::with_capacity(limit.min(8192));
    let mut truncated = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Ok(Some((
                    String::from_utf8_lossy(&bytes).into_owned(),
                    truncated,
                )))
            };
        }
        let end = available.iter().position(|byte| *byte == b'\n');
        let consumed = end.map_or(available.len(), |index| index + 1);
        let content = end.map_or(available, |index| &available[..index]);
        let room = limit.saturating_sub(bytes.len());
        bytes.extend_from_slice(&content[..content.len().min(room)]);
        truncated |= content.len() > room;
        reader.consume(consumed);
        if end.is_some() {
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            return Ok(Some((
                String::from_utf8_lossy(&bytes).into_owned(),
                truncated,
            )));
        }
    }
}

fn read_lines(generation: u64, mut reader: BufReader<std::process::ChildStdout>) {
    while let Ok(Some((line, truncated))) = bounded_line(&mut reader, MAX_PROTOCOL_LINE) {
        // A helper that was replaced while this thread was blocked on `lines`
        // must not write over the new one's state.
        if engine().lock().map(|e| e.generation).unwrap_or(0) != generation {
            return;
        }
        if truncated {
            diagnose("The engine sent an oversized protocol message; it was discarded.");
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            diagnose(format!(
                "Invalid engine output: {}",
                line.chars().take(500).collect::<String>()
            ));
            continue;
        };

        if let Some(event) = message.get("event").and_then(Value::as_str) {
            let data = message.get("data").cloned().unwrap_or(Value::Null);
            match event {
                "snapshot" => {
                    if let Ok(mut engine) = engine().lock() {
                        engine.phase = Some("live".into());
                        engine.resuming = 0;
                        engine.latest_snapshot = Some(data);
                        engine.snapshot_dirty = true;
                        engine.last_beat = Some(Instant::now());
                        engine.last_snapshot = Some(Instant::now());
                        if engine.state != "running" {
                            engine.state = "running".into();
                            engine.message = None;
                        }
                        engine.healthy_since.get_or_insert_with(Instant::now);
                    }
                }
                "heartbeat" | "ready" => {
                    // A beat is not news. A change of phase is: it is the only
                    // thing that tells the page a long resume is under way, and
                    // no snapshot will arrive to carry it.
                    let mut phase_changed = false;
                    if let Ok(mut engine) = engine().lock() {
                        engine.last_beat = Some(Instant::now());
                        if let Some(phase) = data.get("phase").and_then(Value::as_str) {
                            phase_changed = engine.phase.as_deref() != Some(phase);
                            engine.phase = Some(phase.to_owned());
                        }
                        engine.resuming = data
                            .get("resuming")
                            .and_then(Value::as_u64)
                            .unwrap_or(0) as usize;
                        if event == "ready" {
                            engine.state = "running".into();
                            engine.message = None;
                            engine.healthy_since.get_or_insert_with(Instant::now);
                            let name = data
                                .get("engine")
                                .and_then(Value::as_str)
                                .map(str::to_owned);
                            if let Some(running) = engine.running.as_mut() {
                                running.engine = name;
                            }
                        }
                    }
                    if event == "ready" || phase_changed {
                        broadcast(&status());
                    }
                }
                _ => {}
            }
            continue;
        }

        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            continue;
        };
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

    // The pipe closed: the helper is gone.
    let mut changed = false;
    let mut retry_after = None;
    if let Ok(mut engine) = engine().lock() {
        if engine.generation == generation {
            let exit = engine
                .running
                .as_mut()
                .and_then(|running| running.child.try_wait().ok().flatten())
                .map(|status| format!(" with exit status {status}"))
                .unwrap_or_else(|| " without an exit status".into());
            engine.running = None;
            // Anything but a deliberate stop is recovered. This used to insist
            // the engine had reached `running` first, which silently gave up on
            // the worst case there is: a helper that dies during start-up, and
            // so never reports ready. The generation check above already tells
            // a real death from a restart we asked for.
            if engine.state != "stopped" {
                retry_after = note_failure(&mut engine, "The torrent engine stopped.");
                changed = true;
            }
            drop(engine);
            diagnose(format!("The engine output pipe closed{exit}."));
        }
    }
    if changed {
        broadcast(&status());
    }
    if let Some(delay) = retry_after {
        restart_later(generation, delay);
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
    let (answering, alive) = engine()
        .lock()
        .map(|e| {
            (
                e.running.is_some() && e.state == "running",
                e.running.is_some(),
            )
        })
        .unwrap_or((false, false));

    if !answering {
        // Only when there is no helper at all. One that exists but has not
        // said `ready` yet is already on its way up, and `start` would
        // replace it mid-flight.
        if !alive {
            let status = start();
            if status.state == "failed" {
                return Err(status
                    .message
                    .unwrap_or_else(|| "The torrent engine is not running.".into()));
            }
        }
        // Give a starting engine a moment to say `ready`, but no more than
        // the request would have waited for anyway.
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            let ready = engine()
                .lock()
                .map(|e| e.state == "running")
                .unwrap_or(false);
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
        phase: engine.phase.clone(),
        resuming: engine.resuming,
        memory_bytes: engine.memory_bytes,
        pending_requests: pending().lock().map(|p| p.len()).unwrap_or(0),
        restarts: engine.restarts,
        uptime_ms: engine
            .running
            .as_ref()
            .map(|running| running.started.elapsed().as_millis().min(u64::MAX as u128) as u64),
        last_snapshot_ms: engine
            .last_snapshot
            .map(|at| at.elapsed().as_millis().min(u64::MAX as u128) as u64),
        diagnostics: engine.diagnostics.iter().cloned().collect(),
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
            let mut last_pass = Instant::now();
            loop {
                std::thread::sleep(Duration::from_secs(2));
                // Before anything is judged: was this pass even on time? A two
                // second sleep that took half an hour means the machine was
                // asleep, and nothing measured across that gap says anything
                // about the engine.
                let slept = last_pass.elapsed() > RESUME_GAP;
                last_pass = Instant::now();
                if slept {
                    if let Ok(mut engine) = engine().lock() {
                        if engine.last_beat.is_some() {
                            engine.last_beat = Some(Instant::now());
                        }
                        if let Some(running) = engine.running.as_mut() {
                            running.started = Instant::now();
                        }
                    }
                    diagnose(
                        "The machine was asleep or WinT was stalled; the torrent engine is given                          time to answer again rather than being treated as unresponsive."
                            .to_string(),
                    );
                    continue;
                }
                let mut fault: Option<String> = None;
                // A fault worth a second opinion before anything is killed.
                let mut verify = false;
                let mut restart_after = None;
                let mut generation = 0;
                let mut gave_up = false;
                let mut recovered = None;

                {
                    let Ok(mut engine) = engine().lock() else {
                        continue;
                    };
                    // A start we asked for is already in flight. Nothing below
                    // is true while the helper is being replaced.
                    if STARTING.load(Ordering::SeqCst) {
                        continue;
                    }
                    let broken = PIPE_BROKEN.swap(false, Ordering::SeqCst);
                    // Copied out so the borrow ends before the engine is
                    // written to below.
                    let running_pid = engine.running.as_ref().map(|running| running.pid);
                    let since_spawn = engine
                        .running
                        .as_ref()
                        .map(|running| running.started.elapsed());

                    match running_pid {
                        // The engine is down. This is the case the supervisor
                        // used to skip: it only ever inspected a live helper,
                        // so an engine that had already died could never be
                        // revived from here. "stopped" is the user's own doing,
                        // "failed" is this having given up, and "starting"
                        // means a restart is already scheduled.
                        None => {
                            if engine.state != "stopped"
                                && engine.state != "failed"
                                && engine.state != "starting"
                            {
                                fault = Some("The torrent engine is not running.".into());
                            }
                        }
                        Some(pid) => {
                            // Measuring the child's memory from out here, rather
                            // than asking it, is deliberate: a wedged process
                            // still has a working set, and would never answer.
                            let memory = memory_of(pid);
                            engine.memory_bytes = memory;

                            let silent = match engine.last_beat {
                                // Answering already: the ordinary gap applies.
                                Some(at) => at.elapsed() > HEARTBEAT_DEAD,
                                // Still coming up and has never spoken.
                                None => since_spawn
                                    .is_some_and(|since| since > STARTUP_GRACE),
                            };
                            let depth = pending().lock().map(|p| p.len()).unwrap_or(0);

                            if broken {
                                fault =
                                    Some("The torrent engine stopped accepting commands.".into());
                            } else if silent {
                                // Beats can go missing for reasons that are not
                                // the engine's fault - WinT stalling long enough
                                // that the helper's bounded queue drops them, for
                                // one. Asking it directly settles it.
                                verify = true;
                                fault = Some(if engine.last_beat.is_some() {
                                    "The torrent engine stopped answering.".into()
                                } else {
                                    format!(
                                        "The torrent engine did not finish starting within {} seconds.",
                                        STARTUP_GRACE.as_secs()
                                    )
                                });
                            } else if memory > MEMORY_CEILING_BYTES {
                                fault = Some(format!(
                                    "The torrent engine was using {} MB and was restarted.",
                                    memory / (1024 * 1024)
                                ));
                            } else if depth >= PENDING_CEILING {
                                fault =
                                    Some("The torrent engine stopped replying to commands.".into());
                            }

                            // Nothing wrong, and it has been answering long
                            // enough to call the last burst over. Without this
                            // the count only ever rose, so a machine left
                            // awake for months would walk into the give-up
                            // limit one ordinary crash at a time.
                            if fault.is_none()
                                && engine.consecutive_failures > 0
                                && engine
                                    .healthy_since
                                    .is_some_and(|since| since.elapsed() >= HEALTHY_RUN)
                            {
                                recovered = Some(engine.consecutive_failures);
                                engine.consecutive_failures = 0;
                            }
                        }
                    }

                    if let Some(text) = fault.as_deref() {
                        if !verify {
                            generation = engine.generation;
                            restart_after = note_failure(&mut engine, text);
                            gave_up = restart_after.is_none();
                        }
                    }
                }

                // Outside the lock, because asking the helper anything means
                // waiting for it, and nothing else may wait on this thread
                // holding the engine.
                if verify && fault.is_some() {
                    if request("ping", json!({}), PING_TIMEOUT).is_ok() {
                        diagnose(
                            "The torrent engine missed its heartbeats but answered when asked                              directly, so it was left alone."
                                .to_string(),
                        );
                        if let Ok(mut engine) = engine().lock() {
                            engine.last_beat = Some(Instant::now());
                        }
                        fault = None;
                    } else if let Ok(mut engine) = engine().lock() {
                        // Still the same helper? A restart may have happened
                        // while the ping was outstanding.
                        if STARTING.load(Ordering::SeqCst) || engine.running.is_none() {
                            fault = None;
                        } else {
                            generation = engine.generation;
                            let text = fault.clone().unwrap_or_default();
                            restart_after = note_failure(&mut engine, &text);
                            gave_up = restart_after.is_none();
                        }
                    } else {
                        fault = None;
                    }
                }

                if let Some(count) = recovered {
                    diagnose(format!(
                        "The torrent engine has been answering for {} seconds;                          the count of {count} recent failure(s) is cleared.",
                        HEALTHY_RUN.as_secs()
                    ));
                }

                if let Some(fault) = fault {
                    diagnose(format!("Watchdog: {fault}"));
                    broadcast(&status());
                    // A give-up has to survive the stop, or the UI would show
                    // "starting" and promise a restart that is not coming.
                    stop_inner(if gave_up { "failed" } else { "restarting" });
                    broadcast(&status());
                    if let Some(delay) = restart_after {
                        restart_later(generation, delay);
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
        if measured {
            counters.WorkingSetSize as u64
        } else {
            0
        }
    }
}

#[cfg(not(windows))]
fn memory_of(_pid: u32) -> u64 {
    0
}

/// Kill any helper this WinT does not own.
///
/// The job object kills our helper when WinT exits normally, but nothing
/// collects one left by a WinT that was killed outright, that crashed, or by
/// the previous run of `npm run dev`. Such an orphan still holds the DHT's
/// UDP port, so the new helper cannot bind it and dies on start-up with
/// "only one usage of each socket address" — a failure that looks like the
/// engine being broken when it is really a ghost of the last session.
///
/// Returns how many were killed, for the log.
#[cfg(windows)]
fn kill_stray_helpers(keep: Option<u32>) -> usize {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    let mut killed = 0usize;
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return 0;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
                let pid = entry.th32ProcessID;
                if name.eq_ignore_ascii_case("wint-torrent-helper.exe") && Some(pid) != keep {
                    if let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                        if TerminateProcess(handle, 1).is_ok() {
                            killed += 1;
                        }
                        let _ = CloseHandle(handle);
                    }
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(HANDLE(snapshot.0));
    }
    killed
}

#[cfg(not(windows))]
fn kill_stray_helpers(_keep: Option<u32>) -> usize {
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
        // merely that a process exists. A helper still building its session
        // answers nothing for as long as that takes — minutes on a long list —
        // and that is not a failure to report: the watchdog is what decides
        // whether a slow start is a dead engine, with the whole startup grace
        // to do it in. Failing here instead told the page the engine would not
        // start, over a helper that was busy coming up and went on to run
        // perfectly well.
        if let Err(error) = request_started("hello", json!({}), REQUEST_TIMEOUT) {
            let status = self::status();
            // Nothing running at all is a real failure; a process that has not
            // finished starting is not.
            if status.pid.is_none() {
                return Err(error);
            }
            diagnose(format!(
                "The torrent engine has not finished starting ({error}); waiting for it."
            ));
            return Ok(status);
        }
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
        if let Ok(mut engine) = engine().lock() {
            engine.restarts = 0;
            // Asking for it by hand clears the give-up, so automatic recovery
            // is armed again from this point.
            engine.consecutive_failures = 0;
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
        std::fs::write(
            dir.join(format!("recheck-{}", info_hash.to_ascii_lowercase())),
            [],
        )
        .map_err(|e| format!("Could not schedule that file check: {e}"))?;
        let status = start();
        if status.state == "failed" {
            return Err(status
                .message
                .unwrap_or_else(|| "The torrent engine would not restart.".into()));
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
            "force_start" => "force_start",
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
    off!(request(
        "file_path",
        json!({ "id": id, "index": index }),
        REQUEST_TIMEOUT
    ))
}

/// The info hashes the user has ticked off in the list. These go through the
/// durable store rather than the webview's `localStorage`, which is flushed to
/// disk whenever WebView2 feels like it: a tick made a moment before the window
/// closed was simply gone. Here it is on disk before the command answers.
const MARKS_KEY: &str = "torrent-marks";

#[tauri::command]
pub async fn torrent_marks(app: AppHandle) -> Result<Vec<String>, String> {
    off!({
        Ok(crate::ui_state::read(&app, MARKS_KEY)
            .and_then(|value| serde_json::from_value::<Vec<String>>(value).ok())
            .unwrap_or_default())
    })
}

/// Replace the ticked-off set.
#[tauri::command]
pub async fn torrent_marks_save(app: AppHandle, hashes: Vec<String>) -> Result<(), String> {
    off!({
        let hashes: Vec<String> = hashes
            .into_iter()
            .filter(|hash| hash.len() == 40 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
            .collect();
        crate::ui_state::write(&app, MARKS_KEY, &json!(hashes))
    })
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
