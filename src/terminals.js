// The terminal dock: a strip of live shells at the bottom of DevHQ, each one
// tied to the project it was opened from.
//
// The dock lives outside `#root` on purpose. `render()` replaces that subtree
// wholesale on every rescan, and a terminal must survive that — its DOM is
// mounted once and only ever mutated in place.

const term_dock_invoke = window.__TAURI__.core.invoke;
const term_dock_listen = window.__TAURI__.event.listen;

const TERM_PREFS = "devhq.terminals.v1";
const TERM_SHELLS = [
  { value: "auto", label: "Auto" },
  { value: "pwsh", label: "PowerShell 7" },
  { value: "powershell", label: "Windows PowerShell" },
  { value: "cmd", label: "Command Prompt" },
  { value: "git-bash", label: "Git Bash" },
  { value: "wsl", label: "WSL Bash" },
];

const terms = {
  open: false,
  active: null,
  /** id -> { info, view, host } */
  sessions: new Map(),
  /** All terminals that belong to this workspace, including ones currently
   *  popped out and therefore absent from `sessions`. */
  known: new Map(),
  /** key -> project name, for shells that have been asked for but have not
   *  started yet. They get a tab straight away so the click is never silent. */
  pending: new Map(),
  height: 320,
  restoreSpecs: [],
  restoreOpen: false,
  restoreActive: 0,
  defaultShell: "auto",
  nextShell: "auto",
  shellMenuOpen: false,
  restoring: false,
  /** id -> generation. Output increments it; a successful snapshot only
   *  clears the generation it actually captured. */
  dirtyHistory: new Map(),
  interacted: new Set(),
  persistenceRunning: null,
  el: null,
};

function markTerminalHistoryDirty(id) {
  if (!terms.known.has(id) || !terms.interacted.has(id)) return;
  terms.dirtyHistory.set(id, (terms.dirtyHistory.get(id) || 0) + 1);
}

function termsSavePrefs() {
  if (terms.restoring) return;
  const entries = [...terms.known.entries()];
  localStorage.setItem(TERM_PREFS, JSON.stringify({
    height: terms.height,
    open: terms.open,
    active: Math.max(0, entries.findIndex(([id]) => id === terms.active)),
    sessions: entries.map(([, spec]) => spec),
    defaultShell: terms.defaultShell,
  }));
}

function termsLoadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(TERM_PREFS) || "{}");
    if (saved.height) terms.height = saved.height;
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

function termIcon(name) {
  return `<span class="ms" aria-hidden="true">${name}</span>`;
}

