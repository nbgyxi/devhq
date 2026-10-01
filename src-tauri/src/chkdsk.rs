//! A streaming wrapper around Windows' built-in `chkdsk.exe`.
//!
//! `chkdsk` is inherently slow and reports its progress by rewriting one
//! console line with carriage returns, which is why running it from a terminal
//! looks like nothing is happening for minutes at a time. This module starts
//! it in its own thread, splits its output on `\r` as well as `\n`, and emits
//! every fragment as an event, so the page can draw a real percentage and name
//! the stage instead of showing a spinner.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};

static TOKEN: AtomicU64 = AtomicU64::new(0);
static CHILD_PID: AtomicU32 = AtomicU32::new(0);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub letter: String,
    pub label: String,
    pub file_system: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub removable: bool,
    pub system: bool,
}

/// What the page needs before it can offer anything: the volumes, and whether
/// this copy of WinT is running with the rights the online scan requires.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Survey {
    pub volumes: Vec<Volume>,
    pub elevated: bool,
}

pub fn survey() -> Result<Survey, String> {
    Ok(Survey {
        volumes: volumes()?,
        elevated: crate::dns::is_elevated(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    /// The volume to check, as a drive letter (`C` or `C:`).
    pub drive: String,
    /// `readonly` for a plain `chkdsk`, `scan` for the online `/scan`,
    /// `repair` for `/R`. See `arguments_for`.
    pub mode: String,
}

/// What chkdsk is actually run with, and whether the run needs administrator.
///
/// `/R` is the only mode here that writes to the volume. It implies `/F`, and
/// on top of the repairs it reads every sector on the disk and moves what it
/// can out of any it cannot read, writing them into `$BadClus` so NTFS never
/// allocates them again. That is the one thing that fences off bad media - and
/// it is also why it takes hours on a large disk and why it needs the volume
/// to itself.
///
/// What it deliberately does **not** do is answer chkdsk's questions. With no
/// stdin, a chkdsk that cannot lock the volume asks whether to force a
/// dismount, or - on the drive Windows is running from - whether to check at
/// the next restart, reads end-of-file and declines. Both of those are answers
/// only the person at the keyboard gets to give: forcing a dismount pulls the
/// volume out from under every program holding a file open on it, and a check
/// scheduled at boot can hold a machine out of Windows for hours with no way
/// to say no. The tool reports that it could not lock the drive instead.
fn arguments_for(mode: &str, letter: char) -> Result<(Vec<String>, bool), String> {
    let drive = format!("{letter}:");
    match mode {
        "readonly" => Ok((vec![drive], false)),
        // /scan is the online scan: it never asks to dismount the volume and
        // never schedules a check at the next boot, so nothing it starts can
        // keep the machine out of Windows.
        "scan" => Ok((
            vec![drive, "/scan".into(), "/perf".into()],
            true,
        )),
        "repair" => {
            let system = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
            if system
                .chars()
                .next()
                .is_some_and(|c| c.to_ascii_uppercase() == letter)
            {
                return Err(format!(
                    "{drive} is the drive Windows is running from, so it cannot be locked while \
                     Windows is up. A repair pass on it can only happen at the next restart, and \
                     scheduling that is not something this tool will do behind your back. Use the \
                     online scan here, or run `chkdsk {drive} /R` yourself from an administrator \
                     prompt and answer its question."
                ));
            }
            Ok((vec![drive, "/R".into()], true))
        }
        _ => Err("Unknown check mode.".into()),
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Line {
    token: u64,
    text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Done {
    token: u64,
    ok: bool,
    exit_code: i32,
    error: String,
}

#[cfg(windows)]
pub fn volumes() -> Result<Vec<Volume>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
    };
    let system_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for index in 0..26u32 {
        if mask & (1 << index) == 0 {
            continue;
        }
        let letter = (b'A' + index as u8) as char;
        let root = format!("{letter}:\\");
        let wide: Vec<u16> = root.encode_utf16().chain(Some(0)).collect();
        let kind = unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) };
        // DRIVE_REMOVABLE (2) and DRIVE_FIXED (3). chkdsk has nothing useful
        // to say about a network share or an optical drive.
        if kind != 2 && kind != 3 {
            continue;
        }
        // A volume that is not answering is exactly the one worth checking, so
        // unlike the drive list this does not drop it — it lists it without
        // the details it would have had to block to read. Asking Windows for
        // the label or the free space on a drive whose controller has stopped
        // answering takes minutes, and the page would have nothing on it until
        // every drive had been waited out.
        if !crate::volume::answers(std::path::Path::new(&root)) {
            out.push(Volume {
                letter: format!("{letter}:"),
                label: String::new(),
                file_system: String::new(),
                total_bytes: 0,
                free_bytes: 0,
                removable: kind == 2,
                system: format!("{letter}:").eq_ignore_ascii_case(&system_drive),
            });
            continue;
        }
        let mut label = [0u16; 261];
        let mut fs = [0u16; 261];
        let named = unsafe {
            GetVolumeInformationW(
                PCWSTR(wide.as_ptr()),
                Some(&mut label),
                None,
                None,
                None,
                Some(&mut fs),
            )
        }
        .is_ok();
        let (mut available, mut total, mut free) = (0u64, 0u64, 0u64);
        let sized = unsafe {
            GetDiskFreeSpaceExW(
                PCWSTR(wide.as_ptr()),
                Some(&mut available),
                Some(&mut total),
                Some(&mut free),
            )
        }
        .is_ok();
        if !sized && !named {
            continue;
        }
        let text = |buffer: &[u16]| {
            String::from_utf16_lossy(&buffer[..buffer.iter().position(|c| *c == 0).unwrap_or(0)])
        };
        out.push(Volume {
            letter: format!("{letter}:"),
            label: if named { text(&label) } else { String::new() },
            file_system: if named { text(&fs) } else { String::new() },
            total_bytes: total,
            free_bytes: free,
            removable: kind == 2,
            system: format!("{letter}:").eq_ignore_ascii_case(&system_drive),
        });
    }
    Ok(out)
}

#[cfg(not(windows))]
pub fn volumes() -> Result<Vec<Volume>, String> {
    Ok(Vec::new())
}

/// The drive letter on its own, uppercased, or an error naming what was wrong.
fn drive_letter(raw: &str) -> Result<char, String> {
    let trimmed = raw.trim().trim_end_matches(['\\', ':']);
    let mut chars = trimmed.chars();
    match (chars.next(), chars.next()) {
        (Some(letter), None) if letter.is_ascii_alphabetic() => Ok(letter.to_ascii_uppercase()),
        _ => Err("Choose a drive to check.".into()),
    }
}

pub fn start(app: AppHandle, options: Options) -> Result<u64, String> {
    let letter = drive_letter(&options.drive)?;
    let (args, needs_admin) = arguments_for(&options.mode, letter)?;
    let token = TOKEN.fetch_add(1, Ordering::SeqCst) + 1;
    // Everything but the read-only check needs administrator rights, and
    // asking for them must not mean restarting WinT. Windows is asked for
    // them for this one run, the way the hosts file and PC Detective ask.
    if needs_admin && !crate::dns::is_elevated() {
        std::thread::spawn(move || run_elevated(app, token, args));
        return Ok(token);
    }

    std::thread::spawn(move || {
        let mut command = Command::new("chkdsk.exe");
        command.args(&args);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }

        let mut exit_code = -1;
        let result = (|| -> Result<(), String> {
            let mut child = command
                .spawn()
                .map_err(|e| format!("Could not start chkdsk: {e}"))?;
            CHILD_PID.store(child.id(), Ordering::SeqCst);
            let mut stdout = child.stdout.take().ok_or("Chkdsk did not return output.")?;
            // chkdsk overwrites one line with `\r` while it counts up, so the
            // percentages only exist between carriage returns. Reading bytes
            // and cutting on either terminator is what turns that into
            // progress instead of one long pause.
            let mut buffer = [0u8; 1024];
            let mut pending = Vec::new();
            loop {
                let read = match stdout.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => read,
                    Err(_) => break,
                };
                if TOKEN.load(Ordering::SeqCst) != token {
                    let _ = child.kill();
                    return Err("Cancelled".into());
                }
                feed(&app, token, &mut pending, &buffer[..read]);
            }
            emit_pending(&app, token, &mut pending);
            let status = child.wait().map_err(|e| e.to_string())?;
            CHILD_PID.store(0, Ordering::SeqCst);
            exit_code = status.code().unwrap_or(-1);
            classify(exit_code)
        })();
        emit_done(&app, token, exit_code, result);
    });
    Ok(token)
}

