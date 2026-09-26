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

const { spawn, execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cargoBin = path.join(os.homedir(), ".cargo", "bin");
const parts = (process.env.PATH || "").split(path.delimiter);
if (fs.existsSync(cargoBin) && !parts.some((p) => p.toLowerCase() === cargoBin.toLowerCase())) {
  process.env.PATH = [cargoBin, ...parts].join(path.delimiter);
}

// Windows' `timeout.exe` refuses to run with its input redirected, which is
// exactly how a child process of a build script is always run: it exits with
// "input redirection is not supported" the instant it is called. Used as a
// sleep it therefore threw on the first turn of the wait loop below and broke
// out of it, so the grace period meant to let the kernel finish closing the
// old engine's handles was never waited at all — the build went straight on to
// cargo, and cargo hit the file while it was still locked.
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Is WinT itself up? It decides what to say when the file cannot be freed:
 *  a running WinT restarts its engine within a second or two by design, while
 *  a helper with no WinT behind it is an orphan and simply has to go. */
function wintRunning() {
  if (process.platform !== "win32") return false;
  try {
    const out = execFileSync("tasklist", ["/fi", "imagename eq wint.exe", "/nh", "/fo", "csv"], {
      encoding: "utf8",
    });
    return /^"wint\.exe"/im.test(out.trim());
  } catch {
    return false;
  }
}

/** Whether the exe can be replaced right now.
 *
 *  The process list is the wrong thing to wait on: a process disappears from
 *  it before the kernel has finished closing the handles it held, and it is
 *  the handle — not the process — that makes cargo fail. Opening the file for
 *  writing asks the question cargo is about to ask. */
function replaceable(exe) {
  if (!fs.existsSync(exe)) return true;
  try {
    fs.closeSync(fs.openSync(exe, "r+"));
    return true;
  } catch {
    return false;
  }
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
    const killed = spawnSync("taskkill", ["/pid", pid, "/f"], { encoding: "utf8" });
    if (killed.status === 0) continue;
    const said = `${killed.stderr || ""}${killed.stdout || ""}`.trim();
    // An engine started by an elevated WinT cannot be stopped from an ordinary
    // terminal, and no amount of waiting changes that. Saying which of the two
    // it is saves trying the same build again and getting the same error.
    if (/access is denied/i.test(said)) {
      console.warn(
        `PID ${pid} belongs to a WinT running as administrator; this terminal cannot stop it.\n` +
          "Build from an administrator terminal, or close that WinT first.",
      );
    } else {
      console.warn(`Could not stop PID ${pid}${said ? `: ${said}` : "."}`);
    }
  }
  // The exe stays locked until the kernel has finished tearing the process
  // down, which is not instant after taskkill returns — and the process is out
  // of the task list before its handles are gone, so the file itself is what
  // has to be waited on.
  const until = Date.now() + 10000;
  while (!replaceable(EXE) && Date.now() < until) sleep(250);
}

const debug = process.argv.includes("--debug");
const EXE = path.join(
  __dirname,
  "..",
  "src-tauri",
  "target",
  debug ? "debug" : "release",
  "wint-torrent-helper.exe",
);

stopStrayHelpers(runningHelpers());

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
    // Two different situations end up here and they need opposite advice, so
    // the one being looked at is checked rather than assumed. Telling someone
    // to flip a switch in an app that is not running is worse than saying
    // nothing: it sends them looking for a window that is not there.
    const supervised = wintRunning();
    console.error(
      [
        "",
        "The build could not replace wint-torrent-helper.exe: an engine is running, and Windows",
        "does not let anything overwrite a running program.",
        "",
        ...(supervised
          ? [
              "WinT is open, and killing its engine is not enough — it treats one that dies on its own",
              "as a fault and starts another within a second or two.",
              "",
              "Turn the engine off deliberately instead — the Torrents switch on WinT's home screen —",
              "and the supervisor leaves it off. Then build again; WinT itself can stay open. The",
              "torrents are saved in the state folder and come back when you turn it on again.",
            ]
          : [
              "WinT is not running, so this engine is an orphan left behind by an earlier run. It",
              "should have gone when WinT did. Stop it and build again:",
              "",
              `    taskkill /f /im wint-torrent-helper.exe`,
              "",
              "If that says access is denied, the engine was started by a WinT running as",
              "administrator, and it takes an administrator terminal to stop it.",
            ]),
        "",
      ].join("\n"),
    );
  }
  process.exit(code || 0);
});
