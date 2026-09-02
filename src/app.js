// WinT - front end.
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
const emit = window.__TAURI__.event.emit;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const PREFS_KEY = "wint.prefs.v1";
/** Present only while a remembered destination is being restored. If the
 * renderer dies before it can clear this flag, the next launch ignores that
 * destination and opens the overview instead of repeating the crash forever. */
const STARTUP_RESTORE_KEY = "wint.startupRestore.v1";
let toolRecoveryTimer = 0;

/** Arm a dead-man switch before entering tool code. Exceptions can be caught,
 * but a synchronous loop blocks this renderer so completely that no handler
 * can run. In that case this marker survives and the next launch opens the
 * overview. A healthy renderer clears it after it has kept pumping events. */
function armToolRecovery(view, tool = "") {
  clearTimeout(toolRecoveryTimer);
  try {
    localStorage.setItem(STARTUP_RESTORE_KEY, JSON.stringify({ view, tool, startedAt: Date.now() }));
  } catch { /* storage disabled */ }
  toolRecoveryTimer = setTimeout(() => {
    try { localStorage.removeItem(STARTUP_RESTORE_KEY); } catch { /* storage disabled */ }
    toolRecoveryTimer = 0;
  }, 4000);
}
/** Last finished scan, kept so a restart within a few minutes can skip the disk. */
const SCAN_CACHE_KEY = "wint.scanCache.v1";
const SCAN_CACHE_TTL_MS = 5 * 60 * 1000;

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
  /** Whether anonymous usage counts may be sent, and whether the question has
   *  been put yet. Nothing is sent until it has been answered yes. */
  analytics: false,
  analyticsChosen: false,
  theme: "dark",
  compactTechOverview: true,
  /** Whether the optional title-bar control that hides WinT to the tray is visible. */
  minimizeToTrayButton: false,
  viewMode: "cards",
  tableSortKey: "project",
  tableSortDirection: 1,
  tableColumns: ["version", "lang", "runtime", "framework", "ui", "data", "status", "actions"],
  tableColumnMenuOpen: false,
  tableColumnWidths: {},
  settingsSection: "general",
  hotkeys: {},
  hotkeyGlobals: new Set(),
  hotkeyQuery: "",
  hotkeyFilter: "all",
  hotkeyRecording: null,
  activeView: "overview",
  /** Which shared util-tool is on screen when `activeView` is `"tools"`. */
  utilToolId: "any",
  /** Which native Windows tool is on screen in their shared host. */
  windowsToolId: "events",
  /** Tool whose body runs in a separate native child webview. */
  isolatedToolId: "",
  isolatedToolSession: "",
  portSearch: "",
  /** Which slice of the machine the explorer is listing: every listening
   *  socket, or every process whether it holds a port or not. */
  portTab: "listen",
  /** How the rows are ordered, across the whole list: by what they are costing
   *  right now. 1 is ascending, -1 descending. */
  portSortKey: "mem",
  portSortDirection: -1,
  ports: [],
  portsLoading: false,
  portsError: "",
  portToken: 0,
  /** The port row the detail pane is describing, keyed "<pid>:<port>". */
  portSelected: null,
  /** The ports kept on the shelf along the top. Pinned by port number, not by
   *  PID: the point of a pin is to still find :3000 after the server restarted
   *  under a new PID. */
  portPins: [],
  /** Project paths the user has starred. Remembered by path so a rescan keeps
   *  the same stars without needing anything from the scan itself. */
  favorites: new Set(),
  /** The tools pinned to the dock in the status bar, in the order they were
   *  pinned, by tool id. Empty by default: a tool is found by searching for
   *  it, and only earns a permanent seat once it has been pinned there. */
  toolPins: [],
  /** Tools and places opened recently, most recent first. An empty Ctrl+K
   *  list is these, plus Help. */
  toolRecent: [],
  /** Whether the "all pins" panel that opens upward from the dock is showing. */
  toolPinsOpen: false,
  /** Where the pins live: false keeps the handful of chips in the status bar,
   *  true gives them a shelf of their own above it with room to wrap. */
  pinsPanel: false,
  /** Tool ids currently open in their own window. Opening one from a pin
   *  focuses that window instead of remounting the tool in the main view. */
  toolPopouts: [],
  /** The kill confirmation: which row, and whether the whole tree goes. */
  portKill: null,
  portRestarting: 0,
  /** pid -> the rolling CPU and memory readings behind the sparklines. */
  portSamples: new Map(),
  portLive: true,
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
  /** SHA-256 of this running exe. Only filled for an official Store package;
   *  What's new then prints it on the current version. Dev builds stay empty. */
  appBuildChecksum: "",
};

window.wintPortsState = {
  exportState() { return { search:state.portSearch, tab:state.portTab, sortKey:state.portSortKey, sortDirection:state.portSortDirection, selected:state.portSelected, live:state.portLive }; },
  importState(saved) { if(!saved)return;state.portSearch=saved.search||"";state.portTab=saved.tab||state.portTab;state.portSortKey=saved.sortKey||state.portSortKey;state.portSortDirection=saved.sortDirection===1?1:-1;state.portSelected=saved.selected||null;state.portLive=saved.live!==false;markDirty("ports"); },
};

/* ------------------------------------------------------------- work log */

/** Everything currently in flight: key -> { label, detail }. */
const work = new Map();
let searchCommands = [];
let searchCommandIndex = 0;
let techMenuRows = [];
let techMenuIndex = 0;

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

/* ------------------------------------------------------- shared confirms */

const confirmQueue = [];
let confirmOpen = false;

/** A single app-native confirmation surface for destructive or interrupting
 * actions. Calls are queued so two features can never stack dialogs. */
function appConfirm(options = {}) {
  return new Promise((resolve) => {
    confirmQueue.push({
      title: options.title || "Are you sure?",
      message: options.message || "This action cannot be undone.",
      confirmLabel: options.confirmLabel || "Continue",
      cancelLabel: options.cancelLabel || "Cancel",
      alternateLabel: options.alternateLabel || "",
      iconName: options.icon || "warning",
      tone: options.tone === "danger" ? "danger" : "accent",
      resolve,
    });
    showNextConfirm();
  });
}

function showNextConfirm() {
  if (confirmOpen || !confirmQueue.length) return;
  confirmOpen = true;
  const request = confirmQueue.shift();
  const layer = document.createElement("div");
  layer.className = "confirm-layer";
  layer.innerHTML = `<section class="confirm-card" role="alertdialog" aria-modal="true"
    aria-labelledby="confirm-title" aria-describedby="confirm-message">
    <span class="confirm-icon ${request.tone}">${icon(request.iconName)}</span>
    <div class="confirm-copy"><h2 id="confirm-title">${esc(request.title)}</h2>
      <p id="confirm-message">${esc(request.message)}</p></div>
    <div class="confirm-actions"><button class="btn" type="button" data-confirm="cancel">${esc(request.cancelLabel)}</button>
      ${request.alternateLabel ? `<button class="btn" type="button" data-confirm="alternate">${esc(request.alternateLabel)}</button>` : ""}
      <button class="btn ${request.tone === "danger" ? "danger" : "primary"}" type="button" data-confirm="accept">${esc(request.confirmLabel)}</button></div>
  </section>`;
  document.body.appendChild(layer);
  let settled = false;
  const settle = (accepted) => {
    if (settled) return;
    settled = true;
    layer.remove();
    confirmOpen = false;
    request.resolve(accepted);
    showNextConfirm();
  };
  layer.querySelectorAll("[data-confirm]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.confirm;
      settle(action === "accept" ? true : action === "alternate" ? "alternate" : false);
    });
  });
  layer.addEventListener("click", (event) => {
    if (event.target === layer) settle(false);
  });
  layer.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      const buttons = [...layer.querySelectorAll("button")];
      const edge = event.shiftKey ? buttons[0] : buttons[buttons.length - 1];
      if (document.activeElement === edge) {
        event.preventDefault();
        (event.shiftKey ? buttons[buttons.length - 1] : buttons[0])?.focus();
      }
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation(); settle(false);
  });
  requestAnimationFrame(() => layer.querySelector('[data-confirm="cancel"]')?.focus());
}

window.wintConfirm = appConfirm;

/** Shows a label for as long as `promise` runs, whatever the outcome. */
function trackWork(key, label, promise) {
  beginWork(key, label);
  return promise.finally(() => endWork(key));
}

// A popped-out terminal can change the scheme too; if the settings page is
// open here, its controls have to follow.
window.wintOnTermThemeChanged = () => {
  if (state.activeView === "settings") syncTermThemeControls();
};

window.addEventListener("wint:time-tracker-always-changed", (event) => {
  const control = el["settings-host"]?.querySelector("#setting-time-tracker");
  if (control) control.checked = event.detail?.enabled === true;
});

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
    if (typeof p.minimizeToTrayButton === "boolean") state.minimizeToTrayButton = p.minimizeToTrayButton;
    if (typeof p.analytics === "boolean") {
      state.analytics = p.analytics;
      state.analyticsChosen = true;
    }
    applyAnalytics();
    if (["dark", "light"].includes(p.theme)) state.theme = p.theme;
    if (["cards", "table"].includes(p.viewMode)) state.viewMode = p.viewMode;
    if (typeof p.tableSortKey === "string") state.tableSortKey = p.tableSortKey;
    if (p.tableSortDirection === -1) state.tableSortDirection = -1;
    if (Array.isArray(p.tableColumns)) state.tableColumns = p.tableColumns.filter((column) => typeof column === "string");
    if (p.tableColumnWidths && typeof p.tableColumnWidths === "object") {
      state.tableColumnWidths = Object.fromEntries(Object.entries(p.tableColumnWidths)
        .filter(([, width]) => Number.isFinite(width) && width >= 70 && width <= 800));
    }
    if (["listen", "all"].includes(p.portTab)) state.portTab = p.portTab;
    if (["cpu", "mem"].includes(p.portSortKey)) state.portSortKey = p.portSortKey;
    if (p.portSortDirection === 1) state.portSortDirection = 1;
    if (Array.isArray(p.portPins)) state.portPins = p.portPins.filter((port) => Number.isInteger(port)).slice(0, 12);
    if (Array.isArray(p.favorites)) {
      state.favorites = new Set(p.favorites.filter((path) => typeof path === "string" && path));
    }
    // A pin for a tool this build no longer has is dropped rather than left in
    // the bar as a chip that leads nowhere.
    if (typeof p.pinsPanel === "boolean") state.pinsPanel = p.pinsPanel;
    if (Array.isArray(p.toolPins)) {
      state.toolPins = p.toolPins.filter((id) => TOOLS.some((tool) => tool.id === id));
    }
    if (Array.isArray(p.toolPopouts)) {
      state.toolPopouts = p.toolPopouts.filter((id) => TOOLS.some((tool) => tool.id === id));
    }
    if (Array.isArray(p.toolRecent)) {
      state.toolRecent = p.toolRecent
        .filter((id) => typeof id === "string" && (TOOLS.some((tool) => tool.id === id) || PLACES.some((place) => place.id === id)))
        .slice(0, TOOL_RECENT_MAX);
    }
    // Restore the last main destination only when it still exists in this
    // build. Shared tool hosts also need their concrete child id; otherwise a
    // removed tool falls back to that host's stable default.
    if (MAIN_VIEWS.includes(p.activeView)) state.activeView = p.activeView;
    if (typeof p.utilToolId === "string" && window.wintUtilTools?.byId?.(p.utilToolId)) {
      state.utilToolId = p.utilToolId;
    }
    if (typeof p.windowsToolId === "string" && window.wintWindowsTools?.catalog?.().some((tool) => tool.id === p.windowsToolId)) {
      state.windowsToolId = p.windowsToolId;
    }
    if (typeof p.isolatedToolId === "string" && TOOLS.some((tool) => tool.id === p.isolatedToolId)) {
      state.isolatedToolId = p.isolatedToolId;
    }
    if (p.hotkeys && typeof p.hotkeys === "object" && !Array.isArray(p.hotkeys)) {
      state.hotkeys = Object.fromEntries(Object.entries(p.hotkeys)
        .filter(([id, binding]) => typeof id === "string" && typeof binding === "string"));
    }
    if (Array.isArray(p.hotkeyGlobals)) state.hotkeyGlobals = new Set(p.hotkeyGlobals.filter((id) => typeof id === "string"));
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
        ...(state.analyticsChosen ? { analytics: state.analytics } : {}),
        theme: state.theme,
        compactTechOverview: state.compactTechOverview,
        minimizeToTrayButton: state.minimizeToTrayButton,
        viewMode: state.viewMode,
        tableSortKey: state.tableSortKey,
        tableSortDirection: state.tableSortDirection,
        tableColumns: state.tableColumns,
        tableColumnWidths: state.tableColumnWidths,
        portTab: state.portTab,
        portSortKey: state.portSortKey,
        portSortDirection: state.portSortDirection,
        portPins: state.portPins,
        favorites: [...state.favorites],
        toolPins: state.toolPins,
        pinsPanel: state.pinsPanel,
        toolPopouts: state.toolPopouts,
        toolRecent: state.toolRecent,
        activeView: state.activeView,
        utilToolId: state.utilToolId,
        windowsToolId: state.windowsToolId,
        isolatedToolId: state.isolatedToolId,
        hotkeys: state.hotkeys,
        hotkeyGlobals: [...state.hotkeyGlobals],
      })
    );
  } catch {
    /* storage disabled - prefs simply do not persist */
  }
}

/** Hands the answer to the tracker, which sends nothing until it has one. */
function applyAnalytics() {
  window.wintAnalyticsConsent?.(state.analyticsChosen && state.analytics);
}

function applyLanguage() {
  document.documentElement.lang = state.language === "system"
    ? (navigator.language || "en")
    : state.language;
  window.wintI18n?.setLanguage(state.language);
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  // Isolated tools are separate native WebViews. Re-running the generic host
  // sync updates both their document theme and their opaque native surface.
  if (state.activeView === "isolated-tool" && state.isolatedToolId) queueMicrotask(syncEmbeddedTool);
  // The title bar toggle and the General row are two ways to the same
  // setting, so whichever was used, the other has to show the result.
  for (const choice of el["settings-host"]?.querySelectorAll("[data-setting-theme]") || []) {
    const active = choice.dataset.settingTheme === state.theme;
    choice.classList.toggle("on", active);
    choice.setAttribute("aria-pressed", String(active));
  }
  const button = document.getElementById("toggle-theme");
  if (!button) return;
  const light = state.theme === "light";
  button.classList.toggle("on", light);
  button.setAttribute("aria-pressed", String(light));
  button.title = light ? "Use dark mode" : "Use light mode";
  button.setAttribute("aria-label", button.title);
  window.wintI18n?.refresh(button);
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
    <img src="wint-icon.png" alt="" />
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
      await window.wintI18n?.setLanguage(language);
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
    <img src="wint-icon.png" alt="" />
    <h1 id="folder-title">Which folder holds your projects?</h1>
    <p>WinT reads every project inside the folder you choose. Type the path or browse for it - you can add more folders now, or change them later.</p>
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

/** The file that builds the request and puts it on the wire - the one that
 *  answers "what leaves my machine". Offered in the question itself, because
 *  "anonymous" is worth more when it can be read. Its own comment points at
 *  `src/analytics.js`, which is the half that decides when to send at all. */
const ANALYTICS_SOURCE_URL = "https://github.com/nbgyxi/devhq/blob/main/src-tauri/src/analytics.rs";

/** The last thing a new install asks: whether it may say hello. Asked once, in
 *  the same dialog shape as the questions before it, and answerable either way
 *  without explaining yourself. The answer is remembered and can be changed in
 *  Settings afterwards. */
function firstRunUsageData() {
  if (state.analyticsChosen) return Promise.resolve();
  const overlay = document.createElement("div");
  overlay.className = "language-first-run";
  overlay.innerHTML = `<section class="language-dialog" role="dialog" aria-modal="true"
      aria-labelledby="usage-title">
    <img src="wint-icon.png" alt="" />
    <h1 id="usage-title">We would love to know someone new is using WinT</h1>
    <p>May we send that to PageRain Analytics? It is completely anonymous - a random number and the name of the screen you opened, nothing else. Never a project, never a folder, never your code. The few lines that do it are open source, so you can read exactly what leaves your machine.</p>
    <p class="usage-source"><button class="linklike" type="button" data-usage="source">Read the code that sends it</button></p>
    <div class="language-choices">
      <button class="language-choice primary" data-usage="yes">${icon("waving_hand")}
        <span><strong>Yes, say hello</strong><small>Send anonymous usage counts</small></span></button>
      <button class="language-choice" data-usage="no">${icon("close")}
        <span><strong>No thanks</strong><small>Send nothing at all</small></span></button>
    </div>
  </section>`;
  document.body.appendChild(overlay);
  overlay.querySelector('[data-usage="yes"]').focus();
  return new Promise((resolve) => {
    overlay.onclick = (e) => {
      const button = e.target.closest("[data-usage]");
      if (!button) return;
      // Reading the code is not an answer: the question stays up behind it.
      if (button.dataset.usage === "source") return openUrl(ANALYTICS_SOURCE_URL);
      state.analytics = button.dataset.usage === "yes";
      state.analyticsChosen = true;
      savePrefs();
      applyAnalytics();
      // Counted from here rather than at startup: the screen behind the
      // question is the first one this install has actually shown.
      window.wintTrackPageView?.(currentPath());
      overlay.remove();
      resolve();
    };
  });
}

/** Opens a link in the user's browser. A plain anchor would navigate the app's
 *  own window away from itself, so it goes out through the opener plugin. */
function openUrl(url) {
  trackWork("open:url", "Opening your browser", invoke("plugin:opener|open_url", { url }))
    .catch(() => {});
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
  { id: "assistant", label: "Assistant", icon: "auto_awesome" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "hotkeys", label: "Hotkeys", icon: "keyboard" },
];

/* The icon font has no glyph for `terminal`: it comes out as the browser's
 * missing-character box, which is invisible on the dark theme and a black
 * square on the light one. That one icon is therefore drawn by hand, in
 * currentColor, so it sizes and colours exactly like the font ones. */
const INLINE_ICONS = {
  terminal: `<svg class="ms ms-svg" viewBox="0 0 24 24" aria-hidden="true"
    style="width:1em;height:1em;fill:none;stroke:currentColor;vertical-align:-.14em"
    stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2.6" y="4.4" width="18.8" height="15.2" rx="2.6" style="fill:none;stroke:currentColor" />
    <path d="m6.9 9.4 2.9 2.6-2.9 2.6" style="fill:none;stroke:currentColor" />
    <path d="M12.9 15h4.2" style="fill:none;stroke:currentColor" />
  </svg>`,
  // Drawn by hand for the same reason, rather than trusting a second ligature.
  download: `<svg class="ms ms-svg" viewBox="0 0 24 24" aria-hidden="true"
    style="width:1em;height:1em;fill:none;stroke:currentColor;vertical-align:-.14em"
    stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3.6v10.2" style="fill:none;stroke:currentColor" />
    <path d="m7.6 9.6 4.4 4.4 4.4-4.4" style="fill:none;stroke:currentColor" />
    <path d="M4.4 17.2v1.4a1.8 1.8 0 0 0 1.8 1.8h11.6a1.8 1.8 0 0 0 1.8-1.8v-1.4" style="fill:none;stroke:currentColor" />
  </svg>`,
};

function icon(name) {
  return INLINE_ICONS[name] || `<span class="ms" aria-hidden="true">${name}</span>`;
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
const DEMO_MODE = false;

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
  favorite: { label: "Favorites", test: (p) => state.favorites.has(p.path) },
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

/** Keep the folder editor inside the window. Anchored under the chip with
 *  fixed coordinates so a mid-row chip cannot hang the browse button off the
 *  right edge (and so no ancestor overflow can clip it). */
function placeRootPop() {
  const pop = el["roots-pop"];
  const btn = el["roots-btn"];
  if (!pop || !btn || pop.hidden) return;
  const pad = 12;
  const gap = 8;
  const btnRect = btn.getBoundingClientRect();
  pop.style.position = "fixed";
  pop.style.top = `${Math.round(btnRect.bottom + gap)}px`;
  pop.style.left = "0px";
  pop.style.right = "auto";
  const popWidth = pop.getBoundingClientRect().width || 420;
  let left = btnRect.left;
  left = Math.min(left, window.innerWidth - pad - popWidth);
  left = Math.max(pad, left);
  pop.style.left = `${Math.round(left)}px`;
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
  placeRootPop();
  requestAnimationFrame(placeRootPop);
  el["roots-list"].querySelector("input")?.focus();
}

function closeRootEditor() {
  if (!rootEditorOpen()) return;
  el["roots-pop"].hidden = true;
  el["roots-btn"].classList.remove("on");
  const pop = el["roots-pop"];
  pop.style.position = "";
  pop.style.top = "";
  pop.style.left = "";
  pop.style.right = "";
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
    // A finished scan (not stopped mid-way) is what a quick restart can reuse.
    if (!p.cancelled) saveScanCache();
    syncGlobalHotkeys();
  });

  return Promise.all(registered);
}

/** Roots match when the same folders are listed in the same order. */
function sameScanRoots(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((root, index) => String(root).toLowerCase() === String(b[index]).toLowerCase());
}

/** Drop live process fields — they go stale the moment the window closes. */
function projectForCache(project) {
  return {
    name: project.name,
    path: project.path,
    group: project.group,
    description: project.description || "",
    version: project.version || "",
    packageManager: project.packageManager || "",
    scripts: Array.isArray(project.scripts) ? project.scripts : [],
    depCount: project.depCount || 0,
    devDepCount: project.devDepCount || 0,
    flags: Array.isArray(project.flags) ? project.flags : [],
    tech: Array.isArray(project.tech) ? project.tech : [],
    git: project.git || null,
    runCmd: project.runCmd || "",
    touchedMs: project.touchedMs || 0,
    running: [],
    ports: [],
  };
}

/** Remember the finished list so the next open can skip a full scan. */
function saveScanCache() {
  if (resetting) return;
  const projects = state.projects.filter((project) => !project.pending && !project.stopped);
  // An interrupted list is not worth keeping; leave whatever was saved before.
  if (state.projects.some((project) => project.pending || project.stopped)) return;
  try {
    localStorage.setItem(
      SCAN_CACHE_KEY,
      JSON.stringify({
        roots: [...state.roots],
        scannedAt: state.scannedAt,
        durationMs: state.durationMs,
        completedAt: Date.now(),
        projects: projects.map(projectForCache),
      })
    );
  } catch {
    /* quota or storage disabled - next launch simply rescans */
  }
}

/** A cache that is still warm and matches the folders we would scan. */
function loadScanCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(SCAN_CACHE_KEY) || "null");
    if (!cache || !Array.isArray(cache.projects) || !Array.isArray(cache.roots)) return null;
    if (!sameScanRoots(cache.roots, state.roots)) return null;
    const completedAt = Number(cache.completedAt) || Number(cache.scannedAt) || 0;
    if (!completedAt) return null;
    const age = Date.now() - completedAt;
    if (age < 0 || age > SCAN_CACHE_TTL_MS) return null;
    return cache;
  } catch {
    return null;
  }
}

/** Put the remembered list on screen without touching the disk. */
function restoreScanCache(cache) {
  state.error = "";
  state.scanning = false;
  state.scannedAt = cache.scannedAt || cache.completedAt;
  state.durationMs = cache.durationMs || 0;
  state.total = cache.projects.length;
  state.settled = cache.projects.length;
  state.projects = cache.projects.map((project) => ({
    ...projectForCache(project),
    name: demoName(project.name),
    group: demoGroup(project.group),
    pending: false,
  }));
  state.byPath = new Map(state.projects.map((project) => [project.path, project]));
  const when = new Date(cache.completedAt || cache.scannedAt).toLocaleTimeString();
  beginWork("scan-cache", "Restored last scan", `from ${when}`);
  setTimeout(() => endWork("scan-cache"), 2200);
  markDirty("toolbar", "grid", "summary", "filters", "banner", "detail", "activity");
  syncGlobalHotkeys();
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
  if (state.activeView === "git") syncGitRepositories();
  touchCard(project);
  if (project.path !== state.selectedPath) return;
  // The view can be opened on a folder still being read, which does not yet
  // know it is a repository. Once it does, fetch the patch it could not ask
  // for at the time.
  if (project.git && !state.diff && !state.diffError && !work.has("diff")) loadDiff(project);
  markDirty("detail");
}

/* --------------------------------------------------------------- actions */

/** `git pull` in a project's folder.
 *
 *  The work is named in the status bar while it runs and git's own answer is
 *  left there when it lands, because a pull that says nothing is a pull the
 *  user has to go and check by hand. The backend re-reads the project in the
 *  same call, so the card stops claiming it is behind without a whole rescan. */
