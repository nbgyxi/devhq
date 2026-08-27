// DevHQ - front end.
//
// Two rules shape this file (see CLAUDE.md):
//
//  1. The window never blocks. Nothing is awaited before the first paint, and
//     every command that does real work streams its results back as events.
//  2. The app always says what it is doing. Work is registered with
//     `beginWork` / `endWork`, which drives the activity strip, and anything
//     not yet loaded is drawn as a named skeleton rather than left blank.
//
// Rendering is region based: the shell is mounted once and never replaced, and
// each region redraws only when its own data changed, coalesced into one
// animation frame.

const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const PREFS_KEY = "devhq.prefs.v1";

const state = {
  /** Every folder being scanned. Edited through the toolbar chip, never a
   *  field left standing open once the list has loaded. */
  roots: [],
  projects: [],
  /** path -> project, so a streamed update finds its card in constant time. */
  byPath: new Map(),
  scanning: false,
  scanToken: 0,
  total: 0,
  settled: 0,
  error: "",
  durationMs: 0,
  scannedAt: 0,
  search: "",
  sort: "activity",
  filters: new Set(),
  techFilter: "",
  groupBy: true,
  selectedPath: null,
  /** What the open project's detail view is showing. Both arrive after the
   *  view does, so both start null and are drawn as skeletons until they land.
   *  `detailToken` retires an answer for a project that is no longer open. */
  detailToken: 0,
  diff: null,
  diffError: "",
  /** The patch split per file, and which of them is being read. */
  diffFiles: new Map(),
  diffFile: null,
  todos: null,
  todosError: "",
};

/* ------------------------------------------------------------- work log */

/** Everything currently in flight: key -> { label, detail }. */
const work = new Map();

function beginWork(key, label, detail = "") {
  work.set(key, { label, detail });
  markDirty("activity", "toolbar");
}

function updateWork(key, detail, label) {
  const entry = work.get(key);
  if (!entry) return;
  entry.detail = detail;
  if (label) entry.label = label;
  markDirty("activity");
}

function endWork(key) {
  if (work.delete(key)) markDirty("activity", "toolbar");
}

/** Shows a label for as long as `promise` runs, whatever the outcome. */
function trackWork(key, label, promise) {
  beginWork(key, label);
  return promise.finally(() => endWork(key));
}

/* ------------------------------------------------------------------ prefs */

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    if (Array.isArray(p.roots)) state.roots = p.roots.filter(Boolean);
    else if (p.root) state.roots = [p.root]; // prefs written before multiple folders
    if (p.sort) state.sort = p.sort;
    if (typeof p.groupBy === "boolean") state.groupBy = p.groupBy;
    if (Array.isArray(p.filters)) state.filters = new Set(p.filters);
    if (p.techFilter) state.techFilter = p.techFilter;
  } catch {
    /* first run, or corrupted prefs - defaults are fine */
  }
}

function savePrefs() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        roots: state.roots,
        sort: state.sort,
        groupBy: state.groupBy,
        filters: [...state.filters],
        techFilter: state.techFilter,
      })
    );
  } catch {
    /* storage disabled - prefs simply do not persist */
  }
}

/* ------------------------------------------------------------- formatting */

