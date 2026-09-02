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
        .map(|root| root.join("DevHQ").join("bin"))
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
    let exe = dir.join("devhq.exe");
    let on_path = user_path()?.split(';').any(|entry| same_path(entry, &dir));
    let installed = exe.is_file();
    Ok(CliStatus {
        installed,
        on_path,
        path: exe.to_string_lossy().into_owned(),
        message: if installed && on_path {
            "Available as devhq in new terminals.".into()
        } else {
            "The DevHQ CLI is not registered.".into()
        },
    })
}

fn bundled_cli(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("devhq-cli.exe"));
        candidates.push(dir.join("resources").join("devhq-cli.exe"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("devhq-cli.exe"));
            if let Some(target) = dir.parent() {
                candidates.push(target.join("release").join("devhq-cli.exe"));
            }
        }
    }
    candidates.into_iter().find(|path| path.is_file()).ok_or_else(||
        "This build does not contain the CLI. Build it with `npm run cli:build`, then restart DevHQ.".into()
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
    command.env("DEVHQ_USER_PATH", &next).args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::SetEnvironmentVariable('Path',$env:DEVHQ_USER_PATH,'User')",
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
    std::fs::copy(&source, dir.join("devhq.exe"))
        .map_err(|e| format!("Could not install the CLI: {e}"))?;
    set_user_path(&dir, true)?;
    status()
}

pub fn uninstall() -> Result<CliStatus, String> {
    let dir = install_dir()?;
    set_user_path(&dir, false)?;
    let exe = dir.join("devhq.exe");
    if exe.exists() {
        std::fs::remove_file(&exe)
            .map_err(|e| format!("Could not remove {}: {e}", exe.display()))?;
    }
    status()
}
