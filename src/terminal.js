// A view onto a terminal session. The session itself — pseudoconsole, shell
// and screen — lives in Rust; this only paints cells and forwards keystrokes,
// which is why the same class serves the docked panel and the popped-out
// window without either owning the shell.

const term_invoke = window.__TAURI__.core.invoke;
const term_listen = window.__TAURI__.event.listen;

// ---------------------------------------------------------------- palette
//
// A terminal's colours live as CSS variables on the document rather than being
// baked into the cells, so changing a scheme recolours every line already on
// screen without repainting a single row. Both windows that host a terminal -
// the DevHQ panel and a popped-out one - load this file, and a change in one
// is broadcast to the other.

const TERM_THEME_KEY = "devhq.termtheme.v1";

const TERM_PRESETS = [
  {
    id: "devhq-dark", label: "DevHQ Dark", bg: "#0a0b0f", fg: "#d7dbe6",
    ansi: ["#1c1f26", "#e05561", "#8cc265", "#d5a458", "#4d9df5", "#c162de", "#42b3c2", "#c8ccd4",
           "#5c6370", "#ff6b78", "#a5e075", "#e6c07b", "#61afef", "#d55fde", "#56b6c2", "#ffffff"],
  },
  {
    id: "devhq-light", label: "DevHQ Light", bg: "#fbfbfd", fg: "#1c1f26",
    ansi: ["#383a42", "#e45649", "#50a14f", "#c18401", "#0184bc", "#a626a4", "#0997b3", "#a0a1a7",
           "#4f525e", "#d13c33", "#3f8a3e", "#a06d00", "#0165a0", "#8b1f8b", "#077f97", "#0a0b0f"],
  },
  {
    id: "campbell", label: "Campbell (Windows)", bg: "#0c0c0c", fg: "#cccccc",
    ansi: ["#0c0c0c", "#c50f1f", "#13a10e", "#c19c00", "#0037da", "#881798", "#3a96dd", "#cccccc",
           "#767676", "#e74856", "#16c60c", "#f9f1a5", "#3b78ff", "#b4009e", "#61d6d6", "#f2f2f2"],
  },
  {
    id: "one-dark", label: "One Dark", bg: "#282c34", fg: "#abb2bf",
    ansi: ["#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
           "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"],
  },
  {
    id: "dracula", label: "Dracula", bg: "#282a36", fg: "#f8f8f2",
    ansi: ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
           "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"],
  },
  {
    id: "nord", label: "Nord", bg: "#2e3440", fg: "#d8dee9",
    ansi: ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
           "#4c566a", "#d08770", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"],
  },
  {
    id: "gruvbox-dark", label: "Gruvbox Dark", bg: "#282828", fg: "#ebdbb2",
    ansi: ["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984",
           "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"],
  },
  {
    id: "tokyo-night", label: "Tokyo Night", bg: "#1a1b26", fg: "#c0caf5",
    ansi: ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
           "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"],
  },
  {
    id: "solarized-dark", label: "Solarized Dark", bg: "#002b36", fg: "#93a1a1",
    ansi: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
           "#586e75", "#cb4b16", "#93a1a1", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"],
  },
  {
    id: "solarized-light", label: "Solarized Light", bg: "#fdf6e3", fg: "#586e75",
    ansi: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
           "#586e75", "#cb4b16", "#93a1a1", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"],
  },
  {
    id: "github-light", label: "GitHub Light", bg: "#ffffff", fg: "#24292f",
    ansi: ["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781",
           "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"],
  },
];

/** Swatch labels, in ANSI order. */
const TERM_COLOR_NAMES = [
  "Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White",
  "Bright black", "Bright red", "Bright green", "Bright yellow",
  "Bright blue", "Bright magenta", "Bright cyan", "Bright white",
];

const termTheme = { preset: TERM_PRESETS[0].id, custom: null };

function termPreset(id) {
  return TERM_PRESETS.find((p) => p.id === id) || TERM_PRESETS[0];
}

/** The palette actually in force: the edited one, or the chosen preset. */
function termPalette() {
  return termTheme.custom || termPreset(termTheme.preset);
}

