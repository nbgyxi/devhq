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
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, AtomicU64, Ordering};
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
/// How often a stuck window is reported again while it stays stuck.
const STILL_STUCK: Duration = Duration::from_secs(5);
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
    unsafe {
        use windows::Win32::Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE};
        use windows::Win32::System::Threading::{
            GetCurrentProcess, GetCurrentThread, GetCurrentThreadId,
        };
        MAIN_THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
        let me = GetCurrentProcess();
        let mut handle = HANDLE::default();
        if DuplicateHandle(me, GetCurrentThread(), me, &mut handle, 0, false, DUPLICATE_SAME_ACCESS)
            .is_ok()
        {
            MAIN_HANDLE.store(handle.0 as isize, Ordering::SeqCst);
        }
    }
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
        record(
            "PANIC",
            format!("blocking calls: {} — in flight: {}", native_summary(), in_flight_summary()),
        );
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

/// The last thing the front end said it was doing. A deadlock leaves nothing
/// in flight — the thread is not doing tracked work, it is stopped — so the
/// step the UI had reached is the only thing left to name it by.
static LAST_NOTE: Mutex<Option<(String, Instant)>> = Mutex::new(None);

pub fn note(text: String) {
    *LAST_NOTE.lock().unwrap_or_else(|e| e.into_inner()) = Some((text.clone(), Instant::now()));
    record("ui", text);
}

fn last_note() -> String {
    match LAST_NOTE.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        Some((text, at)) => format!("{text} ({} ms ago)", at.elapsed().as_millis()),
        None => "nothing yet".into(),
    }
}

/// Blocking calls into another process that are open right now.
///
/// `spawn_blocking` work shows up in `in_flight_summary`, but a call the
/// drawing thread makes straight into the shell does not: it is not a job,
/// it is that thread stopped mid-instruction. Those are the calls a freeze
/// with "nothing in flight" is actually sitting in, so they are tracked by
/// name and by which thread made them.
/// The thread that draws the window, noted at startup.
static MAIN_THREAD: AtomicU32 = AtomicU32::new(0);

/// A live handle to the thread that draws the window, so its stack can be
/// walked while it is stuck. `GetCurrentThread` only ever returns a
/// pseudo-handle meaning "me", so it is duplicated into a real one.
static MAIN_HANDLE: AtomicIsize = AtomicIsize::new(0);
/// One walk per episode. Suspending a thread is not free, and a second walk
/// of the same stall says nothing the first did not.
static WALKED: AtomicBool = AtomicBool::new(false);

