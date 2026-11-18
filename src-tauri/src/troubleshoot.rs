//! One file to send when WinT misbehaves on somebody else's PC.
//!
//! App health shows the log to whoever is sitting in front of it; this packs
//! what a developer needs to read the same story somewhere else: WinT's own
//! health log, what Windows itself recorded when WinT crashed or hung, and a
//! short description of the machine.
//!
//! Everything text goes through `feedback::redact` on the way in, so user
//! names in paths, email addresses and anything that reads as a secret are
//! taken out. Memory dumps are deliberately left behind: they hold whatever
//! was in memory, and nobody can check that by reading them first. Their
//! names and sizes are listed so they can be asked for.

use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// How many Windows crash reports and log events are worth the space.
const MAX_REPORTS: usize = 10;
const MAX_EVENTS: usize = 25;

pub struct Phase<'a>(pub &'a dyn Fn(&str));

/// Builds the zip in memory. `phase` names each step as it starts, for the
/// status line.
pub fn collect(version: &str, webview: &str, phase: Phase<'_>) -> Result<Vec<u8>, String> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut add = |name: &str, text: &str| -> Result<(), String> {
        zip.start_file(name, options).map_err(|e| e.to_string())?;
        zip.write_all(without_pc_name(&crate::feedback::redact(text)).as_bytes())
            .map_err(|e| e.to_string())
    };
    let mut contents: Vec<String> = Vec::new();

    (phase.0)("Reading WinT's health log");
    if let Some(path) = crate::health::log_path() {
        for (file, name) in [
            (path.clone(), "wint/health.log"),
            (path.with_extension("log.1"), "wint/health.previous.log"),
        ] {
            if let Ok(text) = std::fs::read_to_string(&file) {
                add(name, &text)?;
                contents.push(format!("{name} - WinT's own log: freezes, slow calls, panics, recoveries"));
            }
        }
    }

    (phase.0)("Reading Windows crash reports");
    let reports = wer_reports();
    for (index, (dir, text)) in reports.iter().enumerate() {
        let folder = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        add(&format!("windows/crash-reports/{:02}-{folder}.txt", index + 1), text)?;
    }
    if !reports.is_empty() {
        contents.push(format!(
            "windows/crash-reports/ - {} report(s) Windows Error Reporting wrote when WinT crashed or hung, newest first",
            reports.len()
        ));
    }

    (phase.0)("Reading the Windows event log");
    let events = crash_events();
    add("windows/events.txt", &events)?;
    contents.push("windows/events.txt - Application Error and Application Hang events for WinT and its WebView2 processes".into());

    (phase.0)("Describing this PC");
    add("system.txt", &system(version, webview))?;
    contents.push("system.txt - WinT and Windows versions, memory, what was running when this was made".into());

    let readme = format!(
        "WinT troubleshooting files\r\n\
         Made by WinT {version} on {}.\r\n\r\n\
         {}\r\n\r\n\
         User names in paths, email addresses and anything that looks like a password or \
         token have been replaced with [redacted]. Memory dumps are not included; system.txt \
         lists any that exist.\r\n",
        now_local(),
        contents.join("\r\n"),
    );
    add("README.txt", &readme)?;

    zip.finish()
        .map(|cursor| cursor.into_inner())
        .map_err(|e| e.to_string())
}

/// `WinT-troubleshooting-<version>-<yyyy-mm-dd>.zip`.
pub fn default_name(version: &str) -> String {
    let today: String = now_local().chars().take(10).collect();
    format!("WinT-troubleshooting-{version}-{today}.zip")
}

fn wer_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for var in ["LOCALAPPDATA", "PROGRAMDATA"] {
        if let Some(base) = std::env::var_os(var) {
            let wer = PathBuf::from(base).join("Microsoft").join("Windows").join("WER");
            roots.push(wer.join("ReportArchive"));
            roots.push(wer.join("ReportQueue"));
        }
    }
    roots
}

/// The `Report.wer` of every WER folder named for wint.exe, newest first.
fn wer_reports() -> Vec<(PathBuf, String)> {
    let mut found: Vec<(SystemTime, PathBuf)> = Vec::new();
    for root in wer_roots() {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if !name.contains("_wint.exe_") {
                continue;
            }
            let when = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            found.push((when, entry.path()));
        }
    }
    found.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    found
        .into_iter()
        .take(MAX_REPORTS)
        .filter_map(|(_, dir)| {
            let text = read_wer(&dir.join("Report.wer"))?;
            Some((dir, text))
        })
        .collect()
}

/// Report.wer is UTF-16 with a byte order mark.
fn read_wer(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        Some(String::from_utf16_lossy(&units))
    } else {
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }
}

