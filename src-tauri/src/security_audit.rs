//! Security Sweep: a coding agent the person already installed, pointed at
//! their own machine instead of a project.
//!
//! The agent does the looking and the fixing - it has a shell of its own, runs
//! PowerShell itself, and may kill, disable or remove what it finds. WinT only
//! starts one turn at a time, streams what the agent is doing back to the tool,
//! and hands the next turn the answer the person chose. Every turn continues
//! the same agent session, so nothing the agent learned is lost between choices.
//!
//! A turn runs in print mode, where nobody can answer the CLI's own prompts - a
//! permission it would ask for is simply refused. So every tool the audit needs
//! is allowed up front, and the agent asks the person *through its reply*: a
//! JSON block the tool renders as a question with answers, acted on next turn.
//!
//! Administrator rights are decided **once, before the audit starts**, and
//! never change afterwards. Elevating halfway would mean a new process and a
//! new context, which is exactly what the audit must not lose. An elevated
//! audit starts a small PowerShell host through a single `runas` prompt; that
//! host stays alive for the whole audit and runs every turn of the agent, so
//! there is one prompt, not one per turn.
//!
//! The host talks to WinT over two one-way named pipes. Both are created here
//! with `FILE_FLAG_FIRST_PIPE_INSTANCE` and a single instance, and each
//! connection is only accepted from the process `runas` actually started - a
//! pipe any process of this user could connect to would otherwise be a way to
//! run things as administrator without the prompt.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/* ------------------------------------------------------------ the agents */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditAgent {
    id: &'static str,
    label: &'static str,
    installed: bool,
}

/// Which agent CLIs are on this machine. Presence only: the tool asks for a
/// choice, and a version check per CLI would make that choice wait.
#[tauri::command]
pub async fn audit_agents() -> Vec<AuditAgent> {
    tauri::async_runtime::spawn_blocking(|| {
        vec![
            AuditAgent { id: "claude", label: "Claude Code", installed: crate::term::claude_program().is_some() },
            AuditAgent { id: "codex", label: "Codex", installed: crate::codex::codex_path().is_some() },
            AuditAgent { id: "gemini", label: "Gemini", installed: crate::gemini::gemini_path().is_some() },
            AuditAgent { id: "copilot", label: "GitHub Copilot", installed: crate::copilot::copilot_path().is_some() },
            AuditAgent { id: "cursor", label: "Cursor Agent", installed: crate::cursor::find_agent().is_some() },
        ]
    })
    .await
    .unwrap_or_default()
}

fn is_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn quote(value: &Path) -> String {
    format!("\"{}\"", value.display())
}

/// The whole command line for one turn, as `cmd.exe /s /c` runs it.
///
/// One string rather than a program and arguments, because the elevated host
/// has to run exactly the same thing and a string is what survives the pipe.
/// Nothing in it is typed by anyone: the prompt goes in on stdin, and the only
/// variable part is a session id that has already been checked.
fn turn_line(agent: &str, session: Option<&str>, first: bool) -> Result<String, String> {
    let session = session.filter(|id| is_session_id(id));
    let line = match agent {
        "claude" => {
            let path = crate::term::claude_program().ok_or("Claude Code is not installed.")?;
            let mut line = format!(
                "{} -p --output-format stream-json --verbose \
                 --allowedTools \"Bash,PowerShell,Read,Grep,Glob,LS,Edit,Write\"",
                quote(&path)
            );
            if let Some(id) = session {
                line.push_str(if first { " --session-id " } else { " --resume " });
                line.push_str(id);
            }
            line
        }
        "codex" => {
            let path = crate::codex::codex_path().ok_or("Codex is not installed.")?;
            let mut line = format!(
                "{} exec --json --skip-git-repo-check --sandbox danger-full-access",
                quote(&path)
            );
            if let (Some(id), false) = (session, first) {
                line.push_str(" resume ");
                line.push_str(id);
            }
            line.push_str(" -");
            line
        }
        "gemini" => {
            let path = crate::gemini::gemini_path().ok_or("Gemini CLI is not installed.")?;
            let mut line = format!("{} --output-format stream-json --yolo", quote(&path));
            if let (Some(id), false) = (session, first) {
                line.push_str(" --resume ");
                line.push_str(id);
            }
            line
        }
        "copilot" => {
            let path = crate::copilot::copilot_path().ok_or("GitHub Copilot CLI is not installed.")?;
            let mut line = format!(
                "{} --output-format json --allow-all --no-ask-user",
                quote(&path)
            );
            if let (Some(id), false) = (session, first) {
                line.push_str(&format!(" --resume={id}"));
            }
            line
        }
        "cursor" => {
            let found = crate::cursor::find_agent().ok_or("Cursor Agent is not installed.")?;
            let mut line = format!(
                "set \"CURSOR_INVOKED_AS=agent\"&& {} {} --print --output-format stream-json --force --trust",
                quote(&found.node),
                quote(&found.script)
            );
            if let Some(id) = session {
                line.push_str(" --resume ");
                line.push_str(id);
            }
            line
        }
        _ => return Err("That agent is not one the audit knows.".into()),
    };
    Ok(line)
}

