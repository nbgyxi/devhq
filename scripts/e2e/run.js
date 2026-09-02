#!/usr/bin/env node
/**
 * Drives the real, built DevHQ app through every screen and tool via
 * tauri-driver + WebView2, to catch regressions where a tool has totally
 * stopped working, the UI freezes, or navigating away gets stuck.
 *
 * One-time setup (see scripts/e2e/README.md for details):
 *   1. cargo install tauri-driver --locked
 *   2. Download Microsoft Edge WebDriver matching your installed WebView2
 *      Runtime version and put msedgedriver.exe on PATH.
 *
 * Then just run: npm run test:e2e:webview
 *
 * Builds the app for you first if it's missing or stale (any Rust or
 * front-end source file newer than the exe - see needsRebuild()), so a
 * fresh checkout or an edited source tree Just Works. Skip that with
 * DEVHQ_E2E_SKIP_BUILD=1, or point DEVHQ_E2E_EXE at a build you manage
 * yourself (either opts out of auto-build).
 *
 * What this does and does not check:
 *   - It navigates to every screen/tool the exact way the app's own pin
 *     chips and back buttons do (dispatching the same "devhq:open-tool"
 *     event app.js already listens for), then reads the real DOM to prove
 *     the right thing is actually on screen and didn't render an error.
 *   - For each tool, it also makes a best-effort attempt to invoke one
 *     generic, read-only action inside it (see deepCheckIsolatedTool()) -
 *     this depends on the isolated tool's child webview being reachable as
 *     its own WebDriver window handle, which isn't guaranteed, so a miss is
 *     reported as DEEP_CHECK_UNSUPPORTED, not a regression.
 *   - Beyond per-tool navigation, runAuxiliaryScenarios() superficially
 *     exercises search, the version/changelog window, a tool pop-out, both
 *     terminal forms, and a real (non-synthetic) click on a tool's Back
 *     button - proving the real interaction paths work, not deep
 *     correctness.
 *   - It deliberately never clicks into an action that changes system state
 *     (starting a disk scan, killing a process, running a repair, closing a
 *     terminal, resetting a device), so it's safe to re-run repeatedly. It
 *     is a "does this work and respond" smoke test, not a correctness test
 *     of every tool's own logic.
 *   - Freezes are detected two ways: (a) a step that never reaches its
 *     expected on-screen state within its time budget, and (b) a WebDriver
 *     script call that itself never returns, which only happens when the
 *     app's main thread is genuinely wedged (not just slow).
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { Builder, By } = require("selenium-webdriver");

const { buildCatalog } = require("./catalog");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_EXE = path.join(REPO_ROOT, "src-tauri", "target", "release", "devhq.exe");
// firstRunFolders() needs a real, existing folder before it'll let you
// through. This repo's own checkout would technically work, but it's a
// genuinely heavy first scan (node_modules/, Rust target/ build output) -
// slow enough to plausibly delay early navigation for several seconds while
// it runs. An empty, dedicated folder scans near-instantly and this suite
// doesn't care what the scan actually finds.
const FALLBACK_SCAN_ROOT = path.join(os.tmpdir(), "devhq-e2e-scan-root");
const APP_EXE = process.env.DEVHQ_E2E_EXE || DEFAULT_EXE;
const DRIVER_PORT = Number(process.env.DEVHQ_E2E_PORT || 4444);
const STEP_TIMEOUT_MS = Number(process.env.DEVHQ_E2E_STEP_TIMEOUT_MS || 6000);
const SCRIPT_TIMEOUT_MS = Number(process.env.DEVHQ_E2E_SCRIPT_TIMEOUT_MS || 3000);
// Each isolated tool gets its own dedicated WebView2 environment - a real
// separate renderer process, by the app's own design (see
// src-tauri/src/tool_window.rs), specifically so a hung tool can't take the
// main shell down with it. Creating and tearing ~48 of those down back to
// back with no breathing room has been observed to get progressively
// slower over a run and eventually start failing outright late in it
// (window creation just never completing) - this settle delay gives
// WebView2 a moment to actually finish releasing each one before the next
// tool's dispatch starts piling more on top.
const TOOL_SETTLE_MS = Number(process.env.DEVHQ_E2E_TOOL_SETTLE_MS || 400);
// Purely for a human watching the window: without this, a tool's deep check
// finishes and bounceToOverview() fires immediately after, so the tool
// never actually gets painted on screen before Overview replaces it again.
// Doesn't change what's being checked, just gives each tool a moment to
// actually be visible.
const TOOL_VISIBLE_MS = Number(process.env.DEVHQ_E2E_TOOL_VISIBLE_MS || 500);
const POLL_INTERVAL_MS = 250;
const DRIVER_START_TIMEOUT_MS = 15000;
const REPORT_PATH = path.join(__dirname, "last-run-report.json");
const LOG_PATH = path.join(__dirname, "last-run.log");

// Truncated at the start of each run (not appended across runs), so it
// always reflects only the run you just watched - open it after a hang or
// a confusing result instead of trying to catch everything live in the
// console. Every line is timestamped and written synchronously as it
// happens (not buffered), specifically so that if the process hangs or
// gets killed, the log still shows exactly how far it got and how long the
// last step had been running - that's the whole point of it existing.
fs.writeFileSync(LOG_PATH, "");
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(LOG_PATH, line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Races `promise` against a timeout, rejecting if it doesn't settle in
 *  time. Needed for WebDriver commands like driver.close() that aren't
 *  covered by the session's own script timeout - that only bounds
 *  executeScript calls, not window-management commands - so nothing else
 *  in this suite protects against one of those genuinely hanging. */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const SKIP_BUILD = process.env.DEVHQ_E2E_SKIP_BUILD === "1";
