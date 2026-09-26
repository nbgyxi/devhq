// Speed Test: what the line can do, and what it is doing right now.
//
// Two readings, which are not the same thing and are far too often confused:
//
//  * **The live meter** is the adapter's own byte counters, read twice a
//    second. It is what *this PC* is moving at this moment — every program at
//    once, including whatever is downloading in the background while the test
//    runs. It costs nothing and touches no network.
//  * **The test** fills the line on purpose, against Cloudflare's speed
//    endpoint, and reports what it managed. It is the only thing here that
//    sends a byte anywhere, and it only ever runs on a press.
//
// The number worth more than either is the third one: how much the round trip
// grows while the line is full. A connection that measures 500 Mb/s and adds
// 400ms of lag under load is a connection every call on it will stutter over,
// and that is exactly what the torrent tool's pacing exists to prevent.

(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;
  const icon = (name) => window.wintShell?.icon?.(name) || `<span class="ms" aria-hidden="true">${name}</span>`;

  /** How often the live meter samples. The rate it reports is the average over
   *  the gap between two calls, so this interval *is* the averaging window:
   *  faster and every packet burst becomes a spike, slower and the needle
   *  lags behind what is happening. */
  const METER_MS = 500;
  /** How many samples the sparkline keeps — a little over half a minute, which
   *  is long enough to see a download start and short enough to stay legible
   *  at this width. */
  const HISTORY = 70;
  /** How often the per-app panel is read. */
  const APPS_MS = 1000;
  /** Rows quieter than this are left out: every idle browser tab holds a socket
   *  open, and a list of forty processes moving nothing answers nothing. */
  const APP_FLOOR = 2048;
  /** How long each app's rate is averaged over. Traffic at the one-second scale
   *  is all bursts and gaps, and a number that jumps between 4 MB/s and nothing
   *  cannot be read; five seconds is steady enough to read and short enough to
   *  still be about now. */
  const WINDOW_MS = 5000;
  /** How long a program stays on the list after its last burst. Without this a
   *  row disappears on the first idle second and comes back on the next, which
   *  is the opposite of calm. */
  const LINGER_MS = 8000;
  /** How many rows the panel shows at once. */
  const APPS_SHOWN = 8;
  /** Where the last result is kept. Through the backend rather than
   *  `localStorage`, because a measurement nobody can reproduce on demand is
   *  exactly the kind of state that must not be lost to a webview flush that
   *  never happened. */
  const KEY = "speedtest-last";
  /** Where the chosen order is kept, so the panel opens the way it was left. */
  const SORT_KEY = "speedtest-app-sort";

  const st = {
    host: null,
    timer: 0,
    unlisten: [],
    /** The newest live reading, and the history behind it. */
    live: { downBps: 0, upBps: 0 },
    downHistory: [],
    upHistory: [],
    /** The last finished test, whenever it ran — including a previous session. */
    result: null,
    /** Set while a test is running: the phase, in words, and how far along. */
    running: null,
    error: "",
    /** The apps panel: the last report, and the row per pid it is drawn into. */
    apps: null,
    appsTimer: 0,
    appRows: new Map(),
    /** Per program: the last few seconds of samples, the newest grouped reading
     *  and when it was last busy. This is what makes the list calm. */
    appSeen: new Map(),
    /** What the last press of "Measure exactly" had to say. */
    measureNote: "",
    /** Which way the app list is ordered: `total`, `down` or `up`. Down and up
     *  are not the same question — a PC whose upload is saturated is a PC
     *  somebody is seeding or syncing from, and that culprit is often nowhere
     *  near the top of the busiest list. */
    sort: "total",
  };

  function bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return `${Math.round(n)} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let i = -1;
    do { n /= 1024; i += 1; } while (n >= 1024 && i < units.length - 1);
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
  }

  /** Bytes per second as megabits, which is the unit every line is sold in and
   *  the only one a result can be compared against a contract with. */
  function megabits(bps) {
    const mb = (Number(bps) || 0) * 8 / 1000000;
    return mb >= 100 ? Math.round(mb) : mb.toFixed(mb >= 10 ? 1 : 2);
  }

  function speed(bps) {
    return Number(bps) > 0 ? `${bytes(bps)}/s` : "—";
  }

  function mount(node) {
    st.host = node;
    node.innerHTML = `
      <div class="spd">
        <section class="spd-test">
          <div class="spd-dials">
            <div class="spd-dial" data-spd-dial="down">
              <span class="spd-dial-head">${icon("download")}Download</span>
              <strong data-spd-down>—</strong><small>Mb/s</small>
            </div>
            <div class="spd-dial" data-spd-dial="up">
              <span class="spd-dial-head">${icon("upload")}Upload</span>
              <strong data-spd-up>—</strong><small>Mb/s</small>
            </div>
            <div class="spd-dial" data-spd-dial="ping">
              <span class="spd-dial-head">${icon("timer")}Round trip</span>
              <strong data-spd-ping>—</strong><small data-spd-pingnote>ms, idle</small>
            </div>
          </div>
          <div class="spd-bar"><i data-spd-progress style="width:0"></i></div>
          <div class="spd-actions">
            <button type="button" class="btn primary" data-spd-run>${icon("network_check")}<span data-spd-runlabel>Run the test</span></button>
            <span class="spd-note" data-spd-note>The test contacts Cloudflare's speed endpoint, and only when you press it.</span>
          </div>
          <div class="spd-verdict" data-spd-verdict hidden></div>
        </section>

        <section class="spd-live">
          <header>${icon("monitor_heart")}<strong>This PC, right now</strong>
            <small>Every program at once, from the adapter's own counters</small></header>
          <div class="spd-livegrid">
            <div><span>Down</span><strong data-spd-livedown>—</strong></div>
            <div><span>Up</span><strong data-spd-liveup>—</strong></div>
          </div>
          <svg class="spd-spark" viewBox="0 0 280 60" preserveAspectRatio="none" aria-hidden="true">
            <path data-spd-sparkdown fill="none" stroke="currentColor" stroke-width="1.5" />
            <path data-spd-sparkup fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
          <p class="spd-hint">A reading here that stays high while nothing is obviously running is worth
            following up in <strong>Startup and tray</strong> or <strong>PC Detective</strong>.</p>
        </section>

        <section class="spd-apps">
          <header>${icon("apps")}<strong>Which apps are using it</strong>
            <div class="seg" data-spd-sort>
              <button type="button" data-sort="total">Busiest</button>
              <button type="button" data-sort="down">${icon("download")}Download</button>
              <button type="button" data-sort="up">${icon("upload")}Upload</button>
            </div>
            <small data-spd-appsnote>Every process holding a connection off this PC</small></header>
          <div class="spd-applist" data-spd-applist>
            <p class="spd-hint" data-spd-appsempty>Reading the socket table…</p>
          </div>
          <div class="spd-appsfoot">
            <button type="button" class="btn" data-spd-measure>${icon("admin_panel_settings")}<span data-spd-measurelabel>Measure exactly…</span></button>
            <span class="spd-note" data-spd-measurenote>Windows only counts bytes per process for an administrator. Without that, each app's
              figures are its share of the adapter total, worked out from how much it read and wrote.</span>
          </div>
        </section>
      </div>`;

    node.addEventListener("click", (event) => {
      if (event.target.closest("[data-spd-run]")) run();
      if (event.target.closest("[data-spd-measure]")) measure();
      const sort = event.target.closest("[data-spd-sort] button");
      if (sort) setSort(sort.dataset.sort);
    });

    loadLast();
    startMeter();
  }

  /** Stops the meter and drops the listeners. Called when the tool is left, so
   *  a page nobody is looking at is not sampling anything. */
  function unmount() {
    clearInterval(st.timer);
    clearInterval(st.appsTimer);
    st.timer = 0;
    st.appsTimer = 0;
    st.appRows.clear();
    st.appSeen.clear();
    for (const off of st.unlisten.splice(0)) { try { off(); } catch { /* already gone */ } }
    invoke("net_throughput_reset").catch(() => {});
    invoke("net_app_usage_reset").catch(() => {});
    // The elevated helper is told to stop as the tool is left: it exists for
    // this panel, and nothing should be sampling the TCP stack for a window
    // nobody has open.
    invoke("net_app_usage_measure_stop").catch(() => {});
  }

  function startMeter() {
    clearInterval(st.timer);
    // The first reading is thrown away by the backend anyway — it has nothing
    // to subtract from — so the interval starts clean here.
    invoke("net_throughput_reset").catch(() => {});
    st.timer = setInterval(() => {
      if (!st.host?.isConnected) return unmount();
      invoke("net_throughput").then((live) => {
        if (!live?.known) return;
        st.live = live;
        push(st.downHistory, live.downBps);
        push(st.upHistory, live.upBps);
        drawLive();
      }).catch(() => {});
    }, METER_MS);
    startApps();
  }

  /** The per-app panel samples a second at a time. It is slower than the meter
   *  on purpose: the reading opens a handle per connected process, and a list
   *  that reorders itself twice a second cannot be read. */
  function startApps() {
    clearInterval(st.appsTimer);
    invoke("net_app_usage_reset").catch(() => {});
    const tick = () => {
      if (!st.host?.isConnected) return;
      invoke("net_app_usage").then((report) => {
        if (!report) return;
        st.apps = report;
        accumulate(grouped(report.apps));
        drawApps();
      }).catch(() => {});
    };
    st.appsTimer = setInterval(tick, APPS_MS);
    tick();
  }

  /** Asks for the measured numbers. One `runas` prompt, one small elevated
   *  helper; the estimate stays on screen either way. */
  function measure() {
    st.measureNote = "Asking Windows for administrator rights…";
    drawApps();
    window.wintWork?.beginWork("netusage", "Asking for administrator rights");
    invoke("net_app_usage_measure")
      .then((message) => { st.measureNote = String(message || ""); })
      .catch((error) => { st.measureNote = String(error); })
      .finally(() => {
        window.wintWork?.endWork("netusage");
        drawApps();
      });
  }

  function push(list, value) {
    list.push(Number(value) || 0);
    if (list.length > HISTORY) list.shift();
  }

  function loadLast() {
    invoke("ui_state_get", { key: KEY }).then((saved) => {
      if (saved && !st.result && !st.running) { st.result = saved; drawResult(); }
    }).catch(() => {});
    invoke("ui_state_get", { key: SORT_KEY }).then((saved) => {
      if (saved === "down" || saved === "up" || saved === "total") {
        st.sort = saved;
        drawApps();
      }
    }).catch(() => {});
  }

  function run() {
    if (st.running) return;
    st.running = { label: "Starting", fraction: 0, bps: 0 };
    st.error = "";
    drawResult();
    window.wintWork?.beginWork("speedtest", "Measuring the connection");
    const events = window.__TAURI__.event;
    events?.listen("speedtest:progress", (event) => {
      st.running = event.payload;
      drawProgress();
    }).then((off) => st.unlisten.push(off)).catch(() => {});

    invoke("net_speed_test", { upload: true })
      .then((result) => {
        st.result = result;
        invoke("ui_state_set", { key: KEY, value: result }).catch(() => {});
      })
      .catch((error) => { st.error = String(error); })
      .finally(() => {
        st.running = null;
        window.wintWork?.endWork("speedtest");
        drawResult();
        drawProgress();
      });
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  /** The dials while a test runs: the phase's own rate, climbing, rather than
   *  a spinner and a number that appears at the end. */
  function drawProgress() {
    const host = st.host;
    if (!host?.isConnected) return;
    const running = st.running;
    const bar = host.querySelector("[data-spd-progress]");
    if (bar) bar.style.width = running ? `${Math.round((running.fraction || 0) * 100)}%` : "0";
    const button = host.querySelector("[data-spd-run]");
    if (button) {
      button.disabled = !!running;
      // The icon is a span of its own, and it is the first one in the button.
      setText(button.querySelector("[data-spd-runlabel]"), running ? "Measuring…" : "Run the test");
    }
    setText(host.querySelector("[data-spd-note]"), running
      ? `${running.label}…`
      : st.error || "The test contacts Cloudflare's speed endpoint, and only when you press it.");
    if (!running) return;
    if (running.phase === "download") setText(host.querySelector("[data-spd-down]"), megabits(running.bps));
    if (running.phase === "upload") setText(host.querySelector("[data-spd-up]"), megabits(running.bps));
  }

  function drawResult() {
    const host = st.host;
    if (!host?.isConnected) return;
    const result = st.result;
    setText(host.querySelector("[data-spd-down]"), result ? megabits(result.downBps) : "—");
    setText(host.querySelector("[data-spd-up]"), result ? megabits(result.upBps) : "—");
    setText(host.querySelector("[data-spd-ping]"), result?.latencyMs != null ? String(result.latencyMs) : "—");

    const verdict = host.querySelector("[data-spd-verdict]");
    if (!verdict) return;
    verdict.hidden = !result;
    if (!result) return;
    const idle = result.latencyMs;
    const loaded = result.loadedLatencyMs;
    // The gap between the two is the whole point. A line that keeps its round
    // trip under load can carry a call and a download at once; one that does
    // not is where pacing earns its keep.
    const grew = idle != null && loaded != null ? loaded - idle : null;
    setText(host.querySelector("[data-spd-pingnote]"),
      loaded != null ? `ms idle · ${loaded} ms loaded` : "ms, idle");
    const when = result.measuredAtMs
      ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
        .format(new Date(result.measuredAtMs))
      : "";
    const bufferbloat = grew == null
      ? "The loaded round trip could not be measured."
      : grew > 200
        ? `The round trip grew by ${grew} ms while the line was full. Anything live — a call, a game, a shell — will stutter whenever something downloads. Turning on "Give way to other apps" in Torrents is what this number is arguing for.`
        : grew > 60
          ? `The round trip grew by ${grew} ms under load. Noticeable on a call, but not ruinous.`
          : `The round trip held steady under load (${grew} ms worse). This line shares well.`;
    verdict.innerHTML = `<strong>${speed(result.downBps)} down · ${speed(result.upBps)} up</strong>
      <span>${bufferbloat}</span>
      ${when ? `<small>Measured ${when}</small>` : ""}`;
  }

  /** One row per program, not per process. A browser is thirty processes and an
   *  Electron app is five; the question is which *app* is using the line, so
   *  the processes sharing an executable are added together. The count of them
   *  is kept, because "chrome.exe × 31" is itself worth seeing. */
  function grouped(apps) {
    const byName = new Map();
    for (const app of apps) {
      const row = byName.get(app.name) || {
        name: app.name, downBps: 0, upBps: 0, connections: 0, processes: 0,
        measured: false, udpOnly: true, peers: [],
      };
      row.downBps += app.downBps;
      row.upBps += app.upBps;
      row.connections += app.connections;
      row.processes += 1;
      row.measured = row.measured || app.measured;
      row.udpOnly = row.udpOnly && app.udpOnly;
      for (const peer of app.peers) {
        if (row.peers.length < 3 && !row.peers.includes(peer)) row.peers.push(peer);
      }
      byName.set(app.name, row);
    }
    return byName;
  }

  /** What is actually drawn: the last few seconds of each program, averaged.
   *
   *  Traffic is bursty at the one-second scale — a browser that is steadily
   *  pulling a video still reads zero on the tick between two chunks — so the
   *  raw numbers jump and rows drop out and come back. Averaging over a rolling
   *  window steadies the figures, and a program is kept in the list for a few
   *  seconds after it last did something, so a quiet second cannot make a row
   *  vanish and reappear. */
  /** Whichever direction is being ranked decides the order *and* which rows are
   *  listed, so "Upload" is a list of what is uploading rather than the busiest
   *  apps with their upload printed beside them. */
  function weigh(down, up) {
    if (st.sort === "down") return down;
    if (st.sort === "up") return up;
    return down + up;
  }

  /** Takes one reading into the window. Called once per poll and nowhere else —
   *  a redraw must never add a sample, or a click would weight the average. */
  function accumulate(byName) {
    const now = Date.now();
    for (const [name, app] of byName) {
      const seen = st.appSeen.get(name) || { samples: [] };
      seen.samples.push({ at: now, downBps: app.downBps, upBps: app.upBps });
      seen.last = app;
      st.appSeen.set(name, seen);
    }
    for (const [name, seen] of st.appSeen) {
      // A program absent from this reading is sampled as a zero: an average
      // that skips the idle seconds is not an average.
      if (!byName.has(name)) seen.samples.push({ at: now, downBps: 0, upBps: 0 });
      seen.samples = seen.samples.filter((sample) => now - sample.at < WINDOW_MS);
      // Busy is judged on the busiest second in the window rather than on the
      // average: a program that moved a megabyte four seconds ago belongs on
      // the list, even though the average has thinned it out since.
      const peak = seen.samples.reduce((most, s) => Math.max(most, weigh(s.downBps, s.upBps)), 0);
      if (peak >= APP_FLOOR) seen.busyAt = now;
      // Once nothing is left in the window and the linger is past, the program
      // is forgotten entirely.
      if (!seen.samples.length || (!byName.has(name) && peak === 0
        && (!seen.busyAt || now - seen.busyAt > LINGER_MS))) {
        st.appSeen.delete(name);
      }
    }
  }

  /** What the panel draws: each program's rate averaged over the window, in the
   *  chosen order. A program stays listed for a few seconds after its last
   *  burst, so a quiet second cannot make a row vanish and reappear. */
  function ranked() {
    const now = Date.now();
    const rows = [];
    for (const [name, seen] of st.appSeen) {
      if (!seen.samples.length || !seen.busyAt || now - seen.busyAt > LINGER_MS) continue;
      const count = seen.samples.length;
      const downBps = seen.samples.reduce((sum, s) => sum + s.downBps, 0) / count;
      const upBps = seen.samples.reduce((sum, s) => sum + s.upBps, 0) / count;
      const peak = seen.samples.reduce((most, s) => Math.max(most, weigh(s.downBps, s.upBps)), 0);
      rows.push({ ...seen.last, name, downBps, upBps, rank: weigh(downBps, upBps), peak });
    }
    return rows.sort((a, b) => b.rank - a.rank || b.peak - a.peak || a.name.localeCompare(b.name));
  }

  /** Changes the order, and remembers it. Through the backend, because the
   *  webview's own storage is not something a saved choice may depend on. */
  function setSort(sort) {
    if (!sort || sort === st.sort) return;
    st.sort = sort;
    // The rows are ranked on a different number now, so the ones that survive
    // the floor change too: the list is rebuilt rather than reordered.
    for (const [, row] of st.appRows) row.remove();
    st.appRows.clear();
    drawApps();
    invoke("ui_state_set", { key: SORT_KEY, value: sort }).catch(() => {});
  }

  /** The apps panel. Rows are kept per program and updated in place: one that
   *  is still there keeps its row, so only the numbers move. */
  function drawApps() {
    const host = st.host;
    if (!host?.isConnected) return;
    const list = host.querySelector("[data-spd-applist]");
    if (!list) return;
    const report = st.apps || { apps: [] };
    const busy = ranked().slice(0, APPS_SHOWN);

    // The direction the list is ranked on is the one drawn brightest, so the
    // column the order is about is obvious without reading the buttons.
    list.dataset.rank = st.sort;
    for (const button of host.querySelectorAll("[data-spd-sort] button")) {
      button.classList.toggle("on", button.dataset.sort === st.sort);
    }

    const placeholder = list.querySelector("[data-spd-appsempty]");
    if (placeholder) {
      const moving = st.sort === "down" ? "is downloading" : st.sort === "up" ? "is uploading" : "is moving";
      const idle = report.known
        ? `Nothing ${moving} more than ${bytes(APP_FLOOR)}/s. ${report.apps.length} process${report.apps.length === 1 ? "" : "es"} hold a connection open.`
          + ` Anything that moves something stays listed for ${LINGER_MS / 1000}s after it stops.`
        : "Reading the socket table…";
      placeholder.hidden = busy.length > 0;
      setText(placeholder, idle);
    }

    // Rows whose process has gone, or gone quiet, leave.
    const wanted = new Set(busy.map((app) => app.name));
    for (const [name, row] of st.appRows) {
      if (!wanted.has(name)) { row.remove(); st.appRows.delete(name); }
    }
    let after = placeholder;
    for (const app of busy) {
      let row = st.appRows.get(app.name);
      if (!row) {
        row = document.createElement("div");
        row.className = "spd-app";
        row.innerHTML = `<span class="spd-app-name"><strong></strong><em></em></span>
          <span class="spd-app-rate" data-dir="down">${icon("download")}<b data-down></b></span>
          <span class="spd-app-rate" data-dir="up">${icon("upload")}<b data-up></b></span>
          <span class="spd-app-tag" data-tag></span>`;
        st.appRows.set(app.name, row);
        list.appendChild(row);
      }
      // Kept in order without rebuilding: a node is only moved when the row
      // above it is not the one that should be.
      if (after ? after.nextElementSibling !== row : list.firstElementChild !== row) {
        list.insertBefore(row, after ? after.nextElementSibling : list.firstElementChild);
      }
      after = row;
      setText(row.querySelector(".spd-app-name strong"), app.name);
      const shape = `${app.connections} conn${app.processes > 1 ? ` · ${app.processes} processes` : ""}`;
      setText(row.querySelector(".spd-app-name em"),
        app.peers.length ? `${shape} · ${app.peers.join("  ")}` : shape);
      setText(row.querySelector("[data-down]"), speed(app.downBps));
      setText(row.querySelector("[data-up]"), speed(app.upBps));
      const tag = app.measured ? "measured" : app.udpOnly ? "UDP · estimate" : "estimate";
      setText(row.querySelector("[data-tag]"), tag);
      row.querySelector("[data-tag]").dataset.kind = app.measured ? "measured" : "estimate";
    }

    setText(host.querySelector("[data-spd-appsnote]"), report.measured
      ? `Measured per connection by the TCP stack · ${WINDOW_MS / 1000}s average`
      : `Estimated share of the adapter total · ${WINDOW_MS / 1000}s average`);
    const button = host.querySelector("[data-spd-measure]");
    const exact = report.elevated || report.helperRunning;
    // Once the numbers are actually arriving, the line about asking for them
    // has been overtaken by events.
    if (report.helperRunning && st.measureNote) st.measureNote = "";
    if (button) button.disabled = exact;
    setText(host.querySelector("[data-spd-measurelabel]"), exact ? "Measuring exactly" : "Measure exactly…");
    setText(host.querySelector("[data-spd-measurenote]"), st.measureNote || (report.elevated
      ? "WinT is an administrator, so these are the stack's own per-connection counters."
      : report.helperRunning
        ? "An elevated helper is counting TCP bytes per connection. UDP and QUIC are still estimated."
        : "Windows only counts bytes per process for an administrator. Without that, each app's figures are its share of the adapter total, worked out from how much it read and wrote."));
  }

  function drawLive() {
    const host = st.host;
    if (!host?.isConnected) return;
    setText(host.querySelector("[data-spd-livedown]"), speed(st.live.downBps));
    setText(host.querySelector("[data-spd-liveup]"), speed(st.live.upBps));
    spark(host.querySelector("[data-spd-sparkdown]"), st.downHistory);
    spark(host.querySelector("[data-spd-sparkup]"), st.upHistory);
  }

  /** Both traces share one scale, so the two are comparable at a glance —
   *  scaling each to its own peak would draw a trickle of upload exactly like
   *  a saturated download. */
  function spark(path, values) {
    if (!path || !values.length) return;
    const peak = Math.max(...st.downHistory, ...st.upHistory, 1);
    const step = 280 / Math.max(HISTORY - 1, 1);
    const points = values.map((value, index) => `${(index * step).toFixed(1)},${(58 - (value / peak) * 56).toFixed(1)}`);
    path.setAttribute("d", `M${points.join("L")}`);
  }

  window.wintSpeedTest = { mount, unmount };
})();
