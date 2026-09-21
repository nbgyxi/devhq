//! What the sidebar's tray rail sees of WinT itself.
//!
//! Run it while WinT is in the notification area: it prints every top-level
//! window `wint.exe` owns, whether Windows still calls it visible, and what
//! the notification area has on record for the program. The rail only draws
//! a row for WinT when its main window is hidden, so this says which half of
//! that is missing.

#[cfg(windows)]
fn main() {
    use std::ffi::c_void;
    use windows::core::{BOOL, PWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowLongW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible, GWL_EXSTYLE, GWL_STYLE, WS_CAPTION, WS_EX_TOOLWINDOW,
    };

    unsafe extern "system" fn collect(hwnd: HWND, found: LPARAM) -> BOOL {
        let found = &mut *(found.0 as *mut Vec<isize>);
        found.push(hwnd.0 as isize);
        true.into()
    }

    let mut handles: Vec<isize> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(std::ptr::addr_of_mut!(handles) as isize));
    }

    println!("-- every window wint.exe owns --");
    let mut any = false;
    let mut running: Vec<String> = Vec::new();
    let mut main_hidden = false;
    for raw in handles {
        let hwnd = HWND(raw as *mut c_void);
        unsafe {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                continue;
            };
            let mut buffer = [0u16; 512];
            let mut len = buffer.len() as u32;
            let exe = if QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_FORMAT(0),
                PWSTR(buffer.as_mut_ptr()),
                &mut len,
            )
            .is_ok()
            {
                String::from_utf16_lossy(&buffer[..len as usize])
            } else {
                String::new()
            };
            let _ = windows::Win32::Foundation::CloseHandle(process);
            if !exe.to_ascii_lowercase().ends_with("wint.exe") {
                continue;
            }
            any = true;
            if !running.contains(&exe) {
                running.push(exe.clone());
            }
            let mut text = [0u16; 256];
            let len = GetWindowTextW(hwnd, &mut text).max(0) as usize;
            let title = String::from_utf16_lossy(&text[..len]);
            let mut name = [0u16; 256];
            let len = GetClassNameW(hwnd, &mut name).max(0) as usize;
            let class = String::from_utf16_lossy(&name[..len]);
            let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            println!(
                "  {raw:#x} visible={} caption={} toolwindow={} pid={pid} title={title:?} class={class:?}",
                IsWindowVisible(hwnd).as_bool(),
                style & WS_CAPTION.0 != 0,
                ex & WS_EX_TOOLWINDOW.0 != 0,
            );
            // The main window, as the rail identifies it: WinT's own title,
            // and no tool-window style.
            if title == "WinT" && ex & WS_EX_TOOLWINDOW.0 == 0 && !IsWindowVisible(hwnd).as_bool() {
                main_hidden = true;
            }
        }
    }
    if !any {
        println!("  (none — is WinT running?)");
    }

    println!("-- which build is running --");
    for exe in &running {
        println!("  {exe}");
    }
    println!("-- the verdict --");
    println!(
        "  main window hidden: {main_hidden} — so the rail {} draw a WinT row",
        if main_hidden { "should" } else { "should not" }
    );
    println!("  (run this again while WinT is in the notification area if it says not)");

    println!("-- what the notification area has on record for wint --");
    let mut found = false;
    for icon in wint_lib::tray::icons() {
        if icon.exe.to_ascii_lowercase().contains("wint") {
            found = true;
            println!("  promoted={} exe={} tooltip={:?}", icon.promoted, icon.exe, icon.tooltip);
        }
    }
    if !found {
        println!("  (no record — the rail falls back to treating it as promoted)");
    }

    println!("-- what this process calls itself --");
    println!("  current_exe={:?}", std::env::current_exe());
}

#[cfg(not(windows))]
fn main() {
    println!("Windows only.");
}
