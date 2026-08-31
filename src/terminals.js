// The terminal dock: a strip of live shells at the bottom of DevHQ, each one
// tied to the project it was opened from.
//
// The dock lives outside `#root` on purpose. `render()` replaces that subtree
// wholesale on every rescan, and a terminal must survive that — its DOM is
// mounted once and only ever mutated in place.

const term_dock_invoke = window.__TAURI__.core.invoke;
const term_dock_listen = window.__TAURI__.event.listen;
const term_dock_emit = window.__TAURI__.event.emit;

const TERM_PREFS = "devhq.terminals.v1";

/** Names one terminal's kept stream. The output itself never comes through
 *  here: the session in Rust keeps the bytes the shell wrote and replays them
 *  into the parser when the terminal is opened again, so what a restored
 *  terminal shows is its own scrollback rather than a drawing of it. All this
 *  side has to remember is which stream belongs to which terminal. */
function newHistoryKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
const TERM_SHELLS = [
  { value: "auto", label: "Auto" },
  { value: "pwsh", label: "PowerShell 7" },
  { value: "pwsh-preview", label: "PowerShell Preview" },
  { value: "powershell", label: "Windows PowerShell" },
  { value: "cmd", label: "Command Prompt" },
  { value: "git-bash", label: "Git Bash" },
  { value: "wsl", label: "WSL Bash" },
  { value: "nu", label: "NuShell" },
];
const DEFAULT_SHELL_COLORS = {
  pwsh: "#4d9df5", "pwsh-preview": "#c162de", powershell: "#61afef",
  cmd: "#8cc265", "git-bash": "#e05561", wsl: "#d5a458", nu: "#c162de", auto: "#42b3c2",
};

const terms = {
  open: false,
  active: null,
  /** id -> { info, view, host } */
  sessions: new Map(),
  /** All terminals that belong to this workspace, including ones currently
   *  popped out and therefore absent from `sessions`. */
  known: new Map(),
  /** key -> { label, pane }, for shells that have been asked for but have not
   *  started yet. They get a tab straight away so the click is never silent. */
  pending: new Map(),
  height: 320,
  splitRatio: .5,
  paneActive: [null, null],
  restoreSpecs: [],
  restoreOpen: false,
  restoreActive: 0,
  defaultShell: "auto",
  nextShell: "auto",
  shellMenuPane: null,
  shellAvailability: new Map(),
  shellColors: { ...DEFAULT_SHELL_COLORS },
  shellMarkerStyle: "code",
  /** When false, terminals start fresh and nothing is replayed on restore. */
  saveHistory: true,
  /** Replace the shell's small reverse search with DevHQ's searchable history. */
  enhancedHistorySearch: true,
  orphanWarnings: new Map(),
  restoring: false,
  el: null,
};

function historyKeyForOpen(existing = "") {
  if (!terms.saveHistory) return null;
  return existing || newHistoryKey();
}

/** Writes the panel down: which shells are open, where, in what order, and the
 *  key that names each one's kept stream. No output passes through here - it
 *  never has to, and a terminal's scrollback was never something localStorage
 *  should have been holding. */
function termsSavePrefs() {
  if (terms.restoring || window.devhqResetting) return;
  const entries = [...terms.known.entries()];
  try {
    localStorage.setItem(TERM_PREFS, JSON.stringify({
      height: terms.height,
      open: terms.open,
      active: Math.max(0, entries.findIndex(([id]) => id === terms.active)),
      sessions: entries.map(([, spec]) => ({
        projectPath: spec.projectPath,
        projectName: spec.projectName,
        popped: spec.popped,
        shell: spec.shell,
        pane: spec.pane,
        ...(terms.saveHistory && spec.key ? { key: spec.key } : {}),
      })),
      defaultShell: terms.defaultShell,
      splitRatio: terms.splitRatio,
      shellColors: terms.shellColors,
      shellMarkerStyle: terms.shellMarkerStyle,
      saveHistory: terms.saveHistory,
      enhancedHistorySearch: terms.enhancedHistorySearch,
    }));
  } catch { /* nothing here is worth failing a render over */ }
}

function termsLoadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(TERM_PREFS) || "{}");
    if (saved.height) terms.height = saved.height;
    if (saved.splitRatio >= .25 && saved.splitRatio <= .75) terms.splitRatio = saved.splitRatio;
    if (saved.shellColors && typeof saved.shellColors === "object") {
      for (const profile of Object.keys(DEFAULT_SHELL_COLORS)) {
        if (/^#[0-9a-f]{6}$/i.test(saved.shellColors[profile])) terms.shellColors[profile] = saved.shellColors[profile];
      }
    }
    if (["none", "dot", "code"].includes(saved.shellMarkerStyle)) terms.shellMarkerStyle = saved.shellMarkerStyle;
    if (typeof saved.saveHistory === "boolean") terms.saveHistory = saved.saveHistory;
    if (typeof saved.enhancedHistorySearch === "boolean") terms.enhancedHistorySearch = saved.enhancedHistorySearch;
    if (TERM_SHELLS.some((profile) => profile.value === saved.defaultShell)) {
      terms.defaultShell = saved.defaultShell;
      terms.nextShell = saved.defaultShell;
    }
    if (Array.isArray(saved.sessions)) {
      terms.restoreSpecs = saved.sessions.filter((s) => s?.projectPath);
      terms.restoreOpen = saved.open !== false;
      terms.restoreActive = Number.isInteger(saved.active) ? saved.active : 0;
    }
  } catch {}
}

function applyShellColors() {
  for (const [profile, color] of Object.entries(terms.shellColors)) {
    document.documentElement.style.setProperty(`--shell-color-${profile}`, color);
  }
}

function applyShellMarkerStyle() {
  const dock = terms.el;
  if (!dock) return;
  for (const style of ["none", "dot", "code"]) dock.classList.toggle(`shell-markers-${style}`, terms.shellMarkerStyle === style);
}

function broadcastShellMarkers() {
  term_dock_emit("term:markers", { style: terms.shellMarkerStyle, colors: terms.shellColors }).catch(() => {});
}

function termIcon(name) {
  return `<span class="ms" aria-hidden="true">${name}</span>`;
}

