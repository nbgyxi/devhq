// Input Stall Watch: the page over the backend's stall watcher.
//
// The watch itself runs in Rust (`stall_watch.rs`) and keeps going whether
// this page is open or not, so everything here is a view of what
// `stall_watch_status` reports: refreshed once a second while mounted, and
// told about every newly diagnosed stall through `stall-watch:stall`.
//
// Regions are drawn separately - the live strip every second, the list only
// when its stalls change, the detail only when the selection does - so a
// click is never lost to a redraw.

(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name) => window.wintShell?.icon?.(name) || `<span class="ms" aria-hidden="true">${name}</span>`;

  const CAUSES = {
    driver: { word: "Driver", glyph: "memory", tone: "bad" },
    cpu: { word: "CPU", glyph: "speed", tone: "warn" },
    memory: { word: "Memory", glyph: "storage", tone: "warn" },
    input: { word: "Mouse path", glyph: "mouse", tone: "warn" },
    unexplained: { word: "Unexplained", glyph: "help", tone: "bad" },
    none: { word: "Nothing seen", glyph: "check", tone: "muted" },
  };
  const KINDS = { system: "Whole system", pointer: "Pointer only", manual: "Marked by you" };

  const st = {
    status: null,
    selected: 0,
    listKey: "",
    detailKey: "",
    events: new Map(),
    busy: "",
    error: "",
  };
  let root = null;
  let timer = 0;
  let listening = false;

  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const day = (ms) => {
    const d = new Date(ms);
    const today = new Date();
    return d.toDateString() === today.toDateString() ? "Today" : d.toLocaleDateString([], { day: "numeric", month: "short" });
  };
  const span = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${String(m).padStart(2, "0")}m` : m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
  };

  async function refresh() {
    try {
      st.status = await invoke("stall_watch_status");
      st.error = "";
    } catch (error) {
      st.error = String(error);
    }
    draw();
  }

  async function act(key, label, call) {
    if (st.busy) return;
    st.busy = key;
    window.wintWork?.beginWork(`stall-watch-${key}`, label);
    draw();
    try {
      const result = await call();
      if (result && typeof result === "object" && "watching" in result) st.status = result;
      st.error = "";
    } catch (error) {
      st.error = String(error);
    } finally {
      st.busy = "";
      window.wintWork?.endWork(`stall-watch-${key}`);
      draw();
    }
  }

  function setWatch(watching, thresholdMs) {
    const threshold = thresholdMs ?? st.status?.thresholdMs ?? 100;
    return act("set", watching ? "Starting the stall watch" : "Updating the stall watch", () => invoke("stall_watch_set", { watching, thresholdMs: threshold }));
  }

  async function loadEvents(stall) {
    st.events.set(stall.id, { loading: true, rows: [] });
    st.detailKey = "";
    draw();
    window.wintWork?.beginWork("stall-watch-events", "Reading the System event log around the stall");
    try {
      const rows = await invoke("stall_watch_events", { at: stall.at });
      st.events.set(stall.id, { rows });
    } catch (error) {
      st.events.set(stall.id, { error: String(error), rows: [] });
    } finally {
      window.wintWork?.endWork("stall-watch-events");
      st.detailKey = "";
      draw();
    }
  }

  /* ------------------------------------------------------------ drawing */

  function draw() {
    if (!root?.isConnected) return stop();
    const s = st.status;
    const hero = root.querySelector("[data-sw-hero]");
    const strip = root.querySelector("[data-sw-strip]");
    const list = root.querySelector("[data-sw-list]");
    const detail = root.querySelector("[data-sw-detail]");
    const notice = root.querySelector("[data-sw-notice]");
    if (!s) {
      hero.innerHTML = `<div class="sw-skeleton">Reading the stall watch…</div>`;
      return;
    }
    root.querySelector(".awake-hero").classList.toggle("is-awake", s.watching);
    drawHero(hero, s);
    drawStrip(strip, s);
    drawSensitivity(s);

    const listKey = `${s.stalls.length}:${s.stalls[0]?.id || 0}:${st.selected}:${s.pending}`;
    if (listKey !== st.listKey) {
      st.listKey = listKey;
      list.innerHTML = s.stalls.length
        ? s.stalls.map(row).join("")
        : `<div class="awake-empty">${s.watching ? "Nothing caught yet. Keep working — every stall lands here, with what the machine was doing." : "Start watching, then use the PC as usual. Stalls are caught while this tool is closed too."}</div>`;
      root.querySelector("[data-sw-count]").textContent = `${s.stalls.length} caught${s.pending ? ` · ${s.pending} being diagnosed` : ""}`;
    }
    const stall = s.stalls.find((x) => x.id === st.selected) || s.stalls[0];
    const ev = stall ? st.events.get(stall.id) : null;
    const detailKey = `${stall?.id || 0}:${ev ? (ev.loading ? "l" : ev.rows.length + (ev.error || "")) : "-"}`;
    if (detailKey !== st.detailKey) {
      st.detailKey = detailKey;
      detail.innerHTML = stall ? detailHtml(stall, ev) : `<div class="awake-empty">Select a stall to see what the machine was doing.</div>`;
    }
    notice.textContent = st.error;
    notice.hidden = !st.error;
  }

  function drawHero(hero, s) {
    const worst = s.stalls.reduce((m, x) => x.kind === "manual" ? m : Math.max(m, x.durationMs), 0);
    const key = `${s.watching}:${st.busy}`;
    if (hero.dataset.key !== key) {
      hero.dataset.key = key;
      hero.innerHTML = `<div class="awake-orbit">${icon(s.watching ? "monitoring" : "mouse")}</div>
        <div class="awake-hero-copy"><small>${s.watching ? "WATCHING" : "OFF"}</small>
          <h2>${s.watching ? "Watching for freezes" : "Not watching"}</h2>
          <p>${s.watching
            ? "A high-priority probe checks every 4 ms whether the machine or the pointer stopped. Around each stall it keeps a note of driver time, CPU, memory and paging. The watch belongs to WinT, not to this page: leave the tool and it keeps going, and it starts again with WinT until you stop it."
            : "Start watching, and WinT catches every moment the system or the pointer freezes. For each one it notes what the machine was doing at the time, and it keeps watching with this tool closed."}</p>
          <div class="awake-clock"><strong data-sw-elapsed></strong><span data-sw-stats></span></div></div>
        <div class="sw-hero-actions">
          <button class="btn awake-main ${s.watching ? "release" : "primary"}" data-sw-toggle ${st.busy ? "disabled" : ""}>${icon(s.watching ? "stop" : "play_arrow")}${s.watching ? "Stop watching" : "Start watching"}</button>
          <button class="btn" data-sw-mark ${s.watching && !st.busy ? "" : "disabled"} title="Diagnose the last 15 seconds">${icon("touch_app")}It just happened</button>
        </div>`;
    }
    hero.querySelector("[data-sw-elapsed]").textContent = s.watching && s.startedAt ? span(Date.now() - s.startedAt) : "--";
    const live = s.live;
    hero.querySelector("[data-sw-stats]").textContent = [
      `${s.stalls.filter((x) => x.kind !== "manual").length} stalls caught`,
      worst ? `longest ${worst} ms` : "",
      s.watching && live ? `now: ${live.busy.toFixed(0)}% busy · ${(live.dpc + live.interrupt).toFixed(1)}% driver time · ${live.memoryLoad}% memory` : "",
    ].filter(Boolean).join(" · ");
  }

  function drawStrip(strip, s) {
    const values = s.latency || [];
    const threshold = s.thresholdMs || 100;
    const scale = Math.max(threshold * 1.5, ...values);
    const bars = Array.from({ length: 60 }, (_, i) => values[i - (60 - values.length)]);
    strip.querySelector("[data-sw-bars]").innerHTML = bars.map((v) => v == null
      ? `<i class="empty"></i>`
      : `<i class="${v >= threshold ? "over" : v >= threshold / 2 ? "near" : ""}" style="height:${Math.max(3, Math.round((v / scale) * 100))}%" title="${v} ms late"></i>`).join("");
    strip.querySelector("[data-sw-line]").style.bottom = `${(threshold / scale) * 100}%`;
    const last = values[values.length - 1];
    strip.querySelector("[data-sw-strip-note]").textContent = s.watching
      ? `This second: ${last ?? 0} ms late · worst since start: ${s.worstMs} ms · the line is ${threshold} ms`
      : "Wake-up lateness per second appears here while watching.";
  }

  function drawSensitivity(s) {
    for (const button of root.querySelectorAll("[data-sw-threshold]")) {
      button.classList.toggle("on", Number(button.dataset.swThreshold) === s.thresholdMs);
    }
  }

  function row(stall) {
    const cause = CAUSES[stall.cause] || CAUSES.none;
    const on = stall.id === (st.selected || st.status.stalls[0]?.id);
    return `<button class="sw-row ${on ? "on" : ""}" data-sw-select="${stall.id}">
      <time><strong>${esc(time(stall.at))}</strong><small>${esc(day(stall.at))}</small></time>
      <span class="sw-ms">${stall.kind === "manual" ? icon("touch_app") : `${stall.durationMs}<small>ms</small>`}</span>
      <span class="sw-row-text"><strong>${esc(stall.verdict || "Diagnosing…")}</strong><small>${esc(KINDS[stall.kind] || stall.kind)}</small></span>
      <span class="sw-cause ${cause.tone}">${icon(cause.glyph)}${cause.word}</span></button>`;
  }

  function detailHtml(stall, ev) {
    const cause = CAUSES[stall.cause] || CAUSES.none;
    const samples = (stall.context || []).map((c) => {
      const inside = c.at >= stall.at && c.at - 1000 <= stall.at + stall.durationMs + 1000;
      const top = (c.top || []).slice(0, 3).map((p) => `${esc(p.name)} ${p.cpu.toFixed(0)}%${p.hardFaults ? ` · ${p.hardFaults} pf` : ""}`).join("<br>");
      return `<tr class="${inside ? "inside" : ""}"><td>${esc(time(c.at))}</td><td>${c.busy.toFixed(0)}%</td><td class="${c.worstCoreDriver >= 20 ? "hot" : ""}">CPU ${c.worstCore} · ${c.worstCoreDriver.toFixed(0)}%</td><td>${(c.dpc + c.interrupt).toFixed(1)}%</td><td class="${c.hardFaults >= 800 ? "hot" : ""}">${c.hardFaults}</td><td>${c.memoryLoad}%</td><td>${top || "—"}</td></tr>`;
    }).join("");
    let events = `<button class="btn" data-sw-events="${stall.id}">${icon("receipt_long")}Check the System log around this</button>`;
    if (ev?.loading) events = `<div class="sw-skeleton">Reading System log warnings and errors, two minutes either side…</div>`;
    else if (ev?.error) events = `<div class="win-status" data-tone="bad">${esc(ev.error)}</div>`;
    else if (ev) events = ev.rows.length
      ? ev.rows.map((e) => `<div class="awake-log-row"><time>${esc(time(Date.parse(e.time)))}</time><span class="awake-log-dot ${e.level === "Warning" ? "warn" : "bad"}"></span><div><strong>${esc(e.provider)} · ${e.id}</strong><small>${esc((e.message || "").split(/\r?\n/)[0])}</small></div></div>`).join("")
      : `<div class="awake-empty">No warnings or errors in the System log within two minutes.</div>`;
    return `<div class="sw-verdict ${cause.tone}">${icon(cause.glyph)}<div><small>${esc(KINDS[stall.kind] || stall.kind)} · ${esc(day(stall.at))} ${esc(time(stall.at))}${stall.kind === "manual" ? "" : ` · ${stall.durationMs} ms`}</small><h3>${esc(stall.verdict)}</h3><p>${esc(stall.detail)}</p></div></div>
      ${stall.evidence?.length ? `<ul class="sw-evidence">${stall.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
      <div class="sw-context"><table><thead><tr><th>Second</th><th>Busy</th><th>Worst core driver</th><th>Driver all</th><th>Hard faults</th><th>Memory</th><th>Top processes</th></tr></thead><tbody>${samples || `<tr><td colspan="7">No samples recorded around this stall.</td></tr>`}</tbody></table></div>
      <div class="sw-events">${events}</div>`;
  }

  /* ------------------------------------------------------------- events */

  function click(event) {
    const target = event.target.closest("button");
    if (!target || target.disabled) return;
    if (target.matches("[data-sw-toggle]")) return setWatch(!st.status?.watching);
    if (target.matches("[data-sw-mark]")) return act("mark", "Marking a stall to diagnose", () => invoke("stall_watch_mark"));
    if (target.matches("[data-sw-threshold]")) return setWatch(!!st.status?.watching, Number(target.dataset.swThreshold));
    if (target.matches("[data-sw-clear]")) {
      return Promise.resolve(window.wintConfirm ? window.wintConfirm({ title: "Clear every caught stall?", message: "The list and its diagnoses are removed. Watching carries on.", confirmLabel: "Clear", icon: "delete_sweep" }) : true)
        .then((yes) => { if (yes === true) { st.selected = 0; return act("clear", "Clearing caught stalls", () => invoke("stall_watch_clear")); } });
    }
    if (target.matches("[data-sw-select]")) {
      st.selected = Number(target.dataset.swSelect);
      return draw();
    }
    if (target.matches("[data-sw-events]")) {
      const stall = st.status?.stalls.find((x) => x.id === Number(target.dataset.swEvents));
      if (stall) loadEvents(stall);
    }
  }

  function stop() {
    clearInterval(timer);
    timer = 0;
  }

  function mount(node) {
    root = node;
    st.listKey = "";
    st.detailKey = "";
    node.innerHTML = `<div class="awake-page sw-page">
      <section class="awake-hero" data-sw-hero></section>
      <div class="win-status" data-tone="bad" data-sw-notice hidden></div>
      <div class="awake-grid">
        <section class="awake-panel sw-strip" data-sw-strip><header>${icon("monitoring")}<strong>Scheduler lateness</strong><small>last 60 s</small></header>
          <div class="sw-bars"><div data-sw-bars></div><span class="sw-line" data-sw-line></span></div><p data-sw-strip-note></p></section>
        <section class="awake-panel"><header>${icon("tune")}<strong>Sensitivity</strong><small>what counts as a stall</small></header>
          <div class="awake-segments">${[[50, "50 ms"], [100, "100 ms"], [200, "200 ms"], [500, "500 ms"]].map(([ms, label]) => `<button data-sw-threshold="${ms}">${label}</button>`).join("")}</div>
          <p class="sw-note">100 ms is the point at which a pointer visibly hitches. Go lower to catch micro-stutter, higher if normal load keeps tripping it. Changing it keeps the watch running.</p></section>
      </div>
      <div class="sw-work">
        <section class="awake-panel sw-list"><header>${icon("history")}<strong>Caught stalls</strong><small data-sw-count></small><button class="sw-clear" data-sw-clear title="Clear the list">${icon("delete_sweep")}</button></header><div data-sw-list></div></section>
        <section class="awake-panel sw-detail"><header>${icon("troubleshoot")}<strong>Diagnosis</strong></header><div data-sw-detail></div></section>
      </div></div>`;
    node.addEventListener("click", click);
    if (!listening) {
      listening = true;
      try {
        window.__TAURI__.event.listen("stall-watch:stall", () => { if (root?.isConnected) refresh(); });
      } catch { /* no event bridge here; the one-second refresh still picks it up */ }
    }
    stop();
    draw();
    refresh();
    timer = setInterval(() => { if (!root?.isConnected) return stop(); if (!st.busy) refresh(); }, 1000);
  }

  window.wintStallWatch = { mount };
})();
