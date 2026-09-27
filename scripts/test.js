#!/usr/bin/env node
//
// Everything this repo can check without the app running, in one command.
//
// CLAUDE.md's rule is that WinT is verified without ever launching its window,
// which leaves four separate suites that were each remembered by hand and so
// were each quietly rotting between runs. They go in one order here, cheapest
// first, so a syntax slip is reported in a second rather than after a Rust
// link:
//
//   1. `node --check` over every front-end file - no build step means nothing
//      else ever parses them.
//   2. The two catalog smoke tests, which read src/ in a sandbox.
//   3. The headless front-end suite, which opens every screen and tool.
//   4. `cargo test`, for the Rust side and the torrent helper.
//
// Pass `--rust` or `--front` to run only that half; `--skip-e2e` leaves out
// step 3, which is the only step needing `npx playwright install chromium`.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const SRC = path.join(REPO_ROOT, "src");

// cargo lives in the user profile and is not always on PATH for a spawned
// build - the same dance `tauri-with-cargo-path.js` does.
const cargoBin = path.join(os.homedir(), ".cargo", "bin");
const parts = (process.env.PATH || "").split(path.delimiter);
if (fs.existsSync(cargoBin) && !parts.some((p) => p.toLowerCase() === cargoBin.toLowerCase())) {
  process.env.PATH = [cargoBin, ...parts].join(path.delimiter);
}

const args = process.argv.slice(2);
const only = args.includes("--rust") ? "rust" : args.includes("--front") ? "front" : "both";
const skipE2e = args.includes("--skip-e2e");

const results = [];

function run(label, command, commandArgs, options = {}) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const started = Date.now();
  // No shell: everything spawned here is a real executable, and a shell would
  // only break on the spaces in node's own install path.
  const done = spawnSync(command, commandArgs, {
    cwd: options.cwd || REPO_ROOT,
    env: process.env,
    stdio: "inherit",
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = !done.error && done.status === 0;
  if (done.error) process.stdout.write(`${done.error.message}\n`);
  results.push({ label, ok, seconds });
  return ok;
}

/** Every front-end file parses. With no build step, nothing else checks this. */
function parseCheck() {
  const files = fs
    .readdirSync(SRC)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(SRC, name));
  process.stdout.write(`\n=== front end parses (${files.length} files) ===\n`);
  const started = Date.now();
  const broken = [];
  for (const file of files) {
    const done = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (done.status !== 0) {
      broken.push(path.basename(file));
      process.stdout.write(`${done.stderr || ""}`);
    }
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (!broken.length) process.stdout.write(`all ${files.length} files parse\n`);
  results.push({ label: "front end parses", ok: broken.length === 0, seconds });
  return broken.length === 0;
}

if (only !== "rust") {
  parseCheck();
  run("util tool catalog", process.execPath, ["scripts/smoke-util-tools.js"]);
  run("windows tool catalog", process.execPath, ["scripts/smoke-windows-tools.js"]);
  if (!skipE2e) run("every screen and tool opens", process.execPath, ["scripts/e2e/run-browser.js"]);
}

if (only !== "front") {
  const rust = path.join(REPO_ROOT, "src-tauri");
  run("cargo test", "cargo", ["test"], { cwd: rust });
  run("cargo test (torrent helper)", "cargo", ["test", "-p", "wint-torrent-helper"], { cwd: rust });
}

process.stdout.write("\n");
for (const { label, ok, seconds } of results) {
  process.stdout.write(`${ok ? "ok    " : "FAILED"}  ${label} (${seconds}s)\n`);
}
const failed = results.filter((result) => !result.ok);
process.stdout.write(
  failed.length
    ? `\n${failed.length} of ${results.length} suites failed.\n`
    : `\nAll ${results.length} suites passed.\n`,
);
process.exit(failed.length ? 1 : 0);