function pullProject(project) {
  const key = `pull:${project.path}`;
  // Two pulls of one folder at once would race each other's index lock.
  if (work.has(key)) return;
  trackWork(key, `Pulling ${project.name}`, invoke("git_pull", { path: project.path, group: project.group }))
    .then((result) => {
      if (result.project) {
        const previous = state.byPath.get(result.project.path);
        // Running processes are the process sweep's business, not a pull's.
        result.project.running = previous ? previous.running : [];
        result.project.ports = previous ? previous.ports : [];
        replaceProject(result.project, previous);
        markDirty("summary", "filters", "grid");
        // The patch on screen is about the tree as it was before the pull.
        if (state.selectedPath === result.project.path) {
          state.diff = null;
          state.diffError = "";
          state.diffFiles = new Map();
          state.diffFile = null;
          loadDiff(result.project);
        }
      }
      if (!result.ok) {
        state.error = `${project.name}: ${result.summary}`;
        markDirty("banner");
      }
      // Whatever git said stays on the bar long enough to be read.
      beginWork(`${key}:said`, `${project.name}: ${result.summary}`);
      setTimeout(() => endWork(`${key}:said`), 3500);
    })
    .catch((err) => {
      state.error = `${project.name}: ${String(err)}`;
      markDirty("banner");
    });
}

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
  if (state.activeView === "settings") switchMainView("overview");
  state.selectedPath = project.path;
  window.wintTrackPageView?.("/project");
  clearDetailData();
  markDirty("detail");
  if (project.git) loadDiff(project);
  loadTodos(project);
}

function closeDetail(nextPath = "/overview") {
  state.selectedPath = null;
  window.wintTrackPageView?.(nextPath);
  clearDetailData();
  markDirty("detail");
}

function openSettings() {
  if (state.activeView === "settings") return closeSettings();
  if (state.selectedPath) closeDetail("/settings");
  switchMainView("settings");
}

function closeSettings() {
  if (state.activeView === "settings") switchMainView("overview");
}

/* --------------------------------------------------------------- ports */

/** Everything the main area can be showing. The overview is the one that is
 *  always there; the rest are tools, each with a host of its own that
 *  `syncMainView` shows and hides. */
const MAIN_VIEWS = ["overview", "ports", "dns", "hosts", "network", "path-ping", "disk-space", "github", "git", "tools", "windows-tools", "isolated-tool", "settings"];

function switchMainView(view) {
  if (!MAIN_VIEWS.includes(view)) return;
  // Re-opening the current destination must repair visibility as well. This
  // matters when a tool's first mount failed or a cached stylesheet left its
  // host hidden: the next click should recover without requiring a restart.
  if (state.activeView === view) {
    syncMainView();
    if (view === "github") window.wintGithub?.opened();
    if (view === "git") { syncGitRepositories(); window.wintGit?.opened(); }
    return;
  }
  // Isolated tools never get a vote on shell navigation. The entire point of
  // this boundary is that Back/Home/Close still work when their renderer does not.
  if (state.activeView === "disk-space") {
    const permission = window.wintDiskSpace?.confirmLeave?.();
    if (permission && typeof permission.then === "function") {
      permission.then((leave) => { if (leave) switchMainView(view); });
      return;
    }
    if (permission === false) return;
  }
  state.activeView = view;
  savePrefs();
  state.selectedPath = null;
  clearDetailData();
  syncSettingsButton();
  syncMainView();
  window.wintTrackPageView?.(
    view === "tools" ? `/tools/${state.utilToolId}` : `/${view}`
  );
  if (view === "ports" && !state.ports.length) loadPorts();
  if (view === "dns") window.wintDns?.opened();
  if (view === "hosts") window.wintHosts?.opened();
  if (view === "network") window.wintNetwork?.opened();
  if (view === "path-ping") window.wintPathPing?.opened();
  if (view === "disk-space") window.wintDiskSpace?.opened();
  if (view === "github") window.wintGithub?.opened();
  if (view === "git") { syncGitRepositories(); window.wintGit?.opened(); }
  if (view === "tools") window.wintUtilTools?.opened();
  if (view === "windows-tools") window.wintWindowsTools?.opened();
}

function syncGitRepositories() {
  window.wintGit?.setRepositories(state.projects.filter((p) => !p.pending && p.git).map((p) => ({
    name: p.name, path: p.path, branch: p.git.branch, dirty: p.git.dirty,
    changed: p.git.changedTotal || p.git.changed?.length || 0,
    ahead: p.git.ahead, behind: p.git.behind,
  })));
}

/** Open one of the shared util tools. They all share `#tools-host`; only the
 *  catalog id changes, so switching Base64 → JWT does not rebuild the page. */
function openUtilTool(id) {
  const entry = window.wintUtilTools?.byId?.(id);
  if (!entry) return;
  const same = state.activeView === "tools" && state.utilToolId === id;
  state.utilToolId = id;
  savePrefs();
  rememberToolUse(id);
  window.wintUtilTools?.open(id);
  if (state.activeView !== "tools") {
    switchMainView("tools");
    return;
  }
  if (same) return;
  window.wintTrackPageView?.(`/tools/${id}`);
  markDirty("tools", "toolbar", "pins");
}

function openWindowsTool(id) {
  const entry = window.wintWindowsTools?.catalog?.().find((tool) => tool.id === id);
  if (!entry) return;
  if (state.activeView === "windows-tools" && state.windowsToolId === "time-tracker" && id !== "time-tracker") {
    const permission = window.wintTimeTracker?.confirmLeave?.();
    if (permission && typeof permission.then === "function") {
      permission.then((leave) => { if (leave) openWindowsTool(id); });
      return;
    }
    if (permission === false) return;
  }
  const same = state.activeView === "windows-tools" && state.windowsToolId === id;
  state.windowsToolId = id;
  savePrefs();
  rememberToolUse(id);
  // The tracker is the first tool hosted in a native child webview. Do not run
  // its open/render path in the shell renderer as well.
  if (id !== "time-tracker") window.wintWindowsTools?.open(id);
  if (state.activeView !== "windows-tools") return switchMainView("windows-tools");
  if (!same) window.wintTrackPageView?.(`/tools/${id}`);
  syncEmbeddedTool();
  markDirty("toolbar", "pins");
}

let embeddedToolOpening = false;
let embeddedToolResyncPending = false;
let embeddedToolMountedId = "";

const EMBEDDED_TOOL_WORK = "isolated-tool-open";
// The tool that has already reported itself drawn. `ready` can land before the
// invoke that created the webview has resolved, and without this a resize in
// that gap would put the loading screen back over a tool that is already up.
let embeddedToolReadyId = "";

/* ---------- tools that stay alive after you navigate away ----------
 * Leaving a tool used to destroy its webview, so coming back rebuilt it from
 * nothing. Now the last few are only hidden, and returning to one is a show,
 * not a cold start.
 *
 * Only the eight tools with a webview of their own can occupy a slot. The
 * utilities and Windows tools are not candidates and do not need to be: they
 * render into the main window's own DOM, so their code is loaded once and
 * switching between them was never a reload.
 *
 * Three, not more. What is kept alive is not a DOM tree - each of these tools
 * has its own WebView2 data directory, so it has its own browser process tree
 * and costs tens of megabytes, not the little a cached tab would. People move
 * between two or three tools, so past three the slots are paid for every
 * minute and hit rarely. The current tool holds one, making this two warm
 * spares. Raising it is this one number.
 */
const EMBEDDED_TOOL_RESIDENT_MAX = 3;

/** Live webviews, least recently used first. */
const embeddedToolResident = [];
/** Which resident tools currently believe they are visible. */
const embeddedToolAwakeIds = new Set();

/** id -> the session its live webview was built with. The session is baked
 *  into the webview's URL and its bridge filters on it, so it has to survive
 *  for as long as that webview does - it can no longer be rolled per visit. */
const embeddedToolSessions = new Map();

