//! The three things Windows keeps in its own tray beside the network: the
//! volume, the battery and the keyboard language.
//!
//! None of them can be read out of Explorer — the icons there are drawn by the
//! shell and by nobody else. So each one is read from the source Windows
//! itself reads: Core Audio for the volume, the power status for the battery,
//! and the loaded keyboard layouts for the language.
//!
//! Every call here is short, but they all run off the main thread anyway,
//! because Core Audio can block on the audio service while a device is being
//! switched underneath it.

use serde::Serialize;

use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::Globalization::{LOCALE_SISO639LANGNAME, LOCALE_SLOCALIZEDDISPLAYNAME};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL, STGM_READ};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    ActivateKeyboardLayout, GetKeyboardLayout, GetKeyboardLayoutList, HKL, KLF_SETFORPROCESS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, PostMessageW, WM_INPUTLANGCHANGEREQUEST,
};

use crate::com::Apartment;

// ---- the volume --------------------------------------------------------------------

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    /// The master level of the default playback device, 0-100.
    pub level: u32,
    pub muted: bool,
    /// Whether there is a playback device at all — with none, the tile says so
    /// rather than showing a silent zero.
    pub present: bool,
    /// What the device calls itself, for the line above the menu.
    pub device: String,
}

/// The default playback endpoint's own volume control, and its name.
fn endpoint() -> Result<(IAudioEndpointVolume, String), String> {
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|e| format!("Could not reach the audio service: {e}"))?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|_| "There is no playback device.".to_string())?;
        let name = device
            .OpenPropertyStore(STGM_READ)
            .ok()
            .and_then(|store| store.GetValue(&PKEY_Device_FriendlyName).ok())
            .map(|value| value.to_string())
            .unwrap_or_default();
        let control: IAudioEndpointVolume = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("Could not read the volume: {e}"))?;
        Ok((control, name))
    }
}

/// What the rail's volume tile shows.
pub fn volume() -> Volume {
    let _com = Apartment::multi_threaded();
    let Ok((control, device)) = endpoint() else {
        return Volume::default();
    };
    unsafe {
        let level = control.GetMasterVolumeLevelScalar().unwrap_or(0.0);
        Volume {
            level: (level * 100.0).round().clamp(0.0, 100.0) as u32,
            muted: control.GetMute().map(|muted| muted.as_bool()).unwrap_or(false),
            present: true,
            device,
        }
    }
}

/// Move the master volume, as the tray's own slider does.
pub fn set_volume(level: u32) -> Result<(), String> {
    let _com = Apartment::multi_threaded();
    let (control, _) = endpoint()?;
    unsafe {
        control
            .SetMasterVolumeLevelScalar(level.min(100) as f32 / 100.0, std::ptr::null())
            .map_err(|e| format!("Could not change the volume: {e}"))
    }
}

/// Mute or unmute the default playback device.
pub fn set_muted(muted: bool) -> Result<(), String> {
    let _com = Apartment::multi_threaded();
    let (control, _) = endpoint()?;
    unsafe {
        control
            .SetMute(muted, std::ptr::null())
            .map_err(|e| format!("Could not change the mute state: {e}"))
    }
}

// ---- the battery -------------------------------------------------------------------

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Battery {
    /// False on a desktop, where the tile has nothing to say and is left out.
    pub present: bool,
    /// Charge left, 0-100.
    pub percent: u32,
    pub charging: bool,
    /// Whether the machine is on mains power at all.
    pub plugged: bool,
    pub saver: bool,
    /// Minutes of runtime Windows estimates, 0 while it does not know yet.
    pub minutes: u32,
}

/// What the rail's battery tile shows. `GetSystemPowerStatus` is the reading
/// Windows' own flyout is built from.
pub fn battery() -> Battery {
    // BATTERY_FLAG_NO_BATTERY, BATTERY_FLAG_CHARGING and the "unknown"
    // readings, spelled out rather than pulled in from another crate feature.
    const NO_BATTERY: u8 = 128;
    const CHARGING: u8 = 8;
    const UNKNOWN: u8 = 255;

    let mut status = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut status) }.is_err() {
        return Battery::default();
    }
    Battery {
        present: status.BatteryFlag & NO_BATTERY == 0 && status.BatteryLifePercent != UNKNOWN,
        percent: if status.BatteryLifePercent == UNKNOWN {
            0
        } else {
            status.BatteryLifePercent as u32
        },
        charging: status.BatteryFlag & CHARGING != 0,
        plugged: status.ACLineStatus == 1,
        // SYSTEM_STATUS_FLAG_POWER_SAVING_ON
        saver: status.SystemStatusFlag == 1,
        minutes: if status.BatteryLifeTime == u32::MAX {
            0
        } else {
            status.BatteryLifeTime / 60
        },
    }
}