/* ------------------------------------------------------------ the session */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditStart {
    /// The folder the audit keeps its log and report in, and the one
    /// every agent turn runs in - so the agent is not started inside somebody's
    /// project.
    dir: String,
    elevated: bool,
    computer: String,
}

/// Where every audit keeps its files: `%LOCALAPPDATA%\WinT\audits`.
fn audits_root() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("WinT")
        .join("audits")
}

/// A folder handed back by the front end, accepted only if it is one of ours.
fn audit_dir(dir: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(dir);
    let inside = path.parent().is_some_and(|parent| parent == audits_root());
    if inside && path.is_dir() {
        Ok(path)
    } else {
        Err("The audit folder is gone. Scan again.".into())
    }
}

fn is_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !value.starts_with('.')
}

struct Broker {
    requests: File,
    replies: Option<File>,
}

fn broker() -> &'static Mutex<Option<Broker>> {
    static BROKER: OnceLock<Mutex<Option<Broker>>> = OnceLock::new();
    BROKER.get_or_init(|| Mutex::new(None))
}

fn direct() -> &'static Mutex<Option<Child>> {
    static DIRECT: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
    DIRECT.get_or_init(|| Mutex::new(None))
}

/// Starts an audit. With `elevated`, this is where the one administrator
/// prompt happens; declining it fails the start rather than quietly carrying on
/// without rights the person asked for.
#[tauri::command]
pub async fn audit_begin(elevated: bool, stamp: String) -> Result<AuditStart, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_token(&stamp) {
            return Err("That audit name is not valid.".into());
        }
        cancel_now();
        let dir = audits_root().join(&stamp);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Could not prepare the audit folder: {e}"))?;
        let already = crate::dns::is_elevated();
        // Scanning again with the same rights keeps the administrator session,
        // so a second scan does not mean a second Windows prompt.
        let running = broker().lock().unwrap().is_some();
        if !elevated || already {
            stop_broker();
        } else if !running {
            let started = start_broker(&dir)?;
            *broker().lock().unwrap() = Some(started);
        }
        Ok(AuditStart {
            dir: dir.to_string_lossy().into_owned(),
            elevated: elevated || already,
            computer: std::env::var("COMPUTERNAME").unwrap_or_default(),
        })
    })
    .await
    .unwrap_or_else(|_| Err("The audit could not start.".into()))
}

/// Ends the audit: the elevated host, if there is one, exits when its pipes
/// close.
#[tauri::command]
pub async fn audit_end() {
    let _ = tauri::async_runtime::spawn_blocking(|| {
        cancel_now();
        stop_broker();
    })
    .await;
}

fn stop_broker() {
    broker().lock().unwrap().take();
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnLine {
    run: String,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnEnd {
    run: String,
    code: i32,
    error: String,
}

/// Runs one turn of the agent and streams it back.
///
/// Returns as soon as the turn is running: every line of the CLI's stream
/// arrives on `audit:line` and the turn finishes with `audit:end`. `run` is the
/// front end's token for the turn, so a line from a cancelled turn cannot land
/// in the next one.
#[tauri::command]
pub async fn audit_turn(
    app: AppHandle,
    run: String,
    agent: String,
    prompt: String,
    dir: String,
    session: Option<String>,
    first: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = audit_dir(&dir)?.to_string_lossy().into_owned();
        let mut session = session;
        // Cursor names a conversation before it has one; everyone else names
        // it in the stream of the first turn.
        if agent == "cursor" && session.is_none() {
            let id = crate::cursor::create_chat(&dir)?;
            let _ = app.emit(
                "audit:line",
                TurnLine { run: run.clone(), line: serde_json::json!({ "session_id": id }).to_string() },
            );
            session = Some(id);
        }
        let line = turn_line(&agent, session.as_deref(), first)?;
        let elevated = broker().lock().unwrap().is_some();
        if elevated {
            run_elevated(app, run, line, prompt, dir)
        } else {
            run_direct(app, run, line, prompt, dir)
        }
    })
    .await
    .unwrap_or_else(|_| Err("The agent could not be started.".into()))
}