const IGNORED_DIR_NAMES = new Set(["target", "node_modules", ".git"]);

/** Newest mtime of any file under `dir` (recursive), skipping build/VCS
 *  output that would otherwise make a fresh checkout look perpetually
 *  stale (or, for src-tauri/target, make the exe look newer than itself). */
function newestMtimeUnder(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIR_NAMES.has(entry.name)) stack.push(path.join(current, entry.name));
        continue;
      }
      const mtime = fs.statSync(path.join(current, entry.name)).mtimeMs;
      if (mtime > newest) newest = mtime;
    }
  }
  return newest;
}

/** True if `appExe` is missing, or older than any Rust or front-end source
 *  file. Frontend files matter too, not just src-tauri/src: Tauri bundles
 *  `frontendDist` into the binary at build time, and cargo's own dependency
 *  graph doesn't know to rebuild just because a .js file changed - this is
 *  exactly what caused an earlier session's exe to silently be missing a
 *  tool that existed in current source (search found nothing for it,
 *  because the running build simply predated it). */
function needsRebuild(appExe) {
  if (!fs.existsSync(appExe)) return true;
  const exeMtime = fs.statSync(appExe).mtimeMs;
  const configFiles = [
    path.join(REPO_ROOT, "src-tauri", "Cargo.toml"),
    path.join(REPO_ROOT, "src-tauri", "tauri.conf.json"),
    path.join(REPO_ROOT, "src-tauri", "build.rs"),
  ];
  const configNewest = Math.max(0, ...configFiles.map((f) => {
    try { return fs.statSync(f).mtimeMs; } catch { return 0; }
  }));
  const sourceNewest = Math.max(
    newestMtimeUnder(path.join(REPO_ROOT, "src-tauri", "src")),
    newestMtimeUnder(path.join(REPO_ROOT, "src")),
    configNewest,
  );
  return sourceNewest > exeMtime;
}

function runCargoBuild() {
  return new Promise((resolve, reject) => {
    console.log("Source is newer than the built app - running cargo build --release...");
    const proc = spawn(
      "cargo",
      ["build", "--release", "--manifest-path", path.join(REPO_ROOT, "src-tauri", "Cargo.toml"), "--bin", "devhq"],
      { stdio: "inherit", shell: process.platform === "win32" },
    );
    proc.on("error", (err) => reject(new Error(`Could not start cargo: ${err.message}. Is it on PATH? (a fresh terminal may be needed after installing Rust)`)));
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`cargo build exited with code ${code}`));
    });
  });
}

function waitForDriverReady(port, deadline) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/status", timeout: 1000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) return reject(new Error(`tauri-driver did not come up on port ${port} in time`));
        setTimeout(attempt, 300);
      });
      req.on("timeout", () => req.destroy());
    };
    attempt();
  });
}

async function spawnTauriDriver() {
  log(`Starting tauri-driver on port ${DRIVER_PORT}...`);
  const proc = spawn("tauri-driver", ["--port", String(DRIVER_PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let spawnError = null;
  proc.stdout?.on("data", (chunk) => log(`[tauri-driver stdout] ${chunk.toString().trimEnd()}`));
  proc.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
    log(`[tauri-driver stderr] ${chunk.toString().trimEnd()}`);
  });
  proc.on("error", (err) => { spawnError = err; });
  try {
    await waitForDriverReady(DRIVER_PORT, Date.now() + DRIVER_START_TIMEOUT_MS);
  } catch (err) {
    proc.kill();
    log(`tauri-driver did not come up: ${(spawnError || err).message}`);
    console.error((spawnError || err).message);
    console.error("Is tauri-driver installed? Install it once with: cargo install tauri-driver --locked");
    if (stderr) console.error(stderr);
    process.exit(1);
  }
  log("tauri-driver is ready.");
  return proc;
}

function finish(entry, status, detail, startedAt) {
  return {
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    status,
    detail: detail || "",
    ms: Date.now() - startedAt,
  };
}

async function pollForState(driver, entry, startedAt) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    let state;
    // Logged before, not just after, each attempt on purpose: if this
    // specific executeScript call is what hangs, the log's last line for
    // this entry names exactly which attempt never came back, rather than
    // just showing a gap you have to guess the cause of.
    log(`  poll ${entry.id} #${attempt}: executeScript starting...`);
    try {
      state = await driver.executeScript(entry.checkFn, ...entry.checkArgs);
    } catch (err) {
      log(`  poll ${entry.id} #${attempt}: threw - ${err.message}`);
      return finish(entry, "FROZEN", `WebDriver script did not return: ${err.message}`, startedAt);
    }
    log(`  poll ${entry.id} #${attempt}: returned active=${state?.active}`);
    if (state && state.active) {
      return state.errorText
        ? finish(entry, "RENDERED_WITH_ERROR", state.errorText, startedAt)
        : finish(entry, "OK", "", startedAt);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return finish(entry, "FAIL_NO_ACTIVATE", `did not become active within ${STEP_TIMEOUT_MS}ms`, startedAt);
}

async function waitForCondition(driver, checkFn, checkArgs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let ok = false;
    try {
      ok = await driver.executeScript(checkFn, ...checkArgs);
    } catch {
      // Treated as "not yet" rather than a hard failure - the same
      // executeScript can transiently fail while a window is mid-transition.
    }
    if (ok) return true;
    await sleep(200);
  }
  return false;
}

