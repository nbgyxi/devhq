//! "Start WinT with Windows".
//!
//! Two mechanisms, because a Store package cannot use the ordinary one: writes
//! a packaged app makes to `HKCU\Software` land in its private hive, so a Run
//! value would never be seen by Explorer. The package therefore declares a
//! `StartupTask` in its manifest (`packaging/msix/AppxManifest.template.xml`,
//! id `WinTStartup`) and toggles that; any other build writes the Run key with
//! `--autostart` behind the exe.
//!
//! Either way, a launch at sign-in goes straight to the notification area.

use serde::Serialize;

pub const ARG: &str = "--autostart";

#[derive(Serialize, Clone, Debug)]
pub struct Status {
    pub enabled: bool,
    /// False when Windows will not let WinT change it (turned off in Task
    /// Manager's Startup apps, or by policy); `note` says why.
    pub changeable: bool,
    pub note: Option<String>,
}

/// True when this process was started by Windows at sign-in.
pub fn launched_at_startup(args: &[String]) -> bool {
    if args.iter().any(|arg| arg == ARG) {
        return true;
    }
    #[cfg(windows)]
    if imp::is_packaged() {
        return imp::activated_by_startup_task();
    }
    false
}

#[cfg(windows)]
pub fn status() -> Result<Status, String> {
    if imp::is_packaged() {
        imp::task_status()
    } else {
        imp::run_key_status()
    }
}

#[cfg(windows)]
pub fn set(enabled: bool) -> Result<Status, String> {
    if imp::is_packaged() {
        imp::task_set(enabled)
    } else {
        imp::run_key_set(enabled)?;
        imp::run_key_status()
    }
}

#[cfg(not(windows))]
pub fn status() -> Result<Status, String> {
    Err("Starting with the system is only supported on Windows.".into())
}

#[cfg(not(windows))]
pub fn set(_enabled: bool) -> Result<Status, String> {
    status()
}

#[cfg(windows)]
mod imp {
    use super::{Status, ARG};
    use windows::core::{HSTRING, PCWSTR};
    use windows::ApplicationModel::Activation::ActivationKind;
    use windows::ApplicationModel::{AppInstance, StartupTask, StartupTaskState};
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS};
    use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
    use windows::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
    };

    const TASK_ID: &str = "WinTStartup";
    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const RUN_VALUE: &str = "WinT";

    pub fn is_packaged() -> bool {
        let mut len = 0u32;
        let result = unsafe { GetCurrentPackageFullName(&mut len, None) };
        // No package answers APPMODEL_ERROR_NO_PACKAGE; a package answers that
        // the (empty) buffer is too small for its name.
        result == ERROR_INSUFFICIENT_BUFFER || result == ERROR_SUCCESS
    }

    pub fn activated_by_startup_task() -> bool {
        AppInstance::GetActivatedEventArgs()
            .and_then(|args| args.Kind())
            .map(|kind| kind == ActivationKind::StartupTask)
            .unwrap_or(false)
    }

    fn task() -> Result<StartupTask, String> {
        StartupTask::GetAsync(&HSTRING::from(TASK_ID))
            .and_then(|op| op.get())
            .map_err(|e| format!("Could not reach WinT's startup task: {e}"))
    }

    fn task_state_status(state: StartupTaskState) -> Status {
        match state {
            StartupTaskState::Enabled => Status { enabled: true, changeable: true, note: None },
            StartupTaskState::EnabledByPolicy => Status {
                enabled: true,
                changeable: false,
                note: Some("Your organization starts WinT with Windows.".into()),
            },
            StartupTaskState::DisabledByUser => Status {
                enabled: false,
                changeable: false,
                note: Some("Turned off in Windows Settings > Apps > Startup. Switch WinT on there first.".into()),
            },
            StartupTaskState::DisabledByPolicy => Status {
                enabled: false,
                changeable: false,
                note: Some("Your organization does not allow WinT to start with Windows.".into()),
            },
            _ => Status { enabled: false, changeable: true, note: None },
        }
    }

    pub fn task_status() -> Result<Status, String> {
        let state = task()?.State().map_err(|e| e.to_string())?;
        Ok(task_state_status(state))
    }

    pub fn task_set(enabled: bool) -> Result<Status, String> {
        let task = task()?;
        if enabled {
            let state = task
                .RequestEnableAsync()
                .and_then(|op| op.get())
                .map_err(|e| format!("Could not turn on starting with Windows: {e}"))?;
            Ok(task_state_status(state))
        } else {
            task.Disable().map_err(|e| e.to_string())?;
            task_status()
        }
    }

    fn command_line() -> Result<String, String> {
        let exe = std::env::current_exe().map_err(|e| format!("Could not find WinT's exe: {e}"))?;
        Ok(format!("\"{}\" {ARG}", exe.display()))
    }

    fn read_run_value() -> Result<Option<String>, String> {
        let key = HSTRING::from(RUN_KEY);
        let name = HSTRING::from(RUN_VALUE);
        let mut buf = vec![0u16; 2048];
        let mut size = (buf.len() * 2) as u32;
        let result = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if result == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        result.ok().map_err(|e| format!("Could not read the startup entry: {e}"))?;
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Ok(Some(String::from_utf16_lossy(&buf[..len])))
    }

    pub fn run_key_status() -> Result<Status, String> {
        let expected = command_line()?;
        Ok(match read_run_value()? {
            None => Status { enabled: false, changeable: true, note: None },
            Some(value) if value.eq_ignore_ascii_case(&expected) => {
                Status { enabled: true, changeable: true, note: None }
            }
            // Another copy of WinT registered itself; switching on here
            // points the entry at this one instead.
            Some(value) => Status {
                enabled: false,
                changeable: true,
                note: Some(format!("Windows starts a different WinT: {value}")),
            },
        })
    }

    pub fn run_key_set(enabled: bool) -> Result<(), String> {
        let key = HSTRING::from(RUN_KEY);
        let name = HSTRING::from(RUN_VALUE);
        if enabled {
            let value = HSTRING::from(command_line()?);
            let bytes = (value.len() + 1) * 2;
            unsafe {
                RegSetKeyValueW(
                    HKEY_CURRENT_USER,
                    PCWSTR(key.as_ptr()),
                    PCWSTR(name.as_ptr()),
                    REG_SZ.0,
                    Some(value.as_ptr().cast()),
                    bytes as u32,
                )
            }
            .ok()
            .map_err(|e| format!("Could not add WinT to startup: {e}"))
        } else {
            let result = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()), PCWSTR(name.as_ptr())) };
            if result == ERROR_FILE_NOT_FOUND {
                return Ok(());
            }
            result.ok().map_err(|e| format!("Could not remove WinT from startup: {e}"))
        }
    }
}