/// Saves the report or the log into the audit's folder and returns its path.
#[tauri::command]
pub async fn audit_save(dir: String, name: String, text: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_token(&name) {
            return Err("That file name is not valid.".into());
        }
        let path = audit_dir(&dir)?.join(name);
        std::fs::write(&path, text).map_err(|e| format!("Could not save: {e}"))?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .unwrap_or_else(|_| Err("Could not save.".into()))
}

/// Past audits, newest first: the `summary.json` each run keeps beside its
/// full `run.json`, with the folder it came from. Only summaries are read, so
/// listing stays quick however long the logs get.
#[tauri::command]
pub async fn audit_history() -> Vec<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(|| {
        let Ok(entries) = std::fs::read_dir(audits_root()) else {
            return Vec::new();
        };
        let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        dirs.reverse();
        dirs.into_iter()
            .take(200)
            .filter_map(|dir| {
                let text = std::fs::read_to_string(dir.join("summary.json")).ok()?;
                let mut value: serde_json::Value = serde_json::from_str(&text).ok()?;
                value.as_object_mut()?.insert("dir".into(), dir.to_string_lossy().into_owned().into());
                Some(value)
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// One past audit in full.
#[tauri::command]
pub async fn audit_load(dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read_to_string(audit_dir(&dir)?.join("run.json"))
            .map_err(|e| format!("Could not read that audit: {e}"))
    })
    .await
    .unwrap_or_else(|_| Err("Could not read that audit.".into()))
}

/// Deletes a past audit: its run, its report and its log.
#[tauri::command]
pub async fn audit_delete(dir: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::remove_dir_all(audit_dir(&dir)?).map_err(|e| format!("Could not delete that audit: {e}"))
    })
    .await
    .unwrap_or_else(|_| Err("Could not delete that audit.".into()))
}

#[tauri::command]
pub async fn audit_cancel() {
    let _ = tauri::async_runtime::spawn_blocking(cancel_now).await;
}

fn cancel_now() {
    if let Some(child) = direct().lock().unwrap().as_mut() {
        // `cmd.exe` is the child; the agent is its child. The tree has to go.
        let _ = Command::new("taskkill.exe")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let _ = child.kill();
    }
    if let Some(broker) = broker().lock().unwrap().as_mut() {
        let _ = broker.requests.write_all(b"cancel\n");
    }
}

fn run_direct(app: AppHandle, run: String, line: String, prompt: String, dir: String) -> Result<(), String> {
    cancel_now();
    let mut child = Command::new("cmd.exe")
        .raw_arg(format!("/d /s /c \"{line}\""))
        .current_dir(&dir)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start the agent: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes());
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *direct().lock().unwrap() = Some(child);

    std::thread::spawn(move || {
        let errors = std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut stderr) = stderr {
                let _ = stderr.read_to_string(&mut text);
            }
            text
        });
        if let Some(stdout) = stdout {
            // Lossy: one badly encoded byte in a path must not end the stream.
            let mut reader = BufReader::new(stdout);
            let mut bytes = Vec::new();
            while reader.read_until(b'\n', &mut bytes).is_ok_and(|n| n > 0) {
                let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
                bytes.clear();
                if !line.trim().is_empty() {
                    let _ = app.emit("audit:line", TurnLine { run: run.clone(), line });
                }
            }
        }
        let code = direct()
            .lock()
            .unwrap()
            .take()
            .and_then(|mut child| child.wait().ok())
            .and_then(|status| status.code())
            .unwrap_or(-1);
        let error = errors.join().unwrap_or_default();
        let _ = app.emit("audit:end", TurnEnd { run, code, error });
    });
    Ok(())
}