async function getWindowHandles(driver) {
  return new Set(await driver.getAllWindowHandles());
}

async function waitForNewWindowHandle(driver, before, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await driver.getAllWindowHandles();
    const fresh = now.find((h) => !before.has(h));
    if (fresh) return fresh;
    await sleep(200);
  }
  return null;
}

/** Like waitForNewWindowHandle(), but verifies the handle actually points
 *  to `expectedUrlPart` before trusting it - not just "it wasn't in the
 *  before-set". After 40+ isolated-tool child webviews get created and torn
 *  down over a full run, msedgedriver's own handle enumeration has been
 *  observed to hand back a leftover/stale handle (from some earlier tool's
 *  child webview, e.g. tool-embedded.html?id=git) instead of the genuinely
 *  new one a scenario just triggered - a plain before/after diff can't tell
 *  the difference, and switching into the wrong window then makes every
 *  check after it fail in confusing ways. Handles that don't match are
 *  remembered and skipped for the rest of this call, but never touched
 *  otherwise - this only reads location.href, it doesn't close anything. */
async function waitForMatchingWindowHandle(driver, before, expectedUrlPart, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const rejected = new Set();
  while (Date.now() < deadline) {
    const now = await driver.getAllWindowHandles();
    const candidates = now.filter((h) => !before.has(h) && !rejected.has(h));
    for (const handle of candidates) {
      try {
        await driver.switchTo().window(handle);
        const href = await driver.executeScript(function () { return location.href; });
        if (typeof href === "string" && href.includes(expectedUrlPart)) return handle;
      } catch {
        // Couldn't switch to it or read its URL - not a match this round.
      }
      rejected.add(handle);
    }
    await sleep(200);
  }
  return null;
}

const ONBOARDING_TIMEOUT_MS = 20000;

/** The release build under test is a fresh install from WebView2's
 *  perspective (a different profile than `npm run dev`, which you've
 *  already clicked through), so app.js runs new-install onboarding every
 *  single run: firstRunLanguage(), then - once there are no scanned roots
 *  yet - firstRunFolders(), then firstRunUsageData(). Each is a full-window
 *  modal (.language-first-run: position:fixed;inset:0;z-index:200 with a
 *  dark blurred scrim) sitting over the titlebar/statusbar too, and nothing
 *  in this suite's navigation-only dispatching ever clicks any of them away
 *  on its own. Click through all three once, the same way a real
 *  first-time user would, before doing anything else.
 *
 *  Runs as one executeAsyncScript so the browser does its own polling
 *  (a Node-side round trip per tick would be far chattier) - the dialogs
 *  appear one after another as each is answered, and firstRunFolders()
 *  waits on a real invoke("default_root") backend call to auto-fill a
 *  folder before its Start button enables, so this can genuinely take a
 *  few seconds. Needs a longer script timeout than normal steps get, hence
 *  the temporary setTimeouts() bump. */
async function dismissFirstRunOnboarding(driver) {
  log("Checking for first-run onboarding dialogs...");
  await driver.manage().setTimeouts({ script: ONBOARDING_TIMEOUT_MS + 2000 });
  let result;
  try {
    result = await driver.executeAsyncScript(
      function (fallbackRoot, timeoutMs, callback) {
        const deadline = Date.now() + timeoutMs;
        let steps = 0;
        function tick() {
          if (Date.now() > deadline) return callback({ timedOut: true, steps });
          const langBtn = document.querySelector('.language-first-run [data-language="system"]');
          if (langBtn) { langBtn.click(); steps++; return setTimeout(tick, 300); }
          const startBtn = document.querySelector('.language-first-run [data-first-run="start"]');
          if (startBtn) {
            if (startBtn.disabled) {
              const input = document.querySelector('.language-first-run .first-run-roots input');
              if (input && !input.value) {
                input.value = fallbackRoot;
                input.dispatchEvent(new Event("input", { bubbles: true }));
              }
              return setTimeout(tick, 300);
            }
            startBtn.click();
            steps++;
            return setTimeout(tick, 300);
          }
          const noThanksBtn = document.querySelector('.language-first-run [data-usage="no"]');
          if (noThanksBtn) { noThanksBtn.click(); steps++; return setTimeout(tick, 300); }
          // Nothing recognized right now - either a dialog is mid-transition
          // (keep waiting) or there's genuinely none left (done).
          if (document.querySelector(".language-first-run")) return setTimeout(tick, 300);
          callback({ timedOut: false, steps });
        }
        tick();
      },
      FALLBACK_SCAN_ROOT,
      ONBOARDING_TIMEOUT_MS,
    );
  } finally {
    await driver.manage().setTimeouts({ script: SCRIPT_TIMEOUT_MS });
  }
  if (result && result.steps > 0) {
    const msg = `Dismissed ${result.steps} first-run onboarding step(s)${result.timedOut ? " (timed out waiting for more)" : ""}.`;
    console.log(msg);
    log(msg);
  } else if (result && result.timedOut) {
    const msg = "A first-run dialog appears to be stuck open - none of its known buttons matched.";
    console.log(msg);
    log(msg);
  } else {
    log("No first-run onboarding dialog appeared (already past it, or never shown).");
  }
}

