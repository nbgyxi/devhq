//! Input Stall Watch: notices when the machine or the mouse pointer stops for a
//! moment, and keeps what the machine looked like at that moment.
//!
//! The watch belongs to the backend, like Keep Awake: it runs from the moment
//! it is started until it is stopped, whether the tool is open or not, and a
//! watch left on starts again with WinT.
//!
//! Two threads, both only while watching:
//!
//! - The **probe** runs at time-critical priority and wakes every few
//!   milliseconds. When it wakes far later than it asked to, something above
//!   normal scheduling held the CPU - a driver, firmware, or the kernel - and
//!   the pointer, which is moved at high priority too, stalled with it. It also
//!   reads the cursor, so a pointer that froze mid-movement and then jumped is
//!   caught even while the machine itself kept running.
//! - The **context** sampler takes one cheap snapshot a second - per-core
//!   DPC/interrupt time, busy time, memory load, hard page faults and the
//!   busiest processes - into a rolling window. A stall is finished and
//!   diagnosed once the sample after it has arrived.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const PROBE_MS: u64 = 4;
const WINDOW_SECONDS: usize = 90;
const LATENCY_SECONDS: usize = 60;
const KEEP_STALLS: usize = 150;
/// A wake this late is the machine sleeping or hibernating, not a stall.
const SUSPEND_MS: u64 = 5000;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProcessShare {
    pub name: String,
    pub pid: u32,
    /// Share of all cores, 0-100.
    pub cpu: f32,
    pub hard_faults: u32,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextSample {
    /// End of the second this sample covers, Unix ms.
    pub at: u64,
    pub busy: f32,
    pub dpc: f32,
    pub interrupt: f32,
    pub worst_core: u32,
    /// DPC + interrupt share of the worst core.
    pub worst_core_driver: f32,
    pub worst_core_busy: f32,
    pub memory_load: u32,
    pub hard_faults: u32,
    pub top: Vec<ProcessShare>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stall {
    pub id: u64,
    /// When the stall began, Unix ms.
    pub at: u64,
    pub duration_ms: u32,
    /// `system`, `pointer` or `manual`.
    pub kind: String,
    /// `driver`, `cpu`, `memory`, `input`, `unexplained` or `none`.
    pub cause: String,
    pub verdict: String,
    pub detail: String,
    pub evidence: Vec<String>,
    pub context: Vec<ContextSample>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Saved {
    watching: bool,
    threshold_ms: u32,
    stalls: Vec<Stall>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct StallStatus {
    pub watching: bool,
    pub started_at: u64,
    pub threshold_ms: u32,
    /// Latest lateness per second, oldest first, in ms.
    pub latency: Vec<u32>,
    pub worst_ms: u32,
    pub live: Option<ContextSample>,
    pub stalls: Vec<Stall>,
    pub pending: usize,
}

#[derive(Default)]
struct State {
    app: Option<AppHandle>,
    watching: bool,
    generation: u64,
    started_at: u64,
    threshold_ms: u32,
    latency: VecDeque<u32>,
    worst_ms: u32,
    window: VecDeque<ContextSample>,
    pending: Vec<Stall>,
    stalls: Vec<Stall>,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| {
        let mut st = State {
            threshold_ms: 100,
            ..State::default()
        };
        if let Some(saved) = read_saved() {
            st.threshold_ms = saved.threshold_ms.clamp(30, 2000);
            st.stalls = saved.stalls;
            st.watching = saved.watching;
            let next = st.stalls.iter().map(|s| s.id).max().unwrap_or(0) + 1;
            NEXT_ID.store(next, Ordering::Relaxed);
        }
        Mutex::new(st)
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn saved_file() -> Option<std::path::PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|root| {
        std::path::PathBuf::from(root)
            .join("WinT")
            .join("stall-watch.json")
    })
}

fn read_saved() -> Option<Saved> {
    serde_json::from_str(&std::fs::read_to_string(saved_file()?).ok()?).ok()
}

fn save(st: &State) {
    let Some(path) = saved_file() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let saved = Saved {
        watching: st.watching,
        threshold_ms: st.threshold_ms,
        stalls: st.stalls.clone(),
    };
    if let Ok(text) = serde_json::to_string(&saved) {
        let _ = std::fs::write(path, text);
    }
}

/// Called once at startup: remembers the app for events and resumes a watch
/// that was left on.
pub fn resume(app: AppHandle) {
    let resume = {
        let Ok(mut st) = state().lock() else { return };
        st.app = Some(app);
        st.watching
    };
    if resume {
        start();
    }
}

fn start() {
    let generation = {
        let Ok(mut st) = state().lock() else { return };
        st.generation += 1;
        st.watching = true;
        st.started_at = now_ms();
        st.latency.clear();
        st.window.clear();
        st.worst_ms = 0;
        st.generation
    };
    std::thread::Builder::new()
        .name("stall-probe".into())
        .spawn(move || probe(generation))
        .ok();
    std::thread::Builder::new()
        .name("stall-context".into())
        .spawn(move || context(generation))
        .ok();
}

fn current(generation: u64) -> bool {
    state()
        .lock()
        .map(|st| st.watching && st.generation == generation)
        .unwrap_or(false)
}

/* ------------------------------------------------------------------ probe */

fn queue_stall(kind: &str, at: u64, duration_ms: u32) {
    let Ok(mut st) = state().lock() else { return };
    st.pending.push(Stall {
        id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
        at,
        duration_ms,
        kind: kind.into(),
        ..Stall::default()
    });
}

fn probe(generation: u64) {
    raise_priority();
    let interval = Duration::from_millis(PROBE_MS);
    let mut second = Instant::now();
    let mut second_worst = 0u32;
    let mut cursor = cursor_pos();
    let mut last_move = Instant::now();
    // Moments the pointer moved recently, to tell "moving, then frozen" from
    // a hand that simply stopped.
    let mut moves: VecDeque<Instant> = VecDeque::new();
    let mut last_system_stall = Instant::now() - Duration::from_secs(10);
    let mut checks = 0u32;

    loop {
        let asked = Instant::now();
        std::thread::sleep(interval);
        let woke = Instant::now();
        let late = woke
            .duration_since(asked)
            .saturating_sub(interval)
            .as_millis() as u64;

        checks += 1;
        if checks % 25 == 0 && !current(generation) {
            return;
        }
        let threshold = state().lock().map(|s| s.threshold_ms).unwrap_or(100) as u64;

        if late < SUSPEND_MS {
            second_worst = second_worst.max(late as u32);
            if late >= threshold {
                last_system_stall = woke;
                queue_stall("system", now_ms().saturating_sub(late), late as u32);
            }
        }

        if let Some(pos) = cursor_pos() {
            if Some(pos) != cursor {
                let gap = woke.duration_since(last_move).as_millis() as u64;
                let jump = cursor
                    .map(|(x, y)| {
                        (((pos.0 - x) as f64).powi(2) + ((pos.1 - y) as f64).powi(2)).sqrt()
                    })
                    .unwrap_or(0.0);
                let window_start = last_move.checked_sub(Duration::from_millis(80));
                let was_moving = window_start
                    .map(|from| moves.iter().filter(|t| **t >= from).count() >= 4)
                    .unwrap_or(false);
                if gap >= threshold
                    && gap < 3000
                    && was_moving
                    && jump >= 60.0
                    && late < threshold / 2
                    && last_system_stall < last_move
                {
                    queue_stall("pointer", now_ms().saturating_sub(gap), gap as u32);
                }
                cursor = Some(pos);
                last_move = woke;
                moves.push_back(woke);
                while moves.len() > 64 {
                    moves.pop_front();
                }
            }
        }

        if woke.duration_since(second) >= Duration::from_secs(1) {
            second = woke;
            if let Ok(mut st) = state().lock() {
                if st.generation != generation {
                    return;
                }
                st.latency.push_back(second_worst);
                while st.latency.len() > LATENCY_SECONDS {
                    st.latency.pop_front();
                }
                st.worst_ms = st.worst_ms.max(second_worst);
            }
            second_worst = 0;
        }
    }
}

/* ---------------------------------------------------------------- context */

fn context(generation: u64) {
    let mut sampler = Sampler::default();
    sampler.sample(); // baseline for the deltas
    loop {
        std::thread::sleep(Duration::from_millis(1000));
        if !current(generation) {
            return;
        }
        let Some(sample) = sampler.sample() else {
            continue;
        };
        let finished = {
            let Ok(mut st) = state().lock() else { return };
            st.window.push_back(sample.clone());
            while st.window.len() > WINDOW_SECONDS {
                st.window.pop_front();
            }
            let (ready, waiting): (Vec<Stall>, Vec<Stall>) = std::mem::take(&mut st.pending)
                .into_iter()
                .partition(|s| s.at + s.duration_ms as u64 + 200 <= sample.at);
            st.pending = waiting;
            let window: Vec<ContextSample> = st.window.iter().cloned().collect();
            let mut done = Vec::new();
            for mut stall in merge(ready) {
                diagnose(&mut stall, &window);
                st.stalls.insert(0, stall.clone());
                done.push(stall);
            }
            if !done.is_empty() {
                st.stalls.truncate(KEEP_STALLS);
                save(&st);
            }
            done.into_iter()
                .map(|s| (st.app.clone(), s))
                .collect::<Vec<_>>()
        };
        for (app, stall) in finished {
            if let Some(app) = app {
                let _ = app.emit("stall-watch:stall", &stall);
            }
        }
    }
}

/// A burst of late wakes during one freeze arrives as several stalls; they
/// are one event for whoever reads the list.
fn merge(mut stalls: Vec<Stall>) -> Vec<Stall> {
    stalls.sort_by_key(|s| s.at);
    let mut out: Vec<Stall> = Vec::new();
    for stall in stalls {
        if let Some(last) = out.last_mut() {
            let end = last.at + last.duration_ms as u64;
            if last.kind == stall.kind && stall.at <= end + 500 {
                let new_end = (stall.at + stall.duration_ms as u64).max(end);
                last.duration_ms = (new_end - last.at) as u32;
                continue;
            }
        }
        out.push(stall);
    }
    out
}

fn diagnose(stall: &mut Stall, window: &[ContextSample]) {
    let start = stall.at;
    let end = stall.at + stall.duration_ms as u64;
    let (from, to) = if stall.kind == "manual" {
        (start.saturating_sub(15_000), start)
    } else {
        (start.saturating_sub(1000), end + 1100)
    };
    stall.context = window
        .iter()
        .filter(|s| s.at + 10_000 >= from && s.at <= to + 2000)
        .cloned()
        .collect();
    // Samples whose second overlaps the stall.
    let cover: Vec<&ContextSample> = window
        .iter()
        .filter(|s| s.at >= from && s.at.saturating_sub(1000) <= to)
        .collect();

    let worst_driver = cover
        .iter()
        .max_by(|a, b| a.worst_core_driver.total_cmp(&b.worst_core_driver));
    let total_driver = cover
        .iter()
        .map(|s| s.dpc + s.interrupt)
        .fold(0.0, f32::max);
    let busy = cover.iter().max_by(|a, b| a.busy.total_cmp(&b.busy));
    let faults = cover.iter().max_by_key(|s| s.hard_faults);
    let memory = cover.iter().map(|s| s.memory_load).max().unwrap_or(0);

    let mut evidence = Vec::new();
    if let Some(s) = worst_driver {
        evidence.push(format!(
            "Worst core: CPU {} at {:.0}% DPC/interrupt, {:.0}% busy",
            s.worst_core, s.worst_core_driver, s.worst_core_busy
        ));
    }
    if let Some(s) = busy {
        evidence.push(format!(
            "All cores: {:.0}% busy, {:.1}% DPC, {:.1}% interrupt",
            s.busy, s.dpc, s.interrupt
        ));
        if let Some(p) = s.top.first() {
            evidence.push(format!(
                "Busiest process: {} (PID {}) at {:.0}% of all cores",
                p.name, p.pid, p.cpu
            ));
        }
    }
    if let Some(s) = faults {
        evidence.push(format!(
            "Hard page faults: {}/s · memory in use {}%",
            s.hard_faults, memory
        ));
    }

    let top_faulter = faults
        .and_then(|s| s.top.iter().max_by_key(|p| p.hard_faults))
        .filter(|p| p.hard_faults > 0);

    let (cause, verdict, detail): (&str, String, String) = if cover.is_empty() {
        (
            "none",
            "No samples around it".into(),
            "The context sampler had not yet recorded the seconds around this moment.".into(),
        )
    } else if worst_driver
        .map(|s| s.worst_core_driver >= 20.0)
        .unwrap_or(false)
        || total_driver >= 8.0
    {
        let s = worst_driver.unwrap();
        (
            "driver",
            format!("A driver held CPU {}", s.worst_core),
            format!(
                "CPU {} spent {:.0}% of that second servicing interrupts and deferred procedure calls. That is driver work, and it runs above everything else, including the pointer. The usual suspects are the GPU, network or Wi-Fi, audio, storage and USB drivers. LatencyMon, or a Windows Performance Recorder trace, names the exact driver.",
                s.worst_core, s.worst_core_driver
            ),
        )
    } else if faults.map(|s| s.hard_faults >= 800).unwrap_or(false) || memory >= 92 {
        (
            "memory",
            "Windows was reading memory back from disk".into(),
            format!(
                "Memory was {}% in use with heavy hard page faults, so programs were waiting on the page file.{}",
                memory,
                top_faulter
                    .map(|p| format!(" Most faults came from {} (PID {}).", p.name, p.pid))
                    .unwrap_or_default()
            ),
        )
    } else if busy.map(|s| s.busy >= 90.0).unwrap_or(false) {
        let s = busy.unwrap();
        (
            "cpu",
            "Every core was busy".into(),
            match s.top.first() {
                Some(p) => format!(
                    "All cores were {:.0}% busy. The biggest consumer was {} (PID {}) at {:.0}%.",
                    s.busy, p.name, p.pid, p.cpu
                ),
                None => format!("All cores were {:.0}% busy.", s.busy),
            },
        )
    } else if stall.kind == "pointer" {
        (
            "input",
            "Only the pointer stopped".into(),
            "The PC kept running without a hitch, but the pointer froze mid-movement and then jumped. That points at the path from the mouse to Windows: wireless interference or a weak receiver battery, USB power saving on the port or hub, or a program with a global mouse hook (overlays, macro and gesture tools, remote-control software) that answered slowly.".into(),
        )
    } else if stall.kind == "manual" {
        (
            "none",
            "Nothing visible in the last 15 seconds".into(),
            "Nothing on the machine was busy around the moment you marked. If the pointer stuttered anyway, the cause is most likely outside Windows' view: the mouse, its receiver, or its USB port.".into(),
        )
    } else {
        (
            "unexplained",
            "The whole system paused with nothing busy".into(),
            "Every thread stopped while no core showed load. Short freezes like this usually come from firmware (system management interrupts), a GPU or storage driver blocking at high priority, or a power-state change. A kernel trace is the next step.".into(),
        )
    };
    stall.cause = cause.into();
    stall.verdict = verdict;
    stall.detail = detail;
    stall.evidence = evidence;
}

/* ---------------------------------------------------------------- sampler */

#[derive(Default)]
struct Sampler {
    at: Option<Instant>,
    cores: Vec<[i64; 5]>,
    procs: std::collections::HashMap<(u32, i64), (i64, u32)>,
}

impl Sampler {
    fn sample(&mut self) -> Option<ContextSample> {
        let now = Instant::now();
        let cores = win::cores();
        let procs = win::processes();
        let elapsed = self
            .at
            .map(|t| now.duration_since(t).as_nanos() as f64 / 100.0);
        let prev_cores = std::mem::replace(&mut self.cores, cores.clone());
        let prev_procs = std::mem::take(&mut self.procs);
        for p in &procs {
            self.procs
                .insert((p.pid, p.created), (p.cpu_time, p.hard_faults));
        }
        self.at = Some(now);
        let elapsed = elapsed?;
        if prev_cores.len() != cores.len() || cores.is_empty() {
            return None;
        }

        let mut sample = ContextSample {
            at: now_ms(),
            memory_load: win::memory_load(),
            ..ContextSample::default()
        };
        let (mut total, mut idle, mut dpc, mut int) = (0f64, 0f64, 0f64, 0f64);
        for (i, (c, p)) in cores.iter().zip(prev_cores.iter()).enumerate() {
            // [idle, kernel (includes idle), user, dpc, interrupt]
            let d = |k: usize| (c[k] - p[k]).max(0) as f64;
            let span = (d(1) + d(2)).max(1.0);
            total += span;
            idle += d(0);
            dpc += d(3);
            int += d(4);
            let driver = ((d(3) + d(4)) / span * 100.0) as f32;
            let core_busy = ((1.0 - d(0) / span) * 100.0).max(0.0) as f32;
            if i == 0 || driver > sample.worst_core_driver {
                sample.worst_core = i as u32;
                sample.worst_core_driver = driver;
                sample.worst_core_busy = core_busy;
            }
        }
        let total = total.max(1.0);
        sample.busy = ((1.0 - idle / total) * 100.0).max(0.0) as f32;
        sample.dpc = (dpc / total * 100.0) as f32;
        sample.interrupt = (int / total * 100.0) as f32;

        let capacity = elapsed * cores.len() as f64;
        let mut shares: Vec<ProcessShare> = Vec::new();
        for p in procs {
            let Some((cpu, faults)) = prev_procs.get(&(p.pid, p.created)) else {
                continue;
            };
            let hard = p.hard_faults.saturating_sub(*faults);
            sample.hard_faults += hard;
            if p.pid == 0 {
                continue; // the idle process
            }
            let share = ((p.cpu_time - cpu).max(0) as f64 / capacity * 100.0) as f32;
            if share >= 0.5 || hard > 0 {
                shares.push(ProcessShare {
                    name: p.name,
                    pid: p.pid,
                    cpu: share,
                    hard_faults: hard,
                });
            }
        }
        shares.sort_by(|a, b| b.cpu.total_cmp(&a.cpu));
        let mut top: Vec<ProcessShare> = shares.iter().take(5).cloned().collect();
        if let Some(faulter) = shares
            .iter()
            .filter(|p| p.hard_faults > 0)
            .max_by_key(|p| p.hard_faults)
        {
            if !top.iter().any(|p| p.pid == faulter.pid) {
                top.push(faulter.clone());
            }
        }
        sample.top = top;
        Some(sample)
    }
}

struct Proc {
    pid: u32,
    created: i64,
    name: String,
    cpu_time: i64,
    hard_faults: u32,
}

#[cfg(windows)]
mod win {
    use super::Proc;
    use windows::Wdk::System::SystemInformation::{
        NtQuerySystemInformation, SystemProcessInformation, SystemProcessorPerformanceInformation,
    };

    pub fn cores() -> Vec<[i64; 5]> {
        // SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION with its reserved fields
        // named: Idle, Kernel, User, DpcTime, InterruptTime, InterruptCount.
        const SIZE: usize = 48;
        let mut buf = vec![0u8; SIZE * 256];
        let mut len = 0u32;
        let status = unsafe {
            NtQuerySystemInformation(
                SystemProcessorPerformanceInformation,
                buf.as_mut_ptr().cast(),
                buf.len() as u32,
                &mut len,
            )
        };
        if status.is_err() {
            return Vec::new();
        }
        buf.chunks_exact(SIZE)
            .take(len as usize / SIZE)
            .map(|c| {
                let v = |o: usize| i64::from_le_bytes(c[o..o + 8].try_into().unwrap());
                [v(0), v(8), v(16), v(24), v(32)]
            })
            .collect()
    }

    pub fn processes() -> Vec<Proc> {
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let mut len = 0u32;
            let status = unsafe {
                NtQuerySystemInformation(
                    SystemProcessInformation,
                    buf.as_mut_ptr().cast(),
                    buf.len() as u32,
                    &mut len,
                )
            };
            if status.0 == 0xC000_0004u32 as i32 && buf.len() < (64 << 20) {
                buf = vec![0u8; (len as usize).max(buf.len() * 2) + 65536];
                continue;
            }
            if status.is_err() {
                return Vec::new();
            }
            break;
        }
        let u32_at = |o: usize| u32::from_le_bytes(buf[o..o + 4].try_into().unwrap());
        let i64_at = |o: usize| i64::from_le_bytes(buf[o..o + 8].try_into().unwrap());
        let mut out = Vec::new();
        let mut offset = 0usize;
        loop {
            if offset + 96 > buf.len() {
                break;
            }
            // x64 SYSTEM_PROCESS_INFORMATION offsets.
            let next = u32_at(offset) as usize;
            let hard_faults = u32_at(offset + 16);
            let created = i64_at(offset + 32);
            let user = i64_at(offset + 40);
            let kernel = i64_at(offset + 48);
            let name_len =
                u16::from_le_bytes(buf[offset + 56..offset + 58].try_into().unwrap()) as usize;
            let name_ptr = i64_at(offset + 64) as usize as *const u16;
            let pid = i64_at(offset + 80) as u32;
            let name = if name_ptr.is_null() || name_len == 0 {
                if pid == 0 {
                    "Idle".to_string()
                } else {
                    "System".to_string()
                }
            } else {
                // The name points back into `buf`, which is still alive.
                let slice = unsafe { std::slice::from_raw_parts(name_ptr, name_len / 2) };
                String::from_utf16_lossy(slice)
            };
            out.push(Proc {
                pid,
                created,
                name,
                cpu_time: user + kernel,
                hard_faults,
            });
            if next == 0 {
                break;
            }
            offset += next;
        }
        out
    }

    pub fn memory_load() -> u32 {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut status = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        unsafe { GlobalMemoryStatusEx(&mut status) }
            .map(|_| status.dwMemoryLoad)
            .unwrap_or(0)
    }
}

#[cfg(not(windows))]
mod win {
    use super::Proc;
    pub fn cores() -> Vec<[i64; 5]> {
        Vec::new()
    }
    pub fn processes() -> Vec<Proc> {
        Vec::new()
    }
    pub fn memory_load() -> u32 {
        0
    }
}

#[cfg(windows)]
fn raise_priority() {
    use windows::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL,
    };
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    }
}

#[cfg(not(windows))]
fn raise_priority() {}

#[cfg(windows)]
fn cursor_pos() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point) }
        .ok()
        .map(|_| (point.x, point.y))
}

