//! WinT's terminal engine, with nothing drawing it.
//!
//! A session - pseudoconsole, child process and screen - lives here, keyed by
//! id. Whatever shows it is only ever a view: WinT's dock and its popped-out
//! windows, through the Tauri commands in `term.rs`, and the VS Code panel,
//! through `wint-term-host.exe`. Both hand [`session::open`] a sink and are told
//! what changed through it.

#![cfg(windows)]

pub mod command_history;
pub mod conpty;
pub mod history;
mod scan;
pub mod session;
pub mod shell;
pub mod vt;
