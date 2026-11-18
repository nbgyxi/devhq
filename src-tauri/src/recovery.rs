//! Getting back up after something went wrong.
//!
//! `health` writes down why the app stopped answering; this puts it back.
//! Each kind of failure is caught at the layer it happens in:
//!
//! - **A panic off the main thread** is survived. Release builds unwind (see
//!   `Cargo.toml`), so the thread that panicked ends, `off_thread` hands its
//!   caller `None`, and the rest of the app carries on.
//! - **A panic on the main thread** cannot be survived: it unwinds out of the
//!   window procedure and takes the process with it. The panic hook starts a
//!   fresh WinT on its way down, which waits for this one to be gone before it
//!   claims the single-instance lock.
//! - **A webview whose renderer died or hung** is reloaded in place. The page
//!   goes white when WebView2 loses its renderer and would stay white for good.
//! - **The WebView2 engine itself going away** leaves every window dead, so
//!   the whole app restarts.
//! - **Anything else that kills the process** (a native crash, a hang Windows
//!   gives up on) is handed to Windows: `RegisterApplicationRestart` asks it to
//!   start WinT again.
//!
//! A WinT that dies again within a minute of coming back is left down: a
//! crash on every start is not one the app can fix, and restarting it forever
//! would hide it.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime};

/// The command line flag a recovered start carries: `--recovered` from
/// Windows, `--recovered=<pid>` from our own panic hook.
pub const FLAG: &str = "--recovered";

/// A recovered start that dies again within this is not restarted again.
const SETTLE: Duration = Duration::from_secs(60);
/// How many times one webview is reloaded inside `RELOAD_WINDOW` before it is
/// left alone: a page that kills its renderer on load would otherwise loop.
const MAX_RELOADS: usize = 3;
const RELOAD_WINDOW: Duration = Duration::from_secs(60);

static MAIN_THREAD: AtomicU32 = AtomicU32::new(0);
static RECOVERED: AtomicBool = AtomicBool::new(false);
static ARMED: AtomicBool = AtomicBool::new(false);
static STARTED: Mutex<Option<Instant>> = Mutex::new(None);

/// Whether this run is the one that came back after a crash.
pub fn recovered() -> bool {
    RECOVERED.load(Ordering::SeqCst)
}

/// Called first thing in `run`, before the single-instance lock is asked for.
/// A recovered start waits for the WinT it replaces to be gone; otherwise that
/// one would still hold the lock, and this one would forward its arguments to
/// a dying process and exit.
pub fn before_start(argv: &[String]) {
    let Some(flag) = argv.iter().find(|arg| arg.starts_with(FLAG)) else {
        return;
    };
    RECOVERED.store(true, Ordering::SeqCst);
    #[cfg(windows)]
    if let Some(pid) = flag
        .strip_prefix(FLAG)
        .and_then(|rest| rest.strip_prefix('='))
        .and_then(|pid| pid.parse::<u32>().ok())
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };
        unsafe {
            if let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
                // Bounded: if the old one somehow lingers, the single-instance
                // lock decides, which at worst means this copy exits.
                WaitForSingleObject(handle, 15_000);
                let _ = CloseHandle(handle);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = flag;
}

/// Arm recovery for a normal WinT (never the one-shot administrator terminal).
/// Runs in `setup`, on the main thread, after `health::start` so its panic
/// hook is the outer one and the log line is written before the relaunch.
pub fn start() {
    #[cfg(windows)]
    unsafe {
        MAIN_THREAD.store(
            windows::Win32::System::Threading::GetCurrentThreadId(),
            Ordering::SeqCst,
        );
    }
    *STARTED.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    ARMED.store(true, Ordering::SeqCst);
    if recovered() {
        crate::health::record("recovered", "started again after a crash");
    }

    #[cfg(windows)]
    unsafe {
        use windows::core::PCWSTR;
        use windows::Win32::System::Recovery::{
            RegisterApplicationRestart, RESTART_NO_PATCH, RESTART_NO_REBOOT,
        };
        // Windows only restarts a process that had been running for a minute,
        // which is the crash-loop guard on that path.
        let flag: Vec<u16> = FLAG.encode_utf16().chain(Some(0)).collect();
        let _ = RegisterApplicationRestart(
            PCWSTR(flag.as_ptr()),
            RESTART_NO_PATCH | RESTART_NO_REBOOT,
        );
    }

    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        previous(info);
        if on_main_thread() {
            relaunch("a panic on the main thread");
        }
    }));
}

