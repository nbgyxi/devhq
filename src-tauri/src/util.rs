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

/// Starts VS Code on `path` - or, when `folder` is given, on that project,
/// with `path` revealed inside it. Without the folder, `code <file>` opens
/// the file in whichever window VS Code last had active, project or not;
/// `code <folder> -g <file>` instead reuses (or opens) the window already on
/// that project, the same way a plain `code <folder>` does for the folder
/// actions elsewhere in the app.
///
/// A well-known install location is tried first, with `code` on PATH as the
/// last resort: WinT is a long-running process, and a PATH inherited at
/// launch can predate a VS Code install done since, silently leaving
/// `cmd /c code` with nothing to run — `cmd` still exits 0 for "not
/// recognized", so the caller has no way to tell success from a no-op.
pub fn open_vscode(path: &str, folder: Option<&str>) -> bool {
    // A per-user install (the default the VS Code installer offers) lands
    // under `Programs` inside LOCALAPPDATA; a system install does not.
    let direct = [
        std::env::var("LOCALAPPDATA")
            .ok()
            .map(|dir| Path::new(&dir).join("Programs").join("Microsoft VS Code")),
        std::env::var("ProgramFiles")
            .ok()
            .map(|dir| Path::new(&dir).join("Microsoft VS Code")),
        std::env::var("ProgramFiles(x86)")
            .ok()
            .map(|dir| Path::new(&dir).join("Microsoft VS Code")),
    ]
    .into_iter()
    .flatten()
    .map(|dir| dir.join("Code.exe"))
    .find(|exe| exe.exists());
    let mut cmd = match direct {
        Some(exe) => Command::new(exe),
        None => {
            let mut c = Command::new("cmd");
            c.args(["/c", "code"]);
            c
        }
    };
    match folder {
        Some(folder) => cmd.args([folder, "-g", path]),
        None => cmd.arg(path),
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().is_ok()
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
