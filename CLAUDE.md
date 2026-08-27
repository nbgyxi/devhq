# DevHQ

A Tauri + Rust desktop app that scans a folder of development projects and
reports git status, running processes and detected tech at a glance.

- `src/` — the front end (plain JS, no framework, no build step).
- `src-tauri/src/` — the Rust backend and the `#[tauri::command]` surface.

## The window must never block

This is the rule the whole app is built around. **Every click reacts within one
frame.** Nothing that touches the disk, the network, `git`, the process table
or `CreateProcess` may run on the thread that draws the window.

- A synchronous `#[tauri::command]` runs on the **main thread** and freezes the
  window for as long as it takes. Any command doing real work must therefore be
  `async` and hand the work to `tauri::async_runtime::spawn_blocking` (see
  `off_thread` in `lib.rs`), or spawn its own thread and report back through
  events.
- Long work is **streamed, not awaited**: send what is known immediately, then
  emit results as they arrive so the UI fills in progressively.
- The front end renders on a `requestAnimationFrame` batch (`markDirty` /
  `flushRender` in `app.js`) and never rebuilds a region it did not change.
  Inputs are mounted once and never replaced, so focus and caret survive.

## Always show what it is doing

No silent work. Whenever the app is busy, the user must be able to see **what**
is happening and **how far along** it is:

- Register the work with `beginWork(key, label)` / `endWork(key)` in `app.js`.
  That drives the status bar along the bottom of the window and the
  indeterminate bar in the toolbar. The status bar is **never empty and never
  hidden** — with nothing in flight it says what the app last did, because a
  bar that comes and goes cannot be glanced at.
- If the total is known, report progress (`142 / 310`), not just a spinner.
- If individual items are still loading, draw them as **skeletons in place** —
  named, greyed and shimmering — so it is obvious which rows are still coming.
- Name the real phase (`Reading git status`, `Scanning running processes`),
  never a generic "Loading…".
- Actions that leave the app (VS Code, Explorer, a new shell) show their own
  transient line until they return.

## Do not launch the app

**Never start, foreground or screenshot the DevHQ window.** No `npm run dev`,
no running `devhq.exe`, no `PrintWindow` / `CopyFromScreen` captures, no
sending input to the window. The user runs and tests the app themselves.

Verify changes without it: `cargo check` / `cargo clippy` for the Rust side,
`cargo run --example scan_cli` for the scan itself, and `node --check` for the
front-end files. If something can only be confirmed by looking at the running
window, say so and hand it over rather than launching it.