fn run_elevated(app: AppHandle, run: String, line: String, prompt: String, dir: String) -> Result<(), String> {
    let (mut replies, mut requests) = {
        let mut guard = broker().lock().unwrap();
        let broker = guard.as_mut().ok_or("The administrator session has ended.")?;
        let replies = broker
            .replies
            .take()
            .ok_or("The agent is still answering the last step.")?;
        let requests = broker.requests.try_clone().map_err(|e| e.to_string())?;
        (replies, requests)
    };
    let request = serde_json::json!({
        "args": format!("/d /s /c \"{line}\""),
        "cwd": dir,
        "stdin": prompt,
    })
    .to_string();
    let sent = requests
        .write_all(format!("{}\n", crate::workspace::base64(request.as_bytes())).as_bytes())
        .and_then(|_| requests.flush());
    if let Err(e) = sent {
        stop_broker();
        return Err(format!("The administrator session has ended: {e}"));
    }

    std::thread::spawn(move || {
        let decode = |text: &str| {
            crate::workspace::unbase64(text)
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .unwrap_or_default()
        };
        let mut ended = None;
        {
            let mut reader = BufReader::new(&mut replies);
            let mut raw = String::new();
            loop {
                raw.clear();
                match reader.read_line(&mut raw) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let text = raw.trim_end();
                if let Some(body) = text.strip_prefix("L ") {
                    let line = decode(body);
                    if !line.trim().is_empty() {
                        let _ = app.emit("audit:line", TurnLine { run: run.clone(), line });
                    }
                } else if let Some(rest) = text.strip_prefix("E ") {
                    let (code, error) = rest.split_once(' ').unwrap_or((rest, ""));
                    ended = Some((code.parse().unwrap_or(-1), decode(error)));
                    break;
                }
            }
        }
        match ended {
            Some((code, error)) => {
                if let Some(broker) = broker().lock().unwrap().as_mut() {
                    broker.replies = Some(replies);
                }
                let _ = app.emit("audit:end", TurnEnd { run, code, error });
            }
            None => {
                stop_broker();
                let _ = app.emit(
                    "audit:end",
                    TurnEnd { run, code: -1, error: "The administrator session closed unexpectedly.".into() },
                );
            }
        }
    });
    Ok(())
}

/* --------------------------------------------------- the elevated host */

/// Runs in the elevated PowerShell. Reads one request per line, runs the turn
/// with its stdout streamed back line by line, and watches for `cancel` while
/// the turn runs. When WinT's end of the pipe closes, it kills whatever is
/// running and exits - it must never outlive the audit.
const HOST_PS: &str = r#"
$ErrorActionPreference = 'Stop'
$enc = New-Object System.Text.UTF8Encoding($false)
$inPipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', '__REQ__', [System.IO.Pipes.PipeDirection]::In)
$inPipe.Connect(60000)
$outPipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', '__REP__', [System.IO.Pipes.PipeDirection]::Out)
$outPipe.Connect(60000)
$reader = New-Object System.IO.StreamReader($inPipe, $enc)
$writer = New-Object System.IO.StreamWriter($outPipe, $enc)
$writer.AutoFlush = $true
function B64([string]$s) { [Convert]::ToBase64String($enc.GetBytes($s)) }
$pending = $null
while ($true) {
  if ($null -eq $pending) { $pending = $reader.ReadLineAsync() }
  $line = $pending.Result
  $pending = $null
  if ($null -eq $line) { break }
  if ($line -eq 'cancel' -or $line -eq '') { continue }
  $req = $enc.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
  $psi = New-Object System.Diagnostics.ProcessStartInfo('cmd.exe', [string]$req.args)
  $psi.WorkingDirectory = [string]$req.cwd
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $enc
  $psi.StandardErrorEncoding = $enc
  try { $p = [System.Diagnostics.Process]::Start($psi) } catch {
    $writer.WriteLine('E -1 ' + (B64 ("Could not start the agent: " + $_)))
    continue
  }
  $bytes = $enc.GetBytes([string]$req.stdin)
  $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  $p.StandardInput.Close()
  $errTask = $p.StandardError.ReadToEndAsync()
  $closed = $false
  while ($true) {
    $next = $p.StandardOutput.ReadLineAsync()
    while (-not $next.Wait(200)) {
      if ($null -eq $pending) { $pending = $reader.ReadLineAsync() }
      if ($pending.IsCompleted) {
        $cmd = $pending.Result
        $pending = $null
        if ($null -eq $cmd) { $closed = $true }
        if ($closed -or $cmd -eq 'cancel') { & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null }
      }
    }
    if ($null -eq $next.Result) { break }
    $writer.WriteLine('L ' + (B64 $next.Result))
  }
  $p.WaitForExit()
  $writer.WriteLine('E ' + $p.ExitCode + ' ' + (B64 $errTask.Result))
  if ($closed) { break }
}
"#;

