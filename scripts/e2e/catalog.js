/**
 * Builds the full list of every screen and tool this suite should visit, by
 * reading the same catalogs the app itself uses (src/util-tools.js and
 * src/windows-tools.js) plus the fixed set of built-in views wired directly
 * in src/app.js's TOOLS/PLACES arrays. This keeps the manifest in sync with
 * the app automatically instead of hand-maintaining a duplicate list that
 * drifts.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(REPO_ROOT, "src");

// ports/dns/hosts/network/path-ping/disk-space/github/git all live in
// app.js's TOOLS array (not PLACES), each with an `open: () =>
// switchMainView(id)` handler - but openTool() (what "devhq:open-tool"
// dispatches into) never calls that handler for anything toolById() finds:
// it always routes to openIsolatedTool() instead, same as every util-tool
// and windows-tool. Those switchMainView handlers are dead code for this
// dispatch path; the "<id>-host" elements they'd have shown/hidden are
// never touched by real navigation anymore. Labels here are each tool's
// exact `name` in TOOLS, since that's what gets stamped onto
// #isolated-tool-host's [data-isolated-name] and is what isolatedToolCheck
// (below) compares against - it is not always the same as the id.
const ISOLATED_BUILT_IN_TOOLS = [
  { id: "ports", label: "Process Explorer" },
  { id: "dns", label: "DNS" },
  { id: "hosts", label: "Hosts file" },
  { id: "network", label: "Network" },
  { id: "path-ping", label: "Path Ping" },
  { id: "disk-space", label: "Disk Space Usage" },
  { id: "github", label: "GitHub" },
  { id: "git", label: "Git" },
];

// "settings" is the one screen besides "overview" that's still in PLACES,
// not TOOLS - openTool() really does call switchMainView("settings") for
// it, so it's the one built-in entry that still uses the old #<id>-host
// check below rather than isolatedToolCheck.
const PLACE_VIEWS = [{ id: "settings", label: "Settings" }];

// All host ids switchMainView() can show/hide, used to prove "overview" is
// active by proving nothing else is. "tools" and "windows-tools" are listed
// even though openTool() no longer routes normal navigation into them (see
// below) - they're harmless to keep checking as "must be hidden".
const ALL_VIEW_HOST_IDS = [
  "ports", "dns", "hosts", "network", "path-ping", "disk-space",
  "github", "git", "tools", "windows-tools", "isolated-tool", "settings",
];

function loadUtilToolCatalog() {
  const src = fs.readFileSync(path.join(SRC, "util-tools.js"), "utf8");
  const sandbox = {
    console,
    TextEncoder, TextDecoder, Uint8Array, BigInt, Number, String, Array,
    Object, Math, Date, JSON, RegExp, Error, Set, Map, Promise,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    crypto: {
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
      getRandomValues: (arr) => arr,
      subtle: {
        digest: async () => new Uint8Array(32).buffer,
        importKey: async () => ({}),
        sign: async () => new Uint8Array(32).buffer,
      },
    },
    document: { createElement: () => ({ value: "", innerHTML: "" }) },
    DOMParser: class { parseFromString() { return { body: {}, head: {}, querySelector: () => null }; } },
    navigator: { clipboard: { readText: async () => "", writeText: async () => {} } },
    window: {},
    requestAnimationFrame: (fn) => fn(),
  };
  // window === globalThis in this sandbox (see below), so __TAURI__ has to
  // live on the top-level sandbox object, not the nested `window` value
  // that gets replaced next.
  sandbox.__TAURI__ = { core: { invoke: async () => { throw new Error("not invoked by catalog build"); } } };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(src, sandbox, { filename: "util-tools.js" });
  const api = sandbox.window.devhqUtilTools;
  if (!api) throw new Error("src/util-tools.js did not expose window.devhqUtilTools");
  return api.catalog().map((tool) => ({ id: tool.id, label: tool.name }));
}

function loadWindowsToolCatalog() {
  const src = fs.readFileSync(path.join(SRC, "windows-tools.js"), "utf8");
  const window = {
    __TAURI__: { core: { invoke: async () => { throw new Error("not invoked by catalog build"); } } },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  };
  const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const location = { pathname: "/" };
  // Never fires a callback: the tracker/clipboard DB-open promises this
  // feeds just stay pending forever, which is fine since nothing in this
  // sandbox awaits them - we only need catalog(), built synchronously above.
  const indexedDB = { open: () => ({}) };
  vm.runInNewContext(
    src,
    { window, localStorage, location, indexedDB, console, setInterval, clearInterval, prompt: () => null },
    { filename: "windows-tools.js" },
  );
  const api = window.devhqWindowsTools;
  if (!api) throw new Error("src/windows-tools.js did not expose window.devhqWindowsTools");
  return api.catalog().map((tool) => ({ id: tool.id, label: tool.name }));
}

// openTool() (app.js) routes every TOOLS entry - the eight built-in views
// above, every util-tool, every windows-tool - through openIsolatedTool(),
// which mounts the tool in a genuinely separate child WebView2 surface
// (src-tauri/src/tool_window.rs, add_child), not an in-page panel in this
// document. The shell keeps owning the chrome around it
// (#isolated-tool-host's header, with the tool's name stamped onto
// [data-isolated-name] - see app.js's mountShell()), so that's what's
// checkable from here. The tool's own rendered content lives in a
// different document this suite has no WebDriver handle to, so unlike the
// old in-page checks this replaced, this can only prove navigation reached
// the right tool - not that the tool's own content rendered without error.
// See README.md's "what this misses" section.
function isolatedToolCheck(name) {
  const host = document.getElementById("isolated-tool-host");
  const nameEl = host ? host.querySelector("[data-isolated-name]") : null;
  const active = !!host && !host.hidden && !!nameEl && nameEl.textContent.trim() === name;
  return { active, errorText: null };
}

/**
 * Returns the ordered list of every entry to visit. Each entry knows how to
 * check, from outside the app, whether it is actually the thing on screen:
 * `checkFn` is executed in-browser via WebDriver's executeScript and must be
 * a fully self-contained function (no closures over Node scope) returning
 * `{ active: boolean, errorText: string|null }`. `checkArgs` are passed to it.
 */
