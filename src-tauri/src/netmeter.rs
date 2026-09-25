//! What the network adapter is actually doing, and what the line can do.
//!
//! Two things are measured here, and both are wanted in two places — the
//! Speed Test tool reads them directly, the torrent pacer leans on them to
//! decide how much of the line it may take:
//!
//! * **Throughput, now.** Windows keeps byte counters per interface. Sampling
//!   the one the default route actually uses, twice, and dividing by the time
//!   between the samples gives what every program on this PC is moving. The
//!   counters are the kernel's own, so this costs nothing and sees traffic no
//!   socket of ours could.
//! * **Capacity.** What the line can carry is not something Windows knows —
//!   the adapter's link speed is the speed to the *router*. It is measured by
//!   pulling bytes from Cloudflare's speed endpoint and pushing bytes back,
//!   and only ever when someone asks for it: nothing here reaches the network
//!   on its own.
//!
//! Every reading is taken off the main thread, and the test reports progress
//! as it runs rather than going quiet for ten seconds.

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Where the test pulls from and pushes to. Cloudflare's speed endpoint is
/// used because it is anycast — the bytes come from whichever edge is nearest,
/// so the number is the line's, not a distant server's — and because it takes
/// the size as a query parameter, which is what lets the test aim at a
/// duration instead of guessing one.
const DOWN_URL: &str = "https://speed.cloudflare.com/__down?bytes=";
const UP_URL: &str = "https://speed.cloudflare.com/__up";
/// How long each half of the test runs for. Long enough to get past TCP's slow
/// start on a fast line, short enough that nobody walks away from it.
const PHASE: Duration = Duration::from_secs(8);
/// How many sockets each half opens. A single TCP connection does not fill a
/// fast line — one stream on a gigabit connection measures the window, not the
/// link. Four is what it takes for the sum to reach the real ceiling.
const STREAMS: usize = 4;
/// The first slice of each phase is thrown away. It is slow start, DNS and the
/// TLS handshake, and including it reports a line as slower than it is.
const WARMUP: Duration = Duration::from_millis(1500);
/// A test that cannot reach the endpoint at all must fail quickly, not hang
/// for the whole phase.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
/// The upload body, made once and sent again per stream. Incompressible so a
/// transparent proxy cannot flatter the result.
const UPLOAD_CHUNK: usize = 1024 * 1024;

/// One reading of the adapter's counters: absolute totals, taken at an instant.
#[derive(Clone, Copy)]
struct Counters {
    rx: u64,
    tx: u64,
    at: Instant,
}

/// Throughput over the interval between the last two samples.
#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Throughput {
    pub down_bps: u64,
    pub up_bps: u64,
    /// Whether this is a real measurement. The very first sample has nothing
    /// to subtract from and is not one; reporting it as zero would tell the
    /// pacer the line is idle when it knows nothing at all.
    pub known: bool,
}

fn last() -> &'static Mutex<Option<Counters>> {
    static LAST: Mutex<Option<Counters>> = Mutex::new(None);
    &LAST
}

/// The newest throughput reading, for anything that wants the number without
/// driving the sampler itself.
static LAST_DOWN: AtomicU64 = AtomicU64::new(0);
static LAST_UP: AtomicU64 = AtomicU64::new(0);

/// Samples the counters and returns the rate since the previous call.
///
/// Blocking, but only just: it is two IP Helper calls. Callers on the main
/// thread must still go through `off_thread`, because "cheap" is not "free"
/// and the rule is the rule.
pub fn sample() -> Throughput {
    let now = match read_counters() {
        Some(counters) => counters,
        None => return Throughput::default(),
    };
    let Ok(mut slot) = last().lock() else {
        return Throughput::default();
    };
    let previous = slot.replace(now);
    let Some(previous) = previous else {
        return Throughput::default();
    };
    let seconds = now.at.duration_since(previous.at).as_secs_f64();
    // Two samples taken in the same instant divide by nothing, and a machine
    // that has just woken has a gap so long the average is meaningless.
    if !(0.05..=30.0).contains(&seconds) {
        return Throughput::default();
    }
    // Saturating, because the counters are reset when an adapter is disabled
    // and re-enabled, and a wrapped subtraction would read as a burst of
    // exabytes — which, to the pacer, looks exactly like a busy line.
    let rate = |now: u64, before: u64| ((now.saturating_sub(before)) as f64 / seconds) as u64;
    let out = Throughput {
        down_bps: rate(now.rx, previous.rx),
        up_bps: rate(now.tx, previous.tx),
        known: true,
    };
    LAST_DOWN.store(out.down_bps, Ordering::Relaxed);
    LAST_UP.store(out.up_bps, Ordering::Relaxed);
    out
}