/// Where the drawing thread actually is, frame by frame.
///
/// When a freeze has no work in flight and no blocking call open, everything
/// this file records has already been ruled out, and the only thing left that
/// can name the cause is the stack itself. So it is read the way a debugger
/// reads it: suspend the thread, walk it, let it go.
///
/// Symbols for Windows' own libraries are not on this machine, so most frames
/// come back as a library and an offset rather than a function. That is
/// enough — which library the thread is sitting in is the answer to "what is
/// it waiting for".
fn main_thread_stack() -> String {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Diagnostics::Debug::{
        GetThreadContext, StackWalk64, SymFunctionTableAccess64, SymGetModuleBase64,
        SymGetModuleInfoW64, SymInitialize, CONTEXT, CONTEXT_FULL_AMD64, IMAGEHLP_MODULEW64,
        STACKFRAME64,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, ResumeThread, SuspendThread};

    // CONTEXT must be 16-byte aligned on x64 or the read comes back wrong.
    #[repr(align(16))]
    struct Aligned(CONTEXT);

    // `StackWalk64` takes these as raw callbacks, so they are handed over as
    // the shape it asks for rather than the crate's safe wrappers.
    unsafe extern "system" fn table_access(
        process: HANDLE,
        address: u64,
    ) -> *mut std::ffi::c_void {
        SymFunctionTableAccess64(process, address)
    }
    unsafe extern "system" fn module_base(process: HANDLE, address: u64) -> u64 {
        SymGetModuleBase64(process, address)
    }

    const MAX_FRAMES: usize = 24;
    let raw = MAIN_HANDLE.load(Ordering::SeqCst);
    if raw == 0 {
        return "no handle to the drawing thread".into();
    }
    let thread = HANDLE(raw as *mut std::ffi::c_void);
    let process = unsafe { GetCurrentProcess() };

    // dbghelp is set up once, and only ever here: nothing else in the app
    // needs it, and it is not worth its cost until something has gone wrong.
    static READY: AtomicBool = AtomicBool::new(false);
    if !READY.swap(true, Ordering::SeqCst) {
        let _ = unsafe { SymInitialize(process, None, true) };
    }

    let mut frames: Vec<u64> = Vec::new();
    unsafe {
        if SuspendThread(thread) == u32::MAX {
            return "the drawing thread could not be suspended".into();
        }
        let mut context = Aligned(CONTEXT {
            ContextFlags: CONTEXT_FULL_AMD64,
            ..Default::default()
        });
        if GetThreadContext(thread, &mut context.0).is_ok() {
            let mut frame = STACKFRAME64::default();
            frame.AddrPC.Offset = context.0.Rip;
            frame.AddrPC.Mode = windows::Win32::System::Diagnostics::Debug::AddrModeFlat;
            frame.AddrFrame.Offset = context.0.Rbp;
            frame.AddrFrame.Mode = windows::Win32::System::Diagnostics::Debug::AddrModeFlat;
            frame.AddrStack.Offset = context.0.Rsp;
            frame.AddrStack.Mode = windows::Win32::System::Diagnostics::Debug::AddrModeFlat;
            while frames.len() < MAX_FRAMES {
                let walked = StackWalk64(
                    0x8664, // IMAGE_FILE_MACHINE_AMD64
                    process,
                    thread,
                    &mut frame,
                    std::ptr::addr_of_mut!(context.0).cast(),
                    None,
                    Some(table_access),
                    Some(module_base),
                    None,
                );
                if !walked.as_bool() || frame.AddrPC.Offset == 0 {
                    break;
                }
                frames.push(frame.AddrPC.Offset);
            }
        }
        // Back on its feet before anything slow is done with what was read.
        ResumeThread(thread);
    }

    if frames.is_empty() {
        return "the stack could not be walked".into();
    }
    frames
        .iter()
        .map(|&address| unsafe {
            let base = SymGetModuleBase64(process, address);
            let mut info = IMAGEHLP_MODULEW64 {
                SizeOfStruct: std::mem::size_of::<IMAGEHLP_MODULEW64>() as u32,
                ..Default::default()
            };
            if base != 0 && SymGetModuleInfoW64(process, address, &mut info).is_ok() {
                let name = String::from_utf16_lossy(&info.ModuleName);
                let name = name.trim_end_matches('\0');
                format!("{name}+0x{:x}", address - base)
            } else {
                format!("0x{address:x}")
            }
        })
        .collect::<Vec<_>>()
        .join(" < ")
}

/// What Windows itself thinks the drawing thread is doing.
///
/// The watchdog cannot tell a wedged window from a healthy one with a menu
/// open: a menu runs its own message loop, so the event loop is not pumping
/// either way and the watchdog's question goes unanswered for as long as the
/// menu is up. That made every open menu look like a freeze.
///
/// Windows knows the difference. `GetGUIThreadInfo` says whether the thread
/// is in menu mode and which window owns the menu, and `IsHungAppWindow` is
/// the same judgement the shell uses when it decides to paint the grey frame
/// over an app. Between them: menu mode and not hung is a menu someone has
/// open, and anything else is the app in trouble.
fn gui_state() -> String {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetGUIThreadInfo, IsHungAppWindow, GUITHREADINFO, GUI_INMENUMODE, GUI_INMOVESIZE,
        GUI_POPUPMENUMODE, GUI_SYSTEMMENUMODE,
    };
    let thread = MAIN_THREAD.load(Ordering::SeqCst);
    if thread == 0 {
        return "not known yet".into();
    }
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    let mut parts: Vec<String> = Vec::new();
    if unsafe { GetGUIThreadInfo(thread, &mut info) }.is_ok() {
        let flags = info.flags.0;
        for (bit, name) in [
            (GUI_INMENUMODE.0, "in menu mode"),
            (GUI_POPUPMENUMODE.0, "a popup menu is up"),
            (GUI_SYSTEMMENUMODE.0, "the system menu is up"),
            (GUI_INMOVESIZE.0, "moving or sizing a window"),
        ] {
            if flags & bit != 0 {
                parts.push(name.into());
            }
        }
        if parts.is_empty() {
            parts.push("no menu, not moving".into());
        }
        if !info.hwndMenuOwner.0.is_null() {
            parts.push(format!("menu owner {:?}", info.hwndMenuOwner.0));
        }
        if !info.hwndCapture.0.is_null() {
            parts.push(format!("mouse captured by {:?}", info.hwndCapture.0));
        }
    } else {
        parts.push("Windows would not say".into());
    }
    let docked = crate::appbar::docked_handle();
    if docked != 0 {
        // Printed alongside the menu owner: whether the menu belongs to the
        // rail itself or to the webview inside it is the difference between
        // two quite different bugs.
        parts.push(format!("the rail is {:#x}", docked));
        let hwnd = HWND(docked as *mut std::ffi::c_void);
        parts.push(if unsafe { IsHungAppWindow(hwnd) }.as_bool() {
            "WINDOWS CALLS THE RAIL HUNG".into()
        } else {
            "the rail is not hung".into()
        });
    }
    parts.join(", ")
}

