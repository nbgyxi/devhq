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

// Every id here corresponds 1:1 with an "<id>-host" element toggled by
// switchMainView() in app.js (MAIN_VIEWS), minus "overview", "tools" and
// "windows-tools" which are handled specially below.
const BUILT_IN_VIEWS = [
  { id: "ports", label: "Ports" },
  { id: "dns", label: "DNS" },
  { id: "hosts", label: "Hosts" },
  { id: "network", label: "Network" },
  { id: "path-ping", label: "Path Ping" },
  { id: "disk-space", label: "Disk Space Usage" },
  { id: "github", label: "GitHub" },
  { id: "git", label: "Git" },
  { id: "settings", label: "Settings" },
];

// All host ids switchMainView() can show/hide, used to prove "overview" is
// active by proving nothing else is.
const ALL_VIEW_HOST_IDS = [
  "ports", "dns", "hosts", "network", "path-ping", "disk-space",
  "github", "git", "tools", "windows-tools", "settings",
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

  for (const view of BUILT_IN_VIEWS) {
    entries.push({
      id: view.id,
      kind: "view",
      label: view.label,
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
      checkFn: function (name) {
        const host = document.getElementById("tools-host");
        const nameEl = document.getElementById("tools-name");
        const active = !!host && !host.hidden && !!nameEl && nameEl.textContent.trim() === name;
        const errEl = document.querySelector("#tools-output .tools-error");
        return { active, errorText: errEl ? errEl.textContent.trim() : null };
      },
      checkArgs: [tool.label],
    });
  }

  for (const tool of loadWindowsToolCatalog()) {
    entries.push({
      id: tool.id,
      kind: "windows-tool",
      label: tool.label,
      checkFn: function (name) {
        const host = document.getElementById("windows-tools-host");
        const titleEl = host ? host.querySelector(".tool-title strong") : null;
        const active = !!host && !host.hidden && !!titleEl && titleEl.textContent.trim() === name;
        const statusEl = host ? host.querySelector("[data-win-status]") : null;
        const bad = !!(statusEl && statusEl.dataset && statusEl.dataset.tone === "bad");
        return { active, errorText: bad ? statusEl.textContent.trim() : null };
      },
      checkArgs: [tool.label],
    });
  }

  return entries;
}

module.exports = { buildCatalog, ALL_VIEW_HOST_IDS };
