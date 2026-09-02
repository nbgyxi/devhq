//! Shells WinT can fetch on demand, so a missing one is a button and not a
//! dead end.
//!
//! WinT ships none of these. A machine that already has PowerShell 7, NuShell
//! or Git for Windows installed keeps using its own copy - what is downloaded
//! here is only ever consulted last, in [`managed_exe`], so a private copy can
//! never quietly shadow the newer one the user maintains themselves.
//!
//! Everything in [`CATALOG`] is the publisher's own release asset, pinned by
//! URL, byte count and SHA-256 taken from the checksum file that publisher
//! ships beside it. A download that does not match all three is discarded,
//! which is what makes fetching an executable at runtime defensible at all.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

use crate::download;

/// How a verified archive is turned into a folder of files.
#[derive(Clone, Copy)]
enum Archive {
    Zip,
    /// A 7-Zip self-extracting executable, which is how Git for Windows ships
    /// the portable build. It unpacks itself with `-o<dir> -y`, asks nothing,
    /// and writes nothing outside `<dir>`.
    SelfExtracting,
}

#[derive(Clone, Copy)]
struct Entry {
    /// The terminal profile this satisfies, as `term.rs` names it.
    profile: &'static str,
    label: &'static str,
    publisher: &'static str,
    version: &'static str,
    url: &'static str,
    /// Exact size of the download, from the publisher's release metadata.
    size: u64,
    /// SHA-256 as published by the project, not as computed here.
    hash: &'static str,
    archive: Archive,
    /// The file that proves the unpack worked, relative to the install folder.
    exe: &'static str,
}

/// The shells that can be fetched, and nothing else. An arbitrary URL is not
/// something the front end gets to ask for.
const CATALOG: &[Entry] = &[
    Entry {
        profile: "pwsh",
        label: "PowerShell 7",
        publisher: "Microsoft",
        version: "7.6.5",
        url: "https://github.com/PowerShell/PowerShell/releases/download/v7.6.5/PowerShell-7.6.5-win-x64.zip",
        size: 106_319_290,
        hash: "32eb8f6cdce08f86e987d625a2733e54ac3e289ae7e1621b14c0b5bcec2434ea",
        archive: Archive::Zip,
        exe: "pwsh.exe",
    },
    Entry {
        profile: "pwsh-preview",
        label: "PowerShell Preview",
        publisher: "Microsoft",
        version: "7.7.0-preview.4",
        url: "https://github.com/PowerShell/PowerShell/releases/download/v7.7.0-preview.4/PowerShell-7.7.0-preview.4-win-x64.zip",
        size: 108_328_242,
        hash: "17cb533371c469659963cf918f9655be8d40ce68782fee4253f71ea22baa34e7",
        archive: Archive::Zip,
        exe: "pwsh.exe",
    },
    Entry {
        profile: "nu",
        label: "NuShell",
        publisher: "The Nushell Project",
        version: "0.115.1",
        url: "https://github.com/nushell/nushell/releases/download/0.115.1/nu-0.115.1-x86_64-pc-windows-msvc.zip",
        size: 59_759_609,
        hash: "b83009cbc88021f4dc293c49320118886b78363f9a4bb14933d33c8803241f46",
        archive: Archive::Zip,
        exe: "nu.exe",
    },
    Entry {
        profile: "git-bash",
        label: "Git Bash",
        publisher: "Git for Windows",
        version: "2.55.0.5",
        url: "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/PortableGit-2.55.0.5-64-bit.7z.exe",
        size: 58_960_208,
        hash: "5aa8a20f6e9abb2c755f0e73c91c687701a46b309ad84a0ca6509380fa4ae290",
        archive: Archive::SelfExtracting,
        exe: "bin/bash.exe",
    },
];

static BUSY: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

/// Where WinT keeps the programs it manages itself, next to the `wt.exe`
/// proxy the terminal dock already installs there.
pub fn runtime_root() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("WinT")
        .join("runtime")
}

/// Installs are kept under the pinned version, so bumping the pin lands beside
/// the old copy rather than on top of a folder something may be running out
/// of. Only the pinned version counts as installed.
fn install_dir(entry: &Entry) -> PathBuf {
    runtime_root()
        .join("shells")
        .join(entry.profile)
        .join(entry.version)
}

fn entry(profile: &str) -> Option<&'static Entry> {
    CATALOG.iter().find(|item| item.profile == profile)
}

/// The copy WinT downloaded for this profile, if it is there and complete.
///
/// Every caller in `term.rs` asks this **after** looking on PATH and in Program
/// Files: a real installation always wins.
pub fn managed_exe(profile: &str) -> Option<PathBuf> {
    let entry = entry(profile)?;
    let path = install_dir(entry).join(entry.exe);
    path.is_file().then_some(path)
}

fn folder_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|item| match item.file_type() {
            Ok(kind) if kind.is_dir() => folder_size(&item.path()),
            _ => item.metadata().map(|data| data.len()).unwrap_or(0),
        })
        .sum()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellDownload {
    profile: &'static str,
    label: &'static str,
    publisher: &'static str,
    version: &'static str,
    /// Bytes to fetch, exactly - this is what the button promises to spend.
    download_bytes: u64,
    /// What the unpacked copy actually takes, measured, or 0 when not present.
    installed_bytes: u64,
    /// True when WinT has its own copy of this shell.
    managed: bool,
    /// The host the bytes come from, so the offer names its source.
    source: String,
}

