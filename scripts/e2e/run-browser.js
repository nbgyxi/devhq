#!/usr/bin/env node
/**
 * Drives the front end through every screen and tool in a plain headless
 * browser (Playwright + Chromium), with window.__TAURI__ replaced by a
 * generic stub (see tauri-stub.js). No Tauri runtime, no built app, no OS
 * driver, no version-matched WebDriver to install - just `npm install` and
 * `npx playwright install chromium` once.
 *
 * What this catches: a screen that fails to open, a tool that renders an
 * error state, a genuine front-end hang (a synchronous loop or O(n^2) DOM
 * thrash that blocks the page's own main thread - a page.evaluate() call
 * literally cannot return while that's happening, which is what FROZEN /
 * FREEZE_ON_DISPATCH are built on), and a renderer crash (the tab itself
 * dies - reported as CRASHED, and the suite recovers with a fresh page so
 * one crashing tool doesn't take the rest of the run down with it). A crash
 * often isn't visible to Playwright at the exact moment a call times out -
 * see reconcileCrash() below - so every timeout gets a brief recheck before
 * it's taken at face value.
 *
 * What this does NOT catch: a real Rust command hanging the app's actual
 * main thread, since window.__TAURI__.core.invoke is mocked here and never
 * touches the real backend. For that, use run.js (needs tauri-driver and a
 * release build - see README.md).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { buildCatalog } = require("./catalog");
const { stubSource } = require("./tauri-stub");
const { serveDir } = require("./static-server");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC_DIR = path.join(REPO_ROOT, "src");
const STEP_TIMEOUT_MS = Number(process.env.WINT_E2E_STEP_TIMEOUT_MS || 4000);
const SCRIPT_TIMEOUT_MS = Number(process.env.WINT_E2E_SCRIPT_TIMEOUT_MS || 2500);
const POLL_INTERVAL_MS = 150;
// A genuinely wedged main thread can take a long time to actually bring the
// tab down (observed ~25s in one real case) - long past this suite's normal
// per-step timeout, and often longer than it's worth waiting on. This is
// purely to enrich the report with a confirmed CRASHED label when the tab
// dies quickly; recovery itself does NOT wait on this (see needsRecovery) -
// a page that's still "open" but permanently pegged is exactly as useless
// for further testing as one that's actually closed.
const CRASH_RECHECK_INTERVAL_MS = 1500;
const CRASH_RECHECK_ATTEMPTS = 3;
const REPORT_PATH = path.join(__dirname, "last-run-report.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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

async function evalChecked(session, fn, args, timeoutMessage) {
  return withTimeout(session.page.evaluate(fn, ...args), SCRIPT_TIMEOUT_MS, timeoutMessage);
}

async function pollForState(session, entry, startedAt) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let state;
    try {
      state = await evalChecked(
        session,
        entry.checkFn,
        entry.checkArgs,
        `page.evaluate() did not return within ${SCRIPT_TIMEOUT_MS}ms - the page's main thread appears wedged`,
      );
    } catch (err) {
      return finish(entry, "FROZEN", err.message, startedAt);
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

async function dispatchOpen(session, id) {
  return evalChecked(
    session,
    (toolId) => { window.dispatchEvent(new CustomEvent("wint:open-tool", { detail: { id: toolId } })); },
    [id],
    `dispatching navigation to "${id}" did not return within ${SCRIPT_TIMEOUT_MS}ms - the page's main thread appears wedged`,
  );
}

/** True for a result that means the page may no longer be usable for further
 *  testing: FROZEN/FREEZE_ON_DISPATCH mean a page.evaluate() call never came
 *  back, and a main thread that wedged once for one tool has no reason to
 *  un-wedge for the next one. RENDERED_WITH_ERROR and FAIL_NO_ACTIVATE both
 *  imply the page answered (just not the way expected), so it's still fine
 *  to keep testing on. */
function isWedged(result) {
  return result.status === "FROZEN" || result.status === "FREEZE_ON_DISPATCH" || result.status === "CRASHED";
}

/** A page.evaluate() that times out because the renderer just crashed looks
 *  identical, in the instant it fails, to a genuine hang: Playwright hasn't
 *  necessarily flagged the page closed yet. This is a short, best-effort
 *  check to upgrade the report from FROZEN to the more precise CRASHED when
 *  the tab dies quickly - it does NOT gate recovery (see isWedged/main()):
 *  a page that's still technically "open" but permanently pegged at 100%
 *  CPU is exactly as useless for further testing as one that's actually
 *  closed, so recovery happens either way. */
async function reconcileCrash(session, result) {
  if (!isWedged(result)) return;
  for (let attempt = 0; attempt < CRASH_RECHECK_ATTEMPTS; attempt++) {
    if (session.page.isClosed()) {
      result.status = "CRASHED";
      result.detail = `the page/tab died shortly after this step's own timeout, which was its first symptom: ${result.detail}`;
      return;
    }
    await sleep(CRASH_RECHECK_INTERVAL_MS);
  }
}

async function visit(session, entry, results) {
  const startedAt = Date.now();
  let result;
  try {
    await dispatchOpen(session, entry.id);
    result = await pollForState(session, entry, startedAt);
  } catch (err) {
    result = finish(entry, "FREEZE_ON_DISPATCH", err.message, startedAt);
  }
  results.push(result);
  await reconcileCrash(session, result);
  return isWedged(result);
}