function buildCatalog() {
  const entries = [];

  entries.push({
    id: "overview",
    kind: "view",
    label: "Overview",
    isolated: false,
    checkFn: function (hostIds) {
      return {
        active: hostIds.every((id) => {
          const el = document.getElementById(id + "-host");
          return !el || el.hidden;
        }),
        errorText: null,
      };
    },
    checkArgs: [ALL_VIEW_HOST_IDS],
  });

  for (const view of ISOLATED_BUILT_IN_TOOLS) {
    entries.push({
      id: view.id,
      kind: "view",
      label: view.label,
      isolated: true,
      checkFn: isolatedToolCheck,
      checkArgs: [view.label],
    });
  }

  for (const view of PLACE_VIEWS) {
    entries.push({
      id: view.id,
      kind: "view",
      label: view.label,
      isolated: false,
      checkFn: function (hostId) {
        const el = document.getElementById(hostId + "-host");
        return { active: !!el && !el.hidden, errorText: null };
      },
      checkArgs: [view.id],
    });
  }

  for (const tool of loadUtilToolCatalog()) {
    entries.push({
      id: tool.id,
      kind: "util-tool",
      label: tool.label,
      isolated: true,
      checkFn: isolatedToolCheck,
      checkArgs: [tool.label],
    });
  }

  for (const tool of loadWindowsToolCatalog()) {
    entries.push({
      id: tool.id,
      kind: "windows-tool",
      label: tool.label,
      isolated: true,
      checkFn: isolatedToolCheck,
      checkArgs: [tool.label],
    });
  }

  return entries;
}

module.exports = { buildCatalog, ALL_VIEW_HOST_IDS };
