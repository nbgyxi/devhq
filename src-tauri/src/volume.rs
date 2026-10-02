//! Whether a volume is still answering — asked once for the whole app.
//!
//! A drive whose controller has stopped answering does not fail calls, it
//! swallows them: `GetDiskFreeSpaceExW` on a USB disk that has gone away sits
//! in the driver for minutes, and so does a plain `metadata`. Nothing in the
//! app is prepared for that. The drive list is re-read every half minute by
//! anything showing free space, so a dead volume used to leave one blocked
//! thread behind per refresh, for as long as the app ran; a drag off that
//! volume took the thread that draws the window with it.
//!
//! So the question is asked here, once, with a deadline, and the answer is
//! shared. Three things follow from that:
//!
//! - **One probe per volume at a time.** A probe that has not come back is
//!   left alone rather than joined by another, because a second call into a
//!   driver that is not answering answers no sooner and costs another thread.
//! - **A deadline, not a wait.** The probe thread is abandoned when it runs
//!   over; it ends by itself whenever the volume does, and writes its answer
//!   down on the way out so the next caller gets it.
//! - **Healthy volumes cost nothing.** An answer is good for `FRESH`, which is
//!   far shorter than anything a user would notice and far longer than the
//!   gap between the calls that ask.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long a volume is given to answer before it counts as not answering.
///
/// A healthy disk answers in microseconds and a sleeping one in a second or
/// two. Three seconds is past anything a drive that is merely slow needs, and
/// well short of the minutes a drive that has stopped answering will take.
const PROBE: Duration = Duration::from_secs(3);

/// How long an answer is trusted before the volume is asked again. Long enough
/// that a page refreshing twice a second never probes, short enough that a
/// drive coming back is noticed while the user is still looking at it.
const FRESH: Duration = Duration::from_secs(5);

#[derive(Default)]
struct State {
    /// Whether an answer has ever come back for this volume.
    known: bool,
    answering: bool,
    /// Total and free bytes, from the probe. Carried here because the call
    /// that reads them is the call that blocks: asking again outside the probe
    /// would be the whole problem over again. See `probe_volume`.
    space: Option<(u64, u64)>,
    checked: Option<Instant>,
    /// A probe is out. Nothing starts another while this is set.
    probing: bool,
}

/// The one call that actually touches the device, run only ever on a probe
/// thread that may be abandoned.
///
/// It asks for the free space rather than merely stat-ing the root, because
/// those are not the same question. A drive whose controller is failing
/// answers `metadata("E:\\")` from the cache the moment it is asked and leaves
/// `GetDiskFreeSpaceExW` in the driver for minutes — which is exactly how the
/// first version of this got it wrong, probing something cheap and then
/// letting the caller go on to make the expensive call anyway.
#[cfg(windows)]
fn probe_volume(root: &Path) -> Option<(u64, u64)> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut path = root.to_string_lossy().into_owned();
    if !path.ends_with(['\\', '/']) {
        path.push('\\');
    }
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let (mut available, mut total, mut free) = (0u64, 0u64, 0u64);
    unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR(wide.as_ptr()),
            Some(&mut available),
            Some(&mut total),
            Some(&mut free),
        )
    }
    .ok()
    .map(|()| (total, free))
}

#[cfg(not(windows))]
fn probe_volume(root: &Path) -> Option<(u64, u64)> {
    std::fs::metadata(root).ok().map(|_| (0, 0))
}

/// The map, and the way a probe says it has finished. One condvar for every
/// volume rather than one each: a probe finishing is rare, the waiters are few,
/// and each of them re-reads the state it was waiting on anyway.
fn states() -> &'static (Mutex<HashMap<String, State>>, std::sync::Condvar) {
    static STATES: OnceLock<(Mutex<HashMap<String, State>>, std::sync::Condvar)> = OnceLock::new();
    STATES.get_or_init(Default::default)
}

/// The volume a path lives on, as the key everything here agrees on: the drive
/// letter, or the share, uppercased.
pub fn root_of(path: &Path) -> Option<PathBuf> {
    use std::path::Component;
    match path.components().next() {
        Some(c @ (Component::Prefix(_) | Component::RootDir)) => Some(PathBuf::from(c.as_os_str())),
        _ => None,
    }
}