function ago(seconds) {
  if (!seconds) return "never";
  const d = Math.max(0, Date.now() / 1000 - seconds);
  const units = [
    [31536000, "y"],
    [2592000, "mo"],
    [604800, "w"],
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
  ];
  for (const [size, label] of units) {
    if (d >= size) return `${Math.floor(d / size)}${label} ago`;
  }
  return "just now";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function icon(name) {
  return `<span class="ms">${name}</span>`;
}

/** Shortens a git remote to `owner/repo` when it looks like one. */
function shortRemote(url) {
  if (!url) return "";
  const m = url.match(/[:/]([^/:]+\/[^/]+?)(\.git)?$/);
  return m ? m[1] : url;
}

/* -------------------------------------------------------------- derived */

/** A discovered folder before anything is known about it. Every field the rest
 *  of the app reads is present, so nothing has to special-case a half project
 *  beyond the `pending` flag itself. */
function stubProject(stub) {
  return {
    name: stub.name,
    path: stub.path,
    group: stub.group,
    description: "",
    version: "",
    packageManager: "",
    scripts: [],
    depCount: 0,
    devDepCount: 0,
    flags: [],
    tech: [],
    git: null,
    running: [],
    ports: [],
    runCmd: "",
    touchedMs: 0,
    pending: true,
  };
}

function changeCount(p) {
  return p.git ? p.git.changedTotal : 0;
}

/** Epoch seconds of the most recent signal of life, for sorting and display. */
function activity(p) {
  const commit = p.git?.lastCommit?.timestamp || 0;
  return Math.max(commit, Math.floor((p.touchedMs || 0) / 1000));
}

const FILTERS = {
  dirty: { label: "Uncommitted", test: (p) => changeCount(p) > 0 },
  running: { label: "Running", test: (p) => p.running.length > 0 },
  unpushed: { label: "Unpushed", test: (p) => (p.git?.ahead || 0) > 0 },
  behind: { label: "Behind", test: (p) => (p.git?.behind || 0) > 0 },
  noremote: { label: "No remote", test: (p) => !!p.git && !p.git.remote },
  nogit: { label: "Not a repo", test: (p) => !p.git },
  stash: { label: "Stashed", test: (p) => (p.git?.stashes || 0) > 0 },
  stale: {
    label: "Stale 90d+",
    test: (p) => activity(p) > 0 && Date.now() / 1000 - activity(p) > 90 * 86400,
  },
};

function matchesSearch(p, terms) {
  if (!terms.length) return true;
  const hay = [
    p.name,
    p.group,
    p.description,
    p.path,
    p.git?.branch,
    shortRemote(p.git?.remote),
    ...p.tech.map((t) => t.name),
    ...p.ports.map(String),
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => hay.includes(term));
}

/** A project the chips and the tech picker let through.
 *
 *  Several chips together widen the list rather than narrow it: picking
 *  Running and No remote shows everything that is either one, not only the
 *  projects that happen to be both. The tech picker and the search box are a
 *  different question being asked, so those still narrow whatever the chips
 *  let through.
 *
 *  Folders still being read stay visible so the list does not shuffle as
 *  results land - they are filtered for real once they settle. */
function matchesFilters(p) {
  if (p.pending) return true;
  if (state.filters.size) {
    let any = false;
    for (const key of state.filters) {
      if (FILTERS[key].test(p)) {
        any = true;
        break;
      }
    }
    if (!any) return false;
  }
  if (state.techFilter && !p.tech.some((t) => t.name === state.techFilter)) return false;
  return true;
}

function visibleProjects() {
  const terms = state.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = state.projects.filter((p) => matchesFilters(p) && matchesSearch(p, terms));

  const sorters = {
    name: (a, b) => a.name.localeCompare(b.name),
    activity: (a, b) => activity(b) - activity(a),
    changes: (a, b) => changeCount(b) - changeCount(a) || a.name.localeCompare(b.name),
    running: (a, b) => b.running.length - a.running.length || activity(b) - activity(a),
    tech: (a, b) =>
      (a.tech[0]?.name || "zzz").localeCompare(b.tech[0]?.name || "zzz") ||
      a.name.localeCompare(b.name),
  };
  return list.sort(sorters[state.sort] || sorters.name);
}

function selectedProject() {
  return state.selectedPath ? state.byPath.get(state.selectedPath) || null : null;
}

/* ---------------------------------------------------------- scan folders */

/** The chip's label. One folder reads as itself; several as the first plus a
 *  count, so the toolbar stays a single short line. */
function rootsLabel() {
  if (!state.roots.length) return "Add a folder";
  if (state.roots.length === 1) return state.roots[0];
  return `${state.roots[0]} +${state.roots.length - 1}`;
}

function rootRow(value = "") {
  const row = document.createElement("div");
  row.className = "root-row";
  row.innerHTML = `${icon("folder")}<input spellcheck="false" placeholder="C:\\code" />
    <button class="root-drop" title="Remove">${icon("close")}</button>`;
  row.querySelector("input").value = value;
  return row;
}

function rootEditorOpen() {
  return !el["roots-pop"].hidden;
}

/** Opens the folder editor with one row per folder. The rows are built here
 *  and afterwards only added or removed one at a time, so nothing holding a
 *  caret is ever replaced under the user. */
function openRootEditor() {
  el["roots-list"].innerHTML = "";
  for (const value of state.roots.length ? state.roots : [""]) {
    el["roots-list"].append(rootRow(value));
  }
  el["roots-pop"].hidden = false;
  el["roots-btn"].classList.add("on");
  el["roots-list"].querySelector("input")?.focus();
}

function closeRootEditor() {
  if (!rootEditorOpen()) return;
  el["roots-pop"].hidden = true;
  el["roots-btn"].classList.remove("on");
}

/** Takes what the editor holds and scans it. Blanks and repeats drop out. */
function applyRootEditor() {
  const seen = new Set();
  const roots = [];
  for (const input of el["roots-list"].querySelectorAll("input")) {
    const value = input.value.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    roots.push(value);
  }
  state.roots = roots;
  savePrefs();
  closeRootEditor();
  markDirty("toolbar");
  rescan();
}

/* -------------------------------------------------------- scan streaming */

/** Starts a scan. Returns as soon as the backend has taken the request - every
 *  result arrives later through the `scan:*` events wired up in `listenScan`. */
function rescan() {
  state.error = "";
  state.scanning = true;
  state.projects = [];
  state.byPath = new Map();
  state.total = 0;
  state.settled = 0;
  state.durationMs = 0;
  beginWork("scan", `Starting scan of ${state.roots.join(", ") || "nothing"}`);
  markDirty("toolbar", "grid", "summary", "banner", "filters");
  savePrefs();
  invoke("scan", { roots: state.roots }).catch((err) => {
    state.error = String(err);
    state.scanning = false;
    endWork("scan");
    markDirty("toolbar", "banner");
  });
}

/** Retires the running scan. The folders already read keep what they have; the
 *  ones still pending simply stop being pending. */
function stopScan() {
  state.scanning = false;
  for (const key of [...work.keys()]) {
    if (key === "scan" || key.startsWith("phase:")) endWork(key);
  }
  for (const project of state.projects) if (project.pending) project.stopped = true;
  markDirty("toolbar", "grid", "summary", "filters", "activity");
  invoke("scan_cancel").catch(() => {});
}

/** Events from an older scan are ignored; a newer token takes over. */
function scanTokenOk(payload) {
  if (payload.token < state.scanToken) return false;
  state.scanToken = payload.token;
  return true;
}

function scanProgress() {
  if (!state.total) return "";
  return `${state.settled} / ${state.total}`;
}

function listenScan() {
  const registered = [];
  const on = (name, handler) => registered.push(listen(name, handler));

  on("scan:start", (event) => {
    const p = event.payload;
    if (!scanTokenOk(p)) return;
    state.roots = p.roots;
    state.error = p.error;
    state.scannedAt = p.scannedAtMs;
    state.total = p.stubs.length;
    state.settled = 0;
    state.projects = p.stubs.map(stubProject);
    state.byPath = new Map(state.projects.map((s) => [s.path, s]));
    // A missing folder is reported but does not stop the others: the scan
    // carries on for as long as it has something to read.
    state.scanning = p.stubs.length > 0;
    if (!state.scanning) endWork("scan");
    else updateWork("scan", scanProgress(), `Reading ${p.stubs.length} projects`);
    markDirty("toolbar", "grid", "summary", "filters", "banner", "detail", "activity");
  });

  // A named step of the backend's work, so the strip can show the real phase
  // rather than an unlabelled spinner.
  on("scan:phase", (event) => {
    const p = event.payload;
    if (!scanTokenOk(p)) return;
    if (p.done) endWork(`phase:${p.key}`);
    else beginWork(`phase:${p.key}`, p.label);
  });

  on("scan:project", (event) => {
    const p = event.payload;
    if (!scanTokenOk(p)) return;
    for (const project of p.projects) {
      const previous = state.byPath.get(project.path);
      // The process sweep may have landed first; never drop what it found.
      if (previous && previous.running.length) {
        project.running = previous.running;
        project.ports = previous.ports;
      }
      replaceProject(project, previous);
      if (!previous || previous.pending) state.settled++;
    }
    updateWork("scan", scanProgress());
    markDirty("summary", "filters", "activity");
  });

  on("scan:procs", (event) => {
    const p = event.payload;
    if (!scanTokenOk(p)) return;
    for (const item of p.items) {
      const project = state.byPath.get(item.path);
      if (!project) continue;
      project.running = item.running;
      project.ports = item.ports;
      touchCard(project);
    }
    markDirty("summary", "filters");
  });

  on("scan:done", (event) => {
    const p = event.payload;
    if (!scanTokenOk(p)) return;
    state.scanning = false;
    state.durationMs = p.durationMs;
    if (p.error) state.error = p.error;
    endWork("scan");
    // One reordering pass at the end, so the list settles into the chosen sort
    // instead of shuffling under the pointer while results stream in.
    markDirty("toolbar", "grid", "summary", "filters", "banner", "detail");
  });

  return Promise.all(registered);
}

/** Swaps a stub for the real thing, in the list and in the index. */
function replaceProject(project, previous) {
  const index = previous ? state.projects.indexOf(previous) : -1;
  if (index >= 0) state.projects[index] = project;
  else state.projects.push(project);
  state.byPath.set(project.path, project);
  touchCard(project);
  if (project.path !== state.selectedPath) return;
  // The view can be opened on a folder still being read, which does not yet
  // know it is a repository. Once it does, fetch the patch it could not ask
  // for at the time.
  if (project.git && !state.diff && !state.diffError && !work.has("diff")) loadDiff(project);
  markDirty("detail");
}

/* --------------------------------------------------------------- actions */

function openIn(path, target) {
  const labels = { explorer: "Opening Explorer", vscode: "Opening VS Code", terminal: "Opening a shell" };
  trackWork(`open:${target}`, labels[target] || "Opening", invoke("open_in", { path, target })).catch(
    (err) => {
      state.error = String(err);
      markDirty("banner");
    }
  );
}

/** Runs one of the detail view's two background reads.
 *
 *  Both are slow enough to see - a patch means running `git`, and the notes
 *  mean walking the tree - so both are named in the activity strip and both
 *  leave a skeleton in their section until they land. An answer that arrives
 *  after the view has moved on to another project is dropped: it is about a
 *  project nobody is looking at any more. */
function loadDetailPart(project, key, command, label, onValue, onError) {
  const token = state.detailToken;
  trackWork(key, `${label} for ${project.name}`, invoke(command, { path: project.path }))
    .then((value) => {
      if (state.detailToken === token) onValue(value);
    })
    .catch((err) => {
      if (state.detailToken === token) onError(String(err));
    })
    .finally(() => {
      if (state.detailToken === token) markDirty("detail");
    });
}

function loadDiff(project) {
  loadDetailPart(
    project,
    "diff",
    "git_diff",
    "Reading the diff",
    (diff) => {
      state.diff = diff;
      state.diffError = "";
      // Split once, here, rather than on every redraw of the view.
      state.diffFiles = parseDiff(diff.text);
      state.diffFile = firstChangedFile(project);
    },
    (err) => {
      state.diff = null;
      state.diffError = err;
    }
  );
}

/** The file to open on: the first one git status lists that the patch actually
 *  has, so the view never lands on "nothing to show" while a real diff sits
 *  further down the list. */
function firstChangedFile(project) {
  for (const f of project.git?.changed || []) {
    if (state.diffFiles.has(f.path)) return f.path;
  }
  const first = state.diffFiles.keys().next();
  return first.done ? null : first.value;
}

function loadTodos(project) {
  loadDetailPart(
    project,
    "todos",
    "todos",
    "Looking for TODOs",
    (report) => {
      state.todos = report;
      state.todosError = "";
    },
    (err) => {
      state.todos = null;
      state.todosError = err;
    }
  );
}

/** Fills the window with one project, and starts everything the full view
 *  shows that a card does not already know. */
function openDetail(project) {
  state.selectedPath = project.path;
  clearDetailData();
  markDirty("detail");
  if (project.git) loadDiff(project);
  loadTodos(project);
}

function closeDetail() {
  state.selectedPath = null;
  clearDetailData();
  markDirty("detail");
}

/** Bumping the token is what makes the reads still in flight harmless. */
function clearDetailData() {
  state.detailToken++;
  state.diff = null;
  state.diffError = "";
  state.diffFiles = new Map();
  state.diffFile = null;
  state.todos = null;
  state.todosError = "";
}

/** Every action a project offers, in one place, so the card and the detail
 *  view cannot drift apart about what "Run" or "Code" means. */
function projectAction(action, p) {
  switch (action) {
    case "run":
      if (!p.runCmd) return;
      openTerminal(p, { run: p.runCmd });
      break;
    case "vscode":
    case "explorer":
      openIn(p.path, action);
      break;
    case "terminal":
      openTerminal(p);
      break;
    case "external":
      openIn(p.path, "terminal");
      break;
    case "copy":
      navigator.clipboard.writeText(p.path);
      beginWork("copy", "Path copied");
      setTimeout(() => endWork("copy"), 1200);
      break;
  }
}

function toggleFilter(key) {
  if (state.filters.has(key)) state.filters.delete(key);
  else state.filters.add(key);
  savePrefs();
  markDirty("filters", "grid");
}

function setTechFilter(name) {
  state.techFilter = state.techFilter === name ? "" : name;
  savePrefs();
  markDirty("filters", "toolbar", "grid");
}

/* ----------------------------------------------------------------- views */

function skeletonView(p) {
  const note = p.stopped
    ? `${icon("do_not_disturb_on")}not read - the scan was stopped`
    : `${icon("hourglass_top")}reading git status...`;
  return `<article class="card skeleton${p.stopped ? " stopped" : ""}" data-path="${esc(p.path)}">
    <div class="card-top"><div class="card-name">${esc(p.name)}</div></div>
    <div class="sk sk-line" style="width:72%"></div>
    <div class="sk-row">
      <span class="sk sk-pill" style="width:58px"></span>
      <span class="sk sk-pill" style="width:44px"></span>
      <span class="sk sk-pill" style="width:70px"></span>
    </div>
    <div class="sk-row">
      <span class="sk sk-pill" style="width:86px"></span>
      <span class="sk sk-pill" style="width:52px"></span>
    </div>
    <div class="sk-note">${note}</div>
    <div class="card-actions">
      <span class="sk sk-pill" style="width:64px"></span>
      <span class="sk sk-pill" style="width:64px"></span>
      <span class="sk sk-pill" style="width:78px"></span>
    </div>
  </article>`;
}

/** The three things a project is usually wanted for. Always drawn, never
 *  revealed on hover: a button that appears under the pointer is a button that
 *  cannot be found by looking. Run says what it will actually type, and when
 *  the folder gives no clue how it starts, it says that instead of guessing. */
function cardActions(p) {
  const run = p.runCmd
    ? `<button class="cact go" data-act="run" title="Run ${esc(p.runCmd)}">${icon(
        "play_arrow"
      )}Run</button>`
    : `<button class="cact" disabled title="Nothing in this folder says how it runs">${icon(
        "play_disabled"
      )}Run</button>`;
  return `<div class="card-actions">${run}
    <button class="cact" data-act="vscode" title="Open in VS Code">${icon("code")}Code</button>
    <button class="cact" data-act="terminal" title="Open a terminal here">${icon(
      "terminal"
    )}Terminal</button>
  </div>`;
}

function cardView(p) {
  if (p.pending) return skeletonView(p);

  const g = p.git;
  const classes = ["card"];
  if (changeCount(p) > 0) classes.push("dirty");
  if (p.running.length) classes.push("running");

  const tags = p.tech
    .slice(0, 5)
    .map(
      (t) =>
        `<span class="tag ${esc(t.kind)}" data-tech="${esc(t.name)}">${esc(t.name)}${
          t.version ? `<i class="v">${esc(t.version)}</i>` : ""
        }</span>`
    )
    .join("");
  const more = p.tech.length > 5 ? `<span class="tag more">+${p.tech.length - 5}</span>` : "";

  const stats = [];
  if (g) {
    stats.push(
      `<span class="stat" title="branch">${icon("account_tree")}<span class="mono">${esc(
        g.branch || "detached"
      )}</span></span>`
    );
    if (changeCount(p) > 0) {
      const parts = [];
      if (g.staged) parts.push(`${g.staged} staged`);
      if (g.modified) parts.push(`${g.modified} modified`);
      if (g.untracked) parts.push(`${g.untracked} untracked`);
      stats.push(
        `<span class="stat amber" title="${esc(parts.join(", "))}">${icon("edit_note")}${
          g.changedTotal
        } changed</span>`
      );
    } else {
      stats.push(`<span class="stat" title="clean">${icon("check_circle")}clean</span>`);
    }
    if (g.ahead) stats.push(`<span class="stat accent">${icon("arrow_upward")}${g.ahead}</span>`);
    if (g.behind) stats.push(`<span class="stat red">${icon("arrow_downward")}${g.behind}</span>`);
    if (g.conflicted)
      stats.push(`<span class="stat red">${icon("merge_type")}${g.conflicted} conflict</span>`);
    if (g.stashes)
      stats.push(`<span class="stat">${icon("inventory_2")}${g.stashes} stash</span>`);
    if (!g.remote) stats.push(`<span class="stat">${icon("cloud_off")}no remote</span>`);
  } else {
    stats.push(`<span class="stat">${icon("folder_off")}not a repo</span>`);
  }
  if (p.ports.length)
    stats.push(
      `<span class="stat green">${icon("lan")}${p.ports
        .slice(0, 4)
        .map((n) => `:${n}`)
        .join(" ")}</span>`
    );

  const live = p.running.length
    ? `<span class="live"><i class="dot"></i>${p.running.length} proc</span>`
    : "";

  const commit = g?.lastCommit
    ? `<div class="commit">${icon("commit")}<span class="mono">${esc(
        g.lastCommit.hash
      )}</span><span class="msg">${esc(g.lastCommit.subject)}</span><span style="margin-left:auto">${esc(
        ago(g.lastCommit.timestamp)
      )}</span></div>`
    : `<div class="commit">${icon("schedule")}<span class="msg">touched ${esc(
        ago(Math.floor((p.touchedMs || 0) / 1000))
      )}</span></div>`;

  return `<article class="${classes.join(" ")}" data-path="${esc(p.path)}">
    <div class="card-top">
      <div class="card-name">${esc(p.name)}${
        p.version ? `<span class="card-ver">v${esc(p.version)}</span>` : ""
      }</div>
      ${live}
    </div>
    ${p.description ? `<div class="desc">${esc(p.description)}</div>` : ""}
    <div class="tags">${tags}${more}</div>
    <div class="stats">${stats.join("")}</div>
    ${commit}
    ${cardActions(p)}
  </article>`;
}

/** How many patch lines are put in the DOM at once. A patch is read from the
 *  top; ten thousand rows of it would cost more to lay out than anyone is
 *  going to scroll through. */
const DIFF_LINE_LIMIT = 1500;

/** One class per kind of patch line, which is all the colouring needs. */
function diffLineClass(line) {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("diff --git ") || line.startsWith("index ")) return "meta";
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/** `diff --git a/src/x.js b/src/x.js` -> `src/x.js`. Both halves name the same
 *  file unless it was renamed, and then the b side is where it ended up. */
function headerPath(line) {
  const rest = line.slice("diff --git ".length);
  const at = rest.lastIndexOf(" b/");
  return at >= 0 ? rest.slice(at + 3) : rest;
}

/** The patch split into one chunk per file, so a file can be read on its own.
 *
 *  Staged and unstaged changes to the same file arrive as two chunks; they are
 *  merged, because from here they are one file with work in it. */
function parseDiff(text) {
  const byPath = new Map();
  let current = null;
  for (const line of (text || "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { path: headerPath(line), lines: [line], add: 0, del: 0 };
      continue;
    }
    if (!current) continue;
    // The `+++` line is the name git itself settled on, so it wins over the
    // header, which cannot be split reliably when a path contains " b/".
    if (line.startsWith("+++ b/")) {
      current.path = line.slice(6).trim();
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      current.add++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.del++;
    }
    current.lines.push(line);
    // Only once the path is known can the chunk be filed, so this happens on
    // every line rather than at the end of one.
    const held = byPath.get(current.path);
    if (held === current) continue;
    if (held) {
      held.lines.push(...current.lines);
      held.add += current.add;
      held.del += current.del;
      current = held;
    } else {
      byPath.set(current.path, current);
    }
  }
  return byPath;
}

/** The file list: what git status says changed, with the patch's own counts
 *  against each one. Clicking a row is what picks the patch shown beside it. */
function filesSection(p) {
  const g = p.git;
  const head = (body, note = "") =>
    `<section class="section"><h3>Working tree${note}</h3>${body}</section>`;
  if (!g) return "";
  if (!g.changed.length) {
    return head(`<div class="sk-note">${icon("check_circle")}nothing uncommitted</div>`);
  }

  const rows = g.changed
    .map((f) => {
      const code =
        f.status === "untracked"
          ? "U"
          : f.status === "conflict"
          ? "C"
          : f.status.replace(/\./g, "").charAt(0) || "M";
      const chunk = state.diffFiles.get(f.path);
      const counts = chunk
        ? `<span class="n add">+${chunk.add}</span><span class="n del">-${chunk.del}</span>`
        : "";
      const on = f.path === state.diffFile ? " on" : "";
      return `<div class="filerow${on}" data-file="${esc(f.path)}" title="${esc(f.path)}">
        <span class="st ${esc(code)}">${esc(code)}</span>
        <span class="p">${esc(f.path)}</span>${counts}
      </div>`;
    })
    .join("");

  const note = ` <span class="count">${g.changedTotal}${
    g.changedTotal > g.changed.length ? `, showing ${g.changed.length}` : ""
  }</span>`;
  return head(`<div class="filelist">${rows}</div>`, note);
}

/** One file's changes, beside the list when the window is wide enough for a
 *  third column and underneath it when it is not. */
function patchSection() {
  const head = (title, body) =>
    `<section class="section"><h3>${title}</h3>${body}</section>`;

  if (work.has("diff")) {
    return head("Changes", `<div class="sk-note">${icon("hourglass_top")}running git diff...</div>`);
  }
  if (state.diffError) {
    return head("Changes", `<div class="sk-note">${icon("error_outline")}${esc(state.diffError)}</div>`);
  }
  if (!state.diff) return "";

  const chunk = state.diffFile ? state.diffFiles.get(state.diffFile) : null;
  if (!chunk) {
    const why = state.diffFile
      ? `${esc(state.diffFile)} has no patch - it is untracked, binary, or only changed mode`
      : "pick a file to see what changed in it";
    return head("Changes", `<div class="sk-note">${icon("description")}${why}</div>`);
  }

  const shown = chunk.lines.slice(0, DIFF_LINE_LIMIT);
  const body = shown
    .map((line) => `<div class="dl ${diffLineClass(line)}">${esc(line) || "&nbsp;"}</div>`)
    .join("");
  const cut = [];
  if (chunk.lines.length > shown.length) cut.push(`${chunk.lines.length - shown.length} more lines`);
  if (state.diff.truncated) cut.push("the patch itself was cut short");
  const tail = cut.length
    ? `<div class="sk-note">${icon("more_horiz")}${esc(
        cut.join(", ")
      )} - open a terminal for the rest</div>`
    : "";
  const title = `<span class="mono">${esc(chunk.path)}</span> <span class="n add">+${
    chunk.add
  }</span><span class="n del">-${chunk.del}</span>`;
  return head(title, `<div class="diff">${body}</div>${tail}`);
}

function todoSection() {
  const head = (body, note = "") =>
    `<section class="section"><h3>TODO / FIXME${note}</h3>${body}</section>`;

  if (work.has("todos")) {
    return head(`<div class="sk-note">${icon("hourglass_top")}reading the source...</div>`);
  }
  if (state.todosError) {
    return head(`<div class="sk-note">${icon("error_outline")}${esc(state.todosError)}</div>`);
  }
  if (!state.todos) return "";
  if (!state.todos.items.length) {
    return head(`<div class="sk-note">${icon("check_circle")}none left in this project</div>`);
  }

  const rows = state.todos.items
    .map(
      (t) => `<div class="todorow">
        <span class="kind ${esc(t.kind)}">${esc(t.kind)}</span>
        <span class="note">${esc(t.text) || "<em>no note</em>"}</span>
        <span class="where">${esc(t.file)}:${t.line}</span>
      </div>`
    )
    .join("");
  const n = state.todos.items.length;
  const note = ` <span class="count">${n}${state.todos.truncated ? "+" : ""}</span>`;
  const tail = state.todos.truncated
    ? `<div class="sk-note">${icon("more_horiz")}stopped at ${n} - there are more</div>`
    : "";
  return head(`<div class="todolist">${rows}</div>${tail}`, note);
}

function detailView(p) {
  const g = p.git;
  const kv = [];
  if (p.description) kv.push(["Description", esc(p.description)]);
  kv.push(["Path", `<span class="mono">${esc(p.path)}</span>`]);
  if (p.runCmd) kv.push(["Runs with", `<span class="mono">${esc(p.runCmd)}</span>`]);
  if (p.group) kv.push(["Group", esc(p.group)]);
  if (p.version) kv.push(["Version", `<span class="mono">${esc(p.version)}</span>`]);
  if (p.packageManager) kv.push(["Package manager", esc(p.packageManager)]);
  if (p.depCount || p.devDepCount)
    kv.push(["Dependencies", `${p.depCount} runtime &middot; ${p.devDepCount} dev`]);
  kv.push(["Last touched", esc(ago(Math.floor((p.touchedMs || 0) / 1000)))]);
  if (g) {
    kv.push(["Branch", `<span class="mono">${esc(g.branch || "detached")}</span>`]);
    if (g.upstream) kv.push(["Upstream", `<span class="mono">${esc(g.upstream)}</span>`]);
    kv.push(["Remote", g.remote ? `<span class="mono">${esc(g.remote)}</span>` : "none"]);
    kv.push(["Ahead / behind", `${g.ahead} / ${g.behind}`]);
    kv.push(["Branches", String(g.branches.length)]);
    kv.push(["Stashes", String(g.stashes)]);
    kv.push(["Commits (30d)", String(g.commits30d)]);
    if (g.lastCommit)
      kv.push([
        "Last commit",
        `${esc(g.lastCommit.subject)}<br><span class="mono" style="color:var(--dim2)">${esc(
          g.lastCommit.hash
        )} &middot; ${esc(g.lastCommit.author)} &middot; ${esc(ago(g.lastCommit.timestamp))}</span>`,
      ]);
  }
  if (p.flags.length) kv.push(["Notes", p.flags.map(esc).join(", ")]);

  const loading = p.pending
    ? `<section class="section"><div class="sk-note">${icon(
        "hourglass_top"
      )}still reading this project...</div></section>`
    : "";

  const techSection = p.tech.length
    ? `<section class="section"><h3>Tech stack</h3><div class="tags">${p.tech
        .map(
          (t) =>
            `<span class="tag ${esc(t.kind)}" data-tech="${esc(t.name)}">${esc(t.name)}${
              t.version ? `<i class="v">${esc(t.version)}</i>` : ""
            }</span>`
        )
        .join("")}</div></section>`
    : "";

  const procSection = p.running.length
    ? `<section class="section"><h3>Running (${p.running.length})</h3>${p.running
        .map(
          (r) => `<div class="procrow">
            <span class="nm">${esc(r.name)}</span>
            <span class="pid">#${r.pid}</span>
            ${r.ports.map((n) => `<span class="port">:${n}</span>`).join("")}
            <span class="cmd" title="${esc(r.cmd)}">${esc(r.cmd)}</span>
          </div>`
        )
        .join("")}</section>`
    : "";

  const scripts = p.scripts.length
    ? `<section class="section"><h3>Scripts</h3>${p.scripts
        .map(
          (s) =>
            `<div class="scriptrow"><span class="k">${esc(s[0])}</span><span class="v" title="${esc(
              s[1]
            )}">${esc(s[1])}</span></div>`
        )
        .join("")}</section>`
    : "";

  const branches = g && g.branches.length > 1
    ? `<section class="section"><h3>Branches</h3><div class="tags">${g.branches
        .map((b) => `<span class="tag${b === g.branch ? " framework" : ""}">${esc(b)}</span>`)
        .join("")}</div></section>`
    : "";

  const todos = todoSection();

  const run = p.runCmd
    ? `<button class="btn primary" data-act="run" title="Run ${esc(p.runCmd)}">${icon(
        "play_arrow"
      )}Run <span class="mono">${esc(p.runCmd)}</span></button>`
    : `<button class="btn" disabled title="Nothing in this folder says how it runs">${icon(
        "play_disabled"
      )}Nothing to run</button>`;

  return `<div class="detail">
    <div class="detail-head">
      <button class="btn back" data-act="close" title="Back to the list (Esc)">${icon(
        "arrow_back"
      )}Back</button>
      <div class="detail-id">
        <h2>${esc(p.name)}${
          p.version ? `<span class="card-ver">v${esc(p.version)}</span>` : ""
        }</h2>
        <div class="path">${esc(p.path)}</div>
      </div>
      <button class="win-btn" data-act="close" title="Close">${icon("close")}</button>
    </div>
    <div class="detail-actions">
      ${run}
      <button class="btn" data-act="vscode">${icon("code")}VS Code</button>
      <button class="btn" data-act="terminal">${icon("terminal")}Terminal</button>
      <button class="btn" data-act="explorer">${icon("folder_open")}Explorer</button>
      <button class="btn" data-act="external">${icon("open_in_new")}External shell</button>
      <button class="btn" data-act="copy">${icon("content_copy")}Copy path</button>
    </div>
    <div class="detail-body${g ? "" : " solo"}">
      <div class="dcol dcol-info">
        ${loading}
        <section class="section"><h3>Overview</h3><dl class="kv">${kv
          .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
          .join("")}</dl></section>
        ${techSection}
        ${todos}
        ${procSection}
        ${scripts}
        ${branches}
      </div>
      ${
        g
          ? `<div class="dcol dcol-files">${filesSection(p)}</div>
             <div class="dcol dcol-patch">${patchSection()}</div>`
          : ""
      }
    </div>
  </div>`;
}

/* -------------------------------------------------------------- rendering */

/** Regions waiting to be redrawn, plus the individual cards whose data changed
 *  but whose position in the list did not. */
const dirty = new Set();
const dirtyCards = new Set();
let frame = 0;
/** path -> the card element currently on screen for it. */
let cardIndex = new Map();
const el = {};

function markDirty(...regions) {
  for (const region of regions) dirty.add(region);
  schedule();
}

/** Repaints one card in place - no reflow of the list, so results can stream in
 *  under the pointer without anything moving. */
function touchCard(project) {
  if (dirty.has("grid")) return;
  // A project that no longer passes an active filter has to leave the list,
  // which only a rebuild can do.
  if (!matchesFilters(project)) markDirty("grid");
  else if (cardIndex.has(project.path)) dirtyCards.add(project.path);
  else markDirty("grid");
  schedule();
}

function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    flushRender();
  });
}

function flushRender() {
  const regions = new Set(dirty);
  const cards = new Set(dirtyCards);
  dirty.clear();
  dirtyCards.clear();

  if (regions.has("grid")) renderGrid();
  else for (const path of cards) patchCard(path);

  if (regions.has("toolbar")) renderToolbar();
  if (regions.has("activity")) renderActivity();
  if (regions.has("filters")) renderFilters();
  if (regions.has("banner")) renderBanner();
  if (regions.has("summary")) {
    renderSummary();
    // The idle line says the same things the summary does, so it is stale
    // exactly when the summary is.
    if (!work.size) renderActivity();
  }
  if (regions.has("detail")) renderDetail();
}

/** The shell is built once. Inputs live for the lifetime of the window, so
 *  focus, selection and IME state are never disturbed by a redraw. */
function mountShell() {
  document.getElementById("root").innerHTML = `
    <div class="titlebar">
      <div class="drag">
        <div class="brand"><img src="devhq-icon.png" alt="" /><span>DevHQ</span>
          <span class="sub" id="brand-sub"></span></div>
      </div>
      <div class="win-btns">
        <button class="win-btn" data-win="min">${icon("remove")}</button>
        <button class="win-btn" data-win="max">${icon("crop_square")}</button>
        <button class="win-btn close" data-win="close">${icon("close")}</button>
      </div>
    </div>

    <div class="toolbar">
      <div class="loading" id="loadbar" hidden><i></i></div>
      <div class="roots" id="roots">
        <button class="rootchip" id="roots-btn">${icon("folder")}<span
          class="label" id="roots-label"></span>${icon("edit")}</button>
        <div class="rootpop" id="roots-pop" hidden>
          <div class="rootpop-head">Folders to scan</div>
          <div class="rootpop-list" id="roots-list"></div>
          <div class="rootpop-foot">
            <button class="btn" data-root-act="add">${icon("add")}Add folder</button>
            <button class="btn primary" data-root-act="apply">${icon("refresh")}Scan</button>
          </div>
        </div>
      </div>
      <button class="btn primary" id="rescan">${icon("refresh")}<span class="label">Rescan</span></button>
      <div class="field search">${icon("search")}
        <input id="search-input" spellcheck="false"
               placeholder="Search name, tech, branch, port..." />
      </div>
      <select class="sort" id="tech-filter"><option value="">All tech</option></select>
      <select class="sort" id="sort">
        <option value="activity">Recent activity</option>
        <option value="name">Name</option>
        <option value="changes">Most changes</option>
        <option value="running">Running first</option>
        <option value="tech">Tech</option>
      </select>
      <button class="btn" id="groupby" title="Group by parent folder">${icon(
        "view_agenda"
      )}<span class="label">Grouped</span></button>
    </div>

    <div class="filters" id="filters"></div>
    <div id="banner-host"></div>
    <div class="summary" id="summary"></div>
    <div class="scroll" id="scroll"><div class="grid" id="grid"></div></div>
    <div class="statusbar">
      <div class="activity" id="activity"></div>
      <button class="status-btn" id="status-term" title="Open a terminal">${icon(
        "terminal"
      )}<span class="label">Terminal</span></button>
      <div class="act-bar" id="status-progress" hidden><i></i></div>
    </div>
    <div id="detail-host"></div>
  `;

  for (const id of [
    "brand-sub", "loadbar", "roots-btn", "roots-label", "roots-pop", "roots-list",
    "rescan", "search-input", "tech-filter", "sort", "groupby", "activity", "filters",
    "banner-host", "summary", "grid", "detail-host", "status-term", "status-progress",
  ]) {
    el[id] = document.getElementById(id);
  }

  el["search-input"].value = state.search;
  el.sort.value = state.sort;
  wireShell();
}

function renderToolbar() {
  const busy = state.scanning;
  el.loadbar.hidden = !busy && !work.size;
  el.rescan.classList.toggle("spinning", busy);
  el.rescan.querySelector(".label").textContent = busy ? "Stop" : "Rescan";
  el.rescan.querySelector(".ms").textContent = busy ? "stop_circle" : "refresh";
  el.rescan.title = busy ? "Stop the scan" : "Scan the folder again";
  el["roots-label"].textContent = rootsLabel();
  el["roots-btn"].classList.toggle("empty", state.roots.length === 0);
  el["roots-btn"].title = state.roots.length
    ? `Scanning ${state.roots.join(", ")} - click to change`
    : "Click to choose the folders to scan";
  el.groupby.querySelector(".label").textContent = state.groupBy ? "Grouped" : "Flat";
  el.groupby.querySelector(".ms").textContent = state.groupBy ? "view_agenda" : "grid_view";
  const pending = state.total ? state.total - state.settled : 0;
  el["brand-sub"].textContent =
    busy && pending
      ? `${state.projects.length} projects \u00b7 ${pending} loading`
      : `${state.projects.length} projects`;

  // The tech list is rebuilt only when it actually changed, and never while the
  // user has the picker open.
  const counts = new Map();
  for (const p of state.projects) for (const t of p.tech) counts.set(t.name, (counts.get(t.name) || 0) + 1);
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const signature = entries.map(([n, c]) => `${n}:${c}`).join("|") + `#${state.techFilter}`;
  if (signature !== el["tech-filter"].dataset.signature && document.activeElement !== el["tech-filter"]) {
    el["tech-filter"].dataset.signature = signature;
    el["tech-filter"].innerHTML =
      `<option value="">All tech</option>` +
      entries
        .map(([name, n]) => `<option value="${esc(name)}">${esc(name)} (${n})</option>`)
        .join("");
    el["tech-filter"].value = state.techFilter;
  }
}

