//! One verified download, shared by everything DevHQ fetches on demand.
//!
//! Models, the local AI runtime and the shells in [`crate::shells`] all want
//! the same thing: stream a pinned URL to disk, say how far along it is, refuse
//! anything whose bytes are not what was pinned, and stop the moment the user
//! cancels. Keeping that here means "verified" is defined once instead of once
//! per caller - a second copy is how one of them quietly stops checking.

use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// How many bytes pass between progress reports. Every chunk would be a few
/// thousand events a second for no visible difference; this is roughly a tick
/// of a progress bar.
const PROGRESS_STEP: u64 = 2_000_000;

/// Streams `url` to `target`, verifying the size and SHA-256 before the file is
/// allowed to appear under its real name.
///
/// The download lands on a `.part` file first, so a cancelled or corrupt
/// transfer can never be mistaken for a finished one: `target` only exists if
/// every byte was checked.
pub fn fetch(
    url: &str,
    expected: u64,
    hash: &str,
    target: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(), String> {
    let part = target.with_extension("part");
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?
    }
    let mut response = reqwest::blocking::Client::builder()
        .user_agent("DevHQ")
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .send()
        .map_err(|e| format!("Download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Download failed: {e}"))?;
    let total = response.content_length().unwrap_or(expected);
    let mut out = File::create(&part).map_err(|e| e.to_string())?;
    let mut sha = Sha256::new();
    let mut buf = [0u8; 131072];
    let mut n = 0u64;
    let mut next = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(out);
            let _ = fs::remove_file(&part);
            return Err("Download cancelled.".into());
        }
        let got = response.read(&mut buf).map_err(|e| e.to_string())?;
        if got == 0 {
            break;
        }
        out.write_all(&buf[..got]).map_err(|e| e.to_string())?;
        sha.update(&buf[..got]);
        n += got as u64;
        if n >= next {
            next = n + PROGRESS_STEP;
            progress(n, total);
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