// ---- the keyboard language ---------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    /// The layout handle as a decimal string, which is what switching to it
    /// needs handed back.
    pub id: String,
    /// The three letters the tray shows: ENG, DAN, DEU.
    pub tag: String,
    /// The language's own name for itself.
    pub name: String,
    /// Whether this is the layout the window in front is typing in.
    pub active: bool,
}

/// One locale string for the language half of a layout handle. The LCID form
/// is deprecated in favour of locale names, and is also the only one that
/// takes what an HKL carries.
#[allow(deprecated)]
fn locale_info(lcid: u32, what: u32) -> String {
    let mut buffer = [0u16; 128];
    let len = unsafe { windows::Win32::Globalization::GetLocaleInfoW(lcid, what, Some(&mut buffer)) };
    if len <= 1 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..len as usize - 1])
}

/// Every keyboard layout this session has loaded, with the one the window in
/// front is typing in marked.
pub fn layouts() -> Vec<Layout> {
    unsafe {
        let count = GetKeyboardLayoutList(None) as usize;
        if count == 0 {
            return Vec::new();
        }
        let mut handles = vec![HKL::default(); count];
        let read = GetKeyboardLayoutList(Some(&mut handles)) as usize;
        handles.truncate(read.min(count));

        // The layout belongs to whichever thread is typing, so the one that
        // counts is the foreground window's, not ours.
        let window = GetForegroundWindow();
        let thread = if window.0.is_null() {
            0
        } else {
            GetWindowThreadProcessId(window, None)
        };
        let current = GetKeyboardLayout(thread);

        handles
            .into_iter()
            .map(|hkl| {
                // The language is the low word of the layout handle.
                let lcid = (hkl.0 as usize as u32) & 0xFFFF;
                let tag = locale_info(lcid, LOCALE_SISO639LANGNAME);
                let name = locale_info(lcid, LOCALE_SLOCALIZEDDISPLAYNAME);
                Layout {
                    id: (hkl.0 as usize as u64).to_string(),
                    tag: if tag.is_empty() {
                        "?".into()
                    } else {
                        tag.to_uppercase()
                    },
                    name: if name.is_empty() {
                        format!("Layout {lcid:04X}")
                    } else {
                        name
                    },
                    active: hkl == current,
                }
            })
            .collect()
    }
}

/// Switch the window in front to a layout, the way Alt+Shift does.
///
/// A layout belongs to the thread that is typing, not to this process, so the
/// request is posted to the foreground window and Windows carries it from
/// there. This process is switched too, so the rail agrees with itself when
/// nothing else is in front.
pub fn set_layout(id: &str) -> Result<(), String> {
    let handle: u64 = id
        .parse()
        .map_err(|_| "That is not a keyboard layout.".to_string())?;
    let hkl = HKL(handle as usize as *mut std::ffi::c_void);
    unsafe {
        let window = GetForegroundWindow();
        if !window.0.is_null() {
            let _ = PostMessageW(
                Some(window),
                WM_INPUTLANGCHANGEREQUEST,
                WPARAM(0),
                LPARAM(handle as isize),
            );
        }
        let _ = ActivateKeyboardLayout(hkl, KLF_SETFORPROCESS);
    }
    Ok(())
}

// ---- Windows' own pages ------------------------------------------------------------

/// Hand a setting over to the page Windows keeps for it — an output device, a
/// power plan, a language to add. None of those belong in a rail.
pub fn open_settings(page: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    let uri = match page {
        "sound" => "ms-settings:sound",
        "power" => "ms-settings:powersleep",
        "battery" => "ms-settings:batterysaver",
        "language" => "ms-settings:keyboard",
        _ => return Err("There is no such settings page.".into()),
    };
    std::process::Command::new("explorer.exe")
        .arg(uri)
        .creation_flags(DETACHED_PROCESS)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open that settings page: {e}"))
}
