// App health: what WinT itself was doing when it stopped answering.
//
// The backend records three things while the app runs (see `health.rs`): every
// piece of off-thread work with where it was asked for, the moment the window
// stopped repainting and what was in flight at the time, and any panic. This
// page is the window onto that file — the recent lines, what is running right
// now, and the way to the log itself.
//
// It is deliberately dull. A diagnostic page that refreshes hard is one more
// thing to suspect, so it reads once a second and nothing else.

(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name) => window.wintShell?.icon?.(name) || `<span class="ms" aria-hidden="true">${name}</span>`;
  const REFRESH_MS = 1000;

  const st = { report: null, filter: "all", drawn: "" };
  let root = null;
  let body = null;
  let timer = 0;

  // Troubleshooting files. The panel is built once and only its text changes,
  // so the once-a-second redraw of the log below never replaces the button
  // while it is being pressed.
  const pack = { busy: false, phase: "", result: "", tone: "" };
  let packNode = null;
  let unlistenPhase = null;
  const engine = () => {
    const found = /Edg\/([\d.]+)/.exec(navigator.userAgent) || /Chrome\/([\d.]+)/.exec(navigator.userAgent);
    return found ? `WebView2 ${found[1]}` : "";
  };

  function packMarkup() {
    return `
      <div class="health-now health-pack">
        <strong>Troubleshooting files</strong>
        <small>One zip to send to the developer when WinT crashes, freezes or misbehaves: WinT's health log, the crash reports and events Windows recorded for it, and a short description of this PC. User names, the PC's name, email addresses and anything that looks like a password are taken out first.</small>
        <div class="health-pack-row">
          <button class="btn" data-health-pack>${icon("folder_zip")}<span data-health-pack-label>Collect troubleshooting files</span></button>
          <span class="health-pack-status" data-health-pack-status role="status"></span>
        </div>
      </div>`;
  }

  function paintPack() {
    if (!packNode?.isConnected) return;
    const button = packNode.querySelector("[data-health-pack]");
    const label = packNode.querySelector("[data-health-pack-label]");
    const status = packNode.querySelector("[data-health-pack-status]");
    button.disabled = pack.busy;
    label.textContent = pack.busy ? "Collecting…" : "Collect troubleshooting files";
    status.textContent = pack.busy ? pack.phase : pack.result;
    status.dataset.tone = pack.busy ? "" : pack.tone;
  }

  async function collect() {
    if (pack.busy) return;
    pack.busy = true;
    pack.phase = "Starting";
    paintPack();
    window.wintWork?.beginWork("health:pack", "Collecting troubleshooting files");
    try {
      unlistenPhase ??= await window.__TAURI__.event.listen("troubleshoot:phase", (event) => {
        if (!pack.busy) return;
        pack.phase = String(event.payload || "");
        window.wintWork?.updateWork("health:pack", pack.phase);
        paintPack();
      });
      const saved = await invoke("troubleshoot_collect", { webview: engine() });
      if (saved) {
        pack.result = `Saved as ${saved}. Explorer has it selected, ready to attach.`;
        pack.tone = "ok";
      } else {
        pack.result = "Not saved: Save As was closed.";
        pack.tone = "";
      }
    } catch (error) {
      pack.result = `Could not collect them: ${error}`;
      pack.tone = "bad";
    } finally {
      pack.busy = false;
      window.wintWork?.endWork("health:pack");
      paintPack();
    }
  }

  // Lines are `HH:MM:SS.mmmZ kind text`. The kinds worth colouring are the
  // ones that mean something went wrong.
  const KINDS = {
    STUCK: { tone: "bad", what: "the window stopped repainting" },
    PANIC: { tone: "bad", what: "a panic" },
    slow: { tone: "warn", what: "work that took its time" },
    recovered: { tone: "ok", what: "the window came back" },
    recovery: { tone: "warn", what: "WinT reloading or restarting itself" },
    start: { tone: "", what: "a session started" },
    ui: { tone: "", what: "a note from the window" },
  };
  const kindOf = (line) => line.split(/\s+/)[1] || "";

  function summary(lines) {
    const counts = { STUCK: 0, PANIC: 0, slow: 0 };
    for (const line of lines) {
      const kind = kindOf(line);
      if (kind in counts) counts[kind] += 1;
    }
    const bits = [];
    if (counts.PANIC) bits.push(`${counts.PANIC} panic${counts.PANIC === 1 ? "" : "s"}`);
    if (counts.STUCK) bits.push(`${counts.STUCK} freeze${counts.STUCK === 1 ? "" : "s"}`);
    if (counts.slow) bits.push(`${counts.slow} slow call${counts.slow === 1 ? "" : "s"}`);
    return bits.length ? bits.join(" · ") : "nothing has gone wrong in what is recorded here";
  }

  function draw() {
    if (!body?.isConnected) return;
    const report = st.report;
    if (!report) {
      body.innerHTML = '<div class="win-empty">Reading the health log…</div>';
      return;
    }
    const lines = report.lines.filter((line) => st.filter === "all" || kindOf(line) === st.filter);
    const key = JSON.stringify([st.filter, report.inFlight, report.uptime, report.lines.length, lines.at(-1) || ""]);
    if (key === st.drawn) return;
    st.drawn = key;

    const minutes = Math.floor(report.uptime / 60);
    const rows = lines.length
      ? lines.slice().reverse().map((line) => {
          const kind = kindOf(line);
          const tone = KINDS[kind]?.tone || "";
          return `<div class="health-line${tone ? ` ${tone}` : ""}">${esc(line)}</div>`;
        }).join("")
      : `<div class="win-empty">Nothing of that kind has been recorded.</div>`;

    body.innerHTML = `
      <div class="win-status" data-tone="${report.lines.some((l) => ["PANIC", "STUCK"].includes(kindOf(l))) ? "warn" : "ok"}">
        ${esc(summary(report.lines))} · this session has been running ${minutes < 1 ? "less than a minute" : `${minutes} minute${minutes === 1 ? "" : "s"}`}
      </div>
      <div class="health-now">
        <strong>Running right now</strong>
        <code>${esc(report.inFlight)}</code>
        <small>Every command that touches the disk, the registry or another process goes through one place in the backend, and is counted here while it runs. When the window stops repainting, this is the list the cause is in.</small>
      </div>
      <div class="win-controls">
        <label><span>Show</span>
          <select data-health-filter>
            ${["all", ...Object.keys(KINDS)].map((kind) =>
              `<option value="${kind}"${kind === st.filter ? " selected" : ""}>${kind === "all" ? "Everything" : `${kind} — ${KINDS[kind].what}`}</option>`).join("")}
          </select>
        </label>
        <button class="btn" data-health-reveal>${icon("folder_open")}Show the log file</button>
      </div>
      <div class="health-log">${rows}</div>
      <p class="startup-note">The log lives at <code>${esc(report.path)}</code>. It is written as things happen, kept to half a megabyte and rotated once, so a crash survives whatever the app does next. It holds times, command locations and program paths — never anything you typed or any file's contents.</p>`;
  }

  async function load() {
    try {
      st.report = await invoke("health_report");
      draw();
    } catch (error) {
      if (body?.isConnected) body.innerHTML = `<div class="win-empty">${esc(String(error))}</div>`;
    }
  }

  function click(event) {
    if (event.target.closest("[data-health-reveal]")) {
      invoke("health_reveal").catch(() => {});
    }
    if (event.target.closest("[data-health-pack]")) collect();
  }

  function change(event) {
    const filter = event.target.closest("[data-health-filter]");
    if (filter) {
      st.filter = filter.value;
      st.drawn = "";
      draw();
    }
  }

  function mount(node) {
    root = node;
    root.onclick = click;
    root.onchange = change;
    root.innerHTML = `${packMarkup()}<div data-health-body></div>`;
    packNode = root.querySelector(".health-pack");
    body = root.querySelector("[data-health-body]");
    st.drawn = "";
    paintPack();
    draw();
    load();
    clearInterval(timer);
    timer = setInterval(() => {
      if (root?.isConnected && !document.hidden) load();
      else if (!root?.isConnected) { clearInterval(timer); timer = 0; }
    }, REFRESH_MS);
  }

  window.wintAppHealth = { mount };
})();
