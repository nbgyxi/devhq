//! How much of the line the torrent engine is allowed to take.
//!
//! BitTorrent's whole character is that it will use everything it is given —
//! which is exactly what makes a video call stutter and a page take five
//! seconds to load while a download runs. The fix is not a smaller number: a
//! fixed cap low enough to stay out of the way wastes the line every hour
//! nobody else is using it.
//!
//! So the cap moves. Every `TICK` this samples the adapter's own byte counters
//! (`netmeter`), subtracts what the engine reports moving, and treats the
//! difference as **everyone else** — a browser, Windows Update, a call. The
//! engine is then given what is left of the ceiling after the rest of the PC
//! has been served, plus a reserve it is never allowed to eat into:
//!
//! ```text
//! cap = clamp(ceiling - other - reserve, floor, ceiling)
//! ```
//!
//! Two rules keep that from oscillating, which is the failure mode of every
//! naive version of this:
//!
//! * **Down fast, up slow.** A new demand takes the cap down at once — the
//!   point is that the other program never feels the queue. Coming back up is
//!   done in steps, so a browser that goes quiet for one sample does not get
//!   run over by the engine reclaiming the whole line before the next click.
//! * **Nothing is sent that is not a change.** The cap goes to the engine only
//!   when it differs by more than `MEANINGFUL` from the one it is already
//!   applying, so a steady line is a steady engine and not a message every two
//!   seconds.
//!
//! The ceiling itself is either measured (the Speed Test tool, or the button
//! in the torrent settings) or learned: the best throughput this PC has ever
//! actually been seen to reach is remembered, so a line that was never tested
//! still gets a ceiling that is about right, and a wrong one corrects itself
//! upward the first time the line is genuinely full.
//!
//! When the pacer is off, the user's own maximum is applied as a plain cap and
//! nothing here samples anything.

use crate::netmeter;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Where the settings live. One file, like everything else the front end must
/// not lose: a throttle that silently forgets itself is worse than no throttle.
const KEY: &str = "torrent-pace";
/// How often the line is looked at. Fast enough that a call notices nothing,
/// slow enough to average out a single lumpy sample.
const TICK: Duration = Duration::from_secs(2);
/// A cap is only sent to the engine when it moves by more than this fraction
/// of the ceiling. Below that the engine would be re-tuned constantly for a
/// difference nobody could measure.
const MEANINGFUL: f64 = 0.04;
/// The most the cap may climb in one tick, as a fraction of the ceiling.
/// Recovery therefore takes about ten seconds from the floor, which is slower
/// than any human notices and far slower than a browser's next request.
const RAMP_UP: f64 = 0.20;
/// Traffic below this is noise — ARP, DNS, a heartbeat, the engine's own
/// trackers — not a program that wants the line. Without it the pacer would
/// throttle itself forever on an idle PC.
const IDLE_FLOOR_BPS: u64 = 96 * 1024;
/// The engine's reported rate is what its sockets moved; the adapter also
/// carries the TCP and IP headers, retransmits and the overhead of talking to
/// a hundred peers. Subtracting the engine's own figure straight from the
/// adapter's leaves that overhead behind, looking exactly like another program
/// using a slice of the line — and the pacer then throttles itself in a loop
/// that ends at the floor. Scaling up what the engine claims before
/// subtracting it is what stops that.
const OVERHEAD: f64 = 1.08;
/// A learned ceiling only moves up on a sample sustained for this long. One
/// burst out of the router's buffer is not the line's capacity.
const PEAK_HOLD: Duration = Duration::from_secs(6);

/// Where the ceiling came from.
#[derive(Clone, Copy, Serialize, Deserialize, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// Nothing is known about the line yet, so nothing is paced against it.
    #[default]
    Unknown,
    /// The best throughput this PC has been seen to reach.
    Learned,
    /// A real test, run because someone asked for one.
    Measured,
}