/// Whether this volume is answering. Costs one lock when the answer is fresh,
/// and at most `PROBE` when it is not.
pub fn answers(root: &Path) -> bool {
    let key = root.to_string_lossy().to_uppercase();
    let (lock, finished) = states();
    let mut map = lock.lock().unwrap_or_else(|e| e.into_inner());
    let deadline = Instant::now() + PROBE;
    loop {
        let entry = map.entry(key.clone()).or_default();
        if entry.probing {
            // Something already asked and has not been answered. Anything this
            // volume has said before stands in for the answer rather than
            // waiting for it — a volume that was fine a moment ago is fine
            // enough to list while the next probe runs, and one that was not is
            // the reason the probe is taking this long.
            if entry.known {
                return entry.answering;
            }
            // Nothing has ever come back for this volume, so there is nothing
            // to stand in. Waiting for the probe already out is both quicker
            // and truer than starting another: the first time two callers
            // arrive together, the second used to be told "no" about a drive
            // that was about to answer yes.
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            let (guard, timed_out) = finished
                .wait_timeout(map, left)
                .unwrap_or_else(|e| e.into_inner());
            map = guard;
            if timed_out.timed_out() {
                return false;
            }
            continue;
        }
        if entry.checked.is_some_and(|at| at.elapsed() < FRESH) {
            return entry.answering;
        }
        entry.probing = true;
        break;
    }
    drop(map);

    let probed = root.to_path_buf();
    let probed_key = key.clone();
    if std::thread::Builder::new()
        .name("wint-volume-probe".into())
        .spawn(move || {
            let space = probe_volume(&probed);
            let (lock, finished) = states();
            let mut written = lock.lock().unwrap_or_else(|e| e.into_inner());
            let entry = written.entry(probed_key).or_default();
            entry.probing = false;
            entry.known = true;
            entry.answering = space.is_some();
            entry.space = space;
            entry.checked = Some(Instant::now());
            // The caller may be long gone — this is the half of the answer
            // that matters for whoever asks next.
            finished.notify_all();
        })
        .is_err()
    {
        let mut map = lock.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(key).or_default().probing = false;
        finished.notify_all();
        // A thread that cannot be started says nothing about the drive, and
        // refusing every volume because of that would be worse than the risk.
        return true;
    }

    let mut map = lock.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        let entry = map.entry(key.clone()).or_default();
        if !entry.probing {
            return entry.known && entry.answering;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            // Abandoned, not waited out: the probe thread writes its answer
            // down whenever the volume gets round to it, and until then every
            // caller is told what this one was told.
            return false;
        }
        let (guard, _) = finished
            .wait_timeout(map, left)
            .unwrap_or_else(|e| e.into_inner());
        map = guard;
    }
}

/// The total and free bytes on this volume, or `None` when it would not say
/// within the deadline.
///
/// This is the call anything listing drives should use. The number comes from
/// the probe thread, so a drive that has stopped answering costs the caller a
/// deadline once rather than minutes every time the list is refreshed.
pub fn space(root: &Path) -> Option<(u64, u64)> {
    if !answers(root) {
        return None;
    }
    let key = root.to_string_lossy().to_uppercase();
    let (lock, _) = states();
    let map = lock.lock().unwrap_or_else(|e| e.into_inner());
    map.get(&key).and_then(|state| state.space)
}

/// Whether every volume these paths live on is answering, named if one is not.
pub fn all_answer(paths: &[String]) -> Result<(), String> {
    use std::collections::BTreeSet;
    let roots: BTreeSet<PathBuf> = paths
        .iter()
        .filter_map(|path| root_of(Path::new(path.as_str())))
        .collect();
    for root in roots {
        if !answers(&root) {
            return Err(format!(
                "{} is not answering. Let it settle, or check the drive, and try again.",
                root.display()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_working_volume_answers() {
        let temp = std::env::temp_dir();
        let root = root_of(&temp).expect("the temp folder has no volume");
        assert!(answers(&root), "{} did not answer", root.display());
    }

    #[test]
    fn the_answer_is_reused() {
        let temp = std::env::temp_dir();
        let root = root_of(&temp).unwrap();
        assert!(answers(&root));
        // Second time through it is the cache, so it cannot take a probe's
        // worth of time.
        let at = Instant::now();
        assert!(answers(&root));
        assert!(at.elapsed() < Duration::from_millis(250));
    }

    #[test]
    fn a_path_with_no_volume_has_no_root() {
        assert!(root_of(Path::new("relative/thing.txt")).is_none());
    }
}