async function dispatchOpen(driver, id) {
  return driver.executeScript(function (toolId) {
    window.dispatchEvent(new CustomEvent("devhq:open-tool", { detail: { id: toolId } }));
  }, id);
}

async function visit(driver, mainHandle, entry, results) {
  const startedAt = Date.now();
  log(`visit ${entry.id}: dispatching open...`);
  const beforeHandles = entry.isolated ? await getWindowHandles(driver) : null;
  try {
    await dispatchOpen(driver, entry.id);
  } catch (err) {
    log(`visit ${entry.id}: FREEZE_ON_DISPATCH - ${err.message}`);
    results.push(finish(entry, "FREEZE_ON_DISPATCH", `WebDriver could not even dispatch navigation: ${err.message}`, startedAt));
    return;
  }
  const result = await pollForState(driver, entry, startedAt);
  log(`visit ${entry.id}: ${result.status} (${result.ms}ms)${result.detail ? ` - ${result.detail}` : ""}`);
  results.push(result);
  if (entry.isolated && result.status === "OK") {
    log(`visit ${entry.id}: running deep check...`);
    const deepResult = await deepCheckIsolatedTool(driver, mainHandle, entry, beforeHandles);
    log(`visit ${entry.id}: deep check ${deepResult.status} (${deepResult.ms}ms)${deepResult.detail ? ` - ${deepResult.detail}` : ""}`);
    results.push(deepResult);
  }
}

/** Bounces back to Overview after visiting `entry`, so a leave-confirmation
 *  or stuck state on one tool can't cascade into every entry after it. A
 *  failure here is reported against `entry` itself, tagged "(leaving)",
 *  since it means visiting that tool left navigation blocked - exactly the
 *  kind of regression this suite exists to catch. */
async function bounceToOverview(driver, catalog, justVisited, results) {
  const overview = catalog[0];
  const leaveId = `${justVisited.id}:leave`;
  const leaveLabel = `Leaving ${justVisited.label}`;
  const startedAt = Date.now();
  log(`bounce from ${justVisited.id}: dispatching open overview...`);
  try {
    await dispatchOpen(driver, "overview");
  } catch (err) {
    log(`bounce from ${justVisited.id}: FREEZE_ON_DISPATCH - ${err.message}`);
    results.push(finish(
      { id: leaveId, kind: "navigation", label: leaveLabel },
      "FREEZE_ON_DISPATCH",
      `WebDriver could not dispatch navigation back to Overview: ${err.message}`,
      startedAt,
    ));
    return;
  }
  const result = await pollForState(driver, overview, startedAt);
  log(`bounce from ${justVisited.id}: ${result.status} (${result.ms}ms)${result.detail ? ` - ${result.detail}` : ""}`);
  if (result.status !== "OK") {
    results.push({ ...result, id: leaveId, label: leaveLabel });
  }
}

// A generic "hello" is fine for the util-tools that are genuinely tolerant
// of plain text (bidirectional encoders, hashers, HTML repair - see each
// tool's own `hint` in src/util-tools.js) but reads as "broken" to anyone
// watching for the strictly-formatted ones (base64, jwt, uuid/guid,
// unix/filetime, json - "hello" isn't valid input for any of them, so they
// correctly show their own error state, which just looks like this suite
// found a bug when it didn't). A real sample per format avoids that noise.
const UTIL_TOOL_SAMPLE_INPUT = {
  base64: "aGVsbG8=", // "hello"
  jwt: "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.x",
  uuid: "8f14e45f-ceea-467a-9c3d-6b1f2a77e0d4",
  guid: "8f14e45f-ceea-467a-9c3d-6b1f2a77e0d4",
  unix: "1756345600",
  filetime: "133484736000000000",
  json: '{"hello":"world"}',
};

/** Best-effort: after `entry` becomes active, see whether its isolated
 *  child webview (src-tauri/src/tool_window.rs's add_child) shows up as its
 *  own WebDriver window handle. This is genuinely uncertain - unlike the
 *  scenario windows below, which are real WebviewWindowBuilder top-level
 *  windows, add_child creates an embedded native child surface, and whether
 *  msedgedriver's automation model exposes that as a separately-addressable
 *  target isn't something this suite can assume. If it does, click exactly
 *  one generic, read-only, side-effect-free action inside it: every
 *  windows-tool shares a "Refresh" button (data-win-refresh - re-reads
 *  current state, never a repair/reset/kill/write action); util-tools are
 *  typed input -> output transforms, so typing a harmless sample into
 *  #tools-input is equally safe (a realistic one per format, where it
 *  matters - see UTIL_TOOL_SAMPLE_INPUT above). Never touches anything
 *  else - specifically never a repair/reset/kill/start-scan/close-terminal
 *  action. DEEP_CHECK_UNSUPPORTED is a graceful, expected outcome (not a
 *  regression) when the handle never appears - see printReport(). */
