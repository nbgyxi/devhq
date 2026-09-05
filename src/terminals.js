// The terminal dock: a strip of live shells at the bottom of WinT, each one
// tied to the project it was opened from.
//
// The dock lives outside `#root` on purpose. `render()` replaces that subtree
// wholesale on every rescan, and a terminal must survive that — its DOM is
// mounted once and only ever mutated in place.

const term_dock_invoke = window.__TAURI__.core.invoke;
const term_dock_listen = window.__TAURI__.event.listen;
const term_dock_emit = window.__TAURI__.event.emit;

/** Where this dock is drawn and whose terminals it holds.
 *
 *  WinT's own dock is the strip across the bottom of the main window. A
 *  workspace mounts the same dock inside one of its panels instead, so the
 *  terminal in a workspace is this terminal - tabs, splits, shell types, the
 *  shell menu, pop-out and all - and not a second, thinner one.
 *
 *  A host sets `window.wintDockHost` before this file loads:
 *    id          names this dock's own list of what it has open
 *    container   the element the dock is appended to
 *    projectPath the folder a new terminal opens in
 *    projectName what to call that folder
 *    autoOpen    start a shell when there is nothing to restore
 *    onDock      a terminal has been handed back into this dock
 *  Absent, the dock is WinT's own and behaves exactly as it always has. */
const dockHost = window.wintDockHost || null;
const embedded = Boolean(dockHost);

/** Where WinT keeps the terminal settings that are the same in every window.
 *  A dock in a workspace reads them from here and writes down only its own
 *  open terminals, so changing the default shell once changes it everywhere. */
const TERM_APP_PREFS = "wint.terminals.v1";

/** Where a dock other than WinT's own writes what it has open, one key per
 *  host. Every window shares one localStorage, so a dock can read what the
 *  other docks are holding - which is how pruning kept scrollback never throws
 *  away the terminals of a workspace that simply is not open at the time. */
const TERM_DOCK_PREFIX = "wint.terminals.dock.v1:";

const TERM_PREFS = dockHost ? `${TERM_DOCK_PREFIX}${dockHost.id}` : TERM_APP_PREFS;

/** This window. Sessions popped out of a dock carry it, so that a terminal
 *  handed back lands in the dock it came from rather than in every dock that
 *  happened to be listening. */
const dockOrigin = window.__TAURI__.window.getCurrentWindow().label;

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
  { value: "claude", label: "Claude Code" },
];
const DEFAULT_SHELL_COLORS = {
  pwsh: "#4d9df5", "pwsh-preview": "#c162de", powershell: "#61afef",
  cmd: "#8cc265", "git-bash": "#e05561", wsl: "#d5a458", nu: "#c162de", claude: "#d97757", auto: "#42b3c2",
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
  splitDirection: "vertical",
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
  /** Replace the shell's small reverse search with WinT's searchable history. */
  enhancedHistorySearch: true,
  orphanWarnings: new Map(),
  /** Why the last shell that failed to start failed, for the caller that has
   *  somewhere to put it - `wt`, waiting at a prompt. */
  lastOpenError: "",
  restoring: false,
  el: null,
};

function historyKeyForOpen(existing = "") {
  if (!terms.saveHistory) return null;
  return existing || newHistoryKey();
}

/** Which dock is holding which live terminal, written where every window can
 *  read it: they all share one localStorage, and reading it is instant and
 *  cannot be missed.
 *
 *  A terminal handed back from its own window has to reach the dock it came
 *  from, and the window that hears the handover first is not necessarily that
 *  dock. Asking - by broadcast, and hoping for an answer before acting - is a
 *  race; looking the terminal up is not.
 *
 *  Session ids only mean anything while the app is running, so this is not a
 *  preference: at startup a dock forgets everything it had claimed, because
 *  nothing it was holding survived. */
const OWNERS_KEY = "wint.terminals.owners.v1";

function readOwners() {
  try {
    const owners = JSON.parse(localStorage.getItem(OWNERS_KEY) || "{}");
    return owners && typeof owners === "object" ? owners : {};
  } catch { return {}; }
}

function writeOwners(owners) {
  try { localStorage.setItem(OWNERS_KEY, JSON.stringify(owners)); } catch { /* nothing to do about it */ }
}

/** This dock holds that terminal - still true while it is popped out into its
 *  own window, which is the whole point: that window is showing it, but this
 *  dock is where it goes back to. */
function ownTerminal(id) {
  const owners = readOwners();
  if (owners[id] === dockOrigin) return;
  owners[id] = dockOrigin;
  writeOwners(owners);
}

function disownTerminal(id) {
  const owners = readOwners();
  if (!(id in owners)) return;
  delete owners[id];
  writeOwners(owners);
}

function forgetOwnedTerminals() {
  const owners = readOwners();
  let changed = false;
  for (const [id, owner] of Object.entries(owners)) {
    if (owner !== dockOrigin) continue;
    delete owners[id];
    changed = true;
  }
  if (changed) writeOwners(owners);
}

/** Every kept stream any dock in the app still means to open again, this one
 *  included. Pruning to only what this dock holds would delete the scrollback
 *  of every workspace that happens to be closed. */
function allKeptStreams() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const name = localStorage.key(i);
    if (name !== TERM_APP_PREFS && !name?.startsWith(TERM_DOCK_PREFIX)) continue;
    try {
      for (const spec of JSON.parse(localStorage.getItem(name) || "{}").sessions || []) {
        if (spec?.key) keys.push(spec.key);
      }
    } catch { /* a key that cannot be read holds no streams worth keeping */ }
  }
  return keys;
}