function sessionForTool(id) {
  let session = embeddedToolSessions.get(id);
  if (!session) {
    session = Array.from(
      crypto.getRandomValues(new Uint8Array(18)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    embeddedToolSessions.set(id, session);
  }
  return session;
}

/** Which resident tool a bridge message came from. With more than one tool
 *  alive, the current tool's session is no longer the only valid one. */
function toolForSession(session) {
  if (!session) return "";
  for (const [id, value] of embeddedToolSessions) if (value === session) return id;
  return "";
}

function touchResidentTool(id) {
  const at = embeddedToolResident.indexOf(id);
  if (at >= 0) embeddedToolResident.splice(at, 1);
  embeddedToolResident.push(id);
}

/** Tell a hidden tool to stop working, or a shown one to pick up again.
 *  Residency must not mean a tool polls forever behind your back: destroying
 *  the webview used to stop its timers for free, and this replaces that. */
function setEmbeddedToolAwake(id, awake) {
  const session = embeddedToolSessions.get(id);
  if (!session) return;
  // Edge-triggered. syncEmbeddedTool runs on every resize frame, and this must
  // not turn each of those into an event across the process boundary.
  if (embeddedToolAwakeIds.has(id) === awake) return;
  if (awake) embeddedToolAwakeIds.add(id);
  else embeddedToolAwakeIds.delete(id);
  emit("tool:bridge-command", {
    session,
    commandId: `${session}:awake:${Date.now()}`,
    action: awake ? "resume" : "suspend",
  }).catch(() => {});
}

/** Drop a tool out of memory for good, and forget its session with it. */
async function evictEmbeddedTool(id) {
  const at = embeddedToolResident.indexOf(id);
  if (at >= 0) embeddedToolResident.splice(at, 1);
  embeddedToolAwakeIds.delete(id);
  embeddedToolSessions.delete(id);
  if (embeddedToolMountedId === id) embeddedToolMountedId = "";
  if (embeddedToolReadyId === id) embeddedToolReadyId = "";
  await invoke("tool_embedded_destroy", { id }).catch(() => {});
}

/** Evict from the least recently used end until the budget is met. */
async function trimResidentTools(keepId) {
  while (embeddedToolResident.length > EMBEDDED_TOOL_RESIDENT_MAX) {
    const oldest = embeddedToolResident.find((id) => id !== keepId);
    if (!oldest) break;
    await evictEmbeddedTool(oldest);
  }
}

/** The named, shimmering stand-in that fills the slot from the click until the
 *  tool has drawn itself. The child webview is a native sibling layered over
 *  this slot, so this covers the part of the wait the webview cannot: the
 *  hundreds of milliseconds Rust spends creating it, before it exists to paint
 *  anything of its own. Its own copy of this screen takes over from there. */
function showEmbeddedToolLoading(tool, phase) {
  const panel = document.getElementById("isolated-tool-loading");
  if (!panel) return;
  panel.classList.remove("failed");
  panel.querySelector("[data-loading-name]").textContent = tool?.name || "This tool";
  panel.querySelector("[data-loading-phase]").textContent = phase;
  panel.hidden = false;
}

function hideEmbeddedToolLoading() {
  const panel = document.getElementById("isolated-tool-loading");
  if (panel) panel.hidden = true;
}

function failEmbeddedToolLoading(tool, message) {
  const panel = document.getElementById("isolated-tool-loading");
  if (!panel) return;
  panel.classList.add("failed");
  panel.querySelector(".tool-loading-ring")?.remove();
  panel.querySelector(".tool-loading-body")?.remove();
  panel.querySelector("[data-loading-phase]").textContent = message;
  panel.hidden = false;
}

/** Keep the isolated tracker exactly over the ordinary Windows-tools host.
 * Its child webview is a native sibling of the shell webview, not an iframe,
 * so a blocked tracker event loop cannot prevent the shell from responding. */
function syncEmbeddedTool() {
  const id = state.isolatedToolId;
  const isolated = state.activeView === "isolated-tool" && Boolean(id);
  // One session per live webview, reused for as long as that webview lives.
  if (isolated) state.isolatedToolSession = sessionForTool(id);
  const host = el["isolated-tool-slot"];
  if (!isolated || !host || host.hidden) {
    hideEmbeddedToolLoading();
    endWork(EMBEDDED_TOOL_WORK);
    embeddedToolReadyId = "";
    if (embeddedToolOpening) {
      embeddedToolResyncPending = true;
      return;
    }
    const mountedId = embeddedToolMountedId || id;
    if (mountedId) {
      embeddedToolMountedId = "";
      embeddedToolOpening = true;
      // Hidden, not destroyed: this is what makes coming back a show rather
      // than a rebuild. Put it to sleep first so it stops working while away.
      setEmbeddedToolAwake(mountedId, false);
      invoke("tool_embedded_hide", { id: mountedId }).catch(() => {}).finally(() => {
        embeddedToolOpening = false;
        if (embeddedToolResyncPending) {
          embeddedToolResyncPending = false;
          syncEmbeddedTool();
        }
      });
    }
    return;
  }
  if (embeddedToolOpening) {
    embeddedToolResyncPending = true;
    return;
  }
  const tool = toolById(id);
  if (embeddedToolReadyId && embeddedToolReadyId !== id) embeddedToolReadyId = "";
  if (embeddedToolMountedId !== id && embeddedToolReadyId !== id) {
    showEmbeddedToolLoading(tool, `Opening ${tool?.name || id}…`);
    beginWork(EMBEDDED_TOOL_WORK, `Opening ${tool?.name || id}`);
  }
  requestAnimationFrame(async () => {
    const rect = host.getBoundingClientRect();
    if (state.activeView !== "isolated-tool" || state.isolatedToolId !== id) return;
    if (embeddedToolOpening) return;
    embeddedToolOpening = true;
    try {
      // WebView2 creation and destruction both touch the native window tree.
      // Never overlap them: switching tools used to race a close for the old
      // environment against creation of the next one and could freeze the
      // entire main window. Hiding touches the same tree, so it waits here too.
      if (embeddedToolMountedId && embeddedToolMountedId !== id) {
        const mountedId = embeddedToolMountedId;
        embeddedToolMountedId = "";
        setEmbeddedToolAwake(mountedId, false);
        await invoke("tool_embedded_hide", { id: mountedId });
      }
      const resident = embeddedToolResident.includes(id);
      await invoke("tool_embedded_show", {
        id,
        // Carried into the page's URL so its own first paint can name it.
        name: tool?.name || id,
        session: sessionForTool(id),
        theme: state.theme === "light" ? "light" : "dark",
        pinned: isToolPinned(id),
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
      // A webview that was just built boots awake. Record that before anything
      // tries to put it to sleep, or the first suspend is swallowed as a no-op
      // and the tool polls on in the background.
      if (!resident) embeddedToolAwakeIds.add(id);
      // Navigation may have happened while Rust was creating WebView2.
      if (state.activeView !== "isolated-tool" || state.isolatedToolId !== id) {
        setEmbeddedToolAwake(id, false);
        await invoke("tool_embedded_hide", { id }).catch(() => {});
      } else {
        embeddedToolMountedId = id;
      }
      touchResidentTool(id);
      if (resident && embeddedToolMountedId === id) {
        // It was still alive, so nothing reloaded and nothing will report
        // ready. Wake it and clear the stand-in ourselves.
        setEmbeddedToolAwake(id, true);
        embeddedToolReadyId = id;
        endWork(EMBEDDED_TOOL_WORK);
        hideEmbeddedToolLoading();
      }
      await trimResidentTools(id);
    } catch (error) {
      // Stay on the tool and say why it did not open. Bouncing back to the
      // overview used to throw the reason away along with the view.
      const label = tool?.name || id;
      console.error(`Could not show the isolated ${label}`, error);
      endWork(EMBEDDED_TOOL_WORK);
      failEmbeddedToolLoading(tool, `${label} could not open. ${String(error)}`);
      beginWork("isolated-tool-fail", `${label} could not open`, String(error));
      setTimeout(() => endWork("isolated-tool-fail"), 8000);
    } finally {
      embeddedToolOpening = false;
      if (embeddedToolResyncPending) {
        embeddedToolResyncPending = false;
        syncEmbeddedTool();
      }
    }
  });
}

// A narrower window wraps the shelf onto another row: what is under it has to
// be told, and a resize is the one time nothing else re-renders the pins.
window.addEventListener("resize", () => {
  measurePinsPanel();
  if (rootEditorOpen()) placeRootPop();
  syncEmbeddedTool();
});

window.addEventListener("wint:open-tool", (event) => {
  const id = event.detail?.id;
  if (id) {
    openTool(id);
    if (event.detail?.input) window.wintUtilTools?.setInput?.(id, event.detail.input);
  }
});

window.addEventListener("wint:git-close", () => switchMainView("overview"));
function projectForGithubRepo(repo) {
  const wanted = String(repo || "").replace(/\/?\.git\/?$/i, "").toLowerCase();
  return state.projects.find((project) => {
    const remote = String(project.git?.remote || "").trim().replace(/\\/g, "/").replace(/\/?\.git\/?$/i, "").toLowerCase();
    return wanted && (remote.endsWith(`github.com/${wanted}`) || remote.endsWith(`github.com:${wanted}`));
  });
}

window.addEventListener("wint:open-git-repo", (event) => {
  const local = projectForGithubRepo(event.detail?.repo);
  if (local) projectAction("git", local);
});
window.addEventListener("wint:open-github-project", (event) => {
  const local = projectForGithubRepo(event.detail?.repo);
  if (!local) return;
  switchMainView("overview");
  openDetail(local);
});

function syncMainView() {
  if (!el["ports-host"]) return;
  const ports = state.activeView === "ports";
  const overview = state.activeView === "overview";
  document.documentElement.classList.toggle("github-active", state.activeView === "github");
  document.documentElement.classList.toggle("git-active", state.activeView === "git");
  for (const id of ["summary", "filters", "banner-host", "scroll"]) el[id].hidden = !overview;
  el["ports-host"].hidden = !ports;
  el["dns-host"].hidden = state.activeView !== "dns";
  el["hosts-host"].hidden = state.activeView !== "hosts";
  if (el["network-host"]) el["network-host"].hidden = state.activeView !== "network";
  if (el["path-ping-host"]) el["path-ping-host"].hidden = state.activeView !== "path-ping";
  if (el["disk-space-host"]) el["disk-space-host"].hidden = state.activeView !== "disk-space";
  if (el["github-host"]) el["github-host"].hidden = state.activeView !== "github";
  if (el["git-host"]) el["git-host"].hidden = state.activeView !== "git";
  if (el["tools-host"]) el["tools-host"].hidden = state.activeView !== "tools";
  if (el["windows-tools-host"]) el["windows-tools-host"].hidden = state.activeView !== "windows-tools";
  if (el["isolated-tool-host"]) el["isolated-tool-host"].hidden = state.activeView !== "isolated-tool";
  if (el["settings-host"]) el["settings-host"].hidden = state.activeView !== "settings";
  syncEmbeddedTool();
  el["search-input"].value = state.search;
  if (el["port-filter-input"]) el["port-filter-input"].value = state.portSearch;
  el["search-input"].placeholder = "Search projects, tools and commands...";
  closeSearchCommands();
  // The sampler only runs while the explorer is on screen - nothing else reads
  // it, and it is the one thing in the app that ticks on its own.
  setPortsLive(ports && state.portLive);
  // The dock says which tool is on screen, and offers to keep an unpinned one.
  markDirty(overview ? "grid" : state.activeView, "toolbar", "pins");
}

/** Starts the data lifecycle for a destination restored from preferences.
 * `mountShell` has already mounted every host and made the right one visible;
 * this pass does the same work a deliberate click would normally trigger. */
function openRestoredView() {
  if (state.activeView === "ports" && !state.ports.length) loadPorts();
  if (state.activeView === "dns") window.wintDns?.opened();
  if (state.activeView === "hosts") window.wintHosts?.opened();
  if (state.activeView === "network") window.wintNetwork?.opened();
  if (state.activeView === "path-ping") window.wintPathPing?.opened();
  if (state.activeView === "disk-space") window.wintDiskSpace?.opened();
  if (state.activeView === "github") window.wintGithub?.opened();
  if (state.activeView === "git") { syncGitRepositories(); window.wintGit?.opened(); }
  if (state.activeView === "tools") {
    window.wintUtilTools?.open(state.utilToolId);
    window.wintUtilTools?.opened();
  }
  if (state.activeView === "windows-tools") {
    if (state.windowsToolId === "time-tracker") syncEmbeddedTool();
    else {
      window.wintWindowsTools?.open(state.windowsToolId);
      window.wintWindowsTools?.opened();
    }
  }
  if (state.activeView === "isolated-tool") {
    renderIsolatedToolChrome();
    syncEmbeddedTool();
  }
}

/* --------------------------------------------------- what the explorer lists

   The list is about ports, not processes: one row per port a process holds, so
   ":3000 is taken" has a row of its own even when one process is holding four
   of them. The servers you started keep a shelf of their own at the top, since
   that is the question usually being asked; everything else is one list in
   whatever order the sort asks for, so "what is eating the memory" is answered
   by the row at the top of it and not by four separate shelves.
*/

/** Services worth telling apart from "the rest of Windows": you did not start
 *  them this morning, but you do care that they are up. */
const SERVICE_MARKERS = [
  ["postgres", "PostgreSQL"], ["mysqld", "MySQL"], ["mariadb", "MariaDB"],
  ["mongod", "MongoDB"], ["redis", "Redis"], ["sqlservr", "SQL Server"],
  ["docker", "Docker"], ["com.docker", "Docker"], ["rabbitmq", "RabbitMQ"],
  ["elasticsearch", "Elasticsearch"], ["opensearch", "OpenSearch"],
  ["nginx", "nginx"], ["httpd", "Apache"], ["memcached", "Memcached"],
  ["influxd", "InfluxDB"], ["clickhouse", "ClickHouse"], ["cassandra", "Cassandra"],
  ["kafka", "Kafka"], ["zookeeper", "ZooKeeper"], ["minio", "MinIO"],
  ["ollama", "Ollama"], ["azurite", "Azurite"], ["func.exe", "Azure Functions"],
];

/** The two shelves the list is drawn on. A row still carries the finer group it
 *  was classified into — dev, svc, sys, off — which is what colours its rail. */
const PORT_SHELVES = [
  { key: "dev", title: "Your dev servers", tone: "green" },
  { key: "rest", title: "Everything else", tone: "grey" },
];

const PORT_TABS = [
  { key: "listen", label: "Ports" },
  { key: "all", label: "All" },
];

/** The expensive end is the one being looked for, so a cost column starts at
 *  the top of it. */
const PORT_SORTS = [
  { key: "cpu", label: "CPU", title: "CPU", first: -1 },
  { key: "mem", label: "Mem", title: "memory", first: -1 },
];

/** How many readings a sparkline is drawn from, and how often they are taken. */
const SAMPLE_POINTS = 40;
const SAMPLE_MS = 2000;
/** The full sweep is expensive — a CIM sweep, netstat and an HTTP probe per
 *  local port — so it runs far more rarely than the sampler, which is a handful
 *  of native calls. New servers appear within this; their cost does not. */
const RELIST_MS = 30000;

function portProcessName(row) {
  return row.process || row.executablePath?.split(/[\\/]/).pop() || "Unknown process";
}

function processPortText(row) {
  return (row.ports || []).map((binding) => `${binding.port}/${binding.protocol}${binding.httpStatus ? ` (HTTP ${binding.httpStatus})` : ""}`).join(", ") || "None";
}

function primaryBrowserUrl(row) {
  return (row.ports || []).find((binding) => binding.browserUrl)?.browserUrl || null;
}

function projectForProcess(row) {
  const cwd = String(row.cwd || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  if (!cwd) return null;
  return state.projects.find((project) => {
    const path = String(project.path || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    return cwd === path || cwd.startsWith(`${path}\\`);
  }) || null;
}

function localServerLabel(row, port, project) {
  const haystack = `${row.process} ${row.executablePath} ${row.commandLine}`.toLowerCase();
  const known = [
    ["next", "Next.js"], ["vite", "Vite"], ["aspnet", "ASP.NET"],
    ["dotnet", "ASP.NET"], ["postgres", "PostgreSQL"], ["redis", "Redis"],
    ["webpack", "Webpack"], ["ng serve", "Angular"], ["django", "Django"],
    ["flask", "Flask"], ["uvicorn", "FastAPI"], ["fastapi", "FastAPI"],
    ["rails", "Rails"], ["spring", "Spring Boot"],
  ];
  const commandMatch = known.find(([needle]) => haystack.includes(needle));
  if (commandMatch) return commandMatch[1];
  const serviceMatch = SERVICE_MARKERS.find(([needle]) => haystack.includes(needle));
  if (serviceMatch) return serviceMatch[1];
  const projectNames = (project?.tech || []).map((tech) => tech.name);
  const projectMatch = ["Next.js", "Vite", "ASP.NET", "PostgreSQL", "Redis", "Angular", "Django", "Flask", "FastAPI", "Spring Boot"]
    .find((name) => projectNames.includes(name));
  if (projectMatch) return projectMatch;
  return ({ 3000: "Web app", 4200: "Angular", 5000: "Web server", 5001: "ASP.NET", 5173: "Vite", 5432: "PostgreSQL", 6379: "Redis", 8000: "Web server", 8080: "Web server" })[port]
    || portProcessName(row).replace(/\.exe$/i, "");
}

function isLikelyDevelopmentProcess(row, project) {
  if (project) return true;
  const executable = portProcessName(row).toLowerCase();
  const runtimes = new Set([
    "node.exe", "bun.exe", "deno.exe", "dotnet.exe", "python.exe", "pythonw.exe",
    "ruby.exe", "php.exe", "java.exe", "javaw.exe", "go.exe", "cargo.exe", "air.exe",
  ]);
  if (runtimes.has(executable)) return true;
  const command = `${row.commandLine || ""} ${row.executablePath || ""}`.toLowerCase();
  return [
    "next dev", "vite", "webpack", "ng serve", "aspnetcore", "dotnet watch",
    "django", "manage.py runserver", "flask run", "uvicorn", "fastapi", "rails server",
    "spring-boot", "npm run", "pnpm run", "yarn dev", "bun run", "deno run",
  ].some((marker) => command.includes(marker));
}

/** Which shelf a row belongs on. A service is recognised by its image name, so
 *  Postgres is a service whether or not it happens to sit inside a project
 *  folder; anything else that looks like something you started is a dev server. */
function portGroup(row, project) {
  const haystack = `${row.process} ${row.executablePath}`.toLowerCase();
  if (SERVICE_MARKERS.some(([needle]) => haystack.includes(needle))) return "svc";
  if (isLikelyDevelopmentProcess(row, project)) return "dev";
  return "sys";
}

// Deriving the rows walks every process on the machine, and the sampler asks
// for them twice a second. They only change when the sweep brings back a new
// table, so they are worked out once per table and kept.
let portEntryCache = { source: null, projects: null, listening: [], portless: [] };

function portCache() {
  // A scan landing after the sweep is what ties rows to projects, so the
  // project list is part of what the rows were derived from.
  if (portEntryCache.source !== state.ports || portEntryCache.projects !== state.projects) {
    portEntryCache = {
      source: state.ports, projects: state.projects,
      listening: buildPortEntries(), portless: buildPortlessEntries(),
    };
  }
  return portEntryCache;
}

function portEntries() {
  return portCache().listening;
}

function portlessEntries() {
  return portCache().portless;
}

/** Every listening socket as its own row. The same port on TCP and UDP is one
 *  row carrying both protocols — it is one port either way. */
function buildPortEntries() {
  const entries = [];
  for (const row of state.ports) {
    const project = projectForProcess(row);
    const group = portGroup(row, project);
    const byPort = new Map();
    for (const binding of row.ports || []) {
      const existing = byPort.get(binding.port);
      if (existing) {
        if (!existing.protocols.includes(binding.protocol)) existing.protocols.push(binding.protocol);
        existing.browserUrl = existing.browserUrl || binding.browserUrl;
        existing.httpStatus = existing.httpStatus || binding.httpStatus;
        continue;
      }
      byPort.set(binding.port, {
        key: `${row.pid}:${binding.port}`,
        row, project, group,
        pid: row.pid,
        port: binding.port,
        protocols: [binding.protocol],
        address: binding.address,
        browserUrl: binding.browserUrl || null,
        httpStatus: binding.httpStatus || 0,
        label: localServerLabel(row, binding.port, project),
      });
    }
    entries.push(...byPort.values());
  }
  return entries.sort((a, b) => a.port - b.port || a.pid - b.pid);
}

/** A process holding nothing, shown only on the All tab so the explorer still
 *  answers "what is this thing running?" the way the old table did. */
function buildPortlessEntries() {
  return state.ports.filter((row) => !(row.ports || []).length).map((row) => {
    const project = projectForProcess(row);
    return {
      key: `${row.pid}:none`, row, project, group: "off",
      pid: row.pid, port: 0, protocols: [], address: "",
      browserUrl: null, httpStatus: 0,
      label: portProcessName(row).replace(/\.exe$/i, ""),
    };
  }).sort((a, b) => a.label.localeCompare(b.label) || a.pid - b.pid);
}

function portMatches(entry, words) {
  if (!words.length) return true;
  const haystack = `${entry.port || ""} ${entry.protocols.join(" ")} ${entry.address} ${entry.label} ${entry.project?.name || ""} ${entry.row.pid} ${entry.row.process} ${entry.row.cwd} ${entry.row.executablePath} ${entry.row.commandLine}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** What a row is worth under the current ordering. CPU and memory come from the
 *  live readings, so a row that has not been measured yet has no value at all
 *  rather than a zero that would claim it is idle. */
function portSortValue(entry) {
  const slot = state.portSamples.get(entry.pid);
  if (state.portSortKey === "cpu") {
    const cpu = slot?.cpu;
    return cpu?.length ? cpu[cpu.length - 1] : null;
  }
  return slot?.memoryBytes || null;
}

/** Ordering runs across the whole list, not inside a shelf: asked for the
 *  hungriest process, the answer has to be the hungriest one there is, wherever
 *  it happens to live. Anything unmeasured sinks to the bottom whichever way
 *  the arrow points, and the port number breaks ties so the order is never
 *  arbitrary. */
function sortPortRows(rows) {
  const direction = state.portSortDirection;
  return [...rows].sort((a, b) => {
    const av = portSortValue(a);
    const bv = portSortValue(b);
    if (av === null || bv === null) {
      if (av === bv) return a.port - b.port || a.pid - b.pid;
      return av === null ? 1 : -1;
    }
    return (av - bv) * direction || a.port - b.port || a.pid - b.pid;
  });
}

/** The rows the current tab and filter leave standing. One shelf survives as a
 *  shelf — the servers you started, which are the ones usually being looked for
 *  and are worth keeping in reach at the top. Everything else is a single list
 *  in whatever order the sort asks for, so the top of it really is the most
 *  expensive thing on the machine. */
function visiblePortGroups() {
  const words = state.portSearch.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const all = state.portTab === "all" ? [...portEntries(), ...portlessEntries()] : portEntries();
  const kept = all.filter((entry) => portMatches(entry, words));
  return PORT_SHELVES
    .map((shelf) => ({
      ...shelf,
      rows: sortPortRows(kept.filter((entry) => (shelf.key === "dev") === (entry.group === "dev"))),
    }))
    .filter((shelf) => shelf.rows.length);
}

function portEntryByKey(key) {
  if (!key) return null;
  const all = [...portEntries(), ...portlessEntries()];
  return all.find((entry) => entry.key === key) || null;
}

/** The row the detail pane describes. Falls back to the first thing on screen,
 *  so the pane is never empty while the list has something in it. */
function selectedPortEntry() {
  const groups = visiblePortGroups();
  const rows = groups.flatMap((group) => group.rows);
  return rows.find((entry) => entry.key === state.portSelected) || portEntryByKey(state.portSelected) || rows[0] || null;
}

/* ------------------------------------------------------ the live readings */

/** Whose cost is worth measuring: every row the list is currently showing, plus
 *  whatever the detail pane is showing and its tree. The list is ordered by
 *  those readings, so a row on screen that was never measured would sit at the
 *  bottom for ever and make the ordering a lie. */
function sampledPids() {
  const pids = new Set(visiblePortGroups().flatMap((group) => group.rows).map((entry) => entry.pid));
  const selected = selectedPortEntry();
  if (selected) for (const node of processTree(selected.row)) pids.add(node.pid);
  return [...pids].slice(0, 600);
}

function sampleSlot(pid) {
  let slot = state.portSamples.get(pid);
  if (!slot) {
    slot = { cpu: [], mem: [], cpuSeconds: 0, at: 0, uptime: 0, memoryBytes: 0 };
    state.portSamples.set(pid, slot);
  }
  return slot;
}

/** One reading turned into a point on each line. CPU only exists as a
 *  difference between two readings, so the first one for a process draws
 *  nothing — it is the baseline. */
function recordSample(sample, at) {
  const slot = sampleSlot(sample.pid);
  const cores = navigator.hardwareConcurrency || 4;
  const seconds = (at - slot.at) / 1000;
  if (slot.at && seconds > 0.2) {
    const busy = Math.max(0, sample.cpuSeconds - slot.cpuSeconds);
    slot.cpu = [...slot.cpu, Math.min(100, (busy / seconds / cores) * 100)].slice(-SAMPLE_POINTS);
    slot.mem = [...slot.mem, sample.memoryBytes / 1048576].slice(-SAMPLE_POINTS);
  }
  slot.cpuSeconds = sample.cpuSeconds;
  slot.memoryBytes = sample.memoryBytes;
  slot.uptime = sample.uptimeSeconds;
  slot.at = at;
}

let portSampleInFlight = false;

async function samplePorts() {
  if (portSampleInFlight || state.activeView !== "ports") return;
  const pids = sampledPids();
  if (!pids.length) return;
  portSampleInFlight = true;
  try {
    const samples = await invoke("port_sample", { pids });
    const at = Date.now();
    const alive = new Set();
    for (const sample of samples || []) {
      recordSample(sample, at);
      alive.add(sample.pid);
    }
    // A process that stopped answering has gone; forget its history so a PID
    // reused by something else does not inherit a stranger's graph.
    const asked = new Set(pids);
    for (const pid of [...state.portSamples.keys()]) {
      // Also drops anything that has fallen out of what is worth measuring, so
      // a long session does not keep a graph per process it once looked at.
      if (!asked.has(pid) || !alive.has(pid)) state.portSamples.delete(pid);
    }
    if (state.activeView === "ports") {
      // Ordering by cost means the order is a live thing: a reading that moves
      // a row has to move it. Nothing is rebuilt when the order came out the
      // same, and nothing moves while the pointer is over the list - a row
      // sliding out from under a click is worse than a stale position.
      if (!portListHovered && portOrderChanged()) renderPortList();
      patchPortMetrics();
    }
  } catch {
    /* a sampling round that fails simply leaves the lines where they were */
  } finally {
    portSampleInFlight = false;
  }
}

let portLiveTimer = 0;
let portRelistTimer = 0;

/** The sampler runs only while the explorer is on screen: off it, there is
 *  nothing for the readings to draw on. */
function setPortsLive(on) {
  clearInterval(portLiveTimer);
  clearInterval(portRelistTimer);
  portLiveTimer = 0;
  portRelistTimer = 0;
  if (!on) return;
  samplePorts();
  portLiveTimer = setInterval(samplePorts, SAMPLE_MS);
  portRelistTimer = setInterval(() => {
    if (state.activeView === "ports" && !state.portsLoading && !state.portKill) loadPorts({ quiet: true });
  }, RELIST_MS);
}

/* ---------------------------------------------------------- process trees */

/** The chain the row hangs off: its ancestors above it, its descendants below,
 *  each with the depth to indent it by. Built from the process table the
 *  explorer already has, so it costs nothing extra. */
function processTree(row) {
  const byPid = new Map(state.ports.map((entry) => [entry.pid, entry]));
  const chain = [];
  let walker = row;
  const seen = new Set();
  while (walker && !seen.has(walker.pid) && chain.length < 8) {
    seen.add(walker.pid);
    chain.unshift(walker);
    walker = walker.parentPid && walker.parentPid !== walker.pid ? byPid.get(walker.parentPid) : null;
  }
  const nodes = chain.map((entry, depth) => ({ row: entry, pid: entry.pid, depth, holder: entry.pid === row.pid }));
  const children = new Map();
  for (const entry of state.ports) {
    if (!children.has(entry.parentPid)) children.set(entry.parentPid, []);
    children.get(entry.parentPid).push(entry);
  }
  const descend = (parent, depth) => {
    if (depth > chain.length + 3) return;
    for (const child of (children.get(parent.pid) || []).sort((a, b) => a.pid - b.pid)) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      nodes.push({ row: child, pid: child.pid, depth, holder: false });
      descend(child, depth + 1);
    }
  };
  descend(row, chain.length);
  return nodes.slice(0, 24);
}

/* ------------------------------------------------------------- formatting */

function portUptimeText(pid) {
  const seconds = state.portSamples.get(pid)?.uptime || 0;
  if (!seconds) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, "0")}h`;
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m`;
}

function portCpuText(pid) {
  const cpu = state.portSamples.get(pid)?.cpu;
  return cpu?.length ? `${cpu[cpu.length - 1].toFixed(1)}%` : "—";
}

function portMemText(pid) {
  const bytes = state.portSamples.get(pid)?.memoryBytes || 0;
  return bytes ? `${Math.round(bytes / 1048576)} MB` : "—";
}

/** A polyline through the readings, scaled to whatever the tallest one is so a
 *  quiet process still shows its shape rather than a flat line on the floor. */
function sparkPoints(values, width, height, pad) {
  if (!values?.length) return "";
  const max = Math.max(...values, 0.1) * 1.15;
  const step = width / Math.max(values.length - 1, 1);
  return values
    .map((value, index) => `${(index * step).toFixed(1)},${(height - pad - (value / max) * (height - pad * 2)).toFixed(1)}`)
    .join(" ");
}

function portTone(entry) {
  if (entry.httpStatus >= 500) return "amber";
  if (entry.group === "dev") return "green";
  if (entry.group === "svc") return "teal";
  return "grey";
}

/* --------------------------------------------------------------- drawing */

function renderPorts() {
  if (state.activeView !== "ports") return;
  renderPortPins();
  renderPortTabs();
  renderPortList();
  renderPortDetail();
  renderPortDialogs();
  patchPortMetrics();
}

function renderPortTabs() {
  const entries = portEntries();
  const counts = { listen: entries.length, all: state.ports.length };
  el["port-tabs"].innerHTML = PORT_TABS.map((tab) => `<button type="button" class="${state.portTab === tab.key ? "on" : ""}"
    data-port-tab="${tab.key}" aria-pressed="${state.portTab === tab.key}">${tab.label}<span>${counts[tab.key]}</span></button>`).join("");
  el["port-sort"].innerHTML = PORT_SORTS.map((sort) => {
    const on = state.portSortKey === sort.key;
    const arrow = state.portSortDirection === 1 ? "▲" : "▼";
    return `<button type="button" class="${on ? "on" : ""}" data-port-sort="${sort.key}"
      aria-pressed="${on}" title="${on ? `Sort by ${sort.title} the other way` : `Sort by ${sort.title}`}"
      >${sort.label}<span>${on ? arrow : ""}</span></button>`;
  }).join("");
  el["port-live"].classList.toggle("off", !state.portLive);
  el["port-live"].textContent = state.portLive ? `Live · ${SAMPLE_MS / 1000}s` : "Paused";
}

function renderPortPins() {
  const entries = portEntries();
  el["port-pins"].innerHTML = state.portPins.length
    ? state.portPins.map((port) => {
        const entry = entries.find((candidate) => candidate.port === port);
        if (!entry) {
          // A pinned port nothing is holding is worth saying out loud, but there
          // is nothing behind it to open.
          return `<div class="port-pin-tile free" title=":${port} is free">
            <span class="port-pin-top"><i class="dot grey"></i><b>:${port}</b></span>
            <span class="port-pin-sub"><span>Not listening</span></span></div>`;
        }
        return `<button type="button" class="port-pin-tile ${entry.key === state.portSelected ? "on" : ""}"
          data-port-select="${esc(entry.key)}" title="${esc(entry.label)} · PID ${entry.pid}">
          <span class="port-pin-top"><i class="dot ${portTone(entry)}"></i><b>:${entry.port}</b>
            <svg class="port-spark" data-spark-pid="${entry.pid}" data-spark="pin" viewBox="0 0 64 18" preserveAspectRatio="none"><polyline points="" /></svg></span>
          <span class="port-pin-sub"><span>${esc(entry.label)}</span><small>${esc(entry.project?.name || portProcessName(entry.row))}</small></span>
        </button>`;
      }).join("")
    : `<div class="port-pins-empty">Nothing pinned yet</div>`;
}

function portRowHtml(entry) {
  const tone = portTone(entry);
  const pinned = state.portPins.includes(entry.port);
  const badge = entry.httpStatus
    ? `<span class="port-badge ${entry.httpStatus >= 500 ? "bad" : entry.httpStatus >= 400 ? "warn" : "ok"}">HTTP ${entry.httpStatus}</span>`
    : "";
  const sub = [portProcessName(entry.row), entry.pid, entry.project?.name].filter(Boolean).join(" · ");
  return `<div class="port-row ${entry.key === state.portSelected ? "on" : ""}" data-port-select="${esc(entry.key)}"
      data-port-row="${esc(entry.key)}" data-port-pid="${entry.pid}" role="button" tabindex="0">
    <i class="port-rail ${tone}"></i>
    <span class="port-num ${entry.group}">${entry.port ? `<b>${entry.port}</b><small>${esc(entry.protocols.join("/"))}</small>` : `<b class="none">—</b>`}</span>
    <span class="port-what"><span class="port-what-top"><strong>${esc(entry.label)}</strong>${badge}</span>
      <small>${esc(sub)}</small></span>
    ${entry.port ? `<svg class="port-spark" data-spark-pid="${entry.pid}" data-spark="row" viewBox="0 0 64 20" preserveAspectRatio="none"><polyline points="" /></svg>
    <span class="port-cpu" data-cpu-pid="${entry.pid}">—</span>` : `<span class="port-spark"></span><span class="port-cpu"></span>`}
    ${entry.port ? `<button type="button" class="port-pin ${pinned ? "on" : ""}" data-port-pin="${entry.port}"
      title="${pinned ? "Unpin" : "Pin"} :${entry.port}">${icon("push_pin")}</button>` : `<span class="port-pin"></span>`}
  </div>`;
}

/** Whether the pointer is somewhere in the list, and what order the list was
 *  last drawn in — together they decide whether a live re-sort is allowed to
 *  move anything. */
let portListHovered = false;
let portDrawnOrder = "";

function portOrderSignature(groups) {
  return groups.flatMap((group) => group.rows.map((entry) => entry.key)).join("|");
}

function portOrderChanged() {
  return portOrderSignature(visiblePortGroups()) !== portDrawnOrder;
}

function renderPortList() {
  const groups = visiblePortGroups();
  const host = el["ports-list"];
  portDrawnOrder = portOrderSignature(groups);
  // The list is rebuilt whenever a sweep lands, which is every half minute even
  // when nothing about it changed. Putting the scroll back means a list being
  // read does not jump to the top under the reader.
  const scrolled = host.scrollTop;
  if (!groups.length) {
    host.innerHTML = `<div class="ports-empty">${state.portsLoading ? "Reading processes and ports…" : "Nothing matches this filter."}</div>`;
    return;
  }
  host.innerHTML = groups.map((group) => `<section class="port-group">
    <header class="port-group-head"><i class="dot ${group.tone}"></i>${esc(group.title)}<span>${group.rows.length}</span></header>
    ${group.rows.map(portRowHtml).join("")}
  </section>`).join("");
  host.scrollTop = scrolled;
}

function portFactsHtml(entry) {
  const facts = [
    ["Local URL", entry.browserUrl ? `<a href="#open" data-port-open="${esc(entry.browserUrl)}">${esc(entry.browserUrl)}</a>` : "—"],
    ["Listening on", entry.port ? `${esc(entry.address || "*")}:${entry.port} (${esc(entry.protocols.join(", "))})` : "Nothing"],
    ["Executable", esc(entry.row.executablePath || "Unavailable")],
    ["Working folder", esc(entry.row.cwd || "Unavailable")],
    ["Command line", esc(entry.row.commandLine || "Unavailable")],
  ];
  return facts.map(([key, value]) => `<div class="port-fact"><dt>${key}</dt><dd>${value}</dd></div>`).join("");
}

function renderPortDetail() {
  const host = el["ports-detail"];
  const body = host.querySelector(".port-detail-body");
  const scrolled = body ? body.scrollTop : 0;
  const wasKey = state.portSelected;
  const entry = selectedPortEntry();
  if (!entry) {
    host.innerHTML = `<div class="ports-empty">${state.portsLoading ? "Reading processes and ports…" : "Select a port to see what is holding it."}</div>`;
    return;
  }
  state.portSelected = entry.key;
  const tone = portTone(entry);
  const pinned = state.portPins.includes(entry.port);
  const restarting = state.portRestarting === entry.pid;
  const runnable = entry.project?.runCmd;
  const badge = entry.httpStatus
    ? `<span class="port-badge ${entry.httpStatus >= 500 ? "bad" : entry.httpStatus >= 400 ? "warn" : "ok"}">HTTP ${entry.httpStatus}${entry.httpStatus < 400 ? " · healthy" : ""}</span>`
    : `<span class="port-badge">${entry.port ? "Listening" : "No ports"}</span>`;
  const tree = processTree(entry.row);
  host.innerHTML = `
    <header class="port-detail-head">
      <span class="port-plate ${tone}">${entry.port ? `<b>${entry.port}</b><small>${esc(entry.protocols.join("/"))}</small>` : `<b class="none">—</b>`}</span>
      <span class="port-detail-title">
        <span class="port-detail-name"><h2>${esc(entry.label)}</h2>${badge}</span>
        <span class="port-detail-meta"><span>${esc(portProcessName(entry.row))}</span><i>·</i><span>PID ${entry.pid}</span><i>·</i>
          <span data-uptime-pid="${entry.pid}">up ${esc(portUptimeText(entry.pid))}</span>${entry.port ? `<i>·</i><span>${esc(entry.address || "*")}:${entry.port}</span>` : ""}</span>
        ${entry.project ? `<span class="port-detail-project">${icon("folder_code")}
          <button type="button" data-port-project="${esc(entry.project.path)}">${esc(entry.project.name)}</button>
          <small>${esc(entry.project.git?.branch || "")}</small></span>` : ""}
      </span>
      ${entry.port ? `<button type="button" class="btn port-pin-btn ${pinned ? "on" : ""}" data-port-pin="${entry.port}">${icon("push_pin")}${pinned ? "Pinned" : "Pin"}</button>` : ""}
    </header>
    <div class="port-detail-actions">
      ${entry.browserUrl ? `<button type="button" class="btn go" data-port-open="${esc(entry.browserUrl)}">${icon("open_in_new")}Open</button>
        <button type="button" class="btn" data-port-copy="${esc(entry.browserUrl)}">${icon("content_copy")}Copy URL</button>` : ""}
      ${runnable ? `<button type="button" class="btn ${restarting ? "busy" : ""}" data-port-restart="${esc(entry.key)}" ${restarting ? "disabled" : ""}>${icon(restarting ? "progress_activity" : "restart_alt")}${restarting ? "Restarting…" : "Restart"}</button>` : ""}
      ${entry.project ? `<button type="button" class="btn" data-port-detail="${esc(entry.project.path)}">${icon("folder_code")}Project</button>` : ""}
      ${entry.row.cwd ? `<button type="button" class="btn" data-port-terminal="${esc(entry.key)}">${icon("terminal")}Terminal</button>
        <button type="button" class="btn" data-port-reveal="${esc(entry.project?.path || entry.row.cwd)}">${icon("folder_open")}Reveal</button>` : ""}
      <span class="spacer"></span>
      <button type="button" class="btn danger" data-port-kill="${esc(entry.key)}">${icon("stop_circle")}Kill</button>
    </div>
    <div class="port-detail-body">
      <div class="port-charts">
        <div class="port-chart cpu">
          <div class="port-chart-head"><span>CPU</span><b data-cpu-pid="${entry.pid}">—</b><i data-peak="cpu" data-peak-pid="${entry.pid}"></i></div>
          <svg viewBox="0 0 240 44" preserveAspectRatio="none" data-chart="cpu" data-chart-pid="${entry.pid}">
            <polyline class="area" points="" /><polyline class="line" points="" /></svg>
        </div>
        <div class="port-chart mem">
          <div class="port-chart-head"><span>Memory</span><b data-mem-pid="${entry.pid}">—</b><i data-peak="mem" data-peak-pid="${entry.pid}"></i></div>
          <svg viewBox="0 0 240 44" preserveAspectRatio="none" data-chart="mem" data-chart-pid="${entry.pid}">
            <polyline class="area" points="" /><polyline class="line" points="" /></svg>
        </div>
      </div>
      <section class="port-tree">
        <header>${icon("account_tree")}<span>Process tree</span><small>${tree.length} process${tree.length === 1 ? "" : "es"}</small></header>
        ${tree.map((node) => `<div class="port-tree-node ${node.holder ? "holder" : ""}">
          <i style="width:${node.depth * 16}px"></i>
          ${icon(node.holder ? "lan" : node.depth === 0 ? "desktop_windows" : "subdirectory_arrow_right")}
          <b>${esc(portProcessName(node.row))}</b><span>${node.pid}</span>
          <small>${esc(node.row.cwd || node.row.commandLine || "")}</small>
          ${node.holder && entry.port ? `<em>HOLDS PORT</em>` : ""}
        </div>`).join("")}
      </section>
      <dl class="port-facts">${portFactsHtml(entry)}</dl>
    </div>`;
  // Only worth putting back when it is the same row: a different port is a
  // different page and starts at the top.
  if (wasKey === entry.key) host.querySelector(".port-detail-body").scrollTop = scrolled;
}

function renderPortDialogs() {
  const host = el["ports-dialogs"];
  if (!state.portKill) return void (host.innerHTML = "");
  const entry = portEntryByKey(state.portKill.key);
  if (!entry) return void (host.innerHTML = "");
  const tree = processTree(entry.row);
  // Only what hangs below the row goes with it: the shells and supervisors
  // above it in the tree are shown for context, never terminated.
  const holderDepth = tree.find((node) => node.holder)?.depth ?? 0;
  const below = tree.filter((node) => node.depth > holderDepth);
  const count = state.portKill.tree ? below.length + 1 : 1;
  host.innerHTML = `<div class="port-overlay"><section class="port-dialog port-confirm" role="alertdialog" aria-modal="true" aria-labelledby="port-kill-title">
    <header>${icon("stop_circle")}<h3 id="port-kill-title">Kill ${esc(portProcessName(entry.row))}${entry.port ? ` on :${entry.port}` : ""}?</h3>
      <button type="button" data-port-dialog-close>${icon("close")}</button></header>
    <p>PID ${entry.pid} ${entry.port ? `is listening on ${esc(entry.address || "*")}:${entry.port}` : "holds no ports"}${entry.project ? ` for ${esc(entry.project.name)}` : ""}. Terminating it ${entry.port ? "closes that port immediately" : "stops it immediately"}.</p>
    <button type="button" class="port-kill-tree ${state.portKill.tree ? "on" : ""}" data-port-kill-tree>
      ${icon(state.portKill.tree ? "check_box" : "check_box_outline_blank")}
      <span><strong>Kill the whole tree</strong><small>${below.length ? esc(below.map((node) => `${portProcessName(node.row)} ${node.pid}`).join("  →  ")) : "Nothing is running under it"}</small></span>
    </button>
    <footer><button type="button" class="btn" data-port-dialog-close>Cancel</button>
      <button type="button" class="btn danger" data-port-kill-confirm="${esc(entry.key)}">Kill ${count} process${count === 1 ? "" : "es"}</button></footer>
  </section></div>`;
}

/** The 2-second refresh. Only the numbers and the lines change, so only those
 *  are touched — the list itself is never rebuilt under the pointer. */
function patchPortMetrics() {
  const host = el["ports-host"];
  if (!host || host.hidden) return;
  for (const svg of host.querySelectorAll("[data-spark-pid]")) {
    const values = state.portSamples.get(Number(svg.dataset.sparkPid))?.cpu || [];
    const height = svg.dataset.spark === "pin" ? 18 : 20;
    svg.firstElementChild.setAttribute("points", sparkPoints(values.slice(-24), 64, height, 2));
  }
  for (const node of host.querySelectorAll("[data-cpu-pid]")) node.textContent = portCpuText(Number(node.dataset.cpuPid));
  for (const node of host.querySelectorAll("[data-mem-pid]")) node.textContent = portMemText(Number(node.dataset.memPid));
  for (const node of host.querySelectorAll("[data-uptime-pid]")) node.textContent = `up ${portUptimeText(Number(node.dataset.uptimePid))}`;
  for (const node of host.querySelectorAll("[data-peak-pid]")) {
    const slot = state.portSamples.get(Number(node.dataset.peakPid));
    const values = (node.dataset.peak === "cpu" ? slot?.cpu : slot?.mem) || [];
    node.textContent = values.length
      ? `peak ${node.dataset.peak === "cpu" ? `${Math.max(...values).toFixed(1)}%` : `${Math.round(Math.max(...values))} MB`}`
      : "";
  }
  for (const svg of host.querySelectorAll("[data-chart-pid]")) {
    const slot = state.portSamples.get(Number(svg.dataset.chartPid));
    const values = (svg.dataset.chart === "cpu" ? slot?.cpu : slot?.mem) || [];
    const points = sparkPoints(values, 240, 44, 3);
    svg.querySelector(".line").setAttribute("points", points);
    svg.querySelector(".area").setAttribute("points", points ? `0,44 ${points} 240,44` : "");
  }
}

/* --------------------------------------------------------------- actions */

async function loadPorts(options = {}) {
  const token = ++state.portToken;
  state.portsLoading = !options.quiet;
  state.portsError = "";
  if (!options.quiet) markDirty("ports");
  if (!options.quiet) beginWork("ports", "Reading processes and ports");
  try {
    const rows = await invoke("port_list");
    if (token === state.portToken) state.ports = Array.isArray(rows) ? rows : [];
  } catch (error) {
    if (token === state.portToken) state.portsError = String(error);
  } finally {
    if (token === state.portToken) {
      state.portsLoading = false;
      markDirty("ports");
      if (document.activeElement === el["search-input"]) renderSearchCommands();
    }
    if (!options.quiet) endWork("ports");
  }
  samplePorts();
}

function togglePortPin(port) {
  state.portPins = state.portPins.includes(port)
    ? state.portPins.filter((pinned) => pinned !== port)
    : [...state.portPins, port].slice(-12);
  savePrefs();
  markDirty("ports");
}

function isFavorite(path) {
  return state.favorites.has(path);
}

/** Stars travel with the folder path, not the scan. Unstarring while the
 *  Favorites chip is on drops the card from the list on the next paint. */
function toggleFavorite(path) {
  if (!path) return;
  const starred = state.favorites.has(path);
  if (starred) state.favorites.delete(path);
  else state.favorites.add(path);
  savePrefs();
  const name = state.byPath.get(path)?.name || path;
  beginWork("favorite", starred ? `Unstarred ${name}` : `Starred ${name}`);
  setTimeout(() => endWork("favorite"), 1200);
  markDirty("filters", "grid");
  if (state.selectedPath === path) markDirty("detail");
}

async function killPortProcess(key, tree) {
  const entry = portEntryByKey(key);
  if (!entry) return;
  state.portKill = null;
  markDirty("ports");
  beginWork(`port-kill:${entry.pid}`, tree ? `Terminating ${portProcessName(entry.row)} and everything under it` : `Terminating process ${entry.pid}`);
  try {
    await invoke("port_kill", {
      pid: entry.pid,
      expectedExecutable: entry.row.executablePath || "",
      expectedProcess: entry.row.process || "",
      tree: Boolean(tree),
    });
    state.portSamples.delete(entry.pid);
    await loadPorts({ quiet: true });
  } catch (error) {
    state.portsError = String(error);
    markDirty("ports");
  } finally {
    endWork(`port-kill:${entry.pid}`);
  }
}

/** The shell opens in the dock, not in a window of its own: the point of
 *  landing in the folder a port is being served from is to type in it while
 *  still looking at the port. A row outside any scanned project gets a session
 *  named after its working folder, which is all `term_open` needs. */
function openPortTerminal(key) {
  const entry = portEntryByKey(key);
  const folder = entry?.project?.path || entry?.row.cwd;
  if (!folder) return;
  const name = entry.project?.name || folder.split(/[\\/]/).filter(Boolean).pop() || portProcessName(entry.row);
  window.openTerminal?.({ path: folder, name });
}

/** Stop it and start it again the way the project says it starts — which is why
 *  this is offered only for a row that belongs to a project with a run command. */
async function restartPortProcess(key) {
  const entry = portEntryByKey(key);
  const project = entry?.project;
  if (!project?.runCmd) return;
  state.portRestarting = entry.pid;
  markDirty("ports");
  beginWork(`port-restart:${entry.pid}`, `Restarting ${project.name}`);
  try {
    await invoke("port_kill", {
      pid: entry.pid,
      expectedExecutable: entry.row.executablePath || "",
      expectedProcess: entry.row.process || "",
      tree: true,
    });
    state.portSamples.delete(entry.pid);
    window.openTerminal?.(project, { run: project.runCmd });
    await loadPorts({ quiet: true });
  } catch (error) {
    state.portsError = String(error);
  } finally {
    state.portRestarting = 0;
    endWork(`port-restart:${entry.pid}`);
    markDirty("ports");
  }
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
  const checksum = release.version === state.appVersion && state.appBuildChecksum
    ? state.appBuildChecksum
    : (release.buildChecksum || "");
  const build = checksum
    ? `<p class="release-build">Version ${esc(release.version)} was built with checksum <code>${esc(checksum)}</code></p>`
    : "";
  return `<section class="release">
    <div class="release-head">
      <span class="release-ver">${esc(release.version)}</span>
      <span class="release-title">${esc(release.title)}</span>
      <time class="release-date" datetime="${esc(release.date)}">${esc(changelogDate(release.date))}</time>
    </div>
    ${build}
    <ul class="release-changes">${changes}</ul>
  </section>`;
}

/** The list is the same every time it opens, so it is built once and then only
 *  shown and hidden - opening it never costs a frame. */
function buildChangelog() {
  const log = window.wintChangelog;
  const built = `${log?.current}/${state.appVersion}/${state.appBuildChecksum}`;
  if (!log || el["changelog-pop"].dataset.built === built) return;
  el["changelog-pop"].innerHTML = `
    <div class="changelog-head">
      <span class="changelog-title">What's new</span>
      <span class="changelog-now">WinT ${esc(state.appVersion || log.current)}</span>
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
 *  answers, the status bar simply has no version on it. An official Store
 *  package then hashes this exe on a second trip - disk work - so What's new
 *  can name the current release's checksum. Dev builds skip that entirely. */
function loadAppVersion() {
  invoke("app_version")
    .then((version) => {
      state.appVersion = String(version);
      renderVersionButton();
    })
    .catch(() => {});
  invoke("app_is_official_build")
    .then((official) => {
      if (!official) return;
      beginWork("build-checksum", "Reading this build's checksum");
      return invoke("app_build_checksum")
        .then((hash) => {
          const value = String(hash || "");
          if (!value) return;
          state.appBuildChecksum = value;
          if (changelogOpen()) buildChangelog();
        })
        .finally(() => endWork("build-checksum"));
    })
    .catch(() => {});
}

function changelogOpen() {
  return false;
}

/** The screen the window is showing, named for analytics. Worked out from the
 *  state rather than remembered, so closing something always reports whatever
 *  it uncovers - the changelog over a project goes back to the project. */
function currentPath() {
  if (changelogOpen()) return "/changelog";
  if (state.selectedPath) return "/project";
  if (state.activeView === "tools") return `/tools/${state.utilToolId}`;
  return `/${state.activeView}`;
}

function openChangelog() {
  invoke("changelog_show", { theme: state.theme === "light" ? "light" : "dark" }).catch((error) => {
    beginWork("changelog-open-fail", "Could not open What's new", String(error));
    setTimeout(() => endWork("changelog-open-fail"), 5000);
  });
  window.wintTrackPageView?.("/changelog");
}

function closeChangelog() {
  invoke("changelog_hide").catch(() => {});
}

function syncSettingsButton() {
  const button = document.getElementById("open-settings");
  if (!button) return;
  const active = state.activeView === "settings";
  button.classList.toggle("on", active);
  button.setAttribute("aria-pressed", String(active));
  button.title = active ? "Back to overview" : "Settings";
  button.setAttribute("aria-label", button.title);
  window.wintI18n?.refresh(button);
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
function projectAction(action, p, button = null) {
  switch (action) {
    case "open":
      if (state.activeView !== "overview") switchMainView("overview");
      openDetail(p);
      break;
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
    case "pull":
      if (p.git) pullProject(p);
      break;
    case "git":
      if (!p.git) return;
      window.wintGit?.open(p.path, p.name);
      if (state.activeView !== "git") switchMainView("git");
      break;
    case "external":
      openIn(p.path, "terminal");
      break;
    case "copy":
      window.wintCopy.copy(p.path, button, "Path copied").catch(() => {});
      break;
    case "favorite":
      toggleFavorite(p.path);
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

/* ------------------------------------------------------- tech dropdown */

/** What each tech kind is called in the picker. Short, because it sits in a
 *  fixed column in front of every name. */
const TECH_KIND_LABELS = {
  all: "All", lang: "Lang", runtime: "Runtime", framework: "Framework", ui: "UI",
  build: "Build", data: "Data", test: "Test", infra: "Infra", tool: "Tool",
};

/** Every technology the scan has seen, with how many projects carry it and
 *  which kind it is, so the list is coloured the way the cards' tags are. */
function techEntries() {
  const seen = new Map();
  for (const project of state.projects) {
    for (const tech of project.tech) {
      const entry = seen.get(tech.name) || { name: tech.name, kind: tech.kind, count: 0 };
      entry.count += 1;
      seen.set(tech.name, entry);
    }
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function techMenuOpen() {
  return Boolean(el["tech-menu"]) && !el["tech-menu"].hidden;
}

function openTechMenu() {
  el["tech-menu-input"].value = "";
  techMenuIndex = 0;
  el["tech-menu"].hidden = false;
  el["tech-filter"].setAttribute("aria-expanded", "true");
  renderTechMenu();
  el["tech-menu-input"].focus();
}

function closeTechMenu() {
  if (!el["tech-menu"]) return;
  el["tech-menu"].hidden = true;
  el["tech-filter"].setAttribute("aria-expanded", "false");
}

function chooseTech(name) {
  closeTechMenu();
  el["tech-filter"].focus();
  // "All tech" clears the filter; so does picking the one already on.
  if (!name) {
    if (!state.techFilter) return;
    state.techFilter = "";
    savePrefs();
    return markDirty("filters", "toolbar", "grid");
  }
  setTechFilter(name);
}

function renderTechMenu() {
  const terms = el["tech-menu-input"].value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = techEntries().filter((entry) => {
    const hay = `${entry.name} ${entry.kind}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
  // "All tech" is the way back out, so it leads the list - but only when the
  // list is the whole list; while typing, every row should be a match.
  techMenuRows = terms.length
    ? matches
    : [{ name: "", kind: "all", count: state.projects.length, label: "All tech" }, ...matches];
  techMenuIndex = Math.min(techMenuIndex, Math.max(0, techMenuRows.length - 1));
  el["tech-menu-list"].innerHTML = techMenuRows.length
    ? techMenuRows.map((entry, index) => {
        const on = entry.name ? entry.name === state.techFilter : !state.techFilter;
        return `<button class="tech-option${index === techMenuIndex ? " active" : ""}${
          on ? " on" : ""
        }" role="option" aria-selected="${on}" data-tech-option="${esc(entry.name)}"><span
          class="tech-option-kind tag ${esc(entry.kind)}">${esc(
          TECH_KIND_LABELS[entry.kind] || entry.kind
        )}</span><span
          class="tech-option-name">${esc(entry.label || entry.name)}</span><span
          class="tech-option-count">${entry.count}</span><span
          class="tech-option-check">${on ? icon("check") : ""}</span></button>`;
      }).join("")
    : '<div class="search-command-empty">No technology matches</div>';
  el["tech-menu-list"].querySelector(".tech-option.active")?.scrollIntoView({ block: "nearest" });
}

/* ------------------------------------------------------------------ tools

   Nothing but the project overview has a permanent seat in this window. The
   Process Explorer, and every big or small tool added beside it, is reached
   by searching for it — and only keeps a seat once the user has pinned it to
   the dock on the right of the status bar.

   That keeps the top of the window from growing a tab per tool, and keeps
   search as the single way to navigate: a tool nobody pins costs nothing but
   a row in a list nobody has to read.

   Adding a tool is one entry here. `open` puts it on screen, `active` says
   whether it is the thing currently on screen, and the rest is what search
   and the dock need to draw it. */

const TOOLS = [
  {
    id: "git", name: "Git", icon: "commit",
    hint: "changes, staging, commits, branches, remotes and history",
    keywords: "git versions version history save saved record snapshot source control commit branch checkout switch stash fetch pull push upload download sync diff changes changed modified untracked staged unstaged uncommitted stage unstage discard revert reset amend merge rebase conflict clone remote origin upstream tag blame log repository repo working tree",
    open: () => switchMainView("git"), active: () => state.activeView === "git",
  },
  {
    id: "github",
    name: "GitHub",
    icon: "merge",
    hint: "inbox, pull requests, issues, Actions and repositories",
    keywords: "github gh pull request pr merge request review approve comment issue ticket actions workflow run job build checks ci cd pipeline repository repo fork clone remote origin notifications inbox mentions assigned draft",
    open: () => switchMainView("github"),
    active: () => state.activeView === "github",
  },
  {
    id: "ports",
    name: "Process Explorer",
    icon: "lan",
    hint: "ports, PIDs, what is holding :3000, and kill",
    /** Extra words the tool should answer to that its name does not contain. */
    keywords: "processes process explorer ports port pid pids sockets socket listening listener bound bind in use taken occupied address already in use eaddrinuse conflict kill free release stop end terminate close task manager netstat lsof tcp udp localhost 3000 5173 8080 server daemon service node cpu memory ram usage resource what is using",
    open: () => switchMainView("ports"),
    active: () => state.activeView === "ports",
  },
  {
    id: "dns",
    name: "DNS",
    icon: "dns",
    hint: "resolve a name, compare resolvers, see who really answers",
    keywords: "dns resolve resolution lookup query nslookup dig host domain subdomain hostname name record records a aaaa cname mx txt ns soa srv ptr reverse rdns ttl propagation flush clear cache resolver nameserver doh 8.8.8.8 1.1.1.1 cloudflare google ip address localhost nxdomain not resolving cannot find",
    open: () => switchMainView("dns"),
    active: () => state.activeView === "dns",
  },
  {
    id: "hosts",
    name: "Hosts file",
    icon: "edit_note",
    hint: "point a name at your own machine — it beats every DNS server",
    keywords: "hosts hostfile hosts file etc drivers system32 entry alias mapping map point override shadow 127.0.0.1 ::1 localhost loopback dev local domain subdomain redirect block blocking ads site testing staging admin administrator elevate backup restore",
    open: () => switchMainView("hosts"),
    active: () => state.activeView === "hosts",
  },
  {
    id: "network",
    name: "Network",
    icon: "network_check",
    hint: "watch the packets crossing the wire, live",
    keywords: "network networking packet packets capture sniff sniffer analyzer pktmon wireshark tcpdump pcap pcapng traffic tcp udp tls ssl https http dns quic icmp arp frames wire live monitor inspect throughput bandwidth speed connections sockets adapter interface nic ethernet port ip who is talking",
    open: () => switchMainView("network"),
    active: () => state.activeView === "network",
  },
  {
    id: "path-ping",
    name: "Path Ping",
    icon: "route",
    hint: "find latency and packet loss at every hop",
    keywords: "pathping ping traceroute tracert mtr route hops hop latency lag rtt jitter slow packet loss dropped timeout unreachable connectivity reachable network diagnose troubleshoot internet connection quality",
    open: () => switchMainView("path-ping"),
    active: () => state.activeView === "path-ping",
  },
  {
    id: "disk-space",
    name: "Disk Space Usage",
    icon: "hard_drive",
    hint: "see what fills a drive and drill into every folder",
    keywords: "disk space usage storage capacity drive volume size big large biggest largest folder directory file files treemap spacesniffer windirstat treesize scan scanner full out of space free up cleanup clean delete reveal explorer what is filling",
    open: () => switchMainView("disk-space"),
    active: () => state.activeView === "disk-space",
  },
  // Encode / hash / JWT / time / format tools: one shared host, many pins.
  ...((window.wintUtilTools?.catalog?.() || []).map((tool) => ({
    id: tool.id,
    name: tool.name,
    icon: tool.icon,
    hint: tool.hint,
    keywords: tool.keywords,
    open: () => openUtilTool(tool.id),
    active: () => state.activeView === "tools" && state.utilToolId === tool.id,
  }))),
  ...((window.wintWindowsTools?.catalog?.() || []).map((tool) => ({
    id: tool.id,
    name: tool.name,
    icon: tool.icon,
    hint: tool.hint,
    keywords: tool.keywords,
    open: () => openWindowsTool(tool.id),
    active: () => state.activeView === "windows-tools" && state.windowsToolId === tool.id,
  }))),
];

/** Destinations that are not pinnable tools. They still occupy the main area
 *  and answer to search like tools; Overview is the home destination. */
const PLACES = [
  {
    id: "overview",
    name: "Overview",
    icon: "dashboard",
    hint: "projects, git status and tech at a glance",
    keywords: "overview projects home start main dashboard repos repositories folders workspace list all everything front page",
    open: () => switchMainView("overview"),
    active: () => state.activeView === "overview",
  },
  {
    id: "settings",
    name: "Settings",
    icon: "settings",
    hint: "folders to scan, theme, language and the terminal",
    keywords: "settings preferences options config configuration setup customise customize theme dark light appearance language locale translation folders scan roots directories terminal startup defaults",
    open: () => switchMainView("settings"),
    active: () => state.activeView === "settings",
  },
];

/** How many pins sit in the compact bar itself. "More" promotes the pins to
 *  their dedicated wrapping shelf, so no navigation depends on an overlay. */
const DOCK_PINS = 4;

/** How many recently opened tools Ctrl+K keeps at the top of the list. */
const TOOL_RECENT_MAX = 12;

/** Keep the native tray menu aligned with the same recency list as Ctrl+K.
 * Places such as Settings are omitted: these shortcuts are specifically for
 * opening tools. */
function syncRecentTrayTools() {
  const tools = state.toolRecent
    .map((id) => toolById(id))
    .filter(Boolean)
    .slice(0, 6)
    .map(({ id, name }) => ({ id, name }));
  invoke("tray_set_recent_tools", { tools }).catch(() => {});
}

function toolById(id) {
  return TOOLS.find((tool) => tool.id === id) || null;
}

/** The tool currently on screen, or null when the overview is. Only a tool can
 *  be pinned from the header, and only a tool lights up its chip. */
function activeTool() {
  if (state.activeView === "isolated-tool") return toolById(state.isolatedToolId);
  return TOOLS.find((tool) => tool.active()) || null;
}

function isToolPinned(id) {
  return state.toolPins.includes(id);
}

/** Record that a tool or place was opened, so the next empty Ctrl+K leads with
 *  it. Overview is home, not a destination worth promoting. */
function rememberToolUse(id) {
  if (!id || id === "overview") return;
  if (!toolById(id) && !PLACES.some((place) => place.id === id)) return;
  const next = [id, ...state.toolRecent.filter((entry) => entry !== id)].slice(0, TOOL_RECENT_MAX);
  if (next.length === state.toolRecent.length && next.every((entry, index) => entry === state.toolRecent[index])) {
    return;
  }
  state.toolRecent = next;
  savePrefs();
  syncRecentTrayTools();
}

/** New pins go on the end. Dragging a pin is the explicit way to change its
 *  position and therefore the Ctrl+number shortcut attached to it. */
function toggleToolPin(id) {
  const tool = toolById(id);
  if (!tool) return;
  const pinned = isToolPinned(id);
  state.toolPins = pinned
    ? state.toolPins.filter((pin) => pin !== id)
    : [...state.toolPins, id];
  savePrefs();
  beginWork("tool-pin", pinned ? `Unpinned ${tool.name}` : `Pinned ${tool.name}`,
    pinned ? "gone from the status bar" : `status bar · Ctrl+${state.toolPins.length}`);
  setTimeout(() => endWork("tool-pin"), 1600);
  markDirty("pins");
}

/** Move a pin relative to another one. Its position is also its Ctrl+number,
 *  so the new order is persisted and every place that shows shortcuts redraws. */
function reorderToolPin(id, targetId, after = false) {
  if (id === targetId || !isToolPinned(id) || !isToolPinned(targetId)) return;
  const next = state.toolPins.filter((pin) => pin !== id);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex < 0) return;
  next.splice(targetIndex + (after ? 1 : 0), 0, id);
  if (next.every((pin, index) => pin === state.toolPins[index])) return;
  state.toolPins = next;
  savePrefs();
  const tool = toolById(id);
  beginWork("tool-pin-order", `Moved ${tool?.name || "tool"}`, `pin ${next.indexOf(id) + 1}`);
  setTimeout(() => endWork("tool-pin-order"), 1200);
  markDirty("pins");
}

function moveToolPin(id, direction) {
  const index = state.toolPins.indexOf(id);
  const target = state.toolPins[index + direction];
  if (!target) return;
  reorderToolPin(id, target, direction > 0);
}

/** Taking a tool out of the bar while you are looking at it reads as closing
 *  it - there is nothing else the cross on its chip could mean - so it does
 *  both. The pin button in a tool's own header stays a pin and nothing more:
 *  it has a close button of its own sitting next to it. */
function unpinTool(id) {
  if (!isToolPinned(id)) return;
  const leaving = Boolean(activeTool()) && activeTool().id === id;
  toggleToolPin(id);
  if (leaving) openTool("overview");
}

function openTool(id) {
  const target = toolById(id) || PLACES.find((place) => place.id === id);
  if (!target) return;
  closeToolPins();
  rememberToolUse(id);
  if (toolById(id) && isToolPopped(id)) {
    focusToolPopout(id);
    markDirty("pins");
    return;
  }
  if (toolById(id)) {
    openIsolatedTool(id);
    markDirty("pins");
    return;
  }
  // Set this before calling foreign tool code. If it blocks the UI thread,
  // the timeout cannot clear the marker and restart recovery stays armed.
  if (toolById(id)) armToolRecovery("tool", id);
  try {
    target.open();
  } catch (error) {
    console.error(`Could not open tool ${id}`, error);
    state.activeView = "overview";
    savePrefs();
    syncMainView();
    beginWork("tool-open-fail", `${target.name} could not open`, "Returned to Overview");
    setTimeout(() => endWork("tool-open-fail"), 5000);
  }
  markDirty("pins");
}

/** Shared isolation frame: the shell owns all navigation chrome while the
 * child webview receives only a body rectangle. It cannot cover or disable
 * Back, Close, Home, Search, pins, or the status bar. */
function openIsolatedTool(id) {
  const tool = toolById(id);
  if (!tool) return;
  state.isolatedToolId = id;
  // Reuses the session of a tool that is still resident, so its webview keeps
  // answering the shell rather than being orphaned by a freshly rolled one.
  state.isolatedToolSession = sessionForTool(id);
  state.activeView = "isolated-tool";
  state.selectedPath = null;
  savePrefs();
  syncSettingsButton();
  renderIsolatedToolChrome(tool);
  syncMainView();
  window.wintTrackPageView?.(`/tools/${id}`);
}

function renderIsolatedToolChrome(tool = toolById(state.isolatedToolId)) {
  const host = el["isolated-tool-host"];
  if (!host || !tool) return;
  host.querySelector("[data-isolated-icon]").innerHTML = icon(tool.icon);
  host.querySelector("[data-isolated-name]").textContent = tool.name;
  host.querySelector("[data-isolated-hint]").textContent = tool.hint;
  const pin = host.querySelector("[data-pin-tool]");
  pin.dataset.pinTool = tool.id;
  pin.classList.toggle("on", isToolPinned(tool.id));
  pin.innerHTML = `${icon("push_pin")}${isToolPinned(tool.id) ? "Pinned" : "Pin"}`;
  const popout = host.querySelector("[data-popout-tool]");
  popout.dataset.popoutTool = tool.id;
  popout.innerHTML = `${icon("open_in_new")}Pop out`;
}

function isToolPopped(id) {
  return state.toolPopouts.includes(id);
}

function rememberToolPopout(id, open) {
  const next = open
    ? [...state.toolPopouts.filter((pin) => pin !== id), id]
    : state.toolPopouts.filter((pin) => pin !== id);
  if (next.length === state.toolPopouts.length && next.every((pin, index) => pin === state.toolPopouts[index])) {
    return;
  }
  state.toolPopouts = next;
  savePrefs();
  markDirty("pins");
}

/** Hand a tool to its own window the way a terminal tab pops out. The main
 *  view lets go immediately; the window remounts the tool on its own. */
const toolPopoutsOpening = new Set();

function popOutTool(id, screenX, screenY) {
  const tool = toolById(id);
  if (!tool) return;
  if (toolPopoutsOpening.has(id)) return;
  if (isToolPopped(id)) {
    void focusToolPopout(id);
    return Promise.resolve();
  }
  toolPopoutsOpening.add(id);
  // Deliberately detach the handoff from the click handler. State persistence,
  // native window creation and renderer startup must never hold the shell's UI
  // interaction path open.
  void completeToolPopout(tool, screenX, screenY);
  return Promise.resolve();
}

async function completeToolPopout(tool, screenX, screenY) {
  const id = tool.id;
  const leaving = activeTool()?.id === id;
  const leavingSession = leaving && state.activeView === "isolated-tool" ? state.isolatedToolSession : "";
  rememberToolPopout(id, true);
  const key = `tool-popout:${id}`;
  beginWork(key, `Opening ${tool.name} in its own window`);
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  let unlistenReady = () => {};
  try {
    unlistenReady = await listen("tool:ready", (event) => {
      if (event.payload?.id === id) readyResolve(true);
    });
    if (leaving) {
      if (id === "disk-space") window.wintDiskSpace?.preparePopout?.();
      if (state.activeView === "isolated-tool") await flushIsolatedToolState();
      else await window.wintToolState?.send?.(id);
    }
    // The tool is moving into a window of its own. Its embedded copy must go
    // rather than linger in the cache, or docking back would restore a stale
    // one holding state from before the pop-out.
    await evictEmbeddedTool(id);
    await invoke("tool_popout", {
      id,
      title: tool.name,
      theme: state.theme === "light" ? "light" : "dark",
      x: Number.isFinite(screenX) ? screenX - 80 : null,
      y: Number.isFinite(screenY) ? screenY - 18 : null,
    });
    const mounted = await Promise.race([
      ready,
      new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
    ]);
    if (!mounted) throw new Error(`${tool.name} did not finish opening.`);
    // Do not steal navigation if the user used Back, Close, Home or Search
    // while the new window was opening.
    if (leaving && activeTool()?.id === id && (!leavingSession || state.isolatedToolSession === leavingSession)) {
      openTool("overview");
    }
  } catch (error) {
    rememberToolPopout(id, false);
    await invoke("tool_dock", { id }).catch(() => {});
    if (leaving && state.activeView === "isolated-tool" && state.isolatedToolId === id) syncEmbeddedTool();
    beginWork("tool-popout-fail", `Could not pop ${tool.name} out`, String(error));
    setTimeout(() => endWork("tool-popout-fail"), 4000);
  } finally {
    unlistenReady();
    toolPopoutsOpening.delete(id);
    endWork(key);
  }
}

async function flushIsolatedToolState() {
  const session = state.isolatedToolSession;
  if (!session) return false;
  const commandId = `${session}:${Date.now()}`;
  let unlistenResult = () => {};
  const done = new Promise(async (resolve) => {
    unlistenResult = await listen("tool:bridge-command-result", (event) => {
      if (event.payload?.session === session && event.payload?.commandId === commandId) resolve(event.payload.ok === true);
    });
    await emit("tool:bridge-command", { session, commandId, action: "persist" }).catch(() => resolve(false));
  });
  const result = await Promise.race([done, new Promise((resolve) => setTimeout(() => resolve(false), 1200))]);
  unlistenResult();
  return result;
}

async function focusToolPopout(id) {
  try {
    await invoke("tool_focus", { id });
  } catch {
    rememberToolPopout(id, false);
    await popOutTool(id);
  }
}

async function dockToolPopout(id) {
  rememberToolPopout(id, false);
  await invoke("tool_dock", { id }).catch(() => {});
  // Always re-enter through the central router. Calling `tool.open()` here
  // bypasses isolation policy and can expose a shared host's previous child
  // (for Windows tools that was usually Event Stream).
  if (toolById(id)) openTool(id);
}

async function restoreToolPopouts() {
  const ids = [...state.toolPopouts];
  for (const id of ids) {
    const tool = toolById(id);
    if (!tool) {
      rememberToolPopout(id, false);
      continue;
    }
    try {
      await invoke("tool_popout", {
        id,
        title: tool.name,
        theme: state.theme === "light" ? "light" : "dark",
        x: null,
        y: null,
      });
    } catch {
      rememberToolPopout(id, false);
    }
  }
}

function toolPinsOpen() {
  return state.toolPinsOpen;
}

function closeToolPins() {
  if (!state.toolPinsOpen) return;
  state.toolPinsOpen = false;
  markDirty("pins");
}

/* ------------------------------------------------------ search commands */

/** The icon that stands for each kind of palette row. Every row carries one -
 *  a row without one reads as a hole in the list. */
const COMMAND_KIND_ICONS = {
  TOOL: "handyman",
  GOTO: "arrow_forward",
  CMD: "bolt",
  KILL: "stop_circle",
  TERM: "code",
  VIEW: "filter_alt",
  REPO: "folder_open",
  RUN: "play_arrow",
  PULL: "download",
};

function availableSearchCommands(query = "") {
  const commands = [
    // Catalog order here is irrelevant: renderSearchCommands re-ranks by
    // latest used, then how well the query matches the name.
    ...TOOLS.map((tool) => ({
      kind: "TOOL", label: tool.name, icon: tool.icon,
      detail: isToolPinned(tool.id) ? `pin ${state.toolPins.indexOf(tool.id) + 1} · ${tool.hint}` : tool.hint,
      // "tool" / "tools" are how you ask for the catalog, not a word any one
      // tool's name has to carry.
      keywords: `tool tools ${tool.keywords || ""}`, action: "tool", toolId: tool.id,
    })),
    ...PLACES.map((place) => ({
      kind: "GOTO", label: place.name, icon: place.icon, detail: place.hint,
      keywords: place.keywords, action: "tool", toolId: place.id,
    })),
    { kind: "CMD", label: "Rescan projects", detail: "F5", keywords: "rescan re-scan scan refresh reload reread update projects folders f5", action: "rescan" },
    { kind: "TERM", label: "Toggle terminal panel", detail: "Ctrl+`", keywords: "terminal panel console shell prompt powershell cmd bash toggle show hide open command line", action: "terminal-panel" },
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
      commands.push({ kind: "RUN", label: `Run ${project.name}`, detail: project.runCmd, keywords: "run start launch serve dev server npm yarn pnpm cargo start up", action: "run", project });
    }
    commands.push({
      kind: "TERM", label: `Terminal — ${project.name}`, detail: project.path,
      keywords: "terminal shell console prompt powershell cmd bash open here cd",
      action: "terminal", project,
    });
    if (project.git) {
      commands.push({
        kind: "PULL", label: `Pull ${project.name}`, keywords: "pull fetch update sync git download latest remote origin",
        detail: project.git.upstream || project.git.branch || "git pull",
        action: "pull", project,
      });
    }
  }
  if (/\bkill\b/i.test(query)) {
    for (const row of state.ports) {
      const ports = (row.ports || []).map((binding) => binding.port);
      commands.push({
        kind: "KILL",
        label: `Kill ${portProcessName(row)} (PID ${row.pid})`,
        detail: [ports.length ? `port${ports.length === 1 ? "" : "s"} ${ports.join(", ")}` : "no ports", row.cwd || row.executablePath].filter(Boolean).join(" · "),
        action: "kill-process",
        process: row,
      });
    }
  }
  return commands;
}

/** Tools that always appear in an empty Ctrl+K list, after latest-used. Help
 *  has to be reachable without already knowing its name. */
const SEARCH_ALWAYS = new Set(["help"]);

/** Empty Ctrl+K is latest-used, plus Help. Pins live on the status bar; typing
 *  still finds every tool. */
function searchCommandVisibleWhenEmpty(command) {
  const id = command.toolId;
  if (!id) return false;
  if (command.kind !== "TOOL" && command.kind !== "GOTO") return false;
  return state.toolRecent.includes(id) || SEARCH_ALWAYS.has(id);
}

/** How well a row matches what was typed. Name beats detail beats keywords, so
 *  a stray keyword hit cannot outrank the tool you meant. Kind counts too:
 *  typing "tool" is asking for the TOOL rows, not a substring in a path. */
function searchCommandMatchScore(command, terms) {
  if (!terms.length) return 0;
  const label = command.label.toLowerCase();
  const detail = (command.detail || "").toLowerCase();
  const keywords = (command.keywords || "").toLowerCase();
  const kind = (command.kind || "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (kind === term || (term === "tools" && kind === "tool")) score += 80;
    else if (label === term) score += 100;
    else if (label.startsWith(term)) score += 50;
    else if (label.includes(term)) score += 30;
    else if (detail.includes(term)) score += 10;
    else if (keywords.includes(term)) score += 5;
  }
  return score;
}

/** Sort key: latest used first, then always-shown destinations (Help), then
 *  match score. Pins do not reorder search. */
function searchCommandRank(command) {
  const id = command.toolId;
  if (id) {
    const recent = state.toolRecent.indexOf(id);
    if (recent >= 0) return [0, recent];
    if (SEARCH_ALWAYS.has(id)) return [1, 0];
  }
  return [2, 0];
}

function compareSearchCommands(a, b, terms) {
  const ra = searchCommandRank(a);
  const rb = searchCommandRank(b);
  if (ra[0] !== rb[0]) return ra[0] - rb[0];
  if (ra[1] !== rb[1]) return ra[1] - rb[1];
  if (terms.length) {
    const diff = searchCommandMatchScore(b, terms) - searchCommandMatchScore(a, terms);
    if (diff) return diff;
  }
  return String(a.label).localeCompare(String(b.label));
}

/** What the search box is actually searching for. A leading ">" is the
 *  command prefix, not part of the words - it opens the palette and is
 *  otherwise ignored, so ">term" narrows the commands without emptying the
 *  project list behind them. */
function searchQuery(value = el["search-input"]?.value || "") {
  return value.replace(/^>\s*/, "");
}

let nativeSearchQuery = "";

function rankedSearchCommands(query = "") {
  const terms = searchQuery(query).toLowerCase().trim().split(/\s+/).filter(Boolean);
  const browsing = terms.length === 0;
  return availableSearchCommands(query)
    .filter((command) => {
      if (browsing) return searchCommandVisibleWhenEmpty(command);
      const hay = `${command.kind} ${command.label} ${command.detail} ${command.keywords || ""}`.toLowerCase();
      return terms.every((term) => hay.includes(term));
    })
    .sort((a, b) => compareSearchCommands(a, b, terms))
    .slice(0, 60);
}

function publishNativeSearch(query = nativeSearchQuery) {
  nativeSearchQuery = query;
  searchCommands = rankedSearchCommands(query);
  emit("search:results", {
    query,
    theme: state.theme,
    rows: searchCommands.map((command) => ({
      kind: command.kind,
      label: command.label,
      detail: command.detail || "",
      icon: command.icon || COMMAND_KIND_ICONS[command.kind] || "chevron_right",
      toolId: command.toolId || "",
      pinnable: command.action === "tool" && Boolean(toolById(command.toolId)),
      pinned: Boolean(command.toolId && isToolPinned(command.toolId)),
    })),
  }).catch(() => {});
}

function activateNativeSearch() {
  publishNativeSearch(nativeSearchQuery);
  emit("search:activate", { query: nativeSearchQuery, theme: state.theme }).catch(() => {});
}

function openSearchCommands({ fresh = false, initialQuery = "", position = null } = {}) {
  if (fresh) nativeSearchQuery = initialQuery;
  invoke("search_show", {
    theme: state.theme === "light" ? "light" : "dark",
    x: position?.x ?? null,
    y: position?.y ?? null,
  })
    .then(activateNativeSearch)
    .catch((error) => {
      beginWork("search-open-fail", "Search could not open", String(error));
      setTimeout(() => endWork("search-open-fail"), 4000);
    });
}

function renderSearchCommands() {
  const menu = el["search-menu"];
  const input = el["search-input"];
  if (!menu || document.activeElement !== input) return;
  const query = searchQuery(input.value);
  const killQuery = /\bkill\b/i.test(query);
  if (killQuery && !state.ports.length && !state.portsLoading && !state.portsError) loadPorts();
  const browsing = searchQuery(query).trim().length === 0;
  searchCommands = rankedSearchCommands(query);
  searchCommandIndex = Math.min(searchCommandIndex, Math.max(0, searchCommands.length - 1));
  menu.innerHTML = searchCommands.length
    ? searchCommands.map((command, index) => {
      // Only a tool can be pinned, and the pin sits on the row itself: finding
      // a tool and keeping it are the same gesture, one key apart.
      const pinnable = command.action === "tool" && Boolean(toolById(command.toolId));
      const pinned = pinnable && isToolPinned(command.toolId);
      return `<div class="search-row"><button class="search-command${
        index === searchCommandIndex ? " on" : ""
      }" data-command="${index}"><span class="command-kind kind-${command.kind.toLowerCase()}" title="${esc(
        command.kind
      )}">${icon(command.icon || COMMAND_KIND_ICONS[command.kind] || "chevron_right")}</span><span
        class="command-label">${esc(command.label)}</span><span class="command-detail">${esc(
        command.detail
      )}</span></button>${pinnable ? `<button class="search-pin${pinned ? " on" : ""}" data-pin-tool="${esc(
        command.toolId
      )}" title="${pinned ? "Unpin from the status bar" : "Pin to the status bar"}" aria-pressed="${pinned}">${icon(
        pinned ? "push_pin" : "add"
      )}</button>` : `<span class="search-pin-slot"></span>`}</div>`;
    }).join("")
    : `<div class="search-command-empty">${browsing
      ? "Type to find a tool"
      : killQuery && state.portsLoading
      ? "Finding processes…"
      : killQuery && state.portsError
      ? `Could not read processes: ${esc(state.portsError)}`
      : "No commands, projects or processes found"}</div>`;
  menu.hidden = false;
  menu.querySelector(".search-command.on")?.scrollIntoView({ block: "nearest" });
}

function closeSearchCommands() {
  if (el["search-menu"]) el["search-menu"].hidden = true;
  invoke("search_hide").catch(() => {});
}

function runSearchCommand(index) {
  const command = searchCommands[index];
  if (!command) return;
  closeSearchCommands();
  state.search = "";
  el["search-input"].value = "";
  markDirty("grid", "filters");
  if (command.action === "tool") openTool(command.toolId);
  else if (command.action === "rescan") rescan();
  else if (command.action === "terminal-panel") openTerminalPanel();
  else if (command.action === "filter") {
    if (state.activeView !== "overview") switchMainView("overview");
    toggleFilter(command.key);
  } else if (command.action === "repo") {
    if (state.activeView !== "overview") switchMainView("overview");
    openDetail(command.project);
  }
  else if (command.action === "run") projectAction("run", command.project);
  else if (command.action === "terminal") projectAction("terminal", command.project);
  else if (command.action === "pull") projectAction("pull", command.project);
  else if (command.action === "kill-process") {
    if (state.activeView !== "ports") switchMainView("ports");
    // The palette names a process; the explorer talks in ports, so the row it
    // opens is the first port that process holds - or the process itself when
    // it holds none.
    const port = (command.process.ports || [])[0];
    const key = `:`;
    state.portSelected = key;
    state.portKill = { key, tree: true };
    markDirty("ports");
  }
}

/* ------------------------------------------------------------- hotkeys */

const HOTKEY_DEFAULTS = {
  "command:palette": "Ctrl+K", "command:rescan": "F5", "command:terminal-panel": "Ctrl+`",
  "tool:ports": "Ctrl+Shift+P", "tool:network": "Ctrl+Shift+N",
  "tool:registry": "Ctrl+Shift+R", "tool:clipboard": "Ctrl+Shift+V",
  "tool:github": "Ctrl+Shift+G", "tool:git": "Ctrl+Alt+G",
};

function hotkeyCatalog() {
  const projectCommands = [];
  for (const project of state.projects.filter((item) => !item.pending)) {
    const add = (action, name, iconName, hint) => projectCommands.push({
      id: `project:${project.path}:${action}`, kind: "project", name: `${name} ${project.name}`,
      icon: iconName, hint, action: () => projectAction(action, project),
    });
    add("open", "Open project —", "folder_open", project.path);
    add("vscode", "Open in VS Code —", "code", project.path);
    add("terminal", "Open terminal —", "terminal", project.path);
    add("explorer", "Open in Explorer —", "folder_open", project.path);
    add("external", "Open external shell —", "open_in_new", project.path);
    add("copy", "Copy path —", "content_copy", project.path);
    add(
      "favorite",
      isFavorite(project.path) ? "Unstar project —" : "Star project —",
      isFavorite(project.path) ? "star" : "star_border",
      project.path
    );
    if (project.runCmd) add("run", "Run —", "play_arrow", project.runCmd);
    if (project.git) add("pull", "Pull —", "download", project.git.upstream || project.git.branch || "git pull");
  }
  return [
    ...TOOLS.map((tool) => ({ id: `tool:${tool.id}`, kind: "tool", name: tool.name, icon: tool.icon, hint: tool.hint, action: () => openTool(tool.id) })),
    { id: "command:palette", kind: "global", name: "Command palette", icon: "search", hint: "Find any command, tool or action", action: () => openSearchCommands({ fresh: true }) },
    { id: "command:rescan", kind: "global", name: "Rescan projects", icon: "refresh", hint: "Scan every configured project folder again", action: () => rescan() },
    { id: "command:terminal-panel", kind: "global", name: "Toggle terminal panel", icon: "terminal", hint: "Show or hide docked terminals", action: () => setDockOpen(!window.termsState.open) },
    ...Object.entries(FILTERS).map(([key, filter]) => ({
      id: `filter:${key}`, kind: "action", name: `Toggle ${filter.label.toLowerCase()}`,
      icon: key === "favorite" ? "star" : "filter_alt", hint: "Show or hide this project filter", action: () => toggleFilter(key),
    })),
    ...projectCommands,
  ];
}

function hotkeyBinding(id) {
  return Object.prototype.hasOwnProperty.call(state.hotkeys, id) ? state.hotkeys[id] : (HOTKEY_DEFAULTS[id] || "");
}

function hotkeyFromEvent(e) {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return "";
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  const names = { " ": "Space", Escape: "Esc", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };
  let key = names[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  if (key === "+") key = "Plus";
  if (!key) return "";
  parts.push(key);
  return parts.join("+");
}

function hotkeyConflicts() {
  const bindings = new Map();
  for (const command of hotkeyCatalog()) {
    const binding = hotkeyBinding(command.id);
    if (!binding) continue;
    bindings.set(binding, [...(bindings.get(binding) || []), command.id]);
  }
  return new Set([...bindings.values()].filter((ids) => ids.length > 1).flat());
}

const globalHotkeyErrors = new Map();
async function syncGlobalHotkeys() {
  const api = window.__TAURI__?.globalShortcut;
  if (!api) return;
  globalHotkeyErrors.clear();
  try { await api.unregisterAll(); } catch { /* nothing registered yet */ }
  const catalog = hotkeyCatalog();
  const paletteBinding = state.hotkeyGlobals.has("command:palette") ? hotkeyBinding("command:palette") : "";
  if (paletteBinding) {
    try { await invoke("search_prepare"); }
    catch (error) { globalHotkeyErrors.set("command:palette", String(error)); }
  }
  await invoke("search_global_binding_set", { binding: paletteBinding }).catch((error) => {
    globalHotkeyErrors.set("command:palette", String(error));
  });
  for (const command of catalog) {
    if (!state.hotkeyGlobals.has(command.id)) continue;
    const binding = hotkeyBinding(command.id);
    if (!binding) continue;
    try {
      await api.register(binding, async (event) => {
        if (event.state && event.state !== "Pressed") return;
        // The native palette is intentionally usable without surfacing the
        // main window. Other global commands still bring their working context
        // forward before executing.
        if (command.id !== "command:palette") {
          await appWindow.show().catch(() => {});
          await appWindow.unminimize().catch(() => {});
          await appWindow.setFocus().catch(() => {});
        }
        command.action();
      });
    } catch (error) {
      globalHotkeyErrors.set(command.id, String(error));
    }
  }
  if (state.activeView === "settings" && state.settingsSection === "hotkeys") {
    const conflicts = hotkeyConflicts();
    for (const command of hotkeyCatalog()) {
      const row = el["settings-host"]?.querySelector(`[data-hotkey-global="${CSS.escape(command.id)}"]`)?.closest(".hotkey-row");
      if (!row) continue;
      const error = globalHotkeyErrors.get(command.id);
      row.classList.toggle("conflict", Boolean(error) || conflicts.has(command.id));
      const detail = row.querySelector(".hotkey-command small");
      if (detail) detail.textContent = error || command.hint;
    }
  }
}

function renderHotkeys(host) {
  const section = host.querySelector('[data-section="hotkeys"]');
  if (!section) return;
  const catalog = hotkeyCatalog();
  const conflicts = hotkeyConflicts();
  const query = state.hotkeyQuery.trim().toLowerCase();
  const filtered = catalog.filter((command) => {
    const binding = hotkeyBinding(command.id);
    if (query && !`${command.name} ${command.hint} ${binding}`.toLowerCase().includes(query)) return false;
    if (state.hotkeyFilter === "tools" && command.kind !== "tool") return false;
    if (state.hotkeyFilter === "actions" && command.kind === "tool") return false;
    if (state.hotkeyFilter === "unbound" && binding) return false;
    if (state.hotkeyFilter === "conflicts" && !conflicts.has(command.id)) return false;
    return true;
  });
  const counts = { all: catalog.length, tools: catalog.filter((c) => c.kind === "tool").length, actions: catalog.filter((c) => c.kind !== "tool").length, unbound: catalog.filter((c) => !hotkeyBinding(c.id)).length, conflicts: conflicts.size };
  section.innerHTML = `<div class="hotkeys-head"><div><h3>Hotkeys</h3><p>Bind anything the command palette can find — tools and global actions.</p></div><button class="btn" type="button" data-hotkeys-restore>${icon("restart_alt")}Restore defaults</button></div>
    <div class="hotkeys-toolbar"><label>${icon("search")}<input id="hotkey-search" value="${esc(state.hotkeyQuery)}" placeholder="Search commands, tools and actions" spellcheck="false"><span class="mono">${filtered.length}/${catalog.length}</span></label><div class="hotkey-filters">${Object.entries(counts).map(([id, count]) => `<button type="button" data-hotkey-filter="${id}" class="${state.hotkeyFilter === id ? "on" : ""}">${id[0].toUpperCase() + id.slice(1)} <span>${count}</span></button>`).join("")}</div></div>
    <div class="hotkey-list-head"><span>Command</span><span>Type</span><span>Binding</span><span>System-wide</span><span></span></div>
    <div class="hotkey-list">${filtered.length ? filtered.map((command) => {
      const binding = hotkeyBinding(command.id);
      const recording = state.hotkeyRecording === command.id;
      const keys = binding ? binding.split("+").map((part) => `<kbd>${esc(part)}</kbd>`).join("") : "Unbound";
      const global = state.hotkeyGlobals.has(command.id);
      const error = globalHotkeyErrors.get(command.id);
      return `<div class="hotkey-row${conflicts.has(command.id) || error ? " conflict" : ""}"><span class="hotkey-command">${icon(command.icon)}<span><strong>${esc(command.name)}</strong><small>${esc(error || command.hint)}</small></span></span><span class="hotkey-scope">${command.kind === "tool" ? "Tool" : "Action"}</span><button type="button" class="hotkey-binding${recording ? " recording" : ""}" data-hotkey-record="${esc(command.id)}">${recording ? "Press a shortcut…" : keys}</button><label class="hotkey-global" title="Make this shortcut work while WinT is unfocused"><input type="checkbox" data-hotkey-global="${esc(command.id)}"${global ? " checked" : ""}${binding ? "" : " disabled"}><span>Global</span></label><button type="button" class="hotkey-clear" data-hotkey-clear="${esc(command.id)}" title="Clear binding" ${binding ? "" : "disabled"}>${icon("backspace")}</button></div>`;
    }).join("") : `<div class="hotkey-empty">${icon("search_off")}Nothing matches this view.</div>`}</div>`;
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
  // Pull is only offered where it can mean something: a folder git knows about.
  const pull = p.git
    ? `<button class="cact" data-act="pull" title="Run git pull here">${icon(
        "download"
      )}Pull</button>`
    : "";
  return `<div class="card-actions">${run}
    <button class="cact" data-act="vscode" title="Open in VS Code">${icon("code")}Code</button>
    <button class="cact" data-act="terminal" title="Open a terminal here">${icon(
      "terminal"
    )}Terminal</button>${pull}
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
  const starred = isFavorite(p.path);
  const fav = `<button class="card-fav${starred ? " on" : ""}" data-act="favorite" title="${
    starred ? "Remove from favorites" : "Add to favorites"
  }" aria-pressed="${starred}">${icon(starred ? "star" : "star_border")}</button>`;

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
      <div class="card-top-end">${live}${fav}</div>
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
    return `<button class="table-tech" data-tech="${esc(item.name)}" title="${esc(full)}"><span class="table-tech-row"><span class="table-tech-name">${esc(item.name)}</span>${
      item.version ? `<code>${esc(item.version)}</code>` : ""
    }</span></button>`;
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
  const starred = isFavorite(p.path);
  return `<tr class="project-row" data-path="${esc(p.path)}">
    <td><strong title="${esc(p.name)}">${esc(p.name)}</strong><small title="${esc(demoPath(p))}">${esc(demoPath(p))}</small></td>
    ${state.tableColumns.includes("version") ? `<td class="project-version">${p.version ? esc(p.version) : "—"}</td>` : ""}
    ${technologyCells}
    ${state.tableColumns.includes("status") ? `<td class="table-status-cell" title="${esc(statusTitle)}"><div class="table-status-list">${statuses.join("")}</div></td>` : ""}
    <td class="table-actions-cell"><div class="table-actions">
      <button class="table-fav${starred ? " on" : ""}" data-act="favorite" title="${
        starred ? "Remove from favorites" : "Add to favorites"
      }" aria-pressed="${starred}">${icon(starred ? "star" : "star_border")}</button>
      <button data-act="run" title="${p.runCmd ? `Run ${esc(p.runCmd)}` : "No run command detected"}" ${p.runCmd ? "" : "disabled"}>${icon("play_arrow")}</button>
      <button data-act="vscode" title="Open in VS Code">${icon("code")}</button>
      <button data-act="terminal" title="Open a terminal">${icon("terminal")}</button>
      ${p.git ? `<button data-act="pull" title="Run git pull here">${icon("download")}</button>` : ""}
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
  const starred = isFavorite(p.path);

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
      <button class="win-btn detail-fav${starred ? " on" : ""}" data-act="favorite" title="${
        starred ? "Remove from favorites" : "Add to favorites"
      }" aria-pressed="${starred}">${icon(starred ? "star" : "star_border")}</button>
      <button class="win-btn" data-act="close" title="Close">${icon("close")}</button>
    </div>
    <div class="detail-actions">
      ${run}
      <button class="btn" data-act="vscode">${icon("code")}VS Code</button>
      <button class="btn" data-act="terminal">${icon("terminal")}Terminal</button>
      ${g ? `<button class="btn" data-act="pull" title="Run git pull here">${icon("download")}Pull</button>` : ""}
      ${g ? `<button class="btn" data-act="git" title="Open this repository in the Git tool">${icon("commit")}Git</button>` : ""}
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
  if (regions.has("ports")) renderPorts();
  if (regions.has("dns")) window.wintDns?.render();
  if (regions.has("hosts")) window.wintHosts?.render();
  if (regions.has("network")) window.wintNetwork?.render();
  if (regions.has("path-ping")) window.wintPathPing?.render();
  if (regions.has("disk-space")) window.wintDiskSpace?.render();
  if (regions.has("tools")) {
    window.wintUtilTools?.render();
    syncToolHeads();
  }
  if (regions.has("pins")) renderPins();
}

/** The shell is built once. Inputs live for the lifetime of the window, so
 *  focus, selection and IME state are never disturbed by a redraw. */
function mountShell() {
  document.getElementById("root").innerHTML = `
    <div class="titlebar">
      <div class="loading" id="loadbar" hidden><i></i></div>
      <div class="drag">
        <div class="brand"><img src="wint-icon.png" alt="" /><span>WinT</span>
          <span class="sub" id="brand-sub"></span></div>
      </div>
      <button class="title-home" id="title-home" type="button"
              title="Overview" aria-label="Go to overview">${icon("home")}</button>
      <div class="field search" id="search-box">${icon("search")}
        <input id="search-input" spellcheck="false"
               placeholder="Search projects, tools and commands..." />
        <div class="search-menu" id="search-menu" hidden></div>
      </div>
      <div class="drag drag-fill"></div>
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
        <button class="win-btn" data-win="tray" title="Minimize to tray" aria-label="Minimize to tray"${state.minimizeToTrayButton ? "" : " hidden"}>${icon("move_to_inbox")}</button>
        <button class="win-btn" data-win="min">${icon("remove")}</button>
        <button class="win-btn" data-win="max">${icon("crop_square")}</button>
        <button class="win-btn close" data-win="close">${icon("close")}</button>
      </div>
    </div>

    <div class="summary" id="summary">
      <div class="summary-stats" id="summary-stats"></div>
      <div class="roots summary-roots" id="roots">
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
      <button class="btn primary summary-rescan" id="rescan">${icon("refresh")}<span class="label">Rescan</span></button>
      <div class="sort-buttons summary-sort" id="sort-buttons" aria-label="Sort projects">
        <button data-sort="activity" title="Sort by recent activity">Recent</button>
        <button data-sort="name" title="Sort by project name">Name</button>
        <button data-sort="changes" title="Sort by most changes">Changes</button>
        <button data-sort="running" title="Show running projects first">Running</button>
        <button data-sort="tech" title="Sort by technology">Tech</button>
      </div>
      <div class="sort-buttons view-buttons summary-view" id="view-buttons" aria-label="Project view">
        <button data-view="cards">Cards</button>
        <button data-view="table">Table</button>
      </div>
    </div>
    <div class="filters" id="filters">
      <div class="filter-chips" id="filter-chips"></div>
      <div class="tech-picker filter-tech" id="tech-picker">
        <button class="tech-button" id="tech-filter" type="button" aria-haspopup="listbox"
                title="Choose a technology to filter by" aria-expanded="false">${icon("category")}<span class="tech-button-label"
          id="tech-filter-label">All tech</span>${icon("keyboard_arrow_down")}</button>
        <button class="tech-clear" id="tech-clear" type="button" title="Clear the technology filter" hidden>${icon(
          "close"
        )}</button>
        <div class="tech-menu" id="tech-menu" role="listbox" hidden>
          <div class="tech-menu-search">${icon("search")}<input id="tech-menu-input"
            spellcheck="false" placeholder="Filter technologies..." /></div>
          <div class="tech-menu-list" id="tech-menu-list"></div>
        </div>
      </div>
    </div>
    <div id="banner-host"></div>
    <div class="scroll" id="scroll"><div class="grid" id="grid"></div></div>
    <main class="ports-page" id="ports-host" hidden>
      <header class="tool-head">
        <button class="btn back tool-back" type="button" data-open-tool="overview"
                title="Back to the overview">${icon("arrow_back")}Back</button>
        <span class="tool-plate">${icon("lan")}</span>
        <span class="tool-title">
          <strong>Process Explorer</strong>
          <small>ports, PIDs, what is holding :3000, and kill</small>
        </span>
        ${window.wintMaturity?.badge("ports") ?? ""}
        <button class="tool-popout" type="button" data-popout-tool="ports"></button>
        <button class="tool-pin" id="tool-pin-ports" type="button" data-pin-tool="ports"></button>
        <button class="tool-close" type="button" data-open-tool="overview"
                title="Back to the overview">${icon("close")}</button>
      </header>
      <div class="port-pins-wrap">
        <span class="port-pins-head">${icon("push_pin")}Pinned<i>·</i><small>click the pin on a port to keep it here</small></span>
        <div class="port-pins" id="port-pins"></div>
      </div>
      <div class="ports-body">
        <section class="ports-list-pane">
          <div class="ports-list-head">
            <label class="field ports-filter" for="port-filter-input">${icon("filter_alt")}
              <input id="port-filter-input" spellcheck="false" placeholder="Port, process, PID or project..." />
            </label>
            <div class="ports-list-tools">
              <div class="seg" id="port-tabs"></div>
              <div class="seg seg-sort" id="port-sort"></div>
              <button class="port-live" id="port-live" type="button" title="Pause the live readings"></button>
              <button class="btn ports-refresh" type="button" data-ports-refresh title="Read the process table again">${icon("refresh")}</button>
            </div>
          </div>
          <div class="ports-list" id="ports-list"></div>
        </section>
        <section class="ports-detail" id="ports-detail"></section>
      </div>
      <div id="ports-dialogs"></div>
    </main>
    <main class="dns-page" id="dns-host" hidden></main>
    <main class="hosts-page" id="hosts-host" hidden></main>
    <main class="net-page" id="network-host" hidden></main>
    <main class="path-page" id="path-ping-host" hidden></main>
    <main class="disk-page" id="disk-space-host" hidden></main>
    <main class="github-page" id="github-host" hidden></main>
    <main class="git-page" id="git-host" hidden></main>
    <main class="tools-page" id="tools-host" hidden></main>
    <main class="windows-tools-page" id="windows-tools-host" hidden></main>
    <main class="isolated-tool-page" id="isolated-tool-host" hidden>
      <header class="tool-head isolated-tool-head">
        <button class="btn back tool-back" type="button" data-open-tool="overview">${icon("arrow_back")}Back</button>
        <span class="tool-plate" data-isolated-icon></span>
        <span class="tool-title"><strong data-isolated-name></strong><small data-isolated-hint></small></span>
        <button class="tool-popout" type="button" data-popout-tool=""></button>
        <button class="tool-pin" type="button" data-pin-tool=""></button>
        <button class="tool-close" type="button" data-open-tool="overview" title="Back to the overview">${icon("close")}</button>
      </header>
      <div class="isolated-tool-slot" id="isolated-tool-slot">
        <div class="tool-loading" id="isolated-tool-loading" hidden>
          <div class="tool-loading-head">
            <span class="tool-loading-ring" aria-hidden="true"></span>
            <span class="tool-loading-title">
              <strong data-loading-name></strong>
              <small data-loading-phase></small>
            </span>
          </div>
          <div class="tool-loading-body" aria-hidden="true">
            <div class="tool-loading-row"><span class="tool-loading-bar" style="max-width:190px"></span><span class="tool-loading-bar" style="max-width:96px"></span></div>
            <div class="tool-loading-row"><span class="tool-loading-bar"></span></div>
            <div class="tool-loading-row"><span class="tool-loading-bar" style="max-width:320px"></span></div>
            <div class="tool-loading-row"><span class="tool-loading-bar" style="max-width:240px"></span></div>
          </div>
        </div>
      </div>
    </main>
    <main class="settings-page" id="settings-host" hidden></main>
    <div class="pins-panel" id="pins-panel" hidden></div>
    <div class="statusbar">
      <div class="activity" id="activity"></div>
      <div class="status-version-wrap" id="status-version-wrap">
        <button class="status-btn status-version" id="status-version" title="What's new in WinT"
                aria-haspopup="dialog" aria-expanded="false"></button>
        <div class="changelog-pop" id="changelog-pop" role="dialog" aria-label="What's new" hidden></div>
      </div>
      <div class="status-orphan-wrap" id="status-orphan-wrap" hidden>
        <button class="status-btn status-orphan" id="status-orphan" title="Processes left running after terminal closure" aria-haspopup="dialog" aria-expanded="false">${icon("warning")}<span>Still running</span><b>0</b></button>
        <div class="orphan-pop" id="orphan-pop" role="dialog" aria-label="Processes still running" hidden></div>
      </div>
      <div class="status-pins-wrap" id="status-pins-wrap">
        <div class="status-pins" id="status-pins"></div>
        <div class="pins-pop" id="pins-pop" role="dialog" aria-label="All pinned tools" hidden></div>
      </div>
      <button class="status-btn" id="toggle-assistant" title="Open AI assistant" aria-label="Open AI assistant" aria-pressed="false">${icon("auto_awesome")}<span class="label">AI</span></button>
      <button class="status-btn" id="status-term" title="Open a terminal" aria-expanded="false">${icon(
        "terminal"
      )}<span class="label">Terminal</span><span class="term-count" hidden>0</span></button>
      <button class="status-btn status-term-popout" id="status-term-popout" title="Open a terminal in its own window" aria-label="Open a terminal in its own window">${icon("open_in_new")}</button>
      <div class="act-bar" id="status-progress" hidden><i></i></div>
    </div>
    <div id="detail-host"></div>
    <aside id="assistant-host" class="assistant-panel" hidden></aside>
  `;

  for (const id of [
    "brand-sub", "loadbar", "roots-btn", "roots-label", "roots-pop", "roots-list",
    "rescan", "title-home", "search-input", "search-menu", "tech-picker", "tech-filter", "tech-filter-label",
    "tech-menu", "tech-menu-input", "tech-menu-list", "tech-clear", "sort-buttons", "view-buttons", "activity", "filters", "filter-chips",
    "banner-host", "summary", "summary-stats", "scroll", "grid", "ports-host", "dns-host", "hosts-host", "network-host", "path-ping-host", "disk-space-host", "github-host", "git-host", "tools-host", "windows-tools-host", "isolated-tool-host", "isolated-tool-slot", "port-filter-input", "port-pins", "port-tabs", "port-sort", "port-live", "ports-list", "ports-detail", "ports-dialogs", "detail-host", "settings-host", "open-settings", "toggle-theme",
    "status-term", "status-term-popout", "status-progress", "status-version", "changelog-pop",
    "status-pins-wrap", "status-pins", "pins-pop", "pins-panel",
  ]) {
    el[id] = document.getElementById(id);
  }

  // The native child is not part of CSS layout. Terminal docks, pin shelves,
  // toolbars and other shell regions can resize its slot without resizing the
  // OS window, so observe the slot itself and mirror every resulting rectangle.
  new ResizeObserver(() => syncEmbeddedTool()).observe(el["isolated-tool-slot"]);

  window.wintAssistant?.mount(document.getElementById("assistant-host"), document.getElementById("toggle-assistant"));

  // Tools that live in a file of their own build their own DOM, once, into the
  // host the shell has just made for them - before anything is drawn, so the
  // pin in their header is found by the same pass as every other one. A tool
  // that throws while mounting must not leave the window buttons unwired.
  try {
    window.wintDns?.mount(el["dns-host"]);
  } catch (err) {
    console.error("DNS tool failed to mount", err);
  }
  try {
    window.wintHosts?.mount(el["hosts-host"]);
  } catch (err) {
    console.error("Hosts file tool failed to mount", err);
  }
  try {
    window.wintNetwork?.mount(el["network-host"]);
  } catch (err) {
    console.error("Network tool failed to mount", err);
  }
  try { window.wintPathPing?.mount(el["path-ping-host"]); } catch (err) { console.error("Path Ping failed to mount", err); }
  try { window.wintDiskSpace?.mount(el["disk-space-host"]); } catch (err) { console.error("Disk Space Usage failed to mount", err); }
  try { window.wintGithub?.mount(el["github-host"]); } catch (err) { console.error("GitHub failed to mount", err); }
  try { window.wintGit?.mount(el["git-host"]); } catch (err) { console.error("Git failed to mount", err); }
  try { window.wintUtilTools?.mount(el["tools-host"]); } catch (err) { console.error("Util tools failed to mount", err); }
  try { window.wintWindowsTools?.mount(el["windows-tools-host"]); } catch (err) { console.error("Windows tools failed to mount", err); }

  el["search-input"].value = state.search;
  renderVersionButton();
  renderPins();
  wireShell();
  applyTheme();
  syncSettingsButton();
  window.syncTerminalButton?.();
  syncMainView();
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

  // The button says what is being filtered by; the list behind it is only
  // rebuilt while it is open, so a scan streaming in cannot redraw it underfoot.
  el["tech-filter-label"].textContent = state.techFilter || "All tech";
  if (techMenuOpen()) renderTechMenu();
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
  if (state.scannedAt) parts.push(`scanned at ${new Date(state.scannedAt).toLocaleTimeString()}`);
  return parts.join(" · ");
}

/* --------------------------------------------------------------- the dock

   Pins live in the status bar and nowhere else, so nothing in the window
   competes with search as the way to get around. The bar carries the first
   DOCK_PINS of them and pushes the rest into a panel that opens upward, which
   is why pinning can stay unlimited without the bar ever growing.

   A pin can be made in three places, and they are the three places you are
   standing when you want one: beside the row in search, in the header of the
   tool you are already looking at, and in the empty slot in the bar itself. */

/** Chips are read at a glance, so a long tool name is cut rather than allowed
 *  to push the terminal button off the end of the bar. */
function shortToolName(name) {
  return name.length > 16 ? `${name.slice(0, 15)}\u2026` : name;
}

function renderPins() {
  const host = el["status-pins"];
  if (!host) return;
  const pins = state.toolPins.map(toolById).filter(Boolean);
  const current = activeTool();
  // On its own shelf the row wraps, so there is nothing to hold back: every
  // pin is on screen and the overflow panel has no reason to exist.
  const shown = state.pinsPanel ? pins : pins.slice(0, DOCK_PINS);
  const overflow = pins.length - shown.length;
  // A panel with nothing left to show closes itself rather than opening empty.
  if (overflow <= 0) state.toolPinsOpen = false;

  // The chip is the tool, and the cross on the end of it is the way to be rid
  // of it. The shortcut number it used to carry now lives in the tooltip and in
  // the all-pins panel, where there is room to say what a number is for.
  const chips = shown.map((tool, index) => {
    const here = Boolean(current) && current.id === tool.id;
    const popped = isToolPopped(tool.id);
    const off = here ? `Unpin and close ${esc(tool.name)}` : `Unpin ${esc(tool.name)}`;
    // Only the first nine answer to a number, and a shelf holds far more than
    // nine, so the tenth chip onwards says its name and nothing about a key.
    const what = popped ? `${tool.name} — open in its own window` : tool.name;
    const tip = index < 9 ? `${what}${popped ? " · " : " — "}Ctrl+${index + 1}` : what;
    return `<span class="pin-chip${here ? " on" : ""}${popped ? " popped" : ""}" data-drag-pin="${esc(tool.id)}"><button class="pin-chip-go" type="button"
      data-open-tool="${esc(tool.id)}" title="${esc(tip)}">${
      icon(tool.icon)}<span>${esc(shortToolName(tool.name))}</span>${
      popped ? icon("open_in_new") : ""}</button><button class="pin-chip-off"
      type="button" data-unpin-tool="${esc(tool.id)}" title="${off}" aria-label="${off}">${
      icon("close")}</button></span>`;
  }).join("");

  const more = overflow > 0
    ? `<button class="pin-more" type="button" data-pins-more
        title="Show every pinned tool on the dedicated shelf">${icon("more_horiz")}${overflow} more</button>`
    : "";
  const compact = state.pinsPanel && pins.length > 0
    ? `<button class="pin-compact" type="button" data-pins-compact
        title="Return pinned tools to the compact status bar">${icon("collapse_content")}Compact</button>`
    : "";

  // The offer to keep what is on screen, made in the place the pin will land.
  const offer = current && !isToolPinned(current.id)
    ? `<button class="pin-add" type="button" data-pin-tool="${esc(current.id)}"
        title="Keep ${esc(current.name)} in the status bar">${icon("add")}Pin ${esc(shortToolName(current.name))}</button>`
    : "";

  // With nothing pinned and no tool on screen the dock has nothing to say, so
  // it says nothing: no chips, no standing invitation, not even a divider. It
  // appears the moment there is a tool to put in it.
  const dock = `${chips}${more}${offer}${compact}`;
  host.innerHTML = dock;
  el["status-pins-wrap"].hidden = !dock;
  applyPinsPlacement(Boolean(dock));
  renderPinsPop();
  syncToolHeads();
}

/** The dock is one element wherever it lives: it is moved between the status
 *  bar and the shelf rather than built twice, so dragging, the arrow keys and
 *  every click on it keep working without a second set of handlers. */
function applyPinsPlacement(any) {
  const wrap = el["status-pins-wrap"];
  const panel = el["pins-panel"];
  if (!wrap || !panel) return;
  const shelf = state.pinsPanel;
  wrap.classList.toggle("in-panel", shelf);
  const home = shelf ? panel : el["status-term"].parentNode;
  if (wrap.parentNode !== home) {
    if (shelf) panel.appendChild(wrap);
    else (document.getElementById("toggle-assistant") || el["status-term"]).before(wrap);
  }
  panel.hidden = !shelf || !any;
  measurePinsPanel();
}

/** Full-screen views sit above the status bar by a fixed offset, so the shelf
 *  has to say how tall it grew - it wraps, and its height is not a constant. */
function measurePinsPanel() {
  const panel = el["pins-panel"];
  const height = !panel || panel.hidden ? 0 : panel.offsetHeight;
  document.documentElement.style.setProperty("--pins-h", `${height}px`);
}

function renderPinsPop() {
  const pop = el["pins-pop"];
  if (!pop) return;
  const pins = state.toolPins.map(toolById).filter(Boolean);
  const open = state.toolPinsOpen && pins.length > DOCK_PINS;
  pop.hidden = !open;
  // Only rebuilt while it is open, so a pin toggled elsewhere cannot redraw a
  // list nobody is looking at.
  if (!open) return;
  const current = activeTool();
  pop.innerHTML = `<header>${icon("push_pin")}<strong>All pins</strong><span>${
    pins.length} pinned</span><button type="button" data-pins-close title="Close">${icon("close")}</button></header>
    <div class="pins-list">${pins.map((tool, index) => `<div class="pin-row${
      current && current.id === tool.id ? " on" : ""}${index < DOCK_PINS ? " in-bar" : ""}${
      isToolPopped(tool.id) ? " popped" : ""}" data-drag-pin="${esc(tool.id)}">
      <button type="button" class="pin-go" data-open-tool="${esc(tool.id)}">${icon(tool.icon)}<span><strong>${
        esc(tool.name)}</strong><small>${esc(isToolPopped(tool.id) ? "open in its own window" : tool.hint)}</small></span><i>${
        index < 9 ? `Ctrl+${index + 1}` : "\u2014"}</i></button>
      <button type="button" class="pin-off" data-unpin-tool="${esc(tool.id)}" title="${
        current && current.id === tool.id ? `Unpin and close ${esc(tool.name)}` : `Unpin ${esc(tool.name)}`
      }">${icon("close")}</button>
    </div>`).join("")}</div>
    <footer>${icon("low_priority")}drag to reorder \u00b7 drag out to pop out \u00b7 first ${DOCK_PINS} sit in the bar</footer>`;
}

/** The pin button in a tool's own header says the same thing the dock does,
 *  including the number the pin answers to once it has one. The pop-out button
 *  beside it opens the tool in its own window, or focuses one that is already out. */
function syncToolHeads() {
  for (const button of document.querySelectorAll(".tool-pin[data-pin-tool]")) {
    const tool = toolById(button.dataset.pinTool);
    if (!tool) continue;
    const pinned = isToolPinned(tool.id);
    const index = state.toolPins.indexOf(tool.id);
    button.classList.toggle("on", pinned);
    button.setAttribute("aria-pressed", String(pinned));
    button.title = pinned
      ? `Unpin ${tool.name} from the status bar`
      : `Keep ${tool.name} in the status bar`;
    button.innerHTML = `${icon("push_pin")}${
      pinned ? (index < 9 ? `Pinned \u00b7 Ctrl+${index + 1}` : "Pinned") : "Pin to dock"}`;
  }
  for (const button of document.querySelectorAll(".tool-popout[data-popout-tool]")) {
    const tool = toolById(button.dataset.popoutTool);
    if (!tool) continue;
    const popped = isToolPopped(tool.id);
    button.classList.toggle("on", popped);
    button.title = popped
      ? `Show ${tool.name} in its own window`
      : `Open ${tool.name} in a new window`;
    button.innerHTML = `${icon("open_in_new")}${popped ? "Show window" : "Pop out"}`;
  }
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
  el["filter-chips"].innerHTML =
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
    ? `scanned at ${esc(new Date(state.scannedAt).toLocaleTimeString())}`
    : "";

  el["summary-stats"].innerHTML = `
    <span><span class="dot" style="background:var(--green)"></span><b>${count(
      "running"
    )}</b> running</span>
    <span><span class="dot" style="background:var(--amber)"></span><b>${count(
      "dirty"
    )}</b> with uncommitted changes (<b>${totalChanges}</b> files)</span>
    <span><span class="dot" style="background:var(--accent)"></span><b>${count(
      "unpushed"
    )}</b> unpushed</span>
    <span class="summary-tail">${tail}</span>`;
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

async function refreshCliSetting(status = null) {
  const host = el["settings-host"];
  const button = host?.querySelector("#setting-cli-toggle");
  const label = host?.querySelector("#setting-cli-status");
  if (!button || !label) return;
  try {
    status ||= await invoke("cli_status");
    const enabled = status.installed && status.onPath;
    button.dataset.installed = String(enabled);
    button.textContent = enabled ? "Remove from PATH" : "Install CLI";
    button.classList.remove("danger");
    button.classList.toggle("primary", !enabled);
    button.disabled = false;
    label.innerHTML = enabled
      ? `<code>wint</code> is available in new terminals. Installed at <code>${esc(status.path)}</code>.`
      : `Install the CLI and add it to your user PATH. No administrator access is needed.`;
  } catch (error) {
    button.disabled = true;
    button.textContent = "Unavailable";
    label.textContent = String(error);
  }
}

function renderSettings() {
  const host = el["settings-host"];
  if (state.activeView !== "settings") {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `<header class="tool-head settings-head">
      <button class="btn back" data-settings="close">${icon("arrow_back")}Back</button>
      <span class="tool-plate">${icon("settings")}</span>
      <span class="tool-title"><strong>Settings</strong><small>appearance, behavior, terminal and hotkeys</small></span>
      <button class="tool-close" type="button" data-settings="close" title="Back to the overview">${icon("close")}</button>
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
            <span><strong>Language</strong><small>Choose the language WinT uses.</small></span>
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
          <div class="settings-row">
            <span><strong>Theme</strong><small>The window's own light or dark colors.</small></span>
            <div class="sort-buttons setting-theme-buttons" aria-label="Theme">
              <button type="button" data-setting-theme="dark">Dark</button>
              <button type="button" data-setting-theme="light">Light</button>
            </div>
          </div>
          <label class="settings-row" for="setting-compact-tech">
            <span><strong>Compact tech in overview</strong><small>Show technologies in a single neutral line instead of colored tags.</small></span>
            <input class="setting-check" id="setting-compact-tech" type="checkbox" />
          </label>
          <label class="settings-row" for="setting-pins-panel">
            <span><strong>Pinned tools on their own shelf</strong><small>Give the pins a panel above the status bar instead of a few chips inside it. The row wraps, so every pin stays on screen however many you keep.</small></span>
            <input class="setting-check" id="setting-pins-panel" type="checkbox" />
          </label>
          <label class="settings-row" for="setting-minimize-to-tray">
            <span><strong>Show minimize-to-tray button</strong><small>Add a title-bar button that keeps WinT running in the notification area. Click the tray icon to bring it back.</small></span>
            <input class="setting-check" id="setting-minimize-to-tray" type="checkbox" />
          </label>
          <label class="settings-row" for="setting-analytics">
            <span><strong>Send anonymous usage data</strong><small>Let us know you're using WinT, via PageRain. It's a random number and the screen you opened - never your projects.</small>
              <button class="linklike" type="button" id="setting-analytics-source">Read the code that sends it</button>
            </span>
            <input class="setting-check" id="setting-analytics" type="checkbox" />
          </label>
          <label class="settings-row" for="setting-time-tracker">
            <span><strong>Always track active-window usage</strong><small>Record application and window-title time while WinT is open, including when it is minimized or unfocused. Nothing is sent anywhere.</small></span>
            <input class="setting-check" id="setting-time-tracker" type="checkbox" />
          </label>
          <div class="settings-row">
            <span><strong>WinT command-line interface</strong><small id="setting-cli-status">Checking whether <code>wint</code> is available in new terminals…</small></span>
            <button class="btn setting-control" id="setting-cli-toggle" type="button" disabled>Checking…</button>
          </div>
          <div class="settings-row danger-row">
            <span><strong>Reset WinT</strong><small>Forget the folders, language, appearance and terminals, and start over as if the app had just been installed.</small></span>
            <button class="btn danger setting-control" id="setting-reset" type="button">Reset</button>
          </div>
        </section>
        <section class="settings-group" data-section="assistant">
          <h3>Assistant</h3>
          <div class="settings-row">
            <span><strong>Models and providers</strong><small>Open the AI sidebar directly on model downloads, installed models, and cloud-provider keys.</small></span>
            <button class="btn setting-control" id="setting-assistant-models" type="button">${icon("neurology")}Manage models</button>
          </div>
          <label class="settings-row" for="setting-assistant-tool-cap">
            <span><strong>Tool-call limit</strong><small>Maximum tools an answer may call before WinT stops it. Applies to local models, Claude, Codex, GPT, and Cursor.</small></span>
            <input class="sort setting-control setting-number" id="setting-assistant-tool-cap" type="number" min="1" max="100" step="1" />
          </label>
        </section>
        <section class="settings-group" data-section="terminal">
          <h3>Terminal</h3>
          <div class="settings-row">
            <span><strong>Default shell</strong><small>Used for new terminals. Override it from the terminal toolbar.</small></span>
            <div class="setting-shell-control">
              <select class="sort setting-control" id="setting-terminal-shell" aria-label="Default shell"></select>
              <button class="btn" type="button" id="setting-shell-scan">${icon("refresh")}Scan</button>
            </div>
          </div>
          <div class="settings-row shell-downloads-row">
            <span><strong>Get a shell</strong><small>WinT can fetch these itself, straight from the project that publishes them, and keep them to itself. A shell you install yourself is always used first.</small></span>
            <div class="shell-downloads" id="setting-shell-downloads"></div>
          </div>
          <label class="settings-row" for="setting-terminal-history">
            <span><strong>Save terminal history</strong><small>Keep each terminal's scrollback across restarts. When off, a terminal starts fresh and closing it clears what it showed.</small></span>
            <input class="setting-check" id="setting-terminal-history" type="checkbox" />
          </label>
          <label class="settings-row" for="setting-terminal-history-search">
            <span><strong>Enhanced Ctrl+R history search</strong><small>Search commands from all WinT terminals with recency and usage ranking. Turn it off to use your shell's built-in Ctrl+R.</small></span>
            <input class="setting-check" id="setting-terminal-history-search" type="checkbox" />
          </label>
          <div class="settings-row terminal-type-colors-row">
            <span><strong>Terminal type colors</strong><small>Choose the identifying tab color for each shell.</small></span>
            <div class="terminal-type-colors" id="setting-shell-colors"></div>
          </div>
          <div class="settings-row">
            <span><strong>Terminal identifiers</strong><small>Choose how terminal types appear in their tabs.</small></span>
            <div class="sort-buttons setting-terminal-marker" aria-label="Terminal identifiers">
              <button type="button" data-terminal-marker="none">None</button>
              <button type="button" data-terminal-marker="dot">Dot</button>
              <button type="button" data-terminal-marker="code">Code</button>
            </div>
          </div>
          <label class="settings-row" for="setting-term-theme">
            <span><strong>Color scheme</strong><small>Colors for every terminal, docked or popped out.</small></span>
            <select class="sort setting-control" id="setting-term-theme"></select>
          </label>
          <div class="settings-row term-theme-row">
            <span><strong>Colors</strong><small>Change any color to build a scheme of your own.</small></span>
            <div class="term-theme-edit">
              <div class="term-theme-preview" aria-hidden="true">
                <div><span style="color:var(--term-c2)">you</span><span style="color:var(--term-c8)">@</span><span style="color:var(--term-c6)">wint</span> <span style="color:var(--term-c4)">c:\\code\\wint</span> <span style="color:var(--term-c13)">(main)</span></div>
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
        <section class="settings-group hotkeys-group" data-section="hotkeys"></section>
      </div>
    </div>`;
  host.querySelector("#setting-language").value = state.language;
  for (const button of host.querySelectorAll("[data-setting-theme]")) {
    const active = button.dataset.settingTheme === state.theme;
    button.classList.toggle("on", active);
    button.setAttribute("aria-pressed", String(active));
  }
  host.querySelector("#setting-compact-tech").checked = state.compactTechOverview;
  host.querySelector("#setting-pins-panel").checked = state.pinsPanel;
  host.querySelector("#setting-minimize-to-tray").checked = state.minimizeToTrayButton;
  host.querySelector("#setting-analytics").checked = state.analyticsChosen && state.analytics;
  host.querySelector("#setting-time-tracker").checked = window.wintTimeTracker?.getAlways() === true;
  host.querySelector("#setting-assistant-tool-cap").value = window.wintAssistant?.getToolCallCap?.() || 20;
  refreshCliSetting();
  const shellSetting = window.wintTerminalSettings;
  const shellSelect = host.querySelector("#setting-terminal-shell");
  shellSelect.innerHTML = shellSetting.profiles
    .map((profile) => `<option value="${profile.value}"${profile.available === false ? " disabled" : ""}>${profile.label}${profile.available === false ? " · unavailable" : ""}</option>`)
    .join("");
  shellSelect.value = shellSetting.getDefault();
  host.querySelector("#setting-terminal-history").checked = shellSetting.getSaveHistory();
  host.querySelector("#setting-terminal-history-search").checked = shellSetting.getEnhancedHistorySearch();
  for (const button of host.querySelectorAll("[data-terminal-marker]")) {
    const active = button.dataset.terminalMarker === shellSetting.getShellMarkerStyle();
    button.classList.toggle("on", active);
    button.setAttribute("aria-pressed", String(active));
  }
  buildShellColorControls(host);
  buildShellDownloadControls(host);
  // What is on disk can have changed since startup - another window, or a
  // shell removed by hand - so the list is asked for again on the way in and
  // redrawn when the answer arrives.
  shellSetting.loadDownloads?.().then(refreshShellDownloads);
  buildTermThemeControls(host);
  renderHotkeys(host);
  showSettingsSection(state.settingsSection);
}

function buildShellColorControls(host) {
  const shellSetting = window.wintTerminalSettings;
  const colors = shellSetting.shellColors();
  host.querySelector("#setting-shell-colors").innerHTML = shellSetting.profiles
    .filter((profile) => profile.value !== "auto")
    .map((profile) => `<label class="terminal-type-color">
      <input type="color" data-shell-color="${esc(profile.value)}" value="${esc(colors[profile.value])}" aria-label="${esc(profile.label)} color" />
      <span>${esc(profile.label)}</span>
    </label>`)
    .join("") + `<button class="btn terminal-type-colors-reset" id="setting-shell-colors-reset" type="button">Reset colors</button>`;
}

function shellMegabytes(bytes) {
  return `${Math.round(Number(bytes || 0) / 1e6)} MB`;
}

/** The shells WinT can fetch, each with the state of this computer's copy.
 *
 *  Built once per Settings render and then only ever updated in place: a row
 *  is rebuilt underneath a download in progress would restart its bar. */
function buildShellDownloadControls(host) {
  const shellSetting = window.wintTerminalSettings;
  const rows = shellSetting.downloads?.() || [];
  const list = host.querySelector("#setting-shell-downloads");
  if (!rows.length) {
    list.innerHTML = `<p class="shell-downloads-empty">Nothing to fetch — every shell WinT can download is already on this computer.</p>`;
    return;
  }
  list.innerHTML = rows.map((row) => {
    const installed = shellSetting.profiles.find((profile) => profile.value === row.profile)?.available === true;
    return `<div class="shell-download" data-shell-download="${esc(row.profile)}">
      <span class="shell-download-name"><strong>${esc(row.label)}</strong><small>${esc(row.version)} · ${esc(row.publisher)}</small></span>
      <span class="shell-download-state">${shellDownloadState(row, installed)}</span>
      <div class="shell-download-bar" hidden><i style="width:0%"></i></div>
      ${shellDownloadButton(row, installed)}
    </div>`;
  }).join("");
}

/** What this computer has, said plainly. A shell can be present twice - the
 *  user's own installation and WinT's copy - and the user's is the one that
 *  runs, so that is the one the row leads with. */
function shellDownloadState(row, installed) {
  if (installed && !row.managed) return "Installed on this computer";
  if (installed && row.managed) return `Installed on this computer · WinT also has a copy (${shellMegabytes(row.installedBytes)})`;
  if (row.managed) return `Downloaded by WinT · ${shellMegabytes(row.installedBytes)}`;
  return `Not installed · ${shellMegabytes(row.downloadBytes)} from ${esc(row.source)}`;
}

function shellDownloadButton(row, installed) {
  if (row.managed) return `<button class="btn" type="button" data-shell-remove="${esc(row.profile)}">Remove</button>`;
  return `<button class="btn" type="button" data-shell-get="${esc(row.profile)}">${installed ? "Download anyway" : `Download ${shellMegabytes(row.downloadBytes)}`}</button>`;
}

/** Rebuilds the list after an install or a removal has changed what is there.
 *  Safe at any time: it is only called when nothing is downloading. */
function refreshShellDownloads() {
  if (state.activeView !== "settings") return;
  // Never underneath a moving bar: rebuilding the list mid-download would
  // replace the row the progress events are writing into.
  for (const key of work.keys()) if (key.startsWith("shell-download-")) return;
  buildShellDownloadControls(el["settings-host"]);
}

/** Progress for one shell, reported from Rust. The status bar hears about it
 *  whether or not Settings is open, because a 106 MB download is exactly the
 *  kind of work that must never happen invisibly. */
window.wintShellDownloadProgress = (progress) => {
  if (!progress) return;
  const key = `shell-download-${progress.profile}`;
  const label = window.wintTerminalSettings?.downloads?.()
    .find((row) => row.profile === progress.profile)?.label || "a shell";
  const row = el["settings-host"]?.querySelector(`[data-shell-download="${progress.profile}"]`);
  if (!work.has(key)) beginWork(key, `Downloading ${label}`);
  if (progress.done) {
    // The outcome stays on the status bar for a few seconds either way: a
    // download that ends the moment its bar disappears leaves nothing to read.
    updateWork(key, progress.error || "Ready");
    setTimeout(() => endWork(key), progress.error ? 8000 : 3000);
    if (!progress.error) {
      // The work entry is still there for its few seconds on the status bar,
      // so the list is rebuilt directly rather than through the guarded
      // refresh, which would decline while it is.
      if (state.activeView === "settings") buildShellDownloadControls(el["settings-host"]);
      return;
    }
    // A failed or cancelled download keeps its reason on the row, but the
    // button goes back to offering the download - there is nothing to cancel.
    if (!row) return;
    row.querySelector(".shell-download-bar").hidden = true;
    row.querySelector(".shell-download-state").textContent = progress.error;
    const button = row.querySelector("[data-shell-get]");
    if (button) {
      delete button.dataset.shellCancel;
      button.disabled = false;
      button.textContent = "Try again";
    }
    return;
  }
  const percent = progress.total ? Math.min(100, (progress.downloaded / progress.total) * 100) : 0;
  updateWork(key, progress.detail || "");
  if (!row) return;
  const bar = row.querySelector(".shell-download-bar");
  bar.hidden = false;
  bar.querySelector("i").style.width = `${percent}%`;
  row.querySelector(".shell-download-state").textContent = progress.detail;
  const button = row.querySelector("[data-shell-get]");
  if (button) {
    button.dataset.shellCancel = progress.profile;
    button.disabled = false;
    button.textContent = "Cancel";
  }
};

/** Settings, open on the shell downloads, with the one that was asked for
 *  marked so it can be found without reading the whole list. */
window.wintOpenShellDownloads = (shell) => {
  state.settingsSection = "terminal";
  if (state.activeView !== "settings") openSettings();
  else showSettingsSection("terminal");
  requestAnimationFrame(() => {
    const row = el["settings-host"]?.querySelector(`[data-shell-download="${shell}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.classList.add("flash");
    setTimeout(() => row.classList.remove("flash"), 1600);
  });
};

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
  window.wintResetting = true;
  beginWork("reset", "Resetting WinT");
  for (const id of [...(window.termsState?.known.keys() || [])]) {
    await invoke("term_close", { id }).catch(() => {});
  }
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("wint.") && key !== "wint.analytics.visitor.v1") localStorage.removeItem(key);
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
  const theme = window.wintTermTheme;
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
  const theme = window.wintTermTheme;
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

  el["status-version"].onclick = openChangelog;

  el["changelog-pop"].onclick = (e) => {
    if (e.target.closest("[data-changelog-act=\"close\"]")) {
      closeChangelog();
      el["status-version"].focus();
    }
  };

  let pinDragJustEnded = false;
  const clearPinDropMarks = () => {
    for (const node of el["status-pins-wrap"].querySelectorAll(".drop-before,.drop-after")) {
      node.classList.remove("drop-before", "drop-after");
    }
  };
  // Keep pin reordering inside the webview. Native HTML drag does not start
  // reliably from the buttons inside a chip, while pointer capture gives the
  // gesture one owner and matches terminal-tab reordering. Dragging a pin past
  // the window edge pops the tool out the same way a terminal tab does.
  el["status-pins-wrap"].onpointerdown = (down) => {
    const pin = down.target.closest("[data-drag-pin]");
    if (!pin || down.target.closest("[data-unpin-tool]") || down.button !== 0) return;
    const id = pin.dataset.dragPin;
    const startX = down.clientX;
    const startY = down.clientY;
    let dragging = false;
    let target = null;
    let after = false;
    let ghost = null;
    let nativePreview = false;
    let outsideWindow = false;
    const move = (e) => {
      if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
      if (!dragging) {
        dragging = true;
        pinDragJustEnded = true;
        pin.classList.add("dragging");
        pin.setPointerCapture(down.pointerId);
        ghost = document.createElement("div");
        ghost.className = "dock-tab-ghost pin-drag-ghost";
        ghost.innerHTML = pin.querySelector(".pin-chip-go, .pin-go")?.innerHTML || pin.innerHTML;
        document.body.appendChild(ghost);
      }
      e.preventDefault();
      outsideWindow = e.clientX < 0 || e.clientX > window.innerWidth ||
        e.clientY < 0 || e.clientY > window.innerHeight;
      if (ghost) {
        ghost.hidden = outsideWindow;
        ghost.style.transform = `translate(${e.clientX + 12}px,${e.clientY + 12}px)`;
      }
      if (outsideWindow) {
        const action = nativePreview ? "move" : "open";
        nativePreview = true;
        invoke("tool_drag_preview", {
          action,
          x: e.screenX + 12,
          y: e.screenY + 12,
        }).catch(() => {});
      } else if (nativePreview) {
        nativePreview = false;
        invoke("tool_drag_preview", { action: "close", x: 0, y: 0 }).catch(() => {});
      }
      clearPinDropMarks();
      target = outsideWindow
        ? null
        : document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-drag-pin]") || null;
      if (!target || target.dataset.dragPin === id) { target = null; return; }
      const rect = target.getBoundingClientRect();
      after = target.classList.contains("pin-chip")
        ? e.clientX > rect.left + rect.width / 2
        : e.clientY > rect.top + rect.height / 2;
      target.classList.add(after ? "drop-after" : "drop-before");
    };
    const finish = (e, cancelled = false) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      if (pin.hasPointerCapture(down.pointerId)) pin.releasePointerCapture(down.pointerId);
      pin.classList.remove("dragging");
      clearPinDropMarks();
      ghost?.remove();
      if (nativePreview) {
        invoke("tool_drag_preview", { action: "close", x: 0, y: 0 }).catch(() => {});
      }
      if (dragging && !cancelled && outsideWindow && (e.screenX || e.screenY)) {
        popOutTool(id, e.screenX, e.screenY);
      } else if (dragging && !cancelled && target) {
        reorderToolPin(id, target.dataset.dragPin, after);
      }
      if (dragging) setTimeout(() => { pinDragJustEnded = false; }, 0);
    };
    const up = (e) => finish(e);
    const cancel = (e) => finish(e, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };
  el["status-pins-wrap"].onkeydown = (e) => {
    if (!e.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    const pin = e.target.closest("[data-drag-pin]");
    if (!pin) return;
    e.preventDefault();
    moveToolPin(pin.dataset.dragPin, ["ArrowLeft", "ArrowUp"].includes(e.key) ? -1 : 1);
  };
  el["status-pins-wrap"].onclick = (e) => {
    if (pinDragJustEnded) return;
    const unpin = e.target.closest("[data-unpin-tool]");
    if (unpin) return unpinTool(unpin.dataset.unpinTool);
    const pin = e.target.closest("[data-pin-tool]");
    if (pin) return toggleToolPin(pin.dataset.pinTool);
    const go = e.target.closest("[data-open-tool]");
    if (go) return openTool(go.dataset.openTool);
    if (e.target.closest("[data-pins-more]")) {
      state.pinsPanel = true;
      state.toolPinsOpen = false;
      savePrefs();
      return markDirty("pins");
    }
    if (e.target.closest("[data-pins-compact]")) {
      state.pinsPanel = false;
      state.toolPinsOpen = false;
      savePrefs();
      return markDirty("pins");
    }
    if (e.target.closest("[data-pins-close]")) return closeToolPins();
  };

  el["status-term"].onclick = () => window.openTerminalPanel?.();
  el["status-term-popout"].onclick = () => window.openTerminalWindow?.();

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
    setTechFilter(state.techFilter);
  };

  el["tech-filter"].onclick = () => (techMenuOpen() ? closeTechMenu() : openTechMenu());

  el["tech-menu-input"].oninput = () => {
    techMenuIndex = 0;
    renderTechMenu();
  };

  el["tech-menu-input"].onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!techMenuRows.length) return;
      const direction = e.key === "ArrowDown" ? 1 : -1;
      techMenuIndex = (techMenuIndex + direction + techMenuRows.length) % techMenuRows.length;
      renderTechMenu();
    } else if (e.key === "Enter" && techMenuRows.length) {
      e.preventDefault();
      chooseTech(techMenuRows[techMenuIndex].name);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      closeTechMenu();
      el["tech-filter"].focus();
    }
  };

  el["tech-menu"].onclick = (e) => {
    const row = e.target.closest("[data-tech-option]");
    if (row) chooseTech(row.dataset.techOption);
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
    if (techMenuOpen() && !e.target.closest("#tech-picker")) closeTechMenu();
    if (toolPinsOpen() && !e.target.closest("#status-pins-wrap")) closeToolPins();
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
    state.search = searchQuery(e.target.value);
    markDirty("grid", "filters");
    searchCommandIndex = 0;
    renderSearchCommands();
  };
  el["search-input"].onfocus = async () => {
    const rect = el["search-input"].getBoundingClientRect();
    const titlebarBottom = el["search-input"].closest(".titlebar")?.getBoundingClientRect().bottom ?? rect.bottom;
    let position = null;
    try {
      const [origin, scale] = await Promise.all([appWindow.innerPosition(), appWindow.scaleFactor()]);
      position = {
        x: origin.x / scale + rect.left + rect.width / 2 - 340,
        // Search's divider is 72px below its top (18px drag grip + 54px
        // field). Align it with the shell titlebar divider.
        y: origin.y / scale + titlebarBottom - 72,
      };
    } catch { /* Center Search if native window geometry is unavailable. */ }
    openSearchCommands({ fresh: true, position });
    el["search-input"].blur();
  };
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
    const pin = e.target.closest("[data-pin-tool]");
    if (pin) {
      // Pinning is not picking: the list stays open and simply redraws with the
      // row now carrying its pin number.
      toggleToolPin(pin.dataset.pinTool);
      return renderSearchCommands();
    }
    const command = e.target.closest("[data-command]");
    if (command) runSearchCommand(Number(command.dataset.command));
  };

  el["title-home"].onclick = () => {
    closeSearchCommands();
    if (state.activeView === "overview" && state.selectedPath) closeDetail();
    else switchMainView("overview");
  };

  // This header lives in the shell, deliberately outside the child webview.
  // Its controls must be wired here rather than delegated through tool code.
  el["isolated-tool-host"].onclick = (event) => {
    const popout = event.target.closest("[data-popout-tool]");
    if (popout) return popOutTool(popout.dataset.popoutTool);
    const pin = event.target.closest("[data-pin-tool]");
    if (pin) return toggleToolPin(pin.dataset.pinTool);
    const destination = event.target.closest("[data-open-tool]")?.dataset.openTool;
    if (destination) return openTool(destination);
  };

  el["ports-host"].onclick = (e) => {
    const popTool = e.target.closest("[data-popout-tool]");
    if (popTool) return popOutTool(popTool.dataset.popoutTool);
    const pinTool = e.target.closest("[data-pin-tool]");
    if (pinTool) return toggleToolPin(pinTool.dataset.pinTool);
    const goTool = e.target.closest("[data-open-tool]");
    if (goTool) return openTool(goTool.dataset.openTool);
    if (e.target.closest("[data-ports-refresh]")) return loadPorts();
    // Both the name under the title and the Project button lead to the same
    // place: the scanned project this port belongs to.
    const projectLink = e.target.closest("[data-port-project], [data-port-detail]");
    if (projectLink) {
      const project = state.byPath.get(projectLink.dataset.portProject || projectLink.dataset.portDetail);
      if (!project) return;
      switchMainView("overview");
      return openDetail(project);
    }
    const tab = e.target.closest("[data-port-tab]");
    if (tab) {
      state.portTab = tab.dataset.portTab;
      savePrefs();
      return markDirty("ports");
    }
    const sort = e.target.closest("[data-port-sort]");
    if (sort) {
      const key = sort.dataset.portSort;
      // Clicking the column already sorted flips it; a new column starts the
      // way that column is worth reading.
      state.portSortDirection = state.portSortKey === key
        ? -state.portSortDirection
        : PORT_SORTS.find((candidate) => candidate.key === key).first;
      state.portSortKey = key;
      savePrefs();
      return markDirty("ports");
    }
    const pin = e.target.closest("[data-port-pin]");
    if (pin) {
      e.stopPropagation();
      return togglePortPin(Number(pin.dataset.portPin));
    }
    const select = e.target.closest("[data-port-select]");
    if (select) {
      state.portSelected = select.dataset.portSelect;
      samplePorts();
      return markDirty("ports");
    }
    const open = e.target.closest("[data-port-open]");
    if (open) {
      e.preventDefault();
      return openUrl(open.dataset.portOpen);
    }
    const copy = e.target.closest("[data-port-copy]");
    if (copy) {
      window.wintCopy.copy(copy.dataset.portCopy, copy).catch(() => {});
      return;
    }
    const terminal = e.target.closest("[data-port-terminal]");
    if (terminal) return openPortTerminal(terminal.dataset.portTerminal);
    const reveal = e.target.closest("[data-port-reveal]");
    if (reveal) return openIn(reveal.dataset.portReveal, "explorer");
    const restart = e.target.closest("[data-port-restart]");
    if (restart) return restartPortProcess(restart.dataset.portRestart);
    const kill = e.target.closest("[data-port-kill]");
    if (kill) {
      state.portKill = { key: kill.dataset.portKill, tree: true };
      return markDirty("ports");
    }
    if (e.target.closest("[data-port-kill-tree]")) {
      state.portKill = { ...state.portKill, tree: !state.portKill.tree };
      return markDirty("ports");
    }
    const confirm = e.target.closest("[data-port-kill-confirm]");
    if (confirm) return killPortProcess(confirm.dataset.portKillConfirm, state.portKill?.tree);
    if (e.target.closest("[data-port-dialog-close]") || e.target.classList.contains("port-overlay")) {
      state.portKill = null;
      markDirty("ports");
    }
  };
  // A row is a button as far as the keyboard is concerned.
  el["ports-host"].onkeydown = (e) => {
    const row = e.target.closest?.("[data-port-select]");
    if (row && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      state.portSelected = row.dataset.portSelect;
      markDirty("ports");
    }
  };
  el["ports-list"].onpointerenter = () => { portListHovered = true; };
  el["ports-list"].onpointerleave = () => { portListHovered = false; };
  el["port-filter-input"].oninput = (e) => {
    state.portSearch = e.target.value;
    markDirty("ports");
  };
  el["port-live"].onclick = () => {
    state.portLive = !state.portLive;
    setPortsLive(state.portLive && state.activeView === "ports");
    markDirty("ports");
  };

  el.filters.onclick = (e) => {
    const chip = e.target.closest("[data-filter]");
    if (chip) return toggleFilter(chip.dataset.filter);
    if (e.target.closest("#clear")) {
      state.filters.clear();
      state.techFilter = "";
      state.search = "";
      el["search-input"].value = "";
      savePrefs();
      markDirty("filters", "toolbar", "grid");
    }
  };

  document.querySelector(".titlebar").onclick = (e) => {
    const btn = e.target.closest("[data-win]");
    if (!btn) return;
    if (btn.dataset.win === "tray") invoke("minimize_to_tray").catch(() => {});
    else if (btn.dataset.win === "min") appWindow.minimize();
    else if (btn.dataset.win === "max") {
      appWindow.toggleMaximize().then(() => syncMaximizeButton()).catch(() => {});
    } else appWindow.destroy();
  };

  const maxButton = document.querySelector('.titlebar [data-win="max"]');
  let wasMaximized = false;
  async function syncMaximizeButton() {
    if (!maxButton) return;
    const maxed = await appWindow.isMaximized().catch(() => false);
    // Restoring the main window is the one size change that may place the
    // terminal scroller; an ordinary resize must not. Wait past the window
    // resize listener's fit so its hold does not land after this settle.
    if (wasMaximized && !maxed) {
      setTimeout(() => window.wintTerminalSettings?.settleVisible?.(), 100);
    }
    wasMaximized = maxed;
    maxButton.innerHTML = icon(maxed ? "filter_none" : "crop_square");
    maxButton.title = maxed ? "Restore" : "Maximize";
    maxButton.setAttribute("aria-label", maxed ? "Restore" : "Maximize");
  }
  appWindow.isMaximized().then((maxed) => { wasMaximized = !!maxed; }).catch(() => {});
  syncMaximizeButton();
  appWindow.onResized(() => syncMaximizeButton());

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
    if (action) return projectAction(action.dataset.act, project, action);
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
    projectAction(action.dataset.act, p, action);
  };

  el["settings-host"].onclick = async (e) => {
    const navItem = e.target.closest("[data-settings-section]");
    if (e.target.closest("#setting-analytics-source")) {
      // Inside the row's label, so the click has to be stopped from also
      // flipping the switch it sits under.
      e.preventDefault();
      openUrl(ANALYTICS_SOURCE_URL);
    } else if (e.target.closest('[data-settings="close"]')) closeSettings();
    else if (navItem) showSettingsSection(navItem.dataset.settingsSection);
    else if (e.target.closest("#setting-assistant-models")) window.wintAssistant?.openModels?.();
    else if (e.target.closest("[data-hotkey-filter]")) {
      state.hotkeyFilter = e.target.closest("[data-hotkey-filter]").dataset.hotkeyFilter;
      renderHotkeys(el["settings-host"]);
    } else if (e.target.closest("[data-hotkeys-restore]")) {
      state.hotkeys = {};
      state.hotkeyGlobals.clear();
      state.hotkeyRecording = null;
      savePrefs();
      syncGlobalHotkeys();
      renderHotkeys(el["settings-host"]);
    } else if (e.target.closest("[data-hotkey-clear]")) {
      const id = e.target.closest("[data-hotkey-clear]").dataset.hotkeyClear;
      state.hotkeys[id] = "";
      state.hotkeyGlobals.delete(id);
      state.hotkeyRecording = null;
      savePrefs();
      syncGlobalHotkeys();
      renderHotkeys(el["settings-host"]);
    } else if (e.target.closest("[data-hotkey-record]")) {
      state.hotkeyRecording = e.target.closest("[data-hotkey-record]").dataset.hotkeyRecord;
      renderHotkeys(el["settings-host"]);
      el["settings-host"].querySelector(`[data-hotkey-record="${CSS.escape(state.hotkeyRecording)}"]`)?.focus();
    }
    else if (e.target.closest("#setting-reset")) armReset(e.target.closest("#setting-reset"));
    else if (e.target.closest("#setting-cli-toggle")) {
      const button = e.target.closest("#setting-cli-toggle");
      const installed = button.dataset.installed === "true";
      button.disabled = true;
      button.textContent = installed ? "Removing…" : "Installing…";
      try {
        const status = await invoke(installed ? "cli_uninstall" : "cli_install");
        await refreshCliSetting(status);
      } catch (error) {
        const label = el["settings-host"].querySelector("#setting-cli-status");
        if (label) label.textContent = String(error);
        button.disabled = false;
        button.textContent = installed ? "Remove from PATH" : "Install CLI";
      }
    }
    else if (e.target.closest("[data-setting-theme]")) {
      const button = e.target.closest("[data-setting-theme]");
      if (button.dataset.settingTheme === state.theme) return;
      state.theme = button.dataset.settingTheme;
      applyTheme();
      savePrefs();
    } else if (e.target.closest("[data-terminal-marker]")) {
      const button = e.target.closest("[data-terminal-marker]");
      window.wintTerminalSettings.setShellMarkerStyle(button.dataset.terminalMarker);
      for (const choice of el["settings-host"].querySelectorAll("[data-terminal-marker]")) {
        const active = choice === button;
        choice.classList.toggle("on", active);
        choice.setAttribute("aria-pressed", String(active));
      }
    }
    else if (e.target.closest("#setting-term-reset")) {
      window.wintTermTheme.resetToPreset();
      syncTermThemeControls();
    } else if (e.target.closest("#setting-shell-colors-reset")) {
      window.wintTerminalSettings.resetShellColors();
      buildShellColorControls(el["settings-host"]);
    } else if (e.target.closest("[data-shell-get],[data-shell-remove]")) {
      const button = e.target.closest("[data-shell-get],[data-shell-remove]");
      const shellSetting = window.wintTerminalSettings;
      // The same button becomes Cancel while its download runs, so a second
      // click stops what the first one started rather than queueing another.
      if (button.dataset.shellCancel) {
        shellSetting.cancelDownload();
        button.disabled = true;
        return;
      }
      const remove = button.dataset.shellRemove;
      button.disabled = true;
      try {
        if (remove) {
          await shellSetting.removeDownload(remove);
          refreshShellDownloads();
        } else {
          await shellSetting.startDownload(button.dataset.shellGet);
        }
      } catch (err) {
        button.disabled = false;
        const row = button.closest(".shell-download");
        if (row) row.querySelector(".shell-download-state").textContent = String(err);
      }
    } else if (e.target.closest("#setting-shell-scan")) {
      const button = e.target.closest("#setting-shell-scan");
      button.disabled = true;
      button.classList.add("spinning");
      try {
        await window.wintTerminalSettings.scan();
        const select = el["settings-host"].querySelector("#setting-terminal-shell");
        const shellSetting = window.wintTerminalSettings;
        select.innerHTML = shellSetting.profiles
          .map((profile) => `<option value="${profile.value}"${profile.available === false ? " disabled" : ""}>${profile.label}${profile.available === false ? " · unavailable" : ""}</option>`)
          .join("");
        select.value = shellSetting.getDefault();
        await shellSetting.loadDownloads();
        refreshShellDownloads();
      } finally {
        button.classList.remove("spinning");
        button.disabled = false;
      }
    }
  };
  // Colour inputs report every drag of the picker, so the terminals follow the
  // pointer live rather than waiting for the dialog to close.
  el["settings-host"].oninput = (e) => {
    if (e.target.id === "hotkey-search") {
      state.hotkeyQuery = e.target.value;
      renderHotkeys(el["settings-host"]);
      const input = el["settings-host"].querySelector("#hotkey-search");
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    if (e.target.dataset.shellColor !== undefined) {
      window.wintTerminalSettings.setShellColor(e.target.dataset.shellColor, e.target.value);
      return;
    }
    if (e.target.dataset.termColor === undefined) return;
    const key = e.target.dataset.termColor;
    window.wintTermTheme.setColor(key === "bg" || key === "fg" ? key : Number(key), e.target.value);
    syncTermThemeControls();
  };
  el["settings-host"].onchange = (e) => {
    if (e.target.dataset.hotkeyGlobal !== undefined) {
      if (e.target.checked) state.hotkeyGlobals.add(e.target.dataset.hotkeyGlobal);
      else state.hotkeyGlobals.delete(e.target.dataset.hotkeyGlobal);
      savePrefs();
      syncGlobalHotkeys();
    } else if (e.target.id === "setting-language") {
      state.language = e.target.value;
      applyLanguage();
      savePrefs();
    } else if (e.target.id === "setting-compact-tech") {
      state.compactTechOverview = e.target.checked;
      savePrefs();
      markDirty("grid");
    } else if (e.target.id === "setting-pins-panel") {
      state.pinsPanel = e.target.checked;
      closeToolPins();
      savePrefs();
      markDirty("pins");
    } else if (e.target.id === "setting-minimize-to-tray") {
      state.minimizeToTrayButton = e.target.checked;
      document.querySelector('.titlebar [data-win="tray"]').hidden = !state.minimizeToTrayButton;
      savePrefs();
    } else if (e.target.id === "setting-analytics") {
      state.analytics = e.target.checked;
      state.analyticsChosen = true;
      savePrefs();
      applyAnalytics();
      // Switching it on counts the screen it was switched on from, so the
      // setting has an immediate, visible effect rather than a silent one.
      window.wintTrackPageView?.(currentPath());
    } else if (e.target.id === "setting-time-tracker") {
      window.wintTimeTracker?.setAlways(e.target.checked);
    } else if (e.target.id === "setting-assistant-tool-cap") {
      e.target.value = window.wintAssistant?.setToolCallCap?.(e.target.value) || 20;
    } else if (e.target.id === "setting-terminal-shell") {
      window.wintTerminalSettings.setDefault(e.target.value);
    } else if (e.target.id === "setting-terminal-history") {
      window.wintTerminalSettings.setSaveHistory(e.target.checked);
    } else if (e.target.id === "setting-terminal-history-search") {
      window.wintTerminalSettings.setEnhancedHistorySearch(e.target.checked);
    } else if (e.target.id === "setting-term-theme") {
      if (e.target.value === "custom") return syncTermThemeControls();
      window.wintTermTheme.usePreset(e.target.value);
      syncTermThemeControls();
    }
  };
}

