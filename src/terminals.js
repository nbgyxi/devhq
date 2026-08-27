// The terminal dock: a strip of live shells at the bottom of DevHQ, each one
// tied to the project it was opened from.
//
// The dock lives outside `#root` on purpose. `render()` replaces that subtree
// wholesale on every rescan, and a terminal must survive that — its DOM is
// mounted once and only ever mutated in place.

const term_dock_invoke = window.__TAURI__.core.invoke;
const term_dock_listen = window.__TAURI__.event.listen;

const TERM_PREFS = "devhq.terminals.v1";

const terms = {
  open: false,
  active: null,
  /** id -> { info, view, host } */
  sessions: new Map(),
  /** key -> project name, for shells that have been asked for but have not
   *  started yet. They get a tab straight away so the click is never silent. */
  pending: new Map(),
  height: 320,
  el: null,
};

function termsSavePrefs() {
  localStorage.setItem(TERM_PREFS, JSON.stringify({ height: terms.height }));
}

function termsLoadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(TERM_PREFS) || "{}");
    if (saved.height) terms.height = saved.height;
  } catch {}
}

function termIcon(name) {
  return `<span class="ms">${name}</span>`;
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
  el.querySelector(".dock-tabs").onclick = (e) => {
    const close = e.target.closest("[data-close]");
    if (close) return closeTerminal(close.dataset.close);
    if (e.target.closest("[data-new]")) return openNewTerminal();
    const tab = e.target.closest("[data-tab]");
    if (tab) setActive(tab.dataset.tab);
  };

  el.querySelector('[data-dock="hide"]').onclick = () => setDockOpen(false);
  el.querySelector('[data-dock="close"]').onclick = () => closeTerminal(terms.active);
  el.querySelector('[data-dock="popout"]').onclick = () => popOutTerminal(terms.active);

  // Drag the top edge to resize.
  const grip = el.querySelector(".dock-grip");
  grip.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    grip.setPointerCapture(down.pointerId);
    const move = (e) => {
      terms.height = Math.min(Math.max(window.innerHeight - e.clientY, 140), window.innerHeight - 220);
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

  window.addEventListener("resize", () => fitActive());
  return el;
}

/** The status bar's Terminal button: show the shells already running, or start
 *  the first one. Hiding the panel with shells still in it is a normal thing to
 *  do, so this has to bring them back rather than only ever making new ones. */
function openTerminalPanel() {
  if (terms.sessions.size) setDockOpen(true);
  else openNewTerminal();
}

function applyDockHeight() {
  document.documentElement.style.setProperty("--dock-h", terms.open ? `${terms.height}px` : "0px");
}

function setDockOpen(open) {
  terms.open = open;
  dockEl().classList.toggle("open", open);
  applyDockHeight();
  if (open) {
    fitActive();
    terms.sessions.get(terms.active)?.view.focus();
  }
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
      return `<div class="${cls.join(" ")}" data-tab="${s.info.id}" title="${escAttr(
        s.info.projectPath
      )}"><i class="dot"></i><span class="nm">${escAttr(label)}</span>
        <span class="tab-x" data-close="${s.info.id}" title="Close this terminal">${termIcon(
          "close"
        )}</span></div>`;
    })
    .join("");
  const open = tabs + starting;
  bar.innerHTML =
    (open || '<span class="dock-empty">No terminals open</span>') +
    `<button class="dock-new" data-new="1" title="New terminal in ${escAttr(
      newTerminalTarget().name
    )}">${termIcon("add")}</button>`;
  const actions = dockEl().querySelector(".dock-actions");
  actions.classList.toggle("disabled", !terms.active);
}

/** Where a shell opened from + or the corner button lands: alongside whatever
 *  is on screen, or in the folder being scanned when nothing is. */
function newTerminalTarget() {
  const active = terms.sessions.get(terms.active)?.info;
  if (active) return { path: active.projectPath, name: active.projectName || "this project" };
  const root = window.devhqPrimaryRoot?.() || "";
  return { path: root, name: root.split(/[\/]/).filter(Boolean).pop() || root || "no folder" };
}

function openNewTerminal() {
  const target = newTerminalTarget();
  if (!target.path) {
    termNote("term:noroot", "Nowhere to open a shell - add a folder to scan first.", 4000);
    return;
  }
  openTerminal(target);
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
      args: { projectPath: project.path, projectName: label },
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
async function mountSession(id) {
  if (terms.sessions.has(id)) {
    setActive(id);
    return;
  }
  const host = document.createElement("div");
  host.className = "term-host";
  dockEl().querySelector(".dock-views").appendChild(host);

  const view = new TermView(host, id);
  const info = await view.attach();
  const session = { info, view, host };
  terms.sessions.set(id, session);

  view.onTitle = (title) => {
    session.info.title = title;
  };
  view.onExit = () => renderTabs();

  setActive(id);
  view.fit();
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
  term_dock_invoke("term_close", { id }).catch(() => {});
  focusNext();
}

/** Hands the session to its own window. The shell is untouched — only the view
 *  moves, so a running build carries straight on. */
async function popOutTerminal(id) {
  const session = terms.sessions.get(id);
  if (!session) return;
  // The panel lets go on the same frame as the click; the window is opened
  // behind it. Waiting for the window first would leave the terminal sitting
  // in the dock looking as though nothing happened.
  session.view.dispose();
  session.host.remove();
  terms.sessions.delete(id);
  focusNext();
  const key = `popout:${id}`;
  window.devhqWork?.beginWork(key, `Opening ${session.info.projectName || "the terminal"} in its own window`);
  try {
    await term_dock_invoke("term_popout", { id });
  } catch (e) {
    termNote("popout", `Could not pop the terminal out: ${e}`, 5000);
    // The window never came up, so the session has no view at all — take it
    // back into the panel rather than leaving it running unseen, and open the
    // panel again if letting go of this one had closed it.
    await mountSession(id).catch(() => {});
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
  } catch {}
});

window.openTerminal = openTerminal;
window.openTerminalPanel = openTerminalPanel;
window.setDockOpen = setDockOpen;
window.termsState = terms;