/** Writes the panel down: which shells are open, where, in what order, and the
 *  key that names each one's kept stream. No output passes through here - it
 *  never has to, and a terminal's scrollback was never something localStorage
 *  should have been holding. */
function termsSavePrefs() {
  if (terms.restoring || window.wintResetting) return;
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
        tabColor: spec.tabColor || "",
        colorScheme: spec.colorScheme || "",
        ...(terms.saveHistory && spec.key ? { key: spec.key } : {}),
      })),
      defaultShell: terms.defaultShell,
      splitRatio: terms.splitRatio,
      splitDirection: terms.splitDirection,
      shellColors: terms.shellColors,
      shellMarkerStyle: terms.shellMarkerStyle,
      saveHistory: terms.saveHistory,
      enhancedHistorySearch: terms.enhancedHistorySearch,
    }));
  } catch { /* nothing here is worth failing a render over */ }
}

/** What shells there are, what they look like and which one is the default is
 *  one answer for the whole app, and it is WinT's settings panel that gives
 *  it. Only the list of what a dock has open is per window. */
function termsLoadSettings() {
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(TERM_APP_PREFS) || "{}"); } catch { return {}; }
  })();
  terms.shellColors = { ...DEFAULT_SHELL_COLORS };
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
}

function termsLoadPrefs() {
  termsLoadSettings();
  try {
    const saved = JSON.parse(localStorage.getItem(TERM_PREFS) || "{}");
    if (saved.height) terms.height = saved.height;
    if (saved.splitRatio >= .25 && saved.splitRatio <= .75) terms.splitRatio = saved.splitRatio;
    if (["horizontal", "vertical"].includes(saved.splitDirection)) terms.splitDirection = saved.splitDirection;
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
    cmd: "CMD", "git-bash": "GIT", wsl: "WSL", nu: "NU", claude: "CC",
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
        <button data-shell-error-get hidden></button>
        <button data-shell-error-close>OK</button>
      </div>
    </div>`;
  // Embedded, the dock fills whatever panel it was given and that panel owns
  // its size, so the resize grip and the hide button - both of which move a
  // boundary this dock no longer draws - are left out of it.
  el.classList.toggle("embedded", embedded);
  (dockHost?.container || document.body).appendChild(el);
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
  // pointer leaves the window. Pointer capture keeps WinT in charge and also
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
  el.querySelector("[data-shell-error-get]").onclick = (e) => {
    closeShellError();
    window.wintOpenShellDownloads?.(e.currentTarget.dataset.shellErrorGet);
  };
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
      const ratio = terms.splitDirection === "horizontal"
        ? (e.clientY - rect.top) / rect.height
        : (e.clientX - rect.left) / rect.width;
      terms.splitRatio = Math.min(.75, Math.max(.25, ratio));
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

/** Opens a shell straight into its own window.
 *
 *  The panel is never involved: the session is started, remembered as a popped
 *  one and handed to `term_popout`, which only needs the shell to exist. Going
 *  through the dock - mounting a view, then disposing it a moment later - would
 *  flick the bottom panel open and shut for a terminal that was never going to
 *  live there. */
async function openTerminalWindow(shell = terms.defaultShell) {
  const target = newTerminalTarget();
  if (!target.path) {
    termNote("term:noroot", "Nowhere to open a shell - add a folder to scan first.", 4000);
    return;
  }
  if (terms.shellAvailability.get(shell)?.available === false) {
    showShellError(shell);
    return;
  }
  const key = `term:window:${target.path}:${Date.now()}`;
  window.wintWork?.beginWork(key, `Opening a shell in ${target.name} in its own window`);
  let opened = null;
  try {
    const historyKey = historyKeyForOpen();
    const info = await term_dock_invoke("term_open", {
      args: {
        projectPath: target.path,
        projectName: target.name,
        shell: shell || terms.defaultShell,
        ...(historyKey ? { historyKey } : {}),
      },
    });
    opened = info;
    terms.known.set(info.id, {
      projectPath: info.projectPath,
      projectName: info.projectName || "shell",
      popped: true,
      key: terms.saveHistory ? historyKey || "" : "",
      shell: shellProfileFromCommand(info.command),
      pane: 0,
    });
    ownTerminal(info.id);
    await term_dock_invoke("term_popout", {
      id: info.id, x: null, y: null, position: null, dimensions: null,
      maximized: false, fullscreen: false, focus: true, origin: dockOrigin,
    });
    termsSavePrefs();
  } catch (e) {
    terms.lastOpenError = String(e);
    if (opened) {
      // The shell is up; only the window failed. Leaving it running with
      // nothing showing it would strand it, so it comes into the panel instead.
      termNote("popout", `Could not open the terminal window: ${e}`, 5000);
      await mountSession(opened.id).catch(() => {});
      setDockOpen(true);
    } else if (shell !== "auto") showShellError(shell, String(e));
    else termNote(`${key}:err`, `Could not open a shell in ${target.name}: ${e}`, 5000);
  } finally {
    window.wintWork?.endWork(key);
  }
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
  // Embedded, the height is the panel's and the workspace grip moves it.
  if (embedded) return;
  terms.height = clampDockHeight(terms.height);
  document.documentElement.classList.toggle("terminal-dock-open", terms.open);
  document.documentElement.style.setProperty("--dock-h", terms.open ? `${terms.height}px` : "0px");
}

function setDockOpen(open) {
  // A dock inside a panel has no closed state: the panel is what is shown and
  // hidden, and a strip that emptied itself would leave the panel blank with
  // no way back to a new terminal.
  terms.open = embedded || open;
  dockEl().classList.toggle("open", terms.open);
  applyDockHeight();
  syncTerminalButton();
  if (terms.open) {
    fitVisible();
    // Only WinT's own dock takes the caret when it opens: there, opening the
    // panel is the click. A workspace panel is simply on screen, and a window
    // that grabs the keyboard for a shell nobody asked to type in is a window
    // that swallows the first thing typed into the chat beside it.
    if (!embedded) terms.sessions.get(terms.active)?.view.focus();
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
  views.classList.toggle("horizontal", split && terms.splitDirection === "horizontal");
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
  window.wintWork?.beginWork(key, label);
  setTimeout(() => window.wintWork?.endWork(key), ms);
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
      const tabColor = terms.known.get(s.info.id)?.tabColor;
      return `<div class="${cls.join(" ")}" data-tab="${s.info.id}"${/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(tabColor || "") ? ` style="--tab-color:${tabColor};border-bottom-color:${tabColor}"` : ""} title="Right-click to change shell · drag to dock or reorder · ${escAttr(
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
        status?.available === false ? "<span>Unavailable</span>" : status?.setup ? "<span>Set up</span>" : profile.value === terms.defaultShell ? "<span>Default</span>" : ""
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

/** What WinT could fetch, and what it already has. Cheap enough to ask for
 *  again after every install or removal, which is what keeps the shell menu,
 *  the error dialog and Settings saying the same thing. */
async function loadShellDownloads() {
  try {
    const rows = await term_dock_invoke("shell_downloads");
    shellDownloads.clear();
    for (const row of rows) shellDownloads.set(row.profile, row);
    return rows;
  } catch {
    return [];
  }
}

function closeShellError() {
  const dialog = terms.el?.querySelector(".term-shell-error");
  if (dialog) dialog.hidden = true;
}

/** `shell` names a terminal profile when the failure is one WinT can fix by
 *  fetching that shell, which turns the dialog from a dead end into a way on
 *  to the one place downloads live. */
function showTerminalError(title, detail, shell = "") {
  const dialog = dockEl().querySelector(".term-shell-error");
  const offer = dialog.querySelector("[data-shell-error-get]");
  // The offer to fetch a shell leads to WinT's settings, which a workspace
  // does not have. There it says how to install it instead of offering a
  // button that goes nowhere.
  const download = shell && !embedded ? downloadableShell(shell) : null;
  dialog.querySelector("strong").textContent = title;
  dialog.querySelector("p").textContent = download
    ? `${detail} WinT can download it for you — ${megabytes(download.downloadBytes)}, from ${download.source}.`
    : detail;
  offer.hidden = !download;
  offer.textContent = download ? `Get ${download.label}` : "";
  offer.dataset.shellErrorGet = shell;
  dialog.hidden = false;
  (download ? offer : dialog.querySelector("[data-shell-error-close]")).focus();
}

function megabytes(bytes) {
  return `${Math.round(Number(bytes || 0) / 1e6)} MB`;
}

/** The shells WinT can fetch itself, so a missing one has somewhere to go.
 *  Filled from Rust on startup; empty until then, and empty forever for the
 *  shells that ship with Windows or cannot be downloaded at all. */
const shellDownloads = new Map();

/** The download offer for a shell, or nothing when there is none to make -
 *  including when WinT already has its own copy, which is not a thing to
 *  offer twice. */
function downloadableShell(shell) {
  const row = shellDownloads.get(shell);
  return row && !row.managed ? row : null;
}

const PROFILE_HINTS = {
  pwsh: "Install it with: winget install Microsoft.PowerShell — or pick Windows PowerShell.",
  "pwsh-preview": "Install it with: winget install Microsoft.PowerShell.Preview",
  nu: "Install it with: winget install Nushell",
  wsl: "Install it with: wsl --install",
  "git-bash": "Install Git for Windows.",
  claude: "Install it with: npm install -g @anthropic-ai/claude-code — then run claude once to sign in.",
};

function showShellError(shell, detail = "") {
  const profile = TERM_SHELLS.find((item) => item.value === shell);
  const label = profile?.label || "That shell";
  const reason = terms.shellAvailability.get(shell)?.reason || detail
    || `${label} is not available on this computer.`;
  const missing = /not installed|not available|not found|not on PATH/i.test(reason);
  // The winget line is only worth printing for the shells WinT cannot fetch
  // itself; for the rest the dialog offers the download instead of describing
  // a command the user would have to go and type.
  const hint = missing && (embedded || !downloadableShell(shell)) ? PROFILE_HINTS[shell] : "";
  showTerminalError(
    missing ? `${label} isn't installed` : `${label} couldn't start`,
    hint ? `${reason} ${hint}` : reason,
    missing ? shell : ""
  );
}

/** The program a `wt` command line asks for, which is what failed when a pane
 *  does not appear - not the profile the pane would have used. */
function commandProgram(command) {
  const first = String(command || "").trim().match(/^"([^"]+)"|^(\S+)/);
  const program = first ? first[1] || first[2] : "";
  return program.split(/[\\/]/).pop() || "That command";
}

/** Where to get the shells people actually ask a pane to run, so a missing one
 *  is a thing to go and fix rather than a dead end. */
const PWSH_HINT = "Install it with: winget install Microsoft.PowerShell — or ask the pane for powershell instead.";
const SHELL_HINTS = {
  pwsh: PWSH_HINT,
  "pwsh.exe": PWSH_HINT,
  nu: "Install it with: winget install Nushell",
  "nu.exe": "Install it with: winget install Nushell",
  bash: "Install Git for Windows, or ask the pane for wsl.",
  "bash.exe": "Install Git for Windows, or ask the pane for wsl.",
  wsl: "Install it with: wsl --install",
  "wsl.exe": "Install it with: wsl --install",
};

/** The failure as the shell should read it: `wt` prints this at the prompt, so
 *  it carries the same way out as the dialog does. */
function paneErrorText(command, detail) {
  const hint = /is not installed/i.test(detail) ? SHELL_HINTS[commandProgram(command).toLowerCase()] : "";
  return hint ? `${detail} ${hint}` : detail;
}

/** A pane that never opened, said the way it would be said out loud: which
 *  program was wanted, that it is not here, and what to do about it. */
/** The terminal profile a `wt` command's program would have been, so a pane
 *  that failed for want of `pwsh` can offer the same download Settings does. */
const PANE_PROGRAM_PROFILES = {
  pwsh: "pwsh", "pwsh.exe": "pwsh",
  nu: "nu", "nu.exe": "nu",
  bash: "git-bash", "bash.exe": "git-bash",
};

function showPaneError(command, detail) {
  const program = commandProgram(command);
  if (/is not installed/i.test(detail)) {
    const shell = PANE_PROGRAM_PROFILES[program.toLowerCase()] || "";
    const hint = downloadableShell(shell)
      ? ""
      : SHELL_HINTS[program.toLowerCase()] || "Install it, or ask the pane for a program this computer has.";
    showTerminalError(
      `${program} isn't installed`,
      `Nothing on this computer answers to ${program}, so the pane had nothing to run.${hint ? ` ${hint}` : ""}`,
      shell
    );
    return;
  }
  // Anything else went wrong on the way to the pane, and the program is not
  // necessarily to blame for it.
  showTerminalError(
    /could not start/i.test(detail) ? `${program} couldn't start` : "That pane couldn't open",
    detail
  );
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
      <span>${profile.label}</span>${profile.value === current ? `<span class="dock-menu-current">Current</span>` : status?.available === false ? `<span class="dock-menu-current">Unavailable</span>` : status?.setup ? `<span class="dock-menu-current">Set up</span>` : ""}
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
  window.wintWork?.beginWork(key, `Restarting ${label} with ${TERM_SHELLS.find((profile) => profile.value === shell)?.label || shell}`);
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
    disownTerminal(id);
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
    window.wintWork?.endWork(key);
  }
}