// The mouse's back button leaves whatever you stepped into, the way it would
// leave a page. The webview would otherwise try to navigate its own history,
// which in a one-page app means nothing happens at all.
for (const type of ["mousedown", "mouseup", "auxclick"]) {
  document.addEventListener(type, (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    if (type === "mouseup" && e.button === 3) {
      if (toolPinsOpen()) closeToolPins();
      else if (state.activeView === "settings") closeSettings();
      else if (state.selectedPath) closeDetail();
      // A tool is somewhere you went, so back is the way out of it - the same
      // step the close button in its own header takes. Without this the only
      // way out of a tool is that one button, which is a poor place to hide
      // the way home.
      else if (activeTool()) openTool("overview");
    }
  }, true);
}

/** True when the key belongs to whatever has focus - a field, a terminal,
 *  anything editable - and must not be taken as a shortcut. */
function typingSomewhereElse(target) {
  const node = target instanceof Element ? target : null;
  if (!node) return false;
  return Boolean(node.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
}

document.addEventListener("keydown", (e) => {
  if (state.hotkeyRecording) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") state.hotkeyRecording = null;
    else {
      const binding = hotkeyFromEvent(e);
      if (!binding) return;
      state.hotkeys[state.hotkeyRecording] = binding;
      state.hotkeyRecording = null;
      savePrefs();
      syncGlobalHotkeys();
    }
    renderHotkeys(el["settings-host"]);
    return;
  }
  const pressed = hotkeyFromEvent(e);
  // Modifier-only presses return no binding. Never compare that empty value
  // with the catalog: unbound commands also use an empty string, so Ctrl by
  // itself would otherwise execute the first unbound command.
  const custom = pressed
    ? hotkeyCatalog().find((command) => hotkeyBinding(command.id) === pressed)
    : null;
  if (custom) {
    e.preventDefault();
    custom.action();
  } else if (e.key === "Escape" && state.activeView === "ports" && state.portKill) {
    state.portKill = null;
    markDirty("ports");
  } else if (e.key === "Escape" && toolPinsOpen()) {
    closeToolPins();
  } else if (e.key === "Escape" && changelogOpen()) {
    closeChangelog();
    el["status-version"].focus();
  } else if (e.key === "Escape" && (state.activeView === "settings" || state.selectedPath)) {
    if (state.activeView === "settings") closeSettings();
    else closeDetail();
  } else if (e.ctrlKey && e.key.toLowerCase() === "r") {
    e.preventDefault();
    if (state.activeView === "ports") loadPorts();
    else rescan();
  } else if (e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key)) {
    // The number a pin carries in the bar is the number that opens it. Nothing
    // happens on a number nothing is pinned to, so the shortcut never
    // surprises anyone who has pinned three things and pressed four.
    const tool = state.toolPins[Number(e.key) - 1];
    if (tool) {
      e.preventDefault();
      openTool(tool);
    }
  } else if (e.ctrlKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    // The one search shortcut, on every screen. It always lands in the box at
    // the top - never in a filter belonging to whatever is on the page, which
    // would make where the caret goes depend on where you happened to be.
    openSearchCommands({ fresh: true });
  } else if (e.key === ">" && !e.ctrlKey && !e.altKey && !typingSomewhereElse(e.target)) {
    // ">" is the second way in, the way it is in an editor: it lands in the
    // box as the command prefix and the list opens under it.
    e.preventDefault();
    openSearchCommands({ fresh: true, initialQuery: "> " });
  }
});

