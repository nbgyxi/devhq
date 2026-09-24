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

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cargoBin = path.join(os.homedir(), ".cargo", "bin");
const parts = (process.env.PATH || "").split(path.delimiter);
if (fs.existsSync(cargoBin) && !parts.some((p) => p.toLowerCase() === cargoBin.toLowerCase())) {
  process.env.PATH = [cargoBin, ...parts].join(path.delimiter);
}

// The engine outlives the app on purpose — it keeps the torrents going across a
// WinT restart — so one from an earlier run is still holding
// wint-torrent-helper.exe open, and Windows will not let cargo replace a file
// that is in use. The trap that sets is worse than the error it prints: the
// build fails with "Access is denied (os error 5)", the old exe stays where it
// was, and the next run is the old engine with none of the changes in it.
function runningHelpers() {
  if (process.platform !== "win32") return [];
  try {
    const output = execFileSync(
      "tasklist",
      ["/fi", "imagename eq wint-torrent-helper.exe", "/nh", "/fo", "csv"],
      { encoding: "utf8" },
    );
    return output
      .split("\n")
      .map((line) => /^"wint-torrent-helper\.exe","(\d+)"/i.exec(line.trim()))
      .filter(Boolean)
      .map((match) => match[1]);
  } catch {
    return [];
  }
}

// Stopping it is what WinT itself does to a helper it does not own (see
// `kill_stray_helpers`): an engine left by an earlier run holds the DHT port as
// well as this file, and the next one cannot start while it is there. Nothing
// is lost by stopping it — the torrents are saved in the state folder and come
// back when the engine starts again — so this does it rather than ending the
// build with an instruction.
function stopStrayHelpers(helpers) {
  if (!helpers.length) return;
  console.log(
    `Stopping a torrent engine from an earlier run (PID ${helpers.join(", ")}); it is holding\n` +
      "wint-torrent-helper.exe open, and Windows will not let this build replace a file in use.",
  );
  for (const pid of helpers) {
    try {
      execFileSync("taskkill", ["/pid", pid, "/f"], { stdio: "ignore" });
    } catch {
      console.warn(`Could not stop PID ${pid}. Close WinT and build again.`);
    }
  }
  // The exe stays locked until the kernel has finished tearing the process
  // down, which is not instant after taskkill returns.
  const until = Date.now() + 5000;
  while (runningHelpers().length && Date.now() < until) {
    try {
      execFileSync("timeout", ["/t", "1", "/nobreak"], { stdio: "ignore" });
    } catch {
      break;
    }
  }
}

stopStrayHelpers(runningHelpers());

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
  if (signal) return process.kill(process.pid, signal);
  if (code && runningHelpers().length) {
    // The engine came back during the build, which means WinT is open: its
    // supervisor starts a new one within a second or two of the old one dying,
    // by design. Stopping the engine again would only lose the same race, so
    // the one thing that frees the file is said instead. Silence here would be
    // the worst outcome of all: a build that "failed" while leaving yesterday's
    // engine in place, so the next run shows none of the changes.
    console.error(
      [
        "",
        "The build could not replace wint-torrent-helper.exe: an engine is running, and Windows",
        "does not let anything overwrite a running program. Killing it is not enough — WinT treats",
        "an engine that dies on its own as a fault and starts another within a second or two.",
        "",
        "Turn the engine off deliberately instead — the Torrents switch on WinT's home screen — and",
        "the supervisor leaves it off. Then build again; WinT itself can stay open. The torrents are",
        "saved in the state folder and come back when you turn it on again.",
        "",
      ].join("\n"),
    );
  }
  process.exit(code || 0);
});
