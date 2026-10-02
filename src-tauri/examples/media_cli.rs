//! What the sidebar's player has to go on when it looks for the window that is
//! playing: every media session Windows publishes, and every browser window
//! with its AppUserModelID and the names of its tabs.
//!
//!     cargo run --example media_cli
//!
//! Read-only. It focuses nothing and starts nothing.

#[cfg(windows)]
fn main() {
    use windows::core::{BOOL, Interface};
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager as Manager;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, TreeScope_Descendants, UIA_ControlTypePropertyId,
        UIA_TabItemControlTypeId,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };

    unsafe { let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED); }

    println!("== media sessions");
    match Manager::RequestAsync().and_then(|op| op.join()) {
        Ok(manager) => {
            let current = manager
                .GetCurrentSession()
                .ok()
                .and_then(|s| s.SourceAppUserModelId().ok())
                .map(|id| id.to_string())
                .unwrap_or_default();
            println!("current: {current:?}");
            if let Ok(sessions) = manager.GetSessions() {
                for session in sessions {
                    let id = session.SourceAppUserModelId().map(|v| v.to_string()).unwrap_or_default();
                    let status = session
                        .GetPlaybackInfo()
                        .and_then(|info| info.PlaybackStatus())
                        .map(|s| format!("{s:?}"))
                        .unwrap_or_default();
                    let (title, artist) = session
                        .TryGetMediaPropertiesAsync()
                        .and_then(|op| op.join())
                        .map(|p| {
                            (
                                p.Title().map(|v| v.to_string()).unwrap_or_default(),
                                p.Artist().map(|v| v.to_string()).unwrap_or_default(),
                            )
                        })
                        .unwrap_or_default();
                    println!("  {id:?} [{status}] title={title:?} artist={artist:?}");
                }
            }
        }
        Err(error) => println!("no session manager: {error}"),
    }

    let mut windows: Vec<isize> = Vec::new();
    unsafe extern "system" fn collect(hwnd: HWND, param: LPARAM) -> BOOL {
        unsafe {
            if IsWindowVisible(hwnd).as_bool() {
                (*(param.0 as *mut Vec<isize>)).push(hwnd.0 as isize);
            }
        }
        true.into()
    }
    unsafe { let _ = EnumWindows(Some(collect), LPARAM(&mut windows as *mut _ as isize)); }

    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.expect("UI Automation");
    let is_tab = unsafe {
        automation.CreatePropertyCondition(
            UIA_ControlTypePropertyId,
            &VARIANT::from(UIA_TabItemControlTypeId.0),
        )
    }
    .expect("tab condition");

    // PKEY_AppUserModel_ID
    let key = windows::Win32::Foundation::PROPERTYKEY {
        fmtid: windows::core::GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 5,
    };

    println!("== browser windows");
    for raw in windows {
        let hwnd = HWND(raw as *mut std::ffi::c_void);
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)); }
        let exe = process_name(pid);
        if !matches!(exe.as_str(), "msedge.exe" | "chrome.exe" | "brave.exe" | "firefox.exe") {
            continue;
        }
        let mut buf = vec![0u16; 512];
        let len = unsafe { GetWindowTextW(hwnd, &mut buf) } as usize;
        let title = String::from_utf16_lossy(&buf[..len]);
        if title.is_empty() {
            continue;
        }
        let aumid = unsafe { SHGetPropertyStoreForWindow::<IPropertyStore>(hwnd) }
            .ok()
            .and_then(|store| unsafe { store.GetValue(&key) }.ok())
            .map(|value| value.to_string())
            .unwrap_or_default();
        println!("  {raw} pid={pid} {exe} aumid={aumid:?} title={title:?}");
        let started = std::time::Instant::now();
        if let Ok(element) = unsafe { automation.ElementFromHandle(hwnd) } {
            if let Ok(tabs) = unsafe { element.FindAll(TreeScope_Descendants, &is_tab) } {
                let count = unsafe { tabs.Length() }.unwrap_or(0);
                for index in 0..count {
                    if let Ok(tab) = unsafe { tabs.GetElement(index) } {
                        let name = unsafe { tab.CurrentName() }.map(|n| n.to_string()).unwrap_or_default();
                        println!("      tab: {name:?}");
                    }
                }
            }
        }
        println!("      ({} ms)", started.elapsed().as_millis());
        let _ = Interface::as_raw(&automation);
    }
}

#[cfg(windows)]
fn process_name(pid: u32) -> String {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit('\\').next().unwrap_or("").to_ascii_lowercase()
    }
}

#[cfg(not(windows))]
fn main() {}
