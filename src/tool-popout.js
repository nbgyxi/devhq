// Popped-out tool window. Each tool remounts here independently — there is no
// shared session the way terminals have — and docks back by telling WinT to
// open it again and destroying this frame.

(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const emit = window.__TAURI__.event.emit;
  const listen = window.__TAURI__.event.listen;
  const win = window.__TAURI__.window.getCurrentWindow();

  const id = new URLSearchParams(location.search).get("id");
  const host = document.getElementById("tool-host");
  const PREFS_KEY = "wint.prefs.v1";
  const ONTOP_KEY = "wint.tools.ontop.v1";

  let handedOver = false;
  let closed = false;

  const readPrefs = () => {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    } catch {
      return {};
    }
  };

  const writePrefs = (patch) => {
    try {
      const next = { ...readPrefs(), ...patch };
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      return next;
    } catch {
      return readPrefs();
    }
  };

  const applyTheme = () => {
    // Opener query wins — it matches the native webview colour set at create.
    const fromQuery = new URLSearchParams(location.search).get("theme");
    const fromPrefs = readPrefs().theme;
    const theme = fromQuery === "light" || fromQuery === "dark"
      ? fromQuery
      : fromPrefs === "light" || fromPrefs === "dark"
        ? fromPrefs
        : "dark";
    document.documentElement.dataset.theme = theme;
  };
  applyTheme();

  // Window was created visible(false). Reveal only after theme + chrome have
  // painted so the user never sees white → black → grey → content.
  let revealed = false;
  const reveal = async () => {
    if (revealed) return;
    revealed = true;
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    await win.show().catch(() => {});
    await win.setFocus().catch(() => {});
  };
  const revealFallback = setTimeout(() => { reveal(); }, 2000);

  // The loading screen is painted by tool.html and is already naming the tool
  // from the URL. From here it only ever gets a truer phase, or goes away.
  const boot = document.getElementById("tool-loading");
  const bootName = document.getElementById("tool-loading-name");
  const bootPhase = document.getElementById("tool-loading-phase");
  const showBoot = (name, phase) => {
    if (!boot) return;
    if (name && bootName) bootName.textContent = name;
    if (phase && bootPhase) bootPhase.textContent = phase;
    boot.hidden = false;
  };
  const hideBoot = () => {
    if (boot) boot.hidden = true;
  };
  /** A window that cannot mount its tool keeps this screen and says why, so
   *  the reason is never traded for an empty page. */
  const failBoot = (message) => {
    if (!boot) return;
    boot.querySelector(".tool-loading-ring")?.remove();
    boot.querySelector(".tool-loading-body")?.remove();
    if (bootPhase) bootPhase.textContent = message;
    boot.hidden = false;
  };

  const icon = (name) => `<span class="ms" aria-hidden="true">${name}</span>`;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));

  const catalogEntry = () => {
    if (id === "ports") {
      return { id: "ports", name: "Process Explorer", icon: "lan", hint: "ports, PIDs, what is holding :3000, and kill" };
    }
    if (id === "dns") {
      return { id: "dns", name: "DNS", icon: "dns", hint: "resolve a name, compare resolvers, see who really answers" };
    }
    if (id === "hosts") {
      return { id: "hosts", name: "Hosts file", icon: "edit_note", hint: "point a name at your own machine — it beats every DNS server" };
    }
    if (id === "network") {
      return { id: "network", name: "Network", icon: "network_check", hint: "watch the packets crossing the wire, live" };
    }
    if (id === "path-ping") {
      return { id: "path-ping", name: "Path Ping", icon: "route", hint: "latency and loss, hop by hop" };
    }
    if (id === "disk-space") {
      return { id: "disk-space", name: "Disk Space Usage", icon: "hard_drive", hint: "see what fills a drive and drill into every folder" };
    }
    if (id === "github") {
      return { id: "github", name: "GitHub", icon: "merge", hint: "inbox, pull requests, issues, Actions and repositories" };
    }
    if (id === "git") {
      return { id: "git", name: "Git", icon: "bookmark_added", hint: "save, upload and restore versions of your work" };
    }
    const util = window.wintUtilTools?.catalog?.().find((tool) => tool.id === id);
    if (util) return { ...util, kind: "util" };
    const winTool = window.wintWindowsTools?.catalog?.().find((tool) => tool.id === id);
    if (winTool) return { ...winTool, kind: "windows" };
    return null;
  };

  const finishClose = async () => {
    if (handedOver || closed) return;
    closed = true;
    await emit("tool:closed", { id }).catch(() => {});
    await win.destroy().catch(() => {});
  };

  const handOver = async () => {
    if (handedOver || closed) return;
    await window.wintToolState?.send?.(id);
    handedOver = true;
    await emit("tool:docked", { id }).catch(() => {});
    await win.destroy().catch(() => {});
  };

  document.querySelector(".win-btns").addEventListener("click", (event) => {
    const btn = event.target.closest(".win-btn");
    if (!btn) return;
    // This listener runs in the capture phase. The pin owns its click below;
    // do not stop the event before it reaches that handler.
    if (btn.id === "pop-ontop") return;
    event.preventDefault();
    event.stopPropagation();
    if (btn.id === "pop-dock") {
      handOver();
      return;
    }
    const act = btn.dataset.win;
    if (act === "min") win.minimize().catch(() => {});
    else if (act === "max") {
      win.toggleMaximize().then(() => syncMaximizeButton()).catch(() => {});
    } else if (act === "close") finishClose();
  }, true);

  const maxButton = document.querySelector('[data-win="max"]');
  async function syncMaximizeButton() {
    if (!maxButton) return;
    const maxed = await win.isMaximized().catch(() => false);
    const glyph = maxButton.querySelector(".ms");
    if (glyph) glyph.textContent = maxed ? "filter_none" : "crop_square";
    maxButton.title = maxed ? "Restore" : "Maximize";
    maxButton.setAttribute("aria-label", maxed ? "Restore" : "Maximize");
  }
  syncMaximizeButton();
  win.onResized(() => syncMaximizeButton());

  win.onCloseRequested(async (event) => {
    if (!closed && !handedOver) event.preventDefault();
    await finishClose();
  });

  // The name WinT put in the URL. It is the display name, never the id, and
  // it is all this window has to go on until the tool catalog has loaded.
  const openedAs = new URLSearchParams(location.search).get("name") || "";

  if (!id) {
    failBoot("This window was opened without a tool.");
    clearTimeout(revealFallback);
    await reveal();
    return;
  }

  const meta = catalogEntry();
  if (!meta) {
    failBoot(`${openedAs || "That tool"} is not a tool this version knows how to open.`);
    clearTimeout(revealFallback);
    await reveal();
    return;
  }

  window.wintTrackPageView?.(`/tool-popout/${id}`);
  document.title = meta.name;
  document.getElementById("pop-name").textContent = meta.name;
  const applyBrandIcon = () => {
    const brandImg = document.querySelector(".brand img");
    if (!brandImg) return;
    const themeKey = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    brandImg.src = `tool-icons/${themeKey}/${encodeURIComponent(id)}.png`;
    brandImg.onerror = () => {
      brandImg.onerror = null;
      brandImg.src = `tool-icons/${themeKey}/_default.png`;
    };
  };
  applyBrandIcon();
  window.addEventListener("storage", (event) => {
    if (event.key !== PREFS_KEY) return;
    applyTheme();
    applyBrandIcon();
  });
  // The title bar is the only place this window says what it is: the name, and
  // beside it the Alpha/Beta mark that used to sit in the page header. The hint
  // sentence stays out — it crowds the bar and reads as centered noise.
  document.getElementById("pop-hint").innerHTML = window.wintMaturity?.badge(id) ?? "";
  showBoot(meta.name, `Starting ${meta.name}…`);
  // Show themed chrome and the named loading screen — never the blank flash.
  clearTimeout(revealFallback);
  await reveal();

  const workBusy = new Map();
  window.wintWork = {
    beginWork(key, label) {
      workBusy.set(key, label);
    },
    updateWork() {},
    endWork(key) {
      workBusy.delete(key);
    },
  };

  const pinnedIds = () => {
    const list = readPrefs().toolPins;
    return Array.isArray(list) ? list.filter((value) => typeof value === "string") : [];
  };

  // The tool modules never paint directly: they mark themselves dirty and the
  // shell paints on the next frame. In the main window that is app.js's
  // markDirty / flushRender; without it here a tool mounts once and then never
  // updates again — every result it streams in lands on a page nobody redraws.
  const renderers = {
    dns: () => window.wintDns?.render(),
    hosts: () => window.wintHosts?.render(),
    network: () => window.wintNetwork?.render(),
    "path-ping": () => window.wintPathPing?.render(),
    "disk-space": () => window.wintDiskSpace?.render(),
    tools: () => window.wintUtilTools?.render(),
  };
  const dirtyRegions = new Set();
  let renderQueued = 0;

  window.wintShell = {
    icon,
    esc,
    markDirty(...regions) {
      for (const region of regions) {
        if (renderers[region]) dirtyRegions.add(region);
      }
      if (renderQueued || !dirtyRegions.size) return;
      renderQueued = requestAnimationFrame(() => {
        renderQueued = 0;
        const due = [...dirtyRegions];
        dirtyRegions.clear();
        for (const region of due) renderers[region]();
      });
    },
    isToolPinned: (toolId) => pinnedIds().includes(toolId),
    toggleToolPin(toolId) {
      const pins = pinnedIds();
      const next = pins.includes(toolId)
        ? pins.filter((pin) => pin !== toolId)
        : [...pins, toolId];
      writePrefs({ toolPins: next });
      emit("tool:pins-changed", { id: toolId, pinned: next.includes(toolId) }).catch(() => {});
    },
    openTool(toolId) {
      if (toolId === "overview" || toolId === id) return handOver();
      // Switching to another tool from Help cards: ask the main window and dock.
      emit("tool:open", { id: toolId }).catch(() => {});
      return handOver();
    },
    popOutTool() {},
    projects() {
      return [];
    },
  };

  let portHandoff = null;
  window.wintPortsState = {
    exportState() { return { search:document.getElementById("pop-port-filter")?.value||"", ...portHandoff }; },
    importState(state) { portHandoff=state||null; const input=document.getElementById("pop-port-filter");if(input)input.value=portHandoff?.search||""; },
  };

  // Hide the in-page pin/close chrome — the title bar owns dock and close here.
  window.wintExternalToolChrome = true;
  document.body.classList.add("tool-popout-chrome");

  let mounted = false;
  try {
    await window.wintToolState?.receive?.(id);
    if (id === "ports") {
      host.className = "tool-pop-host ports-page tool-pop-ports";
      window.wintPortsTool?.mount(host);
      await window.wintPortsTool?.opened();
    } else if (id === "dns") {
      host.className = "tool-pop-host dns-page";
      window.wintDns?.mount(host);
      window.wintDns?.opened();
    } else if (id === "hosts") {
      host.className = "tool-pop-host hosts-page";
      window.wintHosts?.mount(host);
      window.wintHosts?.opened();
    } else if (id === "network") {
      host.className = "tool-pop-host net-page";
      window.wintNetwork?.mount(host);
      window.wintNetwork?.opened();
    } else if (id === "path-ping") {
      host.className = "tool-pop-host path-page";
      window.wintPathPing?.mount(host);
      window.wintPathPing?.opened();
    } else if (id === "disk-space") {
      host.className = "tool-pop-host disk-page";
      window.wintDiskSpace?.mount(host);
      window.wintDiskSpace?.opened();
    } else if (id === "github") {
      host.className = "tool-pop-host github-page";
      window.wintGithub?.mount(host);
      window.wintGithub?.opened();
    } else if (id === "git") {
      host.className = "tool-pop-host git-page";
      window.wintGit?.mount(host);
      window.wintGit?.opened();
    } else if (window.wintUtilTools?.byId?.(id)) {
      host.className = "tool-pop-host tools-page";
      window.wintUtilTools.mount(host);
      window.wintUtilTools.open(id);
      window.wintUtilTools.opened();
    } else if (window.wintWindowsTools?.catalog?.().some((tool) => tool.id === id)) {
      host.className = "tool-pop-host windows-tools-page";
      window.wintWindowsTools.mount(host);
      window.wintWindowsTools.open(id);
      window.wintWindowsTools.opened();
    } else {
      failBoot(`${meta.name} could not be mounted in its own window.`);
      return;
    }
    mounted = true;
  } finally {
    // Only a tool that actually drew gets the screen taken away. A failure
    // keeps it, because it is now the thing carrying the explanation.
    if (mounted) hideBoot();
  }
  // The main shell keeps its current tool covered until this exact point: the
  // pop-out exists, its tool has mounted, and it is safe to release the source.
  await emit("tool:ready", { id }).catch(() => {});

  // Always-on-top, remembered per tool id the way terminals remember per session.
  const readOnTop = () => {
    try {
      const list = JSON.parse(localStorage.getItem(ONTOP_KEY) || "[]");
      return Array.isArray(list) ? list.filter((value) => typeof value === "string") : [];
    } catch {
      return [];
    }
  };
  const writeOnTop = (list) => {
    try {
      localStorage.setItem(ONTOP_KEY, JSON.stringify(list));
    } catch { /* ignore */ }
  };
  const ontopButton = document.getElementById("pop-ontop");
  let onTop = readOnTop().includes(id);
  const applyOnTop = async () => {
    ontopButton.classList.toggle("on", onTop);
    ontopButton.setAttribute("aria-pressed", String(onTop));
    ontopButton.title = onTop ? "Stop keeping this window on top" : "Keep this window on top";
    await win.setAlwaysOnTop(onTop).catch(() => {});
  };
  ontopButton.onclick = async () => {
    onTop = !onTop;
    const list = readOnTop().filter((value) => value !== id);
    if (onTop) list.push(id);
    writeOnTop(list);
    await applyOnTop();
  };
  await applyOnTop();

  // Drag the title bar to move the window. Nothing else: dropping a tool onto
  // WinT used to dock it, which made an ordinary move look like the window had
  // vanished. Docking is the dock button, and only the dock button.
  document.querySelector(".titlebar .drag").addEventListener("pointerdown", async (e) => {
    if (e.button !== 0) return;
    // The maturity badge lives in the bar and is a button: a drag started here
    // would swallow the click that opens what Alpha and Beta mean.
    if (e.target.closest("[data-maturity]")) return;
    await win.startDragging();
  });

  /** Compact Process Explorer for the pop-out. Full shelving/pins stay in main. */
  async function mountPorts(root) {
    root.innerHTML = `
      <header class="tool-head">
        <span class="tool-plate">${icon("lan")}</span>
        <span class="tool-title">
          <strong>Process Explorer</strong>
          <small>listening ports and what is holding them</small>
        </span>
        <button class="btn" type="button" data-ports-refresh title="Read the process table again">${icon("refresh")}Refresh</button>
      </header>
      <div class="ports-pop-toolbar">
        <label class="field ports-filter" for="pop-port-filter">${icon("filter_alt")}
          <input id="pop-port-filter" spellcheck="false" placeholder="Port, process, PID..." />
        </label>
        <span class="win-status" data-ports-status>Reading…</span>
      </div>
      <div class="ports-pop-list" data-ports-list></div>`;

    let entries = [];
    const list = root.querySelector("[data-ports-list]");
    const status = root.querySelector("[data-ports-status]");
    const filter = root.querySelector("#pop-port-filter");
    filter.value = portHandoff?.search || "";

    const flatten = (processes) => {
      const out = [];
      for (const row of processes || []) {
        for (const binding of row.ports || []) {
          out.push({
            port: binding.port,
            pid: row.pid,
            process: row.process || "",
            path: row.executablePath || row.cwd || "",
            executablePath: row.executablePath || "",
          });
        }
      }
      return out;
    };

    const paint = () => {
      const words = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const visible = entries.filter((row) => {
        if (!words.length) return true;
        const hay = `${row.port} ${row.process} ${row.pid} ${row.path}`.toLowerCase();
        return words.every((word) => hay.includes(word));
      });
      if (!visible.length) {
        list.innerHTML = `<div class="win-empty">${entries.length ? "Nothing matches." : "No listening ports."}</div>`;
        return;
      }
      list.innerHTML = visible.map((row) => `
        <div class="ports-pop-row">
          <span class="mono ports-pop-port">:${esc(row.port)}</span>
          <strong>${esc(row.process || "Unknown")}</strong>
          <span class="mono">PID ${esc(row.pid)}</span>
          <small title="${esc(row.path)}">${esc(row.path)}</small>
          <button type="button" class="btn danger" data-kill-pid="${esc(row.pid)}"
            data-kill-exe="${esc(row.executablePath)}" data-kill-name="${esc(row.process)}"
            title="End this process">${icon("stop_circle")}Kill</button>
        </div>`).join("");
    };

    const load = async () => {
      status.textContent = "Reading…";
      try {
        const rows = await invoke("port_list");
        entries = flatten(Array.isArray(rows) ? rows : []);
        status.textContent = `${entries.length} listening`;
        paint();
      } catch (error) {
        status.textContent = String(error);
        list.innerHTML = `<div class="win-empty">${esc(String(error))}</div>`;
      }
    };

    root.onclick = async (event) => {
      if (event.target.closest("[data-ports-refresh]")) return load();
      const kill = event.target.closest("[data-kill-pid]");
      if (!kill) return;
      const pid = Number(kill.dataset.killPid);
      if (!pid) return;
      status.textContent = `Ending PID ${pid}…`;
      try {
        await invoke("port_kill", {
          pid,
          expectedExecutable: kill.dataset.killExe || "",
          expectedProcess: kill.dataset.killName || "",
          tree: true,
        });
        await load();
      } catch (error) {
        status.textContent = String(error);
      }
    };
    filter.oninput = paint;
    await load();
    setInterval(load, 4000);
  }
})();
