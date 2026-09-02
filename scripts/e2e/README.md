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

**Every util-tool and windows-tool now renders in an isolated child
WebView2 surface**, not an in-page panel: `openTool()` (`app.js`) routes
every one of them through `openIsolatedTool()`, which mounts the tool via
`src-tauri/src/tool_window.rs`'s `add_child` as a genuinely separate
renderer, specifically so a tool that hangs can't take the main shell down
with it. This suite has no WebDriver handle into that separate document, so
for these ~39 entries it can only prove *navigation reached the right
tool* (the shell's `#isolated-tool-host` header shows the right name) — it
can no longer see whether the tool's own content rendered without error the
way the old in-page checks could. `RENDERED_WITH_ERROR` is effectively
unreachable for these entries now; a broken isolated tool will instead
either never activate (`FAIL_NO_ACTIVATE`) or bounce back to Overview with a
status-bar message (`app.js`'s `syncEmbeddedTool` catch block), which shows
up here as the tool's own check failing to activate.

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

Then just: `npm run test:e2e:webview`. It builds the app for you first if
`src-tauri/target/release/devhq.exe` is missing or **stale** — older than
any Rust or front-end source file (`needsRebuild()` in `run.js`). This
matters beyond convenience: Tauri bundles the front end into the binary at
build time, and cargo's own dependency graph doesn't know to rebuild just
because a `.js` file changed, so a stale exe can silently be testing an
older version of the app than what's on disk (this bit an earlier session —
search couldn't find a tool that existed in current source, because the
running build simply predated it). Skip the auto-build with
`DEVHQ_E2E_SKIP_BUILD=1` if you're iterating fast and want to control
builds yourself, or point `DEVHQ_E2E_EXE` at a build you manage separately
(either opts out of auto-build, and `DEVHQ_E2E_EXE` also opts out of the
staleness check — you're on your own for keeping that one fresh).

Only this variant additionally runs, since both depend on real
`WebviewWindowBuilder` windows and real IPC a mocked backend can't produce:

- **A best-effort deep check per tool** (`deepCheckIsolatedTool()`): after a
  tool becomes active, the suite tries to reach its isolated child webview
  as its own WebDriver window handle and, if it can, invokes exactly **one**
  generic, read-only action inside it — clicking the shared "Refresh" button
  every windows-tool has, or typing a harmless sample into a util-tool's
  input field. It never clicks anything else, and specifically never a
  repair, reset, kill, disk-scan-start, or terminal-close action — see
  "What this suite will never do" below. Whether the child webview is
  reachable at all is genuinely uncertain (`add_child` creates an embedded
  native surface, not a top-level window), so a miss is reported as
  `DEEP_CHECK_UNSUPPORTED` and does **not** count as a regression.
- **Superficial scenario checks** (`runAuxiliaryScenarios()`), each via a
  real click/focus rather than a synthetic event dispatch: opening Search
  and clicking a real result, opening the version/changelog window,
  popping a tool out into its own window, opening the terminal both docked
  and popped out, and clicking a tool's own Back button for real. Each only
  proves the real interaction path works and a plausible window/panel
  appears — not deep correctness.

## Reading the output

Either variant prints the same kind of table and writes the full result set
to `scripts/e2e/last-run-report.json` (git-ignored). Each row is one screen
or tool, plus one `<id>:leave` row per tool checking that navigating back to
Overview afterward actually worked — this is where a "blocks navigation"
regression shows up, since the tool itself might open fine but leaving it
gets stuck. Exit code is non-zero if anything regressed.

`run.js` (the webview variant) additionally writes a timestamped, step-by-step
log to `scripts/e2e/last-run.log` (git-ignored, overwritten each run) as it
runs — every dispatch, every poll attempt, every window switch, tauri-driver's
own stdout/stderr. It's written synchronously as each step happens, not
buffered, specifically so that if the process hangs or gets killed, the log
still shows exactly how far it got — check it after a hang or a confusing
result instead of trying to reproduce it live.

| Status | Meaning |
| --- | --- |
| `OK` | Opened and rendered cleanly. |
| `RENDERED_WITH_ERROR` | The screen came up, but the tool itself is showing an error state (e.g. `.tools-error`, or a windows-tool status line with `tone="bad"`). |
| `FAIL_NO_ACTIVATE` | Navigation didn't produce the expected screen within the time budget — the tool silently stopped working, or something blocked getting to it. |
| `FROZEN` | A call into the running page never returned in time. The page might still be alive but wedged, or might die moments later (see `CRASHED`). |
| `FREEZE_ON_DISPATCH` | Even the trivial "dispatch a navigation event" call froze — the most severe non-crash case. |
| `CRASHED` (browser variant only) | The tab/renderer actually died. The suite recovers with a fresh page automatically; this result marks exactly which entry caused it. |
| `DEEP_CHECK_OK` (webview variant only) | The per-tool deep check reached the tool's own child webview and invoked its one safe action. |
| `DEEP_CHECK_UNSUPPORTED` (webview variant only) | The deep check couldn't reach the tool's child webview (or found no generic safe action inside it) — expected on some machines, **not** a regression. |

## What this suite will never do

However deep the checks get, this suite never clicks anything that changes
system state: no starting a disk scan, killing a process, running a device
repair/reset, closing a terminal, or writing a file. The per-tool deep
check above is deliberately restricted to exactly one universally
read-only action (a status refresh, or typing into a pure input → output
transform) — if a tool has no such action, the deep check reports
`DEEP_CHECK_UNSUPPORTED` rather than reaching for anything riskier. This is
why it's safe to re-run as often as you like, including against your own
machine's real network adapters, processes, and files.

## New-install onboarding gets clicked through automatically

Both variants launch (or open) with blank `localStorage`, so `app.js` runs
its full first-run sequence every time — `firstRunLanguage()`, then (once
there are no scanned roots yet) `firstRunFolders()`, then
`firstRunUsageData()` — three full-window modals
(`.language-first-run`: `position:fixed;inset:0;z-index:200` with a dark
blurred scrim) that sit over the titlebar/statusbar too. Nothing in this
suite's navigation-only dispatching clicks them away on its own, so both
runners now click through all three once at session start (choosing "Use
Windows language", filling `firstRunFolders()`'s folder field with this
repo's own path if `default_root()` doesn't auto-fill it, and declining the
usage-data opt-in) before doing anything else — the same path a real
first-time user would take. If you ever see the console log a first-run
dialog stuck open, one of the three now has a different selector than this
suite expects and needs updating to match.

## A finding worth re-checking

An earlier run of `npm run test:e2e` (before the `isolated-tool` checks and
onboarding-dismissal fixes above) surfaced a reproducible-looking hang/crash
opening **Active Window Time Tracker** and then navigating anywhere else.
That finding predates both fixes and was never confirmed against the real
app — treat it as unverified until re-run with the current version of this
suite, on both variants.

## Configuration

All optional, via environment variables:

| Variable | Applies to | Default | Purpose |
| --- | --- | --- | --- |
| `DEVHQ_E2E_STEP_TIMEOUT_MS` | both | `4000` (browser) / `6000` (webview) | How long a screen/tool has to become active before `FAIL_NO_ACTIVATE`. |
| `DEVHQ_E2E_SCRIPT_TIMEOUT_MS` | both | `2500` (browser) / `3000` (webview) | How long a single call into the page can take before it's treated as wedged. |
| `DEVHQ_E2E_CHROMIUM_PATH` | browser | Playwright-managed Chromium | Use a specific Chromium binary instead of Playwright's own download. |
| `DEVHQ_E2E_EXE` | webview | `src-tauri/target/release/devhq.exe` | Path to the built app to test. |
| `DEVHQ_E2E_PORT` | webview | `4444` | Port tauri-driver listens on. |
| `DEVHQ_E2E_SKIP_BUILD` | webview | unset | Set to `1` to skip the automatic staleness check/build and use whatever's already at `DEVHQ_E2E_EXE`/the default path as-is. |
| `DEVHQ_E2E_TOOL_SETTLE_MS` | webview | `400` | Pause after each tool visit and each auxiliary scenario, giving WebView2 a moment to actually finish releasing that tool's dedicated environment before the next one starts. Raise this if late-run window creation starts failing again; lower it (or set 0) once you trust the machine can keep up, to speed the run back up. |
| `DEVHQ_E2E_TOOL_VISIBLE_MS` | webview | `500` | Pause after a tool opens, before bouncing back to Overview - purely so a tool is actually visible on screen for a moment if you're watching the run live. Doesn't affect what's checked. |

## Scope / what this suite doesn't cover

- **Pop-out tool windows, search, changelog, and the terminal** get one
  superficial check each (webview variant only, see above) — opened once,
  confirmed a plausible window/panel appeared, closed. They aren't visited
  per-tool or per-project the way the main catalog is.
- **Tool correctness** (does `base64` actually encode correctly) is covered
  by `scripts/smoke-util-tools.js`, not this suite — this suite only checks
  that a tool's screen opens, invokes one safe action if it can reach one,
  and flags it if it renders an error.
- **The per-tool deep check's coverage depends on the machine.** If
  `DEEP_CHECK_UNSUPPORTED` shows up for every tool, this machine's
  `tauri-driver`/WebView2 automation isn't exposing isolated child webviews
  as separate window handles — that's a limitation of the test environment,
  not a signal about the app.
