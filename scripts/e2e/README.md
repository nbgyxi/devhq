# Full-app integration test

Drives the front end through every screen and tool listed in `src/app.js`'s
catalogs, to catch regressions where a tool has totally stopped working, the
UI freezes, or navigating away from a tool gets stuck. Unlike
`scripts/smoke-util-tools.js` / `scripts/smoke-windows-tools.js` (which
re-run tool logic in a Node sandbox), this drives real rendered pages
through a real browser engine, so it also catches a front-end hang — a
synchronous loop or runaway render that wedges the page's own main thread.

Both variants navigate the same way the app's own pin chips and back
buttons do (dispatching the `devhq:open-tool` event `app.js` already
listens for), then read the real DOM to confirm the right screen actually
came up. Neither ever clicks an action button inside a tool (no killing
processes, running repairs, starting disk scans, or closing terminals) — so
both are safe to re-run as often as you like.

There are two ways to run it, trading off setup cost against fidelity:

## `npm run test:e2e` — headless browser, no setup (start here)

```
npm install
npx playwright install chromium   # once
npm run test:e2e
```

Runs `run-browser.js`: serves `src/` over a local static server, loads it in
headless Chromium via Playwright, and replaces `window.__TAURI__` with a
generic stub (`tauri-stub.js`) that never touches a real backend. No Tauri
runtime, no built app, no OS-level driver, no Windows required.

**What it catches:** a screen that fails to open, a tool that renders an
error state, and a genuine front-end freeze or crash (a `page.evaluate()`
call into the page literally cannot return while the page's own main thread
is wedged — that's a real hang, not a flaky wait). A tool that crashes the
tab is recovered from automatically (a fresh page opens for the next entry)
so one broken screen doesn't take down the rest of the run.

**What it misses:** a real Rust command hanging the app's actual main
thread — `core.invoke` is mocked here, so no IPC ever reaches the backend.
It can also produce a false-positive `RENDERED_WITH_ERROR`: the stub guesses
a generic shape for whatever a command returns (`[]` for anything
list-shaped, `{}` otherwise), and a screen that expects a specific field on
a real response can show an error here that wouldn't happen against the
real backend. Check `scripts/e2e/last-run-report.json`'s `consoleErrors` for
the raw exception before assuming a `RENDERED_WITH_ERROR`/`FROZEN` result is
a real bug — cross-check anything ambiguous against `run.js` below.

## `npm run test:e2e:webview` — the real app, full fidelity, more setup

Runs `run.js` against the actual built app through WebView2 via
`tauri-driver`. This is the only variant that can catch a real Rust command
hanging the app's actual main thread, since it exercises the genuine IPC
path end to end rather than a mock. Windows only.

One-time setup:
1. `cargo install tauri-driver --locked`
2. Download **Microsoft Edge WebDriver** matching your installed WebView2
   Runtime version (Settings → Apps → search "WebView2 Runtime" for the
   version, then grab the matching driver from
   https://developer.microsoft.com/microsoft-edge/tools/webdriver/) and put
   `msedgedriver.exe` on your `PATH`.
3. `cargo build --release --manifest-path src-tauri/Cargo.toml --bin devhq`

Then: `npm run test:e2e:webview`. Re-run the build step whenever you want to
test a fresh build; the test itself always re-tests whatever's currently at
`src-tauri/target/release/devhq.exe` (override with `DEVHQ_E2E_EXE`).

## Reading the output

Either variant prints the same kind of table and writes the full result set
to `scripts/e2e/last-run-report.json` (git-ignored). Each row is one screen
or tool, plus one `<id>:leave` row per tool checking that navigating back to
Overview afterward actually worked — this is where a "blocks navigation"
regression shows up, since the tool itself might open fine but leaving it
gets stuck. Exit code is non-zero if anything regressed.

| Status | Meaning |
| --- | --- |
| `OK` | Opened and rendered cleanly. |
| `RENDERED_WITH_ERROR` | The screen came up, but the tool itself is showing an error state (e.g. `.tools-error`, or a windows-tool status line with `tone="bad"`). |
| `FAIL_NO_ACTIVATE` | Navigation didn't produce the expected screen within the time budget — the tool silently stopped working, or something blocked getting to it. |
| `FROZEN` | A call into the running page never returned in time. The page might still be alive but wedged, or might die moments later (see `CRASHED`). |
| `FREEZE_ON_DISPATCH` | Even the trivial "dispatch a navigation event" call froze — the most severe non-crash case. |
| `CRASHED` (browser variant only) | The tab/renderer actually died. The suite recovers with a fresh page automatically; this result marks exactly which entry caused it. |

## A regression this suite already found

Running `npm run test:e2e` surfaces a real, reproducible one: opening
**Active Window Time Tracker** (`windows-tools` → `time-tracker`) and then
navigating anywhere else wedges the page's main thread for roughly
20-25 seconds before the tab dies outright. It reproduces the same way
every time in the headless suite. It has not been confirmed against the
real WebView2 app (`test:e2e:webview`) yet — that's the natural next step
before treating it as confirmed in production rather than an artifact of
the mocked backend.

## Configuration

All optional, via environment variables:

| Variable | Applies to | Default | Purpose |
| --- | --- | --- | --- |
| `DEVHQ_E2E_STEP_TIMEOUT_MS` | both | `4000` (browser) / `6000` (webview) | How long a screen/tool has to become active before `FAIL_NO_ACTIVATE`. |
| `DEVHQ_E2E_SCRIPT_TIMEOUT_MS` | both | `2500` (browser) / `3000` (webview) | How long a single call into the page can take before it's treated as wedged. |
| `DEVHQ_E2E_CHROMIUM_PATH` | browser | Playwright-managed Chromium | Use a specific Chromium binary instead of Playwright's own download. |
| `DEVHQ_E2E_EXE` | webview | `src-tauri/target/release/devhq.exe` | Path to the built app to test. |
| `DEVHQ_E2E_PORT` | webview | `4444` | Port tauri-driver listens on. |

## Scope / what neither variant covers

- **Pop-out tool windows** (a tool opened in its own OS window via the
  pop-out button) aren't driven by either variant — only the in-page view of
  every screen and tool. The pop-out mechanism (`tool_popout` → `tool.html`)
  is a reasonable thing to extend this suite with later if it starts
  regressing.
- **Tool correctness** (does `base64` actually encode correctly) is covered
  by `scripts/smoke-util-tools.js`, not this suite — this suite only checks
  that a tool's screen opens, and if it renders an error, flags it.