async function deepCheckIsolatedTool(driver, mainHandle, entry, beforeHandles) {
  const deepEntry = { id: `${entry.id}:deep`, kind: entry.kind, label: `${entry.label} (deep)` };
  const startedAt = Date.now();
  // tool-embedded.html?id=<entry.id>&... - matched by content (id=), not
  // just "a handle that wasn't there before": after many isolated tools'
  // webviews have been created and torn down earlier in the run, a plain
  // diff can hand back a leftover handle from a *different* tool instead of
  // this one's - see waitForMatchingWindowHandle()'s doc comment, and the
  // scenario:changelog bug this exact confusion caused.
  log(`  deep ${entry.id}: looking for its child webview handle...`);
  const handle = await waitForMatchingWindowHandle(driver, beforeHandles, `id=${entry.id}`, 2500);
  if (!handle) {
    return finish(deepEntry, "DEEP_CHECK_UNSUPPORTED", "isolated tool did not appear as its own WebDriver window handle", startedAt);
  }
  log(`  deep ${entry.id}: found handle, switching in and looking for a safe action...`);
  const sampleInput = UTIL_TOOL_SAMPLE_INPUT[entry.id] || "hello";
  let result;
  try {
    await driver.switchTo().window(handle);
    const outcome = await driver.executeScript(function (sample) {
      const refresh = document.querySelector("[data-win-refresh]");
      if (refresh) { refresh.click(); return "clicked Refresh"; }
      const input = document.getElementById("tools-input");
      if (input) {
        input.value = sample;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return "typed a sample into the input";
      }
      return null;
    }, sampleInput);
    result = outcome
      ? finish(deepEntry, "DEEP_CHECK_OK", outcome, startedAt)
      : finish(deepEntry, "DEEP_CHECK_UNSUPPORTED", "no generic safe action (Refresh button or input field) found in this tool", startedAt);
  } catch (err) {
    result = finish(deepEntry, "FROZEN", `deep check errored: ${err.message}`, startedAt);
  } finally {
    // Never driver.close() this one: unlike the scenario windows below, its
    // lifecycle belongs to app.js's own syncEmbeddedTool()/tool_embedded_destroy
    // cleanup on the next navigation - closing it out from under that risks
    // fighting the app's own state rather than just observing it.
    try { await driver.switchTo().window(mainHandle); } catch (err) {
      console.error(`Could not switch back to the main window after a deep check on "${entry.label}": ${err.message}`);
    }
  }
  return result;
}

/** Triggers something expected to open a brand-new top-level window (search,
 *  changelog, a tool pop-out, a terminal pop-out - all real
 *  WebviewWindowBuilder windows per src-tauri/src/tool_window.rs and
 *  term.rs, not embedded child webviews, so unlike deepCheckIsolatedTool()
 *  above these reliably show up as their own WebDriver window handle).
 *  Switches into it, runs `check`, then always closes it and switches back
 *  to the main window - even on failure - so a broken scenario doesn't
 *  leave clutter or strand the session on the wrong window.
 *
 *  Closing defaults to WebDriver's own driver.close(), which is fine for a
 *  window app.js doesn't track any state about (search, changelog). For one
 *  it does track state about (a tool pop-out - state.toolPopouts), pass
 *  `cleanup` to close it the way a real user would instead: forcing the
 *  window away without going through the app's own docking flow leaves
 *  state.toolPopouts believing it's still open, which then makes the next
 *  real openTool() on that id try to focus a window that no longer exists
 *  instead of reopening it in the main window - see the "real-back-click"
 *  scenario below, which was failing for exactly this reason before this
 *  tool-popout scenario started passing a cleanup callback.
 *
 *  `trigger` is `async (driver) => {...}`, not a plain executeScript
 *  callback: some triggers need a genuine WebDriver-native interaction
 *  (driver.findElement(...).click(), synthesizing a real input event) rather
 *  than a scripted DOM call like .focus() - see the search scenario below,
 *  where .focus() alone wasn't enough to reliably fire app.js's real
 *  trigger.
 *
 *  `expectedUrlPart` (e.g. "changelog.html") is required, not optional: a
 *  plain "is this handle new" diff isn't reliable once dozens of isolated
 *  tool webviews have been created and torn down earlier in the run - see
 *  waitForMatchingWindowHandle()'s doc comment. */
