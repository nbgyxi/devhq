//! A ConPTY session built straight on kernel32 — pipes, a pseudoconsole, and a
//! child process attached to it. No terminal crate involved; `CreatePseudoConsole`
//! is the whole trick and the rest is the documented `STARTUPINFOEX` dance that
//! every ConPTY host performs.
//!
//! The console-window suppression `util::run` needs elsewhere is deliberately
//! absent here: the child really does have a console, it is just a headless one
//! that renders into our pipe instead of onto the desktop.

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, GetProcessId,
    InitializeProcThreadAttributeList, TerminateProcess, UpdateProcThreadAttribute,
    CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    STARTUPINFOW,
};

/// A raw handle we promise to move across threads ourselves. Win32 handles are
/// process-wide integers and are fine to use from any thread; the compiler has
/// no way to know that.
#[derive(Clone, Copy)]
pub struct SendHandle(pub HANDLE);
unsafe impl Send for SendHandle {}
unsafe impl Sync for SendHandle {}

pub struct ConPty {
    hpcon: HPCON,
    /// Our end of the child's stdin.
    input_write: HANDLE,
    /// Our end of the child's output, as rendered by the pseudoconsole.
    output_read: HANDLE,
    process: HANDLE,
    thread: HANDLE,
    closed: bool,
}

// Same promise as `SendHandle`: a session is only ever driven from one place at
// a time, guarded by the registry mutex in `term.rs`.
unsafe impl Send for ConPty {}
unsafe impl Sync for ConPty {}

fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

impl ConPty {
    /// Spawns `command` in `cwd`, attached to a fresh pseudoconsole.
    pub fn spawn(command: &str, cwd: &Path, cols: u16, rows: u16) -> Result<Self, String> {
        unsafe {
            // Two pipes: one carries our keystrokes in, the other carries the
            // pseudoconsole's rendered VT stream out.
            let mut in_read = HANDLE::default();
            let mut in_write = HANDLE::default();
            let mut out_read = HANDLE::default();
            let mut out_write = HANDLE::default();
            CreatePipe(&mut in_read, &mut in_write, None, 0)
                .map_err(|e| format!("CreatePipe (stdin) failed: {e}"))?;
            CreatePipe(&mut out_read, &mut out_write, None, 0)
                .map_err(|e| format!("CreatePipe (stdout) failed: {e}"))?;

            let size = COORD { X: cols.max(1) as i16, Y: rows.max(1) as i16 };
            let hpcon = CreatePseudoConsole(size, in_read, out_write, 0)
                .map_err(|e| format!("CreatePseudoConsole failed: {e}"))?;

            // The pseudoconsole duplicated both ends it was handed. Ours would
            // otherwise hold the pipes open past the child's exit and the
            // reader thread would never see EOF.
            let _ = CloseHandle(in_read);
            let _ = CloseHandle(out_write);

            // An attribute list sized for exactly one attribute. The first call
            // is expected to fail with ERROR_INSUFFICIENT_BUFFER purely to
            // report the size, so its error is discarded on purpose.
            let mut list_size: usize = 0;
            let _ = InitializeProcThreadAttributeList(None, 1, None, &mut list_size);
            let mut list_buf = vec![0u8; list_size];
            let attr_list = LPPROC_THREAD_ATTRIBUTE_LIST(list_buf.as_mut_ptr() as *mut c_void);
            InitializeProcThreadAttributeList(Some(attr_list), 1, None, &mut list_size)
                .map_err(|e| format!("InitializeProcThreadAttributeList failed: {e}"))?;

            // The handle goes in *as* the pointer value, which is what
            // PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE expects — not a pointer to it.
            UpdateProcThreadAttribute(
                attr_list,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                Some(hpcon.0 as *const c_void),
                std::mem::size_of::<HPCON>(),
                None,
                None,
            )
            .map_err(|e| format!("UpdateProcThreadAttribute failed: {e}"))?;

            // The std handles are pinned to null on purpose. Without
            // STARTF_USESTDHANDLES the child inherits the *parent's* stdio, and
            // a shell then writes its prompt there instead of into the
            // pseudoconsole — the console attaches correctly but nothing ever
            // reaches the pipe. Nulling them forces the child to fall back to
            // the console it is attached to, which is the pty.
            let si = STARTUPINFOEXW {
                StartupInfo: STARTUPINFOW {
                    cb: std::mem::size_of::<STARTUPINFOEXW>() as u32,
                    dwFlags: STARTF_USESTDHANDLES,
                    hStdInput: HANDLE::default(),
                    hStdOutput: HANDLE::default(),
                    hStdError: HANDLE::default(),
                    ..Default::default()
                },
                lpAttributeList: attr_list,
            };
            let mut pi = PROCESS_INFORMATION::default();
            let mut cmd = wide(command);
            let dir = wide(&cwd.to_string_lossy());

            let spawned = CreateProcessW(
                PCWSTR::null(),
                Some(PWSTR(cmd.as_mut_ptr())),
                None,
                None,
                false,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                None,
                PCWSTR(dir.as_ptr()),
                &si.StartupInfo,
                &mut pi,
            );
            DeleteProcThreadAttributeList(si.lpAttributeList);

            if let Err(e) = spawned {
                ClosePseudoConsole(hpcon);
                let _ = CloseHandle(in_write);
                let _ = CloseHandle(out_read);
                return Err(format!("Could not start {command}: {e}"));
            }

            Ok(ConPty {
                hpcon,
                input_write: in_write,
                output_read: out_read,
                process: pi.hProcess,
                thread: pi.hThread,
                closed: false,
            })
        }
    }