fn on_main_thread() -> bool {
    #[cfg(windows)]
    unsafe {
        let main = MAIN_THREAD.load(Ordering::SeqCst);
        main != 0 && windows::Win32::System::Threading::GetCurrentThreadId() == main
    }
    #[cfg(not(windows))]
    false
}

/// Start a new WinT that takes over once this one is gone. Only once per run,
/// and not when this run is itself a recovery that has not stayed up.
fn relaunch(why: &str) {
    if !ARMED.swap(false, Ordering::SeqCst) {
        return;
    }
    let settled = STARTED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .map(|at| at.elapsed() >= SETTLE)
        .unwrap_or(false);
    if recovered() && !settled {
        crate::health::record(
            "recovery",
            format!("{why} again right after recovering — not restarting"),
        );
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    crate::health::record("recovery", format!("{why} — starting WinT again"));
    let mut command = std::process::Command::new(exe);
    command.arg(format!("{FLAG}={}", std::process::id()));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Not a child of the dying process's job or console.
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        command.creation_flags(DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB);
    }
    if command.spawn().is_err() {
        // Not allowed to break away from the job: try again inside it.
        if let Ok(exe) = std::env::current_exe() {
            let _ = std::process::Command::new(exe)
                .arg(format!("{FLAG}={}", std::process::id()))
                .spawn();
        }
    }
}

/// A plugin that watches every webview the app creates for its renderer
/// dying, so no individual window has to remember to.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("wint-recovery")
        .on_webview_ready(|webview| {
            #[cfg(windows)]
            {
                let webview = webview.clone();
                // `with_webview` runs inline when called on the main thread,
                // before this webview is in the runtime's map; from another
                // thread it is queued behind the creation that is under way.
                std::thread::spawn(move || watch(webview));
            }
            #[cfg(not(windows))]
            let _ = webview;
        })
        .build()
}

#[cfg(windows)]
fn watch<R: Runtime>(webview: tauri::Webview<R>) {
    let label = webview.label().to_string();
    let app = webview.app_handle().clone();
    let _ = webview.with_webview(move |platform| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use webview2_com::ProcessFailedEventHandler;
        let Ok(core) = platform.controller().CoreWebView2() else {
            return;
        };
        let reloads: Mutex<Vec<Instant>> = Mutex::new(Vec::new());
        let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            let (Some(sender), Some(args)) = (sender, args) else {
                return Ok(());
            };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            args.ProcessFailedKind(&mut kind)?;
            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                restart_after_engine_loss(&app, &label);
            } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE
            {
                let what = if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                    "its page crashed"
                } else {
                    "its page stopped responding"
                };
                let mut recent = reloads.lock().unwrap_or_else(|e| e.into_inner());
                recent.retain(|at| at.elapsed() < RELOAD_WINDOW);
                if recent.len() >= MAX_RELOADS {
                    crate::health::record(
                        "recovery",
                        format!("{label}: {what} again — left alone after {MAX_RELOADS} reloads"),
                    );
                } else {
                    recent.push(Instant::now());
                    crate::health::record("recovery", format!("{label}: {what} — reloading it"));
                    let _ = sender.Reload();
                }
            } else {
                // GPU, utility and iframe processes: WebView2 brings those back
                // by itself, so they are only worth a line.
                crate::health::record(
                    "recovery",
                    format!("{label}: a WebView2 helper process exited (kind {})", kind.0),
                );
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_ProcessFailed(&handler, &mut token);
    });
}

/// The engine behind every window is gone; only a new process gets a new one.
/// Every webview reports it, so only the first report acts.
#[cfg(windows)]
fn restart_after_engine_loss<R: Runtime>(app: &AppHandle<R>, label: &str) {
    static ONCE: AtomicBool = AtomicBool::new(false);
    if ONCE.swap(true, Ordering::SeqCst) {
        return;
    }
    crate::health::record(
        "recovery",
        format!("{label}: the WebView2 engine exited — restarting WinT"),
    );
    app.request_restart();
}

/// The tray's "Restart WinT": the way back when something looks wrong and
/// nothing has crashed.
pub fn restart<R: Runtime>(app: &AppHandle<R>) {
    crate::health::record("recovery", "restart asked for from the tray");
    app.request_restart();
}