/** The status bar's left half: one line per thing the app is doing right now,
 *  and when there is nothing, what it last did. It is never empty and never
 *  hidden - a bar that comes and goes cannot be glanced at. */
function renderActivity() {
  const items = [...work.values()];
  el.loadbar.hidden = !items.length;
  renderProgress();
  if (!items.length) {
    el.activity.innerHTML = `<span class="act idle"><i class="act-dot"></i><span
      class="act-label">Idle</span><span class="act-detail">${esc(idleDetail())}</span></span>`;
    return;
  }
  el.activity.innerHTML = items
    .map(
      (w) =>
        `<span class="act"><i class="act-spin"></i><span class="act-label">${esc(
          w.label
        )}</span>${w.detail ? `<span class="act-detail">${esc(w.detail)}</span>` : ""}</span>`
    )
    .join("");
}

/** The scan's progress, on the bar itself rather than inside the line - the
 *  line scrolls sideways when several things are happening, and a progress bar
 *  that scrolls out of view is no use to anybody. */
function renderProgress() {
  const showing = state.scanning && state.total > 0;
  el["status-progress"].hidden = !showing;
  if (!showing) return;
  const pct = Math.round((state.settled / state.total) * 100);
  el["status-progress"].firstElementChild.style.width = `${pct}%`;
}