    /// The read end of the VT stream, for the reader thread.
    pub fn output(&self) -> SendHandle {
        SendHandle(self.output_read)
    }

    pub fn pid(&self) -> u32 {
        unsafe { GetProcessId(self.process) }
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        unsafe {
            let mut written = 0u32;
            WriteFile(self.input_write, Some(data), Some(&mut written), None)
                .map_err(|e| format!("WriteFile failed: {e}"))
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        unsafe {
            let size = COORD { X: cols.max(1) as i16, Y: rows.max(1) as i16 };
            ResizePseudoConsole(self.hpcon, size)
                .map_err(|e| format!("ResizePseudoConsole failed: {e}"))
        }
    }

    /// True once the child has exited, so the session can be reaped.
    pub fn exited(&self) -> bool {
        const STILL_ACTIVE: u32 = 259;
        unsafe {
            let mut code = 0u32;
            match GetExitCodeProcess(self.process, &mut code) {
                Ok(()) => code != STILL_ACTIVE,
                Err(_) => true,
            }
        }
    }

    /// Kills the child and tears the pseudoconsole down. The order matters:
    /// `ClosePseudoConsole` drops the console's copy of the output pipe, and
    /// that is what unblocks a reader thread parked in `ReadFile`.
    pub fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        unsafe {
            let _ = TerminateProcess(self.process, 0);
            ClosePseudoConsole(self.hpcon);
            let _ = CloseHandle(self.input_write);
            let _ = CloseHandle(self.output_read);
            let _ = CloseHandle(self.process);
            let _ = CloseHandle(self.thread);
        }
    }
}

impl Drop for ConPty {
    fn drop(&mut self) {
        self.close();
    }
}

/// Blocking read of the next chunk of the VT stream. `None` means EOF, which is
/// how the reader thread learns the session is over.
pub fn read_chunk(handle: SendHandle, buf: &mut [u8]) -> Option<usize> {
    unsafe {
        let mut read = 0u32;
        match ReadFile(handle.0, Some(buf), Some(&mut read), None) {
            Ok(()) if read > 0 => Some(read as usize),
            _ => None,
        }
    }
}
