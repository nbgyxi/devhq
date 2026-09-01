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
 *   3. Build the app: cargo build --release --manifest-path src-tauri/Cargo.toml --bin devhq
 *
 * Then just run: npm run test:e2e
 *
 * What this does and does not check:
 *   - It navigates to every screen/tool the exact way the app's own pin
 *     chips and back buttons do (dispatching the same "devhq:open-tool"
 *     event app.js already listens for), then reads the real DOM to prove
 *     the right thing is actually on screen and didn't render an error.
 *   - It deliberately never clicks into an action inside a tool (starting a
 *     disk scan, killing a process, running a repair, closing a terminal),
 *     so it's safe to re-run repeatedly. It is a "does this screen open and
 *     respond" smoke test, not a correctness test of every tool's logic.
 *   - Freezes are detected two ways: (a) a step that never reaches its
 *     expected on-screen state within its time budget, and (b) a WebDriver
 *     script call that itself never returns, which only happens when the
 *     app's main thread is genuinely wedged (not just slow).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { Builder } = require("selenium-webdriver");

const { buildCatalog } = require("./catalog");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_EXE = path.join(REPO_ROOT, "src-tauri", "target", "release", "devhq.exe");
const APP_EXE = process.env.DEVHQ_E2E_EXE || DEFAULT_EXE;
const DRIVER_PORT = Number(process.env.DEVHQ_E2E_PORT || 4444);
const STEP_TIMEOUT_MS = Number(process.env.DEVHQ_E2E_STEP_TIMEOUT_MS || 6000);
const SCRIPT_TIMEOUT_MS = Number(process.env.DEVHQ_E2E_SCRIPT_TIMEOUT_MS || 3000);
const POLL_INTERVAL_MS = 250;
const DRIVER_START_TIMEOUT_MS = 15000;
const REPORT_PATH = path.join(__dirname, "last-run-report.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const proc = spawn("tauri-driver", ["--port", String(DRIVER_PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let spawnError = null;
  proc.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  proc.on("error", (err) => { spawnError = err; });
  try {
    await waitForDriverReady(DRIVER_PORT, Date.now() + DRIVER_START_TIMEOUT_MS);
  } catch (err) {
    proc.kill();
    console.error((spawnError || err).message);
    console.error("Is tauri-driver installed? Install it once with: cargo install tauri-driver --locked");
    if (stderr) console.error(stderr);
    process.exit(1);
  }
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
  while (Date.now() < deadline) {
    let state;
    try {
      state = await driver.executeScript(entry.checkFn, ...entry.checkArgs);
    } catch (err) {
      return finish(entry, "FROZEN", `WebDriver script did not return: ${err.message}`, startedAt);
    }
    if (state && state.active) {
      return state.errorText
        ? finish(entry, "RENDERED_WITH_ERROR", state.errorText, startedAt)
        : finish(entry, "OK", "", startedAt);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return finish(entry, "FAIL_NO_ACTIVATE", `did not become active within ${STEP_TIMEOUT_MS}ms`, startedAt);
}

async function dispatchOpen(driver, id) {
  return driver.executeScript(function (toolId) {
    window.dispatchEvent(new CustomEvent("devhq:open-tool", { detail: { id: toolId } }));
  }, id);
}

async function visit(driver, entry, results) {
  const startedAt = Date.now();
  try {
    await dispatchOpen(driver, entry.id);
  } catch (err) {
    results.push(finish(entry, "FREEZE_ON_DISPATCH", `WebDriver could not even dispatch navigation: ${err.message}`, startedAt));
    return;
  }
  results.push(await pollForState(driver, entry, startedAt));
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
  try {
    await dispatchOpen(driver, "overview");
  } catch (err) {
    results.push(finish(
      { id: leaveId, kind: "navigation", label: leaveLabel },
      "FREEZE_ON_DISPATCH",
      `WebDriver could not dispatch navigation back to Overview: ${err.message}`,
      startedAt,
    ));
    return;
  }
  const result = await pollForState(driver, overview, startedAt);
  if (result.status !== "OK") {
    results.push({ ...result, id: leaveId, label: leaveLabel });
  }
}

function printReport(results) {
  const width = Math.max(...results.map((r) => r.id.length), 10);
  console.log("");
  console.log(`${"ID".padEnd(width)}  STATUS                 DETAIL`);
  console.log("-".repeat(width + 60));
  for (const r of results) {
    const bad = r.status !== "OK";
    const line = `${r.id.padEnd(width)}  ${r.status.padEnd(22)}  ${r.detail}`;
    console.log(bad ? `\x1b[31m${line}\x1b[0m` : line);
  }
  console.log("");
  const failing = results.filter((r) => r.status !== "OK");
  console.log(`${results.length} checks, ${failing.length} regressions.`);
  if (failing.length) {
    console.log("");
    console.log("Regressions:");
    for (const r of failing) {
      console.log(`  - [${r.kind}] ${r.label} (${r.id}): ${r.status} - ${r.detail}`);
    }
  }
}

async function main() {
  if (process.platform !== "win32") {
    console.error("This suite drives the real WebView2-hosted app via tauri-driver and only runs on Windows.");
    process.exit(1);
  }
  if (!fs.existsSync(APP_EXE)) {
    console.error(`Built app not found at: ${APP_EXE}`);
    console.error("Build it first: cargo build --release --manifest-path src-tauri/Cargo.toml --bin devhq");
    console.error("(or set DEVHQ_E2E_EXE to point at an existing build)");
    process.exit(1);
  }

  const catalog = buildCatalog();
  console.log(`Visiting ${catalog.length} screens/tools against ${APP_EXE}`);

  const driverProc = await spawnTauriDriver();
  let driver = null;
  const results = [];
  try {
    driver = await new Builder()
      .usingServer(`http://127.0.0.1:${DRIVER_PORT}`)
      .withCapabilities({
        browserName: "wry",
        "tauri:options": { application: APP_EXE },
      })
      .build();
    await driver.manage().setTimeouts({ script: SCRIPT_TIMEOUT_MS });

    // Confirm we actually land on Overview before measuring anything else.
    await visit(driver, catalog[0], results);

    for (const entry of catalog.slice(1)) {
      await visit(driver, entry, results);
      await bounceToOverview(driver, catalog, entry, results);
    }
  } finally {
    if (driver) {
      try { await driver.quit(); } catch (err) { console.error(`driver.quit() failed: ${err.message}`); }
    }
    driverProc.kill();
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(results, null, 2));
  printReport(results);
  process.exit(results.some((r) => r.status !== "OK") ? 1 : 0);
}

main().catch((err) => {
  console.error("Integration test crashed:", err);
  process.exit(1);
});
