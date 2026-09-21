//! What the sidebar can identify each open app by.
//!
//! The rail keys a row — and a pin — on a window's AppUserModelID, and a
//! pinned app that is not running is started through that ID. An app that
//! offers none cannot be pinned, so this prints, for every window the taskbar
//! would show: its title, its exe, the ID the window itself declares, and the
//! ID of the package its process runs under. Most packaged apps (Notepad is
//! one) declare nothing on the window and are only reachable through the
//! second one.
//!
//!     cargo run --example appid_cli

#[cfg(windows)]
fn main() {
    use std::ffi::c_void;
    use windows::core::{BOOL, GUID, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HWND, LPARAM, PROPERTYKEY};
    use windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
    use windows::Win32::System::Com::{
        CoInitializeEx, CoTaskMemFree, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, GetClassNameW, GetWindowLongW, GetWindowTextLengthW,
        GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };

    const APP_ID: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0x9F4C2855_9F79_4B39_A8D0_E1D42DE1D5F3),
        pid: 5,
    };

    unsafe fn window_id(hwnd: HWND) -> Option<String> {
        let store: IPropertyStore = SHGetPropertyStoreForWindow(hwnd).ok()?;
        let value = store.GetValue(&APP_ID).ok()?;
        let text = PropVariantToStringAlloc(&value).ok()?;
        let id = text.to_string().ok();
        CoTaskMemFree(Some(text.0 as *const c_void));
        id.filter(|id| !id.is_empty())
    }

    unsafe fn process_id(hwnd: HWND) -> Option<String> {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 512];
        let mut len = buffer.len() as u32;
        let status = GetApplicationUserModelId(process, &mut len, Some(PWSTR(buffer.as_mut_ptr())));
        let _ = CloseHandle(process);
        if status != ERROR_SUCCESS || len == 0 {
            return None;
        }
        let id = String::from_utf16_lossy(&buffer[..(len as usize).saturating_sub(1)]);
        (!id.is_empty()).then_some(id)
    }

    unsafe fn exe_of(hwnd: HWND) -> String {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buffer = [0u16; 1024];
        let mut len = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(process);
        if ok { String::from_utf16_lossy(&buffer[..len as usize]) } else { String::new() }
    }

    /// The same hop the rail makes: a UWP app's real window lives inside the
    /// frame window that ApplicationFrameHost owns.
    unsafe fn app_window(hwnd: HWND) -> HWND {
        unsafe extern "system" fn find(child: HWND, found: LPARAM) -> BOOL {
            let found = &mut *(found.0 as *mut (u32, isize));
            let mut class = [0u16; 64];
            let len = GetClassNameW(child, &mut class).max(0) as usize;
            let mut pid = 0u32;
            GetWindowThreadProcessId(child, Some(&mut pid));
            if String::from_utf16_lossy(&class[..len]) == "Windows.UI.Core.CoreWindow" && pid != found.0 {
                found.1 = child.0 as isize;
                return false.into();
            }
            true.into()
        }
        let mut frame_pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut frame_pid));
        let mut found = (frame_pid, 0isize);
        let _ = EnumChildWindows(Some(hwnd), Some(find), LPARAM(std::ptr::addr_of_mut!(found) as isize));
        if found.1 != 0 { HWND(found.1 as *mut c_void) } else { hwnd }
    }

    unsafe extern "system" fn collect(hwnd: HWND, found: LPARAM) -> BOOL {
        let found = &mut *(found.0 as *mut Vec<isize>);
        let tool = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0;
        if IsWindowVisible(hwnd).as_bool() && GetWindowTextLengthW(hwnd) > 0 && !tool {
            found.push(hwnd.0 as isize);
        }
        true.into()
    }

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let mut handles: Vec<isize> = Vec::new();
        let _ = EnumWindows(Some(collect), LPARAM(std::ptr::addr_of_mut!(handles) as isize));
        for raw in handles {
            let hwnd = HWND(raw as *mut c_void);
            let mut title = [0u16; 512];
            let len = GetWindowTextW(hwnd, &mut title).max(0) as usize;
            let title = String::from_utf16_lossy(&title[..len]);
            let inner = app_window(hwnd);
            let exe = exe_of(inner);
            let window = window_id(hwnd).or_else(|| window_id(inner));
            let package = process_id(inner).or_else(|| process_id(hwnd));
            println!("{title}");
            println!("  exe     {}", if exe.is_empty() { "<denied>" } else { &exe });
            println!("  window  {}", window.as_deref().unwrap_or("-"));
            println!("  package {}", package.as_deref().unwrap_or("-"));
            let pinnable = window.is_some()
                || package.is_some()
                || (!exe.is_empty() && !exe.to_ascii_lowercase().contains(r"\windowsapps\"));
            println!("  pinnable {}", if pinnable { "yes" } else { "no" });
        }
    }
}

#[cfg(not(windows))]
fn main() {
    println!("Windows only.");
}

