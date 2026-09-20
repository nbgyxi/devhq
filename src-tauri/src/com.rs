//! Entering a COM apartment without taking someone else's away.
//!
//! Every heavy call in this app runs on a `spawn_blocking` thread, and those
//! threads are pooled: the one reading a file icon now is the one that read the
//! window list a moment ago, and will be the one resolving a shortcut next.
//! That makes COM initialisation shared state.
//!
//! `CoInitializeEx` on a thread that is already in an apartment returns
//! `RPC_E_CHANGED_MODE` and does nothing — it does **not** add a reference. So
//! a caller that initialises, ignores that error, and then calls
//! `CoUninitialize` anyway is not undoing its own call: it is decrementing
//! somebody else's count. Do that often enough and COM is torn down on a
//! thread while other code still holds interface pointers, and the next call
//! through one of them takes the process down with it.
//!
//! The rule is therefore: uninitialise only if you initialised. This guard is
//! the only place that decision is made.

#[cfg(windows)]
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT, COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED,
};

/// A thread's COM apartment, left exactly as it was found.
pub struct Apartment {
    /// Whether this guard is the one that entered, and so the one that leaves.
    entered: bool,
}

impl Apartment {
    #[cfg(windows)]
    fn enter(model: COINIT) -> Self {
        // Success means this call took a reference on the apartment and owes
        // a matching release — including `S_FALSE`, which says the thread was
        // already in this apartment and counts all the same. The one failure
        // that matters, `RPC_E_CHANGED_MODE`, took nothing: the thread is in
        // the other kind of apartment and stays there.
        let entered = unsafe { CoInitializeEx(None, model) }.is_ok();
        Self { entered }
    }

    /// The apartment for the shell's own calls: single-threaded, which is what
    /// shell extensions expect.
    #[cfg(windows)]
    pub fn single_threaded() -> Self {
        Self::enter(COINIT_APARTMENTTHREADED)
    }

    /// The apartment for plain in-process objects with no message loop.
    #[cfg(windows)]
    pub fn multi_threaded() -> Self {
        Self::enter(COINIT_MULTITHREADED)
    }

    #[cfg(not(windows))]
    pub fn single_threaded() -> Self {
        Self { entered: false }
    }

    #[cfg(not(windows))]
    pub fn multi_threaded() -> Self {
        Self { entered: false }
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        #[cfg(windows)]
        if self.entered {
            unsafe { CoUninitialize() };
        }
    }
}