function isHex(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function validPalette(p) {
  return !!p && isHex(p.bg) && isHex(p.fg)
    && Array.isArray(p.ansi) && p.ansi.length === 16 && p.ansi.every(isHex);
}

function clonePalette(p) {
  return { bg: p.bg, fg: p.fg, ansi: [...p.ansi] };
}

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `amount` of `b` blended into `a`, as a hex string. */
function mix(a, b, amount) {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const part = (x, y) => Math.round(x + (y - x) * amount).toString(16).padStart(2, "0");
  return `#${part(ar, br)}${part(ag, bg)}${part(ab, bb)}`;
}

function applyTermTheme() {
  const palette = termPalette();
  const root = document.documentElement.style;
  root.setProperty("--term-bg", palette.bg);
  root.setProperty("--term-fg", palette.fg);
  palette.ansi.forEach((hex, i) => root.setProperty(`--term-c${i}`, hex));
  // The dock's own chrome - tab bar, tab labels, menus - is mixed out of the
  // scheme rather than fixed in the stylesheet. A light scheme would otherwise
  // keep the dark palette the dock was written for and paint pale text onto a
  // pale tab bar.
  root.setProperty("--term-bar", mix(palette.bg, palette.fg, 0.07));
  root.setProperty("--term-bar2", mix(palette.bg, palette.fg, 0.13));
  root.setProperty("--term-hover", mix(palette.bg, palette.fg, 0.11));
  root.setProperty("--term-line", mix(palette.bg, palette.fg, 0.22));
  root.setProperty("--term-dim", mix(palette.fg, palette.bg, 0.34));
  root.setProperty("--term-dim2", mix(palette.fg, palette.bg, 0.55));
}

function saveTermTheme() {
  if (window.devhqResetting) return;
  try {
    localStorage.setItem(TERM_THEME_KEY, JSON.stringify({
      preset: termTheme.preset,
      custom: termTheme.custom,
    }));
  } catch {
    /* storage disabled - the scheme simply does not persist */
  }
}

function loadTermTheme() {
  try {
    const saved = JSON.parse(localStorage.getItem(TERM_THEME_KEY) || "{}");
    if (TERM_PRESETS.some((p) => p.id === saved.preset)) termTheme.preset = saved.preset;
    if (validPalette(saved.custom)) termTheme.custom = clonePalette(saved.custom);
  } catch {
    /* first run, or corrupted - the default preset is fine */
  }
  applyTermTheme();
}

function broadcastTermTheme() {
  window.__TAURI__.event
    .emit("term:theme", { preset: termTheme.preset, custom: termTheme.custom })
    .catch(() => {});
}

// Dragging a colour picker reports a new colour on every mouse move. The
// screen follows each one, but writing to storage and waking the other window
// waits until the hand stops, so a drag stays a repaint and nothing more.
let termThemeCommit = null;
function commitTermTheme(defer) {
  clearTimeout(termThemeCommit);
  if (!defer) {
    saveTermTheme();
    broadcastTermTheme();
    return;
  }
  termThemeCommit = setTimeout(() => {
    saveTermTheme();
    broadcastTermTheme();
  }, 150);
}

/** Takes a scheme decided elsewhere: the settings page, or the other window. */
function adoptTermTheme(next, { broadcast = false, defer = false } = {}) {
  termTheme.preset = TERM_PRESETS.some((p) => p.id === next.preset) ? next.preset : TERM_PRESETS[0].id;
  termTheme.custom = validPalette(next.custom) ? clonePalette(next.custom) : null;
  applyTermTheme();
  if (broadcast) commitTermTheme(defer);
  else {
    clearTimeout(termThemeCommit);
    saveTermTheme();
  }
}

window.devhqTermTheme = {
  presets: TERM_PRESETS.map(({ id, label }) => ({ id, label })),
  colorNames: TERM_COLOR_NAMES,
  /** The preset in use, or "custom" once any colour has been changed. */
  selection: () => (termTheme.custom ? "custom" : termTheme.preset),
  presetLabel: () => termPreset(termTheme.preset).label,
  palette: () => clonePalette(termPalette()),
  usePreset(id) {
    if (!TERM_PRESETS.some((p) => p.id === id)) return;
    adoptTermTheme({ preset: id, custom: null }, { broadcast: true });
  },
  /** `key` is "bg", "fg" or an ANSI index. An edit seeds a custom palette from
   *  whatever is on screen, so changing one colour never loses the others. */
  setColor(key, value) {
    if (!isHex(value)) return;
    const custom = clonePalette(termPalette());
    if (key === "bg" || key === "fg") custom[key] = value;
    else if (Number.isInteger(key) && key >= 0 && key < 16) custom.ansi[key] = value;
    else return;
    adoptTermTheme({ preset: termTheme.preset, custom }, { broadcast: true, defer: true });
  },
  /** Drops the edits and goes back to the preset they were built on. */
  resetToPreset() {
    adoptTermTheme({ preset: termTheme.preset, custom: null }, { broadcast: true });
  },
};

loadTermTheme();

term_listen("term:theme", (event) => {
  const next = event.payload || {};
  if (next.preset === termTheme.preset
    && JSON.stringify(next.custom ?? null) === JSON.stringify(termTheme.custom)) return;
  adoptTermTheme(next);
  window.devhqOnTermThemeChanged?.();
});

const DEFAULT_COLOR = 4294967295;
const RGB_FLAG = 0x01000000;

const ATTR = { BOLD: 1, DIM: 2, ITALIC: 4, UNDERLINE: 8, REVERSE: 16, STRIKE: 32 };

/** Resolves a wire colour to CSS, or null for "use the theme default". */
function cssColor(v) {
  if (v === DEFAULT_COLOR) return null;
  if (v & RGB_FLAG) return "#" + (v & 0xffffff).toString(16).padStart(6, "0");
  if (v < 16) return `var(--term-c${v})`;
  if (v < 232) {
    // The 6x6x6 colour cube.
    const n = v - 16;
    const step = (x) => (x === 0 ? 0 : 55 + x * 40);
    const r = step(Math.floor(n / 36) % 6);
    const g = step(Math.floor(n / 6) % 6);
    const b = step(n % 6);
    return `rgb(${r},${g},${b})`;
  }
  const grey = 8 + (v - 232) * 10;
  return `rgb(${grey},${grey},${grey})`;
}

function termEsc(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

/** Where column `col` begins, in whole pixels.
 *
 *  A cell is a fraction of a pixel wide, so a run placed by adding those
 *  fractions up lands slightly off the column above it, and the two rows of a
 *  table stop agreeing. Rounding makes the left edge a function of the column
 *  alone: the same column is the same pixel on every row, and two runs that
 *  meet share an edge exactly, with no seam of background between them. */
function colX(col, cellW) {
  return Math.round(col * cellW);
}

// ------------------------------------------------------------------- links
//
// Terminal output is not markup: a link is whatever looks like one. The rule
// is deliberately narrow - a scheme worth handing to a browser, up to the
// first space - because everything found here is something Ctrl+click will
// open, and a shell prints all sorts of things.

const TERM_LINK = /(?:https?:\/\/|www\.)[^\s"'<>`]+/gu;

/** Where a link sits in `text`, if the column is inside one. */
function linkAt(text, col) {
  TERM_LINK.lastIndex = 0;
  let match;
  while ((match = TERM_LINK.exec(text))) {
    const start = match.index;
    const end = linkEnd(text, start, start + match[0].length);
    if (col >= start && col < end) {
      const href = text.slice(start, end);
      return { start, end, url: /^www\./i.test(href) ? `https://${href}` : href };
    }
  }
  return null;
}

/** Where a link really ends. Output puts links in sentences, so the full stop
 *  after one belongs to the sentence - but a bracket only does when it was
 *  never opened inside the link, which is what keeps a URL that contains
 *  brackets of its own whole. */
function linkEnd(text, start, end) {
  const closers = { ")": "(", "]": "[", "}": "{" };
  while (end > start) {
    const ch = text[end - 1];
    if (".,;:!?".includes(ch)) {
      end--;
      continue;
    }
    const open = closers[ch];
    if (open) {
      const slice = text.slice(start, end);
      const opened = slice.split(open).length - 1;
      const closed = slice.split(ch).length - 1;
      if (closed > opened) {
        end--;
        continue;
      }
    }
    break;
  }
  return end;
}

/** Hands a link to the browser, through the same opener the rest of DevHQ
 *  uses. Only http and https ever get here: a scheme a program invented is not
 *  something to pass to Windows on the strength of it appearing in output. */
function openTerminalLink(url) {
  if (!/^https?:\/\//i.test(url)) return;
  const key = `term-link:${Date.now()}`;
  window.devhqWork?.beginWork(key, "Opening your browser");
  term_invoke("plugin:opener|open_url", { url })
    .catch(() => {})
    .finally(() => window.devhqWork?.endWork(key));
}

/** The column a word step lands on, going `dir` from `col` in `text`.
 *
 *  Spaces first, then the run of characters of one kind - letters and digits,
 *  or punctuation - which is the rule an editor uses and the one a terminal
 *  row needs, since the colour a shell painted a word in says nothing about
 *  where the word ends. */
function wordEdge(text, col, dir) {
  const wordish = (ch) => /[\p{L}\p{N}_]/u.test(ch);
  const at = (i) => (dir < 0 ? text[i - 1] : text[i]);
  const inside = (i) => (dir < 0 ? i > 0 : i < text.length);
  while (inside(col) && /\s/u.test(at(col))) col += dir;
  if (!inside(col)) return col;
  const kind = wordish(at(col));
  while (inside(col) && !/\s/u.test(at(col)) && wordish(at(col)) === kind) col += dir;
  return col;
}

/** Renders one row's runs into HTML.
 *
 *  Every run is pinned to the column it starts at rather than being flowed
 *  after the one before it. A glyph the terminal font does not have is drawn
 *  from a fallback font at some other width; flowed, that pushes the whole
 *  rest of the line sideways and the table below stops lining up. Pinned, the
 *  next run starts where its column says it does whatever happened in the one
 *  before, and a run that might hold such a glyph is clipped to its own
 *  columns so it cannot even lean into its neighbour. */
function rowHtml(runs, cellW) {
  if (!runs || !runs.length) return "";
  let out = "";
  for (const run of runs) {
    let fg = cssColor(run.f);
    let bg = cssColor(run.b);
    // Reverse video swaps the pair. Each side has to be resolved to a real
    // colour *before* the swap — and to its own default, foreground for the
    // foreground. Resolving to the opposite one leaves a cell that already had
    // a dark background painting dark text onto the dark default, which is how
    // a program's reversed cursor block turns invisible.
    if (run.a & ATTR.REVERSE) {
      const f = fg ?? "var(--term-fg)";
      const b = bg ?? "var(--term-bg)";
      fg = b;
      bg = f;
    }
    const left = colX(run.x, cellW);
    const style = [`left:${left}px`, `width:${colX(run.x + run.w, cellW) - left}px`];
    if (run.c) style.push("overflow:hidden");
    if (fg) style.push(`color:${fg}`);
    if (bg) style.push(`background:${bg}`);
    if (run.a & ATTR.BOLD) style.push("font-weight:700");
    if (run.a & ATTR.DIM) style.push("opacity:.6");
    if (run.a & ATTR.ITALIC) style.push("font-style:italic");
    if (run.a & ATTR.UNDERLINE) style.push("text-decoration:underline");
    if (run.a & ATTR.STRIKE) style.push("text-decoration:line-through");
    out += `<span style="${style.join(";")}">${termEsc(run.t)}</span>`;
  }
  return out;
}

/** Keystrokes to the bytes a shell expects. */
function keySequence(e) {
  const k = e.key;
  const ctrl = e.ctrlKey;
  const alt = e.altKey;
  const app = (letter) => `\x1b[${letter}`;

  if (ctrl && k.length === 1) {
    const c = k.toUpperCase().charCodeAt(0);
    // Ctrl-A..Ctrl-Z plus the handful of control punctuation codes.
    if (c >= 64 && c <= 95) return String.fromCharCode(c - 64);
    if (k === " ") return "\x00";
  }
  switch (k) {
    // Shift+Enter continues the line instead of running it. A bare LF is the
    // byte a line editor reads as "another line", where CR is "go".
    case "Enter": return e.shiftKey ? "\n" : "\r";
    case "Backspace": return ctrl ? "\x17" : "\x7f";
    case "Tab": return e.shiftKey ? "\x1b[Z" : "\t";
    case "Escape": return "\x1b";
    case "ArrowUp": return ctrl ? "\x1b[1;5A" : app("A");
    case "ArrowDown": return ctrl ? "\x1b[1;5B" : app("B");
    case "ArrowRight": return ctrl ? "\x1b[1;5C" : app("C");
    case "ArrowLeft": return ctrl ? "\x1b[1;5D" : app("D");
    case "Home": return "\x1b[H";
    case "End": return "\x1b[F";
    case "PageUp": return "\x1b[5~";
    case "PageDown": return "\x1b[6~";
    case "Insert": return "\x1b[2~";
    case "Delete": return "\x1b[3~";
    case "F1": return "\x1bOP";
    case "F2": return "\x1bOQ";
    case "F3": return "\x1bOR";
    case "F4": return "\x1bOS";
    case "F5": return "\x1b[15~";
    case "F6": return "\x1b[17~";
    case "F7": return "\x1b[18~";
    case "F8": return "\x1b[19~";
    case "F9": return "\x1b[20~";
    case "F10": return "\x1b[21~";
    case "F11": return "\x1b[23~";
    case "F12": return "\x1b[24~";
    default: break;
  }
  if (k.length === 1) return alt ? "\x1b" + k : k;
  return null;
}

const TERM_PREFS_KEY = "devhq.terminals.v1";

// 0.35.3 stopped maintaining a DevHQ-owned command log. Remove the old index
// rather than leaving commands behind after the feature that wrote it is gone.
try { localStorage.removeItem("devhq.command-history.v1"); } catch {}

function enhancedHistoryEnabled() {
  try {
    const prefs = JSON.parse(localStorage.getItem(TERM_PREFS_KEY) || "{}");
    return prefs.enhancedHistorySearch !== false;
  } catch { return true; }
}

let nativeCommandHistory = [];
let nativeCommandHistoryLoad = null;
let nativeCommandHistoryLoaded = false;

function allCommandHistory() {
  const unique = new Map();
  for (const row of nativeCommandHistory) {
    const old = unique.get(row.command);
    if (old) old.runs = (old.runs || 1) + (row.runs || 1);
    else unique.set(row.command, { ...row });
  }
  return [...unique.values()];
}

function loadNativeCommandHistory(refresh = false) {
  if (refresh) {
    nativeCommandHistoryLoad = null;
    nativeCommandHistoryLoaded = false;
  }
  if (nativeCommandHistoryLoad) return nativeCommandHistoryLoad;
  nativeCommandHistoryLoad = term_invoke("term_command_history").then((rows) => {
    nativeCommandHistory = (Array.isArray(rows) ? rows : []).map((row, index) => ({
      command: row.command,
      shell: row.shell || "shell",
      source: row.shell === "pwsh" ? "PSReadLine" : row.shell === "bash" ? "Bash history" : row.shell === "nu" ? "NuShell history" : "Shell history",
      cwd: "",
      used: null,
      historyOrder: index,
      runs: 1,
    }));
    nativeCommandHistoryLoaded = true;
    return nativeCommandHistory;
  }).catch(() => { nativeCommandHistoryLoaded = true; return []; });
  return nativeCommandHistoryLoad;
}

const views = new Map();
let wired = false;

async function wireEvents() {
  if (wired) return;
  wired = true;
  await term_listen("term:update", (event) => {
    const view = views.get(event.payload.id);
    if (view) view.apply(event.payload);
  });
  await term_listen("term:exit", (event) => {
    const view = views.get(event.payload.id);
    if (view) view.markExited();
  });
}

class TermView {
  /** @param host element to fill; @param id session id from `term_open`. */
  constructor(host, id) {
    this.host = host;
    this.id = id;
    this.cols = 80;
    this.rows = 24;
    this.exited = false;
    this.onExit = null;
    this.onTitle = null;
    /** Fired once, the first time the session paints anything - the moment the
     *  shell is known to be up and reading. */
    this.onFirstOutput = null;
    this.lastCommandName = "";
    this.shellCommand = "";
    this.sessionHistory = [];
    this.historyArrowIndex = -1;
    this.historyArrowDraft = "";
    this.stickToBottom = true;
    /** While a resize is in flight, ConPTY repaints cannot move the viewport. */
    this.scrollHeld = false;
    this.heldScrollTop = 0;
    this.resizeToken = 0;
    this.debugStarted = performance.now();
    this.debugEvents = [];
    this.cx = 0;
    this.cy = 0;
    this.cursorVisible = true;
    // 0 is "nothing asked for", which is drawn as a thin bar.
    this.cursorStyle = 0;
    this.cursorChar = " ";
    host.classList.add("term");
    host.innerHTML =
      '<div class="term-scroll"><div class="term-history"></div>' +
      '<div class="term-screen"></div><div class="term-cursor"></div>' +
      '<div class="term-link"></div></div>' +
      '<div class="term-history-search" hidden><div class="term-history-query"><kbd>^R</kbd><span class="ms">search</span><input type="text" spellcheck="false" aria-label="Search command history"><small></small><button type="button" data-history-close aria-label="Close">&#215;</button></div><div class="term-history-filters"><button class="on" data-history-sort="recent">Recent</button><button data-history-sort="used">Most used</button><button data-history-sort="match">Best match</button></div><div class="term-history-results" role="listbox"></div><div class="term-history-foot"><span></span><div><button data-history-run>Run <kbd>Enter</kbd></button><button data-history-edit>Edit <kbd>Tab</kbd></button><small><kbd>^R</kbd> older &middot; <kbd>^S</kbd> newer &middot; <kbd>^G</kbd> cancel</small></div></div></div>';
    this.scroll = host.querySelector(".term-scroll");
    this.history = host.querySelector(".term-history");
    this.screen = host.querySelector(".term-screen");
    this.cursorEl = host.querySelector(".term-cursor");
    /** Drawn over the link under the pointer while Ctrl is held. Positioned by
     *  column like everything else on a row, so it lines up with the text
     *  whatever the font did. */
    this.linkEl = host.querySelector(".term-link");
    this.link = null;
    this.commandDraft = "";
    this.historySearch = host.querySelector(".term-history-search");
    this.historySearchInput = host.querySelector(".term-history-query input");
    this.historySearchResults = host.querySelector(".term-history-results");
    this.historySearchSort = "recent";
    this.historySearchIndex = 0;
    /** The last place the pointer was, so pressing Ctrl without moving still
     *  lights up what is under it. */
    this.pointer = null;
    this.rowEls = [];
    /** The runs behind the history rows, and the cell they were drawn against.
     *
     *  A row's columns are baked into it as pixels, so a history row drawn
     *  before the cell could be measured keeps that guess forever: every run
     *  after the first sits a fraction of a cell off, and by the middle of a
     *  line that fraction is a whole character of gap between two runs. The
     *  screen is redrawn when the measurement lands; the history has to be
     *  too, and this is what it is redrawn from. */
    this.historyRuns = [];
    this.historyCellW = 0;

    this.measure();
    this.remeasureWhenFontLoads();
    this.bind();
  }

  /** Measures one cell so sizing and the cursor agree with the real font.
   *
   *  The probe is a row inside `.term-screen`, not a bare span, so it picks up
   *  exactly the rules real rows are drawn with - a span's box is the font's
   *  inline height, which is not the line height the rows actually occupy. A
   *  hundred characters at once because the answer is a fraction of a pixel and
   *  every column is drawn at a multiple of it: an error of a hundredth walks
   *  a character out of line by the end of a long row, and dividing by a
   *  hundred keeps the error a hundredth of what one character could hide. */
  measure() {
    const probe = document.createElement("div");
    probe.className = "term-probe";
    probe.innerHTML = `<div>${"M".repeat(100)}</div>`;
    this.screen.appendChild(probe);
    const box = probe.firstElementChild.getBoundingClientRect();
    probe.remove();
    const w = box.width / 100;
    const h = box.height;
    // A terminal built into a panel that is not on screen yet has no layout to
    // measure, and a guessed cell is half a pixel out - which used to be
    // invisible and now is not, because the columns are drawn at multiples of
    // it. So a guess is remembered as a guess, and `fit` measures again the
    // first time the panel is real.
    this.measured = w > 1 && h > 1;
    this.cellW = this.measured ? w : this.cellW || 8;
    this.cellH = this.measured ? h : this.cellH || 17;
  }

  /** Font availability can settle after construction. A cell a fraction of a
   *  pixel out is invisible at column 1 and a whole character out by column 40,
   *  which is exactly where the cursor is seen to drift - so measure again once
   *  the local font is ready and realign the cursor and grid if needed. */
  /** Resolves once the cell measurement can be trusted. */
  async fontsSettled() {
    if (!document.fonts?.ready) return;
    try {
      await document.fonts.ready;
    } catch {}
    this.measure();
  }

  remeasureWhenFontLoads() {
    if (!document.fonts?.ready) return;
    document.fonts.ready.then(() => {
      const w = this.cellW;
      const h = this.cellH;
      this.measure();
      if (Math.abs(w - this.cellW) < 0.01 && Math.abs(h - this.cellH) < 0.01) return;
      this.moveCursor(this.cx, this.cy, this.cursorVisible);
      this.fit();
      // Columns are baked into the rows as pixels, so a different cell means
      // every row on screen is now drawn to the wrong grid.
      this.attachRepaint();
    });
  }

  bind() {
    this.host.tabIndex = 0;
    this.host.addEventListener("keydown", (e) => {
      if (e.key === "Control") this.setLink(this.pointer ? this.linkUnder(this.pointer) : null);
      if (this.exited) return;
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "r" || e.key === "R") && enhancedHistoryEnabled()) {
        e.preventDefault(); e.stopPropagation(); this.openHistorySearch(); return;
      }
      if (!e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && this.useArrowHistory(e.key === "ArrowUp" ? 1 : -1)) {
        e.preventDefault(); e.stopPropagation(); return;
      }
      // Pasting is left to the browser: returning here lets the keystroke
      // through to the native paste event, which is far more dependable than
      // reading the clipboard ourselves. Ctrl+V, Ctrl+Shift+V and the old
      // Shift+Insert all land there.
      if (e.ctrlKey && !e.altKey && (e.key === "v" || e.key === "V")) return;
      if (e.shiftKey && !e.ctrlKey && e.key === "Insert") return;
      // Ctrl+Shift+C is the copy that never means interrupt; Ctrl+Insert is
      // the same thing in Notepad's older spelling.
      if (e.ctrlKey && e.shiftKey && e.key === "C") return;
      if (e.ctrlKey && !e.shiftKey && e.key === "Insert") {
        this.copySelection();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Ctrl+` belongs to DevHQ, for toggling the panel from inside a terminal.
      if (e.ctrlKey && e.key === "`") return;
      // Selecting with the keyboard, the way any text editor does it: Shift
      // with a movement key extends the selection instead of reaching the
      // shell, Ctrl widens the step to a word or the whole scrollback.
      if (this.selectionKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Ctrl+Break is the console's own "break regardless" key, so it never
      // looks at the selection. Keyboards without a Break key are covered by
      // Ctrl+C twice, since copying drops the selection.
      if (e.ctrlKey && (e.key === "Pause" || e.key === "Cancel")) {
        e.preventDefault();
        e.stopPropagation();
        this.send("\x03");
        return;
      }
      // The Windows convention, as in Windows Terminal and VS Code: Ctrl+C
      // copies while something is selected and interrupts the moment nothing
      // is. Ctrl+Shift+C above is the unconditional copy.
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "c" || e.key === "C")) {
        if (this.copySelection()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
      const seq = keySequence(e);
      if (seq === null) return;
      if (e.key.startsWith("Arrow")) this.debugRecord("key", { key: e.key, seq: JSON.stringify(seq) });
      e.preventDefault();
      e.stopPropagation();
      // Notepad's rule: what is selected is what gets replaced. Backspace and
      // Delete just remove it; a typed character removes it and takes its
      // place. Both go in one write, so the shell never sees a half-done edit.
      const replaces =
        e.key === "Backspace" || e.key === "Delete" ||
        (!e.ctrlKey && !e.altKey && e.key.length === 1);
      const erase = replaces ? this.eraseSelectionSeq() : "";
      if (erase && (e.key === "Backspace" || e.key === "Delete")) {
        this.send(erase);
        return;
      }
      this.clearSelection();
      this.send(erase + seq);
    });
    this.historySearchInput.addEventListener("input", () => { this.historySearchIndex = 0; this.renderHistorySearch(); });
    this.historySearch.addEventListener("keydown", (e) => this.historySearchKey(e));
    this.historySearch.addEventListener("click", (e) => {
      const sort = e.target.closest("[data-history-sort]");
      const row = e.target.closest("[data-history-index]");
      if (sort) { this.historySearchSort = sort.dataset.historySort; this.historySearchIndex = 0; this.renderHistorySearch(); }
      else if (row) {
        this.historySearchIndex = Number(row.dataset.historyIndex);
        if (e.detail > 1) this.useHistoryResult(true);
        else this.renderHistorySearch();
      }
      else if (e.target.closest("[data-history-run]")) this.useHistoryResult(true);
      else if (e.target.closest("[data-history-edit]")) this.useHistoryResult(false);
      else if (e.target.closest("[data-history-close]")) this.closeHistorySearch();
    });
    this.host.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData("text");
      if (!text) return;
      const erase = this.eraseSelectionSeq();
      this.clearSelection();
      this.send(erase + text.replace(/\r?\n/g, "\r"));
    });
    this.host.addEventListener("mousedown", (e) => {
      this.host.focus();
      // Ctrl on a link is a click, not the beginning of a selection drag.
      if (e.ctrlKey && e.button === 0 && this.linkUnder(e)) e.preventDefault();
    });
    this.host.addEventListener("mousemove", (e) => {
      this.pointer = { target: e.target, clientX: e.clientX };
      this.setLink(e.ctrlKey ? this.linkUnder(this.pointer) : null);
    });
    this.host.addEventListener("mouseleave", () => this.setLink(null));
    this.host.addEventListener("keyup", (e) => {
      if (e.key === "Control") this.setLink(null);
    });
    this.host.addEventListener("click", (e) => {
      if (!e.ctrlKey || e.button !== 0) return;
      const link = this.linkUnder(e);
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      this.setLink(null);
      openTerminalLink(link.url);
    });
    this.scroll.addEventListener("scroll", () => {
      // A resize pins scrollTop on purpose; that must not look like the user
      // scrolled away from the live end.
      if (this.scrollHeld) return;
      this.stickToBottom = this.followTop() - this.scroll.scrollTop < 4;
    });
  }

  /** Handles the editor-style selection chords, reporting whether the key was
   *  one of them. Everything is done with the real document selection, so what
   *  is highlighted is exactly what Ctrl+C and the mouse already copy. */
  selectionKey(e) {
    if (e.altKey) return false;
    const sel = window.getSelection();
    if (!sel || typeof sel.extend !== "function") return false;

    // The first Ctrl+A on an editable command selects that command. Repeating
    // it expands to the whole terminal, preserving the previous shortcut.
    if (e.ctrlKey && (e.key === "a" || e.key === "A")) {
      if (this.selectCurrentCommand(sel)) return true;
      const range = document.createRange();
      range.setStartBefore(this.history);
      range.setEndAfter(this.screen);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    }

    // Ctrl+Home and Ctrl+End with no Shift are Notepad's jump to the top and
    // bottom of the document. There is no caret of ours to move, so they move
    // the view - the visible half of what Notepad does.
    if (e.ctrlKey && !e.shiftKey && (e.key === "Home" || e.key === "End")) {
      this.clearSelection();
      this.stickToBottom = e.key === "End";
      this.releaseScroll();
      this.scroll.scrollTop = e.key === "Home" ? 0 : this.followTop();
      return true;
    }

    if (!e.shiftKey || !this.selectionStep(e)) return false;
    this.anchorSelection(sel);
    if (!this.extendSelection(sel, e)) return false;
    this.scrollSelectionIntoView(sel);
    return true;
  }

  /** Selects the command after the visible shell prompt. Returns false when
   * the cursor is not on a recognizable, non-empty command, or when that
   * command is already selected so the caller can expand to all output. */
  selectCurrentCommand(sel) {
    if (this.host.classList.contains("alt") || !this.cursorVisible) return false;
    const row = this.rowEls[this.cy];
    if (!row) return false;
    const text = row.textContent || "";
    const cursor = Math.min(this.cx, text.length);
    const start = this.commandStart(text, cursor);
    const end = text.length;
    if (start === null || !text.slice(start, end).trim() || cursor < start || cursor > end) return false;

    const current = sel.rangeCount ? sel.getRangeAt(0) : null;
    if (current && row.contains(current.startContainer) && row.contains(current.endContainer)) {
      const selectedStart = this.colInRow(row, current.startContainer, current.startOffset);
      const selectedEnd = this.colInRow(row, current.endContainer, current.endOffset);
      if (selectedStart === start && selectedEnd === end) return false;
    }

    const [startNode, startOffset] = this.caretAt(row, start);
    const [endNode, endOffset] = this.caretAt(row, end);
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    sel.removeAllRanges();
    sel.addRange(range);
    this.scrollSelectionIntoView(sel);
    return true;
  }

  /** Finds the first editable column for the prompt formats used by DevHQ's
   * shell profiles. Anchoring the patterns keeps `>` and `$` inside commands
   * from being mistaken for a second prompt. */
  commandStart(text, cursor) {
    const beforeCursor = text.slice(0, cursor);
    const patterns = [
      /^PS\s+[^>]*>\s?/,                       // PowerShell
      /^[A-Za-z]:[\\/][^>]*>\s?/,             // Command Prompt
      /^.*?[$#❯➜〉]\s+/,                       // Bash, WSL, Git Bash, NuShell
      /^>\s+/,                                  // Minimal/NuShell prompt
    ];
    for (const pattern of patterns) {
      const match = beforeCursor.match(pattern);
      if (match) return match[0].length;
    }
    return null;
  }

  /** True when the cursor is sitting after a recognizable empty shell prompt.
   * This is the shell's observable acknowledgement that Ctrl+C returned
   * control; unlike a quiet output stream, it does not mistake a paused task
   * for a completed interrupt. */
  isAtPrompt() {
    if (this.exited || this.host.classList.contains("alt") || !this.cursorVisible) return false;
    const row = this.rowEls[this.cy];
    if (!row) return false;
    const text = row.textContent || "";
    const cursor = Math.min(this.cx, text.length);
    const start = this.commandStart(text, cursor);
    return start !== null && !text.slice(start).trim();
  }

  commandName(commandLine) {
    const match = String(commandLine || "").trim().match(/^(?:&\s+)?(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
    const executable = match?.[1] || match?.[2] || match?.[3] || "";
    return executable.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
  }

  runningCommandName() {
    return this.lastCommandName;
  }

  powerShellHistory() {
    if (!/\b(?:pwsh|powershell)(?:\.exe)?\b/i.test(this.shellCommand)) return [];
    const commands = [...this.sessionHistory, ...nativeCommandHistory
      .filter((row) => row.shell === "pwsh")
      .map((row) => row.command)];
    return commands.filter((command, index) => command && commands.indexOf(command) === index);
  }

  useArrowHistory(direction) {
    if (this.host.classList.contains("alt") || !nativeCommandHistoryLoaded) return false;
    const commands = this.powerShellHistory();
    if (!commands.length) return false;
    const row = this.rowEls[this.cy];
    const rowText = row?.textContent || "";
    const cursor = Math.min(this.cx, rowText.length);
    const start = this.commandStart(rowText, cursor);
    if (start === null) return false;
    const current = rowText.slice(start).trimEnd();
    if (this.historyArrowIndex < 0) this.historyArrowDraft = current;
    const next = Math.max(-1, Math.min(commands.length - 1, this.historyArrowIndex + direction));
    if (next === this.historyArrowIndex) return true;
    this.historyArrowIndex = next;
    const command = next < 0 ? this.historyArrowDraft : commands[next];
    this.commandDraft = command;
    const erase = "\x1b[H" + "\x1b[3~".repeat(current.length);
    const data = erase + command;
    this.debugRecord("history", { index: next, length: command.length });
    term_invoke("term_write", { id: this.id, data })
      .then(() => this.debugRecord("history-queued"))
      .catch((error) => this.debugRecord("history-error", { error: String(error) }));
    return true;
  }

  debugRecord(type, detail = {}) {
    this.debugEvents.push({ ms: Math.round(performance.now() - this.debugStarted), type, ...detail });
    if (this.debugEvents.length > 120) this.debugEvents.splice(0, this.debugEvents.length - 120);
  }

  debugReport() {
    return JSON.stringify({
      generated: new Date().toISOString(),
      id: this.id,
      viewport: {
        cols: this.cols, rows: this.rows, cx: this.cx, cy: this.cy,
        scrollTop: Math.round(this.scroll.scrollTop), followTop: Math.round(this.followTop()),
        stickToBottom: this.stickToBottom, scrollHeld: this.scrollHeld,
      },
      events: this.debugEvents,
    }, null, 2);
  }

  // ------------------------------------------------------- moving a selection
  //
  // Every selection chord moves the loose end of the selection, and every one
  // of them moves it the same way: work out the row and column it should land
  // on, then put it there with `sel.extend`. One mechanism, one set of
  // coordinates.
  //
  // The browser's own `Selection.modify` is not that mechanism, and mixing the
  // two is what made Ctrl+Shift+Right need pressing twice after a
  // Ctrl+Shift+Left: `modify` works from directional state it keeps for
  // itself, `extend` does not update that state, and the first `modify` after
  // an `extend` is spent catching up. Anything else built out of the pair
  // would have had a bug of the same shape waiting in it.
  //
  // Doing it here is also the only way to be right about a terminal. `modify`
  // reads the DOM as prose, and a terminal row is spans of colour: its word
  // steps stop at a change of colour rather than at a word. What a step means
  // is decided from the row's text, in columns, which is what the row is.

  /** The link under a pointer position, or null. A row's text is its columns,
   *  so the column under the pointer is a division by the cell. */
  linkUnder(at) {
    const row = at.target?.closest?.(".term-history > div, .term-screen > div");
    if (!row || !this.host.contains(row)) return null;
    const box = row.getBoundingClientRect();
    const col = Math.floor((at.clientX - box.left) / this.cellW);
    if (col < 0) return null;
    const found = linkAt(row.textContent || "", col);
    return found && { ...found, row };
  }

  /** Underlines the link a click would open, or takes the underline away. */
  setLink(link) {
    if (link && this.link && link.row === this.link.row && link.start === this.link.start) return;
    if (!link && !this.link) return;
    this.link = link;
    this.host.classList.toggle("linking", Boolean(link));
    if (!link) {
      this.linkEl.style.display = "none";
      return;
    }
    const left = colX(link.start, this.cellW);
    this.linkEl.style.display = "block";
    this.linkEl.style.left = `${link.row.offsetLeft + left}px`;
    this.linkEl.style.width = `${colX(link.end, this.cellW) - left}px`;
    this.linkEl.style.top = `${link.row.offsetTop}px`;
    this.linkEl.style.height = `${link.row.offsetHeight}px`;
    this.linkEl.title = link.url;
  }

  /** Every drawn row, history first, in the order they appear. */
  rowList() {
    return [...this.history.children, ...this.rowEls];
  }

  /** Where the loose end of the selection sits, as a row and a column, or null
   *  if it is not in this terminal. */
  focusPoint(sel) {
    if (!sel.focusNode) return null;
    const element = sel.focusNode.nodeType === Node.ELEMENT_NODE
      ? sel.focusNode
      : sel.focusNode.parentElement;
    const row = element?.closest(".term-history > div, .term-screen > div");
    if (!row || !this.host.contains(row)) return null;
    const rows = this.rowList();
    const index = rows.indexOf(row);
    if (index < 0) return null;
    return { rows, index, col: this.colInRow(row, sel.focusNode, sel.focusOffset) };
  }

  /** Moves the loose end of the selection by whatever the key asked for. */
  extendSelection(sel, e) {
    const at = this.focusPoint(sel);
    if (!at) return false;
    const to = this.stepFrom(at, e);
    if (!to) return false;
    const [node, offset] = this.caretAt(at.rows[to.index], to.col);
    sel.extend(node, offset);
    return true;
  }

  /** The row and column one movement key leads to.
   *
   *  Rows are stored without their trailing blanks, so a row's text is its
   *  columns and the end of the text is the end of the line. */
  stepFrom({ rows, index, col }, e) {
    const text = (i) => rows[i]?.textContent || "";
    const line = text(index);
    const last = rows.length - 1;
    const ctrl = e.ctrlKey;
    switch (e.key) {
      case "ArrowLeft":
        if (col <= 0) {
          return index > 0 ? { index: index - 1, col: text(index - 1).length } : { index, col: 0 };
        }
        return { index, col: ctrl ? wordEdge(line, col, -1) : col - 1 };
      case "ArrowRight":
        if (col >= line.length) {
          return index < last ? { index: index + 1, col: 0 } : { index, col: line.length };
        }
        return { index, col: ctrl ? wordEdge(line, col, 1) : col + 1 };
      // A terminal's paragraph is its line, so Ctrl adds nothing to up and down.
      case "ArrowUp":
        return { index: Math.max(0, index - 1), col };
      case "ArrowDown":
        return { index: Math.min(last, index + 1), col };
      case "PageUp":
      case "PageDown": {
        // A page is the lines on screen less one, the overlap Notepad leaves.
        const page = Math.max(1, Math.floor(this.scroll.clientHeight / this.cellH) - 1);
        const to = e.key === "PageUp" ? index - page : index + page;
        return { index: Math.min(last, Math.max(0, to)), col };
      }
      case "Home":
        if (ctrl) return { index: 0, col: 0 };
        // The shell prompt is not editable text, so Home stops at the command
        // rather than swallowing the prompt in front of it.
        return { index, col: this.commandStart(line, Math.min(col, line.length)) ?? 0 };
      case "End":
        if (ctrl) return { index: last, col: text(last).length };
        return { index, col: line.length };
      default:
        return null;
    }
  }

  /** Whether this key moves a selection at all. */
  selectionStep(e) {
    return ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]
      .includes(e.key);
  }

  /** A selection has to start somewhere. If this terminal does not already own
   *  one, the caret is dropped at the cursor - the place the user is looking. */
  anchorSelection(sel) {
    if (!sel.isCollapsed && sel.rangeCount && this.host.contains(sel.anchorNode) && this.host.contains(sel.focusNode)) return;
    const row = this.rowEls[this.cy];
    if (!row) return;
    const [node, offset] = this.caretAt(row, this.cx);
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    sel.addRange(range);
  }

  /** The DOM position of column `col` on `row`. Rows are packed without their
   *  trailing blanks, so a cursor sitting past the text lands at the end of the
   *  row - the nearest position that exists. */
  caretAt(row, col) {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let seen = 0;
    let last = null;
    let node;
    while ((node = walker.nextNode())) {
      if (seen + node.data.length >= col) return [node, col - seen];
      seen += node.data.length;
      last = node;
    }
    if (last) return [last, last.data.length];
    return [row, 0];
  }

  /** Keeps the moving end of the selection on screen. */
  scrollSelectionIntoView(sel) {
    if (!sel.rangeCount || !sel.focusNode) return;
    const range = document.createRange();
    range.setStart(sel.focusNode, sel.focusOffset);
    range.collapse(true);
    let box = range.getBoundingClientRect();
    if (!box.height) box = sel.getRangeAt(0).getBoundingClientRect();
    if (!box.height) return;
    const view = this.scroll.getBoundingClientRect();
    if (box.top < view.top) this.scroll.scrollTop -= view.top - box.top + 4;
    else if (box.bottom > view.bottom) this.scroll.scrollTop += box.bottom - view.bottom + 4;
  }

  /** Drops this terminal's selection, the way typing does in an editor. */
  clearSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    if (!this.host.contains(sel.anchorNode) || !this.host.contains(sel.focusNode)) return;
    sel.removeAllRanges();
  }

  /** The keystrokes that rub out the selection, or "" if it is not something
   *  this terminal can delete.
   *
   *  Only the shell owns the text on screen, so deleting means asking it to:
   *  walk its cursor to the end of the selection and backspace over it. That
   *  is only honest for a selection sitting on the line being edited - the
   *  scrollback above it is output that has already happened, and a full-screen
   *  program owns its own keyboard - so everything else is left alone. */
  eraseSelectionSeq() {
    if (this.host.classList.contains("alt")) return "";
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
    const row = this.rowEls[this.cy];
    if (!row) return "";
    const range = sel.getRangeAt(0);
    if (!row.contains(range.startContainer) || !row.contains(range.endContainer)) return "";
    const start = this.colInRow(row, range.startContainer, range.startOffset);
    const end = this.colInRow(row, range.endContainer, range.endOffset);
    if (end <= start) return "";
    const text = row.textContent || "";
    const commandStart = this.commandStart(text, Math.min(this.cx, text.length));
    if (commandStart === null || start < commandStart || end > text.trimEnd().length) return "";
    sel.removeAllRanges();
    const dx = start - this.cx;
    const walk = dx > 0 ? "\x1b[C".repeat(dx) : "\x1b[D".repeat(-dx);
    return walk + "\x1b[3~".repeat(end - start);
  }

  /** The column a DOM position sits at within `row`, counted as the text in
   *  front of it. Rows hold nothing but spans of text, so the range's own
   *  string is the count. */
  colInRow(row, node, offset) {
    const range = document.createRange();
    range.setStart(row, 0);
    range.setEnd(node, offset);
    return range.toString().length;
  }

  /** Copies this terminal's selection, reporting whether there was one to copy.
   *
   *  A selection somewhere else on the page is not this terminal's business —
   *  Ctrl+C has to reach the shell in that case. The selection is dropped after
   *  copying, which is both the visible confirmation that something was copied
   *  and what makes an immediately repeated Ctrl+C an interrupt. */
  copySelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    if (!this.host.contains(sel.anchorNode) || !this.host.contains(sel.focusNode)) return false;
    const text = sel.toString();
    if (!text) return false;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    } else {
      document.execCommand("copy");
    }
    sel.removeAllRanges();
    return true;
  }

  openHistorySearch() {
    if (!this.historySearch.hidden) return;
    this.historySearch.hidden = false;
    this.historySearchInput.value = this.commandDraft;
    this.historySearchIndex = 0;
    this.renderHistorySearch();
    this.historySearchInput.focus();
    this.historySearchInput.select();
    loadNativeCommandHistory(true).then(() => {
      if (!this.historySearch.hidden) this.renderHistorySearch();
    });
  }

  closeHistorySearch() {
    this.historySearch.hidden = true;
    this.host.focus();
  }

  historyMatches() {
    const query = this.historySearchInput.value.trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    const rows = allCommandHistory().filter((row) => terms.every((term) => row.command.toLowerCase().includes(term)));
    const recent = (a, b) => {
      if (a.used && b.used) return b.used - a.used;
      if (a.used) return -1;
      if (b.used) return 1;
      return (a.historyOrder ?? Number.MAX_SAFE_INTEGER) - (b.historyOrder ?? Number.MAX_SAFE_INTEGER);
    };
    if (this.historySearchSort === "used") rows.sort((a, b) => (b.runs || 0) - (a.runs || 0) || recent(a, b));
    else if (this.historySearchSort === "match") rows.sort((a, b) => {
      const score = (row) => !query ? 0 : row.command.toLowerCase().startsWith(query) ? 3 : row.command.toLowerCase().includes(query) ? 2 : 1;
      return score(b) - score(a) || recent(a, b);
    });
    else rows.sort(recent);
    return rows.slice(0, 100);
  }

  renderHistorySearch() {
    const rows = this.historyMatches();
    this.historySearchRows = rows;
    this.historySearchIndex = Math.max(0, Math.min(this.historySearchIndex, rows.length - 1));
    for (const button of this.historySearch.querySelectorAll("[data-history-sort]")) {
      button.classList.toggle("on", button.dataset.historySort === this.historySearchSort);
    }
    const query = this.historySearchInput.value.trim();
    this.historySearch.querySelector(".term-history-query small").textContent = `${rows.length} match${rows.length === 1 ? "" : "es"}`;
    this.historySearchResults.innerHTML = rows.length ? rows.map((row, index) =>
      `<button type="button" role="option" aria-selected="${index === this.historySearchIndex}" class="${index === this.historySearchIndex ? "on" : ""}" data-history-index="${index}"><code>${termEsc(row.shell)}</code><strong>${termEsc(row.command)}</strong><span>${row.runs || 1}&times;</span><em>${termEsc(row.source || "Shell history")}</em></button>`
    ).join("") : `<div class="term-history-empty">${query ? "No commands match this search" : "No native shell history entries found"}</div>`;
    this.historySearchResults.querySelector(".on")?.scrollIntoView({ block: "nearest" });
    const total = allCommandHistory().length;
    const loading = nativeCommandHistoryLoad && !nativeCommandHistoryLoaded;
    this.historySearch.querySelector(".term-history-foot>span").textContent = `${loading ? "Loading shell history · " : "Searching "}${total} history entr${total === 1 ? "y" : "ies"}`;
  }

  historySearchKey(e) {
    e.stopPropagation();
    if (e.key === "Escape" || (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "g" || e.key === "G"))) {
      e.preventDefault(); this.closeHistorySearch();
    }
    else if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "r" || e.key === "R")) {
      e.preventDefault();
      const count = this.historySearchRows?.length || 0;
      if (count) this.historySearchIndex = (this.historySearchIndex + 1) % count;
      this.renderHistorySearch();
    }
    else if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      const count = this.historySearchRows?.length || 0;
      if (count) this.historySearchIndex = (this.historySearchIndex - 1 + count) % count;
      this.renderHistorySearch();
    }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      this.historySearchIndex = Math.max(0, Math.min((this.historySearchRows?.length || 1) - 1, this.historySearchIndex + delta));
      this.renderHistorySearch();
    } else if (e.key === "Enter") { e.preventDefault(); this.useHistoryResult(true); }
    else if (e.key === "Tab") { e.preventDefault(); this.useHistoryResult(false); }
  }

  useHistoryResult(run) {
    const command = this.historySearchRows?.[this.historySearchIndex]?.command;
    if (!command) return;
    const row = this.rowEls[this.cy];
    const rowText = row?.textContent || "";
    const cursor = Math.min(this.cx, rowText.length);
    const start = this.commandStart(rowText, cursor);
    const visibleInput = start === null ? this.commandDraft : rowText.slice(start).trimEnd();
    this.closeHistorySearch();
    // Home and Delete are terminal editing keys rather than control characters,
    // so shells without a Ctrl+K binding cannot print a literal ^K. Send the
    // whole replacement as one write so a half-edited command never flashes.
    const erase = "\x1b[H" + "\x1b[3~".repeat(visibleInput.length);
    this.commandDraft = run ? "" : command;
    if (run) {
      const name = this.commandName(command);
      if (name) this.lastCommandName = name;
    }
    term_invoke("term_write", { id: this.id, data: `${erase}${command}${run ? "\r" : ""}` })
      .catch(() => {});
  }

  send(text) {
    this.debugRecord("write", { bytes: JSON.stringify(text), length: text.length });
    if (text.includes("\r")) {
      const inline = text.slice(0, text.indexOf("\r"));
      let commandLine = inline.replace(/[\x00-\x1f\x7f]/g, "").trim();
      if (!commandLine) commandLine = this.commandDraft.trim();
      if (!commandLine && !this.host.classList.contains("alt")) {
        const row = this.rowEls[this.cy];
        const rowText = row?.textContent || "";
        const cursor = Math.min(this.cx, rowText.length);
        const start = this.commandStart(rowText, cursor);
        if (start !== null) commandLine = rowText.slice(start, cursor).trim();
      }
      const name = this.commandName(commandLine);
      if (name) this.lastCommandName = name;
      if (commandLine && this.sessionHistory[0] !== commandLine) this.sessionHistory.unshift(commandLine);
      this.historyArrowIndex = -1;
      this.historyArrowDraft = "";
      this.commandDraft = "";
    } else if (!text.includes("\x1b") && !text.includes("\x03")) {
      for (const char of text) {
        if (char === "\x7f") this.commandDraft = this.commandDraft.slice(0, -1);
        else if (char >= " ") this.commandDraft += char;
      }
    }
    term_invoke("term_write", { id: this.id, data: text })
      .then(() => this.debugRecord("write-queued"))
      .catch((error) => this.debugRecord("write-error", { error: String(error) }));
  }

  /** Pulls the current screen and starts following updates. */
  async attach() {
    await wireEvents();
    // Columns are drawn at a multiple of the measured cell, so the cell has to
    // be the real one before a single row is painted - a row measured against
    // a stand-in font would keep its wrong columns until it scrolled away.
    await this.fontsSettled();
    views.set(this.id, this);
    const snap = await term_invoke("term_attach", { id: this.id });
    this.shellCommand = snap.info.command || "";
    loadNativeCommandHistory();
    this.cols = snap.cols;
    this.rows = snap.rows;
    this.exited = !snap.info.alive;
    this.history.innerHTML = snap.history.map((runs) => `<div>${rowHtml(runs, this.cellW)}</div>`).join("");
    this.historyRuns = snap.history.slice();
    this.historyCellW = this.cellW;
    this.buildScreen();
    for (const row of snap.screen) this.paintRow(row.y, row.runs);
    this.moveCursor(snap.cx, snap.cy, snap.cursorVisible, snap.cursorStyle, snap.cursorChar);
    this.settleScroll();
    return snap.info;
  }

  buildScreen() {
    this.screen.innerHTML = Array.from({ length: this.rows }, () => "<div></div>").join("");
    this.rowEls = [...this.screen.children];
  }

  paintRow(y, runs) {
    const el = this.rowEls[y];
    if (el) el.innerHTML = rowHtml(runs, this.cellW);
  }

  apply(payload) {
    this.debugRecord("update", {
      rows: payload.rows.length, scrolled: payload.scrolled.length,
      cx: payload.cx, cy: payload.cy, alt: payload.alt,
    });
    const contentAdvanced = payload.clearHistory || payload.scrolled.length || payload.cy !== this.cy;
    if (payload.clearHistory) {
      // CSI 3 J - `clear` / Clear-Host. Drop the painted history so Restore
      // cannot settle back onto lines the shell already wiped.
      this.history.innerHTML = "";
      this.historyRuns = [];
      this.releaseScroll();
    }
    if (payload.scrolled.length) {
      // Lines that fell off the top of the screen become history.
      const frag = document.createDocumentFragment();
      for (const runs of payload.scrolled) {
        const div = document.createElement("div");
        div.innerHTML = rowHtml(runs, this.cellW);
        frag.appendChild(div);
      }
      this.history.appendChild(frag);
      this.historyRuns.push(...payload.scrolled);
      // Keep the DOM bounded; the session still holds the full scrollback.
      const excess = this.history.childElementCount - 3000;
      for (let i = 0; i < excess; i++) this.history.firstElementChild.remove();
      if (excess > 0) this.historyRuns.splice(0, excess);
    }
    for (const row of payload.rows) this.paintRow(row.y, row.runs);
    this.moveCursor(payload.cx, payload.cy, payload.cursorVisible, payload.cursorStyle, payload.cursorChar);
    this.host.classList.toggle("alt", payload.alt);
    if (this.onFirstOutput) {
      const fire = this.onFirstOutput;
      this.onFirstOutput = null;
      fire();
    }
    if (payload.title && this.onTitle) this.onTitle(payload.title);
    if (this.stickToBottom && contentAdvanced) this.settle();
  }

  /** Puts the cursor on a column of the grid.
   *
   *  Rows are drawn column by column, so the column is all the position the
   *  cursor needs - and the only one that is right, since the row's own
   *  characters no longer answer for where a column is once a wide glyph or a
   *  fallback font is involved. */
  moveCursor(cx, cy, visible, style = this.cursorStyle, cursorChar = this.cursorChar) {
    this.cx = cx;
    this.cy = cy;
    this.cursorVisible = visible;
    this.cursorStyle = style ?? 0;
    this.cursorChar = cursorChar || " ";
    this.paintCursor();
  }

  /** Draws the cursor from the state `moveCursor` last recorded. */
  paintCursor() {
    const cx = this.cx;
    const cy = this.cy;
    const visible = this.cursorVisible;
    this.cursorEl.style.display = visible && !this.exited ? "block" : "none";
    const row = this.rowEls[cy];
    // The cursor is a separate overlay, so it mirrors the backend's exact
    // cell. DOM string offsets cannot be used here: wide terminal glyphs make
    // browser character offsets diverge from terminal columns.
    // A thin bar is the resting shape: 0 is the shape nothing has asked to
    // change. A block means overwrite - insert mode, or a full-screen program
    // that asked for one outright.
    const bar = this.cursorStyle === 0 || this.cursorStyle === 5 || this.cursorStyle === 6;
    const underline = this.cursorStyle === 3 || this.cursorStyle === 4;
    this.cursorEl.classList.toggle("bar", bar);
    this.cursorEl.classList.toggle("underline", underline);
    this.cursorEl.textContent = bar || underline ? "" : this.cursorChar;
    const cellLeft = colX(cx, this.cellW);
    this.cursorEl.style.width = `${bar ? 2 : colX(cx + 1, this.cellW) - cellLeft}px`;
    const rowHeight = row?.offsetHeight || this.cellH;
    this.cursorEl.style.height = `${underline ? 2 : rowHeight}px`;
    const x = this.screen.offsetLeft + cellLeft;
    const y = row ? row.offsetTop : this.screen.offsetTop + cy * this.cellH;
    this.cursorEl.style.transform = `translate(${x}px, ${y + (underline ? rowHeight - 2 : 0)}px)`;
  }

  /** How far the followed live end sits. Two empty rows remain visible below
   *  the last used row, making it visually clear that this really is the end,
   *  without exposing the terminal's entire blank screen grid. */
  maxScroll() {
    return Math.max(0, this.usedHeight() + this.cellH * 2 - this.scroll.clientHeight);
  }

  /** Where following the live end actually puts the scroller.
   *
   *  `maxScroll` alone stops at the last written row. After `clear`, that row
   *  is the top of a blank screen under a short scrollback, so the value is 0
   *  and Restore / settle leave the history filling the window - clear looks
   *  like it did nothing. Prefer the live screen whenever it sits below the
   *  history, clamped to what the browser will actually scroll. */
  followTop() {
    const limit = Math.max(0, this.scroll.scrollHeight - this.scroll.clientHeight);
    const bottom = Math.min(this.maxScroll(), limit);
    const screenTop = this.screen.offsetTop;
    if (screenTop <= 0) return bottom;
    return Math.min(limit, Math.max(bottom, screenTop));
  }

  toBottom() {
    this.releaseScroll();
    this.scroll.scrollTop = this.followTop();
  }

  /** Pin the scroller until the newest in-flight resize has fully repainted. */
  holdScroll() {
    if (!this.scrollHeld) this.heldScrollTop = this.scroll.scrollTop;
    this.scrollHeld = true;
  }

  releaseScroll() {
    this.scrollHeld = false;
    // Any older resize completion must not restore a hold the user released.
    this.resizeToken++;
  }

  /** How far down the last row with anything in it reaches.
   *
   *  The screen grid is as tall as the viewport whether or not anything has
   *  been printed into it, so "does it fit" has to be asked of the rows
   *  actually in use and not of the scroll height. */
  usedHeight() {
    if (!this.rowEls.length) return this.scroll.clientHeight;
    // A shrink blanks the grid before the session has repainted into it, and
    // the cursor still points at a row that is no longer there.
    let last = Math.max(0, Math.min(this.cy, this.rowEls.length - 1));
    for (let y = this.rowEls.length - 1; y > last; y--) {
      if (this.rowEls[y].textContent.trim()) {
        last = y;
        break;
      }
    }
    const row = this.rowEls[last];
    return row ? row.offsetTop + row.offsetHeight : this.screen.offsetTop + this.screen.offsetHeight;
  }

  /** Where the scroller belongs: the top for as long as everything written
   *  fits, the bottom once it does not — and after a clear, the live screen,
   *  not the scrollback still sitting above it.
   *
   *  Anchoring to the top while there is room is the whole point - a session
   *  that has printed five lines into a tall window reads from its first line,
   *  and typing into it must not shove those five lines up to the bottom edge.
   *  The moment the output outgrows the window the live end is what matters,
   *  and the bottom of it sits on the bottom of the window. */
  settle() {
    if (this.scrollHeld) {
      this.scroll.scrollTop = this.heldScrollTop;
      return;
    }
    this.scroll.scrollTop = this.followTop();
  }

  /** Where a terminal rests when it is first shown or restored. Following the
   *  output is the resting state; only scrolling up by hand turns it off.
   *  A resize must not call this - that is what `holdScroll` is for. */
  settleScroll() {
    this.releaseScroll();
    this.stickToBottom = true;
    this.settle();
  }

  /** Recomputes the grid size from the element and tells the session.
   *
   *  The scroller stays where it was. Growing or shrinking the window used to
   *  run the same settle path a restored terminal uses, which yanked the view
   *  to the live end on every drag. The grid and the pseudoconsole still
   *  resize; only the scroll position is left alone until the next restore or
   *  until live output is being followed again after the freeze lifts. */
  fit() {
    const box = this.host.getBoundingClientRect();
    if (box.width < 20 || box.height < 20) return;
    // The first time there is a real box there is a real cell to measure, and
    // whatever was drawn against the guess has to be drawn again.
    if (!this.measured) {
      this.measure();
      if (this.measured) this.attachRepaint();
    }
    const cols = Math.max(20, Math.floor((box.width - 16) / this.cellW));
    const rows = Math.max(5, Math.floor((box.height - 12) / this.cellH));
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.debugRecord("resize", { cols, rows });
    this.holdScroll();
    const resizeToken = ++this.resizeToken;
    this.buildScreen();
    term_invoke("term_resize", { id: this.id, cols, rows })
      .then(() => this.attachRepaint())
      .catch(() => {})
      .finally(() => {
        if (resizeToken !== this.resizeToken || !this.scrollHeld) return;
        this.scroll.scrollTop = this.heldScrollTop;
        requestAnimationFrame(() => {
          if (resizeToken === this.resizeToken) this.scrollHeld = false;
        });
      });
  }

  /** Redraws the history against the cell as it is now.
   *
   *  Nothing else ever changes a history row - it is finished output - so this
   *  does nothing unless the measurement it was drawn against has changed,
   *  which is once: the first time the panel is real, or when the terminal
   *  font finishes loading. A resize does not move a column, so it does not
   *  cost the redraw. */
  repaintHistory() {
    if (this.historyCellW === this.cellW || !this.historyRuns.length) return;
    this.historyCellW = this.cellW;
    this.history.innerHTML = this.historyRuns
      .map((runs) => `<div>${rowHtml(runs, this.cellW)}</div>`)
      .join("");
  }

  /** After a resize the session repaints; pull the new screen immediately so
   *  the grid is never briefly blank. Does not move the scroller - that is
   *  `attach`'s job on restore, not a size change's. History is refreshed from
   *  the session so a `clear` that wiped scrollback is not painted back. */
  async attachRepaint() {
    this.repaintHistory();
    try {
      const snap = await term_invoke("term_attach", { id: this.id });
      if (snap.history.length !== this.historyRuns.length) {
        this.history.innerHTML = snap.history
          .map((runs) => `<div>${rowHtml(runs, this.cellW)}</div>`)
          .join("");
        this.historyRuns = snap.history.slice();
        this.historyCellW = this.cellW;
      }
      for (const row of snap.screen) this.paintRow(row.y, row.runs);
      this.moveCursor(snap.cx, snap.cy, snap.cursorVisible, snap.cursorStyle, snap.cursorChar);
      if (this.scrollHeld) {
        this.scroll.scrollTop = this.heldScrollTop;
      }
    } catch {}
  }

  markExited() {
    this.exited = true;
    this.cursorEl.style.display = "none";
    this.host.classList.add("exited");
    if (this.onExit) this.onExit();
  }

  focus() {
    this.host.focus();
  }

  /** Detaches the view. The session keeps running — that is the whole point. */
  dispose() {
    this.setLink(null);
    if (views.get(this.id) === this) views.delete(this.id);
  }
}

window.TermView = TermView;