/// What Settings shows: every shell that can be fetched, and the state of the
/// copy WinT manages for it.
pub fn catalog() -> Vec<ShellDownload> {
    CATALOG
        .iter()
        .map(|entry| {
            let dir = install_dir(entry);
            let managed = dir.join(entry.exe).is_file();
            ShellDownload {
                profile: entry.profile,
                label: entry.label,
                publisher: entry.publisher,
                version: entry.version,
                download_bytes: entry.size,
                installed_bytes: if managed { folder_size(&dir) } else { 0 },
                managed,
                source: entry
                    .url
                    .split('/')
                    .nth(2)
                    .unwrap_or("github.com")
                    .to_string(),
            }
        })
        .collect()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    profile: String,
    phase: String,
    detail: String,
    downloaded: u64,
    total: u64,
    done: bool,
    error: String,
}

fn emit(app: &AppHandle, profile: &str, phase: &str, detail: String, n: u64, total: u64) {
    let _ = app.emit(
        "shells:download-progress",
        Progress {
            profile: profile.into(),
            phase: phase.into(),
            detail,
            downloaded: n,
            total,
            done: false,
            error: String::new(),
        },
    );
}

fn finish(app: &AppHandle, profile: &str, error: String) {
    let _ = app.emit(
        "shells:download-progress",
        Progress {
            profile: profile.into(),
            phase: if error.is_empty() { "done" } else { "error" }.into(),
            detail: if error.is_empty() {
                "Ready".into()
            } else {
                error.clone()
            },
            downloaded: 0,
            total: 0,
            done: true,
            error,
        },
    );
}

fn megabytes(n: u64) -> String {
    format!("{} MB", n / 1_000_000)
}

/// Unpacks a 7-Zip self-extracting archive. It is the same binary Git for
/// Windows publishes - it has simply been checked against the published hash
/// before it is allowed to run.
fn self_extract(archive: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut command = std::process::Command::new(archive);
    command.arg(format!("-o{}", dest.display())).arg("-y");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let status = command
        .status()
        .map_err(|e| format!("The archive could not be unpacked: {e}"))?;
    if !status.success() {
        return Err("The archive did not unpack cleanly.".into());
    }
    Ok(())
}

/// Drops every other version of this shell once a new one is in place, so a
/// pin bump does not leave a few hundred megabytes of the old one behind.
fn prune_old_versions(entry: &Entry) {
    let root = runtime_root().join("shells").join(entry.profile);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    for item in entries.flatten() {
        if item.file_name() != std::ffi::OsStr::new(entry.version) {
            let _ = std::fs::remove_dir_all(item.path());
        }
    }
}

fn run(app: &AppHandle, entry: &Entry) -> Result<(), String> {
    let dir = install_dir(entry);
    if dir.join(entry.exe).is_file() {
        return Ok(());
    }
    let staging = dir.with_file_name(format!("{}.incoming", entry.version));
    let _ = std::fs::remove_dir_all(&staging);
    let archive = runtime_root().join("shells").join(match entry.archive {
        Archive::Zip => format!("{}-{}.zip", entry.profile, entry.version),
        Archive::SelfExtracting => format!("{}-{}.exe", entry.profile, entry.version),
    });
    emit(
        app,
        entry.profile,
        "download",
        format!("Downloading {} {}", entry.label, entry.version),
        0,
        entry.size,
    );
    let profile = entry.profile;
    let mut report = |n: u64, total: u64| {
        emit(
            app,
            profile,
            "download",
            format!("{} of {}", megabytes(n), megabytes(total)),
            n,
            total,
        )
    };
    download::fetch(
        entry.url,
        entry.size,
        entry.hash,
        &archive,
        &CANCEL,
        &mut report,
    )?;
    emit(
        app,
        entry.profile,
        "extract",
        "Unpacking".into(),
        entry.size,
        entry.size,
    );
    let unpacked = match entry.archive {
        Archive::Zip => download::unzip(&archive, &staging, &CANCEL),
        Archive::SelfExtracting => self_extract(&archive, &staging),
    };
    let _ = std::fs::remove_file(&archive);
    if let Err(e) = unpacked {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    if !staging.join(entry.exe).is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!(
            "The verified archive did not contain {}.",
            entry.exe
        ));
    }
    // The folder takes its real name only once the shell inside it is known to
    // be there, so a half-unpacked copy is never what `managed_exe` finds.
    if let Some(parent) = dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&staging, &dir)
        .map_err(|e| format!("The unpacked shell could not be put in place: {e}"))?;
    prune_old_versions(entry);
    Ok(())
}

/// Starts a download on its own thread and reports it through
/// `shells:download-progress`. Nothing here touches the window thread.
pub fn install(app: AppHandle, profile: String) -> Result<(), String> {
    let entry = *entry(&profile).ok_or("That shell is not one WinT can download.")?;
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("Another shell is already downloading.".into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        let result = run(&app, &entry);
        BUSY.store(false, Ordering::SeqCst);
        finish(&app, entry.profile, result.err().unwrap_or_default());
    });
    Ok(())
}

pub fn cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// Removes WinT's copy. The machine's own installation, if it has one, is
/// untouched - this only ever deletes inside WinT's runtime folder.
pub fn remove(profile: &str) -> Result<(), String> {
    let entry = entry(profile).ok_or("That shell is not one WinT manages.")?;
    let dir = runtime_root().join("shells").join(entry.profile);
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("It could not be removed: {e}"))
}