function dockEl() {
  if (terms.el) return terms.el;
  const el = document.createElement("div");
  el.id = "term-dock";
  el.innerHTML = `
    <div class="dock-grip"></div>
    <div class="dock-bar">
      <div class="dock-tabs"></div>
      <div class="dock-actions">
        <div class="dock-new-split">
          <button data-dock="new" title="New terminal">${termIcon("add")}</button>
          <button class="dock-new-menu-button" data-dock="shell-menu" title="Choose shell" aria-haspopup="menu" aria-expanded="false">${termIcon("keyboard_arrow_down")}</button>
          <div class="dock-shell-menu" role="menu" hidden></div>
        </div>
        <button data-dock="popout" title="Pop out into its own window">${termIcon("open_in_new")}</button>
        <button data-dock="close" title="Close this terminal">${termIcon("delete")}</button>
        <button data-dock="hide" title="Hide the panel">${termIcon("keyboard_arrow_down")}</button>
      </div>
    </div>
    <div class="dock-views"></div>`;
  document.body.appendChild(el);
  terms.el = el;

  // Delegated, because the strip is rebuilt every time a shell starts, stops
  // or is switched to - per-tab handlers would be rewired on every one of them.
  let suppressTabClick = false;
  el.querySelector(".dock-tabs").onclick = (e) => {
    if (suppressTabClick) return;
    const close = e.target.closest("[data-close]");
    if (close) return closeTerminal(close.dataset.close);
    if (e.target.closest("[data-new]")) return openNewTerminal();
    const tab = e.target.closest("[data-tab]");
    if (tab) setActive(tab.dataset.tab);
  };

  // Keep this gesture inside the webview rather than using HTML drag/drop.
  // Native browser dragging can activate whatever is behind the app when the
  // pointer leaves the window. Pointer capture keeps DevHQ in charge and also
  // lets us draw a clear preview of what is moving.
  const tabs = el.querySelector(".dock-tabs");
  const clearDropMarks = () => tabs.querySelectorAll(".drop-before,.drop-after").forEach((tab) =>
    tab.classList.remove("drop-before", "drop-after")
  );
  const reorderTab = (id, target, after) => {
    if (target?.dataset.tab === id) return;
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
    renderTabs();
    termsSavePrefs();
  };
  tabs.addEventListener("pointerdown", (down) => {
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
      const strip = tabs.getBoundingClientRect();
      const inStrip = e.clientX >= strip.left && e.clientX <= strip.right &&
        e.clientY >= strip.top && e.clientY <= strip.bottom;
      target = inStrip ? document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-tab]") : null;
      if (target && target !== tab) {
        const rect = target.getBoundingClientRect();
        after = e.clientX >= rect.left + rect.width / 2;
        target.classList.add(after ? "drop-after" : "drop-before");
      }
    };
    const finish = (e, cancelled = false) => {
      tab.removeEventListener("pointermove", move);
      tab.removeEventListener("pointerup", up);
      tab.removeEventListener("pointercancel", cancel);
      tab.classList.remove("dragging");
      clearDropMarks();
      ghost?.remove();
      if (nativePreview) {
        term_dock_invoke("term_drag_preview", { action: "close", x: 0, y: 0 }).catch(() => {});
      }
      if (!dragging) return;
      if (cancelled) {
        suppressTabClick = false;
        return;
      }
      const strip = tabs.getBoundingClientRect();
      const dock = el.getBoundingClientRect();
      const inStrip = e.clientX >= strip.left && e.clientX <= strip.right &&
        e.clientY >= strip.top && e.clientY <= strip.bottom;
      const inDock = e.clientX >= dock.left && e.clientX <= dock.right &&
        e.clientY >= dock.top && e.clientY <= dock.bottom;
      if (inStrip) reorderTab(id, target, after);
      else if (!inDock && (e.screenX || e.screenY)) popOutTerminal(id, e.screenX, e.screenY);
      setTimeout(() => { suppressTabClick = false; }, 0);
    };
    const up = (e) => finish(e);
    const cancel = (e) => finish(e, true);
    tab.addEventListener("pointermove", move);
    tab.addEventListener("pointerup", up);
    tab.addEventListener("pointercancel", cancel);
  });

  el.querySelector('[data-dock="hide"]').onclick = () => setDockOpen(false);
  el.querySelector('[data-dock="close"]').onclick = () => closeTerminal(terms.active);
  el.querySelector('[data-dock="popout"]').onclick = () => popOutTerminal(terms.active);
  el.querySelector('[data-dock="new"]').onclick = () => openNewTerminal(terms.defaultShell);
  el.querySelector('[data-dock="shell-menu"]').onclick = (e) => {
    e.stopPropagation();
    setShellMenuOpen(!terms.shellMenuOpen);
  };
  el.querySelector(".dock-shell-menu").onclick = (e) => {
    const choice = e.target.closest("[data-new-shell]");
    if (!choice) return;
    setShellMenuOpen(false);
    openNewTerminal(choice.dataset.newShell);
  };
  document.addEventListener("pointerdown", (e) => {
    if (terms.shellMenuOpen && !e.target.closest(".dock-new-split")) setShellMenuOpen(false);
  });

  // Drag the top edge to resize.
  const grip = el.querySelector(".dock-grip");
  grip.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    grip.setPointerCapture(down.pointerId);
    const move = (e) => {
      terms.height = clampDockHeight(window.innerHeight - e.clientY);
      applyDockHeight();
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      termsSavePrefs();
      fitActive();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });

  window.addEventListener("resize", () => {
    // A window that just got shorter must give the shell its room back before
    // the terminal is refitted to whatever is left.
    const before = terms.height;
    applyDockHeight();
    fitActive();
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
  button.classList.toggle("on", terms.open);
  button.setAttribute("aria-expanded", String(terms.open));
  button.title = terms.open
    ? "Hide terminals"
    : count
      ? `Show ${count} open terminal${count === 1 ? "" : "s"}`
      : "Open a terminal";
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
  document.documentElement.style.setProperty("--dock-h", terms.open ? `${terms.height}px` : "0px");
}

function setDockOpen(open) {
  terms.open = open;
  dockEl().classList.toggle("open", open);
  applyDockHeight();
  syncTerminalButton();
  if (open) {
    fitActive();
    terms.sessions.get(terms.active)?.view.focus();
  }
  termsSavePrefs();
}

function fitActive() {
  const session = terms.sessions.get(terms.active);
  if (session && terms.open) session.view.fit();
}

/** A short-lived line in the main window's activity strip. */
function termNote(key, label, ms = 2600) {
  window.devhqWork?.beginWork(key, label);
  setTimeout(() => window.devhqWork?.endWork(key), ms);
}

function renderTabs() {
  const bar = dockEl().querySelector(".dock-tabs");
  const starting = [...terms.pending.values()]
    .map(
      (name) =>
        `<span class="dock-tab pending"><i class="dot"></i>${escAttr(name)}<em>starting...</em></span>`
    )
    .join("");
  const tabs = [...terms.sessions.values()]
    .map((s) => {
      const label = s.info.projectName || "shell";
      const cls = ["dock-tab"];
      if (s.info.id === terms.active) cls.push("on");
      if (s.view.exited) cls.push("dead");
      return `<div class="${cls.join(" ")}" data-tab="${s.info.id}" title="Drag out to open in a window · ${escAttr(
        s.info.projectPath
      )}"><i class="dot"></i><span class="nm">${escAttr(label)}</span>
        <span class="tab-x" data-close="${s.info.id}" title="Close this terminal">${termIcon(
          "close"
        )}</span></div>`;
    })
    .join("");
  const open = tabs + starting;
  bar.innerHTML =
    (open || '<span class="dock-empty">No terminals open</span>');
  const actions = dockEl().querySelector(".dock-actions");
  for (const button of actions.querySelectorAll('[data-dock="popout"],[data-dock="close"]')) {
    button.disabled = !terms.active;
  }
  for (const button of actions.querySelectorAll('[data-dock="new"],[data-dock="shell-menu"]')) {
    button.disabled = !newTerminalTarget().path;
  }
  renderShellMenu();
  syncTerminalButton();
}

function renderShellMenu() {
  const menu = dockEl().querySelector(".dock-shell-menu");
  menu.innerHTML = `<div class="dock-menu-label">New terminal with</div>${TERM_SHELLS.map((profile) =>
    `<button role="menuitem" data-new-shell="${profile.value}">${profile.label}${
      profile.value === terms.defaultShell ? "<span>Default</span>" : ""
    }</button>`
  ).join("")}`;
  menu.hidden = !terms.shellMenuOpen;
  dockEl().querySelector('[data-dock="shell-menu"]').setAttribute("aria-expanded", String(terms.shellMenuOpen));
}

function setShellMenuOpen(open) {
  terms.shellMenuOpen = open;
  renderShellMenu();
}

/** Where a shell opened from + or the corner button lands: alongside whatever
 *  is on screen, or in the folder being scanned when nothing is. */
function newTerminalTarget() {
  const active = terms.sessions.get(terms.active)?.info;
  if (active) return { path: active.projectPath, name: active.projectName || "this project" };
  const root = window.devhqPrimaryRoot?.() || "";
  return { path: root, name: root.split(/[\/]/).filter(Boolean).pop() || root || "no folder" };
}

function openNewTerminal(shell = terms.defaultShell) {
  const target = newTerminalTarget();
  if (!target.path) {
    termNote("term:noroot", "Nowhere to open a shell - add a folder to scan first.", 4000);
    return;
  }
  openTerminal(target, { shell });
}

function escAttr(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function setActive(id) {
  terms.active = id;
  for (const [sid, s] of terms.sessions) s.host.classList.toggle("on", sid === id);
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
  terms.pending.set(key, label);
  renderTabs();
  setDockOpen(true);
  window.devhqWork?.beginWork(
    key,
    opts.run ? `Starting ${opts.run} in ${project.name}` : `Starting a shell in ${project.name}`
  );
  try {
    const info = await term_dock_invoke("term_open", {
      args: { projectPath: project.path, projectName: label, shell: opts.shell || terms.defaultShell },
    });
    terms.pending.delete(key);
    await mountSession(info.id);
    if (opts.run) sendWhenReady(info.id, opts.run);
  } catch (e) {
    terms.pending.delete(key);
    renderTabs();
    termNote(`${key}:err`, `Could not open a shell in ${project.name}: ${e}`, 5000);
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
async function mountSession(id, restoredHistory = "") {
  if (terms.sessions.has(id)) {
    setActive(id);
    return;
  }
  const host = document.createElement("div");
  host.className = "term-host";
  dockEl().querySelector(".dock-views").appendChild(host);

  const view = new TermView(host, id);
  const info = await view.attach();
  view.prependRestoredHistory(restoredHistory);
  const session = { info, view, host };
  terms.sessions.set(id, session);
  terms.known.set(id, {
    projectPath: info.projectPath,
    projectName: info.projectName || "shell",
    popped: false,
    history: restoredHistory,
    shell: shellProfileFromCommand(info.command),
  });

  view.onTitle = (title) => {
    session.info.title = title;
  };
  view.onExit = () => renderTabs();

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
  const next = terms.sessions.keys().next();
  terms.active = next.done ? null : next.value;
  if (terms.active) {
    setActive(terms.active);
    return;
  }
  renderTabs();
  if (!terms.pending.size) setDockOpen(false);
}

function closeTerminal(id) {
  const session = terms.sessions.get(id);
  if (!session) return;
  session.view.dispose();
  session.host.remove();
  terms.sessions.delete(id);
  terms.known.delete(id);
  terms.dirtyHistory.delete(id);
  terms.interacted.delete(id);
  term_dock_invoke("term_close", { id }).catch(() => {});
  focusNext();
  termsSavePrefs();
}

/** Hands the session to its own window. The shell is untouched — only the view
 *  moves, so a running build carries straight on. */
async function popOutTerminal(id, screenX, screenY) {
  const session = terms.sessions.get(id);
  if (!session) return;
  const remembered = terms.known.get(id);
  if (remembered) remembered.history = session.view.exportHistory();
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
    await mountSession(id, remembered?.history || "").catch(() => {});
    setDockOpen(true);
  } finally {
    window.devhqWork?.endWork(key);
  }
}

termsLoadPrefs();
dockEl();
renderTabs();
applyDockHeight();

// A popped-out window docking back, or simply being closed: take the session
// into the panel rather than letting it run with nothing showing it.
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
  if (!specs.length) return;
  terms.restoring = true;
  setDockOpen(true);
  const restored = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const key = `term:restore:${i}`;
    terms.pending.set(key, spec.projectName || "shell");
    renderTabs();
    window.devhqWork?.beginWork(key, `Restoring terminal in ${spec.projectName || spec.projectPath}`);
    try {
      const info = await term_dock_invoke("term_open", {
        args: {
          projectPath: spec.projectPath,
          projectName: spec.projectName || "shell",
          shell: spec.shell || terms.defaultShell,
        },
      });
      terms.pending.delete(key);
      await mountSession(info.id, spec.history || "");
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

function snapshotText(snapshot) {
  const line = (runs) => (runs || []).map((run) => run.t).join("");
  const lines = [
    ...snapshot.history.map(line),
    ...snapshot.screen.map((row) => line(row.runs)),
  ];
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-1500).join("\n").slice(-150000);
}

/** Captures only sessions whose output changed since their last snapshot.
 *  Calls coalesce so autosave and shutdown never start competing snapshots. */
async function persistTerminalState() {
  if (terms.persistenceRunning) return terms.persistenceRunning;
  const pending = [...terms.dirtyHistory.entries()];
  if (!pending.length) return false;
  terms.persistenceRunning = Promise.allSettled(pending.map(async ([id, generation]) => {
    try {
      const snapshot = await term_dock_invoke("term_attach", { id });
      const remembered = terms.known.get(id);
      if (remembered) remembered.history = snapshotText(snapshot);
      if (terms.dirtyHistory.get(id) === generation) terms.dirtyHistory.delete(id);
    } catch {}
  })).then(() => {
    termsSavePrefs();
    return true;
  }).finally(() => {
    terms.persistenceRunning = null;
  });
  return terms.persistenceRunning;
}

/** Last-chance persistence that never crosses the native bridge. Docked views
 *  already hold their complete rendered history, so copying it to localStorage
 *  is synchronous and cannot delay or deadlock window shutdown. */
function persistDockedTerminalState() {
  for (const [id, session] of terms.sessions) {
    if (!terms.dirtyHistory.has(id)) continue;
    const remembered = terms.known.get(id);
    if (!remembered) continue;
    remembered.history = session.view.exportHistory();
    terms.dirtyHistory.delete(id);
  }
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

term_dock_listen("term:input", (event) => {
  terms.interacted.add(event.payload);
});

window.openTerminal = openTerminal;
window.openTerminalPanel = openTerminalPanel;
window.setDockOpen = setDockOpen;
window.syncTerminalButton = syncTerminalButton;
window.termsState = terms;
window.persistTerminalState = persistTerminalState;
window.persistDockedTerminalState = persistDockedTerminalState;
window.terminalStateDirty = () => terms.dirtyHistory.size > 0;
window.devhqTerminalChanged = markTerminalHistoryDirty;

function shellProfileFromCommand(command) {
  const value = String(command || "").toLowerCase();
  if (value.includes("git\\bin\\bash.exe")) return "git-bash";
  if (value.startsWith("wsl")) return "wsl";
  if (value.startsWith("pwsh")) return "pwsh";
  if (value.startsWith("powershell")) return "powershell";
  if (value.startsWith("cmd")) return "cmd";
  return "auto";
}

window.devhqTerminalSettings = {
  profiles: TERM_SHELLS,
  getDefault: () => terms.defaultShell,
  setDefault: (shell) => {
    if (!TERM_SHELLS.some((profile) => profile.value === shell)) return;
    terms.defaultShell = shell;
    terms.nextShell = shell;
    termsSavePrefs();
    renderTabs();
  },
};

restoreTerminals();

// Keep shutdown cheap: in normal use it only has to flush output from the last
// few seconds, and often has nothing left to do at all.
setInterval(() => persistTerminalState().catch(() => {}), 5_000);