/// Application Error / Application Hang events that name WinT or WebView2.
fn crash_events() -> String {
    let query = "/q:*[System[Provider[@Name='Application Error' or @Name='Application Hang']]]";
    let Some(text) = crate::util::run_lossy(
        "wevtutil",
        &["qe", "Application", query, "/c:400", "/rd:true", "/f:text"],
        None,
    ) else {
        return "The Windows event log could not be read.\r\n".into();
    };
    let ours: Vec<&str> = text
        .split("Event[")
        .filter(|block| {
            let lower = block.to_lowercase();
            lower.contains("wint.exe") || lower.contains("msedgewebview2.exe")
        })
        .take(MAX_EVENTS)
        .collect();
    if ours.is_empty() {
        "Windows has no Application Error or Application Hang events for WinT.\r\n".into()
    } else {
        ours.iter()
            .map(|block| format!("Event[{}", block.trim_end()))
            .collect::<Vec<_>>()
            .join("\r\n\r\n")
    }
}

fn system(version: &str, webview: &str) -> String {
    let mut lines = vec![
        format!("WinT: {version}{}", if crate::is_official_build() { " (Store build)" } else { " (local build)" }),
        format!("Made: {}", now_local()),
        format!("This session recovered from a crash: {}", if crate::recovery::recovered() { "yes" } else { "no" }),
    ];
    #[cfg(windows)]
    {
        use windows::Win32::System::Registry::HKEY_LOCAL_MACHINE;
        let key = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
        let get = |name| crate::reg::get_sz(HKEY_LOCAL_MACHINE, key, Some(name)).unwrap_or_default();
        lines.push(format!(
            "Windows: {} {} build {}",
            get("ProductName"),
            get("DisplayVersion"),
            get("CurrentBuild")
        ));
        unsafe {
            use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
            let mut memory = MEMORYSTATUSEX {
                dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
                ..Default::default()
            };
            if GlobalMemoryStatusEx(&mut memory).is_ok() {
                let gb = |bytes: u64| bytes as f64 / (1u64 << 30) as f64;
                lines.push(format!(
                    "Memory: {:.1} GB, {:.1} GB free ({}% in use)",
                    gb(memory.ullTotalPhys),
                    gb(memory.ullAvailPhys),
                    memory.dwMemoryLoad
                ));
            }
        }
    }
    lines.push(format!("Architecture: {}", std::env::consts::ARCH));
    lines.push(format!("WebView2: {}", if webview.is_empty() { "unknown" } else { webview }));

    let report = crate::health::report(0);
    lines.push(format!("Running for: {} min", report.uptime / 60));
    lines.push(format!("In flight right now: {}", report.in_flight));

    let dumps = dump_listing();
    lines.push(String::new());
    lines.push("Crash dumps on this PC (not included - ask for one if it is needed):".into());
    if dumps.is_empty() {
        lines.push("  none".into());
    } else {
        lines.extend(dumps.into_iter().map(|line| format!("  {line}")));
    }
    lines.join("\r\n") + "\r\n"
}

/// Names and sizes of the dumps a crash may have left: Windows' own for
/// wint.exe, and WebView2's for the renderers.
fn dump_listing() -> Vec<String> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        dirs.push(local.join("CrashDumps"));
        for app in ["com.devhq.app", "WinT"] {
            dirs.push(local.join(app).join("EBWebView").join("Crashpad").join("reports"));
        }
    }
    for root in wer_roots() {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().to_lowercase().contains("_wint.exe_") {
                dirs.push(entry.path());
            }
        }
    }
    let mut found = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let lower = name.to_lowercase();
            let ours = dir.ends_with("reports") || lower.starts_with("wint.exe");
            if !(lower.ends_with(".dmp") || lower.ends_with(".mdmp")) || !ours {
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            found.push(format!("{} ({} KB)", entry.path().display(), size / 1024));
        }
    }
    found
}

/// Local date and time, `yyyy-mm-dd hh:mm`, as the clock on the taskbar shows it.
fn now_local() -> String {
    #[cfg(windows)]
    unsafe {
        let t = windows::Win32::System::SystemInformation::GetLocalTime();
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}",
            t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute
        )
    }
    #[cfg(not(windows))]
    String::from("unknown time")
}

/// The PC's name is in the health log's start lines and in every event the
/// event log holds; it says nothing about a crash and something about whose
/// machine it was.
fn without_pc_name(text: &str) -> String {
    let Ok(name) = std::env::var("COMPUTERNAME") else {
        return text.to_string();
    };
    if name.len() < 2 {
        return text.to_string();
    }
    let lower = text.to_lowercase();
    let needle = name.to_lowercase();
    // Lowercasing can change byte lengths outside ASCII; then the offsets
    // below would not line up, so only an ASCII name is matched this way.
    if lower.len() != text.len() || !needle.is_ascii() {
        return text.replace(&name, "[pc]");
    }
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while let Some(found) = lower[at..].find(&needle) {
        out.push_str(&text[at..at + found]);
        out.push_str("[pc]");
        at += found + needle.len();
    }
    out.push_str(&text[at..]);
    out
}