/** What the app has to say for itself when it is not doing anything. */
function idleDetail() {
  if (!state.projects.length) return "nothing scanned yet";
  const settled = state.projects.filter((x) => !x.pending);
  const dirty = settled.filter(FILTERS.dirty.test).length;
  const running = settled.filter(FILTERS.running.test).length;
  const parts = [`${state.projects.length} projects`];
  if (dirty) parts.push(`${dirty} with uncommitted changes`);
  if (running) parts.push(`${running} running`);
  if (state.scannedAt) parts.push(`scanned in ${state.durationMs}ms`);
  return parts.join(" · ");
}

function renderFilters() {
  const settled = state.projects.filter((p) => !p.pending);
  const count = (key) => settled.filter(FILTERS[key].test).length;
  const chips = Object.entries(FILTERS)
    .map(
      ([key, f]) =>
        `<button class="chip${state.filters.has(key) ? " on" : ""}" data-filter="${key}">${esc(
          f.label
        )}<span class="n">${count(key)}</span></button>`
    )
    .join("");
  // With more than one chip on, say so - the list is a union, and a count that
  // exceeds every individual chip needs explaining.
  const hint =
    state.filters.size > 1
      ? `<span class="chip-hint">showing any of ${state.filters.size}</span>`
      : "";
  el.filters.innerHTML =
    chips +
    hint +
    (state.filters.size || state.techFilter || state.search
      ? `<span class="chip-sep"></span><button class="chip" id="clear">${icon(
          "backspace"
        )}Clear</button>`
      : "");
}

