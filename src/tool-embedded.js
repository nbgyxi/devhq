// Generic isolated tool loader. Tool families keep the same lifecycle:
// mount/open/opened/render/exportState/importState.
(async () => {
  "use strict";
  const bridge = window.wintToolBridge;
  const loading = document.getElementById("tool-loading");
  const phase = document.getElementById("tool-loading-phase");
  // The loading screen names the real phase rather than saying "Loading…" at
  // everything, so a tool that stalls says where it stalled.
  const sayPhase = (text) => { if (phase) phase.textContent = text; };
  const id = bridge.id;
  const host = document.getElementById("tool-host");
  const queryName = new URLSearchParams(location.search).get("name") || id;
  // A dead end needs a way out. The shell's own stand-in sits underneath this
  // native webview and cannot be clicked, so the retry has to live here: a
  // reload re-runs the bridge handshake and the tool's whole open path, which
  // is every step that could have failed above.
  const stall = (text) => {
    if (!loading) return;
    loading.querySelector(".tool-loading-ring")?.remove();
    loading.querySelector(".tool-loading-body")?.remove();
    sayPhase(text);
    const retry = document.getElementById("tool-loading-retry");
    if (retry) {
      retry.hidden = false;
      retry.addEventListener("click", () => {
        retry.disabled = true;
        retry.textContent = "Retrying…";
        location.reload();
      });
      retry.focus();
    }
  };
  // The bridge answers over Tauri events and gives up after 15s. Waiting on it
  // outside the try would leave this screen spinning forever on a shell that
  // never replied, which is the one thing a loading screen must not do.
  sayPhase(`Connecting ${queryName}…`);
  let context;
  try {
    context = await bridge.ready;
  } catch (error) {
    stall(`${queryName} could not reach WinT. ${String(error)}`);
    // Best effort: if the shell is listening after all, it should know this
    // webview is a dead one and destroy it instead of keeping it resident.
    bridge.request("ready", { error: String(error) }).catch(() => {});
    return;
  }
  const label = context?.tool?.name || queryName;
  const modules = {
    ports: "ports-tool.js", dns: "dns.js", hosts: "hosts.js", network: "network.js", "path-ping": "path-ping.js",
    "disk-space": "disk-space.js", github: "github.js", git: "git-client.js",
  };
  const load = (src) => new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${src}?isolated=1`;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
  try {
    let api;
    sayPhase(`Loading ${label}…`);
    if (modules[id]) {
      await load(modules[id]);
      api = { ports: window.wintPortsTool, dns: window.wintDns, hosts: window.wintHosts, network: window.wintNetwork,
        "path-ping": window.wintPathPing, "disk-space": window.wintDiskSpace,
        github: window.wintGithub, git: window.wintGit }[id];
    } else {
      await load("util-tools.js");
      if (window.wintUtilTools?.byId?.(id)) api = window.wintUtilTools;
      else {
        await load("windows-tools.js");
        if (window.wintWindowsTools?.catalog?.().some((tool) => tool.id === id)) api = window.wintWindowsTools;
      }
    }
    if (!api) throw new Error(`${context.tool?.name || id} has no isolated adapter.`);
    bridge.attach(api);
    const saved = await bridge.takeState();
    if (saved) api.importState?.(saved, id);
    const utilFamily = window.wintUtilTools?.byId?.(id);
    const windowsFamily = window.wintWindowsTools?.catalog?.().some((tool) => tool.id === id);
    const family = utilFamily ? "tools-page"
      : windowsFamily ? "windows-tools-page"
      : id === "network" ? "net-page" : id === "path-ping" ? "path-page"
      : `${id}-page`;
    host.className = `tool-isolated-body ${family}`;
    if (id === "git") api.setRepositories?.(context.projects || []);
    sayPhase(`Starting ${label}…`);
    api.mount?.(host);
    if (utilFamily || windowsFamily) api.open?.(id);
    await api.opened?.();
    // Uncover only once the tool has drawn itself, so the hand-off is a swap
    // rather than a flash of empty background.
    if (loading) loading.hidden = true;
    await bridge.reportReady();
  } catch (error) {
    // A tool that cannot open keeps the loading screen and says so there -
    // better than a spinner that never stops over an empty page.
    if (loading) stall(`${label} could not open. ${String(error)}`);
    else host.innerHTML = `<div class="win-empty">${window.wintShell.esc(String(error))}</div>`;
    await bridge.request("ready", { error: String(error) }).catch(() => {});
  }
})();