window.wintWork = { beginWork, updateWork, endWork };

async function wireToolPopoutEvents() {
  await listen("search:ready", activateNativeSearch);
  await listen("search:query", (event) => {
    const query = typeof event.payload?.query === "string" ? event.payload.query : "";
    if (/\bkill\b/i.test(query) && !state.ports.length && !state.portsLoading) loadPorts();
    publishNativeSearch(query);
  });
  await listen("search:pin", (event) => {
    const id = event.payload?.id;
    if (id && toolById(id)) toggleToolPin(id);
    publishNativeSearch(typeof event.payload?.query === "string" ? event.payload.query : nativeSearchQuery);
  });
  await listen("search:execute", async (event) => {
    const index = Number(event.payload?.index);
    if (!Number.isInteger(index) || !searchCommands[index]) return;
    await appWindow.show().catch(() => {});
    await appWindow.unminimize().catch(() => {});
    await appWindow.setFocus().catch(() => {});
    runSearchCommand(index);
  });
  await listen("tool:bridge-request", async (event) => {
    const request = event.payload || {};
    // Any resident tool may speak, not just the one on screen - a hidden one
    // still saves its state. Which tool asked is now the session's job to say,
    // because state.isolatedToolId only names the visible one.
    const fromId = toolForSession(request.session);
    if (!fromId) return;
    const reply = async (ok, value = null, error = "") => {
      if (!request.requestId) return;
      await emit("tool:bridge-response", {
        session: request.session, requestId: request.requestId, ok, value, error,
      }).catch(() => {});
    };
    try {
      if (request.action === "ready") {
        // The tool has mounted and drawn. Both the slot's stand-in and the
        // status line have been telling the truth until exactly now.
        embeddedToolReadyId = fromId;
        // Only the tool you are looking at owns the stand-in and the status
        // line. A resident tool waking up in the background must not clear
        // them out from under whatever is actually on screen.
        if (fromId === state.isolatedToolId) {
          endWork(EMBEDDED_TOOL_WORK);
          const failure = request.value?.error;
          if (failure) failEmbeddedToolLoading(toolById(fromId), String(failure));
          else hideEmbeddedToolLoading();
        }
        await reply(true, { accepted: true });
      } else if (request.action === "context") {
        const tool = toolById(fromId);
        await reply(true, {
          protocol: 1,
          tool: tool ? { id: tool.id, name: tool.name, icon: tool.icon, hint: tool.hint, keywords: tool.keywords } : null,
          theme: state.theme,
          pinned: isToolPinned(fromId),
          popped: isToolPopped(fromId),
          projects: state.projects.map((project) => ({
            name: project.name, path: project.path, remote: project.git?.remote || "",
            branch: project.git?.branch || "", dirty: project.git?.dirty === true,
            changed: project.git?.changedTotal || project.git?.changed?.length || 0,
            ahead: project.git?.ahead || 0, behind: project.git?.behind || 0,
          })),
        });
      } else if (request.action === "navigate") {
        const destination = String(request.value || "overview");
        // A navigation away hides the webview that sent this request, and may
        // evict it outright if the cache is full. Acknowledge it first so the
        // child and the Tauri event bridge cannot be left waiting on each other.
        await reply(true);
        setTimeout(() => openTool(destination), 0);
      } else if (request.action === "toggle-pin") {
        toggleToolPin(fromId);
        await reply(true, { pinned: isToolPinned(fromId) });
      } else if (request.action === "pop-out") {
        popOutTool(fromId);
        await reply(true);
      } else if (request.action === "confirm") {
        await reply(true, await appConfirm(request.value || {}));
      } else if (request.action === "search") {
        const initialQuery = typeof request.value?.initialQuery === "string" ? request.value.initialQuery : "";
        openSearchCommands({ fresh: true, initialQuery });
        await reply(true);
      } else {
        await reply(false, null, `Unknown tool bridge action: ${request.action}`);
      }
    } catch (error) {
      await reply(false, null, String(error));
    }
  });
  listen("tray:open-tool", (event) => {
    const id = event.payload;
    if (typeof id === "string") openTool(id);
  });
  listen("tool:closed", (event) => {
    const id = event.payload?.id;
    if (!id) return;
    rememberToolPopout(id, false);
  });
  listen("tool:docked", async (event) => {
    const id = event.payload?.id;
    if (!id) return;
    await dockToolPopout(id);
  });
  listen("tool:open", (event) => {
    const id = event.payload?.id;
    if (id) openTool(id);
  });
  listen("tool:shell-search", () => {
    openSearchCommands({ fresh: true });
  });
  listen("tool:toggle-pin", (event) => {
    const id = event.payload?.id;
    if (id && toolById(id)) toggleToolPin(id);
  });
  listen("tool:pins-changed", () => {
    try {
      const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
      if (Array.isArray(prefs.toolPins)) {
        state.toolPins = prefs.toolPins.filter((id) => TOOLS.some((tool) => tool.id === id));
        markDirty("pins");
      }
    } catch { /* ignore */ }
  });
}

