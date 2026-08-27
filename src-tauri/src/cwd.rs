//! Reading another process's current working directory on Windows.
//!
//! This matters because the command line is not enough to tell which project a
//! dev server belongs to: `npm run dev` and `node server.js` both appear with
//! relative paths, and the only thing tying them to a folder is their cwd.
//! Windows exposes no API for that, so the value is read out of the target
//! process's PEB — the same route Process Explorer takes.

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_BASIC_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    // Field offsets in the 64-bit structures. These are stable across every
    // supported Windows release; a wrong read simply fails the bounds checks
    // below and yields `None`.
    const PEB_PROCESS_PARAMETERS: usize = 0x20;
    /// `RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath`, a UNICODE_STRING.
    const PARAMS_CURDIR: usize = 0x38;
    const UNICODE_STRING_BUFFER: usize = 0x08;
    /// Windows paths stay far below this; anything larger means a bad read.
    const MAX_PATH_BYTES: u16 = 8192;

    pub fn of(pid: u32) -> Option<String> {
        unsafe {
            let handle: HANDLE = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
                false,
                pid,
            )
            .ok()?;
            let result = read_cwd(handle);
            let _ = CloseHandle(handle);
            result
        }
    }

    unsafe fn read_cwd(handle: HANDLE) -> Option<String> {
        let mut pbi = PROCESS_BASIC_INFORMATION::default();
        let mut returned = 0u32;
        let status = NtQueryInformationProcess(
            handle,
            ProcessBasicInformation,
            &mut pbi as *mut _ as *mut c_void,
            std::mem::size_of::<PROCESS_BASIC_INFORMATION>() as u32,
            &mut returned,
        );
        if status.is_err() || pbi.PebBaseAddress.is_null() {
            return None;
        }

        let peb = pbi.PebBaseAddress as usize;
        let params: usize = read_value(handle, peb + PEB_PROCESS_PARAMETERS)?;
        if params == 0 {
            return None;
        }

        // UNICODE_STRING: Length (u16), MaximumLength (u16), padding, Buffer.
        let length: u16 = read_value(handle, params + PARAMS_CURDIR)?;
        let buffer: usize = read_value(handle, params + PARAMS_CURDIR + UNICODE_STRING_BUFFER)?;
        if length == 0 || length > MAX_PATH_BYTES || buffer == 0 {
            return None;
        }

        let mut bytes = vec![0u8; length as usize];
        ReadProcessMemory(
            handle,
            buffer as *const c_void,
            bytes.as_mut_ptr() as *mut c_void,
            bytes.len(),
            None,
        )
        .ok()?;

        let wide: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        Some(String::from_utf16_lossy(&wide))
    }

    unsafe fn read_value<T: Copy + Default>(handle: HANDLE, address: usize) -> Option<T> {
        let mut value = T::default();
        ReadProcessMemory(
            handle,
            address as *const c_void,
            &mut value as *mut T as *mut c_void,
            std::mem::size_of::<T>(),
            None,
        )
        .ok()?;
        Some(value)
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn of(_pid: u32) -> Option<String> {
        None
    }
}

/// The process's current directory, or `None` when it cannot be read — a
/// protected or elevated process, or one that exited mid-scan.
pub fn of(pid: u32) -> Option<String> {
    imp::of(pid)
}
