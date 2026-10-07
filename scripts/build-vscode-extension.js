#!/usr/bin/env node
//
// Builds the WinT Terminal extension for VS Code in `vscode-extension/`.
//
// The extension carries copies, not sources: `wint-term-host.exe` built from
// `src-tauri/term-host`, and WinT's own `terminal.js`, `styles.css` and icon
// font. Copied fresh on every build so the panel is always the terminal WinT
// ships, never an older one.
//
//   node scripts/build-vscode-extension.js            build and copy
//   node scripts/build-vscode-extension.js --package  also write the .vsix to dist/
//
// The PATH dance is the same one `tauri-with-cargo-path.js` does: cargo lives
// in the user profile and is not always on PATH for a spawned build.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "vscode-extension");
const pack = process.argv.includes("--package");

const cargoBin = path.join(os.homedir(), ".cargo", "bin");
const parts = (process.env.PATH || "").split(path.delimiter);
if (fs.existsSync(cargoBin) && !parts.some((p) => p.toLowerCase() === cargoBin.toLowerCase())) {
  process.env.PATH = [cargoBin, ...parts].join(path.delimiter);
}

function run(command, args, cwd) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status || 1);
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`  ${path.relative(ROOT, from)} -> ${path.relative(ROOT, to)}`);
}

console.log("Building wint-term-host (release)");
run("cargo", ["build", "--release", "-p", "wint-term-host"], path.join(ROOT, "src-tauri"));

console.log("Copying into vscode-extension/");
copy(
  path.join(ROOT, "src-tauri", "target", "release", "wint-term-host.exe"),
  path.join(EXT, "bin", "wint-term-host.exe"),
);
copy(path.join(ROOT, "src", "terminal.js"), path.join(EXT, "media", "wint", "terminal.js"));
copy(path.join(ROOT, "src", "styles.css"), path.join(EXT, "media", "wint", "styles.css"));
copy(
  path.join(ROOT, "src", "fonts", "material-symbols-rounded.woff2"),
  path.join(EXT, "media", "wint", "fonts", "material-symbols-rounded.woff2"),
);
copy(path.join(ROOT, "LICENSE"), path.join(EXT, "LICENSE"));

if (pack) {
  const { version } = JSON.parse(fs.readFileSync(path.join(EXT, "package.json"), "utf8"));
  const out = path.join(ROOT, "dist", `wint-terminal-${version}.vsix`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  console.log("Packaging");
  run("npx", ["--yes", "@vscode/vsce", "package", "--no-dependencies", "--allow-missing-repository", "--out", out], EXT);
  console.log(`\nInstall with:  code --install-extension "${out}"`);
}
