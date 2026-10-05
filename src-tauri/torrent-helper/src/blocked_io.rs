//! Disk work that may never come back, and the means to make it come back.
//!
//! A read from a drive that has stopped answering does not fail, it waits -
//! inside the driver, where nothing in this process can interrupt it. Giving up
//! on such a thread is not enough: a process with a thread still blocked in the
//! kernel cannot be torn down, so the engine outlived WinT, outlived
//! `Stop-Process -Force`, and sat in the process table holding its exe open
//! until the next restart.
//!
//! Windows does offer one way in. `CancelSynchronousIo` aborts the I/O another
//! thread is blocked on, and the call it was in returns "operation aborted"
//! like any other failure. So every thread that touches a drive which might be
//! the failing one says so here, for as long as it is doing it; the move's
//! stall watcher cancels the one it writes off, and shutdown cancels all of
//! them before leaving.
//!
//! Not every wait is cancellable - a driver decides that - so this makes the
//! hang rarer, not impossible.

use std::sync::{Arc, Mutex};

struct Entry {
    /// A handle to the thread, with just the right `CancelSynchronousIo`
    /// needs. Kept as an integer because the crate's handle type is not `Send`.
    #[cfg(windows)]
    thread: isize,
}

#[cfg(windows)]
impl Drop for Entry {
    fn drop(&mut self) {
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        if self.thread != 0 {
            unsafe {
                let _ = CloseHandle(HANDLE(self.thread as *mut _));
            }
        }
    }
}

impl Entry {
    fn current() -> Self {
        #[cfg(windows)]
        {
            use windows::Win32::System::Threading::{GetCurrentThreadId, OpenThread, THREAD_TERMINATE};
            // `GetCurrentThread` is a pseudo-handle that means "the caller" to
            // whoever uses it, so a real one is opened for other threads to
            // cancel through. THREAD_TERMINATE is the right the call asks for.
            let thread = unsafe { OpenThread(THREAD_TERMINATE, false, GetCurrentThreadId()) }
                .map(|handle| handle.0 as isize)
                .unwrap_or(0);
            Self { thread }
        }
        #[cfg(not(windows))]
        Self {}
    }

    fn cancel(&self) {
        #[cfg(windows)]
        if self.thread != 0 {
            use windows::Win32::{Foundation::HANDLE, System::IO::CancelSynchronousIo};
            // Fails with "not found" when the thread is between calls or in a
            // wait the driver will not cancel. Neither is worth reporting.
            unsafe {
                let _ = CancelSynchronousIo(HANDLE(self.thread as *mut _));
            }
        }
    }
}

fn registry() -> &'static Mutex<Vec<Arc<Entry>>> {
    static REGISTRY: std::sync::OnceLock<Mutex<Vec<Arc<Entry>>>> = std::sync::OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

/// The current thread is about to touch a drive that may not answer. Held for
/// as long as it does; dropping it takes the thread off the list.
pub struct DiskWork(Arc<Entry>);

pub fn begin() -> DiskWork {
    let entry = Arc::new(Entry::current());
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(entry.clone());
    DiskWork(entry)
}

impl DiskWork {
    /// Something another thread can keep, to cancel this one's I/O with.
    pub fn canceller(&self) -> Canceller {
        Canceller(self.0.clone())
    }
}

impl Drop for DiskWork {
    fn drop(&mut self) {
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|entry| !Arc::ptr_eq(entry, &self.0));
    }
}

pub struct Canceller(Arc<Entry>);

impl Canceller {
    /// Abort whatever the thread is blocked on right now. The handle stays
    /// valid however long ago the thread finished, so this is always safe.
    pub fn cancel(&self) {
        self.0.cancel();
    }
}

/// Abort the I/O of every thread still doing disk work. For the way out.
pub fn cancel_all() {
    let entries: Vec<Arc<Entry>> = registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    for entry in entries {
        entry.cancel();
    }
}
