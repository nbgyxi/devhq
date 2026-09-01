// Generic isolated tool loader. Tool families keep the same lifecycle:
// mount/open/opened/render/exportState/importState.
(async () => {
  "use strict";
  const bridge = window.devhqToolBridge;
  const context = await bridge.ready;
  const id = bridge.id;
  const host = document.getElementById("tool-host");
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
    if (modules[id]) {
      await load(modules[id]);
      api = { ports: window.devhqPortsTool, dns: window.devhqDns, hosts: window.devhqHosts, network: window.devhqNetwork,
        "path-ping": window.devhqPathPing, "disk-space": window.devhqDiskSpace,
        github: window.devhqGithub, git: window.devhqGit }[id];
    } else {
      await load("util-tools.js");
      if (window.devhqUtilTools?.byId?.(id)) api = window.devhqUtilTools;
      else {
        await load("windows-tools.js");
        if (window.devhqWindowsTools?.catalog?.().some((tool) => tool.id === id)) api = window.devhqWindowsTools;
      }
    }
    if (!api) throw new Error(`${context.tool?.name || id} has no isolated adapter.`);
    bridge.attach(api);
    const saved = await bridge.takeState();
    if (saved) api.importState?.(saved, id);
    const utilFamily = window.devhqUtilTools?.byId?.(id);
    const windowsFamily = window.devhqWindowsTools?.catalog?.().some((tool) => tool.id === id);
    const family = utilFamily ? "tools-page"
      : windowsFamily ? "windows-tools-page"
      : id === "network" ? "net-page" : id === "path-ping" ? "path-page"
      : `${id}-page`;
    host.className = `tool-isolated-body ${family}`;
    if (id === "git") api.setRepositories?.(context.projects || []);
    api.mount?.(host);
    if (utilFamily || windowsFamily) api.open?.(id);
    await api.opened?.();
    await bridge.reportReady();
  } catch (error) {
    host.innerHTML = `<div class="win-empty">${window.devhqShell.esc(String(error))}</div>`;
    await bridge.request("ready", { error: String(error) }).catch(() => {});
  }
})();