fn pipe_name(dir: &Path, which: &str) -> String {
    let leaf = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    format!("wint-audit-{}-{leaf}-{which}", std::process::id())
}

fn start_broker(dir: &Path) -> Result<Broker, String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_TYPE_BYTE, PIPE_WAIT,
    };
    use windows::Win32::System::Threading::{GetProcessId, WaitForSingleObject};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
    use std::os::windows::io::FromRawHandle;

    let req_name = pipe_name(dir, "req");
    let rep_name = pipe_name(dir, "rep");
    let create = |name: &str, access| -> Result<HANDLE, String> {
        let full = HSTRING::from(format!(r"\\.\pipe\{name}"));
        let handle = unsafe {
            CreateNamedPipeW(
                &full,
                access | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                64 * 1024,
                64 * 1024,
                0,
                None,
            )
        };
        if handle.is_invalid() {
            Err("Could not open a channel to the administrator session.".into())
        } else {
            Ok(handle)
        }
    };
    // WinT writes requests (outbound here, `In` for the host) and reads replies.
    let req = create(&req_name, PIPE_ACCESS_OUTBOUND)?;
    let rep = match create(&rep_name, PIPE_ACCESS_INBOUND) {
        Ok(h) => h,
        Err(e) => {
            unsafe { let _ = CloseHandle(req); }
            return Err(e);
        }
    };
    let close_both = || unsafe {
        let _ = CloseHandle(req);
        let _ = CloseHandle(rep);
    };

    let script = HOST_PS.replace("__REQ__", &req_name).replace("__REP__", &rep_name);
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let params = HSTRING::from(format!(
        "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand {}",
        crate::workspace::base64(&utf16)
    ));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: w!("runas"),
        lpFile: w!("powershell.exe"),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if ShellExecuteExW(&mut info).is_err() || info.hProcess.is_invalid() {
            close_both();
            return Err("The administrator prompt was declined, so the audit did not start.".into());
        }
    }
    let process = info.hProcess;
    let expected = unsafe { GetProcessId(process) };

    // If the host dies before it connects, nothing would ever unblock
    // `ConnectNamedPipe`. The watchdog connects to both pipes itself in that
    // case; the process id check below then refuses the connection.
    let connected = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let watch = {
        let connected = connected.clone();
        let raw = process.0 as isize;
        let (req_name, rep_name) = (req_name.clone(), rep_name.clone());
        std::thread::spawn(move || {
            let process = HANDLE(raw as *mut _);
            for _ in 0..120 {
                if connected.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                // WAIT_OBJECT_0: the host exited without connecting.
                if unsafe { WaitForSingleObject(process, 500) }.0 == 0 {
                    break;
                }
            }
            if !connected.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = std::fs::OpenOptions::new().read(true).open(format!(r"\\.\pipe\{req_name}"));
                let _ = std::fs::OpenOptions::new().write(true).open(format!(r"\\.\pipe\{rep_name}"));
            }
        })
    };

    let accept = |pipe: HANDLE| -> bool {
        unsafe {
            // ERROR_PIPE_CONNECTED means the client beat us to it, which is fine.
            let ok = ConnectNamedPipe(pipe, None).is_ok()
                || windows::Win32::Foundation::GetLastError() == windows::Win32::Foundation::ERROR_PIPE_CONNECTED;
            let mut pid = 0u32;
            ok && GetNamedPipeClientProcessId(pipe, &mut pid).is_ok() && pid == expected && expected != 0
        }
    };
    let good = accept(req) && accept(rep);
    connected.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = watch.join();
    unsafe { let _ = CloseHandle(process); }
    if !good {
        close_both();
        return Err("The administrator session did not start.".into());
    }
    let requests = unsafe { File::from_raw_handle(req.0 as _) };
    let replies = unsafe { File::from_raw_handle(rep.0 as _) };
    Ok(Broker { requests, replies: Some(replies) })
}