/// What the call was, whether the drawing thread made it, and when it began.
type NativeCall = (&'static str, bool, Instant);
static NATIVE: Mutex<Option<HashMap<u64, NativeCall>>> = Mutex::new(None);
static NEXT_NATIVE: AtomicU64 = AtomicU64::new(1);

/// Note that a blocking call into another process has begun. `on_main` says
/// whether the thread that draws the window is the one waiting — the case
/// that freezes the app rather than merely costing time.
pub fn native_started(what: &'static str, on_main: bool) -> u64 {
    let id = NEXT_NATIVE.fetch_add(1, Ordering::Relaxed);
    NATIVE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(HashMap::new)
        .insert(id, (what, on_main, Instant::now()));
    id
}

pub fn native_finished(id: u64) {
    if let Some(open) = NATIVE.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        open.remove(&id);
    }
}

fn native_summary() -> String {
    let guard = NATIVE.lock().unwrap_or_else(|e| e.into_inner());
    let Some(open) = guard.as_ref().filter(|open| !open.is_empty()) else {
        return "none".into();
    };
    let mut rows: Vec<(u128, &'static str, bool)> = open
        .values()
        .map(|(what, on_main, at)| (at.elapsed().as_millis(), *what, *on_main))
        .collect();
    rows.sort_by_key(|(ms, _, _)| std::cmp::Reverse(*ms));
    rows.iter()
        .take(8)
        .map(|(ms, what, on_main)| {
            let thread = if *on_main { "ON THE DRAWING THREAD" } else { "off-thread" };
            format!("{what} ({ms} ms, {thread})")
        })
        .collect::<Vec<_>>()
        .join(", ")
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
            // Reported when it starts and when it ends, and then every
            // STILL_STUCK_SECS while it lasts. An episode the window never
            // comes back from is the one worth reading, and it used to leave
            // a single line: with nothing after it, there was no telling a
            // four-second stall from a deadlock the user had to kill.
            let mut stuck_since: Option<Instant> = None;
            let mut last_report: Option<Instant> = None;
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let asked = Instant::now();
                let answered = std::sync::Arc::new(AtomicBool::new(false));
                let flag = answered.clone();
                if app.run_on_main_thread(move || flag.store(true, Ordering::SeqCst)).is_err() {
                    // The event loop is gone: the app is on its way out.
                    return;
                }
                // Report from inside the wait, not after it. A freeze the
                // user kills straight away used to end the process before the
                // wait was over, and left no line at all — the one kind of
                // freeze most worth having a line for.
                let deadline = asked + Duration::from_secs(10);
                loop {
                    if answered.load(Ordering::SeqCst) || Instant::now() >= deadline {
                        break;
                    }
                    if asked.elapsed() >= Duration::from_millis(STUCK_MS) {
                        let first = stuck_since.is_none();
                        let since = *stuck_since.get_or_insert(asked);
                        if first || last_report.map_or(true, |at: Instant| at.elapsed() >= STILL_STUCK) {
                            last_report = Some(Instant::now());
                            record(
                                if first { "STUCK" } else { "still stuck" },
                                format!(
                                    "the window has not repainted for {} ms — Windows says: {} — last thing the UI said: {} — blocking calls: {} — in flight: {}",
                                    since.elapsed().as_millis(),
                                    gui_state(),
                                    last_note(),
                                    native_summary(),
                                    in_flight_summary()
                                ),
                            );
                            // A stall of a second or two is ordinary and the
                            // stack of one says nothing. Past STILL_STUCK it
                            // is a window that is not coming back, and then
                            // the stack is the whole answer.
                            if !first && !WALKED.swap(true, Ordering::SeqCst) {
                                record("stack", main_thread_stack());
                            }
                        }
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                let took = asked.elapsed();
                if took < Duration::from_millis(STUCK_MS) {
                    if let Some(since) = stuck_since.take() {
                        last_report = None;
                        WALKED.store(false, Ordering::SeqCst);
                        record(
                            "recovered",
                            format!("the window answers again after {} ms", since.elapsed().as_millis()),
                        );
                    }
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
