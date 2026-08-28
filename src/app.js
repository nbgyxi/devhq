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

/** Set once a reset is under way, so nothing writes remembered state back
 *  between the wipe and the reload. */
let resetting = false;

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
  language: "system",
  languageChosen: false,
  theme: "dark",
  compactTechOverview: true,
  viewMode: "cards",
  tableSortKey: "project",
  tableSortDirection: 1,
  tableColumns: ["version", "lang", "runtime", "framework", "ui", "data", "status", "actions"],
  tableColumnMenuOpen: false,
  tableColumnWidths: {},
  settingsOpen: false,
  settingsSection: "general",
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
  /** The note whose source is open, as "file:line", and one entry per note
   *  already read: "file:line" -> { excerpt } or { error }. Kept across
   *  redraws so reopening a note it has already read costs nothing. */
  todoOpen: null,
  todoSource: new Map(),
  /** What the backend says it was built as. Empty until it answers, which is
   *  why the button is only drawn once it has. */
  appVersion: "",
};

/* ------------------------------------------------------------- work log */

/** Everything currently in flight: key -> { label, detail }. */
const work = new Map();
let searchCommands = [];
let searchCommandIndex = 0;

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

// A popped-out terminal can change the scheme too; if the settings page is
// open here, its controls have to follow.
window.devhqOnTermThemeChanged = () => {
  if (state.settingsOpen) syncTermThemeControls();
};

/* ------------------------------------------------------------------ prefs */

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    if (Array.isArray(p.roots)) state.roots = p.roots.filter(Boolean);
    else if (p.root) state.roots = [p.root]; // prefs written before multiple folders
    if (p.sort) state.sort = p.sort;
    if (Array.isArray(p.filters)) state.filters = new Set(p.filters);
    if (p.techFilter) state.techFilter = p.techFilter;
    if (["system", "en", "zh", "hi", "es", "fr", "ar", "bn", "pt", "ru", "id"].includes(p.language)) {
      state.language = p.language;
      state.languageChosen = true;
    }
    if (typeof p.compactTechOverview === "boolean") {
      state.compactTechOverview = p.compactTechOverview;
    } else if (p.showTechOverview === false) {
      // Migrate the short-lived hide/show preference: hidden tech becomes the
      // new compact presentation, so it is visible without adding card height.
      state.compactTechOverview = true;
    }
    if (["dark", "light"].includes(p.theme)) state.theme = p.theme;
    if (["cards", "table"].includes(p.viewMode)) state.viewMode = p.viewMode;
    if (typeof p.tableSortKey === "string") state.tableSortKey = p.tableSortKey;
    if (p.tableSortDirection === -1) state.tableSortDirection = -1;
    if (Array.isArray(p.tableColumns)) state.tableColumns = p.tableColumns.filter((column) => typeof column === "string");
    if (p.tableColumnWidths && typeof p.tableColumnWidths === "object") {
      state.tableColumnWidths = Object.fromEntries(Object.entries(p.tableColumnWidths)
        .filter(([, width]) => Number.isFinite(width) && width >= 70 && width <= 800));
    }
    applyTheme();
    applyLanguage();
  } catch {
    /* first run, or corrupted prefs - defaults are fine */
  }
}

function savePrefs() {
  if (resetting) return;
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        roots: state.roots,
        sort: state.sort,
        filters: [...state.filters],
        techFilter: state.techFilter,
        ...(state.languageChosen ? { language: state.language } : {}),
        theme: state.theme,
        compactTechOverview: state.compactTechOverview,
        viewMode: state.viewMode,
        tableSortKey: state.tableSortKey,
        tableSortDirection: state.tableSortDirection,
        tableColumns: state.tableColumns,
        tableColumnWidths: state.tableColumnWidths,
      })
    );
  } catch {
    /* storage disabled - prefs simply do not persist */
  }
}

function applyLanguage() {
  document.documentElement.lang = state.language === "system"
    ? (navigator.language || "en")
    : state.language;
  window.devhqI18n?.setLanguage(state.language);
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  // The title bar toggle and the Appearance row are two ways to the same
  // setting, so whichever was used, the other has to show the result.
  const themeSelect = el["settings-host"]?.querySelector("#setting-theme");
  if (themeSelect) themeSelect.value = state.theme;
  const button = document.getElementById("toggle-theme");
  if (!button) return;
  const light = state.theme === "light";
  button.classList.toggle("on", light);
  button.setAttribute("aria-pressed", String(light));
  button.title = light ? "Use dark mode" : "Use light mode";
  button.setAttribute("aria-label", button.title);
  window.devhqI18n?.refresh(button);
}

const FIRST_RUN_COPY = {
  zh: "你想使用哪种语言？使用 Windows 系统语言、英语或其他语言。",
  hi: "आप किस भाषा का उपयोग करना चाहते हैं? Windows की भाषा, अंग्रेज़ी या कोई अन्य भाषा चुनें।",
  es: "¿Qué idioma quieres usar? Elige el idioma de Windows, inglés u otro idioma.",
  fr: "Quelle langue souhaitez-vous utiliser ? Choisissez la langue de Windows, l’anglais ou une autre langue.",
  ar: "ما اللغة التي تريد استخدامها؟ اختر لغة Windows أو الإنجليزية أو لغة أخرى.",
  bn: "আপনি কোন ভাষা ব্যবহার করতে চান? Windows-এর ভাষা, ইংরেজি অথবা অন্য ভাষা বেছে নিন।",
  pt: "Qual idioma você deseja usar? Escolha o idioma do Windows, inglês ou outro idioma.",
  ru: "Какой язык вы хотите использовать? Выберите язык Windows, английский или другой язык.",
  id: "Bahasa apa yang ingin Anda gunakan? Pilih bahasa Windows, bahasa Inggris, atau bahasa lain."
};

function firstRunLanguage() {
  if (state.languageChosen) return Promise.resolve();
  const systemCode = (navigator.language || "en").toLowerCase().split("-")[0];
  let systemName = navigator.language || "Windows default";
  try {
    systemName = new Intl.DisplayNames([navigator.language], { type: "language" }).of(systemCode) || systemName;
  } catch {}
  const translatedQuestion = systemCode === "en" ? "" : FIRST_RUN_COPY[systemCode] || "";
  const overlay = document.createElement("div");
  overlay.className = "language-first-run";
  overlay.innerHTML = `<section class="language-dialog" role="dialog" aria-modal="true" aria-labelledby="language-title">
    <img src="devhq-icon.png" alt="" />
    <h1 id="language-title">Choose your language</h1>
    <p>Which language would you like to use? Choose your Windows language, English, or another language.</p>
    ${translatedQuestion ? `<p class="translated" lang="${esc(systemCode)}" dir="auto">${esc(translatedQuestion)}</p>` : ""}
    <div class="language-choices">
      <button class="language-choice primary" data-language="system">${icon("desktop_windows")}
        <span><strong>Use Windows language</strong><small>${esc(systemName)}</small></span></button>
      <button class="language-choice" data-language="en">${icon("language")}
        <span><strong>Use English</strong><small>English</small></span></button>
      <button class="language-choice" data-language="other">${icon("translate")}
        <span><strong>Other language</strong><small>Choose from the supported languages</small></span></button>
    </div>
    <div class="language-other" hidden>
      <select class="sort" aria-label="Other language">
        <option value="zh">中文（简体） — Chinese (Simplified)</option><option value="hi">हिन्दी — Hindi</option>
        <option value="es">Español — Spanish</option><option value="fr">Français — French</option>
        <option value="ar">العربية — Arabic</option><option value="bn">বাংলা — Bengali</option>
        <option value="pt">Português — Portuguese</option><option value="ru">Русский — Russian</option>
        <option value="id">Bahasa Indonesia — Indonesian</option>
      </select>
      <button class="btn primary" data-language="selected">Continue</button>
    </div>
  </section>`;
  document.body.appendChild(overlay);
  return new Promise((resolve) => {
    overlay.onclick = async (e) => {
      const button = e.target.closest("[data-language]");
      if (!button) return;
      let language = button.dataset.language;
      if (language === "other") {
        overlay.querySelector(".language-other").hidden = false;
        overlay.querySelector("select").focus();
        return;
      }
      if (language === "selected") language = overlay.querySelector("select").value;
      state.language = language;
      state.languageChosen = true;
      savePrefs();
      await window.devhqI18n?.setLanguage(language);
      overlay.remove();
      resolve();
    };
  });
}

