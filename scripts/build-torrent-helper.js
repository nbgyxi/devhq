#!/usr/bin/env node
//
// Builds the torrent engine, which is a crate of its own inside `src-tauri`.
//
// It has to exist before `tauri build` runs, because tauri.conf.json bundles
// `target/release/wint-torrent-helper.exe` as a resource and the bundle step
// fails on a resource that is not there. Development also calls this with
// `--debug`, otherwise an old debug helper can survive UI/backend rebuilds.
//
// The PATH dance is the same one `tauri-with-cargo-path.js` does: cargo lives
// in the user profile and is not always on PATH for a spawned build.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cargoBin = path.join(os.homedir(), ".cargo", "bin");
const parts = (process.env.PATH || "").split(path.delimiter);
if (fs.existsSync(cargoBin) && !parts.some((p) => p.toLowerCase() === cargoBin.toLowerCase())) {
  process.env.PATH = [cargoBin, ...parts].join(path.delimiter);
}

const debug = process.argv.includes("--debug");
const cargoArgs = ["build"];
if (!debug) cargoArgs.push("--release");
cargoArgs.push("-p", "wint-torrent-helper");

const child = spawn("cargo", cargoArgs, {
  cwd: path.join(__dirname, "..", "src-tauri"),
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code || 0);
});
