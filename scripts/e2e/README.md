# Full-app integration test

Drives the real, built DevHQ window through every screen and tool listed in
`src/app.js`'s catalogs, to catch regressions where a tool has totally
stopped working, the UI freezes, or navigating away from a tool gets stuck.
Unlike `scripts/smoke-util-tools.js` / `scripts/smoke-windows-tools.js`
(which re-run tool logic in a Node sandbox), this drives the actual
WebView2-hosted app through [tauri-driver](https://github.com/tauri-apps/tauri/tree/dev/crates/tauri-driver),
so it also catches a Rust command that hangs the main thread — the one class
of bug the sandboxed smoke tests can't see.

It navigates the same way the app's own pin chips and back buttons do
(dispatching the `devhq:open-tool` event `app.js` already listens for), then
reads the real DOM to confirm the right screen actually came up. It never
clicks an action button inside a tool (no killing processes, running
repairs, starting disk scans, or closing terminals) — it only opens each
screen and reads its rendered state, so it's safe to re-run as often as you
like.

## One-time setup (Windows only — this drives the real WebView2 window)

1. Install tauri-driver:
   ```
   cargo install tauri-driver --locked
   ```
2. Download **Microsoft Edge WebDriver** that matches your installed
   WebView2 Runtime version (Settings → Apps → search "WebView2 Runtime" for
   the version, then grab the matching driver from
   https://developer.microsoft.com/microsoft-edge/tools/webdriver/) and put
   `msedgedriver.exe` somewhere on your `PATH`. tauri-driver launches it
   under the hood.
3. Install the npm dependency once: `npm install`.

## Running it

```
cargo build --release --manifest-path src-tauri/Cargo.toml --bin devhq
npm run test:e2e
```

The first command only needs to be re-run when you want to test a fresh
build; `npm run test:e2e` alone will re-test whatever's already at
`src-tauri/target/release/devhq.exe`.

Exit code is non-zero if anything regressed. A table prints to the console,
and the full result set is also written to `scripts/e2e/last-run-report.json`
(git-ignored) if you want to diff runs or feed it to something else.

## Reading the output

Each row is one screen or tool, plus one `<id>:leave` row per tool checking
that navigating back to Overview afterward actually worked (this is where a
"blocks navigation" regression shows up — the tool itself might open fine,
but leaving it gets stuck).

| Status | Meaning |
| --- | --- |
| `OK` | Opened and rendered cleanly. |
| `RENDERED_WITH_ERROR` | The screen came up, but the tool itself is showing an error state (e.g. `.tools-error`, or a windows-tool status line with `tone="bad"`). |
| `FAIL_NO_ACTIVATE` | Navigation didn't produce the expected screen within the time budget — the tool silently stopped working, or something blocked getting to it. |
| `FROZEN` | A WebDriver call into the running app never returned — the app's main thread is genuinely wedged, not just slow. |
| `FREEZE_ON_DISPATCH` | Even the trivial "dispatch a navigation event" call froze — the most severe case. |

## Configuration

All optional, via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVHQ_E2E_EXE` | `src-tauri/target/release/devhq.exe` | Path to the built app to test. |
| `DEVHQ_E2E_PORT` | `4444` | Port tauri-driver listens on. |
| `DEVHQ_E2E_STEP_TIMEOUT_MS` | `6000` | How long a screen/tool has to become active before it's marked `FAIL_NO_ACTIVATE`. |
| `DEVHQ_E2E_SCRIPT_TIMEOUT_MS` | `3000` | WebDriver's own script timeout; a call that outlives this is treated as a genuine freeze. |

## Scope / what this doesn't cover

- **Pop-out tool windows** (a tool opened in its own OS window via the pop-out
  button) aren't driven here — only the in-page view of every screen and
  tool. The pop-out mechanism (`tool_popout` → `tool.html`) is a reasonable
  thing to extend this suite with later if it starts regressing, but it
  roughly doubles run time and wasn't in scope for this first pass.
- **Tool correctness** (does `base64` actually encode correctly) is covered
  by `scripts/smoke-util-tools.js`, not this suite — this suite only checks
  that a tool's screen opens, and if it renders an error, flags it.
- Freeze detection can only prove a freeze happened, not attribute it to a
  specific Rust command — pair a `FROZEN`/`FREEZE_ON_DISPATCH` result with
  whatever tool you just visited and dig from there.