async function runWindowScenario(driver, mainHandle, entry, expectedUrlPart, trigger, check, cleanup) {
  const startedAt = Date.now();
  log(`scenario ${entry.id}: starting, expecting a window matching "${expectedUrlPart}"...`);
  const before = await getWindowHandles(driver);
  try {
    await trigger(driver);
  } catch (err) {
    log(`scenario ${entry.id}: trigger threw - ${err.message}`);
    return finish(entry, "FREEZE_ON_DISPATCH", err.message, startedAt);
  }
  const handle = await waitForMatchingWindowHandle(driver, before, expectedUrlPart, 8000);
  if (!handle) {
    log(`scenario ${entry.id}: no matching window appeared`);
    return finish(entry, "FAIL_NO_ACTIVATE", `no window matching "${expectedUrlPart}" appeared within 8000ms`, startedAt);
  }
  log(`scenario ${entry.id}: matching window found, running its check...`);
  let result;
  try {
    // waitForMatchingWindowHandle() already switched to `handle` as part of
    // verifying it - re-switching here is just cheap insurance against it
    // having moved on to check a later candidate in its own loop.
    await driver.switchTo().window(handle);
    // The handle can exist slightly before its page has actually finished
    // navigating to its real content (changelog.html, search.html, ...) -
    // wait for a real document to be there before check() starts reading
    // it, or an early poll can end up reading a not-yet-navigated page and
    // never recover even once the real one loads.
    await waitForCondition(driver, function () { return document.readyState === "complete"; }, [], 5000);
    result = await check(driver, startedAt);
  } catch (err) {
    result = finish(entry, "FROZEN", `error interacting with the new window: ${err.message}`, startedAt);
  } finally {
    try {
      await withTimeout(
        cleanup ? cleanup(driver) : driver.close(),
        5000,
        `cleanup for "${entry.label}" did not complete within 5000ms`,
      );
    } catch (err) {
      console.error(`Could not clean up after "${entry.label}" (leaving it open): ${err.message}`);
    }
    try { await driver.switchTo().window(mainHandle); } catch (err) {
      console.error(`Could not switch back to the main window after "${entry.label}": ${err.message}`);
    }
  }
  log(`scenario ${entry.id}: ${result.status} (${result.ms}ms)${result.detail ? ` - ${result.detail}` : ""}`);
  return result;
}

/** Superficial scenario coverage beyond per-tool navigation: search (via a
 *  real click, not a synthetic dispatch, since #search-input's own onfocus
 *  handler is the app's real trigger), the version/changelog window, a
 *  representative tool pop-out, both terminal forms, and a real click on a
 *  tool's own Back button. Each only proves the real interaction path works
 *  and a plausible window/panel appears - not deep correctness - and none
 *  of them ever click a repair/reset/kill/write action. Real-app (run.js)
 *  only: run-browser.js's mocked core.invoke never creates real native
 *  windows for search_show/changelog_show/tool_popout/term_popout, so none
 *  of this is reachable there. */