function shellMarker(command) {
  const profile = shellProfileFromCommand(command);
  const label = TERM_SHELLS.find((item) => item.value === profile)?.label || "Terminal";
  const short = {
    auto: "SH", pwsh: "PW7", "pwsh-preview": "PWP", powershell: "PS",
    cmd: "CMD", "git-bash": "GIT", wsl: "WSL", nu: "NU",
  }[profile] || "SH";
  return `<i class="shell-mark shell-${profile}" title="${escAttr(label)}" aria-label="${escAttr(label)}">${short}</i>`;
}

function dockEl() {
  if (terms.el) return terms.el;
  const el = document.createElement("div");
  el.id = "term-dock";
  const paneActions = (pane) => `<div class="dock-actions dock-pane-actions" data-pane-actions="${pane}">
    <div class="dock-new-split">
      <button data-dock="new" title="New terminal">${termIcon("add")}</button>
      <button class="dock-new-menu-button" data-dock="shell-menu" title="Choose terminal type" aria-haspopup="menu" aria-expanded="false">${termIcon("tune")}</button>
      <div class="dock-shell-menu" role="menu" hidden></div>
    </div>
    <button data-dock="debug" title="Copy terminal debug report">${termIcon("bug_report")}</button>
    <button data-dock="popout" title="Pop out this terminal">${termIcon("open_in_new")}</button>
    <button data-dock="close" title="Close this terminal">${termIcon("delete")}</button>
  </div>`;
  el.innerHTML = `
    <div class="dock-grip"></div>
    <div class="dock-bar">
      <div class="dock-tab-pane" data-tab-pane="0"><div class="dock-tabs"></div>${paneActions(0)}</div>
      <div class="dock-tab-pane" data-tab-pane="1"><div class="dock-tabs"></div>${paneActions(1)}</div>
      <button class="dock-hide" data-dock="hide" title="Hide the panel">${termIcon("keyboard_arrow_down")}</button>
    </div>
    <div class="dock-views">
      <div class="dock-pane-empty" data-empty-pane="0" hidden>Drop a terminal here</div>
      <div class="dock-divider" role="separator" aria-label="Resize terminal panes"></div>
      <div class="dock-pane-empty" data-empty-pane="1" hidden>Drop a terminal here</div>
      <div class="dock-drop-zones" aria-hidden="true">
        <div data-drop-pane="0"><span>${termIcon("dock_to_left")} Dock left</span></div>
        <div data-drop-pane="1"><span>${termIcon("dock_to_right")} Dock right</span></div>
      </div>
    </div>
    <div class="dock-tab-menu" role="menu" hidden></div>
    <div class="term-shell-error" role="alertdialog" aria-modal="true" aria-labelledby="term-shell-error-title" hidden>
      <div class="term-shell-error-card">
        ${termIcon("error")}
        <div><strong id="term-shell-error-title"></strong><p></p></div>
        <button data-shell-error-close>OK</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  terms.el = el;

  // Delegated, because the strip is rebuilt every time a shell starts, stops
  // or is switched to - per-tab handlers would be rewired on every one of them.
  let suppressTabClick = false;
  el.querySelector(".dock-bar").onclick = (e) => {
    if (suppressTabClick) return;
    const close = e.target.closest("[data-close]");
    if (close) return closeTerminal(close.dataset.close);
    if (e.target.closest("[data-new]")) return openNewTerminal();
    const tab = e.target.closest("[data-tab]");
    if (tab) return setActive(tab.dataset.tab);
    const action = e.target.closest("[data-dock]");
    if (!action) return;
    if (action.dataset.dock === "hide") return setDockOpen(false);
    const pane = Number(action.closest("[data-tab-pane]")?.dataset.tabPane || 0);
    const active = terms.paneActive[pane];
    if (action.dataset.dock === "new") return openNewTerminal(terms.defaultShell, pane);
    if (action.dataset.dock === "shell-menu") {
      e.stopPropagation();
      return setShellMenuOpen(terms.shellMenuPane === pane ? null : pane);
    }
    if (action.dataset.dock === "popout") return popOutTerminal(active);
    if (action.dataset.dock === "debug") {
      const report = terms.sessions.get(active)?.view.debugReport();
      if (report) navigator.clipboard.writeText(report).catch(() => {});
      return;
    }
    if (action.dataset.dock === "close") return closeTerminal(active);
  };

  const tabMenu = el.querySelector(".dock-tab-menu");
  el.querySelector(".dock-bar").addEventListener("contextmenu", (e) => {
    const tab = e.target.closest("[data-tab]");
    if (!tab) return;
    e.preventDefault();
    setActive(tab.dataset.tab);
    openTerminalTabMenu(tab.dataset.tab, e.clientX, e.clientY);
  });
  tabMenu.onclick = (e) => {
    const choice = e.target.closest("[data-switch-shell]");
    if (!choice) return;
    const id = tabMenu.dataset.tab;
    closeTerminalTabMenu();
    switchTerminalShell(id, choice.dataset.switchShell);
  };

  // Keep this gesture inside the webview rather than using HTML drag/drop.
  // Native browser dragging can activate whatever is behind the app when the
  // pointer leaves the window. Pointer capture keeps DevHQ in charge and also
  // lets us draw a clear preview of what is moving.
  const tabBar = el.querySelector(".dock-bar");
  const views = el.querySelector(".dock-views");
  const clearDropMarks = () => tabBar.querySelectorAll(".drop-before,.drop-after").forEach((tab) =>
    tab.classList.remove("drop-before", "drop-after")
  );
  const reorderTab = (id, target, after, pane) => {
    if (target?.dataset.tab === id) return;
    const remembered = terms.known.get(id);
    const oldPane = sessionPane(id);
    if (remembered) remembered.pane = pane;
    terms.paneActive[pane] = id;
    if (oldPane !== pane && terms.paneActive[oldPane] === id) {
      terms.paneActive[oldPane] = [...terms.sessions.keys()].find((sid) => sid !== id && sessionPane(sid) === oldPane) || null;
    }
    const ordered = [...terms.sessions.keys()].filter((sid) => sid !== id);
    if (target) {
      let at = ordered.indexOf(target.dataset.tab);
      if (after) at += 1;
      ordered.splice(at, 0, id);
    } else {
      ordered.push(id);
    }
    terms.sessions = new Map(ordered.map((sid) => [sid, terms.sessions.get(sid)]));
    const remaining = [...terms.known.entries()].filter(([sid]) => !terms.sessions.has(sid));
    terms.known = new Map([
      ...ordered.map((sid) => [sid, terms.known.get(sid)]),
      ...remaining,
    ]);
    terms.active = id;
    syncPaneLayout();
    renderTabs();
    fitVisible();
    termsSavePrefs();
  };
  tabBar.addEventListener("pointerdown", (down) => {
    const tab = down.target.closest("[data-tab]");
    if (!tab || down.target.closest("[data-close]") || down.button !== 0) return;
    const id = tab.dataset.tab;
    const startX = down.clientX;
    const startY = down.clientY;
    let dragging = false;
    let target = null;
    let after = false;
    let ghost = null;
    let nativePreview = false;
    tab.setPointerCapture(down.pointerId);

    const move = (e) => {
      if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
      if (!dragging) {
        dragging = true;
        suppressTabClick = true;
        tab.classList.add("dragging");
        ghost = document.createElement("div");
        ghost.className = "dock-tab-ghost";
        ghost.innerHTML = tab.innerHTML;
        document.body.appendChild(ghost);
        views.classList.add("choosing-pane");
      }
      const outsideWindow = e.clientX < 0 || e.clientX > window.innerWidth ||
        e.clientY < 0 || e.clientY > window.innerHeight;
      ghost.hidden = outsideWindow;
      ghost.style.transform = `translate(${e.clientX + 12}px,${e.clientY + 12}px)`;
      if (outsideWindow) {
        const action = nativePreview ? "move" : "open";
        nativePreview = true;
        term_dock_invoke("term_drag_preview", {
          action,
          x: e.screenX + 12,
          y: e.screenY + 12,
        }).catch(() => {});
      } else if (nativePreview) {
        nativePreview = false;
        term_dock_invoke("term_drag_preview", { action: "close", x: 0, y: 0 }).catch(() => {});
      }
      clearDropMarks();
      views.querySelectorAll("[data-drop-pane]").forEach((zone) => zone.classList.remove("hover"));
      const dropZone = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-drop-pane]");
      dropZone?.classList.add("hover");
      const strip = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-tab-pane]")?.getBoundingClientRect();
      const inStrip = strip && e.clientX >= strip.left && e.clientX <= strip.right &&
        e.clientY >= strip.top && e.clientY <= strip.bottom;
      target = inStrip ? document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-tab]") : null;
      if (target && target !== tab) {
        const rect = target.getBoundingClientRect();
        after = e.clientX >= rect.left + rect.width / 2;
        target.classList.add(after ? "drop-after" : "drop-before");
      }
    };
    const finish = (e, cancelled = false) => {
      const destination = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-drop-pane]");
      tab.removeEventListener("pointermove", move);
      tab.removeEventListener("pointerup", up);
      tab.removeEventListener("pointercancel", cancel);
      tab.classList.remove("dragging");
      clearDropMarks();
      ghost?.remove();
      views.classList.remove("choosing-pane");
      views.querySelectorAll("[data-drop-pane]").forEach((zone) => zone.classList.remove("hover"));
      if (nativePreview) {
        term_dock_invoke("term_drag_preview", { action: "close", x: 0, y: 0 }).catch(() => {});
      }
      if (!dragging) return;
      if (cancelled) {
        suppressTabClick = false;
        return;
      }
      const tabPane = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-tab-pane]");
      const strip = tabPane?.getBoundingClientRect();
      const dock = el.getBoundingClientRect();
      const inStrip = strip && e.clientX >= strip.left && e.clientX <= strip.right &&
        e.clientY >= strip.top && e.clientY <= strip.bottom;
      const inDock = e.clientX >= dock.left && e.clientX <= dock.right &&
        e.clientY >= dock.top && e.clientY <= dock.bottom;
      if (destination) moveToPane(id, Number(destination.dataset.dropPane));
      else if (inStrip) reorderTab(id, target, after, Number(tabPane.dataset.tabPane));
      else if (!inDock && (e.screenX || e.screenY)) popOutTerminal(id, e.screenX, e.screenY);
      setTimeout(() => { suppressTabClick = false; }, 0);
    };
    const up = (e) => finish(e);
    const cancel = (e) => finish(e, true);
    tab.addEventListener("pointermove", move);
    tab.addEventListener("pointerup", up);
    tab.addEventListener("pointercancel", cancel);
  });

  el.querySelector(".dock-bar").addEventListener("click", (e) => {
    const choice = e.target.closest("[data-new-shell]");
    if (!choice) return;
    const pane = Number(choice.closest("[data-tab-pane]").dataset.tabPane);
    setShellMenuOpen(null);
    openNewTerminal(choice.dataset.newShell, pane);
  });
  document.addEventListener("pointerdown", (e) => {
    if (terms.shellMenuPane !== null && !e.target.closest(".dock-new-split")) setShellMenuOpen(null);
    if (!e.target.closest(".dock-tab-menu")) closeTerminalTabMenu();
  });
  window.addEventListener("blur", closeTerminalTabMenu);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTerminalTabMenu();
  });
  el.querySelector("[data-shell-error-close]").onclick = closeShellError;
  el.querySelector(".term-shell-error").onclick = (e) => {
    if (e.target.classList.contains("term-shell-error")) closeShellError();
  };

  // Drag the top edge to resize. Keep each visible terminal's scroll where it
  // is for the whole drag - changing --dock-h alone would let the browser
  // clamp scrollTop on every move, which reads as a scroll action.
  const grip = el.querySelector(".dock-grip");
  grip.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    grip.setPointerCapture(down.pointerId);
    const move = (e) => {
      const kept = terms.paneActive
        .map((id) => terms.sessions.get(id)?.view)
        .filter(Boolean)
        .map((view) => ({ view, top: view.scroll.scrollTop }));
      terms.height = clampDockHeight(window.innerHeight - e.clientY);
      applyDockHeight();
      for (const { view, top } of kept) view.scroll.scrollTop = top;
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      termsSavePrefs();
      fitVisible();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });

  const divider = el.querySelector(".dock-divider");
  divider.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    divider.setPointerCapture(down.pointerId);
    const move = (e) => {
      const rect = views.getBoundingClientRect();
      terms.splitRatio = Math.min(.75, Math.max(.25, (e.clientX - rect.left) / rect.width));
      syncPaneLayout();
    };
    const up = () => {
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
      termsSavePrefs();
      fitVisible();
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
  });

  window.addEventListener("resize", () => {
    // A window that just got shorter must give the shell its room back before
    // the terminal is refitted to whatever is left.
    const before = terms.height;
    applyDockHeight();
    fitVisible();
    if (terms.height !== before) termsSavePrefs();
  });
  return el;
}

/** The status bar's Terminal button toggles the dock without stopping any
 *  shells. With no existing or starting shell, it starts the first one. */
function openTerminalPanel() {
  if (terms.sessions.size || terms.pending.size) setDockOpen(!terms.open);
  else openNewTerminal();
}

function syncTerminalButton() {
  const button = document.getElementById("status-term");
  if (!button) return;
  const count = terms.sessions.size;
  const badge = button.querySelector(".term-count");
  if (badge) {
    badge.textContent = count;
    badge.hidden = count === 0;
  }
  renderOrphanWarnings();
  button.classList.toggle("on", terms.open);
  button.setAttribute("aria-expanded", String(terms.open));
  button.title = terms.open
    ? "Hide terminals"
    : count
      ? `Show ${count} open terminal${count === 1 ? "" : "s"}`
      : "Open a terminal";
}

function renderOrphanWarnings(error = "") {
  const wrap = document.getElementById("status-orphan-wrap");
  const button = document.getElementById("status-orphan");
  const pop = document.getElementById("orphan-pop");
  if (!wrap || !button || !pop) return;
  wireOrphanWarnings(button, pop);
  const processes = [...terms.orphanWarnings.values()];
  wrap.hidden = processes.length === 0;
  button.querySelector("b").textContent = processes.length;
  if (!processes.length) {
    pop.hidden = true;
    button.setAttribute("aria-expanded", "false");
    return;
  }
  pop.innerHTML = `<header><strong>${processes.length} process${processes.length === 1 ? "" : "es"} still running</strong><button type="button" data-orphan-kill-all>Kill all</button></header>${processes.map((process) => `<div class="orphan-row"><strong>${termEsc(process.process || "Unknown process")} <span class="mono">${process.pid}</span></strong><small title="${termEsc(process.executablePath || "")}">${termEsc(process.executablePath || "Path unavailable")}</small><button type="button" data-orphan-kill="${process.pid}">Kill</button></div>`).join("")}${error ? `<div class="orphan-error">${termEsc(error)}</div>` : ""}`;
}

async function refreshOrphanWarnings() {
  const expected = [...terms.orphanWarnings.values()];
  if (!expected.length) return renderOrphanWarnings();
  const survivors = await term_dock_invoke("process_survivors", { expected }).catch(() => expected);
  terms.orphanWarnings = new Map((survivors || []).map((process) => [process.pid, process]));
  renderOrphanWarnings();
}

async function killOrphan(process) {
  await term_dock_invoke("port_kill", {
    pid: process.pid,
    expectedExecutable: process.executablePath || "",
    expectedProcess: process.process || "",
    // The warning lists every survivor separately, so each one is killed on its
    // own - taking a tree here would terminate rows the user has not clicked.
    tree: false,
  });
  terms.orphanWarnings.delete(process.pid);
}

function wireOrphanWarnings(button, pop) {
  if (button.dataset.wired) return;
  button.dataset.wired = "true";
  button.onclick = async () => {
    const opening = pop.hidden;
    if (opening) await refreshOrphanWarnings();
    pop.hidden = !opening || terms.orphanWarnings.size === 0;
    button.setAttribute("aria-expanded", String(!pop.hidden));
  };
  pop.onclick = async (event) => {
    const one = event.target.closest("[data-orphan-kill]");
    const all = event.target.closest("[data-orphan-kill-all]");
    if (!one && !all) return;
    const targets = one
      ? [terms.orphanWarnings.get(Number(one.dataset.orphanKill))].filter(Boolean)
      : [...terms.orphanWarnings.values()];
    try {
      for (const process of targets) await killOrphan(process);
      renderOrphanWarnings();
    } catch (error) {
      renderOrphanWarnings(String(error));
    }
  };
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("#status-orphan-wrap")) {
      pop.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }
  });
}

/** The dock can never be taller than the window it sits in. `#root` is laid out
 *  above it, so a height carried over from a maximized window — or restored on a
 *  smaller screen — leaves the app as nothing but a full-height terminal with
 *  the project shell squeezed to zero. Clamping here rather than only at the
 *  drag means a saved height and a window resize are both covered. */
function clampDockHeight(height) {
  const room = Math.max(120, window.innerHeight - 220);
  return Math.min(Math.max(height, 140), room);
}

function applyDockHeight() {
  terms.height = clampDockHeight(terms.height);
  document.documentElement.classList.toggle("terminal-dock-open", terms.open);
  document.documentElement.style.setProperty("--dock-h", terms.open ? `${terms.height}px` : "0px");
}

function setDockOpen(open) {
  terms.open = open;
  dockEl().classList.toggle("open", open);
  applyDockHeight();
  syncTerminalButton();
  if (open) {
    fitVisible();
    terms.sessions.get(terms.active)?.view.focus();
  }
  termsSavePrefs();
}

function fitVisible() {
  if (!terms.open) return;
  for (const id of terms.paneActive) terms.sessions.get(id)?.view.fit();
}

/** Kept as the window-state callback for compatibility. The preceding fit now
 *  owns resize handling and preserves the terminal's exact viewport. */
function settleVisible() {
  // Intentionally empty: maximize and restore must not move the scroller.
}

function sessionPane(id) {
  return terms.known.get(id)?.pane === 1 ? 1 : 0;
}

function syncPaneLayout() {
  const views = dockEl().querySelector(".dock-views");
  const bar = dockEl().querySelector(".dock-bar");
  const split = [...terms.sessions.keys()].some((id) => sessionPane(id) === 1);
  views.classList.toggle("split", split);
  bar.classList.toggle("split", split);
  views.style.setProperty("--term-split", `${terms.splitRatio * 100}%`);
  bar.style.setProperty("--term-split", `${terms.splitRatio * 100}%`);
  for (const [id, session] of terms.sessions) {
    const pane = sessionPane(id);
    session.host.dataset.pane = pane;
    session.host.classList.toggle("on", terms.paneActive[pane] === id);
  }
  for (const empty of views.querySelectorAll("[data-empty-pane]")) {
    const pane = Number(empty.dataset.emptyPane);
    empty.hidden = !split || terms.paneActive[pane] !== null;
  }
}

function moveToPane(id, pane) {
  const session = terms.sessions.get(id);
  const remembered = terms.known.get(id);
  if (!session || !remembered) return;
  const oldPane = sessionPane(id);
  remembered.pane = pane;
  terms.paneActive[pane] = id;
  if (terms.paneActive[oldPane] === id) {
    terms.paneActive[oldPane] = [...terms.sessions.keys()].find((sid) => sid !== id && sessionPane(sid) === oldPane) || null;
  }
  terms.active = id;
  syncPaneLayout();
  renderTabs();
  fitVisible();
  session.view.focus();
  termsSavePrefs();
}

/** A short-lived line in the main window's activity strip. */
function termNote(key, label, ms = 2600) {
  window.devhqWork?.beginWork(key, label);
  setTimeout(() => window.devhqWork?.endWork(key), ms);
}

function renderTabs() {
  const bars = [...dockEl().querySelectorAll(".dock-tabs")];
  for (let pane = 0; pane < 2; pane++) {
    const starting = [...terms.pending.values()]
      .filter((pending) => pending.pane === pane)
      .map((pending) =>
        `<span class="dock-tab pending"><i class="dot"></i>${escAttr(pending.label)}<em>starting...</em></span>`
      )
      .join("");
    const tabs = [...terms.sessions.values()]
    .filter((s) => sessionPane(s.info.id) === pane)
    .map((s) => {
      const label = s.info.projectName || "shell";
      const cls = ["dock-tab"];
      if (s.info.id === terms.active) cls.push("on");
      if (terms.paneActive[sessionPane(s.info.id)] === s.info.id) cls.push("visible");
      if (s.view.exited) cls.push("dead");
      return `<div class="${cls.join(" ")}" data-tab="${s.info.id}" title="Right-click to change shell · drag to dock or reorder · ${escAttr(
        s.info.projectPath
      )}">${shellMarker(s.info.command)}<span class="nm">${escAttr(label)}</span>
        <span class="tab-x" data-close="${s.info.id}" title="Close this terminal">${termIcon(
          "close"
        )}</span></div>`;
    })
    .join("");
    const open = tabs + starting;
    bars[pane].innerHTML = open || '<span class="dock-empty">No terminals</span>';
  }
  for (const actions of dockEl().querySelectorAll("[data-pane-actions]")) {
    const pane = Number(actions.dataset.paneActions);
    for (const button of actions.querySelectorAll('[data-dock="debug"],[data-dock="popout"],[data-dock="close"]')) {
      button.disabled = !terms.paneActive[pane];
    }
    for (const button of actions.querySelectorAll('[data-dock="new"],[data-dock="shell-menu"]')) {
      button.disabled = !newTerminalTarget(pane).path;
    }
  }
  renderShellMenu();
  syncTerminalButton();
}

function renderShellMenu() {
  for (const paneEl of dockEl().querySelectorAll("[data-tab-pane]")) {
    const pane = Number(paneEl.dataset.tabPane);
    const menu = paneEl.querySelector(".dock-shell-menu");
    menu.innerHTML = `<div class="dock-menu-label">New terminal with</div>${TERM_SHELLS.map((profile) => {
      const status = terms.shellAvailability.get(profile.value);
      return `<button role="menuitem" data-new-shell="${profile.value}"${status?.available === false ? " disabled" : ""}${status?.reason ? ` title="${escAttr(status.reason)}"` : ""}>${profile.label}${
        status?.available === false ? "<span>Unavailable</span>" : profile.value === terms.defaultShell ? "<span>Default</span>" : ""
      }</button>`;
    }).join("")}`;
    menu.hidden = terms.shellMenuPane !== pane;
    paneEl.querySelector('[data-dock="shell-menu"]').setAttribute("aria-expanded", String(terms.shellMenuPane === pane));
  }
}

function setShellMenuOpen(pane) {
  terms.shellMenuPane = pane;
  renderShellMenu();
}

async function loadShellAvailability() {
  try {
    const profiles = await term_dock_invoke("term_shell_availability");
    terms.shellAvailability = new Map(profiles.map((profile) => [profile.profile, profile]));
    for (const profile of TERM_SHELLS) Object.assign(profile, terms.shellAvailability.get(profile.value));
    renderTabs();
    return true;
  } catch {
    return false;
  }
}

function closeShellError() {
  const dialog = terms.el?.querySelector(".term-shell-error");
  if (dialog) dialog.hidden = true;
}

function showShellError(shell, detail = "") {
  const profile = TERM_SHELLS.find((item) => item.value === shell);
  const status = terms.shellAvailability.get(shell);
  const label = profile?.label || "That shell";
  const dialog = dockEl().querySelector(".term-shell-error");
  dialog.querySelector("strong").textContent = `${label} couldn't start`;
  dialog.querySelector("p").textContent = status?.reason || detail || `${label} is not available on this computer.`;
  dialog.hidden = false;
  dialog.querySelector("button").focus();
}

function closeTerminalTabMenu() {
  const menu = terms.el?.querySelector(".dock-tab-menu");
  if (menu) menu.hidden = true;
}

function openTerminalTabMenu(id, x, y) {
  const session = terms.sessions.get(id);
  if (!session) return;
  const current = shellProfileFromCommand(session.info.command);
  const menu = dockEl().querySelector(".dock-tab-menu");
  menu.dataset.tab = id;
  menu.innerHTML = `<div class="dock-menu-label">Restart terminal with</div>${TERM_SHELLS.map((profile) => {
    const status = terms.shellAvailability.get(profile.value);
    const disabled = profile.value === current || status?.available === false;
    const stateClass = profile.value === current ? "current" : status?.available === false ? "unavailable" : "";
    return `<button class="${stateClass}" role="menuitem" data-switch-shell="${profile.value}"${disabled ? " disabled" : ""}${status?.reason ? ` title="${escAttr(status.reason)}"` : ""}>
      <span>${profile.label}</span>${profile.value === current ? `<span class="dock-menu-current">Current</span>` : status?.available === false ? `<span class="dock-menu-current">Unavailable</span>` : ""}
    </button>`
  }).join("")}`;
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - rect.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - rect.height - 6))}px`;
}

async function switchTerminalShell(id, shell) {
  const old = terms.sessions.get(id);
  const remembered = terms.known.get(id);
  if (!old || !remembered || shellProfileFromCommand(old.info.command) === shell) return;
  if (terms.shellAvailability.get(shell)?.available === false) {
    showShellError(shell);
    return;
  }
  const ordered = [...terms.sessions.keys()];
  const index = ordered.indexOf(id);
  const pane = sessionPane(id);
  const label = old.info.projectName || "shell";
  const key = `term:switch:${id}`;
  window.devhqWork?.beginWork(key, `Restarting ${label} with ${TERM_SHELLS.find((profile) => profile.value === shell)?.label || shell}`);
  let replacement = null;
  try {
    const historyKey = historyKeyForOpen();
    replacement = await term_dock_invoke("term_open", {
      args: {
        projectPath: old.info.projectPath,
        projectName: label,
        shell,
        ...(historyKey ? { historyKey } : {}),
      },
    });
    await mountSession(replacement.id, historyKey || "", pane);

    old.view.dispose();
    old.host.remove();
    terms.sessions.delete(id);
    terms.known.delete(id);
    await term_dock_invoke("term_close", { id }).catch(() => {});

    const replacementSession = terms.sessions.get(replacement.id);
    const sessionEntries = [...terms.sessions.entries()].filter(([sid]) => sid !== replacement.id);
    sessionEntries.splice(Math.min(index, sessionEntries.length), 0, [replacement.id, replacementSession]);
    terms.sessions = new Map(sessionEntries);
    const knownReplacement = terms.known.get(replacement.id);
    const knownEntries = [...terms.known.entries()].filter(([sid]) => sid !== replacement.id);
    knownEntries.splice(Math.min(index, knownEntries.length), 0, [replacement.id, knownReplacement]);
    terms.known = new Map(knownEntries);
    terms.paneActive[pane] = replacement.id;
    terms.active = replacement.id;
    syncPaneLayout();
    renderTabs();
    replacementSession.view.fit();
    replacementSession.view.focus();
    termsSavePrefs();
  } catch (e) {
    if (replacement?.id && !terms.sessions.has(replacement.id)) {
      term_dock_invoke("term_close", { id: replacement.id }).catch(() => {});
    }
    showShellError(shell, String(e));
  } finally {
    window.devhqWork?.endWork(key);
  }
}

/** Where a shell opened from + or the corner button lands: alongside whatever
 *  is on screen, or in the folder being scanned when nothing is. */
function newTerminalTarget(pane = terms.active ? sessionPane(terms.active) : 0) {
  const active = terms.sessions.get(terms.paneActive[pane])?.info;
  if (active) return { path: active.projectPath, name: active.projectName || "this project" };
  const root = window.devhqPrimaryRoot?.() || "";
  return { path: root, name: root.split(/[\/]/).filter(Boolean).pop() || root || "no folder" };
}

function openNewTerminal(shell = terms.defaultShell, pane = terms.active ? sessionPane(terms.active) : 0) {
  const target = newTerminalTarget(pane);
  if (!target.path) {
    termNote("term:noroot", "Nowhere to open a shell - add a folder to scan first.", 4000);
    return;
  }
  if (terms.shellAvailability.get(shell)?.available === false) {
    showShellError(shell);
    return;
  }
  openTerminal(target, { shell, pane });
}

function escAttr(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function setActive(id) {
  terms.active = id;
  terms.paneActive[sessionPane(id)] = id;
  syncPaneLayout();
  renderTabs();
  if (terms.open) {
    const session = terms.sessions.get(id);
    if (session) {
      session.view.fit();
      session.view.focus();
    }
  }
  termsSavePrefs();
}

/** Opens a shell in a project's folder and shows it. The dock and a placeholder
 *  tab appear on the same frame as the click; the shell itself is started off
 *  the UI thread and takes the tab over when it is ready.
 *
 *  `opts.run` is a command line to type into the new shell - how the Run button
 *  starts a project. It is sent rather than spawned directly so that what comes
 *  up is a real, interactive shell: the command is visible as typed, Ctrl+C
 *  stops it, and the up arrow runs it again. */
async function openTerminal(project, opts = {}) {
  const key = `term:${project.path}:${Date.now()}`;
  const label = opts.run ? `${project.name} · ${shortRun(opts.run)}` : project.name;
  const pane = opts.pane === 1 ? 1 : opts.pane === 0 ? 0 : terms.active ? sessionPane(terms.active) : 0;
  terms.pending.set(key, { label, pane });
  renderTabs();
  setDockOpen(true);
  window.devhqWork?.beginWork(
    key,
    opts.run ? `Starting ${opts.run} in ${project.name}` : `Starting a shell in ${project.name}`
  );
  try {
    const historyKey = historyKeyForOpen();
    const info = await term_dock_invoke("term_open", {
      args: {
        projectPath: project.path,
        projectName: label,
        shell: opts.shell || terms.defaultShell,
        ...(historyKey ? { historyKey } : {}),
      },
    });
    terms.pending.delete(key);
    await mountSession(info.id, historyKey || "", pane);
    if (opts.run) sendWhenReady(info.id, opts.run);
  } catch (e) {
    terms.pending.delete(key);
    renderTabs();
    const shell = opts.shell || terms.defaultShell;
    if (shell !== "auto") showShellError(shell, String(e));
    else termNote(`${key}:err`, `Could not open a shell in ${project.name}: ${e}`, 5000);
  } finally {
    terms.pending.delete(key);
    window.devhqWork?.endWork(key);
  }
}

/** The command without its package manager, for a tab that has to stay short:
 *  `npm run dev` reads as `dev`. */
function shortRun(cmd) {
  const words = cmd.trim().split(/\s+/);
  return words[words.length - 1];
}

/** Types a command into a shell that has just started.
 *
 *  Not on a timer: the first thing the session paints is the prompt, which is
 *  the shell saying it is up and reading. Sending before that would post
 *  keystrokes into a pipe nobody is listening on yet. */
function sendWhenReady(id, command) {
  const session = terms.sessions.get(id);
  if (!session) return;
  session.view.onFirstOutput = () => session.view.send(command + "\r");
}

/** Attaches a view to a session that already exists — a new one, or one coming
 *  back from a popped-out window. */
async function mountSession(id, historyKey = "", restoredPane = 0) {
  if (terms.sessions.has(id)) {
    setActive(id);
    return;
  }
  const host = document.createElement("div");
  host.className = "term-host";
  dockEl().querySelector(".dock-views").appendChild(host);

  const remembered = terms.known.get(id);

  const view = new TermView(host, id);
  const info = await view.attach();
  const session = { info, view, host };
  terms.sessions.set(id, session);
  terms.known.set(id, {
    projectPath: info.projectPath,
    projectName: info.projectName || "shell",
    popped: false,
    // The stream this terminal is kept as. A terminal coming back from its own
    // window keeps the one it already had.
    key: terms.saveHistory ? (historyKey || remembered?.key || "") : "",
    shell: shellProfileFromCommand(info.command),
    pane: remembered?.pane === 1 || restoredPane === 1 ? 1 : 0,
  });

  view.onTitle = (title) => {
    session.info.title = title;
  };
  view.onExit = () => {
    renderTabs();
  };

  setActive(id);
  view.fit();
  termsSavePrefs();
}

/** Moves on after a session leaves the panel, whichever way it left.
 *
 *  With nothing left to show, the panel goes with it - an empty strip across
 *  the bottom of the window is just a bar saying "No terminals open". A shell
 *  still starting counts as something to show, so the panel does not blink
 *  shut and straight back open underneath it. */
function focusNext() {
  for (let pane = 0; pane < 2; pane++) {
    if (!terms.sessions.has(terms.paneActive[pane])) {
      terms.paneActive[pane] = [...terms.sessions.keys()].find((id) => sessionPane(id) === pane) || null;
    }
  }
  const next = terms.paneActive.find((id) => terms.sessions.has(id));
  terms.active = next || null;
  if (terms.active) {
    setActive(terms.active);
    return;
  }
  renderTabs();
  syncPaneLayout();
  if (!terms.pending.size) setDockOpen(false);
}

function removeTerminal(id) {
  const session = terms.sessions.get(id);
  if (!session) return;
  session.view.dispose();
  session.host.remove();
  terms.sessions.delete(id);
  terms.known.delete(id);
  focusNext();
  termsSavePrefs();
}

function scheduleOrphanCheck(expected) {
  if (!expected?.length) return;
  setTimeout(() => {
    const key = `terminal-orphans:${Date.now()}`;
    window.devhqWork?.beginWork(key, "Checking for terminal processes left running");
    term_dock_invoke("process_survivors", { expected })
      .then((survivors) => {
        for (const process of survivors || []) terms.orphanWarnings.set(process.pid, process);
        syncTerminalButton();
      })
      .finally(() => window.devhqWork?.endWork(key));
  }, 2000);
}

function closeTerminalAndWatch(id) {
  if (!terms.sessions.has(id)) return;
  term_dock_invoke("term_close_snapshot", { id })
    .then(scheduleOrphanCheck)
    .catch(() => term_dock_invoke("term_close", { id }).catch(() => {}));
  removeTerminal(id);
}

/** Close immediately — same as the tab ×. The old Ctrl+C wait dialog is gone. */
function closeTerminal(id) {
  closeTerminalAndWatch(id);
}

/** Hands the session to its own window. The shell is untouched — only the view
 *  moves, so a running build carries straight on. */
async function popOutTerminal(id, screenX, screenY) {
  const session = terms.sessions.get(id);
  if (!session) return;
  const remembered = terms.known.get(id);
  // The panel lets go on the same frame as the click; the window is opened
  // behind it. Waiting for the window first would leave the terminal sitting
  // in the dock looking as though nothing happened.
  session.view.dispose();
  session.host.remove();
  terms.sessions.delete(id);
  if (remembered) remembered.popped = true;
  focusNext();
  const key = `popout:${id}`;
  window.devhqWork?.beginWork(key, `Opening ${session.info.projectName || "the terminal"} in its own window`);
  try {
    await term_dock_invoke("term_popout", {
      id,
      x: Number.isFinite(screenX) ? screenX - 80 : null,
      y: Number.isFinite(screenY) ? screenY - 18 : null,
    });
    termsSavePrefs();
  } catch (e) {
    termNote("popout", `Could not pop the terminal out: ${e}`, 5000);
    // The window never came up, so the session has no view at all — take it
    // back into the panel rather than leaving it running unseen, and open the
    // panel again if letting go of this one had closed it.
    // Only what came from before this run: the session itself still holds
    // everything it has printed, and `attach` brings that back on its own.
    await mountSession(id).catch(() => {});
    setDockOpen(true);
  } finally {
    window.devhqWork?.endWork(key);
  }
}

termsLoadPrefs();
applyShellColors();
dockEl();
applyShellMarkerStyle();
renderTabs();
applyDockHeight();

// A popped-out window docking back, or simply being closed: take the session
// into the panel rather than letting it run with nothing showing it.
// The cross on a popped-out window: that terminal is gone, not moving. Forget
// it rather than pulling it back into the panel or restoring it next launch.
term_dock_listen("term:closed", (event) => {
  const id = event.payload.id;
  terms.known.delete(id);
  renderTabs();
  termsSavePrefs();
});

term_dock_listen("term:close-watch", (event) => {
  const id = event.payload?.id;
  if (!id) return;
  term_dock_invoke("term_close_snapshot", { id })
    .then(scheduleOrphanCheck)
    .catch(() => term_dock_invoke("term_close", { id }).catch(() => {}));
});

term_dock_listen("term:docked", async (event) => {
  const id = event.payload.id;
  await term_dock_invoke("term_dock", { id }).catch(() => {});
  try {
    await mountSession(id);
    setDockOpen(true);
    termsSavePrefs();
  } catch {}
});

/** Recreates the shells that were open when DevHQ last closed. Processes do
 *  not survive app shutdown; the replacement sessions start in the same
 *  folders and retain their tab order. */
async function restoreTerminals() {
  const specs = terms.restoreSpecs;
  // Streams nobody is going to open again - a terminal closed while DevHQ was
  // not running, or one lost with a crash - are dropped before anything else
  // touches them.
  term_dock_invoke("term_prune_history", {
    keys: terms.saveHistory ? specs.map((spec) => spec.key).filter(Boolean) : [],
  }).catch(() => {});
  if (!specs.length) return;
  terms.restoring = true;
  setDockOpen(true);
  const restored = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const key = `term:restore:${i}`;
    terms.pending.set(key, { label: spec.projectName || "shell", pane: spec.pane === 1 ? 1 : 0 });
    renderTabs();
    window.devhqWork?.beginWork(key, `Restoring terminal in ${spec.projectName || spec.projectPath}`);
    try {
      // The shell is new; the scrollback is not. `term_open` replays this
      // terminal's kept stream into the parser before the shell starts, so
      // what comes back is the session's own history rather than a copy.
      const historyKey = historyKeyForOpen(spec.key);
      const info = await term_dock_invoke("term_open", {
        args: {
          projectPath: spec.projectPath,
          projectName: spec.projectName || "shell",
          shell: spec.shell || terms.defaultShell,
          ...(historyKey ? { historyKey } : {}),
        },
      });
      terms.pending.delete(key);
      await mountSession(info.id, historyKey || "", spec.pane);
      restored.push(info.id);
      if (spec.popped) await popOutTerminal(info.id);
    } catch {
      terms.pending.delete(key);
      renderTabs();
    } finally {
      window.devhqWork?.endWork(key);
    }
  }
  terms.restoring = false;
  const preferred = restored[Math.min(terms.restoreActive, restored.length - 1)];
  const active = terms.sessions.has(preferred) ? preferred : terms.sessions.keys().next().value;
  if (active) setActive(active);
  setDockOpen(terms.restoreOpen && terms.sessions.size > 0);
  termsSavePrefs();
}

// A pop-out reports where its title-bar drag ended. Only accept the handoff
// when that point is over the visible terminal area in this window.
term_dock_listen("term:drop", async (event) => {
  const { id, x, y } = event.payload;
  const dock = dockEl().getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const main = window.__TAURI__.window.getCurrentWindow();
  const pos = await main.innerPosition();
  const inside = x >= pos.x + dock.left * scale && x <= pos.x + dock.right * scale &&
    y >= pos.y + dock.top * scale && y <= pos.y + dock.bottom * scale;
  if (!terms.open || !inside) return;
  await term_dock_invoke("term_dock", { id }).catch(() => {});
  try {
    await mountSession(id);
    setDockOpen(true);
  } catch {}
});

window.openTerminal = openTerminal;
window.openTerminalPanel = openTerminalPanel;
window.setDockOpen = setDockOpen;
window.syncTerminalButton = syncTerminalButton;
window.termsState = terms;

function shellProfileFromCommand(command) {
  const value = String(command || "").toLowerCase();
  if (value.includes("git\\bin\\bash.exe")) return "git-bash";
  if (value.includes("7-preview\\pwsh.exe")) return "pwsh-preview";
  if (value.includes("pwsh.exe")) return "pwsh";
  if (value.includes("wsl.exe") || value.startsWith("wsl")) return "wsl";
  if (value.includes("powershell.exe") || value.startsWith("powershell")) return "powershell";
  if (value.includes("cmd.exe") || value.startsWith("cmd")) return "cmd";
  if (value.includes("nu.exe") || value.startsWith("nu")) return "nu";
  return "auto";
}

window.devhqTerminalSettings = {
  profiles: TERM_SHELLS,
  getDefault: () => terms.defaultShell,
  scan: loadShellAvailability,
  shellColors: () => ({ ...terms.shellColors }),
  getShellMarkerStyle: () => terms.shellMarkerStyle,
  setShellMarkerStyle: (style) => {
    if (!["none", "dot", "code"].includes(style)) return;
    terms.shellMarkerStyle = style;
    applyShellMarkerStyle();
    termsSavePrefs();
    broadcastShellMarkers();
  },
  setShellColor: (shell, color) => {
    if (!(shell in DEFAULT_SHELL_COLORS) || !/^#[0-9a-f]{6}$/i.test(color)) return;
    terms.shellColors[shell] = color;
    applyShellColors();
    termsSavePrefs();
    broadcastShellMarkers();
  },
  resetShellColors: () => {
    terms.shellColors = { ...DEFAULT_SHELL_COLORS };
    applyShellColors();
    termsSavePrefs();
    broadcastShellMarkers();
  },
  setDefault: (shell) => {
    if (!TERM_SHELLS.some((profile) => profile.value === shell)) return;
    if (terms.shellAvailability.get(shell)?.available === false) {
      showShellError(shell);
      return;
    }
    terms.defaultShell = shell;
    terms.nextShell = shell;
    termsSavePrefs();
    renderTabs();
  },
  getSaveHistory: () => terms.saveHistory,
  getEnhancedHistorySearch: () => terms.enhancedHistorySearch,
  setEnhancedHistorySearch: (enabled) => {
    terms.enhancedHistorySearch = Boolean(enabled);
    termsSavePrefs();
  },
  setSaveHistory: (enabled) => {
    const next = Boolean(enabled);
    if (terms.saveHistory === next) return;
    terms.saveHistory = next;
    if (!next) {
      for (const spec of terms.known.values()) spec.key = "";
      term_dock_invoke("term_prune_history", { keys: [] }).catch(() => {});
    }
    termsSavePrefs();
  },
  settleVisible,
  fitVisible,
};

restoreTerminals();
loadShellAvailability();
