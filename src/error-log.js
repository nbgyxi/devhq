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

  const send = (text) => {
    const invoke = window.__TAURI__?.core?.invoke;
    // Before the Tauri bridge exists there is nowhere to send it. Hold it:
    // the earliest errors are the start-up ones, and they are the ones most
    // worth keeping.
    if (!invoke) {
      if (queue.length < 50) queue.push(text);
      return;
    }
    if (queue.length) {
      const held = queue;
      queue = [];
      for (const line of held) invoke("ui_error", { text: line }).catch(() => {});
    }
    invoke("ui_error", { text }).catch(() => {});
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
    send(text.slice(0, MAX_TEXT));
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

  window.addEventListener("error", (event) => {
    // A failed <script>/<img>/<link> fires the same event with no `error`.
    if (event.target && event.target !== window && event.target.tagName) {
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
    note(text) { send(`${where()}  ${String(text).slice(0, MAX_TEXT)}`); },
  };
})();
