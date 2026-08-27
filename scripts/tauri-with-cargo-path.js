#!/usr/bin/env node

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cargoBin = path.join(os.homedir(), ".cargo", "bin");
const pathParts = (process.env.PATH || "").split(path.delimiter);

if (fs.existsSync(cargoBin) && !pathParts.some((part) => part.toLowerCase() === cargoBin.toLowerCase())) {
  process.env.PATH = [cargoBin, ...pathParts].join(path.delimiter);
}

const binName = process.platform === "win32" ? "tauri.cmd" : "tauri";
const child = spawn(binName, process.argv.slice(2), {
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code || 0);
  }
});
