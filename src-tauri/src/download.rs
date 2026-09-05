//! One verified download, shared by everything WinT fetches on demand.
//!
//! Models, the local AI runtime and the shells in [`crate::shells`] all want
//! the same thing: stream a pinned URL to disk, say how far along it is, refuse
//! anything whose bytes are not what was pinned, and stop the moment the user
//! cancels. Keeping that here means "verified" is defined once instead of once
//! per caller - a second copy is how one of them quietly stops checking.
//!
//! A transfer that stops early keeps its `.part` file, and the next attempt
//! asks the server to continue from that offset with a `Range` request. An
//! 18 GB model that died at 90% then costs the last 10%, not the whole thing.

use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// How many bytes pass between progress reports. Every chunk would be a few
/// thousand events a second for no visible difference; this is roughly a tick
/// of a progress bar.
const PROGRESS_STEP: u64 = 2_000_000;

/// How long may pass between progress reports. Bytes alone go quiet exactly
/// when the user most wants to know something is still happening - a stalled
/// or crawling transfer would freeze its own readout - so a slow download
/// still reports on this beat, with a rate that falls towards zero.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(400);

/// One progress report: where the transfer is, how fast it is moving right
/// now, and how much of it was already on disk when it started.
pub struct Tick {
    /// Bytes on disk, counting anything a resume inherited.
    pub done: u64,
    /// Bytes the finished file will have.
    pub total: u64,
    /// Recent throughput in bytes per second, smoothed over a few reports.
    /// Zero until the first interval has passed.
    pub speed: f64,
    /// Seconds left at the current rate, or `None` while the rate is unknown.
    pub eta: Option<u64>,
    /// Bytes an interrupted attempt left behind and this one did not re-fetch.
    pub resumed: u64,
}

/// Tracks throughput across reports so the rate shown is the rate now, not the
/// average since the start - those two disagree by a lot on a transfer whose
/// speed drops away from the burst a CDN opens with.
struct Rate {
    last: Instant,
    last_bytes: u64,
    speed: f64,
}

impl Rate {
    fn new(at: u64) -> Self {
        Rate {
            last: Instant::now(),
            last_bytes: at,
            speed: 0.0,
        }
    }

    /// Folds the bytes since the previous report into a smoothed rate. The
    /// weighting is deliberately gentle: a raw per-interval rate jitters far
    /// too much to read, and a plain average hides a slowdown entirely.
    fn update(&mut self, done: u64) -> f64 {
        let elapsed = self.last.elapsed().as_secs_f64();
        if elapsed <= 0.0 {
            return self.speed;
        }
        let sample = done.saturating_sub(self.last_bytes) as f64 / elapsed;
        self.last = Instant::now();
        self.last_bytes = done;
        self.speed = if self.speed == 0.0 {
            sample
        } else {
            self.speed * 0.7 + sample * 0.3
        };
        self.speed
    }
}

/// Re-reads a `.part` file into the hasher so a resumed transfer still ends up
/// with the SHA-256 of the whole file. Reading a few GB back off the disk costs
/// seconds; downloading them again costs minutes.
fn rehash(part: &Path, sha: &mut Sha256, cancel: &AtomicBool) -> Result<u64, String> {
    let mut file = File::open(part).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 1 << 20];
    let mut n = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("Download cancelled.".into());
        }
        let got = file.read(&mut buf).map_err(|e| e.to_string())?;
        if got == 0 {
            return Ok(n);
        }
        sha.update(&buf[..got]);
        n += got as u64;
    }
}