/// Everything the user chose, and everything measured for them.
#[derive(Clone, Copy, Serialize, Deserialize, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Pace {
    /// Give way to other programs. Off, `max_*_bps` is a plain fixed cap.
    pub adaptive: bool,
    /// The most the engine may ever use, whatever else is going on. Zero is
    /// "no limit", and with the pacer on it means the whole measured ceiling.
    pub max_down_bps: u64,
    pub max_up_bps: u64,
    /// What the line is believed to carry, in total.
    pub ceiling_down_bps: u64,
    pub ceiling_up_bps: u64,
    /// Shown, because a cap derived from a guess should say that it is one.
    pub ceiling_source: Source,
    /// When the ceiling last came from a real test. Milliseconds since the
    /// epoch; zero when it never did.
    pub measured_at_ms: u64,
    /// The share of the ceiling held back for everyone else, 0..0.5. The
    /// engine is never given the last slice of the line, because a link run to
    /// exactly 100% is a link with a full queue, and a full queue is the lag.
    pub reserve: f64,
    /// The engine is never squeezed below this, so a download does not stop
    /// dead the moment anything else opens a socket.
    pub floor_down_bps: u64,
    pub floor_up_bps: u64,
}

impl Default for Pace {
    fn default() -> Self {
        Self {
            adaptive: false,
            max_down_bps: 0,
            max_up_bps: 0,
            ceiling_down_bps: 0,
            ceiling_up_bps: 0,
            ceiling_source: Source::Unknown,
            measured_at_ms: 0,
            // A tenth of the line is enough for a call, a page load and the
            // acknowledgements of the download itself.
            reserve: 0.10,
            floor_down_bps: 256 * 1024,
            floor_up_bps: 64 * 1024,
        }
    }
}

/// What the pacer is doing right now. Emitted as `torrent:pace`, so the
/// settings panel can show the decision being made rather than a switch whose
/// effect is invisible.
#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaceState {
    /// What every other program on this PC is using.
    pub other_down_bps: u64,
    pub other_up_bps: u64,
    /// What the whole adapter is moving.
    pub link_down_bps: u64,
    pub link_up_bps: u64,
    /// The cap in force, as last sent to the engine. Zero is no limit.
    pub cap_down_bps: u64,
    pub cap_up_bps: u64,
    /// Whether the pacer has actually pulled the engine back below the user's
    /// maximum, which is the one thing worth saying in a sentence.
    pub yielding: bool,
}

fn config() -> &'static Mutex<Pace> {
    static CONFIG: Mutex<Pace> = Mutex::new(Pace {
        adaptive: false,
        max_down_bps: 0,
        max_up_bps: 0,
        ceiling_down_bps: 0,
        ceiling_up_bps: 0,
        ceiling_source: Source::Unknown,
        measured_at_ms: 0,
        reserve: 0.10,
        floor_down_bps: 256 * 1024,
        floor_up_bps: 64 * 1024,
    });
    &CONFIG
}

fn state() -> &'static Mutex<PaceState> {
    static STATE: Mutex<PaceState> = Mutex::new(PaceState {
        other_down_bps: 0,
        other_up_bps: 0,
        link_down_bps: 0,
        link_up_bps: 0,
        cap_down_bps: 0,
        cap_up_bps: 0,
        yielding: false,
    });
    &STATE
}

/// The cap the engine was last actually told about, so a tick that decides
/// nothing new sends nothing. `u64::MAX` means "not yet told anything", which
/// is different from having been told there is no limit.
static SENT_DOWN: AtomicU64 = AtomicU64::new(u64::MAX);
static SENT_UP: AtomicU64 = AtomicU64::new(u64::MAX);

/// Reads the saved settings and starts the controller. Called once, from
/// setup, and never blocks: the read is a small file and the loop is a thread
/// of its own.
pub fn init(app: &AppHandle) {
    if let Some(saved) = crate::ui_state::read(app, KEY) {
        if let Ok(pace) = serde_json::from_value::<Pace>(saved) {
            if let Ok(mut current) = config().lock() {
                *current = sane(pace);
            }
        }
    }
    controller(app.clone());
}

/// Clamps whatever came back from disk or the front end into the range the
/// rest of this module assumes. A hand-edited file must not be able to hand
/// the engine a cap of one byte a second.
fn sane(mut pace: Pace) -> Pace {
    pace.reserve = pace.reserve.clamp(0.0, 0.5);
    pace.floor_down_bps = pace.floor_down_bps.clamp(32 * 1024, 64 * 1024 * 1024);
    pace.floor_up_bps = pace.floor_up_bps.clamp(16 * 1024, 64 * 1024 * 1024);
    // `ceiling_source` is ours to set, never the caller's: it says where the
    // number came from, and only this module knows that.
    pace.ceiling_source = match (pace.measured_at_ms, pace.ceiling_down_bps) {
        (0, 0) => Source::Unknown,
        (0, _) => Source::Learned,
        _ => Source::Measured,
    };
    pace
}