#[cfg(not(windows))]
fn cursor_pos() -> Option<(i32, i32)> {
    None
}

/* --------------------------------------------------------------- commands */

fn snapshot() -> StallStatus {
    let Ok(st) = state().lock() else {
        return StallStatus::default();
    };
    StallStatus {
        watching: st.watching,
        started_at: st.started_at,
        threshold_ms: st.threshold_ms,
        latency: st.latency.iter().copied().collect(),
        worst_ms: st.worst_ms,
        live: st.window.back().cloned(),
        stalls: st.stalls.clone(),
        pending: st.pending.len(),
    }
}

#[tauri::command]
pub async fn stall_watch_status() -> StallStatus {
    tauri::async_runtime::spawn_blocking(snapshot)
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn stall_watch_set(watching: bool, threshold_ms: u32) -> StallStatus {
    tauri::async_runtime::spawn_blocking(move || {
        let begin = {
            let Ok(mut st) = state().lock() else {
                return StallStatus::default();
            };
            st.threshold_ms = threshold_ms.clamp(30, 2000);
            let begin = watching && !st.watching;
            if !watching && st.watching {
                st.watching = false;
                st.generation += 1;
            }
            save(&st);
            begin
        };
        if begin {
            start();
            if let Ok(st) = state().lock() {
                save(&st);
            }
        }
        snapshot()
    })
    .await
    .unwrap_or_default()
}

/// "It just happened": diagnose the last 15 seconds.
#[tauri::command]
pub async fn stall_watch_mark() -> Result<StallStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        if !state().lock().map(|s| s.watching).unwrap_or(false) {
            return Err(
                "Start watching first - there is nothing recorded to look back at.".to_string(),
            );
        }
        queue_stall("manual", now_ms(), 0);
        Ok(snapshot())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn stall_watch_clear() -> StallStatus {
    tauri::async_runtime::spawn_blocking(|| {
        if let Ok(mut st) = state().lock() {
            st.stalls.clear();
            save(&st);
        }
        snapshot()
    })
    .await
    .unwrap_or_default()
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NearbyEvent {
    pub time: String,
    pub level: String,
    pub provider: String,
    pub id: u32,
    pub message: String,
}

/// Warnings and errors in the System log within two minutes of a stall.
#[tauri::command]
pub async fn stall_watch_events(at: u64) -> Result<Vec<NearbyEvent>, String> {
    tauri::async_runtime::spawn_blocking(move || nearby_events(at))
        .await
        .map_err(|e| e.to_string())?
}

fn nearby_events(at: u64) -> Result<Vec<NearbyEvent>, String> {
    use std::process::Command;
    let script = r#"$ErrorActionPreference='Stop'; $t=[DateTimeOffset]::FromUnixTimeMilliseconds([int64]$env:WINT_AT).LocalDateTime; try { Get-WinEvent -FilterHashtable @{LogName='System'; Level=1,2,3; StartTime=$t.AddMinutes(-2); EndTime=$t.AddMinutes(2)} -MaxEvents 40 | ForEach-Object { [pscustomobject]@{time=$_.TimeCreated.ToString('o');level=$_.LevelDisplayName;provider=$_.ProviderName;id=[uint32]$_.Id;message=[string]$_.Message} } | ConvertTo-Json -Compress } catch [Exception] { if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { '[]' } else { throw } }"#;
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .env("WINT_AT", at.to_string());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let out = command.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let text = text.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    if text.starts_with('[') {
        serde_json::from_str(text).map_err(|e| e.to_string())
    } else {
        serde_json::from_str::<NearbyEvent>(text)
            .map(|e| vec![e])
            .map_err(|e| e.to_string())
    }
}
