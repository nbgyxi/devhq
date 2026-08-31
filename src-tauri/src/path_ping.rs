//! A small streaming wrapper around Windows' built-in `pathping.exe`.
//! The command returns immediately; output is delivered as lines so the page
//! stays responsive during pathping's deliberately long sampling phase.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};

static TOKEN: AtomicU64 = AtomicU64::new(0);
static CHILD_PID: AtomicU32 = AtomicU32::new(0);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub target: String,
    pub queries: u16,
    pub max_hops: u8,
    pub resolve_names: bool,
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
    error: String,
}

pub fn start(app: AppHandle, options: Options) -> Result<u64, String> {
    let target = options.target.trim().to_string();
    if target.is_empty() || target.len() > 253 || target.chars().any(char::is_whitespace) {
        return Err("Enter one hostname or IP address.".into());
    }
    let queries = options.queries.clamp(1, 250);
    let hops = options.max_hops.clamp(1, 30);
    let token = TOKEN.fetch_add(1, Ordering::SeqCst) + 1;

    std::thread::spawn(move || {
        let mut command = Command::new("pathping.exe");
        command
            .arg("-q")
            .arg(queries.to_string())
            .arg("-h")
            .arg(hops.to_string())
            .arg("-p")
            .arg("100");
        if !options.resolve_names {
            command.arg("-n");
        }
        command
            .arg(&target)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }

        let result = (|| -> Result<(), String> {
            let mut child = command
                .spawn()
                .map_err(|e| format!("Could not start pathping: {e}"))?;
            CHILD_PID.store(child.id(), Ordering::SeqCst);
            let stdout = child
                .stdout
                .take()
                .ok_or("Pathping did not return output.")?;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if TOKEN.load(Ordering::SeqCst) != token {
                    let _ = child.kill();
                    return Err("Cancelled".into());
                }
                let _ = app.emit("path-ping:line", Line { token, text: line });
            }
            let status = child.wait().map_err(|e| e.to_string())?;
            CHILD_PID.store(0, Ordering::SeqCst);
            if status.success() {
                Ok(())
            } else {
                Err("Pathping could not complete the probe.".into())
            }
        })();
        let cancelled = matches!(&result, Err(error) if error == "Cancelled");
        let _ = app.emit(
            "path-ping:done",
            Done {
                token,
                ok: result.is_ok(),
                error: if cancelled {
                    String::new()
                } else {
                    result.err().unwrap_or_default()
                },
            },
        );
    });
    Ok(token)
}

pub fn cancel() {
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
        let _ = command.output();
    }
}
