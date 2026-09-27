const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const location = { pathname: "/index.html" };
const window = { localStorage, location, addEventListener: () => {}, __TAURI__: { core: { invoke: async () => { throw new Error("not invoked by catalog smoke test"); } } } };
vm.runInNewContext(fs.readFileSync("src/windows-tools.js", "utf8"), { window, localStorage, location, console, setInterval, clearInterval, prompt: () => null });
const catalog = window.wintWindowsTools.catalog();
const ids = catalog.map((tool) => tool.id);
for (const id of ["help", "events", "registry", "system", "log-tail", "lock-inspector"]) assert(ids.includes(id), `${id} is missing`);
for (const id of ["audio", "swap", "gpu", "bounds", "net", "wifi", "radio", "usb", "shell", "spooler"]) {
  assert(ids.includes(`repair-${id}`), `repair-${id} is missing`);
}
assert.equal(new Set(ids).size, ids.length, "tool IDs must be unique");
assert.equal(catalog.filter((tool) => tool.id.startsWith("repair-")).length, 10, "repairs must be ten separate catalog entries");
assert.equal(
  catalog.filter((tool) => tool.id.startsWith("repair-") && /(^|\s)tools?(\s|$)/.test(tool.keywords)).length,
  10,
  "searching for tool must match every repair tool",
);
const css = fs.readFileSync("src/styles.css", "utf8");
assert(fs.readFileSync("src/windows-tools.js", "utf8").includes('data-help-tool="${esc(item.id)}"'), "Help tool cards must be navigable");
const windowsToolsSource = fs.readFileSync("src/windows-tools.js", "utf8");
assert(
  windowsToolsSource.includes("window.wintShell?.openTool(helpTool.dataset.helpTool)"),
  "Help tool cards must navigate through the shell bridge",
);
const appSource = fs.readFileSync("src/app.js", "utf8");
const navigationReply = appSource.indexOf("await reply(true);", appSource.indexOf('request.action === "navigate"'));
const navigationOpen = appSource.indexOf("setTimeout(() => openTool(destination), 0);", navigationReply);
assert(navigationReply >= 0 && navigationOpen > navigationReply, "Isolated navigation must be acknowledged before its webview is replaced");
// Tools are resident now and switching suspends rather than destroys, so the
// teardown that has to be awaited is eviction: the webview must be gone on the
// Rust side, and its session forgotten here, before anything mounts that tool
// again - otherwise a fresh mount races the old webview's destruction.
const evict = appSource.indexOf("async function evictEmbeddedTool(");
const evictDestroy = appSource.indexOf('await invoke("tool_embedded_destroy", { id })', evict);
assert(evict >= 0, "evictEmbeddedTool must exist to drop a tool out of memory");
assert(
  evictDestroy > evict && evictDestroy - evict < 1200,
  "Evicting a tool must finish destroying its webview before returning",
);
assert(
  appSource.indexOf("embeddedToolSessions.delete(id)", evict) < evictDestroy,
  "An evicted tool's session must be forgotten with it",
);
assert(!appSource.includes('const previousId = state.activeView === "isolated-tool"'), "Tool switching must not start a second eager webview teardown");
const bridgeSource = fs.readFileSync("src/tool-bridge.js", "utf8");
assert(bridgeSource.includes('event.key === ">"'), "Isolated tools must forward the > search shortcut");
assert(bridgeSource.includes('target.matches("input,textarea,select")'), "The > shortcut must not intercept text-entry controls");
const legacyHelpComment = windowsToolsSource.indexOf("/*\n  function renderHelp");
const eventRenderer = windowsToolsSource.indexOf("function renderEvents");
assert(legacyHelpComment >= 0 && windowsToolsSource.indexOf("*/", legacyHelpComment) < eventRenderer, "Event Log Streamer renderer must not be commented out with legacy Help");
assert(windowsToolsSource.includes("const searchableCommands=rows([['<project>'"), "Help must show exact searchable commands");
assert(windowsToolsSource.includes("['Run <project>'"), "Help must document the Run command explicitly");
assert(windowsToolsSource.includes('data-related-tool="repair-swap"'), "Audio Subsystem Bouncer must link to Sound Device Switcher");
assert(windowsToolsSource.includes('data-related-tool="repair-audio"'), "Sound Device Switcher must link to Audio Subsystem Bouncer");
assert(!windowsToolsSource.includes('<div><h3>${esc(name)}</h3>'), "Repair tools must not repeat their title in the body");
// Anchored to the start of a line so this reads the base rule and not one of
// the compound selectors that also end in ".windows-tools-page" (the pop-out
// host, for one) and would otherwise match first.
const pageRule = css.match(/^\.windows-tools-page\{([^}]*)\}/m)?.[1] || "";
assert(pageRule.includes("flex:1"), "Windows tools must fill the shell's remaining height");
assert(!pageRule.includes("position:absolute"), "Windows tools must not cover the shared toolbar");
assert(css.includes(".windows-tools-page[hidden]{display:none}"), "hidden Windows tools must leave the flex layout");
assert(!css.includes(".material-symbols-rounded"), "Windows tools must use WinT's .ms icon renderer");
console.log(`Windows tool catalog smoke test passed (${catalog.length} tools).`);