/** The pieces of the shell a tool living in its own file needs: the same
 *  escaping, the same icons and the same render batch, so a tool can never
 *  paint outside the frame or invent a second way to draw an icon. */
window.wintShell = {
  icon,
  esc,
  markDirty,
  /** The header of a tool carries the same pin and the same way out as the
   *  dock does, and both have to mean exactly what they mean everywhere else. */
  toggleToolPin,
  isToolPinned,
  openTool,
  popOutTool,
  isToolPopped,
  /** The scanned projects, for a tool that wants to open on something real.
   *  A copy, because nothing outside the shell may edit the list. */
  projects: () => state.projects.map((p) => ({ name: p.name, path: p.path, remote: p.git?.remote || "" })),
};

/* ------------------------------------------------------------------ start */

(async function start() {
  let restoreWasInterrupted = false;
  try {
    restoreWasInterrupted = Boolean(localStorage.getItem(STARTUP_RESTORE_KEY));
    localStorage.removeItem(STARTUP_RESTORE_KEY);
  } catch { /* storage disabled - the in-process guards still apply */ }
  loadPrefs();
  // Migrate remembered modular destinations from their old in-process hosts.
  const restoredIsolatedId = state.activeView === "ports" ? "ports"
    : state.activeView === "tools" ? state.utilToolId
    : state.activeView === "windows-tools" ? state.windowsToolId
    : ["dns", "hosts", "network", "path-ping", "disk-space", "github", "git"].includes(state.activeView)
      ? state.activeView : "";
  if (restoredIsolatedId) {
    state.activeView = "isolated-tool";
    state.isolatedToolId = restoredIsolatedId;
  }
  if (restoreWasInterrupted) {
    state.activeView = "overview";
    savePrefs();
  } else if (state.activeView !== "overview") {
    armToolRecovery(
      state.activeView,
      state.activeView === "windows-tools" ? state.windowsToolId
        : state.activeView === "tools" ? state.utilToolId : "",
    );
  }
  // The window is drawn and interactive before anything is asked of the disk.
  mountShell();
  await wireToolPopoutEvents();
  syncRecentTrayTools();
  window.wintTrackPageView?.(currentPath());
  // A restored tool is optional startup work. Its own loader must never be
  // able to prevent the already-mounted shell from opening.
  try {
    openRestoredView();
  } catch (error) {
    console.error("Could not restore the last open tool", error);
    state.activeView = "overview";
    savePrefs();
    syncMainView();
  }
  // Leave the marker in place through the first paint and immediate async
  // startup work. A process/render crash in that window is recovered on the
  // next launch; a healthy tool remains the remembered destination.
  syncGlobalHotkeys();
  loadAppVersion();
  window.wintI18n?.init(state.language);
  markDirty("toolbar", "filters", "summary", "grid");
  invoke("take_startup_tool").then((id) => {
    if (typeof id === "string" && id) openTool(id);
  }).catch(() => {});
  // Popped-out tools reopen with the shell; they do not wait on the first scan.
  restoreToolPopouts();

  // On the first run, scanning waits behind the language dialog. The shell is
  // already painted, but no disk work or stream can distract from the choice.
  await firstRunLanguage();

  listenScan().then(async () => {
    // Nothing scanned before: ask which folder to read rather than guessing
    // one, and start only once there is an answer.
    const newInstall = !state.roots.length;
    if (newInstall) {
      await firstRunFolders();
      // The usage question comes last, and on a new install there is nothing
      // behind it to look at anyway, so the scan waits for the answer.
      await firstRunUsageData();
    }
    if (state.roots.length) {
      // A scan that finished in the last few minutes is still good enough to
      // show; F5 / Rescan always hits the disk again.
      const cache = loadScanCache();
      if (cache) restoreScanCache(cache);
      else rescan();
    }
    // An install that already has folders keeps its projects loading while it
    // answers - the question is not worth a wait.
    if (!newInstall) firstRunUsageData();
  });
})();