function renderBanner() {
  el["banner-host"].innerHTML = state.error ? `<div class="banner">${esc(state.error)}</div>` : "";
}

function renderSummary() {
  const settled = state.projects.filter((p) => !p.pending);
  const count = (key) => settled.filter(FILTERS[key].test).length;
  const totalChanges = settled.reduce((sum, p) => sum + changeCount(p), 0);
  const tail = state.scanning
    ? `${state.settled} of ${state.total} read`
    : state.scannedAt
    ? `scanned in ${state.durationMs}ms &middot; ${esc(
        new Date(state.scannedAt).toLocaleTimeString()
      )}`
    : "";

  el.summary.innerHTML = `
    <span><span class="dot" style="background:var(--green)"></span><b>${count(
      "running"
    )}</b> running</span>
    <span><span class="dot" style="background:var(--amber)"></span><b>${count(
      "dirty"
    )}</b> with uncommitted changes (<b>${totalChanges}</b> files)</span>
    <span><span class="dot" style="background:var(--accent)"></span><b>${count(
      "unpushed"
    )}</b> unpushed</span>
    <span style="margin-left:auto">${tail}</span>`;
}

function renderGrid() {
  const list = visibleProjects();
  let body;

  if (!list.length) {
    body = state.scanning
      ? `<div class="empty">${icon("hourglass_top")}<div>Looking for projects in ${esc(
          state.roots.join(", ")
        )}...</div></div>`
      : `<div class="empty">${icon("search_off")}<div>${
          state.projects.length
            ? "No projects match the current filters."
            : "No projects found in this folder."
        }</div></div>`;
  } else if (state.groupBy && list.some((p) => p.group)) {
    const groups = new Map();
    for (const p of list) {
      const key = p.group || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    body = [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(
        ([name, items]) =>
          `${name ? `<div class="group-head">${esc(name)}</div>` : ""}${items
            .map(cardView)
            .join("")}`
      )
      .join("");
  } else {
    body = list.map(cardView).join("");
  }

  el.grid.innerHTML = body;
  cardIndex = new Map();
  for (const card of el.grid.querySelectorAll(".card")) cardIndex.set(card.dataset.path, card);
}

function patchCard(path) {
  const current = cardIndex.get(path);
  const project = state.byPath.get(path);
  if (!current || !project) return;
  const holder = document.createElement("div");
  holder.innerHTML = cardView(project);
  const next = holder.firstElementChild;
  current.replaceWith(next);
  cardIndex.set(path, next);
}

function renderDetail() {
  const p = selectedProject();
  el["detail-host"].innerHTML = p ? detailView(p) : "";
}

/* ------------------------------------------------------------------ wiring */

/** All handlers are bound once, on elements that live forever, or delegated
 *  from a container - so a redraw never has to rewire anything. */
function wireShell() {
  el.rescan.onclick = () => {
    if (state.scanning) stopScan();
    else rescan();
  };

  el["status-term"].onclick = () => window.openTerminalPanel?.();

  el.groupby.onclick = () => {
    state.groupBy = !state.groupBy;
    savePrefs();
    markDirty("toolbar", "grid");
  };

  el.sort.onchange = (e) => {
    state.sort = e.target.value;
    savePrefs();
    markDirty("grid");
  };

  el["tech-filter"].onchange = (e) => {
    state.techFilter = e.target.value;
    el["tech-filter"].dataset.signature = "";
    savePrefs();
    markDirty("filters", "grid");
  };

  el["roots-btn"].onclick = () => (rootEditorOpen() ? closeRootEditor() : openRootEditor());

  el["roots-pop"].onclick = (e) => {
    const drop = e.target.closest(".root-drop");
    if (drop) {
      const row = drop.closest(".root-row");
      // The last row stays, emptied, so there is always somewhere to type.
      if (el["roots-list"].children.length > 1) row.remove();
      else row.querySelector("input").value = "";
      return;
    }
    const action = e.target.closest("[data-root-act]");
    if (!action) return;
    if (action.dataset.rootAct === "add") {
      const row = rootRow();
      el["roots-list"].append(row);
      row.querySelector("input").focus();
    } else {
      applyRootEditor();
    }
  };

  el["roots-pop"].onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyRootEditor();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeRootEditor();
      el["roots-btn"].focus();
    }
  };

  // Clicking away leaves the folders as they were - only Scan commits them.
  document.addEventListener("pointerdown", (e) => {
    if (rootEditorOpen() && !e.target.closest("#roots")) closeRootEditor();
  });

  // The input element itself is never replaced, so there is no caret to
  // restore; the list simply redraws on the next frame.
  el["search-input"].oninput = (e) => {
    state.search = e.target.value;
    markDirty("grid", "filters");
  };

  el.filters.onclick = (e) => {
    const chip = e.target.closest("[data-filter]");
    if (chip) return toggleFilter(chip.dataset.filter);
    if (e.target.closest("#clear")) {
      state.filters.clear();
      state.techFilter = "";
      state.search = "";
      el["search-input"].value = "";
      el["tech-filter"].value = "";
      savePrefs();
      markDirty("filters", "toolbar", "grid");
    }
  };

  document.querySelector(".titlebar").onclick = (e) => {
    const btn = e.target.closest("[data-win]");
    if (!btn) return;
    if (btn.dataset.win === "min") appWindow.minimize();
    else if (btn.dataset.win === "max") appWindow.toggleMaximize();
    else appWindow.close();
  };

  el.grid.onclick = (e) => {
    const card = e.target.closest(".card");
    if (!card) return;
    const project = state.byPath.get(card.dataset.path);
    if (!project) return;

    // Run, Code and Terminal are the card doing something; anything else on it
    // is the card being opened.
    const action = e.target.closest("[data-act]");
    if (action) return projectAction(action.dataset.act, project);
    const tag = e.target.closest("[data-tech]");
    if (tag) return setTechFilter(tag.dataset.tech);

    openDetail(project);
  };

  el["detail-host"].onclick = (e) => {
    const tag = e.target.closest("[data-tech]");
    if (tag) {
      closeDetail();
      return setTechFilter(tag.dataset.tech);
    }
    const file = e.target.closest("[data-file]");
    if (file) {
      state.diffFile = file.dataset.file;
      return markDirty("detail");
    }
    const action = e.target.closest("[data-act]");
    if (!action) return;
    const p = selectedProject();
    if (!p) return;
    if (action.dataset.act === "close") return closeDetail();
    projectAction(action.dataset.act, p);
  };
}