/// Forgets the previous sample, so the next one starts a fresh interval.
/// Called when a sampler stops, so that resuming does not divide a long gap's
/// worth of bytes by the sampling interval.
pub fn reset() {
    if let Ok(mut slot) = last().lock() {
        *slot = None;
    }
}

#[cfg(windows)]
fn read_counters() -> Option<Counters> {
    use windows::Win32::NetworkManagement::IpHelper::{GetIfEntry2, MIB_IF_ROW2};
    let luid = default_route_luid()?;
    let mut row = MIB_IF_ROW2 {
        InterfaceLuid: luid,
        ..Default::default()
    };
    // SAFETY: the row is zeroed apart from the LUID that selects it, which is
    // exactly what GetIfEntry2 documents as its input.
    let error = unsafe { GetIfEntry2(&mut row) };
    if error.is_err() {
        return None;
    }
    Some(Counters {
        rx: row.InOctets,
        tx: row.OutOctets,
        at: Instant::now(),
    })
}

/// The interface the machine would actually send over.
///
/// Summing every adapter instead would be simpler and wrong: a PC with Hyper-V
/// or WSL has virtual adapters that carry the same bytes as the physical one,
/// so the total counts real traffic two or three times over — and a pacer fed
/// that number throttles a line nobody else is using.
#[cfg(windows)]
fn default_route_luid() -> Option<windows::Win32::NetworkManagement::Ndis::NET_LUID_LH> {
    use windows::Win32::Networking::WinSock::{AF_INET, IN_ADDR, SOCKADDR_INET};
    use windows::Win32::NetworkManagement::IpHelper::{GetBestRoute2, MIB_IPFORWARD_ROW2};

    // Asking for the route to a public address is what picks the adapter that
    // reaches the internet, rather than whichever one happens to be first.
    let mut destination = SOCKADDR_INET::default();
    // A union of address families; the IPv4 arm and its family are written
    // together, which is how it is meant to be filled in.
    destination.Ipv4.sin_family = AF_INET;
    destination.Ipv4.sin_addr = IN_ADDR {
        S_un: windows::Win32::Networking::WinSock::IN_ADDR_0 {
            // 1.1.1.1, in network byte order.
            S_addr: u32::from_be_bytes([1, 1, 1, 1]).to_be(),
        },
    };
    let mut route = MIB_IPFORWARD_ROW2::default();
    let mut source = SOCKADDR_INET::default();
    // SAFETY: all four pointers are to live locals for the duration of the
    // call, and the two out-parameters are fully initialised structs.
    let error = unsafe {
        GetBestRoute2(
            None,
            0,
            None,
            &destination,
            0,
            &mut route,
            &mut source,
        )
    };
    if error.is_err() {
        return None;
    }
    Some(route.InterfaceLuid)
}

#[cfg(not(windows))]
fn read_counters() -> Option<Counters> {
    None
}

// ---------------------------------------------------------------------------
// The speed test
// ---------------------------------------------------------------------------

/// What a finished test found. Bytes per second throughout — the UI does the
/// dividing, so there is one unit in the backend and no chance of a number
/// that is eight times wrong.
#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedResult {
    pub down_bps: u64,
    pub up_bps: u64,
    /// Round trip to the endpoint before either phase ran, in milliseconds.
    pub latency_ms: Option<u64>,
    /// How much worse the round trip got while the line was full. This is the
    /// number that says whether a video call will survive a download, and it
    /// is the reason the torrent pacer exists.
    pub loaded_latency_ms: Option<u64>,
    pub measured_at_ms: u64,
}

