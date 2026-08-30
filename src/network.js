// The network watcher: what is actually crossing the wire, as it happens.
//
// Windows already has the capture engine — `pktmon`, in the box, no driver to
// install — so this tool drives it rather than asking anyone to go and fetch
// Wireshark first. Frames arrive from Rust as `net:frames` batches and are
// held in a ring here; the page never rebuilds a region it did not change, and
// the filter field is mounted once at `mount()` so the caret survives every
// frame that lands underneath it.
//
// Nothing here waits on anything. Starting a capture, listing components and
// writing the pcapng all go to `async` commands that answer off the UI thread.
//
// Kept inside an IIFE on purpose: a classic script that declares listen/mount/
// wire/action at the top level overwrites the same names in app.js (and dns.js)
// and leaves the main window empty.

(() => {
const net_invoke = window.__TAURI__.core.invoke;
const net_listen = window.__TAURI__.event.listen;

/** How many frames the page keeps. The ring in Rust is larger; this is what
 *  the table can scroll through without the DOM becoming the bottleneck. */
const NET_RING = 4000;

/** Rows are appended on an animation frame, never one at a time. A busy link
 *  produces frames faster than the screen refreshes and the difference has to
 *  land somewhere other than the layout engine. */
const NET_TABS = ["ALL", "TCP", "UDP", "TLS", "HTTP", "DNS", "ICMP"];

/** The colour each protocol pill takes, by name. Anything unlisted falls back
 *  to the dim text colour rather than inventing a hue. */
const NET_TONE = {
  TCP: "accent",
  UDP: "teal",
  TLS: "green",
  HTTP: "amber",
  DNS: "purple",
  QUIC: "teal",
  ICMP: "red",
  ICMPv6: "red",
  ARP: "dim",
  mDNS: "dim",
};

/** Offered under the filter list. Ports a dev machine actually cares about,
 *  plus the two exclusions that make a noisy home network readable. */
const NET_SUGGESTED = [
  { kind: "port", value: "3000" },
  { kind: "port", value: "5173" },
  { kind: "port", value: "5432" },
  { kind: "port", value: "443" },
  { kind: "proto", value: "tcp" },
  { kind: "not", value: "mdns" },
  { kind: "not", value: "arp" },
];

const NET_PREFS_KEY = "devhq.network.v1";

function netLoadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(NET_PREFS_KEY) || "{}");
    return {
      filters: Array.isArray(saved.filters) ? saved.filters : [],
      pktSize: Number(saved.pktSize) > 0 ? Number(saved.pktSize) : 128,
      comps: Array.isArray(saved.comps) ? saved.comps : null,
    };
  } catch (_) {
    return { filters: [], pktSize: 128, comps: null };
  }
}

function netSavePrefs() {
  try {
    localStorage.setItem(
      NET_PREFS_KEY,
      JSON.stringify({ filters: net.filters, pktSize: net.pktSize, comps: [...net.offComps] })
    );
  } catch (_) {
    /* A machine that refuses local storage still gets a working tool. */
  }
}

const netPrefs = netLoadPrefs();

const net = {
  /** What pktmon will let us do here, asked once when the tool is opened. */
  cap: null,
  capAsked: false,

  /** Capture filters, `{ kind, value }`. `not` ones never reach pktmon — the
   *  driver can only say what to keep — so they are applied over the frames
   *  that arrive, and the tool says which is which. */
  filters: netPrefs.filters,
  filterText: "",
  /** What the last start actually pushed into the driver, and what it could
   *  not. Straight from Rust rather than guessed at from `filters`. */
  applied: [],
  displayOnly: [],

  /** Packet processing components, and the ids the user has switched off. */
  comps: [],
  compsLoaded: false,
  offComps: new Set(netPrefs.comps || []),

  pktSize: netPrefs.pktSize,

  capturing: false,
  starting: false,
  /** The pktmon command line the running session was started with. */
  command: "",

  /** The frames on screen, oldest first. */
  frames: [],
  /** Frame id of the selected row, or 0. */
  selected: 0,
  /** Which protocol tab the table is narrowed to. */
  tab: "ALL",
  /** Whether the table sticks to the newest frame. Turned off the moment the
   *  user scrolls up: following a list somebody is reading is hostile. */
  follow: true,

  /** Which layers of the detail panel are open, by name. */
  openLayers: { "Ethernet II": false, IPv4: true, IPv6: true, TCP: true, UDP: true },

  /** The last `net:rate` sample, and the sixty before it for the sparkline. */
  rate: null,
  spark: [],
  lastSample: null,

  exported: null,
  exporting: false,

  message: "",
  messageTone: "",

  host: null,
  built: false,
  wired: false,
  /** Set while the frame list is being appended to, so the scroll handler can
   *  tell our own scrolling from the user's. */
  autoScrolling: false,
};

/* ------------------------------------------------------------- the shell */

function netIcon(name) {
  return window.devhqShell?.icon(name) ?? `<span class="ms" aria-hidden="true">${name}</span>`;
}