async function runAuxiliaryScenarios(driver, mainHandle, catalog, results) {
  results.push(await runWindowScenario(
    driver, mainHandle,
    { id: "scenario:search", kind: "scenario", label: "Search (real click, type, click a result)" },
    "search.html",
    // app.js's real trigger is #search-input's onfocus handler. A scripted
    // .focus() call didn't reliably fire it in practice, so this uses an
    // actual WebDriver-native click - real input-event synthesis, not a DOM
    // API call - the same as clicking it with a mouse would produce.
    async (driver) => { await driver.findElement(By.id("search-input")).click(); },
    async (scoped, startedAt) => {
      const entry = { id: "scenario:search", kind: "scenario", label: "Search (real click, type, click a result)" };
      const ready = await waitForCondition(scoped, function () { return !!document.getElementById("query"); }, [], 5000);
      if (!ready) return finish(entry, "FAIL_NO_ACTIVATE", "search window opened but #query never appeared", startedAt);
      await scoped.executeScript(function () {
        const input = document.getElementById("query");
        input.value = "git";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const hasResults = await waitForCondition(scoped, function () {
        return document.querySelectorAll("#results [data-index]").length > 0;
      }, [], 4000);
      if (!hasResults) return finish(entry, "FAIL_NO_ACTIVATE", 'typing "git" produced no results', startedAt);
      await scoped.executeScript(function () { document.querySelector("#results [data-index]")?.click(); });
      return finish(entry, "OK", "", startedAt);
    },
  ));
  await sleep(TOOL_SETTLE_MS);

  results.push(await runWindowScenario(
    driver, mainHandle,
    { id: "scenario:changelog", kind: "scenario", label: "Version / changelog (real click)" },
    "changelog.html",
    async (driver) => { await driver.findElement(By.id("status-version")).click(); },
    async (scoped, startedAt) => {
      const entry = { id: "scenario:changelog", kind: "scenario", label: "Version / changelog (real click)" };
      const ok = await waitForCondition(scoped, function () {
        return document.getElementById("releases")?.children.length > 0;
      }, [], 5000);
      if (ok) return finish(entry, "OK", "", startedAt);
      // Diagnostic dump instead of guessing further: exactly what state was
      // this window actually in when the check gave up?
      let diag = "(could not even read diagnostics)";
      try {
        diag = await scoped.executeScript(function () {
          const el = document.getElementById("releases");
          return JSON.stringify({
            readyState: document.readyState,
            title: document.title,
            href: location.href,
            hasTauri: typeof window.__TAURI__ !== "undefined",
            hasChangelogData: typeof window.devhqChangelog !== "undefined",
            releaseCount: window.devhqChangelog?.releases?.length ?? null,
            releasesElExists: !!el,
            releasesChildCount: el?.children.length ?? null,
            releasesInnerHtmlLength: el?.innerHTML.length ?? null,
            bodyInnerHtmlLength: document.body?.innerHTML.length ?? null,
          });
        });
      } catch (err) {
        diag = `(executeScript itself failed: ${err.message})`;
      }
      return finish(entry, "FAIL_NO_ACTIVATE", `changelog window opened but #releases stayed empty - diagnostics: ${diag}`, startedAt);
    },
  ));
  await sleep(TOOL_SETTLE_MS);

  results.push(await runWindowScenario(
    driver, mainHandle,
    { id: "scenario:tool-popout", kind: "scenario", label: 'Tool pop-out ("Anything")' },
    "tool.html",
    async (driver) => { await driver.executeScript(function () { window.devhqShell?.popOutTool?.("any"); }); },
    async (scoped, startedAt) => {
      const entry = { id: "scenario:tool-popout", kind: "scenario", label: 'Tool pop-out ("Anything")' };
      const ok = await waitForCondition(scoped, function () {
        return (document.getElementById("pop-name")?.textContent || "").trim().length > 0;
      }, [], 8000);
      return ok
        ? finish(entry, "OK", "", startedAt)
        : finish(entry, "FAIL_NO_ACTIVATE", "tool pop-out opened but never got a name", startedAt);
    },
    // Dock it back the way a real user would (#pop-dock, tool.html), not
    // driver.close(): forcing the window away leaves app.js's
    // state.toolPopouts believing "any" is still popped out, so the next
    // real openTool("any") tries to focus a now-nonexistent window instead
    // of reopening it in the main window - see runWindowScenario()'s doc
    // comment.
    async (scoped) => {
      await scoped.executeScript(function () { document.getElementById("pop-dock")?.click(); });
      await sleep(500);
    },
  ));
  await sleep(TOOL_SETTLE_MS);

  results.push(await runWindowScenario(
    driver, mainHandle,
    { id: "scenario:terminal-popout", kind: "scenario", label: "Terminal pop-out" },
    "terminal.html",
    async (driver) => { await driver.executeScript(function () { window.openTerminalWindow?.(); }); },
    async (scoped, startedAt) => {
      const entry = { id: "scenario:terminal-popout", kind: "scenario", label: "Terminal pop-out" };
      const ok = await waitForCondition(scoped, function () { return !!document.getElementById("pop-project"); }, [], 8000);
      return ok
        ? finish(entry, "OK", "", startedAt)
        : finish(entry, "FAIL_NO_ACTIVATE", "terminal pop-out opened but never mounted", startedAt);
    },
  ));
  await sleep(TOOL_SETTLE_MS);

  // Terminal dock: an in-page panel, no window switch needed.
  {
    const entry = { id: "scenario:terminal-dock", kind: "scenario", label: "Terminal (docked panel)" };
    const startedAt = Date.now();
    try {
      await driver.executeScript(function () { window.openTerminalPanel?.(); });
      const ok = await waitForCondition(driver, function () {
        const dock = document.getElementById("term-dock");
        return !!dock && !dock.hidden;
      }, [], 5000);
      results.push(ok
        ? finish(entry, "OK", "", startedAt)
        : finish(entry, "FAIL_NO_ACTIVATE", "#term-dock never appeared", startedAt));
    } catch (err) {
      results.push(finish(entry, "FREEZE_ON_DISPATCH", err.message, startedAt));
    }
  }
  await sleep(TOOL_SETTLE_MS);

  // A real click on a tool's own Back button, not the synthetic dispatch
  // every other check in this suite uses - proves the actual DOM wiring
  // works, not just the event contract.
  {
    const entry = { id: "scenario:real-back-click", kind: "scenario", label: "Back button (real click, not dispatch)" };
    const startedAt = Date.now();
    const overview = catalog[0];
    const anyTool = catalog.find((e) => e.id === "any") || catalog.find((e) => e.isolated);
    try {
      await dispatchOpen(driver, anyTool.id);
      const opened = await pollForState(driver, anyTool, Date.now());
      if (opened.status !== "OK") {
        results.push(finish(entry, "FAIL_NO_ACTIVATE", `could not open "${anyTool.label}" to test its Back button`, startedAt));
      } else {
        await driver.executeScript(function () {
          document.querySelector('.isolated-tool-head [data-open-tool="overview"]')?.click();
        });
        const backOk = await waitForCondition(driver, overview.checkFn, overview.checkArgs, 5000);
        results.push(backOk
          ? finish(entry, "OK", "", startedAt)
          : finish(entry, "FAIL_NO_ACTIVATE", "clicking Back did not return to Overview", startedAt));
      }
    } catch (err) {
      results.push(finish(entry, "FROZEN", err.message, startedAt));
    }
    // Whatever state that Back click left us in, make sure we're on
    // Overview before the caller (main()) writes the report and exits.
    await dispatchOpen(driver, "overview").catch(() => {});
  }
}

// DEEP_CHECK_UNSUPPORTED is an expected, graceful outcome (this machine's
// tauri-driver/WebView2 automation doesn't expose the isolated tool's child
// webview as its own window handle) - not a regression, so it's shown but
// never counted as one.
const NEUTRAL_STATUSES = new Set(["DEEP_CHECK_UNSUPPORTED"]);
const isRegression = (r) => r.status !== "OK" && r.status !== "DEEP_CHECK_OK" && !NEUTRAL_STATUSES.has(r.status);

function printReport(results) {
  const width = Math.max(...results.map((r) => r.id.length), 10);
  console.log("");
  console.log(`${"ID".padEnd(width)}  STATUS                 DETAIL`);
  console.log("-".repeat(width + 60));
  for (const r of results) {
    const ok = r.status === "OK" || r.status === "DEEP_CHECK_OK";
    const neutral = NEUTRAL_STATUSES.has(r.status);
    const line = `${r.id.padEnd(width)}  ${r.status.padEnd(22)}  ${r.detail}`;
    console.log(ok ? line : neutral ? `\x1b[33m${line}\x1b[0m` : `\x1b[31m${line}\x1b[0m`);
  }
  console.log("");
  const failing = results.filter(isRegression);
  const neutral = results.filter((r) => NEUTRAL_STATUSES.has(r.status));
  console.log(`${results.length} checks, ${failing.length} regressions${neutral.length ? `, ${neutral.length} deep-check unsupported (not a regression)` : ""}.`);
  if (failing.length) {
    console.log("");
    console.log("Regressions:");
    for (const r of failing) {
      console.log(`  - [${r.kind}] ${r.label} (${r.id}): ${r.status} - ${r.detail}`);
    }
  }
}

async function main() {
  log(`Run started. Full log: ${LOG_PATH}`);
  console.log(`Logging every step to ${LOG_PATH} - check it after a hang or a confusing result.`);
  if (process.platform !== "win32") {
    console.error("This suite drives the real WebView2-hosted app via tauri-driver and only runs on Windows.");
    process.exit(1);
  }
  // Auto-build only targets the default release path - cargo always
  // produces that one, so building toward a custom DEVHQ_E2E_EXE wouldn't
  // make sense. Pointing DEVHQ_E2E_EXE somewhere else is opting out of
  // auto-build, the same as DEVHQ_E2E_SKIP_BUILD.
  const usingDefaultExe = !process.env.DEVHQ_E2E_EXE;
  if (SKIP_BUILD || !usingDefaultExe) {
    if (!fs.existsSync(APP_EXE)) {
      console.error(`Built app not found at: ${APP_EXE}`);
      console.error(!usingDefaultExe
        ? "DEVHQ_E2E_EXE points somewhere custom, so this suite won't build it for you."
        : "DEVHQ_E2E_SKIP_BUILD=1 was set, so this suite won't build it for you.");
      process.exit(1);
    }
  } else if (needsRebuild(APP_EXE)) {
    log("Build is stale or missing, rebuilding...");
    try {
      await runCargoBuild();
    } catch (err) {
      log(`Build failed: ${err.message}`);
      console.error(err.message);
      process.exit(1);
    }
    log("Build finished.");
  } else {
    console.log(`Build is up to date: ${APP_EXE}`);
    log(`Build is up to date: ${APP_EXE}`);
  }
  fs.mkdirSync(FALLBACK_SCAN_ROOT, { recursive: true });

  const catalog = buildCatalog();
  console.log(`Visiting ${catalog.length} screens/tools against ${APP_EXE}`);
  log(`Catalog built: ${catalog.length} entries.`);

  const driverProc = await spawnTauriDriver();
  let driver = null;
  const results = [];
  try {
    log("Creating WebDriver session (this launches the app)...");
    driver = await new Builder()
      .usingServer(`http://127.0.0.1:${DRIVER_PORT}`)
      .withCapabilities({
        browserName: "wry",
        "tauri:options": { application: APP_EXE },
      })
      .build();
    await driver.manage().setTimeouts({ script: SCRIPT_TIMEOUT_MS });
    const mainHandle = await driver.getWindowHandle();
    log(`WebDriver session created. Main window handle: ${mainHandle}`);

    // dismissFirstRunOnboarding() polls for its own dialogs to appear, so it
    // already absorbs whatever time the shell needs to finish mounting
    // before the first real dispatch - no fixed pre-delay needed on top.
    await dismissFirstRunOnboarding(driver);

    // Confirm we actually land on Overview before measuring anything else.
    await visit(driver, mainHandle, catalog[0], results);

    for (const entry of catalog.slice(1)) {
      await visit(driver, mainHandle, entry, results);
      await sleep(TOOL_VISIBLE_MS);
      await bounceToOverview(driver, catalog, entry, results);
      log(`Settling ${TOOL_SETTLE_MS}ms before the next tool...`);
      await sleep(TOOL_SETTLE_MS);
    }

    log("Main catalog loop finished. Running auxiliary scenarios...");
    await runAuxiliaryScenarios(driver, mainHandle, catalog, results);
    log("Auxiliary scenarios finished.");
  } finally {
    log("Tearing down: quitting WebDriver session and killing tauri-driver...");
    if (driver) {
      try { await driver.quit(); } catch (err) { console.error(`driver.quit() failed: ${err.message}`); }
    }
    driverProc.kill();
    log("Teardown complete.");
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(results, null, 2));
  log(`Run finished. ${results.length} results written to ${REPORT_PATH}.`);
  printReport(results);
  process.exit(results.some(isRegression) ? 1 : 0);
}

process.on("SIGINT", () => {
  log("Interrupted (Ctrl+C) - see the last logged step above for where it was stuck.");
  process.exit(130);
});

main().catch((err) => {
  log(`Crashed: ${err.stack || err.message}`);
  console.error("Integration test crashed:", err);
  process.exit(1);
});
