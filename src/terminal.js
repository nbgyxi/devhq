// A view onto a terminal session. The session itself — pseudoconsole, shell
// and screen — lives in Rust; this only paints cells and forwards keystrokes,
// which is why the same class serves the docked panel and the popped-out
// window without either owning the shell.

const term_invoke = window.__TAURI__.core.invoke;
const term_listen = window.__TAURI__.event.listen;

// The usual 16, tuned to sit on DevHQ's near-black background rather than a
// pure-black one.
const BASE16 = [
  "#1c1f26", "#e05561", "#8cc265", "#d5a458", "#4d9df5", "#c162de", "#42b3c2", "#c8ccd4",
  "#5c6370", "#ff6b78", "#a5e075", "#e6c07b", "#61afef", "#d55fde", "#56b6c2", "#ffffff",
];
const DEFAULT_COLOR = 4294967295;
const RGB_FLAG = 0x01000000;

const ATTR = { BOLD: 1, DIM: 2, ITALIC: 4, UNDERLINE: 8, REVERSE: 16, STRIKE: 32 };

/** Resolves a wire colour to CSS, or null for "use the theme default". */
function cssColor(v) {
  if (v === DEFAULT_COLOR) return null;
  if (v & RGB_FLAG) return "#" + (v & 0xffffff).toString(16).padStart(6, "0");
  if (v < 16) return BASE16[v];
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

/** Renders one row's runs into HTML. */
function rowHtml(runs) {
  if (!runs || !runs.length) return "";
  let out = "";
  for (const run of runs) {
    let fg = cssColor(run.f);
    let bg = cssColor(run.b);
    // Reverse video swaps the pair, and has to fall back to the theme's own
    // colours when either side is the default.
    if (run.a & ATTR.REVERSE) {
      const f = fg === null ? "var(--term-bg)" : fg;
      const b = bg === null ? "var(--term-fg)" : bg;
      fg = b;
      bg = f;
    }
    const style = [];
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
    case "Enter": return "\r";
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

/** One shared listener pair, fanned out to whichever views are mounted. */
const views = new Map();
let wired = false;

async function wireEvents() {
  if (wired) return;
  wired = true;
  await term_listen("term:update", (event) => {
    window.devhqTerminalChanged?.(event.payload.id);
    const view = views.get(event.payload.id);
    if (view) view.apply(event.payload);
  });
  await term_listen("term:exit", (event) => {
    window.devhqTerminalChanged?.(event.payload.id);
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
    this.stickToBottom = true;
    this.cx = 0;
    this.cy = 0;
    this.cursorVisible = true;

    host.classList.add("term");
    host.innerHTML =
      '<div class="term-scroll"><div class="term-history"></div>' +
      '<div class="term-screen"></div><div class="term-cursor"></div></div>';
    this.scroll = host.querySelector(".term-scroll");
    this.history = host.querySelector(".term-history");
    this.screen = host.querySelector(".term-screen");
    this.cursorEl = host.querySelector(".term-cursor");
    this.rowEls = [];

    this.measure();
    this.remeasureWhenFontLoads();
    this.bind();
  }

  /** Measures one cell so sizing and the cursor agree with the real font.
   *
   *  The probe is a row inside `.term-screen`, not a bare span, so it picks up
   *  exactly the rules real rows are drawn with - a span's box is the font's
   *  inline height, which is not the line height the rows actually occupy. */
  measure() {
    const probe = document.createElement("div");
    probe.className = "term-probe";
    probe.innerHTML = `<div>${"M".repeat(10)}</div>`;
    this.screen.appendChild(probe);
    const box = probe.firstElementChild.getBoundingClientRect();
    this.cellW = box.width / 10 || 8;
    this.cellH = box.height || 17;
    probe.remove();
  }

  /** Font availability can settle after construction. A cell a fraction of a
   *  pixel out is invisible at column 1 and a whole character out by column 40,
   *  which is exactly where the cursor is seen to drift - so measure again once
   *  the local font is ready and realign the cursor and grid if needed. */
  remeasureWhenFontLoads() {
    if (!document.fonts?.ready) return;
    document.fonts.ready.then(() => {
      const w = this.cellW;
      const h = this.cellH;
      this.measure();
      if (Math.abs(w - this.cellW) < 0.01 && Math.abs(h - this.cellH) < 0.01) return;
      this.moveCursor(this.cx, this.cy, this.cursorVisible);
      this.fit();
    });
  }

  bind() {
    this.host.tabIndex = 0;
    this.host.addEventListener("keydown", (e) => {
      if (this.exited) return;
      // Leave copy/paste to the browser, and let the app keep its own chords.
      if (e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "V")) return;
      // Ctrl+` belongs to DevHQ, for toggling the panel from inside a terminal.
      if (e.ctrlKey && e.key === "`") return;
      const seq = keySequence(e);
      if (seq === null) return;
      e.preventDefault();
      e.stopPropagation();
      this.send(seq);
    });
    this.host.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData("text");
      if (text) this.send(text.replace(/\r?\n/g, "\r"));
    });
    this.host.addEventListener("mousedown", () => this.host.focus());
    this.scroll.addEventListener("scroll", () => {
      const slack = this.scroll.scrollHeight - this.scroll.clientHeight - this.scroll.scrollTop;
      this.stickToBottom = slack < 4;
    });
  }

  send(text) {
    this.stickToBottom = true;
    term_invoke("term_write", { id: this.id, data: text }).catch(() => {});
  }

  /** Pulls the current screen and starts following updates. */
  async attach() {
    await wireEvents();
    views.set(this.id, this);
    const snap = await term_invoke("term_attach", { id: this.id });
    this.cols = snap.cols;
    this.rows = snap.rows;
    this.exited = !snap.info.alive;
    this.history.innerHTML = snap.history.map((runs) => `<div>${rowHtml(runs)}</div>`).join("");
    this.buildScreen();
    for (const row of snap.screen) this.paintRow(row.y, row.runs);
    this.moveCursor(snap.cx, snap.cy, snap.cursorVisible);
    this.toBottom();
    return snap.info;
  }

  /** Restored output belongs above the new shell's screen. It is deliberately
   *  plain text: colours and cursor state belonged to the process that exited,
   *  while the readable command/output history remains useful. */
  prependRestoredHistory(text) {
    if (!text) return;
    const html = text.split("\n").map((line) => `<div>${termEsc(line)}</div>`).join("");
    this.history.insertAdjacentHTML("afterbegin", html);
    this.toBottom();
  }

  /** A bounded text snapshot for persistence between application runs. */
  exportHistory() {
    const lines = [
      ...[...this.history.children].map((row) => row.textContent || ""),
      ...this.rowEls.map((row) => row.textContent || ""),
    ];
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.slice(-1500).join("\n").slice(-150000);
  }

  buildScreen() {
    this.screen.innerHTML = Array.from({ length: this.rows }, () => "<div></div>").join("");
    this.rowEls = [...this.screen.children];
  }

  paintRow(y, runs) {
    const el = this.rowEls[y];
    if (el) el.innerHTML = rowHtml(runs);
  }

  apply(payload) {
    if (payload.scrolled.length) {
      // Lines that fell off the top of the screen become history.
      const frag = document.createDocumentFragment();
      for (const runs of payload.scrolled) {
        const div = document.createElement("div");
        div.innerHTML = rowHtml(runs);
        frag.appendChild(div);
      }
      this.history.appendChild(frag);
      // Keep the DOM bounded; the session still holds the full scrollback.
      const excess = this.history.childElementCount - 3000;
      for (let i = 0; i < excess; i++) this.history.firstElementChild.remove();
    }
    for (const row of payload.rows) this.paintRow(row.y, row.runs);
    this.moveCursor(payload.cx, payload.cy, payload.cursorVisible);
    if (this.onFirstOutput) {
      const fire = this.onFirstOutput;
      this.onFirstOutput = null;
      fire();
    }
    // A full-screen program owns the viewport, so history is hidden while it runs.
    this.host.classList.toggle("alt", payload.alt);
    if (payload.title && this.onTitle) this.onTitle(payload.title);
    if (this.stickToBottom) this.toBottom();
  }

  /** Puts the cursor where the text really is.
   *
   *  A cell width is a fraction of a pixel, and the browser lays out a line by
   *  accumulating those fractions - so column 40 is never exactly 40 cells from
   *  the left, and a cursor placed by multiplication sits a whole character out
   *  by the end of a prompt. Asking the row itself where its characters are is
   *  the only measurement that cannot drift. */
  moveCursor(cx, cy, visible) {
    this.cx = cx;
    this.cy = cy;
    this.cursorVisible = visible;
    this.cursorEl.style.display = visible && !this.exited ? "block" : "none";
    const row = this.rowEls[cy];
    this.cursorEl.style.width = `${this.cellW}px`;
    this.cursorEl.style.height = `${row?.offsetHeight || this.cellH}px`;
    const x = this.columnX(cx, row);
    const y = row ? row.offsetTop : this.screen.offsetTop + cy * this.cellH;
    this.cursorEl.style.transform = `translate(${x}px, ${y}px)`;
  }

  /** The left edge of column `cx` on `row`, in the coordinates the cursor is
   *  positioned in. Rows are packed without their trailing blanks, so the
   *  cursor usually sits past the end of the text - that last stretch is the
   *  only part stepped over in whole cells, and it is short. */
  columnX(cx, row) {
    const fallback = this.screen.offsetLeft + cx * this.cellW;
    if (!row || !row.firstChild) return fallback;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let seen = 0;
    let last = null;
    let node;
    while ((node = walker.nextNode())) {
      if (seen + node.data.length >= cx) return this.textX(node, cx - seen, fallback);
      seen += node.data.length;
      last = node;
    }
    if (!last) return fallback;
    return this.textX(last, last.data.length, fallback) + (cx - seen) * this.cellW;
  }

  /** Viewport x of one character boundary, brought back into the scroller's
   *  own coordinates - the box the cursor is absolutely positioned in. */
  textX(node, offset, fallback) {
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset);
    const rect = range.getBoundingClientRect();
    // A collapsed range in a node that is not laid out reports nothing at all.
    if (!rect.left && !rect.top) return fallback;
    return rect.left - this.scroll.getBoundingClientRect().left;
  }

  toBottom() {
    this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  /** Recomputes the grid size from the element and tells the session. */
  fit() {
    const box = this.host.getBoundingClientRect();
    if (box.width < 20 || box.height < 20) return;
    const cols = Math.max(20, Math.floor((box.width - 16) / this.cellW));
    const rows = Math.max(5, Math.floor((box.height - 12) / this.cellH));
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.buildScreen();
    term_invoke("term_resize", { id: this.id, cols, rows })
      .then(() => this.attachRepaint())
      .catch(() => {});
  }

  /** After a resize the session repaints; pull the new screen immediately so
   *  the grid is never briefly blank. */
  async attachRepaint() {
    try {
      const snap = await term_invoke("term_attach", { id: this.id });
      for (const row of snap.screen) this.paintRow(row.y, row.runs);
      this.moveCursor(snap.cx, snap.cy, snap.cursorVisible);
      if (this.stickToBottom) this.toBottom();
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
    if (views.get(this.id) === this) views.delete(this.id);
  }
}

window.TermView = TermView;