/// What chkdsk's exit code means, in the words the page will show.
fn classify(exit_code: i32) -> Result<(), String> {
    match exit_code {
        // 0: clean. 1: chkdsk fixed something (only possible when the volume
        // was checked with repair rights).
        0 | 1 => Ok(()),
        2 => Err("Chkdsk found problems on this volume that only a repair pass can fix.".into()),
        3 => Err(
            "Chkdsk could not check this volume; it needs administrator rights or exclusive access."
                .into(),
        ),
        other => Err(format!("Chkdsk stopped with exit code {other}.")),
    }
}

fn emit_done(app: &AppHandle, token: u64, exit_code: i32, result: Result<(), String>) {
    let cancelled = matches!(&result, Err(error) if error == "Cancelled");
    let _ = app.emit(
        "chkdsk:done",
        Done {
            token,
            ok: result.is_ok(),
            exit_code,
            error: if cancelled {
                String::new()
            } else {
                result.err().unwrap_or_default()
            },
        },
    );
}

/// Split a chunk of console bytes on either terminator and emit what is whole.
/// A fragment with no terminator yet stays in `pending` for the next chunk.
fn feed(app: &AppHandle, token: u64, pending: &mut Vec<u8>, bytes: &[u8]) {
    for byte in bytes {
        if *byte == b'\r' || *byte == b'\n' {
            emit_pending(app, token, pending);
        } else {
            pending.push(*byte);
        }
    }
}