/** See above for why a leave-check gets its own reconciliation. Beyond
 *  crash recovery, this also catches a plain "blocks navigation" bug: a
 *  leave-confirmation or stuck state on one tool that isn't a crash at all,
 *  just stops the next navigation from ever landing - reported against the
 *  tool that was left, since that's what a person would blame too. */
async function bounceToOverview(session, catalog, justVisited, results) {
  const overview = catalog[0];
  const leaveId = `${justVisited.id}:leave`;
  const leaveLabel = `Leaving ${justVisited.label}`;
  const leaveEntry = { id: leaveId, kind: "navigation", label: leaveLabel };
  const startedAt = Date.now();
  let result;
  try {
    await dispatchOpen(session, "overview");
    result = await pollForState(session, overview, startedAt);
  } catch (err) {
    result = finish(leaveEntry, "FREEZE_ON_DISPATCH", err.message, startedAt);
  }
  if (result.status === "OK") return false;
  result.id = leaveId;
  result.label = leaveLabel;
  results.push(result);
  await reconcileCrash(session, result);
  return isWedged(result);
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

const ONBOARDING_TIMEOUT_MS = 15000;

/** browser.newPage() opens an isolated context with blank localStorage, so
 *  app.js treats it as a fresh install every time and runs its onboarding
 *  sequence (firstRunLanguage -> firstRunFolders -> firstRunUsageData, all
 *  in app.js) - each a full-window modal (.language-first-run) that nothing
 *  in this suite's navigation-only dispatching clicks through on its own.
 *  Click through all three, the same way a real first-time user would, so
 *  the modal isn't still sitting over everything for the rest of the run.
 *  See run.js's dismissFirstRunOnboarding() for the same logic against the
 *  real app - kept as a separate copy since one drives via WebDriver's
 *  executeAsyncScript and the other via a plain Promise page.evaluate can
 *  await, not because the sequence itself differs. */
async function dismissFirstRunOnboarding(page) {
  const result = await withTimeout(
    page.evaluate(
      ({ fallbackRoot, timeoutMs }) => new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        let steps = 0;
        function tick() {
          if (Date.now() > deadline) return resolve({ timedOut: true, steps });
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
          if (document.querySelector(".language-first-run")) return setTimeout(tick, 300);
          resolve({ timedOut: false, steps });
        }
        tick();
      }),
      { fallbackRoot: SRC_DIR, timeoutMs: ONBOARDING_TIMEOUT_MS },
    ),
    ONBOARDING_TIMEOUT_MS + 3000,
    "onboarding dismissal did not resolve in time",
  ).catch((err) => ({ timedOut: true, steps: 0, error: err.message }));
  if (result.steps > 0) {
    console.log(`Dismissed ${result.steps} first-run onboarding step(s)${result.timedOut ? " (timed out waiting for more)" : ""}.`);
  }
}

/** Opens a fresh page against the served front end, with the Tauri stub and
 *  console/error capture wired in. Used both for the initial page and to
 *  recover after a renderer crash mid-run. */
async function openSession(browser, site, consoleErrors) {
  const page = await browser.newPage();
  page.on("pageerror", (err) => consoleErrors.push(`uncaught exception: ${err.message}`));
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(`console.error: ${msg.text()}`); });
  page.on("dialog", (dialog) => { consoleErrors.push(`native ${dialog.type()} dialog: ${dialog.message()}`); dialog.dismiss().catch(() => {}); });
  await page.addInitScript(stubSource());
  await page.goto(`${site.url}/index.html`, { waitUntil: "load" });
  // Give the shell's initial mount (mountShell in app.js) a moment to run
  // before the very first navigation is dispatched against it.
  await page.waitForSelector("#search-input", { timeout: 10000 }).catch(() => {});
  await dismissFirstRunOnboarding(page);
  return { page };
}

async function main() {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    console.error("playwright isn't installed. Run once: npm install && npx playwright install chromium");
    process.exit(1);
  }

  const site = await serveDir(SRC_DIR);
  const launchOptions = {};
  if (process.env.WINT_E2E_CHROMIUM_PATH) launchOptions.executablePath = process.env.WINT_E2E_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOptions);
  const consoleErrors = [];

  const results = [];
  try {
    let session = await openSession(browser, site, consoleErrors);
    const catalog = buildCatalog();
    console.log(`Visiting ${catalog.length} screens/tools (headless, mocked backend)`);

    if (await visit(session, catalog[0], results)) {
      session = await openSession(browser, site, consoleErrors);
    }
    for (const entry of catalog.slice(1)) {
      if (await visit(session, entry, results)) {
        session = await openSession(browser, site, consoleErrors);
        continue;
      }
      if (await bounceToOverview(session, catalog, entry, results)) {
        session = await openSession(browser, site, consoleErrors);
      }
    }
  } finally {
    await browser.close();
    await site.close();
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify({ results, consoleErrors }, null, 2));
  printReport(results);
  if (consoleErrors.length) {
    console.log(`\n${consoleErrors.length} browser console error(s)/exception(s)/dialog(s) were seen during the run (see ${path.relative(REPO_ROOT, REPORT_PATH)}).`);
    console.log("These may be caused by the mocked backend returning a shape a screen didn't expect, not necessarily a real app bug - see README.md.");
  }
  process.exit(results.some((r) => r.status !== "OK") ? 1 : 0);
}

main().catch((err) => {
  console.error("Integration test crashed:", err);
  process.exit(1);
});