/// The settings as they stand.
pub fn current() -> Pace {
    config().lock().map(|c| *c).unwrap_or_default()
}

fn save(app: &AppHandle, pace: &Pace) {
    let _ = crate::ui_state::write(app, KEY, &json!(pace));
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

fn controller(app: AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("torrent-pace".into())
        .spawn(move || {
            // Where the cap stood at the end of the last tick, so the climb
            // back up is a ramp rather than a jump.
            let mut cap_down = 0f64;
            let mut cap_up = 0f64;
            let mut peak_down_since: Option<(u64, Instant)> = None;
            loop {
                std::thread::sleep(TICK);
                tick(&app, &mut cap_down, &mut cap_up, &mut peak_down_since);
            }
        })
        .ok();
}

fn tick(
    app: &AppHandle,
    cap_down: &mut f64,
    cap_up: &mut f64,
    peak_down_since: &mut Option<(u64, Instant)>,
) {
    let pace = current();
    let engine_running = crate::torrent::is_running();

    // Nothing to pace. The adapter is not even sampled, because a reading
    // taken while nothing is paced only makes the next real one wrong.
    if !pace.adaptive || !engine_running {
        netmeter::reset();
        if engine_running {
            // The plain cap still has to reach the engine — this is the path
            // the switch turns off into, and the user's own maximum is what
            // should be in force the moment it does. Through the same
            // gate as every other decision, so an unchanged fixed cap is not
            // re-sent to the helper every two seconds for as long as WinT runs.
            send_if_changed(
                pace.max_down_bps,
                pace.max_up_bps,
                pace.max_down_bps.max(pace.max_up_bps),
            );
        }
        if let Ok(mut state) = state().lock() {
            *state = PaceState {
                cap_down_bps: pace.max_down_bps,
                cap_up_bps: pace.max_up_bps,
                ..Default::default()
            };
        }
        return;
    }

    let link = netmeter::sample();
    if !link.known {
        return;
    }
    let (engine_down, engine_up) = crate::torrent::last_rates();

    // What the rest of the PC is using. Saturating, because the engine's own
    // figure and the adapter's are taken a moment apart and a falling transfer
    // can make the first larger than the second.
    let other_down = link
        .down_bps
        .saturating_sub((engine_down as f64 * OVERHEAD) as u64);
    let other_up = link
        .up_bps
        .saturating_sub((engine_up as f64 * OVERHEAD) as u64);
    let other_down = if other_down < IDLE_FLOOR_BPS { 0 } else { other_down };
    let other_up = if other_up < IDLE_FLOOR_BPS { 0 } else { other_up };

    // The line is at least as fast as the fastest it has ever been seen to
    // run. A ceiling that was only ever guessed corrects itself this way, and
    // a measured one is still raised by evidence that beats the test.
    let learned = learn(link.down_bps, peak_down_since);
    let ceiling_down = ceiling(pace.ceiling_down_bps.max(learned), pace.max_down_bps);
    let ceiling_up = ceiling(pace.ceiling_up_bps, pace.max_up_bps);
    if learned > pace.ceiling_down_bps && learned > 0 {
        remember_learned(app, learned);
    }

    let target_down = target(
        ceiling_down,
        pace.max_down_bps,
        other_down,
        pace.reserve,
        pace.floor_down_bps,
    );
    let target_up = target(
        ceiling_up,
        pace.max_up_bps,
        other_up,
        pace.reserve,
        pace.floor_up_bps,
    );

    *cap_down = ramp(*cap_down, target_down, ceiling_down);
    *cap_up = ramp(*cap_up, target_up, ceiling_up);

    let down = *cap_down as u64;
    let up = *cap_up as u64;
    // Yielding means one thing only: the engine is being held under what the
    // user allowed it, because something else wanted the line. A cap equal to
    // their own maximum is the pacer standing aside, not working.
    let yielding = down > 0 && (pace.max_down_bps == 0 || down < pace.max_down_bps);

    if let Ok(mut state) = state().lock() {
        *state = PaceState {
            other_down_bps: other_down,
            other_up_bps: other_up,
            link_down_bps: link.down_bps,
            link_up_bps: link.up_bps,
            cap_down_bps: down,
            cap_up_bps: up,
            yielding,
        };
        let _ = app.emit("torrent:pace", *state);
    }
    send_if_changed(down, up, ceiling_down.max(ceiling_up));
}

/// The ceiling in force: what was measured or learned, but never more than the
/// user's own maximum, and the maximum alone when nothing has been measured.
fn ceiling(measured: u64, max: u64) -> u64 {
    match (measured, max) {
        (0, max) => max,
        (measured, 0) => measured,
        (measured, max) => measured.min(max),
    }
}

/// What the engine should be allowed, before smoothing.
fn target(ceiling: u64, max: u64, other: u64, reserve: f64, floor: u64) -> u64 {
    // Nothing else is using the line, so there is nothing to give way to. The
    // engine gets exactly what the user asked for — not the ceiling, and not
    // the ceiling less a reserve.
    //
    // This is also the only way a learned ceiling is ever allowed to grow. It
    // is the fastest the PC has been *seen* to go, which on a line that has
    // never been filled is far below what the line can carry; holding the
    // engine under it even on an idle connection would make the guess true by
    // preventing anything that could disprove it. An idle line is therefore
    // the pacer's chance to find out, and the ceiling rises when it does.
    if other == 0 {
        return max;
    }
    // Without a ceiling there is no share to work out, so the user's own
    // maximum stands rather than a number invented here. Measuring, or one
    // busy minute of downloading, is what turns this into real pacing.
    if ceiling == 0 {
        return max;
    }
    let held = (ceiling as f64 * reserve) as u64;
    let share = ceiling
        .saturating_sub(other)
        .saturating_sub(held)
        .max(floor.min(ceiling));
    // The user's maximum is a maximum, not a target: yielding may only ever
    // lower the cap below it.
    if max == 0 {
        share
    } else {
        share.min(max)
    }
}

/// Down at once, up in steps. Zero — no limit — is passed through, since there
/// is nothing to ramp between.
fn ramp(now: f64, target: u64, ceiling: u64) -> f64 {
    // No limit is not a height to climb to, it is the absence of one.
    if target == 0 {
        return 0.0;
    }
    let scale = ceiling.max(target);
    let target = target as f64;
    if now <= 0.0 || target < now {
        return target;
    }
    let step = scale as f64 * RAMP_UP;
    (now + step).min(target)
}

fn send_if_changed(down: u64, up: u64, scale: u64) {
    let threshold = ((scale as f64 * MEANINGFUL) as u64).max(32 * 1024);
    let moved = |sent: &AtomicU64, value: u64| {
        let before = sent.load(Ordering::Relaxed);
        // Never seen, or crossing between limited and unlimited, is always a
        // change: those two are not a difference in degree.
        before == u64::MAX
            || (before == 0) != (value == 0)
            || before.abs_diff(value) > threshold
    };
    if !moved(&SENT_DOWN, down) && !moved(&SENT_UP, up) {
        return;
    }
    SENT_DOWN.store(down, Ordering::Relaxed);
    SENT_UP.store(up, Ordering::Relaxed);
    send(down, up);
}

/// Hands the cap to the engine. Delivery is the answer, like every other
/// instruction to the helper; what it actually did shows up in the next
/// snapshot's rates.
fn send(down: u64, up: u64) {
    crate::torrent::set_rate_caps(down, up);
}

/// Forget what the engine was last told, so the next decision is sent whatever
/// it is. Called when the helper restarts: its settings came back from its own
/// file, and this side's memory of them is stale.
pub fn forget_sent() {
    SENT_DOWN.store(u64::MAX, Ordering::Relaxed);
    SENT_UP.store(u64::MAX, Ordering::Relaxed);
}

/// The high-water mark, held for `PEAK_HOLD` before it counts.
fn learn(down_bps: u64, held: &mut Option<(u64, Instant)>) -> u64 {
    match held {
        // A faster sample restarts the hold at the new figure.
        Some((peak, _)) if down_bps > *peak => {
            *held = Some((down_bps, Instant::now()));
            0
        }
        Some((peak, since)) if since.elapsed() >= PEAK_HOLD => {
            let peak = *peak;
            *held = None;
            peak
        }
        Some(_) => 0,
        None => {
            if down_bps > IDLE_FLOOR_BPS {
                *held = Some((down_bps, Instant::now()));
            }
            0
        }
    }
}

/// Writes a learned ceiling back. Only ever upward, and never over a measured
/// one's provenance: a number the line was seen to reach is evidence, but the
/// test is still what the panel should credit.
fn remember_learned(app: &AppHandle, down_bps: u64) {
    let saved = {
        let Ok(mut pace) = config().lock() else { return };
        if down_bps <= pace.ceiling_down_bps {
            return;
        }
        pace.ceiling_down_bps = down_bps;
        if pace.measured_at_ms == 0 {
            pace.ceiling_source = Source::Learned;
        }
        *pace
    };
    save(app, &saved);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The settings and the live decision together: one call, because the panel
/// wants both and asking twice could show a cap from before the switch moved.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaceView {
    pub pace: Pace,
    pub state: PaceState,
}

#[tauri::command]
pub async fn torrent_pace() -> PaceView {
    PaceView {
        pace: current(),
        state: state().lock().map(|s| *s).unwrap_or_default(),
    }
}

/// Changes the settings. Absent keys are left alone, like the engine's own
/// `settings`, so the panel can send one switch without restating the rest.
#[tauri::command]
pub async fn torrent_pace_set(app: AppHandle, patch: serde_json::Value) -> Result<PaceView, String> {
    let updated = {
        let mut pace = current();
        if let Some(v) = patch.get("adaptive").and_then(serde_json::Value::as_bool) {
            pace.adaptive = v;
        }
        if let Some(v) = patch.get("maxDownBps").and_then(serde_json::Value::as_u64) {
            pace.max_down_bps = v;
        }
        if let Some(v) = patch.get("maxUpBps").and_then(serde_json::Value::as_u64) {
            pace.max_up_bps = v;
        }
        if let Some(v) = patch.get("reserve").and_then(serde_json::Value::as_f64) {
            pace.reserve = v;
        }
        if let Some(v) = patch.get("floorDownBps").and_then(serde_json::Value::as_u64) {
            pace.floor_down_bps = v;
        }
        if let Some(v) = patch.get("floorUpBps").and_then(serde_json::Value::as_u64) {
            pace.floor_up_bps = v;
        }
        let pace = sane(pace);
        if let Ok(mut current) = config().lock() {
            *current = pace;
        }
        pace
    };
    save(&app, &updated);
    // The old cap is not left in force while the next tick comes round: a
    // switch that takes two seconds to do anything reads as a switch that did
    // nothing.
    forget_sent();
    if !updated.adaptive {
        let (down, up) = (updated.max_down_bps, updated.max_up_bps);
        // Recorded as sent before it is sent, so the tick two seconds later
        // sees its own decision already in force rather than repeating it.
        SENT_DOWN.store(down, Ordering::Relaxed);
        SENT_UP.store(up, Ordering::Relaxed);
        tauri::async_runtime::spawn_blocking(move || crate::torrent::set_rate_caps(down, up));
    }
    Ok(PaceView {
        pace: updated,
        state: state().lock().map(|s| *s).unwrap_or_default(),
    })
}

/// Measures the line and uses the result as the ceiling. The test itself is
/// `netmeter`'s, and the only thing added here is writing the answer down.
#[tauri::command]
pub async fn torrent_pace_measure(app: AppHandle) -> Result<PaceView, String> {
    let result = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || netmeter::run_test(app, true))
            .await
            .map_err(|error| error.to_string())??
    };
    let updated = {
        let mut pace = current();
        pace.ceiling_down_bps = result.down_bps;
        pace.ceiling_up_bps = result.up_bps;
        pace.measured_at_ms = result.measured_at_ms;
        let pace = sane(pace);
        if let Ok(mut current) = config().lock() {
            *current = pace;
        }
        pace
    };
    save(&app, &updated);
    forget_sent();
    Ok(PaceView {
        pace: updated,
        state: state().lock().map(|s| *s).unwrap_or_default(),
    })
}
