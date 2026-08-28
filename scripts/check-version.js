// Refuses to build when the app's version and its release list disagree.
//
// The list in `src/changelog.js` is the source of truth: whatever is at the top
// of it is the version being built, and `src-tauri/tauri.conf.json` has to say
// the same thing, because that is what the exe carries and what the status bar
// shows through `app_version`. Runs as npm's `prebuild`, so `npm run build`
// cannot quietly produce an exe whose number is not in the list in the window.
//
// This only ever reads. `package-msix.ps1 -BumpVersion` is what moves
// tauri.conf.json up to the changelog.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const changelogPath = path.join(root, "src", "changelog.js");
const confPath = path.join(root, "src-tauri", "tauri.conf.json");

function fail(message) {
  console.error(`\nVersion check failed:\n  ${message}\n`);
  process.exit(1);
}

let listVersion;
try {
  const raw = fs.readFileSync(changelogPath, "utf8");
  const match = raw.match(/^\s*version:\s*"(\d+\.\d+\.\d+)"/m);
  if (!match) fail(`No release found in src/changelog.js. The newest release goes at the top of the list.`);
  listVersion = match[1];
} catch (err) {
  if (err.code === "ENOENT") fail("src/changelog.js is missing.");
  throw err;
}

const confVersion = JSON.parse(fs.readFileSync(confPath, "utf8")).version;

if (confVersion !== listVersion) {
  fail(
    `src-tauri/tauri.conf.json says ${confVersion}, the top of src/changelog.js says ${listVersion}.\n` +
      `  Add the release you are building to the top of src/changelog.js and bump tauri.conf.json to match\n` +
      `  (or run: npm run msix -- -BumpVersion).`
  );
}

console.log(`Version check: ${listVersion} - tauri.conf.json matches the top of src/changelog.js`);