/** The folder a terminal opened from nowhere in particular should start in. */
window.wintPrimaryRoot = () => state.roots[0] || "";

/** A deliberately bounded, read-only snapshot for the local assistant. The
 * model receives facts already present in WinT, never direct filesystem or
 * command access. Prefer the open project; otherwise include the first few
 * projects from the current scan so questions such as "this setup" have real
 * context instead of inviting a generic guess. */
window.wintAssistantContext = () => {
  const selected = state.selectedPath ? state.byPath.get(state.selectedPath) : null;
  const projects = (selected ? [selected] : state.projects.slice(0, 12)).map((project) => ({
    name: project.name,
    path: project.path,
    description: project.description || "",
    version: project.version || "",
    packageManager: project.packageManager || "",
    technologies: (project.tech || []).map((tech) => tech.name || tech.label || String(tech)).slice(0, 16),
    branch: project.git?.branch || "",
    changes: project.git?.changes || 0,
    runCommand: project.runCmd || "",
    scripts: (project.scripts || []).slice(0, 12),
    ports: project.ports || [],
  }));
  return JSON.stringify({ roots: state.roots, selectedProject: selected?.name || "", projects });
};
window.wintAssistantRoots = () => [...state.roots];
window.addEventListener("wint:assistant-tool-cap-changed", (event) => {
  const input = document.getElementById("setting-assistant-tool-cap");
  if (input) input.value = event.detail?.value || 20;
});