// The mouse's back button leaves the detail view, the way it would leave a
// page. The webview would otherwise try to navigate its own history, which in
// a one-page app means nothing happens at all.
for (const type of ["mousedown", "mouseup", "auxclick"]) {
  document.addEventListener(type, (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    if (type === "mouseup" && e.button === 3 && state.selectedPath) closeDetail();
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.selectedPath) {
    closeDetail();
  } else if (e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r")) {
    e.preventDefault();
    rescan();
  } else if (e.ctrlKey && e.key === "`") {
    e.preventDefault();
    setDockOpen(!window.termsState.open);
  } else if (e.ctrlKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    el["search-input"]?.focus();
  }
});

/* ------------------------------------------------------------------ start */

(function start() {
  loadPrefs();
  // The window is drawn and interactive before anything is asked of the disk.
  mountShell();
  markDirty("toolbar", "filters", "summary", "grid");

  listenScan().then(() => {
    if (state.roots.length) return rescan();
    trackWork("root", "Looking for a code folder", invoke("default_root"))
      .then((root) => {
        state.roots = [root];
        markDirty("toolbar");
        rescan();
      })
      .catch(() => {
        state.error = "Could not work out a starting folder - pick one above.";
        markDirty("banner");
        openRootEditor();
      });
  });
})();

window.devhqWork = { beginWork, updateWork, endWork };
/** The folder a terminal opened from nowhere in particular should start in. */
window.devhqPrimaryRoot = () => state.roots[0] || "";