/// A check that needs administrator, run through one `runas` prompt for this
/// one run.
///
/// An elevated process has no pipe back to WinT, so the progress has to travel
/// some other way: chkdsk's output is redirected to a file in the temp folder
/// and this reads the tail of that file while the run lasts. The percentages
/// arrive exactly as they would from a pipe, because chkdsk writes the same
/// carriage returns to a file as it does to a console.
#[cfg(windows)]
fn run_elevated(app: AppHandle, token: u64, args: Vec<String>) {
    use std::io::{Seek, SeekFrom};
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, TerminateProcess, WaitForSingleObject,
    };
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let log = std::env::temp_dir().join(format!("wint-chkdsk-{}-{token}.log", std::process::id()));
    let _ = std::fs::remove_file(&log);
    // `< NUL` for the same reason the piped run gets a null stdin: chkdsk must
    // read end-of-file, not a console, if it ever asks whether to force a
    // dismount or to check at the next restart. See `arguments_for`.
    let params = HSTRING::from(format!(
        "/c chkdsk.exe {} < NUL > \"{}\" 2>&1",
        args.join(" "),
        log.display()
    ));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: w!("runas"),
        lpFile: w!("cmd.exe"),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    let process: HANDLE = unsafe {
        // ShellExecuteExW wants COM on the calling thread, and this thread has
        // none of its own.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if ShellExecuteExW(&mut info).is_err() || info.hProcess.is_invalid() {
            let _ = std::fs::remove_file(&log);
            return emit_done(
                &app,
                token,
                -1,
                Err("Windows did not grant administrator rights for the scan.".into()),
            );
        }
        info.hProcess
    };

    let mut pending = Vec::new();
    let mut read_from = 0u64;
    let mut buffer = [0u8; 4096];
    let mut exit_code = -1;
    let result = loop {
        let finished = unsafe { WaitForSingleObject(process, 250) } == WAIT_OBJECT_0;
        // The file may not exist for the first moment: cmd creates it, and the
        // prompt may still have been on screen when this loop started.
        if let Ok(mut file) = std::fs::File::open(&log) {
            if file.seek(SeekFrom::Start(read_from)).is_ok() {
                while let Ok(read) = file.read(&mut buffer) {
                    if read == 0 {
                        break;
                    }
                    read_from += read as u64;
                    feed(&app, token, &mut pending, &buffer[..read]);
                }
            }
        }
        if TOKEN.load(Ordering::SeqCst) != token {
            // An elevated process may refuse to be stopped by a process that
            // is not. Say which it was rather than claiming it stopped.
            let stopped = unsafe { TerminateProcess(process, 1) }.is_ok();
            break Err(if stopped {
                "Cancelled".into()
            } else {
                "Windows would not let WinT stop the administrator scan; it is still running and will finish on its own.".to_string()
            });
        }
        if finished {
            emit_pending(&app, token, &mut pending);
            let mut code = 0u32;
            if unsafe { GetExitCodeProcess(process, &mut code) }.is_ok() {
                exit_code = code as i32;
            }
            break classify(exit_code);
        }
    };
    unsafe {
        let _ = CloseHandle(process);
    }
    let _ = std::fs::remove_file(&log);
    emit_done(&app, token, exit_code, result);
}

#[cfg(not(windows))]
fn run_elevated(app: AppHandle, token: u64, _letter: char) {
    emit_done(
        &app,
        token,
        -1,
        Err("Only Windows volumes can be scanned.".into()),
    );
}

/// One console line, decoded and sent on. Empty fragments are dropped: a
/// `\r\n` pair would otherwise report a blank line between every real one.
fn emit_pending(app: &AppHandle, token: u64, pending: &mut Vec<u8>) {
    if pending.is_empty() {
        return;
    }
    let text = String::from_utf8_lossy(pending).trim_end().to_string();
    pending.clear();
    if text.trim().is_empty() {
        return;
    }
    let _ = app.emit("chkdsk:line", Line { token, text });
}

pub fn cancel() {
    // Bumping the token is what every run watches. An elevated run notices it
    // on its next turn around the tail loop and tries to stop the process
    // itself, because it holds the only handle to it.
    TOKEN.fetch_add(1, Ordering::SeqCst);
    let pid = CHILD_PID.swap(0, Ordering::SeqCst);
    if pid != 0 {
        let mut command = Command::new("taskkill.exe");
        command.arg("/PID").arg(pid.to_string()).arg("/T").arg("/F");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let _ = command.status();
    }
}

#[cfg(test)]
mod tests {
    use super::drive_letter;

    #[test]
    fn drive_letters_are_normalised() {
        assert_eq!(drive_letter("c").unwrap(), 'C');
        assert_eq!(drive_letter("D:").unwrap(), 'D');
        assert_eq!(drive_letter(" e:\\ ").unwrap(), 'E');
        assert!(drive_letter("").is_err());
        assert!(drive_letter("C:\\Windows").is_err());
        assert!(drive_letter("1").is_err());
    }
}
