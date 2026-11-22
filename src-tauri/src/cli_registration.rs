use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub installed: bool,
    pub on_path: bool,
    pub path: String,
    pub message: String,
}

fn install_dir() -> Result<PathBuf, String> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|root| root.join("WinT").join("bin"))
        .ok_or("Windows did not provide LOCALAPPDATA.".into())
}

fn user_path() -> Result<String, String> {
    let mut command = Command::new("powershell");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::GetEnvironmentVariable('Path','User')",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let out = command
        .output()
        .map_err(|e| format!("Could not read the user PATH: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn same_path(left: &str, right: &Path) -> bool {
    left.trim()
        .trim_end_matches(['\\', '/'])
        .eq_ignore_ascii_case(right.to_string_lossy().trim_end_matches(['\\', '/']))
}

pub fn status() -> Result<CliStatus, String> {
    let dir = install_dir()?;
    let exe = dir.join("wint.exe");
    let on_path = user_path()?.split(';').any(|entry| same_path(entry, &dir));
    let installed = exe.is_file();
    Ok(CliStatus {
        installed,
        on_path,
        path: exe.to_string_lossy().into_owned(),
        message: if installed && on_path {
            "Available as wint in new terminals.".into()
        } else {
            "The WinT CLI is not registered.".into()
        },
    })
}

pub(crate) fn bundled_cli(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("wint-cli.exe"));
        candidates.push(dir.join("resources").join("wint-cli.exe"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("wint-cli.exe"));
            if let Some(target) = dir.parent() {
                candidates.push(target.join("release").join("wint-cli.exe"));
            }
        }
    }
    candidates.into_iter().find(|path| path.is_file()).ok_or_else(||
        "This build does not contain the CLI. Build it with `npm run cli:build`, then restart WinT.".into()
    )
}

fn set_user_path(dir: &Path, add: bool) -> Result<(), String> {
    let current = user_path()?;
    let mut entries: Vec<String> = current
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty() && !same_path(entry, dir))
        .map(str::to_string)
        .collect();
    if add {
        entries.push(dir.to_string_lossy().into_owned());
    }
    let next = entries.join(";");
    let mut command = Command::new("powershell");
    command.env("WINT_USER_PATH", &next).args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::SetEnvironmentVariable('Path',$env:WINT_USER_PATH,'User')",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let out = command
        .output()
        .map_err(|e| format!("Could not update the user PATH: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

pub fn install(app: AppHandle) -> Result<CliStatus, String> {
    let source = bundled_cli(&app)?;
    let dir = install_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    replace(&source, &dir.join("wint.exe"))?;
    set_user_path(&dir, true)?;
    status()
}

/// Puts the CLI this build ships with over an older installed copy. True
/// when it had to.
///
/// The installed `wint.exe` is a copy, so it stays at whatever version was
/// current when somebody clicked Install. Claude Desktop starts that copy for
/// `wint mcp`, and a copy from before the command existed just exits - the
/// tools never appear and nothing says why.
pub fn refresh(app: &AppHandle) -> Result<bool, String> {
    let exe = install_dir()?.join("wint.exe");
    if !exe.is_file() {
        return Ok(false);
    }
    let source = bundled_cli(app)?;
    if same_contents(&source, &exe) {
        return Ok(false);
    }
    replace(&source, &exe)?;
    Ok(true)
}

fn same_contents(a: &Path, b: &Path) -> bool {
    let (Ok(ma), Ok(mb)) = (std::fs::metadata(a), std::fs::metadata(b)) else {
        return false;
    };
    ma.len() == mb.len() && std::fs::read(a).ok() == std::fs::read(b).ok()
}

/// Copies `source` over `target`, even while `target` is running. Windows
/// refuses to overwrite a running exe - and Claude Desktop keeps `wint mcp`
/// running - but it does allow renaming one, so the old copy is moved aside
/// and deleted once nothing has it open any more.
fn replace(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(dir) = target.parent() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with("wint.old-") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
    if std::fs::copy(source, target).is_ok() {
        return Ok(());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let aside = target.with_file_name(format!("wint.old-{stamp}.exe"));
    std::fs::rename(target, &aside)
        .and_then(|_| std::fs::copy(source, target).map(|_| ()))
        .map_err(|e| format!("Could not update the wint command: {e}"))?;
    let _ = std::fs::remove_file(&aside);
    Ok(())
}

pub fn uninstall() -> Result<CliStatus, String> {
    let dir = install_dir()?;
    set_user_path(&dir, false)?;
    let exe = dir.join("wint.exe");
    if exe.exists() {
        std::fs::remove_file(&exe)
            .map_err(|e| format!("Could not remove {}: {e}", exe.display()))?;
    }
    status()
}
