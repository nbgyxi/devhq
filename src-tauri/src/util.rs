use std::path::Path;
use std::process::Command;

/// Runs a command and returns stdout on success. Every spawn here goes through
/// this helper so the Windows console-window suppression is applied uniformly —
/// without it each `git` call flashes a black window over the UI.
pub fn run(program: &str, args: &[&str], cwd: Option<&Path>) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Same as [`run`], but keeps stdout even when the exit code is non-zero.
/// `netstat` and a few git subcommands report useful output alongside a
/// non-success status.
pub fn run_lossy(program: &str, args: &[&str], cwd: Option<&Path>) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Unix-epoch milliseconds for a file's mtime, or 0 when unavailable.
pub fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Lowercased path with separators normalised to `\`, so comparisons between a
/// project directory and a process command line survive mixed slash styles.
pub fn norm(s: &str) -> String {
    s.replace('/', "\\").to_lowercase()
}