/** Where a shell opened from + or the corner button lands: alongside whatever
 *  is on screen, or in the folder being scanned when nothing is. */
function newTerminalTarget(pane = terms.active ? sessionPane(terms.active) : 0) {
  const active = terms.sessions.get(terms.paneActive[pane])?.info;
  if (active) return { path: active.projectPath, name: active.projectName || "this project" };
  // Embedded, a new terminal belongs to the project the workspace is for;
  // in WinT it belongs to the folder being scanned.
  if (dockHost?.projectPath) {
    return { path: dockHost.projectPath, name: dockHost.projectName || "this project" };
  }
  const root = window.wintPrimaryRoot?.() || "";
  return { path: root, name: root.split(/[\/]/).filter(Boolean).pop() || root || "no folder" };
}

function openNewTerminal(shell = terms.defaultShell, pane = terms.active ? sessionPane(terms.active) : 0, opts = {}) {
  const target = newTerminalTarget(pane);
  if (!target.path) {
    termNote("term:noroot", "Nowhere to open a shell - add a folder to scan first.", 4000);
    return;
  }
  if (terms.shellAvailability.get(shell)?.available === false) {
    showShellError(shell);
    return;
  }
  openTerminal(target, { shell, pane, ...opts });
}

function escAttr(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/** Brings a terminal to the front. `focus` is false for the ones that arrive
 *  without anybody asking - restored, or the shell a workspace panel opens
 *  onto - which are shown but do not take the keyboard. */
function setActive(id, focus = true) {
  terms.active = id;
  terms.paneActive[sessionPane(id)] = id;
  syncPaneLayout();
  renderTabs();
  if (terms.open) {
    const session = terms.sessions.get(id);
    if (session) {
      session.view.fit();
      if (focus) session.view.focus();
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
  const label = opts.title || (opts.run ? `${project.name} · ${shortRun(opts.run)}` : project.name);
  const pane = opts.pane === 1 ? 1 : opts.pane === 0 ? 0 : terms.active ? sessionPane(terms.active) : 0;
  terms.pending.set(key, { label, pane });
  renderTabs();
  setDockOpen(true);
  window.wintWork?.beginWork(
    key,
    opts.run ? `Starting ${opts.run} in ${project.name}` : `Starting a shell in ${project.name}`
  );
  try {
    const historyKey = historyKeyForOpen();
    const info = await term_dock_invoke("term_open", {
      args: {
        projectPath: project.path,
        projectName: label,
        ...(opts.command ? { command: opts.command } : {}),
        shell: opts.shell || terms.defaultShell,
        ...(historyKey ? { historyKey } : {}),
      },
    });
    terms.pending.delete(key);
    await mountSession(info.id, historyKey || "", pane, opts.focus !== false);
    if (opts.run) sendWhenReady(info.id, opts.run);
    return info;
  } catch (e) {
    terms.pending.delete(key);
    renderTabs();
    const shell = opts.shell || terms.defaultShell;
    // Kept for whoever asked for this terminal: a `wt` command has a shell
    // waiting on the answer, and the dialog below is not something it can read.
    terms.lastOpenError = String(e);
    // A command was named - by `wt`, or by a project action. Naming the shell
    // profile here would blame something that is installed and working for a
    // program that is not on this computer.
    if (opts.command) showPaneError(opts.command, String(e));
    else if (shell !== "auto") showShellError(shell, String(e));
    else termNote(`${key}:err`, `Could not open a shell in ${project.name}: ${e}`, 5000);
  } finally {
    terms.pending.delete(key);
    window.wintWork?.endWork(key);
  }
  return null;
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
async function mountSession(id, historyKey = "", restoredPane = 0, focus = true) {
  if (terms.sessions.has(id)) {
    setActive(id, focus);
    return;
  }
  const host = document.createElement("div");
  host.className = "term-host";
  dockEl().querySelector(".dock-views").appendChild(host);

  const remembered = terms.known.get(id);
  // Written down where the other windows can see it, before anything can go
  // wrong: from here on this dock is where that terminal goes back to.
  ownTerminal(id);

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
    // A setup pane that has exited may well have installed the thing it was
    // set up for, and the menus would otherwise keep offering to set it up
    // again until the next restart.
    if (session.info.command.includes("claude-setup.ps1")) loadShellAvailability();
  };

  setActive(id, focus);
  view.fit();
  termsSavePrefs();
  // A host may want to know what this terminal is already doing - a dev server
  // it announced before the host was listening says nothing a second time.
  dockHost?.onSession?.(id);
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
  disownTerminal(id);
  focusNext();
  termsSavePrefs();
}

function scheduleOrphanCheck(expected) {
  if (!expected?.length) return;
  setTimeout(() => {
    const key = `terminal-orphans:${Date.now()}`;
    window.wintWork?.beginWork(key, "Checking for terminal processes left running");
    term_dock_invoke("process_survivors", { expected })
      .then((survivors) => {
        for (const process of survivors || []) terms.orphanWarnings.set(process.pid, process);
        syncTerminalButton();
      })
      .finally(() => window.wintWork?.endWork(key));
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

/** Every shell this dock is showing, closed for good, and what each one left
 *  running handed back to the caller.
 *
 *  A workspace calls this as its window goes. Without it those sessions stay
 *  alive in Rust with no terminal anywhere in the app showing them - a build
 *  or a dev server nobody can see and nobody can stop until WinT itself
 *  closes. Terminals popped out into their own windows are not this dock's to
 *  close: they have a window of their own and it is still on screen.
 *
 *  What comes back is the same process snapshot the tab × takes, so the caller
 *  can have it checked the same way. Prefs are frozen while this runs for the
 *  same reason restoring freezes them: what this window should open next time
 *  is what it was showing, not the empty strip it is being torn down into. */
async function closeDockTerminals() {
  terms.restoring = true;
  const expected = [];
  for (const id of [...terms.sessions.keys()]) {
    const processes = await term_dock_invoke("term_close_snapshot", { id }).catch(async () => {
      await term_dock_invoke("term_close", { id }).catch(() => {});
      return [];
    });
    expected.push(...(processes || []));
    disownTerminal(id);
  }
  return expected;
}

/** A dock that has just closed its shells asks WinT's own window to watch what
 *  they left behind: the "still running" warning lives in the status bar, and
 *  the window that did the closing is the one that no longer has one. */
term_dock_listen("term:orphan-watch", (event) => {
  if (embedded) return;
  scheduleOrphanCheck(event.payload?.expected);
});

/** The `cols,rows` a popped-out window should open with, or null when the
 *  view never measured itself. Kept inside what the screen can show, since the
 *  panel can be wider than a free-standing window is allowed to be. */
function popoutGrid(view) {
  const cols = view?.cols;
  const rows = view?.rows;
  if (!cols || !rows) return null;
  // `term_popout` turns these back into pixels at 9 x 18, a little more than a
  // cell really is - so the window opens a few columns roomier than the panel
  // was, and a line that fit in the panel still fits.
  const maxCols = Math.floor(((screen.availWidth || 1600) * 0.92) / 9);
  const maxRows = Math.floor(((screen.availHeight || 900) * 0.86) / 18);
  return `${Math.min(cols, maxCols)},${Math.min(rows, maxRows)}`;
}

/** Whether an event about a popped-out terminal is this dock's business.
 *
 *  Every dock hears every one of these. The dock a terminal was popped out of
 *  still remembers it, and that memory is what decides - not the label the
 *  window carries back, which is only there for the sessions no dock has ever
 *  held, such as a pane a popped-out window opened for itself with `wt`. */
function ownsPopped(payload) {
  const id = payload?.id || payload?.info?.id;
  if (id && terms.known.has(id)) return true;
  const origin = payload?.origin;
  return origin ? origin === dockOrigin : !embedded;
}

/** Whether this dock takes in a terminal being handed back.
 *
 *  Whichever dock popped it out takes it: a terminal that left a workspace
 *  comes home to that workspace, not to whichever window heard the handover
 *  first. Nobody's - a workspace closed since it was popped out - is WinT's,
 *  because the alternative is a shell left running with no window anywhere
 *  showing it. */
function claimsDock(payload) {
  const id = payload?.id;
  if (!id) return false;
  if (terms.known.has(id)) return true;
  const owner = readOwners()[id];
  if (owner) return owner === dockOrigin;
  return !embedded;
}

/** Hands the session to its own window. The shell is untouched — only the view
 *  moves, so a running build carries straight on. */
async function popOutTerminal(id, screenX, screenY, windowOptions = {}) {
  const session = terms.sessions.get(id);
  if (!session) return;
  const remembered = terms.known.get(id);
  // The window has to come up with the grid the terminal already had. A
  // narrower one makes ConPTY reflow the scrollback, and every line a program
  // padded out to the full width - a dev server writing its timestamps against
  // the right edge, say - wraps into a second, near-empty row: a blank line
  // between every line, until it is docked back in and reflowed again.
  const grid = popoutGrid(session.view);
  // The panel lets go on the same frame as the click; the window is opened
  // behind it. Waiting for the window first would leave the terminal sitting
  // in the dock looking as though nothing happened.
  session.view.dispose();
  session.host.remove();
  terms.sessions.delete(id);
  if (remembered) remembered.popped = true;
  focusNext();
  const key = `popout:${id}`;
  window.wintWork?.beginWork(key, `Opening ${session.info.projectName || "the terminal"} in its own window`);
  try {
    await term_dock_invoke("term_popout", {
      id,
      x: Number.isFinite(screenX) ? screenX - 80 : null,
      y: Number.isFinite(screenY) ? screenY - 18 : null,
      position: windowOptions.position || null,
      dimensions: windowOptions.dimensions || grid,
      maximized: !!windowOptions.maximized,
      fullscreen: !!windowOptions.fullscreen,
      focus: windowOptions.focus !== false,
      origin: dockOrigin,
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
    window.wintWork?.endWork(key);
  }
}

// Nothing this window was holding survived the last time it was open, whatever
// the register still says about it.
forgetOwnedTerminals();
termsLoadPrefs();
applyShellColors();
dockEl();
applyShellMarkerStyle();
renderTabs();
applyDockHeight();
// Embedded, the panel is already on screen: the dock is what fills it, with or
// without a terminal in it yet.
if (embedded) setDockOpen(true);

// Shell colours and markers are a setting, not a dock's own state: when the
// settings panel changes them, every dock on screen follows.
term_dock_listen("term:markers", () => {
  if (!embedded) return;
  termsLoadSettings();
  applyShellColors();
  applyShellMarkerStyle();
  renderTabs();
});

// A popped-out window docking back, or simply being closed: take the session
// into the panel rather than letting it run with nothing showing it.
// The cross on a popped-out window: that terminal is gone, not moving. Forget
// it rather than pulling it back into the panel or restoring it next launch.
term_dock_listen("term:closed", (event) => {
  if (!ownsPopped(event.payload)) return;
  const id = event.payload.id;
  terms.known.delete(id);
  disownTerminal(id);
  renderTabs();
  termsSavePrefs();
});

term_dock_listen("term:popped-created", (event) => {
  if (!ownsPopped(event.payload)) return;
  const info = event.payload?.info;
  if (!info?.id) return;
  terms.known.set(info.id, {
    projectPath: info.projectPath,
    projectName: info.projectName || "shell",
    popped: true,
    key: "",
    shell: shellProfileFromCommand(info.command),
    pane: 1,
  });
  ownTerminal(info.id);
  termsSavePrefs();
});

// WinT terminals put a private `wt` compatibility command first on PATH.
// Existing `wt split-pane` scripts therefore land here without being changed.
// A popped-out terminal receives the same event and handles its own request.
function wtShell(profile) {
  const value = String(profile || "").toLowerCase();
  if (value.includes("command prompt") || value === "cmd") return "cmd";
  if (value.includes("wsl") || value.includes("ubuntu") || value.includes("debian")) return "wsl";
  if (value.includes("git")) return "git-bash";
  if (value.includes("powershell") || value.includes("pwsh")) return value.includes("7") ? "pwsh" : "powershell";
  return terms.defaultShell;
}

/** Answers the `wt` that is still holding a prompt in the shell this request
 *  came from. Only the window that acted on it replies: the other one saw the
 *  same event and left it alone. */
function reportWt(token, ok, message = "") {
  if (!token) return;
  term_dock_invoke("wt_report", { token, ok, message }).catch(() => {});
}

/** Requests another window has said it is acting on.
 *
 *  A `wt` command is broadcast to every dock and every popped-out terminal.
 *  Only the one holding that terminal acts on it; this is how the rest learn
 *  not to answer on its behalf. */
const wtClaimed = new Set();
term_dock_listen("term:wt-claimed", (event) => {
  const token = event.payload?.token;
  if (!token) return;
  wtClaimed.add(token);
  // Only the moment right after the broadcast matters; the set is not a log.
  setTimeout(() => wtClaimed.delete(token), 10000);
});

async function executeWtRequest(request) {
  if (!request) return;
  if (!terms.sessions.has(request.termId)) {
    // A popped-out terminal answers its own request in its own window - and
    // replies for it too, so nothing is said here. A terminal this panel has
    // never heard of has nowhere to put the pane; `wt` learns that from the
    // answer never arriving.
    if (!terms.known.has(request.termId)) {
      // A workspace holds terminals of its own, and hears this broadcast as
      // well. Speaking for a terminal it was never going to own is how it
      // would answer "no such terminal" to a `wt` the main window is at that
      // moment carrying out, so only WinT's own dock says so - and not even
      // then if the register says the terminal belongs to a dock elsewhere.
      if (embedded || readOwners()[request.termId]) return;
      if (![...terms.known.values()].some((spec) => spec.popped)) {
        setTimeout(() => {
          if (wtClaimed.has(request.token)) return;
          termNote("term:wt-lost", "A wt command arrived from a terminal WinT no longer holds.", 5000);
          reportWt(request.token, false, "WinT has no terminal with that id any more.");
        }, 400);
      }
    }
    return;
  }
  // Claimed before anything is opened: the windows that are not going to act
  // on this are waiting on the answer.
  if (request.token) term_dock_emit("term:wt-claimed", { token: request.token }).catch(() => {});
  const targetNewWindow = ["new", "-1"].includes(request.window);
  if (!targetNewWindow) {
    const current = window.__TAURI__.window.getCurrentWindow();
    if (request.maximized) await current.maximize().catch(() => {});
    if (request.fullscreen) await current.setFullscreen(true).catch(() => {});
    if (request.focus) await current.setFocus().catch(() => {});
    const pair = (value) => String(value || "").split(",").map(Number);
    const [x, y] = pair(request.position);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const Position = window.__TAURI__.dpi?.LogicalPosition;
      if (Position) await current.setPosition(new Position(x, y)).catch(() => {});
    }
    const [cols, rows] = pair(request.dimensions);
    if (Number.isFinite(cols) && Number.isFinite(rows)) {
      const Size = window.__TAURI__.dpi?.LogicalSize;
      if (Size) await current.setSize(new Size(Math.max(400, cols * 9), Math.max(200, rows * 18))).catch(() => {});
    }
  }
  let activeId = request.termId;
  for (const action of request.actions || []) {
    if (action.kind === "help") {
      // `wt --help` is a question asked at a prompt, so it is answered there.
      termNote("term:wt-help", "WinT handles wt tabs, splits, focus, movement, profiles, colors and window options.", 6000);
      reportWt(request.token, true,
        "WinT runs wt commands in its own terminal panel: new-tab, split-pane, focus-tab,\n" +
        "move-focus, move-pane and swap-pane, with --profile, --startingDirectory, --title,\n" +
        "--tabColor, --colorScheme, --horizontal/--vertical, --size and the window options.");
      return;
    }
    if (action.kind === "focus-tab") {
      const ids = [...terms.sessions.keys()];
      if (ids[action.target] !== undefined) setActive(ids[action.target]);
      continue;
    }
    if (action.kind === "move-focus") {
      const pane = sessionPane(activeId);
      const nextPane = ["left", "up", "first", "previous", "previousInOrder"].includes(action.direction) ? 0 : 1;
      const next = terms.paneActive[nextPane === pane ? 1 - pane : nextPane];
      if (next) { setActive(next); activeId = next; }
      continue;
    }
    if (action.kind === "swap-pane") {
      const left = terms.paneActive[0], right = terms.paneActive[1];
      if (left && right) { terms.known.get(left).pane = 1; terms.known.get(right).pane = 0;
        terms.paneActive = [right, left]; syncPaneLayout(); renderTabs(); termsSavePrefs(); }
      continue;
    }
    if (action.kind === "move-pane") {
      const targetId = Number.isInteger(action.target) ? [...terms.sessions.keys()][action.target] : null;
      if (targetId) moveToPane(activeId, sessionPane(targetId));
      continue;
    }
    if (!["new-tab", "split-pane"].includes(action.kind)) continue;
    const source = terms.sessions.get(activeId)?.info;
    const split = action.kind === "split-pane";
    const pane = split ? 1 - sessionPane(activeId) : sessionPane(activeId);
    if (split) {
      terms.splitDirection = action.direction || "vertical";
      if (action.size >= .1 && action.size <= .9) terms.splitRatio = 1 - action.size;
    }
    const cwd = action.cwd || source?.projectPath || newTerminalTarget(pane).path;
    const name = action.title || cwd.split(/[\\/]/).filter(Boolean).pop() || "Terminal";
    terms.lastOpenError = "";
    const info = await openTerminal({ path: cwd, name }, {
      pane, title: name, shell: action.duplicate ? shellProfileFromCommand(source?.command) : wtShell(action.profile),
      command: action.duplicate ? "" : action.command,
    });
    if (!info) {
      // The shell waiting on this reads the failure, exactly where the command
      // was typed. Later actions in the same line are abandoned, as they would
      // be by a `wt` whose first pane never opened.
      reportWt(request.token, false,
        paneErrorText(action.command, terms.lastOpenError || `${name} could not be opened.`));
      return;
    }
    activeId = info.id;
    const known = terms.known.get(info.id);
    if (known) { known.tabColor = action.tabColor || ""; known.colorScheme = action.colorScheme || ""; }
    if (action.colorScheme && window.wintTermTheme) {
      const wanted = action.colorScheme.toLowerCase();
      const preset = window.wintTermTheme.presets.find((item) =>
        item.id.toLowerCase() === wanted || item.label.toLowerCase() === wanted);
      if (preset) window.wintTermTheme.usePreset(preset.id);
    }
    renderTabs();
    if (targetNewWindow) await popOutTerminal(info.id, undefined, undefined, request);
  }
  reportWt(request.token, true);
}

term_dock_listen("term:wt-request", (event) => executeWtRequest(event.payload));

term_dock_listen("term:close-watch", (event) => {
  const id = event.payload?.id;
  if (!id || !ownsPopped(event.payload)) return;
  term_dock_invoke("term_close_snapshot", { id })
    .then(scheduleOrphanCheck)
    .catch(() => term_dock_invoke("term_close", { id }).catch(() => {}));
});

term_dock_listen("term:docked", async (event) => {
  if (!claimsDock(event.payload)) return;
  const id = event.payload.id;
  const focus = embedded ? dockOrigin : undefined;
  await term_dock_invoke("term_dock", { id, focus }).catch(() => {});
  try {
    await mountSession(id, "", event.payload.pane === 1 ? 1 : 0);
    setDockOpen(true);
    termsSavePrefs();
    // A terminal arriving from outside must not land in a panel that is
    // hidden: the window it was in has just closed, so that would be a
    // terminal with nowhere left to be seen.
    dockHost?.onDock?.(id);
  } catch (e) {
    // It has left its own window, so there is nowhere else it could be. Said
    // out loud rather than swallowed: a terminal that vanishes on the way home
    // is not something to leave anybody guessing about.
    termNote("term:dock-failed", `That terminal could not be taken back in: ${e}`, 6000);
  }
});

/** Recreates the shells that were open when WinT last closed. Processes do
 *  not survive app shutdown; the replacement sessions start in the same
 *  folders and retain their tab order. */
async function restoreTerminals() {
  const specs = terms.restoreSpecs;
  // Streams nobody is going to open again - a terminal closed while WinT was
  // not running, or one lost with a crash - are dropped before anything else
  // touches them.
  term_dock_invoke("term_prune_history", {
    keys: terms.saveHistory ? allKeptStreams() : [],
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
    window.wintWork?.beginWork(key, `Restoring terminal in ${spec.projectName || spec.projectPath}`);
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
      await mountSession(info.id, historyKey || "", spec.pane, false);
      Object.assign(terms.known.get(info.id) || {}, {
        tabColor: spec.tabColor || "", colorScheme: spec.colorScheme || "",
      });
      restored.push(info.id);
      if (spec.popped) await popOutTerminal(info.id);
    } catch {
      terms.pending.delete(key);
      renderTabs();
    } finally {
      window.wintWork?.endWork(key);
    }
  }
  terms.restoring = false;
  const preferred = restored[Math.min(terms.restoreActive, restored.length - 1)];
  const active = terms.sessions.has(preferred) ? preferred : terms.sessions.keys().next().value;
  if (active) setActive(active, !embedded);
  setDockOpen(terms.restoreOpen && terms.sessions.size > 0);
  termsSavePrefs();
}

// A pop-out reports where its title-bar drag ended. Only accept the handoff
// when that point is over the visible terminal area in this window.
window.openTerminal = openTerminal;
window.openTerminalPanel = openTerminalPanel;
window.openTerminalWindow = openTerminalWindow;
window.setDockOpen = setDockOpen;
window.syncTerminalButton = syncTerminalButton;
window.termsState = terms;

/** What a host window needs of its own dock: the panel around it changes size
 *  on its own, and the workspace has one or two things to say to whichever
 *  terminal is on top. */
window.wintTermDock = {
  state: terms,
  embedded,
  activeId: () => terms.active,
  has: (id) => terms.sessions.has(id),
  label: (id) => terms.known.get(id)?.projectName || "The terminal",
  newTerminal: openNewTerminal,
  closeAll: closeDockTerminals,
  write: (data) => {
    const session = terms.sessions.get(terms.active);
    if (!session) return false;
    session.view.send(data);
    session.view.focus();
    return true;
  },
  // Writing to one named terminal rather than to whichever is in front: the
  // window acts on what a *particular* terminal printed, and the answer has to
  // go back to that terminal even if the user has since changed tabs. The tab
  // is brought forward first, so the keystrokes are visibly landing somewhere.
  writeTo: (id, data) => {
    const session = terms.sessions.get(id);
    if (!session) return false;
    if (terms.active !== id) setActive(id);
    session.view.send(data);
    session.view.focus();
    return true;
  },
  fit: fitVisible,
};

function shellProfileFromCommand(command) {
  const value = String(command || "").toLowerCase();
  if (["claude-setup.ps1", "claude.exe", "claude.cmd", "claude.bat"].some((name) => value.includes(name))) return "claude";
  if (value.includes("git\\bin\\bash.exe")) return "git-bash";
  if (value.includes("7-preview\\pwsh.exe")) return "pwsh-preview";
  if (value.includes("pwsh.exe")) return "pwsh";
  if (value.includes("wsl.exe") || value.startsWith("wsl")) return "wsl";
  if (value.includes("powershell.exe") || value.startsWith("powershell")) return "powershell";
  if (value.includes("cmd.exe") || value.startsWith("cmd")) return "cmd";
  if (value.includes("nu.exe") || value.startsWith("nu")) return "nu";
  return "auto";
}

window.wintTerminalSettings = {
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
  downloads: () => [...shellDownloads.values()],
  loadDownloads: loadShellDownloads,
  startDownload: (shell) => term_dock_invoke("shell_download_start", { profile: shell }),
  cancelDownload: () => term_dock_invoke("shell_download_cancel").catch(() => {}),
  removeDownload: async (shell) => {
    await term_dock_invoke("shell_download_remove", { profile: shell });
    await loadShellDownloads();
    await loadShellAvailability();
  },
  settleVisible,
  fitVisible,
};

/** A finished download changes what every shell picker on screen may offer, so
 *  the availability scan is redone before anything is told it is ready. */
term_dock_listen("shells:download-progress", async (event) => {
  if (event.payload?.done) {
    await loadShellDownloads();
    await loadShellAvailability();
  }
  window.wintShellDownloadProgress?.(event.payload);
});

restoreTerminals().finally(() => {
  // A workspace opens onto a shell in its project. An empty strip with a plus
  // button on it is not what "the terminal panel" means there, and the first
  // thing anyone does with a workspace terminal is run something in it.
  if (embedded && dockHost.autoOpen && !terms.sessions.size && !terms.pending.size) {
    openNewTerminal(terms.defaultShell, 0, { focus: false });
  }
});
loadShellAvailability();
loadShellDownloads();
