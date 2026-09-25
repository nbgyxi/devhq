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
  /** Where the last result is kept. Through the backend rather than
   *  `localStorage`, because a measurement nobody can reproduce on demand is
   *  exactly the kind of state that must not be lost to a webview flush that
   *  never happened. */
  const KEY = "speedtest-last";

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
      </div>`;

    node.addEventListener("click", (event) => {
      if (event.target.closest("[data-spd-run]")) run();
    });

    loadLast();
    startMeter();
  }

  /** Stops the meter and drops the listeners. Called when the tool is left, so
   *  a page nobody is looking at is not sampling anything. */
  function unmount() {
    clearInterval(st.timer);
    st.timer = 0;
    for (const off of st.unlisten.splice(0)) { try { off(); } catch { /* already gone */ } }
    invoke("net_throughput_reset").catch(() => {});
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
  }

  function push(list, value) {
    list.push(Number(value) || 0);
    if (list.length > HISTORY) list.shift();
  }

  function loadLast() {
    invoke("ui_state_get", { key: KEY }).then((saved) => {
      if (saved && !st.result && !st.running) { st.result = saved; drawResult(); }
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
