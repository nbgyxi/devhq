// Front-end faults, written to the durable health log.
//
// Every tool is a webview of its own, and a webview's console belongs to
// nobody: an exception thrown in the torrent window on the dev machine is
// invisible unless devtools happened to be open on that particular view at
// that particular moment. So the errors are sent to the Rust side instead,
// where `health.log` already survives the tool, the window and the app.
//
// This is loaded first in every entry point, before any other script, so a
// syntax or start-up error in one of them is itself reported.
(() => {
  "use strict";
  if (window.wintErrorLog) return;

  // Repeats are the normal case, not the exception: one bad selector inside a
  // render throws again on every snapshot, three times a second. Reporting
  // each one would push everything else out of a 512 KB log within seconds,
  // so the same fault is sent once, then counted.
  const WINDOW_MS = 10000;
  const MAX_TEXT = 1200;
  const seen = new Map();
  let queue = [];

  const where = () => {
    const page = (location.pathname.split("/").pop() || "index.html").replace(/\.html$/, "");
    const name = new URLSearchParams(location.search).get("name");
    return name ? `${page}:${name}` : page;
  };

  // The engine and its version, for the environment line on a report. The
  // user agent carries far more than that, so only the build number is taken
  // from it and the rest is left behind.
  const engine = () => {
    const found = /Edg\/([\d.]+)/.exec(navigator.userAgent) || /Chrome\/([\d.]+)/.exec(navigator.userAgent);
    return found ? `WebView2 ${found[1]}` : "";
  };

  const send = (fault) => {
    const invoke = window.__TAURI__?.core?.invoke;
    // Before the Tauri bridge exists there is nowhere to send it. Hold it:
    // the earliest errors are the start-up ones, and they are the ones most
    // worth keeping.
    if (!invoke) {
      if (queue.length < 50) queue.push(fault);
      return;
    }
    if (queue.length) {
      const held = queue;
      queue = [];
      for (const earlier of held) invoke("ui_error", { fault: earlier }).catch(() => {});
    }
    invoke("ui_error", { fault }).catch(() => {});
  };

  const report = (kind, detail, source) => {
    const at = Date.now();
    const key = `${kind}|${detail}`.slice(0, 200);
    const previous = seen.get(key);
    if (previous && at - previous.at < WINDOW_MS) {
      previous.suppressed += 1;
      return;
    }
    const repeat = previous?.suppressed ? ` (+${previous.suppressed} more since)` : "";
    seen.set(key, { at, suppressed: 0 });
    let text = `${where()}  ${kind}: ${detail}${repeat}`;
    if (source) text += `\n    at ${source}`;
    // `kind`, `detail` and the page travel alongside the line rather than
    // being parsed back out of it in Rust: they are the same fields a feedback
    // report needs, and the backend decides whether this fault earns one.
    send({
      text: text.slice(0, MAX_TEXT),
      kind,
      detail: String(detail).slice(0, 300),
      page: where(),
      environment: engine(),
    });
  };

  const describe = (value) => {
    if (value instanceof Error) {
      // The stack already carries the message and the frames; the bare
      // message alone is rarely enough to find the line.
      return (value.stack || `${value.name}: ${value.message}`).replace(/\s+/g, " ").trim();
    }
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };

  // A page whose own scripts did not arrive draws nothing at all — not even
  // the title bar, which is ours too — and leaves a black, immovable window.
  // That happened on waking from sleep, when the dev server was not answering
  // yet. Once the page has finished trying, a missing entry script — the last
  // one on every page, which starts it — means the page is dead: say so on
  // screen and load it again, backing off while it keeps failing. Any other
  // missing script is only reported, because covering a page that did start
  // would be worse than the feature that is missing from it. The attempt count
  // lives in sessionStorage because it only has to survive the reload it causes.
  const RELOAD_KEY = "wint.missing-script-reloads";
  const missing = [];
  const attempts = () => {
    try { return Number(sessionStorage.getItem(RELOAD_KEY)) || 0; } catch { return 0; }
  };
  const setAttempts = (count) => {
    try {
      if (count) sessionStorage.setItem(RELOAD_KEY, String(count));
      else sessionStorage.removeItem(RELOAD_KEY);
    } catch {}
  };

  const recover = () => {
    const entry = [...document.querySelectorAll("script[src]")].pop()?.src;
    if (!entry || !missing.includes(entry)) {
      setAttempts(0);
      return;
    }
    const attempt = attempts() + 1;
    setAttempts(attempt);
    const seconds = Math.min(2 ** attempt, 30);
    const t = (text, values) => window.wintI18n?.t?.(text, values) ?? text.replace(/\{(\w+)\}/g, (_, name) => values?.[name] ?? "");
    window.wintErrorLog.note(`${missing.length} script(s) failed to load; reloading in ${seconds}s (attempt ${attempt})`);

    // Inline styles only: styles.css may be among what did not arrive.
    const screen = document.createElement("div");
    screen.setAttribute("data-tauri-drag-region", "");
    screen.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:16px;background:#f3f3f3;color:#1b1b1b;font:14px 'Segoe UI',system-ui,sans-serif;text-align:center";
    const heading = document.createElement("div");
    heading.style.cssText = "font-size:16px;font-weight:600";
    heading.textContent = t("This window could not load");
    const detail = document.createElement("div");
    const button = document.createElement("button");
    button.style.cssText = "padding:6px 16px;font:inherit;cursor:pointer";
    button.textContent = t("Retry now");
    button.addEventListener("click", () => location.reload());
    screen.append(heading, detail, button);
    document.body.append(screen);

    let left = seconds;
    const tick = () => {
      if (left <= 0) return location.reload();
      detail.textContent = t("{count} of its files did not arrive. Trying again in {seconds}s.", { count: missing.length, seconds: left });
      left -= 1;
      setTimeout(tick, 1000);
    };
    tick();
  };
  window.addEventListener("load", recover);

  window.addEventListener("error", (event) => {
    // A failed <script>/<img>/<link> fires the same event with no `error`.
    if (event.target && event.target !== window && event.target.tagName) {
      if (event.target.tagName === "SCRIPT" && event.target.src?.startsWith(location.origin)) {
        missing.push(event.target.src);
      }
      return report("resource", `${event.target.tagName.toLowerCase()} failed to load: ${event.target.src || event.target.href || "?"}`);
    }
    const place = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : "";
    report("error", event.error ? describe(event.error) : String(event.message), place);
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    report("unhandled rejection", describe(event.reason));
  });

  // Explicit reporting, for code that catches its own errors and would
  // otherwise swallow them — `recoverView` in the torrent window being the
  // case this was written for.
  window.wintErrorLog = {
    report(context, error) { report(context, describe(error)); },
    // A note is a step, not a fault: it goes to the log and never to the
    // feedback broker, which is what the `note` kind tells the backend.
    note(text) {
      send({ text: `${where()}  ${String(text).slice(0, MAX_TEXT)}`, kind: "note", page: where(), environment: engine() });
    },
  };
})();