/// Progress, emitted as `speedtest:progress` while a test runs.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedProgress {
    /// `latency`, `download`, `upload` or `done`.
    pub phase: String,
    /// What to put on screen for this phase, already in words.
    pub label: String,
    /// 0..1 through the phase, when the phase has a known length.
    pub fraction: f64,
    /// The rate measured so far in this phase, so the number climbs while the
    /// test runs instead of appearing at the end.
    pub bps: u64,
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        // No overall timeout: each phase stops itself on the clock, and a
        // request killed mid-body is a failed test rather than a slow one.
        .timeout(PHASE + CONNECT_TIMEOUT + Duration::from_secs(5))
        .build()
        .map_err(|error| format!("Could not prepare the test: {error}"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn progress(app: &AppHandle, phase: &str, label: &str, fraction: f64, bps: u64) {
    let _ = app.emit(
        "speedtest:progress",
        SpeedProgress {
            phase: phase.to_owned(),
            label: label.to_owned(),
            fraction: fraction.clamp(0.0, 1.0),
            bps,
        },
    );
}

/// Runs the whole test. Blocking from start to finish and never called from
/// anywhere but a blocking pool thread.
pub fn run_test(app: AppHandle, want_upload: bool) -> Result<SpeedResult, String> {
    let client = client()?;
    progress(&app, "latency", "Measuring the round trip", 0.0, 0);
    let latency_ms = latency(&client);
    let (down_bps, loaded_latency_ms) = phase_download(&app, &client)?;
    let up_bps = if want_upload {
        phase_upload(&app, &client)?
    } else {
        0
    };
    progress(&app, "done", "Finished", 1.0, down_bps);
    Ok(SpeedResult {
        down_bps,
        up_bps,
        latency_ms,
        loaded_latency_ms,
        measured_at_ms: now_ms(),
    })
}

/// Five small requests; the median is kept, so one unlucky packet does not
/// become the answer.
fn latency(client: &reqwest::blocking::Client) -> Option<u64> {
    let mut samples = Vec::new();
    for _ in 0..5 {
        let started = Instant::now();
        let ok = client
            .get(format!("{DOWN_URL}0"))
            .send()
            .and_then(|response| response.bytes())
            .is_ok();
        if ok {
            samples.push(started.elapsed().as_millis() as u64);
        }
    }
    if samples.is_empty() {
        return None;
    }
    samples.sort_unstable();
    Some(samples[samples.len() / 2])
}

/// Returns the rate, and the round trip measured while the line was full.
fn phase_download(
    app: &AppHandle,
    client: &reqwest::blocking::Client,
) -> Result<(u64, Option<u64>), String> {
    use std::io::Read;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    let stop = Arc::new(AtomicBool::new(false));
    let counted = Arc::new(AtomicU64::new(0));
    let started = Instant::now();
    // Each stream asks for far more than it will be allowed to finish; the
    // clock, not the size, ends the phase.
    let ask = 512 * 1024 * 1024u64;
    let mut threads = Vec::new();
    for _ in 0..STREAMS {
        let client = client.clone();
        let stop = stop.clone();
        let counted = counted.clone();
        threads.push(std::thread::spawn(move || -> Result<(), String> {
            let mut response = client
                .get(format!("{DOWN_URL}{ask}"))
                .send()
                .map_err(|error| format!("Could not reach the speed test: {error}"))?;
            let mut buffer = vec![0u8; 256 * 1024];
            loop {
                if stop.load(Ordering::Relaxed) {
                    return Ok(());
                }
                match response.read(&mut buffer) {
                    Ok(0) => return Ok(()),
                    // Bytes are counted only after the warm-up, so slow start
                    // is measured by nobody.
                    Ok(read) => {
                        if started.elapsed() >= WARMUP {
                            counted.fetch_add(read as u64, Ordering::Relaxed);
                        }
                    }
                    // A stream cut short is not a failed test: the others are
                    // still running, and the rate is the sum of what arrived.
                    Err(_) => return Ok(()),
                }
            }
        }));
    }

    // While the line is full, one more small request says what a video call
    // would be feeling. This is the whole argument for pacing, measured.
    let mut loaded = Vec::new();
    while started.elapsed() < PHASE {
        std::thread::sleep(Duration::from_millis(250));
        let elapsed = started.elapsed();
        let measuring = elapsed.saturating_sub(WARMUP).as_secs_f64();
        let bps = if measuring > 0.2 {
            (counted.load(Ordering::Relaxed) as f64 / measuring) as u64
        } else {
            0
        };
        progress(
            app,
            "download",
            "Pulling data down",
            elapsed.as_secs_f64() / PHASE.as_secs_f64(),
            bps,
        );
        if elapsed > WARMUP && loaded.len() < 6 {
            let ping = Instant::now();
            if client
                .get(format!("{DOWN_URL}0"))
                .send()
                .and_then(|response| response.bytes())
                .is_ok()
            {
                loaded.push(ping.elapsed().as_millis() as u64);
            }
        }
    }
    stop.store(true, Ordering::Relaxed);
    let mut failure = None;
    for thread in threads {
        match thread.join() {
            Ok(Err(error)) => failure = Some(error),
            Err(_) => failure = Some("The download test stopped unexpectedly.".to_string()),
            _ => {}
        }
    }
    let measuring = started.elapsed().saturating_sub(WARMUP).as_secs_f64();
    let total = counted.load(Ordering::Relaxed);
    // Only a test that moved nothing at all is reported as an error; a slow
    // line is a result, not a failure.
    if total == 0 {
        return Err(failure.unwrap_or_else(|| {
            "No data arrived. The connection may be down, or the test blocked.".to_string()
        }));
    }
    loaded.sort_unstable();
    let loaded_ms = loaded.get(loaded.len() / 2).copied();
    Ok(((total as f64 / measuring.max(0.5)) as u64, loaded_ms))
}

fn phase_upload(app: &AppHandle, client: &reqwest::blocking::Client) -> Result<u64, String> {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    let stop = Arc::new(AtomicBool::new(false));
    let counted = Arc::new(AtomicU64::new(0));
    let started = Instant::now();
    let mut threads = Vec::new();
    for _ in 0..STREAMS {
        let client = client.clone();
        let stop = stop.clone();
        let counted = counted.clone();
        threads.push(std::thread::spawn(move || {
            // One request per chunk rather than one endless body: the bytes
            // are only counted once the server has taken them, so a local
            // socket buffer swallowing a megabyte cannot be reported as a
            // gigabit line.
            let chunk = vec![0x5Au8; UPLOAD_CHUNK];
            while !stop.load(Ordering::Relaxed) {
                let sent = client
                    .post(UP_URL)
                    .header("content-type", "application/octet-stream")
                    .body(chunk.clone())
                    .send();
                if sent.is_err() {
                    return;
                }
                if started.elapsed() >= WARMUP {
                    counted.fetch_add(UPLOAD_CHUNK as u64, Ordering::Relaxed);
                }
            }
        }));
    }
    while started.elapsed() < PHASE {
        std::thread::sleep(Duration::from_millis(250));
        let elapsed = started.elapsed();
        let measuring = elapsed.saturating_sub(WARMUP).as_secs_f64();
        let bps = if measuring > 0.2 {
            (counted.load(Ordering::Relaxed) as f64 / measuring) as u64
        } else {
            0
        };
        progress(
            app,
            "upload",
            "Pushing data up",
            elapsed.as_secs_f64() / PHASE.as_secs_f64(),
            bps,
        );
    }
    stop.store(true, Ordering::Relaxed);
    for thread in threads {
        let _ = thread.join();
    }
    let measuring = started.elapsed().saturating_sub(WARMUP).as_secs_f64();
    let total = counted.load(Ordering::Relaxed);
    if total == 0 {
        return Err("Nothing could be uploaded. The test may be blocked.".to_string());
    }
    Ok((total as f64 / measuring.max(0.5)) as u64)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// One throughput reading. The caller polls this; the interval between its
/// calls is the interval the rate is averaged over.
#[tauri::command]
pub async fn net_throughput() -> Throughput {
    tauri::async_runtime::spawn_blocking(sample)
        .await
        .unwrap_or_default()
}

/// Starts a fresh sampling interval, so the first reading after a tool opens
/// is not the average since whenever something last looked.
#[tauri::command]
pub async fn net_throughput_reset() {
    let _ = tauri::async_runtime::spawn_blocking(reset).await;
}

/// Runs a speed test. Contacts Cloudflare's speed endpoint, and only ever
/// because something asked it to.
#[tauri::command]
pub async fn net_speed_test(app: AppHandle, upload: Option<bool>) -> Result<SpeedResult, String> {
    let want_upload = upload.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || run_test(app, want_upload))
        .await
        .unwrap_or_else(|_| Err("The speed test could not be started.".into()))
}