function netEsc(value) {
  return window.devhqShell?.esc(value) ?? String(value ?? "");
}

function netDirty() {
  window.devhqShell?.markDirty("network");
}

function netWork(key, label, detail) {
  window.devhqWork?.beginWork(key, label, detail);
}

function netDone(key) {
  window.devhqWork?.endWork(key);
}

/** The capture's line in the status bar, kept true while it runs. The rule is
 *  a count rather than a spinner wherever there is one to give. */
function netProgress(detail) {
  window.devhqWork?.updateWork("net-capture", detail);
}

/** Says something in the tool for a moment, next to the thing that caused it.
 *  Anything worth keeping goes to the status bar instead. */
function netSay(text, tone = "") {
  net.message = text;
  net.messageTone = tone;
  netDirty();
}

/** Bytes as a person reads them. */
function netBytes(n) {
  const value = Number(n) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function netRatePerSec(n) {
  return `${netBytes(n)}/s`;
}

/** A filter as it reads in the list and on the command line. */
function netFilterLabel(filter) {
  if (filter.kind === "not") return `!${filter.value}`;
  if (filter.kind === "proto") return filter.value;
  return `${filter.kind} ${filter.value}`;
}

/** Parses what somebody typed into the filter field. `port 3000`, `3000`,
 *  `ip 10.0.0.9`, `10.0.0.9`, `tcp` and `!mdns` all mean what they look like. */
function netParseFilter(raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (!text) return null;
  if (text.startsWith("!")) {
    const value = text.slice(1).trim();
    return value ? { kind: "not", value } : null;
  }
  const [head, ...rest] = text.split(/\s+/);
  const tail = rest.join(" ");
  if (head === "port" && tail) return { kind: "port", value: tail };
  if (head === "ip" && tail) return { kind: "ip", value: tail };
  if (/^\d+$/.test(text)) return { kind: "port", value: text };
  // An address, with or without a prefix length.
  if (/^[0-9.]+(\/\d+)?$/.test(text) || text.includes(":")) return { kind: "ip", value: text };
  return { kind: "proto", value: text };
}

/* ------------------------------------------------------------------ mount */

function mount(host) {
  if (!host || net.built) return;
  net.host = host;
  host.innerHTML = `
    <header class="tool-head">
      <button class="btn back tool-back" type="button" data-open-tool="overview"
              title="Back to the overview">${netIcon("arrow_back")}Back</button>
      <span class="tool-plate">${netIcon("network_check")}</span>
      <span class="tool-title">
        <strong>Network</strong>
        <small>live packet capture, nothing to install</small>
      </span>
      ${window.devhqMaturity?.badge("network") ?? ""}
      <button class="tool-popout" type="button" data-popout-tool="network"></button>
      <button class="tool-pin" id="tool-pin-network" type="button" data-pin-tool="network"></button>
      <button class="tool-close" type="button" data-open-tool="overview"
              title="Back to the overview">${netIcon("close")}</button>
    </header>

    <div class="net-bar">
      <label class="field net-field" for="net-filter">${netIcon("filter_alt")}
        <input id="net-filter" class="mono" spellcheck="false" autocomplete="off"
               placeholder="port 3000, ip 10.0.0.14, tcp, !mdns" />
        <kbd>Enter to add</kbd>
      </label>
      <button class="btn primary" type="button" data-net="capture" id="net-capture"></button>
      <button class="btn" type="button" data-net="clear"
              title="Drop every frame held so far">${netIcon("delete_sweep")}Clear</button>
      <button class="btn" type="button" data-net="export" id="net-export"></button>
    </div>

    <div class="net-body">
      <aside class="net-side">
        <div class="net-panel net-filters" id="net-filter-panel">
          <div class="net-panel-head">${netIcon("filter_alt")}<span class="net-label">Capture filters</span>
            <span class="mono net-count" id="net-filter-count"></span></div>
          <div class="net-panel-body" id="net-filter-list"></div>
          <div class="net-suggest" id="net-suggest"></div>
        </div>

        <div class="net-panel net-comps">
          <div class="net-panel-head">${netIcon("settings_ethernet")}<span class="net-label">Components</span>
            <button class="net-mini" type="button" data-net="comps-reload"
                    title="Ask pktmon again">${netIcon("refresh")}</button></div>
          <div class="net-panel-body" id="net-comp-list"></div>
          <div class="net-panel-foot">${netIcon("verified_user")}Kernel-level. No Npcap, no WinPcap, nothing to install.</div>
        </div>
      </aside>

      <section class="net-main">
        <div id="net-notice"></div>

        <div class="net-panel net-throughput">
          <div class="net-panel-head"><span class="net-label">Throughput</span>
            <span class="mono net-in" id="net-rate-in"></span>
            <span class="mono net-out" id="net-rate-out"></span>
            <i></i>
            <span class="mono net-drop" id="net-drop"></span></div>
          <div class="net-spark" id="net-spark"></div>
        </div>

        <div class="net-panel net-frames">
          <div class="net-panel-head"><span class="net-label">Frames</span>
            <div class="seg" id="net-tabs"></div>
            <i></i>
            <button class="net-follow" type="button" data-net="follow" id="net-follow"></button>
            <span class="mono net-note" id="net-frame-note"></span></div>
          <div class="net-cols">
            <span class="net-c-time">Time</span>
            <span class="net-c-dir"></span>
            <span class="net-c-proto">Proto</span>
            <span class="net-c-pair">Source &rarr; Destination</span>
            <span class="net-c-proc">Process</span>
            <span class="net-c-len">Bytes</span>
          </div>
          <div class="net-panel-body net-rows" id="net-rows"></div>
          <div class="net-panel-foot net-cmd">
            <span class="mono" id="net-command"></span>
            <i></i>
            <button class="net-mini wide" type="button" data-net="copy-cmd" id="net-copy">${netIcon(
              "content_copy"
            )}Copy</button>
          </div>
        </div>
      </section>

      <aside class="net-detail-side">
        <div class="net-panel net-detail" id="net-detail-panel">
          <div class="net-panel-head">${netIcon("data_object")}<span class="net-label">Frame detail</span>
            <span class="mono net-count" id="net-detail-id"></span></div>
          <div class="net-panel-body" id="net-detail"></div>
          <div class="net-detail-acts" id="net-detail-acts"></div>
        </div>

        <div class="net-panel net-session">
          <div class="net-panel-head">${netIcon("save")}<span class="net-label">Session</span><i></i>
            <span class="net-session-state" id="net-session-state"></span></div>
          <div class="net-session-body" id="net-session"></div>
        </div>

        <div class="net-panel net-talkers">
          <div class="net-panel-head">${netIcon("leaderboard")}<span class="net-label">Top talkers</span></div>
          <div class="net-panel-body" id="net-talkers"></div>
        </div>
      </aside>
    </div>

    <div class="net-message" id="net-message" hidden></div>
  `;

  net.built = true;
  wire();
  listen();
}

function field(id) {
  return net.host?.querySelector(`#${id}`) || null;
}

function wire() {
  const input = field("net-filter");
  input.oninput = () => {
    net.filterText = input.value;
  };
  input.onkeydown = (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addFilter(input.value);
    input.value = "";
    net.filterText = "";
  };

  const rows = field("net-rows");
  // Following is a state the user leaves by scrolling, not by pressing
  // anything. Scrolling back to the bottom picks it up again.
  rows.onscroll = () => {
    if (net.autoScrolling) return;
    const atEnd = rows.scrollHeight - rows.scrollTop - rows.clientHeight < 24;
    if (atEnd === net.follow) return;
    net.follow = atEnd;
    renderFollow();
  };

  net.host.onclick = (event) => {
    const pop = event.target.closest("[data-popout-tool]");
    if (pop) return window.devhqShell?.popOutTool?.(pop.dataset.popoutTool);
    const pin = event.target.closest("[data-pin-tool]");
    if (pin) return window.devhqShell?.toggleToolPin(pin.dataset.pinTool);
    const go = event.target.closest("[data-open-tool]");
    if (go) return window.devhqShell?.openTool(go.dataset.openTool);

    const act = event.target.closest("[data-net]");
    if (act) return action(act.dataset.net, act.dataset);

    const row = event.target.closest("[data-net-frame]");
    if (row) {
      net.selected = Number(row.dataset.netFrame);
      return netDirty();
    }
    const tab = event.target.closest("[data-net-tab]");
    if (tab) {
      net.tab = tab.dataset.netTab;
      return netDirty();
    }
  };
}

function action(name, data) {
  if (name === "capture") return net.capturing ? stopCapture() : startCapture();
  if (name === "clear") return clearFrames();
  if (name === "export") return exportPcap();
  if (name === "follow") return toggleFollow();
  if (name === "copy-cmd") return copyCommand();
  if (name === "comps-reload") return loadComponents(true);
  if (name === "comp-toggle") return toggleComponent(Number(data.comp));
  if (name === "filter-add") return addFilter(data.label);
  if (name === "filter-remove") return removeFilter(data.label);
  if (name === "filter-port") return addFilter(`port ${data.value}`);
  if (name === "filter-ip") return addFilter(`ip ${data.value}`);
  if (name === "layer") return toggleLayer(data.layer);
  if (name === "pkt-size") return setPacketSize(Number(data.size));
  if (name === "open-captures") return openCaptures();
  if (name === "elevate-help") return netSay(
    "Close DevHQ, right-click it and choose Run as administrator. pktmon talks to a kernel driver, and Windows will not open that to a normal process.",
    "warn"
  );
}

/* -------------------------------------------------------------- the events */

/** Frames arrive in batches and land in the ring. This is the only place the
 *  frame list grows, and it never touches the DOM itself — the render pass
 *  does that, once per animation frame, however many batches landed. */
function listen() {
  if (net.wired) return;
  net.wired = true;

  net_listen("net:frames", (event) => {
    const frames = event.payload?.frames || [];
    if (!frames.length) return;
    net.frames.push(...frames);
    if (net.frames.length > NET_RING) net.frames.splice(0, net.frames.length - NET_RING);
    // A capture running with nothing selected selects its first frame, so the
    // detail panel is never an empty box over a full table.
    if (!net.selected && net.frames.length) net.selected = net.frames[net.frames.length - 1].id;
    netDirty();
  });

  net_listen("net:rate", (event) => {
    const sample = event.payload;
    if (!sample) return;
    // The sparkline wants bytes per second, and the sample is a running total.
    const previous = net.lastSample;
    const delta = previous
      ? sample.bytesIn + sample.bytesOut - (previous.bytesIn + previous.bytesOut)
      : 0;
    net.spark.push(Math.max(0, delta));
    if (net.spark.length > 62) net.spark.shift();
    net.lastSample = sample;
    net.rate = sample;
    if (net.capturing) {
      netProgress(
        `${sample.frames.toLocaleString()} frames · ${netBytes(
          sample.bytesIn + sample.bytesOut
        )} · ${netRatePerSec(delta)}`
      );
    }
    netDirty();
  });

  net_listen("net:ended", (event) => {
    if (!net.capturing) return;
    net.capturing = false;
    netDone("net-capture");
    netSay(String(event.payload || "The capture stopped."), "warn");
  });
}

/* ------------------------------------------------------------- what it can do */

/** Opened from the dock, from search, or from a shortcut. */
function opened() {
  if (!net.capAsked) loadCapability();
  if (!net.compsLoaded) loadComponents();
  const input = field("net-filter");
  if (input) setTimeout(() => input.focus(), 0);
  netDirty();
}

async function loadCapability() {
  net.capAsked = true;
  netWork("net-cap", "Checking packet capture");
  try {
    net.cap = await net_invoke("net_capability");
    if (net.cap?.capturing) {
      // The tool has been reopened onto a session that never stopped. Take the
      // frames it has already collected rather than starting from blank.
      net.capturing = true;
      net.command = net.cap.command || "";
      net.frames = await net_invoke("net_backlog", { limit: NET_RING });
      net.rate = await net_invoke("net_rate");
      if (net.frames.length) net.selected = net.frames[net.frames.length - 1].id;
    }
  } catch (err) {
    net.cap = { available: false, elevated: false, capturing: false, note: String(err) };
  } finally {
    netDone("net-cap");
    netDirty();
  }
}

async function loadComponents(again = false) {
  if (net.compsLoaded && !again) return;
  netWork("net-comps", "Listing capture components");
  try {
    net.comps = await net_invoke("net_components");
    net.compsLoaded = true;
  } catch (err) {
    net.comps = [];
    // Not worth a message of its own when the whole tool is already saying
    // pktmon will not talk to us.
    if (net.cap?.available && net.cap?.elevated) netSay(String(err), "bad");
  } finally {
    netDone("net-comps");
    netDirty();
  }
}

function addFilter(raw) {
  const parsed = netParseFilter(raw);
  if (!parsed) return;
  const label = netFilterLabel(parsed);
  if (net.filters.some((f) => netFilterLabel(f) === label)) {
    netSay(`${label} is already in the list.`, "");
    return;
  }
  if (net.filters.length >= 32) {
    netSay("pktmon holds at most 32 filters at once.", "warn");
    return;
  }
  net.filters.push(parsed);
  netSavePrefs();
  netSay(
    net.capturing
      ? `${label} added — restart the capture for pktmon to apply it`
      : `${label} added`,
    ""
  );
  netDirty();
}

function removeFilter(label) {
  net.filters = net.filters.filter((f) => netFilterLabel(f) !== label);
  netSavePrefs();
  netSay(`${label} removed`, "");
  netDirty();
}

function toggleComponent(id) {
  if (net.offComps.has(id)) net.offComps.delete(id);
  else net.offComps.add(id);
  netSavePrefs();
  netDirty();
}

function setPacketSize(size) {
  if (!Number.isFinite(size) || size < 0) return;
  net.pktSize = size;
  netSavePrefs();
  netDirty();
}

function toggleFollow() {
  net.follow = !net.follow;
  if (net.follow) scrollToEnd();
  renderFollow();
}

function toggleLayer(name) {
  net.openLayers[name] = !net.openLayers[name];
  netDirty();
}

/* ----------------------------------------------------------- start and stop */

async function startCapture() {
  if (net.capturing || net.starting) return;
  net.starting = true;
  netWork("net-capture", "Starting packet capture", "pktmon");
  netDirty();
  try {
    const comps = net.comps.filter((c) => !net.offComps.has(c.id)).map((c) => c.id);
    const started = await net_invoke("net_start", {
      options: {
        filters: net.filters.filter((f) => f.kind !== "not"),
        // Every component switched on. An empty list means all of them, which
        // is also what we want when the list could not be read at all.
        comps: net.comps.length && comps.length < net.comps.length ? comps : [],
        pktSize: net.pktSize,
      },
    });
    net.capturing = true;
    net.command = started.command;
    net.applied = started.applied || [];
    net.displayOnly = started.displayOnly || [];
    net.spark = [];
    net.lastSample = null;
    net.exported = null;
    netSay(
      net.displayOnly.length
        ? `Capturing. ${net.displayOnly.join(", ")} cannot be a pktmon filter, so it is applied to what arrives.`
        : "Capturing.",
      "go"
    );
    netProgress("waiting for the first frame");
  } catch (err) {
    netSay(String(err), "bad");
    netDone("net-capture");
  } finally {
    net.starting = false;
    // The work entry stays open for the life of the capture: the status bar
    // must go on saying what the app is doing while it is doing it.
    if (!net.capturing) netDone("net-capture");
    netDirty();
  }
}

async function stopCapture() {
  if (!net.capturing) return;
  try {
    const held = await net_invoke("net_stop");
    netSay(`Capture stopped — ${held}, nothing lost.`, "");
  } catch (err) {
    netSay(String(err), "bad");
  } finally {
    net.capturing = false;
    netDone("net-capture");
    netDirty();
  }
}

async function clearFrames() {
  net.frames = [];
  net.selected = 0;
  net.spark = [];
  net.lastSample = null;
  net.exported = null;
  try {
    await net_invoke("net_clear");
  } catch (_) {
    /* Clearing what is on screen is the part that matters. */
  }
  net.rate = await net_invoke("net_rate").catch(() => null);
  netSay("Frames cleared.", "");
  netDirty();
}

async function exportPcap() {
  if (net.exporting) return;
  net.exporting = true;
  netWork("net-export", "Writing pcapng");
  netDirty();
  try {
    net.exported = await net_invoke("net_export", { path: "" });
    netSay(
      `${net.exported.frames} frames written to ${net.exported.path}. Wireshark opens it as it is.`,
      "go"
    );
  } catch (err) {
    net.exported = null;
    netSay(String(err), "bad");
  } finally {
    net.exporting = false;
    netDone("net-export");
    netDirty();
  }
}

/** Opens the captures folder. `open_in` takes a directory, not a file, so the
 *  file name is trimmed off rather than handed over to be rejected. */
function openCaptures() {
  const file = net.exported?.path;
  if (!file) return;
  const folder = file.replace(/[\/][^\/]*$/, "");
  net_invoke("open_in", { target: "explorer", path: folder }).catch((err) =>
    netSay(String(err), "bad")
  );
}

async function copyCommand() {
  if (!net.command) return;
  try {
    await navigator.clipboard.writeText(net.command);
    netSay("Command line copied.", "");
  } catch (_) {
    netSay("The clipboard refused the copy.", "bad");
  }
}

/* --------------------------------------------------------------- filtering */

/** The frames the table should show: the exclusions the driver could not
 *  apply, then the protocol tab. */
function visibleFrames() {
  const excluded = net.filters
    .filter((f) => f.kind === "not")
    .map((f) => f.value.toLowerCase());
  return net.frames.filter((frame) => {
    const proto = String(frame.proto || "").toLowerCase();
    const transport = String(frame.transport || "").toLowerCase();
    if (excluded.some((x) => x === proto || x === transport)) return false;
    if (net.tab === "ALL") return true;
    return frame.proto === net.tab || frame.transport === net.tab;
  });
}

function selectedFrame(list) {
  return list.find((frame) => frame.id === net.selected) || list[list.length - 1] || null;
}

/* ----------------------------------------------------------------- drawing */

function render() {
  if (!net.built) return;
  renderNotice();
  renderFilters();
  renderComponents();
  renderThroughput();
  renderTabs();
  renderFollow();
  const list = visibleFrames();
  renderRows(list);
  const frame = selectedFrame(list);
  renderDetail(frame);
  renderSession();
  renderTalkers(list);
  renderBar();

  const message = field("net-message");
  message.hidden = !net.message;
  message.className = `net-message ${net.messageTone}`;
  message.textContent = net.message;
}

/** The one thing standing between the user and a capture, said at the top
 *  rather than left for them to discover by pressing Start. */
function renderNotice() {
  const notice = field("net-notice");
  const cap = net.cap;
  if (!cap || (cap.available && cap.elevated)) {
    notice.innerHTML = "";
    return;
  }
  const canElevate = cap.available && !cap.elevated;
  notice.innerHTML = `<div class="net-notice ${canElevate ? "warn" : "bad"}">
    ${netIcon(canElevate ? "shield_person" : "block")}
    <span class="net-notice-text">${netEsc(cap.note)}</span>
    ${
      canElevate
        ? `<button class="btn" type="button" data-net="elevate-help">How?</button>`
        : ""
    }
  </div>`;
}

function renderFilters() {
  const list = field("net-filter-list");
  const count = field("net-filter-count");
  const suggest = field("net-suggest");
  const panel = field("net-filter-panel");

  count.textContent = `${net.filters.length}/32`;
  panel.classList.toggle("empty", net.filters.length === 0);

  list.innerHTML = net.filters.length
    ? net.filters
        .map((filter) => {
          const label = netFilterLabel(filter);
          const note =
            filter.kind === "not"
              ? "excluded here, not in the driver"
              : filter.kind === "port"
              ? "either direction"
              : filter.kind === "ip"
              ? "source or destination"
              : "transport";
          const icon =
            filter.kind === "not"
              ? "block"
              : filter.kind === "port"
              ? "call_split"
              : filter.kind === "ip"
              ? "my_location"
              : "layers";
          return `<div class="net-filter-row">
            ${netIcon(icon)}
            <span class="net-filter-main">
              <span class="mono net-filter-label">${netEsc(label)}</span>
              <small>${note}</small>
            </span>
            <button class="net-row-btn" type="button" data-net="filter-remove"
                    data-label="${netEsc(label)}" title="Remove this filter">${netIcon("close")}</button>
          </div>`;
        })
        .join("")
    : `<div class="net-empty">No filters — pktmon is counting every frame on every component.
        Add a port or an address to keep it readable.</div>`;

  const taken = new Set(net.filters.map(netFilterLabel));
  suggest.innerHTML = NET_SUGGESTED.filter((s) => !taken.has(netFilterLabel(s)))
    .map(
      (s) => `<button class="net-chip" type="button" data-net="filter-add"
        data-label="${netEsc(netFilterLabel(s))}">${netIcon("add")}${netEsc(netFilterLabel(s))}</button>`
    )
    .join("");
}

function renderComponents() {
  const list = field("net-comp-list");
  if (!net.compsLoaded) {
    list.innerHTML = `<div class="net-empty">${
      net.cap && !net.cap.elevated
        ? "pktmon will not list components without administrator rights."
        : "Reading the component list…"
    }</div>`;
    return;
  }
  if (!net.comps.length) {
    list.innerHTML = `<div class="net-empty">pktmon reported no components.</div>`;
    return;
  }
  const icons = { nic: "settings_ethernet", loopback: "sync_alt", vswitch: "hub", other: "cable" };
  list.innerHTML = net.comps
    .map((comp) => {
      const on = !net.offComps.has(comp.id);
      return `<button class="net-comp${on ? " on" : ""}" type="button"
        data-net="comp-toggle" data-comp="${comp.id}"
        title="${on ? "Leave this component out of the capture" : "Include this component"}">
        <span class="dot ${on ? "green" : "grey"}"></span>
        ${netIcon(icons[comp.kind] || "cable")}
        <span class="net-comp-main">
          <span class="net-comp-name">${netEsc(comp.name)}</span>
          <small class="mono">${netEsc(comp.detail || `component ${comp.id}`)}</small>
        </span>
      </button>`;
    })
    .join("");
}

function renderThroughput() {
  const rate = net.rate;
  const inEl = field("net-rate-in");
  const outEl = field("net-rate-out");
  const drop = field("net-drop");
  const spark = field("net-spark");

  // The last sample's delta is what a rate means; a running total is not one.
  const perSecond = net.spark.length ? net.spark[net.spark.length - 1] : 0;
  inEl.textContent = rate ? `↓ ${netBytes(rate.bytesIn)}` : "↓ —";
  outEl.textContent = rate ? `↑ ${netBytes(rate.bytesOut)}` : "↑ —";
  drop.textContent = net.capturing
    ? `${netRatePerSec(perSecond)} · ${
        net.pktSize ? `${net.pktSize}-byte truncation` : "whole packets"
      }${rate?.unparsed ? ` · ${rate.unparsed} not decoded` : ""}`
    : "paused";

  const peak = Math.max(1, ...net.spark);
  const bars = Array.from({ length: 62 }, (_, i) => {
    const at = i - (62 - net.spark.length);
    const value = at >= 0 ? net.spark[at] : 0;
    const height = Math.max(2, Math.round((value / peak) * 100));
    const live = net.capturing && at === net.spark.length - 1;
    return `<i style="height:${height}%"${live ? ' class="live"' : ""}></i>`;
  }).join("");
  spark.innerHTML = bars;
}

function renderTabs() {
  const tabs = field("net-tabs");
  const html = NET_TABS.map(
    (tab) =>
      `<button type="button" class="${net.tab === tab ? "on" : ""}" data-net-tab="${tab}">${tab}</button>`
  ).join("");
  // Rebuilt only when it changed: the tab strip is clicked, and replacing a
  // button under a press swallows the click.
  if (tabs.dataset.state !== net.tab) {
    tabs.innerHTML = html;
    tabs.dataset.state = net.tab;
  }
}

function renderFollow() {
  const follow = field("net-follow");
  if (!follow) return;
  follow.className = `net-follow${net.follow ? " on" : ""}`;
  follow.innerHTML = `${netIcon(net.follow ? "vertical_align_bottom" : "pause")}${
    net.follow ? "Following" : "Frozen"
  }`;
  follow.title = net.follow
    ? "Stop sticking to the newest frame"
    : "Stick to the newest frame again";
}

function renderRows(list) {
  const rows = field("net-rows");
  const note = field("net-frame-note");
  note.textContent = `${list.length} of ${net.frames.length} frames`;

  if (!list.length) {
    rows.innerHTML = `<div class="net-blank">${netIcon("filter_alt_off")}
      <strong>${net.capturing ? "Nothing matches yet" : "Nothing captured"}</strong>
      <span class="mono">${netEsc(
        net.frames.length
          ? `${net.filters.map(netFilterLabel).join(" · ") || "no filter"} · ${net.tab}`
          : net.capturing
          ? "Waiting for the first frame"
          : "Press Start capture"
      )}</span></div>`;
    rows.dataset.count = "0";
    return;
  }

  // Only ever the tail is drawn. A ring of four thousand rows is more DOM than
  // any window needs, and the table can only show a screenful of them.
  const visible = list.slice(-600);
  rows.innerHTML = visible
    .map((frame) => {
      const tone = NET_TONE[frame.proto] || "dim";
      const pair = `${netEsc(netEndpoint(frame.src, frame.srcPort))} → ${netEsc(
        netEndpoint(frame.dst, frame.dstPort)
      )}`;
      return `<button class="net-row${frame.id === net.selected ? " on" : ""}" type="button"
        data-net-frame="${frame.id}">
        <span class="mono net-c-time">${netEsc(frame.time)}</span>
        <span class="net-c-dir ${frame.dir}">${netIcon(
        frame.dir === "out" ? "north_east" : "south_west"
      )}</span>
        <span class="mono net-c-proto tone-${tone}">${netEsc(frame.proto)}</span>
        <span class="mono net-c-pair${frame.proto === "ICMP" ? " bad" : ""}">${pair}${
        frame.info ? `   <small>${netEsc(frame.info)}</small>` : ""
      }</span>
        <span class="net-c-proc">${
          frame.process
            ? `${netIcon("memory")}<span>${netEsc(frame.process)}</span>`
            : `<span class="dimmed">—</span>`
        }</span>
        <span class="mono net-c-len">${frame.len}</span>
      </button>`;
    })
    .join("");
  rows.dataset.count = String(list.length);
  if (net.follow) scrollToEnd();
}

function netEndpoint(address, port) {
  if (!address) return "—";
  return port ? `${address}:${port}` : address;
}

function scrollToEnd() {
  const rows = field("net-rows");
  if (!rows) return;
  net.autoScrolling = true;
  rows.scrollTop = rows.scrollHeight;
  // The scroll event lands after this frame, so the flag has to outlive it.
  requestAnimationFrame(() => {
    net.autoScrolling = false;
  });
}

function renderDetail(frame) {
  const body = field("net-detail");
  const id = field("net-detail-id");
  const acts = field("net-detail-acts");
  const panel = field("net-detail-panel");

  panel.classList.toggle("bad", frame?.proto === "ICMP");

  if (!frame) {
    id.textContent = "no frame";
    body.innerHTML = `<div class="net-empty">Pick a frame to take it apart.</div>`;
    acts.innerHTML = "";
    return;
  }

  id.textContent = `frame #${frame.id} · ${frame.len} bytes`;
  const layers = (frame.layers || [])
    .map((layer) => {
      const open = net.openLayers[layer.name] !== false;
      return `<div class="net-layer${open ? " open" : ""}">
        <button type="button" data-net="layer" data-layer="${netEsc(layer.name)}">
          ${netIcon(open ? "expand_more" : "chevron_right")}
          <span class="net-layer-name">${netEsc(layer.name)}</span>
          <span class="mono net-layer-sum">${netEsc(layer.summary)}</span>
        </button>
        ${
          open
            ? `<div class="net-fields">${layer.fields
                .filter(([, value]) => value)
                .map(
                  ([key, value]) =>
                    `<div class="net-field-row"><span class="mono net-k">${netEsc(
                      key
                    )}</span><span class="mono net-v">${netEsc(value)}</span></div>`
                )
                .join("")}</div>`
            : ""
        }
      </div>`;
    })
    .join("");

  body.innerHTML = `${layers}${renderHex(frame.bytes)}`;

  const port = frame.dstPort || frame.srcPort;
  const address = frame.dst || frame.src;
  acts.innerHTML = `
    <button class="btn" type="button" data-net="filter-port" data-value="${port}"
            ${port ? "" : "disabled"}>${netIcon("filter_alt")}Filter port ${port || "—"}</button>
    <button class="btn" type="button" data-net="filter-ip" data-value="${netEsc(address)}"
            ${address ? "" : "disabled"}>${netIcon("my_location")}Filter this IP</button>`;
}

/** The captured bytes, sixteen to a row, with the printable ones beside them.
 *  What pktmon truncated away is simply not here — nothing is padded to look
 *  like a full packet. */
function renderHex(hex) {
  if (!hex) {
    return `<div class="net-hex-none">${netIcon("info")}pktmon logged this frame's headers but no raw bytes.</div>`;
  }
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  const lines = [];
  for (let at = 0; at < bytes.length; at += 16) {
    const chunk = bytes.slice(at, at + 16);
    lines.push(`<div class="net-hex-row">
      <span class="mono net-hex-off">${at.toString(16).padStart(4, "0")}</span>
      <span class="mono net-hex-b">${chunk
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ")}</span>
      <span class="mono net-hex-a">${netEsc(
        chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("")
      )}</span>
    </div>`);
  }
  return `<div class="net-hex"><span class="net-label">Bytes</span>${lines.join("")}</div>`;
}

function renderSession() {
  const body = field("net-session");
  const state = field("net-session-state");
  const rate = net.rate;

  const label = net.capturing ? "recording" : net.exported ? "exported" : "paused";
  state.textContent = label;
  state.className = `net-session-state ${net.capturing ? "go" : net.exported ? "done" : "idle"}`;

  const held = rate?.held || 0;
  const kept = rate?.kept || net.frames.length;
  // The ring is what the session is: there is no .etl behind a real-time
  // capture, so the honest thing to show is how full the ring is.
  const fullness = Math.min(100, (kept / 20000) * 100);
  const sizes = [0, 64, 128, 256, 1500];

  body.innerHTML = `
    <div class="net-session-row">
      <span class="mono net-session-path">${kept.toLocaleString()} frames held in memory</span>
      <span class="mono">${netBytes(held)}</span>
    </div>
    <div class="net-meter"><i style="width:${fullness.toFixed(1)}%" class="${
    fullness > 85 ? "warn" : ""
  }"></i></div>
    <div class="net-session-note">${netIcon("autorenew")}The oldest frame drops out at 20,000 — nothing is written to disk until you export.</div>
    <div class="net-session-sizes">
      <span class="net-label">Keep</span>
      ${sizes
        .map(
          (size) =>
            `<button class="net-chip${net.pktSize === size ? " on" : ""}" type="button"
              data-net="pkt-size" data-size="${size}"
              ${net.capturing ? "disabled" : ""}
              title="${
                size === 0
                  ? "Log every byte of every frame"
                  : `Log the first ${size} bytes of each frame`
              }">${size === 0 ? "all" : size}</button>`
        )
        .join("")}
    </div>
    ${
      net.exported
        ? `<div class="net-exported">${netIcon("task_alt")}
            <span><strong>${net.exported.frames} frames</strong> written as
            ${netBytes(net.exported.bytes)} of pcapng.${
            net.exported.truncated
              ? " Frames longer than the capture size are marked truncated, as Wireshark expects."
              : ""
          }
            <small class="mono">${netEsc(net.exported.path)}</small></span>
            <button class="net-mini wide" type="button" data-net="open-captures">${netIcon(
              "folder_open"
            )}Show</button>
          </div>`
        : ""
    }`;
}

/** Who is on the other end, by bytes. Counted over what is on screen, so the
 *  protocol tab and the exclusions narrow it too. */
function renderTalkers(list) {
  const body = field("net-talkers");
  const totals = new Map();
  for (const frame of list) {
    // The far end is whichever side is not the one we sent from.
    const host = frame.dir === "out" ? frame.dst : frame.src;
    if (!host) continue;
    totals.set(host, (totals.get(host) || 0) + (frame.len || 0));
  }
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (!top.length) {
    body.innerHTML = `<div class="net-empty">Nothing has crossed the wire yet.</div>`;
    return;
  }
  const peak = top[0][1] || 1;
  body.innerHTML = top
    .map(
      ([host, bytes]) => `<button class="net-talker" type="button" data-net="filter-ip"
        data-value="${netEsc(host)}" title="Filter the capture to ${netEsc(host)}">
        <span class="mono net-talker-host">${netEsc(host)}</span>
        <span class="net-meter"><i style="width:${Math.round((bytes / peak) * 100)}%"></i></span>
        <span class="mono net-talker-bytes">${netBytes(bytes)}</span>
      </button>`
    )
    .join("");
}

/** The two buttons whose label is the state they are in. */
function renderBar() {
  const capture = field("net-capture");
  const exportBtn = field("net-export");
  const command = field("net-command");
  const copy = field("net-copy");

  const blocked = net.cap && !(net.cap.available && net.cap.elevated);
  capture.className = `btn ${net.capturing ? "danger" : "primary"}`;
  capture.disabled = !!blocked || net.starting;
  capture.innerHTML = `${netIcon(net.capturing ? "stop" : "fiber_manual_record")}<span>${
    net.starting ? "Starting…" : net.capturing ? "Stop" : "Start capture"
  }</span>`;

  exportBtn.className = `btn${net.exported ? " good" : ""}`;
  exportBtn.disabled = net.exporting || !net.frames.length;
  exportBtn.innerHTML = `${netIcon(net.exported ? "check" : "download")}${
    net.exporting ? "Writing…" : net.exported ? "Exported" : "Export .pcapng"
  }`;

  command.textContent =
    net.command || "pktmon start --capture --pkt-size 128 --log-mode real-time";
  command.classList.toggle("dimmed", !net.command);
  copy.disabled = !net.command;
}

window.devhqNetwork = { mount, render, opened };

})();