/** The second thing a new install asks, once the language is settled: where
 *  the projects live. It is the folder editor's own rows in a dialog, so the
 *  path can be typed or picked, and more than one folder can be named before
 *  the first scan ever starts. Resolves once at least one folder is chosen. */
function firstRunFolders() {
  if (state.roots.length) return Promise.resolve();
  const overlay = document.createElement("div");
  overlay.className = "language-first-run";
  overlay.innerHTML = `<section class="language-dialog folder-dialog" role="dialog" aria-modal="true"
      aria-labelledby="folder-title">
    <img src="devhq-icon.png" alt="" />
    <h1 id="folder-title">Which folder holds your projects?</h1>
    <p>DevHQ reads every project inside the folder you choose. Type the path or browse for it - you can add more folders now, or change them later.</p>
    <div class="rootpop-list first-run-roots"></div>
    <p class="first-run-error" hidden></p>
    <div class="first-run-foot">
      <button class="btn" data-first-run="add">${icon("add")}Add another folder</button>
      <button class="btn primary" data-first-run="start">${icon("refresh")}Start scanning</button>
    </div>
  </section>`;

  const list = overlay.querySelector(".first-run-roots");
  const problem = overlay.querySelector(".first-run-error");
  const startButton = overlay.querySelector('[data-first-run="start"]');
  const first = rootRow();
  list.append(first);
  document.body.appendChild(overlay);
  first.querySelector("input").focus();

  const chosen = () => [...list.querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
  const sync = () => { startButton.disabled = chosen().length === 0; };
  const fail = (message) => {
    problem.textContent = message;
    problem.hidden = !message;
  };
  sync();

  // The likely answer is offered rather than assumed: it fills the empty row
  // as a suggestion the moment the backend works it out, and never overwrites
  // anything already typed.
  trackWork("root", "Looking for a code folder", invoke("default_root"))
    .then((root) => {
      const input = first.querySelector("input");
      if (root && !input.value) {
        input.value = root;
        input.select();
        sync();
      }
    })
    .catch(() => {});

  beginWork("first-run", "Waiting for a folder to scan");
  return new Promise((resolve) => {
    const done = () => {
      const roots = [];
      const seen = new Set();
      for (const value of chosen()) {
        if (seen.has(value.toLowerCase())) continue;
        seen.add(value.toLowerCase());
        roots.push(value);
      }
      if (!roots.length) return;
      state.roots = roots;
      savePrefs();
      endWork("first-run");
      overlay.remove();
      markDirty("toolbar");
      resolve();
    };

    overlay.oninput = sync;
    overlay.onclick = (e) => {
      const browse = e.target.closest(".root-browse");
      if (browse) {
        fail("");
        return browseForFolder(browse.closest(".root-row"), fail).then(sync);
      }
      const drop = e.target.closest(".root-drop");
      if (drop) {
        // The last row stays, emptied: there is always somewhere to type.
        if (list.children.length > 1) drop.closest(".root-row").remove();
        else drop.closest(".root-row").querySelector("input").value = "";
        return sync();
      }
      const action = e.target.closest("[data-first-run]");
      if (!action) return;
      if (action.dataset.firstRun === "add") {
        const row = rootRow();
        list.append(row);
        row.querySelector("input").focus();
        sync();
      } else {
        done();
      }
    };
    overlay.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      done();
    };
  });
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

/** The settings page's left-hand menu. One entry per group, in this order. */
const SETTINGS_SECTIONS = [
  { id: "general", label: "General", icon: "tune" },
  { id: "appearance", label: "Appearance", icon: "palette" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
];

function icon(name) {
  return `<span class="ms" aria-hidden="true">${name}</span>`;
}

function settingsIcon(className = "") {
  return `<svg class="${esc(className)}" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M19.4 13a7.8 7.8 0 0 0 .05-1 7.8 7.8 0 0 0-.05-1l2.1-1.64-2-3.46-2.56 1.03a7.5 7.5 0 0 0-1.72-1L14.83 3h-4l-.4 2.93a7.5 7.5 0 0 0-1.72 1L6.16 5.9l-2 3.46L6.26 11a7.8 7.8 0 0 0-.05 1 7.8 7.8 0 0 0 .05 1l-2.1 1.64 2 3.46 2.55-1.03a7.5 7.5 0 0 0 1.72 1l.4 2.93h4l.4-2.93a7.5 7.5 0 0 0 1.72-1l2.56 1.03 2-3.46L19.4 13Zm-6.57 2.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" />
  </svg>`;
}

/** Shortens a git remote to `owner/repo` when it looks like one. */
function shortRemote(url) {
  if (!url) return "";
  const m = url.match(/[:/]([^/:]+\/[^/]+?)(\.git)?$/);
  return m ? m[1] : url;
}

/* ============================== SCREENSHOT MODE ==============================
 * One switch that makes the window safe to photograph: every project's title,
 * group and path is replaced by a made-up but plausible one, the toolbar shows
 * a fake scan root, and the git remote is left out of the detail pane.
 *
 *   DEMO_MODE = true   aliases everything below
 *   DEMO_MODE = false  the app behaves exactly as it did before this block
 *
 * Only what is drawn changes. The real `path` is still what every action,
 * terminal and git read uses, and the folder editor still holds the real
 * roots, so the app works the same with the switch either way. */
const DEMO_MODE = true;

const DEMO_ROOT = "C:\\Projects";
const DEMO_NAMES = [
  "acme-storefront", "orbit-api", "northwind-dashboard", "pelican-cli",
  "harbor-auth", "quartz-ui", "vector-ingest", "lantern-docs",
  "redwood-billing", "sable-scheduler", "atlas-gateway", "juniper-mobile",
  "cobalt-analytics", "meridian-crm", "fernway-blog", "solstice-player",
  "tidepool-sync", "granite-worker", "willow-notify", "cinder-search",
  "beacon-status", "driftwood-shop", "kestrel-router", "opaline-editor",
  "foxglove-metrics", "basalt-queue", "marlin-uploads", "verdant-forms",
  "halcyon-chat", "umbra-proxy", "clearwater-etl", "nimbus-deploy",
  "thistle-invoices", "onyx-identity", "seafarer-maps", "birchwood-wiki",
  "cascade-events", "peregrine-bot", "amberline-store", "slate-reports",
];
const DEMO_GROUPS = ["clients", "internal", "labs", "archive", "vendor", "sandbox"];

/** Memoised so a project keeps the same alias for the whole session. */
function demoPick(map, pool, real) {
  if (!map.has(real)) {
    const i = map.size;
    const base = pool[i % pool.length];
    map.set(real, i < pool.length ? base : `${base}-${Math.floor(i / pool.length) + 1}`);
  }
  return map.get(real);
}
const demoNames = new Map();
const demoGroups = new Map();
const demoName = (real) => (DEMO_MODE && real ? demoPick(demoNames, DEMO_NAMES, real) : real);
const demoGroup = (real) => (DEMO_MODE && real ? demoPick(demoGroups, DEMO_GROUPS, real) : real);

/** The whole displayed path, rebuilt from the aliases: real roots, drives and
 *  intermediate folders never reach the screen. With the switch off this is
 *  the project's real path, which is what every call site drew before. */
function demoPath(p) {
  if (!p) return "";
  if (!DEMO_MODE) return p.path;
  const group = p.group ? `\\${p.group}` : "";
  return `${DEMO_ROOT}${group}\\${p.name}`;
}

/** The toolbar's folder chip: the real roots are never drawn in demo mode. */
function demoRootsLabel(roots) {
  if (!DEMO_MODE) return null;
  return roots.length === 1 ? DEMO_ROOT : `${DEMO_ROOT} +${roots.length - 1}`;
}
/* ============================ END SCREENSHOT MODE =========================== */

/* -------------------------------------------------------------- derived */

/** A discovered folder before anything is known about it. Every field the rest
 *  of the app reads is present, so nothing has to special-case a half project
 *  beyond the `pending` flag itself. */
function stubProject(stub) {
  return {
    name: demoName(stub.name), // aliased in screenshot mode, real otherwise
    path: stub.path,
    group: demoGroup(stub.group), // aliased in screenshot mode, real otherwise
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
  const demo = demoRootsLabel(state.roots);
  if (demo) return demo;
  if (state.roots.length === 1) return state.roots[0];
  return `${state.roots[0]} +${state.roots.length - 1}`;
}

function rootRow(value = "") {
  const row = document.createElement("div");
  row.className = "root-row";
  row.innerHTML = `${icon("folder")}<input spellcheck="false" placeholder="C:\\code" />
    <button class="root-browse" title="Browse for a folder">${icon("folder_open")}</button>
    <button class="root-drop" title="Remove">${icon("close")}</button>`;
  row.querySelector("input").value = value;
  return row;
}

/** Opens the native folder picker for one row. The dialog is Windows' own,
 *  shown on a thread of its own, so this only waits for the answer - the
 *  window carries on drawing behind it. A dismissed dialog changes nothing. */
let browsing = false;
async function browseForFolder(row, onError) {
  if (browsing) return;
  const input = row.querySelector("input");
  browsing = true;
  try {
    const picked = await trackWork(
      "pick-folder",
      "Waiting for the folder picker",
      invoke("pick_folder", { start: input.value.trim() || state.roots[0] || "" })
    );
    if (picked) {
      input.value = picked;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  } catch (err) {
    if (onError) onError(String(err));
    else {
      state.error = String(err);
      markDirty("banner");
    }
  } finally {
    browsing = false;
    input.focus();
  }
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
  const scanLabel = demoRootsLabel(state.roots) || state.roots.join(", ") || "nothing";
  beginWork("scan", `Starting scan of ${scanLabel}`);
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
  // Aliased in screenshot mode, the real strings otherwise.
  project.name = demoName(project.name);
  project.group = demoGroup(project.group);
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

function todoKey(file, line) {
  return `${file}:${line}`;
}

/** Reads the source around one note. The note stays open while it loads, so
 *  the row shows what it is doing rather than nothing. */
function loadTodoSource(project, file, line) {
  const key = todoKey(file, line);
  if (state.todoSource.has(key)) return;
  const token = state.detailToken;
  trackWork(
    `todo-source:${key}`,
    `Reading ${file}`,
    invoke("todo_excerpt", { path: project.path, file, line })
  )
    .then((excerpt) => {
      if (state.detailToken === token) state.todoSource.set(key, { excerpt });
    })
    .catch((err) => {
      if (state.detailToken === token) state.todoSource.set(key, { error: String(err) });
    })
    .finally(() => {
      if (state.detailToken === token) markDirty("detail");
    });
}

/** Opens a note's source, or closes it if it is the one already open. */
function toggleTodoSource(file, line) {
  const key = todoKey(file, line);
  if (state.todoOpen === key) {
    state.todoOpen = null;
  } else {
    state.todoOpen = key;
    const project = selectedProject();
    if (project) loadTodoSource(project, file, line);
  }
  markDirty("detail");
}

/** Fills the window with one project, and starts everything the full view
 *  shows that a card does not already know. */
function openDetail(project) {
  if (state.settingsOpen) {
    state.settingsOpen = false;
    syncSettingsButton();
    markDirty("settings");
  }
  state.selectedPath = project.path;
  window.devhqTrackPageView?.("/project");
  clearDetailData();
  markDirty("detail");
  if (project.git) loadDiff(project);
  loadTodos(project);
}

function closeDetail(nextPath = "/overview") {
  state.selectedPath = null;
  window.devhqTrackPageView?.(nextPath);
  clearDetailData();
  markDirty("detail");
}

function openSettings() {
  if (state.settingsOpen) return closeSettings();
  if (state.selectedPath) closeDetail("/settings");
  state.settingsOpen = true;
  window.devhqTrackPageView?.("/settings");
  syncSettingsButton();
  markDirty("settings");
}

function closeSettings() {
  state.settingsOpen = false;
  window.devhqTrackPageView?.("/overview");
  syncSettingsButton();
  markDirty("settings");
}

/* ---------- the version button and what changed in each release ---------- */

/** Inline code spans, so a release note can name a file or a command without
 *  the whole list turning into prose. Escaped first: the backticks survive it. */
function changelogText(text) {
  return esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

const CHANGE_KINDS = { new: "New", better: "Improved", fix: "Fixed" };

function changelogDate(iso) {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(document.documentElement.lang || undefined, {
    day: "numeric", month: "short", year: "numeric",
  });
}

function releaseHtml(release) {
  const changes = release.changes
    .map(([kind, text]) => `<li class="chg ${esc(kind)}">
        <span class="chg-kind">${esc(CHANGE_KINDS[kind] || kind)}</span>
        <span class="chg-text">${changelogText(text)}</span>
      </li>`)
    .join("");
  return `<section class="release">
    <div class="release-head">
      <span class="release-ver">${esc(release.version)}</span>
      <span class="release-title">${esc(release.title)}</span>
      <time class="release-date" datetime="${esc(release.date)}">${esc(changelogDate(release.date))}</time>
    </div>
    <ul class="release-changes">${changes}</ul>
  </section>`;
}

/** The list is the same every time it opens, so it is built once and then only
 *  shown and hidden - opening it never costs a frame. */
function buildChangelog() {
  const log = window.devhqChangelog;
  const built = `${log?.current}/${state.appVersion}`;
  if (!log || el["changelog-pop"].dataset.built === built) return;
  el["changelog-pop"].innerHTML = `
    <div class="changelog-head">
      <span class="changelog-title">What's new</span>
      <span class="changelog-now">DevHQ ${esc(state.appVersion || log.current)}</span>
      <button class="win-btn" data-changelog-act="close" title="Close">${icon("close")}</button>
    </div>
    <div class="changelog-list">${log.releases.map(releaseHtml).join("")}</div>`;
  el["changelog-pop"].dataset.built = built;
}

function renderVersionButton() {
  const button = el["status-version"];
  if (!button) return;
  button.hidden = !state.appVersion;
  if (state.appVersion) button.textContent = `v${state.appVersion}`;
}

/** Asks the backend what it was built as. Nothing else waits on it: until it
 *  answers, the status bar simply has no version on it. */
function loadAppVersion() {
  invoke("app_version")
    .then((version) => {
      state.appVersion = String(version);
      renderVersionButton();
    })
    .catch(() => {});
}

function changelogOpen() {
  return !el["changelog-pop"].hidden;
}

function openChangelog() {
  buildChangelog();
  el["changelog-pop"].hidden = false;
  el["status-version"].classList.add("on");
  el["status-version"].setAttribute("aria-expanded", "true");
  el["changelog-pop"].scrollTop = 0;
  window.devhqTrackPageView?.("/changelog");
}

function closeChangelog(nextPath = "/overview") {
  if (!changelogOpen()) return;
  el["changelog-pop"].hidden = true;
  el["status-version"].classList.remove("on");
  el["status-version"].setAttribute("aria-expanded", "false");
  window.devhqTrackPageView?.(nextPath);
}

function syncSettingsButton() {
  const button = document.getElementById("open-settings");
  if (!button) return;
  button.classList.toggle("on", state.settingsOpen);
  button.setAttribute("aria-pressed", String(state.settingsOpen));
  button.title = state.settingsOpen ? "Back to overview" : "Settings";
  button.setAttribute("aria-label", button.title);
  window.devhqI18n?.refresh(button);
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
  state.todoOpen = null;
  state.todoSource = new Map();
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

/* ------------------------------------------------------ search commands */

function availableSearchCommands() {
  const commands = [
    { kind: "CMD", label: "Rescan projects", detail: "F5", action: "rescan" },
    { kind: "TERM", label: "Toggle terminal panel", detail: "Ctrl+`", action: "terminal-panel" },
    ...Object.entries(FILTERS).map(([key, filter]) => ({
      kind: "VIEW",
      label: `${state.filters.has(key) ? "Remove" : "Show"} ${filter.label.toLowerCase()}`,
      detail: "filter projects",
      action: "filter",
      key,
    })),
  ];

  for (const project of state.projects.filter((p) => !p.pending)) {
    const detail = [project.path, project.git?.branch].filter(Boolean).join(" · ");
    commands.push({ kind: "REPO", label: project.name, detail, action: "repo", project });
    if (project.runCmd) {
      commands.push({ kind: "RUN", label: `Run ${project.name}`, detail: project.runCmd, action: "run", project });
    }
    commands.push({
      kind: "TERM", label: `Terminal — ${project.name}`, detail: project.path,
      action: "terminal", project,
    });
  }
  return commands;
}

function renderSearchCommands() {
  const menu = el["search-menu"];
  const input = el["search-input"];
  if (!menu || document.activeElement !== input) return;
  const terms = input.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  searchCommands = availableSearchCommands()
    .filter((command) => {
      const hay = `${command.kind} ${command.label} ${command.detail}`.toLowerCase();
      return terms.every((term) => hay.includes(term));
    })
    .slice(0, 60);
  searchCommandIndex = Math.min(searchCommandIndex, Math.max(0, searchCommands.length - 1));
  menu.innerHTML = searchCommands.length
    ? searchCommands.map((command, index) => `<button class="search-command${
        index === searchCommandIndex ? " on" : ""
      }" data-command="${index}"><span class="command-kind ${command.kind.toLowerCase()}">${esc(
        command.kind
      )}</span><span class="command-label">${esc(command.label)}</span><span class="command-detail">${esc(
        command.detail
      )}</span></button>`).join("")
    : '<div class="search-command-empty">No commands or projects found</div>';
  menu.hidden = false;
  menu.querySelector(".search-command.on")?.scrollIntoView({ block: "nearest" });
}

function closeSearchCommands() {
  if (el["search-menu"]) el["search-menu"].hidden = true;
}

function runSearchCommand(index) {
  const command = searchCommands[index];
  if (!command) return;
  closeSearchCommands();
  state.search = "";
  el["search-input"].value = "";
  markDirty("grid", "filters");
  if (command.action === "rescan") rescan();
  else if (command.action === "terminal-panel") openTerminalPanel();
  else if (command.action === "filter") toggleFilter(command.key);
  else if (command.action === "repo") openDetail(command.project);
  else if (command.action === "run") projectAction("run", command.project);
  else if (command.action === "terminal") projectAction("terminal", command.project);
}

/* ----------------------------------------------------------------- views */

function skeletonView(p) {
  const note = p.stopped
    ? `${icon("do_not_disturb_on")}not read - the scan was stopped`
    : `${icon("hourglass_top")}reading git status...`;
  const tech = state.compactTechOverview
    ? `<div class="sk sk-line" style="width:62%"></div>`
    : `<div class="sk-row">
      <span class="sk sk-pill" style="width:58px"></span>
      <span class="sk sk-pill" style="width:44px"></span>
      <span class="sk sk-pill" style="width:70px"></span>
    </div>`;
  return `<article class="card skeleton${p.stopped ? " stopped" : ""}" data-path="${esc(p.path)}">
    <div class="card-top"><div class="card-name">${esc(p.name)}</div></div>
    ${tech}
    <div class="sk sk-line" style="width:72%"></div>
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
          !state.compactTechOverview && t.version ? `<i class="v">${esc(t.version)}</i>` : ""
        }</span>`
    )
    .join("");
  const more = p.tech.length > 5
    ? `<span class="tag more">+${p.tech.length - 5}</span>`
    : "";

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
    ${p.tech.length ? `<div class="tags${state.compactTechOverview ? " compact" : ""}">${tags}${more}</div>` : ""}
    ${p.description ? `<div class="desc">${esc(p.description)}</div>` : ""}
    <div class="stats">${stats.join("")}</div>
    ${commit}
    ${cardActions(p)}
  </article>`;
}

const TABLE_TECH_COLUMNS = [
  ["lang", "Language"], ["runtime", "Runtime"], ["framework", "Framework"],
  ["ui", "UI"], ["build", "Build"], ["data", "Data"], ["test", "Testing"],
  ["infra", "Infrastructure"], ["tool", "Tools"],
];

function tableColumnOptions() {
  return [
    ["version", "Project version"],
    ...TABLE_TECH_COLUMNS,
    ["status", "Status"],
  ];
}

function columnPickerView() {
  return `<div class="column-picker" id="table-column-picker">
    <button class="column-picker-button" id="table-column-picker-button" aria-haspopup="true" aria-expanded="${state.tableColumnMenuOpen}"><span>Columns</span>${icon("keyboard_arrow_down")}</button>
    <div class="column-picker-menu" id="table-column-picker-menu" ${state.tableColumnMenuOpen ? "" : "hidden"}><div class="column-picker-title">Visible columns</div>${tableColumnOptions()
    .map(([key, label]) => `<label><input type="checkbox" data-table-column="${key}" ${
      state.tableColumns.includes(key) ? "checked" : ""
    } /><span>${label}</span></label>`).join("")}</div></div>`;
}

/** The text of a run of small spans, for a title attribute. */
function stripTags(html) {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function tableTechCell(tech) {
  if (!tech.length) return '<td class="table-tech-cell"><span class="table-muted">—</span></td>';
  return `<td class="table-tech-cell"><div class="table-tech-list">${tech.map((item) => {
    const full = item.version ? `${item.name} ${item.version}` : item.name;
    return `<button class="table-tech" data-tech="${esc(item.name)}" title="${esc(full)}"><span>${esc(item.name)}</span>${
      item.version ? `<code>${esc(item.version)}</code>` : ""
    }</button>`;
  }).join("")}</div></td>`;
}

function tableRowView(p) {
  const techColumns = TABLE_TECH_COLUMNS.filter(([kind]) => state.tableColumns.includes(kind));
  const trailingColumns = Number(state.tableColumns.includes("status")) + 1;
  if (p.pending) {
    const extraColumns = Number(state.tableColumns.includes("version")) + techColumns.length + trailingColumns;
    return `<tr class="project-row pending" data-path="${esc(p.path)}"><td><strong>${esc(
      p.name
    )}</strong><small>Reading project…</small></td>${extraColumns
      ? `<td class="table-muted" colspan="${extraColumns}">Loading project…</td>`
      : ""}</tr>`;
  }
  const technologyCells = techColumns.map(([kind]) =>
    tableTechCell(p.tech.filter((tech) => tech.kind === kind))
  ).join("");
  const statuses = [];
  if (p.running.length) statuses.push(`<span class="table-status running">${p.running.length} running</span>`);
  if (changeCount(p)) statuses.push(`<span class="table-status dirty">${changeCount(p)} changed</span>`);
  if (!statuses.length) statuses.push('<span class="table-muted">Idle</span>');
  // The cell is one line and clips, so the whole of it has to be reachable.
  const statusTitle = statuses.length ? stripTags(statuses.join(", ")) : "";
  return `<tr class="project-row" data-path="${esc(p.path)}">
    <td><strong title="${esc(p.name)}">${esc(p.name)}</strong><small title="${esc(demoPath(p))}">${esc(demoPath(p))}</small></td>
    ${state.tableColumns.includes("version") ? `<td class="project-version">${p.version ? esc(p.version) : "—"}</td>` : ""}
    ${technologyCells}
    ${state.tableColumns.includes("status") ? `<td class="table-status-cell" title="${esc(statusTitle)}"><div class="table-status-list">${statuses.join("")}</div></td>` : ""}
    <td class="table-actions-cell"><div class="table-actions">
      <button data-act="run" title="${p.runCmd ? `Run ${esc(p.runCmd)}` : "No run command detected"}" ${p.runCmd ? "" : "disabled"}>${icon("play_arrow")}</button>
      <button data-act="vscode" title="Open in VS Code">${icon("code")}</button>
      <button data-act="terminal" title="Open a terminal">${icon("terminal")}</button>
    </div></td>
  </tr>`;
}

function tableSortValue(project, key) {
  if (key === "project") return project.name;
  if (key === "version") return project.version || null;
  if (key === "status") return project.running.length * 100000 + changeCount(project);
  if (key.startsWith("tech:")) {
    const kind = key.slice(5);
    const tech = project.tech.filter((item) => item.kind === kind)
      .sort((a, b) => a.name.localeCompare(b.name))[0];
    return tech ? `${tech.name} ${tech.version || ""}` : null;
  }
  return project.name;
}

function sortTableProjects(projects) {
  const direction = state.tableSortDirection;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...projects].sort((a, b) => {
    const av = tableSortValue(a, state.tableSortKey);
    const bv = tableSortValue(b, state.tableSortKey);
    if (av == null && bv == null) return a.name.localeCompare(b.name);
    if (av == null) return -direction;
    if (bv == null) return direction;
    const compared = typeof av === "number" && typeof bv === "number" ? av - bv : collator.compare(av, bv);
    return compared * direction || a.name.localeCompare(b.name);
  });
}

function visibleTableColumnKeys() {
  return [
    "project",
    ...(state.tableColumns.includes("version") ? ["version"] : []),
    ...TABLE_TECH_COLUMNS.filter(([kind]) => state.tableColumns.includes(kind)).map(([kind]) => `tech:${kind}`),
    ...(state.tableColumns.includes("status") ? ["status"] : []),
    "actions",
  ];
}

function tableColumnWidth(key) {
  const defaults = { project: 240, version: 105, status: 130, actions: 112 };
  return state.tableColumnWidths[key] || defaults[key] || 140;
}

function tableResizeHandle(key) {
  return `<span class="table-resize-handle" data-resize-column="${key}" title="Drag to resize column"></span>`;
}

function tableHeader(key, label) {
  const active = state.tableSortKey === key;
  const direction = active ? (state.tableSortDirection === 1 ? "ascending" : "descending") : "none";
  return `<th aria-sort="${direction}"><button class="table-sort${active ? " active" : ""}" data-table-sort="${key}">${label}<span>${
    active ? (state.tableSortDirection === 1 ? "▲" : "▼") : ""
  }</span></button>${tableResizeHandle(key)}</th>`;
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

/** The code around one note: a skeleton while it is being read, then the
 *  lines themselves with the one the note is on picked out. */
function todoSourceView(key) {
  const entry = state.todoSource.get(key);
  if (!entry) {
    return `<div class="todosrc loading">${icon("hourglass_top")}reading the file...</div>`;
  }
  if (entry.error) {
    return `<div class="todosrc error">${icon("error_outline")}${esc(entry.error)}</div>`;
  }
  const { start, line, lines } = entry.excerpt;
  const body = lines
    .map((text, index) => {
      const number = start + index;
      return `<div class="srcline${number === line ? " hit" : ""}">
        <span class="srcnum">${number}</span><span class="srccode">${esc(text) || " "}</span>
      </div>`;
    })
    .join("");
  return `<div class="todosrc"><div class="srclines">${body}</div></div>`;
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
    .map((t) => {
      const key = todoKey(t.file, t.line);
      const open = state.todoOpen === key;
      return `<div class="todoitem${open ? " open" : ""}">
        <button class="todorow" type="button" aria-expanded="${open}"
                data-todo-file="${esc(t.file)}" data-todo-line="${t.line}"
                title="Show the code around this note">
          <span class="kind ${esc(t.kind)}">${esc(t.kind)}</span>
          <span class="note">${esc(t.text) || "<em>no note</em>"}</span>
          <span class="where">${esc(t.file)}:${t.line}</span>
          <span class="ms todo-chev" aria-hidden="true">expand_more</span>
        </button>
        ${open ? todoSourceView(key) : ""}
      </div>`;
    })
    .join("");
  const n = state.todos.items.length;
  const note = ` <span class="count">${n}${state.todos.truncated ? "+" : ""}</span>`;
  const tail = state.todos.truncated
    ? `<div class="sk-note">${icon("more_horiz")}stopped at ${n} - there are more</div>`
    : "";
  return head(`<div class="todolist">${rows}</div>${tail}`, note);
}

function detailView(p, replayEntrance = true) {
  const g = p.git;
  const kv = [];
  if (p.description) kv.push(["Description", esc(p.description)]);
  kv.push(["Path", `<span class="mono">${esc(demoPath(p))}</span>`]);
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
    // The remote is the one thing an alias cannot cover, so screenshot mode
    // leaves the row out entirely rather than showing a made-up URL.
    if (!DEMO_MODE)
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

  return `<div class="detail${replayEntrance ? "" : " steady"}">
    <div class="detail-head">
      <button class="btn back" data-act="close" title="Back to the list (Esc)">${icon(
        "arrow_back"
      )}Back</button>
      <div class="detail-id">
        <h2>${esc(p.name)}${
          p.version ? `<span class="card-ver">v${esc(p.version)}</span>` : ""
        }</h2>
        <div class="path">${esc(demoPath(p))}</div>
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
          ? `<div class="dcol-work">
               <div class="dcol dcol-files">${filesSection(p)}</div>
               <div class="dcol dcol-patch">${patchSection()}</div>
             </div>`
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
let tableResizeClickSuppressed = false;

function markDirty(...regions) {
  for (const region of regions) dirty.add(region);
  schedule();
}

/** Repaints one card in place - no reflow of the list, so results can stream in
 *  under the pointer without anything moving. */
function touchCard(project) {
  if (dirty.has("grid")) return;
  // Table values are sort keys, so a streamed update may move the row.
  if (state.viewMode === "table") return markDirty("grid");
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
  if (regions.has("settings")) renderSettings();
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
        <button class="win-btn" id="toggle-theme" title="Use light mode" aria-label="Use light mode" aria-pressed="false">
          <svg class="win-icon theme-sun" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M11 1h2v3h-2V1Zm0 19h2v3h-2v-3ZM3.51 4.93l1.42-1.42 2.12 2.12-1.42 1.42-2.12-2.12Zm13.44 13.44 1.42-1.42 2.12 2.12-1.42 1.42-2.12-2.12ZM1 11h3v2H1v-2Zm19 0h3v2h-3v-2ZM3.51 19.07l2.12-2.12 1.42 1.42-2.12 2.12-1.42-1.42ZM16.95 5.63l2.12-2.12 1.42 1.42-2.12 2.12-1.42-1.42ZM12 6a6 6 0 1 1 0 12 6 6 0 0 1 0-12Zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
          </svg>
          <svg class="win-icon theme-moon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20.2 15.35A8.4 8.4 0 0 1 8.65 3.8 9 9 0 1 0 20.2 15.35ZM12 21a7 7 0 0 1-5.18-11.7 10.4 10.4 0 0 0 7.88 7.88A7 7 0 0 1 12 21Z" />
          </svg>
        </button>
        <button class="win-btn" id="open-settings" title="Settings" aria-label="Settings">
          ${settingsIcon("win-icon")}
        </button>
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
      <div class="field search" id="search-box">${icon("search")}
        <input id="search-input" spellcheck="false"
               placeholder="Search projects and commands..." />
        <div class="search-menu" id="search-menu" hidden></div>
      </div>
      <div class="tech-picker">
        <select class="sort" id="tech-filter"><option value="">All tech</option></select>
        <button class="tech-clear" id="tech-clear" type="button" title="Clear the technology filter" hidden>${icon(
          "close"
        )}</button>
      </div>
      <div class="sort-buttons" id="sort-buttons" aria-label="Sort projects">
        <button data-sort="activity" title="Sort by recent activity">Recent</button>
        <button data-sort="name" title="Sort by project name">Name</button>
        <button data-sort="changes" title="Sort by most changes">Changes</button>
        <button data-sort="running" title="Show running projects first">Running</button>
        <button data-sort="tech" title="Sort by technology">Tech</button>
      </div>
      <div class="sort-buttons view-buttons" id="view-buttons" aria-label="Project view">
        <button data-view="cards">Cards</button>
        <button data-view="table">Table</button>
      </div>
    </div>

    <div class="filters" id="filters"></div>
    <div id="banner-host"></div>
    <div class="summary" id="summary"></div>
    <div class="scroll" id="scroll"><div class="grid" id="grid"></div></div>
    <div class="statusbar">
      <div class="activity" id="activity"></div>
      <div class="status-version-wrap" id="status-version-wrap">
        <button class="status-btn status-version" id="status-version" title="What's new in DevHQ"
                aria-haspopup="dialog" aria-expanded="false"></button>
        <div class="changelog-pop" id="changelog-pop" role="dialog" aria-label="What's new" hidden></div>
      </div>
      <button class="status-btn" id="status-term" title="Open a terminal" aria-expanded="false">${icon(
        "terminal"
      )}<span class="label">Terminal</span><span class="term-count" hidden>0</span></button>
      <div class="act-bar" id="status-progress" hidden><i></i></div>
    </div>
    <div id="detail-host"></div>
    <div id="settings-host"></div>
  `;

  for (const id of [
    "brand-sub", "loadbar", "roots-btn", "roots-label", "roots-pop", "roots-list",
    "rescan", "search-input", "search-menu", "tech-filter", "tech-clear", "sort-buttons", "view-buttons", "activity", "filters",
    "banner-host", "summary", "grid", "detail-host", "settings-host", "open-settings", "toggle-theme",
    "status-term", "status-progress", "status-version", "changelog-pop",
  ]) {
    el[id] = document.getElementById(id);
  }

  el["search-input"].value = state.search;
  renderVersionButton();
  wireShell();
  applyTheme();
  syncSettingsButton();
  window.syncTerminalButton?.();
}

function renderToolbar() {
  const busy = state.scanning;
  el["sort-buttons"].hidden = state.viewMode === "table";
  el.loadbar.hidden = !busy && !work.size;
  el.rescan.classList.toggle("spinning", busy);
  el.rescan.querySelector(".label").textContent = busy ? "Stop" : "Rescan";
  el.rescan.querySelector(".ms").textContent = busy ? "stop_circle" : "refresh";
  el.rescan.title = busy ? "Stop the scan" : "Scan the folder again";
  el["roots-label"].textContent = rootsLabel();
  el["roots-btn"].classList.toggle("empty", state.roots.length === 0);
  el["roots-btn"].title = state.roots.length
    ? `Scanning ${demoRootsLabel(state.roots) || state.roots.join(", ")} - click to change`
    : "Click to choose the folders to scan";
  for (const button of el["sort-buttons"].querySelectorAll("[data-sort]")) {
    const active = button.dataset.sort === state.sort;
    button.classList.toggle("on", active);
    button.setAttribute("aria-pressed", String(active));
  }
  for (const button of el["view-buttons"].querySelectorAll("[data-view]")) {
    const active = button.dataset.view === state.viewMode;
    button.classList.toggle("on", active);
    button.setAttribute("aria-pressed", String(active));
  }
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
  // A filter that is on has to look on, and be switchable off without hunting
  // for "All tech" in a list of a hundred.
  const filtering = Boolean(state.techFilter);
  el["tech-filter"].classList.toggle("on", filtering);
  el["tech-clear"].hidden = !filtering;
  el["tech-clear"].title = filtering
    ? `Stop filtering by ${state.techFilter}`
    : "Clear the technology filter";
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
      class="act-label">Idle</span></span>`;
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
  const visible = visibleProjects();
  const list = state.viewMode === "table" ? sortTableProjects(visible) : visible;
  let body;

  if (!list.length) {
    body = state.scanning
      ? `<div class="empty">${icon("hourglass_top")}<div>Looking for projects in ${esc(
          demoRootsLabel(state.roots) || state.roots.join(", ")
        )}...</div></div>`
      : `<div class="empty">${icon("search_off")}<div>${
          state.projects.length
            ? "No projects match the current filters."
            : "No projects found in this folder."
        }</div></div>`;
  } else {
    body = state.viewMode === "table"
      ? `<div class="project-table-wrap"><table class="project-table" style="width:${visibleTableColumnKeys()
          .reduce((sum, key) => sum + tableColumnWidth(key), 0)}px"><colgroup>${visibleTableColumnKeys()
          .map((key) => `<col data-table-col="${key}" style="width:${tableColumnWidth(key)}px" />`).join("")}</colgroup><thead><tr>
          ${tableHeader("project", "Project")}${state.tableColumns.includes("version") ? tableHeader("version", "Version") : ""}${TABLE_TECH_COLUMNS
            .filter(([kind]) => state.tableColumns.includes(kind))
            .map(([kind, label]) => tableHeader(`tech:${kind}`, label)).join("")}${
              state.tableColumns.includes("status") ? tableHeader("status", "Status") : ""
            }<th class="table-actions-head">${columnPickerView()}${tableResizeHandle("actions")}</th>
        </tr></thead><tbody>${list.map(tableRowView).join("")}</tbody></table></div>`
      : list.map(cardView).join("");
  }

  el.grid.classList.toggle("table-view", state.viewMode === "table");
  el.grid.innerHTML = body;
  cardIndex = new Map();
  for (const card of el.grid.querySelectorAll(".card,.project-row")) cardIndex.set(card.dataset.path, card);
}

function patchCard(path) {
  const current = cardIndex.get(path);
  const project = state.byPath.get(path);
  if (!current || !project) return;
  const holder = document.createElement("div");
  if (state.viewMode === "table") {
    const table = document.createElement("table");
    table.innerHTML = `<tbody>${tableRowView(project)}</tbody>`;
    holder.appendChild(table);
  } else {
    holder.innerHTML = cardView(project);
  }
  const next = state.viewMode === "table" ? holder.querySelector("tr") : holder.firstElementChild;
  current.replaceWith(next);
  cardIndex.set(path, next);
}

function renderDetail() {
  const p = selectedProject();
  const host = el["detail-host"];
  if (!p) {
    host.innerHTML = "";
    delete host.dataset.path;
    return;
  }

  // Detail data arrives in pieces. Rebuilding is cheap, but replaying the
  // entrance animation for each piece makes the Overview column flash. Only
  // animate when entering a project, not while refreshing the open one.
  const entering = host.dataset.path !== p.path;
  // Opening a note rebuilds the column, and a list that jumps back to the top
  // when you click a row in the middle of it is unusable. Only worth keeping
  // while staying on the same project - entering one starts at the top.
  const todoScroll = entering ? 0 : host.querySelector(".todolist")?.scrollTop || 0;
  host.innerHTML = detailView(p, entering);
  host.dataset.path = p.path;
  if (todoScroll) {
    const list = host.querySelector(".todolist");
    if (list) list.scrollTop = todoScroll;
  }
}

function renderSettings() {
  const host = el["settings-host"];
  if (!state.settingsOpen) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `<main class="settings-page">
    <header class="detail-head settings-head">
      <button class="btn back" data-settings="close">${icon("arrow_back")}Back</button>
      <div class="detail-id"><h2>${settingsIcon("settings-heading-icon")}Settings</h2></div>
    </header>
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings sections">
        ${SETTINGS_SECTIONS.map((section) => `<button class="settings-nav-item" type="button"
          data-settings-section="${section.id}">${icon(section.icon)}${section.label}</button>`).join("")}
      </nav>
      <div class="settings-body">
        <section class="settings-group" data-section="general">
          <h3>General</h3>
          <label class="settings-row" for="setting-language">
            <span><strong>Language</strong><small>Choose the language DevHQ uses.</small></span>
            <select class="sort setting-control" id="setting-language">
              <option value="system">Windows default</option>
              <option value="en">English</option>
              <option value="zh">中文（简体） — Chinese (Simplified)</option>
              <option value="hi">हिन्दी — Hindi</option>
              <option value="es">Español — Spanish</option>
              <option value="fr">Français — French</option>
              <option value="ar">العربية — Arabic</option>
              <option value="bn">বাংলা — Bengali</option>
              <option value="pt">Português — Portuguese</option>
              <option value="ru">Русский — Russian</option>
              <option value="id">Bahasa Indonesia — Indonesian</option>
            </select>
          </label>
          <div class="settings-row danger-row">
            <span><strong>Reset DevHQ</strong><small>Forget the folders, language, appearance and terminals, and start over as if the app had just been installed.</small></span>
            <button class="btn danger setting-control" id="setting-reset" type="button">Reset</button>
          </div>
        </section>
        <section class="settings-group" data-section="appearance">
          <h3>Appearance</h3>
          <label class="settings-row" for="setting-theme">
            <span><strong>Theme</strong><small>The window's own light or dark colors.</small></span>
            <select class="sort setting-control" id="setting-theme">
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <label class="settings-row" for="setting-compact-tech">
            <span><strong>Compact tech in overview</strong><small>Show technologies in a single neutral line instead of colored tags.</small></span>
            <input class="setting-check" id="setting-compact-tech" type="checkbox" />
          </label>
        </section>
        <section class="settings-group" data-section="terminal">
          <h3>Terminal</h3>
          <label class="settings-row" for="setting-terminal-shell">
            <span><strong>Default shell</strong><small>Used for new terminals. Override it from the terminal toolbar.</small></span>
            <select class="sort setting-control" id="setting-terminal-shell"></select>
          </label>
          <label class="settings-row" for="setting-term-theme">
            <span><strong>Color scheme</strong><small>Colors for every terminal, docked or popped out.</small></span>
            <select class="sort setting-control" id="setting-term-theme"></select>
          </label>
          <div class="settings-row term-theme-row">
            <span><strong>Colors</strong><small>Change any color to build a scheme of your own.</small></span>
            <div class="term-theme-edit">
              <div class="term-theme-preview" aria-hidden="true">
                <div><span style="color:var(--term-c2)">you</span><span style="color:var(--term-c8)">@</span><span style="color:var(--term-c6)">devhq</span> <span style="color:var(--term-c4)">c:\\code\\devhq</span> <span style="color:var(--term-c13)">(main)</span></div>
                <div>&gt; npm run <span style="color:var(--term-c14)">dev</span></div>
                <div><span style="color:var(--term-c3)">warn</span> 2 outdated packages</div>
                <div><span style="color:var(--term-c1)">error</span> port 5173 busy</div>
                <div><span style="color:var(--term-c10)">ready</span> in <span style="color:var(--term-c12)">412 ms</span><span class="term-theme-caret"> </span></div>
              </div>
              <div class="term-swatches" id="setting-term-swatches"></div>
              <button class="btn term-theme-reset" id="setting-term-reset" type="button">Reset to preset</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  </main>`;
  host.querySelector("#setting-language").value = state.language;
  host.querySelector("#setting-theme").value = state.theme;
  host.querySelector("#setting-compact-tech").checked = state.compactTechOverview;
  const shellSetting = window.devhqTerminalSettings;
  const shellSelect = host.querySelector("#setting-terminal-shell");
  shellSelect.innerHTML = shellSetting.profiles
    .map((profile) => `<option value="${profile.value}">${profile.label}</option>`)
    .join("");
  shellSelect.value = shellSetting.getDefault();
  buildTermThemeControls(host);
  showSettingsSection(state.settingsSection);
}

/** Resetting throws away everything the app remembers, and there is no undo,
 *  so it takes two clicks: the first arms the button, the second wipes. The
 *  arming lapses on its own, so a stray click cannot leave it loaded. */
let resetTimer = 0;
let armedButton = null;
function armReset(button) {
  // Leaving Settings and coming back rebuilds the button, and that new button
  // has to be armed again: only a second click on the same one resets.
  if (resetTimer && armedButton === button) {
    clearTimeout(resetTimer);
    resetTimer = 0;
    return resetApp();
  }
  clearTimeout(resetTimer);
  armedButton = button;
  button.classList.add("armed");
  button.textContent = "Click again to reset";
  resetTimer = setTimeout(() => {
    resetTimer = 0;
    armedButton = null;
    button.classList.remove("armed");
    button.textContent = "Reset";
  }, 6000);
}

/** Puts the app back to a fresh install: every shell closed, everything it
 *  remembered dropped, then a reload so the first-run questions come round
 *  again. Only the analytics visitor id survives - it is not a preference, and
 *  a reset install is still the same install. */
async function resetApp() {
  resetting = true;
  window.devhqResetting = true;
  beginWork("reset", "Resetting DevHQ");
  for (const id of [...(window.termsState?.known.keys() || [])]) {
    await invoke("term_close", { id }).catch(() => {});
  }
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("devhq.") && key !== "devhq.analytics.visitor.v1") localStorage.removeItem(key);
    }
  } catch {
    /* storage disabled - there was nothing remembered to drop */
  }
  location.reload();
}

/** Shows one section. Every group stays mounted and only its visibility
 *  changes, so switching sections cannot reset a control - the colour swatches
 *  in particular are built once and never rebuilt underneath the pointer. */
function showSettingsSection(id) {
  const host = el["settings-host"];
  if (!SETTINGS_SECTIONS.some((section) => section.id === id)) id = SETTINGS_SECTIONS[0].id;
  state.settingsSection = id;
  for (const group of host.querySelectorAll(".settings-group")) {
    group.hidden = group.dataset.section !== id;
  }
  for (const item of host.querySelectorAll(".settings-nav-item")) {
    const on = item.dataset.settingsSection === id;
    item.classList.toggle("on", on);
    item.setAttribute("aria-current", String(on));
  }
  host.querySelector(".settings-body").scrollTop = 0;
}

/** Builds the colour-scheme picker and its 18 swatches once per settings
 *  render. Later changes only write values back into these inputs - rebuilding
 *  them would close the colour picker the user is standing in. */
function buildTermThemeControls(host) {
  const theme = window.devhqTermTheme;
  const themeSelect = host.querySelector("#setting-term-theme");
  themeSelect.innerHTML = theme.presets
    .map((preset) => `<option value="${esc(preset.id)}">${esc(preset.label)}</option>`)
    .join("") + `<option value="custom">Custom</option>`;
  const swatch = (key, label, value, wide = false) => `<label class="term-swatch${wide ? " wide" : ""}" title="${esc(label)}">
      <input type="color" data-term-color="${key}" value="${value}" aria-label="${esc(label)}" />
      <span>${esc(label)}</span>
    </label>`;
  const palette = theme.palette();
  host.querySelector("#setting-term-swatches").innerHTML = [
    swatch("bg", "Background", palette.bg, true),
    swatch("fg", "Foreground", palette.fg, true),
    ...palette.ansi.map((hex, i) => swatch(String(i), theme.colorNames[i], hex)),
  ].join("");
  syncTermThemeControls();
}

/** Mirrors the live scheme into the settings controls without touching any
 *  other part of the page - a colour change must not redraw the panel it was
 *  made from, and the terminals themselves recolour through CSS variables. */
function syncTermThemeControls() {
  const host = el["settings-host"];
  const themeSelect = host?.querySelector("#setting-term-theme");
  if (!themeSelect) return;
  const theme = window.devhqTermTheme;
  const palette = theme.palette();
  const custom = theme.selection() === "custom";
  themeSelect.value = custom ? "custom" : theme.selection();
  for (const input of host.querySelectorAll("[data-term-color]")) {
    const key = input.dataset.termColor;
    const value = key === "bg" || key === "fg" ? palette[key] : palette.ansi[Number(key)];
    if (input.value !== value) input.value = value;
  }
  const reset = host.querySelector("#setting-term-reset");
  reset.disabled = !custom;
  reset.textContent = custom ? `Reset to ${theme.presetLabel()}` : "Reset to preset";
}

/** Changes only the two DOM fragments affected by picking a diff file. The
 *  Overview/TODO columns stay mounted, so a file click cannot flash or reset
 *  the rest of the detail view. */
function renderDiffSelection() {
  for (const row of el["detail-host"].querySelectorAll(".filerow[data-file]")) {
    row.classList.toggle("on", row.dataset.file === state.diffFile);
  }
  const patch = el["detail-host"].querySelector(".dcol-patch");
  if (patch) patch.innerHTML = patchSection();
}

/* ------------------------------------------------------------------ wiring */

/** All handlers are bound once, on elements that live forever, or delegated
 *  from a container - so a redraw never has to rewire anything. */
function wireShell() {
  el["open-settings"].onclick = openSettings;
  el["toggle-theme"].onclick = () => {
    state.theme = state.theme === "light" ? "dark" : "light";
    applyTheme();
    savePrefs();
  };

  el.rescan.onclick = () => {
    if (state.scanning) stopScan();
    else rescan();
  };

  el["status-version"].onclick = () => (changelogOpen() ? closeChangelog() : openChangelog());

  el["changelog-pop"].onclick = (e) => {
    if (e.target.closest("[data-changelog-act=\"close\"]")) {
      closeChangelog();
      el["status-version"].focus();
    }
  };

  el["status-term"].onclick = () => window.openTerminalPanel?.();

  el["sort-buttons"].onclick = (e) => {
    const button = e.target.closest("[data-sort]");
    if (!button || button.dataset.sort === state.sort) return;
    state.sort = button.dataset.sort;
    savePrefs();
    markDirty("toolbar", "grid");
  };
  el["view-buttons"].onclick = (e) => {
    const button = e.target.closest("[data-view]");
    if (!button || button.dataset.view === state.viewMode) return;
    state.viewMode = button.dataset.view;
    savePrefs();
    markDirty("toolbar", "grid");
  };
  el.grid.onchange = (e) => {
    const input = e.target.closest("[data-table-column]");
    if (!input) return;
    state.tableColumns = input.checked
      ? [...state.tableColumns, input.dataset.tableColumn]
      : state.tableColumns.filter((column) => column !== input.dataset.tableColumn);
    const sortedColumn = state.tableSortKey.startsWith("tech:") ? state.tableSortKey.slice(5) : state.tableSortKey;
    if (!state.tableColumns.includes(sortedColumn) && state.tableSortKey !== "project") {
      state.tableSortKey = "project";
      state.tableSortDirection = 1;
    }
    savePrefs();
    markDirty("grid");
  };
  el.grid.onpointerdown = (down) => {
    const handle = down.target.closest("[data-resize-column]");
    if (!handle || down.button !== 0) return;
    down.preventDefault();
    down.stopPropagation();
    const key = handle.dataset.resizeColumn;
    const table = handle.closest("table");
    const col = [...table.querySelectorAll("col[data-table-col]")].find((item) => item.dataset.tableCol === key);
    if (!col) return;
    const startX = down.clientX;
    const startWidth = col.getBoundingClientRect().width;
    const startTableWidth = table.getBoundingClientRect().width;
    let width = startWidth;
    let moved = false;
    handle.setPointerCapture(down.pointerId);
    const move = (e) => {
      moved ||= Math.abs(e.clientX - startX) > 2;
      width = Math.max(key === "actions" ? 90 : 76, Math.min(800, startWidth + e.clientX - startX));
      col.style.width = `${width}px`;
      table.style.width = `${startTableWidth + width - startWidth}px`;
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      if (!moved) return;
      state.tableColumnWidths[key] = Math.round(width);
      savePrefs();
      tableResizeClickSuppressed = true;
      setTimeout(() => { tableResizeClickSuppressed = false; }, 0);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  el["tech-clear"].onclick = () => {
    if (!state.techFilter) return;
    state.techFilter = "";
    el["tech-filter"].value = "";
    el["tech-filter"].dataset.signature = "";
    savePrefs();
    markDirty("filters", "toolbar", "grid");
  };

  el["tech-filter"].onchange = (e) => {
    state.techFilter = e.target.value;
    el["tech-filter"].dataset.signature = "";
    savePrefs();
    markDirty("filters", "grid");
  };

  el["roots-btn"].onclick = () => (rootEditorOpen() ? closeRootEditor() : openRootEditor());

  el["roots-pop"].onclick = (e) => {
    const browse = e.target.closest(".root-browse");
    if (browse) return browseForFolder(browse.closest(".root-row"));
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
    if (changelogOpen() && !e.target.closest("#status-version-wrap")) closeChangelog();
    if (!e.target.closest("#search-box")) closeSearchCommands();
    if (!e.target.closest("#table-column-picker")) {
      const menu = document.getElementById("table-column-picker-menu");
      const button = document.getElementById("table-column-picker-button");
      state.tableColumnMenuOpen = false;
      if (menu) menu.hidden = true;
      button?.setAttribute("aria-expanded", "false");
    }
  });

  // The input element itself is never replaced, so there is no caret to
  // restore; the list simply redraws on the next frame.
  el["search-input"].oninput = (e) => {
    state.search = e.target.value;
    markDirty("grid", "filters");
    searchCommandIndex = 0;
    renderSearchCommands();
  };
  el["search-input"].onfocus = () => renderSearchCommands();
  el["search-input"].onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!searchCommands.length) return renderSearchCommands();
      const direction = e.key === "ArrowDown" ? 1 : -1;
      searchCommandIndex = (searchCommandIndex + direction + searchCommands.length) % searchCommands.length;
      renderSearchCommands();
    } else if (e.key === "Enter" && !el["search-menu"].hidden && searchCommands.length) {
      e.preventDefault();
      runSearchCommand(searchCommandIndex);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      closeSearchCommands();
      e.target.blur();
    }
  };
  el["search-menu"].onpointerdown = (e) => e.preventDefault();
  el["search-menu"].onclick = (e) => {
    const command = e.target.closest("[data-command]");
    if (command) runSearchCommand(Number(command.dataset.command));
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
    else appWindow.destroy();
  };

  el.grid.onclick = (e) => {
    if (tableResizeClickSuppressed || e.target.closest("[data-resize-column]")) return;
    const columnPicker = e.target.closest("#table-column-picker-button");
    if (columnPicker) {
      const menu = document.getElementById("table-column-picker-menu");
      state.tableColumnMenuOpen = !state.tableColumnMenuOpen;
      menu.hidden = !state.tableColumnMenuOpen;
      columnPicker.setAttribute("aria-expanded", String(!menu.hidden));
      return;
    }
    const tableSort = e.target.closest("[data-table-sort]");
    if (tableSort) {
      const key = tableSort.dataset.tableSort;
      if (state.tableSortKey === key) state.tableSortDirection *= -1;
      else {
        state.tableSortKey = key;
        state.tableSortDirection = 1;
      }
      savePrefs();
      return markDirty("grid");
    }
    const card = e.target.closest(".card,.project-row");
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
    const todo = e.target.closest("[data-todo-file]");
    if (todo) {
      return toggleTodoSource(todo.dataset.todoFile, Number(todo.dataset.todoLine));
    }
    const file = e.target.closest("[data-file]");
    if (file) {
      if (state.diffFile === file.dataset.file) return;
      state.diffFile = file.dataset.file;
      return renderDiffSelection();
    }
    const action = e.target.closest("[data-act]");
    if (!action) return;
    const p = selectedProject();
    if (!p) return;
    if (action.dataset.act === "close") return closeDetail();
    projectAction(action.dataset.act, p);
  };

  el["settings-host"].onclick = (e) => {
    const navItem = e.target.closest("[data-settings-section]");
    if (e.target.closest('[data-settings="close"]')) closeSettings();
    else if (navItem) showSettingsSection(navItem.dataset.settingsSection);
    else if (e.target.closest("#setting-reset")) armReset(e.target.closest("#setting-reset"));
    else if (e.target.closest("#setting-term-reset")) {
      window.devhqTermTheme.resetToPreset();
      syncTermThemeControls();
    }
  };
  // Colour inputs report every drag of the picker, so the terminals follow the
  // pointer live rather than waiting for the dialog to close.
  el["settings-host"].oninput = (e) => {
    if (e.target.dataset.termColor === undefined) return;
    const key = e.target.dataset.termColor;
    window.devhqTermTheme.setColor(key === "bg" || key === "fg" ? key : Number(key), e.target.value);
    syncTermThemeControls();
  };
  el["settings-host"].onchange = (e) => {
    if (e.target.id === "setting-language") {
      state.language = e.target.value;
      applyLanguage();
      savePrefs();
    } else if (e.target.id === "setting-theme") {
      state.theme = e.target.value === "light" ? "light" : "dark";
      applyTheme();
      savePrefs();
    } else if (e.target.id === "setting-compact-tech") {
      state.compactTechOverview = e.target.checked;
      savePrefs();
      markDirty("grid");
    } else if (e.target.id === "setting-terminal-shell") {
      window.devhqTerminalSettings.setDefault(e.target.value);
    } else if (e.target.id === "setting-term-theme") {
      if (e.target.value === "custom") return syncTermThemeControls();
      window.devhqTermTheme.usePreset(e.target.value);
      syncTermThemeControls();
    }
  };
}

// The mouse's back button leaves the detail view, the way it would leave a
// page. The webview would otherwise try to navigate its own history, which in
// a one-page app means nothing happens at all.
for (const type of ["mousedown", "mouseup", "auxclick"]) {
  document.addEventListener(type, (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    if (type === "mouseup" && e.button === 3) {
      if (state.settingsOpen) closeSettings();
      else if (state.selectedPath) closeDetail();
    }
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && changelogOpen()) {
    closeChangelog();
    el["status-version"].focus();
  } else if (e.key === "Escape" && (state.settingsOpen || state.selectedPath)) {
    if (state.settingsOpen) closeSettings();
    else closeDetail();
  } else if (e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r")) {
    e.preventDefault();
    rescan();
  } else if (e.ctrlKey && e.key === "`") {
    e.preventDefault();
    setDockOpen(!window.termsState.open);
  } else if (e.ctrlKey && ["f", "k"].includes(e.key.toLowerCase())) {
    e.preventDefault();
    el["search-input"]?.focus();
    el["search-input"]?.select();
    searchCommandIndex = 0;
    renderSearchCommands();
  }
});

/* ------------------------------------------------------------------ start */

(async function start() {
  loadPrefs();
  window.devhqTrackPageView?.("/overview");
  // The window is drawn and interactive before anything is asked of the disk.
  mountShell();
  loadAppVersion();
  window.devhqI18n?.init(state.language);
  markDirty("toolbar", "filters", "summary", "grid");

  // On the first run, scanning waits behind the language dialog. The shell is
  // already painted, but no disk work or stream can distract from the choice.
  await firstRunLanguage();

  listenScan().then(async () => {
    // Nothing scanned before: ask which folder to read rather than guessing
    // one, and start only once there is an answer.
    if (!state.roots.length) await firstRunFolders();
    if (state.roots.length) rescan();
  });
})();

window.devhqWork = { beginWork, updateWork, endWork };
/** The folder a terminal opened from nowhere in particular should start in. */
window.devhqPrimaryRoot = () => state.roots[0] || "";

window.addEventListener("beforeunload", () => {
  // This is DOM/localStorage-only and never delays native window destruction.
  if (!resetting) window.persistDockedTerminalState?.();
});