/// Streams `url` to `target`, verifying the size and SHA-256 before the file is
/// allowed to appear under its real name.
///
/// The download lands on a `.part` file first, so a cancelled or corrupt
/// transfer can never be mistaken for a finished one: `target` only exists if
/// every byte was checked. That `.part` file outlives a cancel or a dropped
/// connection on purpose - it is what the next attempt resumes from. Only a
/// file that fails verification is thrown away, because a `.part` holding the
/// wrong bytes would go on failing forever.
pub fn fetch(
    url: &str,
    expected: u64,
    hash: &str,
    target: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&Tick),
) -> Result<(), String> {
    let part = target.with_extension("part");
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?
    }
    let have = partial(target, expected);
    let mut request = reqwest::blocking::Client::builder()
        .user_agent("WinT")
        .build()
        .map_err(|e| e.to_string())?
        .get(url);
    if have > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let mut response = request
        .send()
        .map_err(|e| format!("Download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Download failed: {e}"))?;
    // A server that ignores the Range header answers 200 with the whole file
    // instead of 206 with the tail, and the only safe reading of that is to
    // start over.
    let resuming = have > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let mut sha = Sha256::new();
    let mut n = 0u64;
    let mut out = if resuming {
        n = rehash(&part, &mut sha, cancel)?;
        OpenOptions::new()
            .append(true)
            .open(&part)
            .map_err(|e| e.to_string())?
    } else {
        File::create(&part).map_err(|e| e.to_string())?
    };
    let total = if resuming {
        expected
    } else {
        response.content_length().unwrap_or(expected)
    };
    let resumed = n;
    let mut rate = Rate::new(n);
    let mut buf = [0u8; 131072];
    let mut next = n + PROGRESS_STEP;
    let mut beat = Instant::now();
    let report = |n: u64, speed: f64, progress: &mut dyn FnMut(&Tick)| {
        progress(&Tick {
            done: n,
            total,
            speed,
            eta: (speed > 1.0 && total > n).then(|| ((total - n) as f64 / speed) as u64),
            resumed,
        })
    };
    report(n, 0.0, progress);
    loop {
        if cancel.load(Ordering::Relaxed) {
            // The bytes so far stay on disk; the next attempt continues here.
            let _ = out.flush();
            drop(out);
            return Err("Download cancelled.".into());
        }
        let got = response.read(&mut buf).map_err(|e| e.to_string())?;
        if got == 0 {
            break;
        }
        out.write_all(&buf[..got]).map_err(|e| e.to_string())?;
        sha.update(&buf[..got]);
        n += got as u64;
        if n >= next || beat.elapsed() >= PROGRESS_INTERVAL {
            next = n + PROGRESS_STEP;
            beat = Instant::now();
            let speed = rate.update(n);
            report(n, speed, progress);
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    if n != expected {
        let _ = fs::remove_file(&part);
        return Err(format!(
            "Size verification failed ({n} of {expected} bytes)."
        ));
    }
    if format!("{:x}", sha.finalize()) != hash {
        let _ = fs::remove_file(&part);
        return Err("SHA-256 verification failed; the download was discarded.".into());
    }
    fs::rename(part, target).map_err(|e| e.to_string())
}

/// Bytes an interrupted attempt at `target` left behind, if they are worth
/// resuming from. Anything at or past the expected size is not: it is either
/// finished but unverified, or a different file altogether.
pub fn partial(target: &Path, expected: u64) -> u64 {
    target
        .with_extension("part")
        .metadata()
        .ok()
        .map(|m| m.len())
        .filter(|&n| n > 0 && n < expected)
        .unwrap_or(0)
}

/// Unpacks a verified archive into `dest`.
///
/// Entry names come from `enclosed_name`, which drops anything that would climb
/// out of `dest` - a verified archive is still an archive, and one bad path
/// would write wherever it liked.
pub fn unzip(archive: &Path, dest: &Path, cancel: &AtomicBool) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        if cancel.load(Ordering::Relaxed) {
            return Err("Download cancelled.".into());
        }
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(name) = entry.enclosed_name() else {
            continue;
        };
        let path = dest.join(name);
        if entry.is_dir() {
            fs::create_dir_all(path).map_err(|e| e.to_string())?
        } else {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?
            }
            std::io::copy(
                &mut entry,
                &mut File::create(path).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
