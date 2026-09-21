// Home: the front page of the main window.
//
// It used to be the project overview. That is now the Projects tool, opened
// like any other, and this page is what the window opens on: what needs you,
// what you pinned, where you left off and what you have not tried yet.
//
// Loaded before app.js and runs entirely off app.js's globals (`state`,
// `TOOLS`, `openTool`, `beginWork` ...), which are only touched at call time.
//
// Nothing here scans in the background. A "look" reads a handful of cheap
// things the backend already answers (drive free space, the hosts file, Keep
// Awake, the last PC Detective run, Input Stall Watch, the CLI) when Home is
// opened and when Refresh is pressed - never on a timer. Git and dev-server
// cards come from the last project scan, which the Projects tool owns.
window.wintHome = (() => {
  "use strict";

  const SECTIONS = [
    ["attention", "Needs attention"],
    ["fav", "Favorites"],
    ["recent", "Jump back in"],
    ["discover", "Never opened"],
    ["projects", "Projects"],
  ];
  const DEFAULT_ORDER = SECTIONS.map(([key]) => key);
  const DEFAULT_WIDE = { attention: true, fav: true, recent: false, discover: false, projects: true };
  /** A look younger than this is not repeated just because Home was reopened. */
  const LOOK_FRESH_MS = 60 * 1000;

  const TONE = {
    amber: ["var(--amber)", "rgba(242,181,68,.13)"],
    red: ["var(--red)", "rgba(242,84,91,.13)"],
    blue: ["var(--accent)", "rgba(109,139,255,.13)"],
    teal: ["var(--teal)", "rgba(58,214,200,.13)"],
    green: ["var(--green)", "rgba(63,202,127,.13)"],
    purple: ["var(--purple)", "rgba(180,139,255,.13)"],
  };

  /** Everything Home can watch. `source` names the read behind it: a look
   *  source, "scan" for the project scan, or "live" for state already in the
   *  window. `read(ctx)` returns a card, or null when there is nothing to say. */
  const CATALOGUE = [
    { cat: "Disk & files", icon: "hard_drive", tone: "amber", items: [
      { key: "disk", label: "Disk filling up", tool: "Disk Space Usage", source: "drives", read: readDisk },
    ] },
    { cat: "Network", icon: "network_check", tone: "teal", items: [
      { key: "hosts", label: "Hosts overrides", tool: "Hosts file", source: "hosts", read: readHosts },
    ] },
    { cat: "Security & startup", icon: "shield", tone: "blue", items: [
      { key: "sweep", label: "Security findings", tool: "PC Detective", source: "sweep", read: readSweep },
    ] },
    { cat: "Processes & windows", icon: "lan", tone: "green", items: [
      { key: "orphans", label: "Orphan processes", tool: "Terminals", source: "live", read: readOrphans },
      { key: "stall", label: "Input stalls", tool: "Input Stall Watch", source: "stall", read: readStall },
      { key: "cli", label: "CLI not on PATH", tool: "CLI", source: "cli", read: readCli },
    ] },
    { cat: "Focus & time", icon: "schedule", tone: "teal", items: [
      { key: "awake", label: "Sleep blocked", tool: "Keep Awake", source: "awake", read: readAwake },
    ] },
    { cat: "Development", icon: "commit", tone: "purple", items: [
      { key: "git", label: "Uncommitted / unpushed", tool: "Projects", source: "scan", read: readGit },
      { key: "running", label: "Dev servers running", tool: "Projects", source: "scan", read: readRunning },
    ] },
  ];
  const FLAT = CATALOGUE.flatMap((group) => group.items);
  const DEFAULT_WATCHED = ["disk", "sweep", "orphans", "stall", "awake", "git", "running"];

  /** The reads a look makes, in the order the status bar names them. */
  const LOOK_SOURCES = [
    ["drives", "Reading drive free space", () => invoke("disk_space_drives")],
    ["hosts", "Reading the hosts file", () => invoke("dns_hosts_read")],
    ["sweep", "Reading the last PC Detective run", () => invoke("audit_history")],
    ["stall", "Reading Input Stall Watch", () => invoke("stall_watch_status")],
    ["cli", "Checking the wint command", () => invoke("cli_status")],
    ["awake", "Reading Keep Awake", () => invoke("keep_awake_status")],
    ["clip", "Reading clipboard history", () => invoke("clipboard_recording")],
    ["tracker", "Reading active window tracking", () => invoke("time_tracker_status")],
  ];

  const home = {
    host: null,
    ui: { editing: false, sectionsOpen: false, watchOpen: false, dragging: null },
    /** source -> { value } | { error } once read; absent while it is coming. */
    readings: new Map(),
    looking: false,
    /** Background activities being switched right now. */
    switching: new Set(),
    lookedAt: 0,
    /** Last HTML written per region, so a redraw only touches what changed. */
    drawn: new Map(),
  };

  /* ------------------------------------------------------------ settings */

  function prefs() {
    state.home ||= {};
    const h = state.home;
    delete h.preset;
    if (!Array.isArray(h.order) || DEFAULT_ORDER.some((key) => !h.order.includes(key))) h.order = [...DEFAULT_ORDER];
    if (!h.hidden || typeof h.hidden !== "object") h.hidden = {};
    if (!h.wide || typeof h.wide !== "object") h.wide = { ...DEFAULT_WIDE };
    if (!Array.isArray(h.watched)) h.watched = [...DEFAULT_WATCHED];
    if (!h.dismissed || typeof h.dismissed !== "object") h.dismissed = {};
    return h;
  }

  function save() {
    savePrefs();
    render();
  }

  /* ------------------------------------------------------------- reading */

  function reading(source) {
    return home.readings.get(source);
  }

  function gb(bytes) {
    const value = bytes / 1024 ** 3;
    return value >= 100 ? `${Math.round(value)} GB` : `${value.toFixed(1)} GB`;
  }

  /** `ago` takes a moment in epoch seconds; everything Home reads is in ms. */
  function when(ms) {
    return ms ? ago(ms / 1000) : "";
  }

  function card(tone, fields) {
    const [color, wash] = TONE[tone];
    return { tone: color, wash, ...fields };
  }

  function readDisk() {
    const drives = reading("drives")?.value || [];
    const full = drives
      .filter((d) => d.totalBytes > 0)
      .map((d) => ({ ...d, used: 1 - d.freeBytes / d.totalBytes }))
      .filter((d) => d.used >= 0.9)
      .sort((a, b) => b.used - a.used);
    if (!full.length) return null;
    const d = full[0];
    const pct = `${Math.round(d.used * 100)}%`;
    const name = d.path.replace(/\\$/, "");
    return card(d.used >= 0.95 ? "red" : "amber", {
      icon: "hard_drive", title: `${name} is nearly full`, source: "free space read at the last look",
      fact: pct, factTail: `used · ${gb(d.freeBytes)} free of ${gb(d.totalBytes)}`, bar: pct,
      detail: full.length > 1
        ? `${full.slice(1).map((x) => x.path.replace(/\\$/, "")).join(", ")} ${full.length > 2 ? "are" : "is"} over 90% as well.`
        : "Disk Space Usage shows which folders are taking the room, one drill-down at a time.",
      actions: [["Open Disk Space Usage", "hard_drive", "tool:disk-space", true]],
    });
  }

  function readHosts() {
    const file = reading("hosts")?.value;
    const active = (file?.lines || []).filter((line) => line.kind === "entry" && line.enabled);
    const overrides = active.filter((line) => !/^(127\.0\.0\.1|::1|0\.0\.0\.0)$/.test(line.ip)
      || line.names.some((name) => !/^localhost$/i.test(name)));
    if (!overrides.length) return null;
    const names = overrides.flatMap((line) => line.names);
    return card("amber", {
      icon: "edit_note", title: `${overrides.length} hosts ${overrides.length === 1 ? "entry is" : "entries are"} active`,
      source: "hosts file read at the last look",
      fact: String(overrides.length), factTail: overrides.length === 1 ? "override" : "overrides",
      detail: `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}. An entry here beats every DNS server.`,
      actions: [["Open Hosts file", "edit_note", "tool:hosts", true]],
    });
  }

  function readSweep() {
    const runs = reading("sweep")?.value || [];
    const last = runs[0];
    if (!last) return null;
    const open = (last.high || 0) + (last.medium || 0) + (last.low || 0);
    if (!open) return null;
    const at = last.updatedAt || last.startedAt;
    return card(last.high ? "red" : "blue", {
      icon: "shield", title: "PC Detective has open findings",
      source: at ? `investigated ${when(at)}` : "from the last investigation",
      fact: String(open), factTail: `open · ${last.high || 0} high, ${last.medium || 0} medium, ${last.low || 0} low`,
      detail: "Nothing changes on this PC until you approve a fix in PC Detective.",
      actions: [["Review findings", "fact_check", "tool:security-audit", true]],
    });
  }

  function readOrphans() {
    const warnings = window.termsState?.orphanWarnings;
    const rows = warnings ? [...warnings.values()] : [];
    if (!rows.length) return null;
    return card("amber", {
      icon: "warning", title: "Processes outlived their terminal", source: "tracked since this session started",
      fact: String(rows.length), factTail: "still running",
      detail: rows.slice(0, 3).map((row) => `${row.process || "Unknown"} (${row.pid})`).join(" · "),
      actions: [["Show them", "visibility", "orphans", true]],
    });
  }

  function readStall() {
    const status = reading("stall")?.value;
    const stalls = (status?.stalls || []).filter((stall) => stall.kind !== "manual");
    if (!stalls.length) return null;
    const longest = stalls.reduce((a, b) => (b.durationMs > a.durationMs ? b : a));
    const latest = stalls.reduce((a, b) => (b.at > a.at ? b : a));
    return card("amber", {
      icon: "mouse", title: `The PC froze ${stalls.length === 1 ? "once" : `${stalls.length} times`}`,
      source: status.watching ? "Input Stall Watch is watching" : "from Input Stall Watch's last session",
      fact: `${(longest.durationMs / 1000).toFixed(1)}s`, factTail: `longest stall · last one ${when(latest.at)}`,
      detail: latest.verdict || latest.detail || "Open Input Stall Watch to see what the machine was doing at that second.",
      actions: [["See the stalls", "visibility", "tool:stall-watch", true]],
    });
  }

  function readCli() {
    const status = reading("cli")?.value;
    if (!status || !status.installed || status.onPath) return null;
    return card("blue", {
      icon: "terminal", title: "The wint command is not on PATH", source: "checked at the last look",
      fact: "wint", factTail: "installed but not found by a new shell",
      detail: status.message || "A new terminal will not find it until the folder is on PATH.",
      actions: [["Open CLI", "terminal", "tool:cli", true]],
    });
  }

  function readAwake() {
    const status = reading("awake")?.value;
    if (!status?.active) return null;
    const left = status.until ? Math.max(0, status.until - Date.now()) : 0;
    const minutes = Math.round(left / 60000);
    return card("green", {
      icon: "coffee", title: "Sleep is blocked", source: status.bySchedule ? "held by your Keep Awake schedule" : "Keep Awake is on",
      fact: left ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m` : "On",
      factTail: left ? "remaining" : "until you stop it",
      detail: [status.system && "sleep", status.display && "display"].filter(Boolean).join(" and ")
        ? `The ${[status.system && "sleep", status.display && "display"].filter(Boolean).join(" and ")} timer${status.system && status.display ? "s are" : " is"} held.`
        : "Windows is being kept awake.",
      actions: [["Open Keep Awake", "coffee", "tool:keep-awake", true]],
    });
  }

  function settledProjects() {
    return state.projects.filter((p) => !p.pending);
  }

  function readGit() {
    if (!state.roots.length) return null;
    const settled = settledProjects();
    const dirty = settled.filter(FILTERS.dirty.test);
    const unpushed = settled.filter(FILTERS.unpushed.test);
    if (!dirty.length && !unpushed.length) return null;
    const files = dirty.reduce((sum, p) => sum + changeCount(p), 0);
    const top = [...dirty].sort((a, b) => changeCount(b) - changeCount(a))[0];
    return card("purple", {
      icon: "commit", title: "Work not yet saved anywhere else",
      source: state.scannedAt ? `last project scan ${new Date(state.scannedAt).toLocaleTimeString()}` : "from the project scan",
      fact: String(dirty.length), factTail: `projects dirty · ${unpushed.length} unpushed`,
      detail: top ? `${files} changed files in total. ${top.name} alone has ${changeCount(top)}.` : `${unpushed.length} projects have commits that are not on a remote.`,
      actions: [["Show them", "folder_copy", "filter:dirty", true], ["Rescan projects", "refresh", "rescan", false]],
    });
  }

  function readRunning() {
    if (!state.roots.length) return null;
    const running = settledProjects().filter(FILTERS.running.test);
    if (!running.length) return null;
    return card("green", {
      icon: "bolt", title: `${running.length === 1 ? "A dev server is" : `${running.length} dev servers are`} up`,
      source: "from the last project scan",
      fact: String(running.length), factTail: running.length === 1 ? "project running" : "projects running",
      detail: running.slice(0, 4).map((p) => p.name).join(", ") + (running.length > 4 ? ` and ${running.length - 4} more` : ""),
      actions: [["Show them", "lan", "filter:running", true], ["Open Process Explorer", "lan", "tool:ports", false]],
    });
  }

  /** Reads every source Home watches, streaming each answer into the page as
   *  it lands. Sources nothing watches are not read at all - except the ones
   *  the "Running in the background" strip needs, which are always read. */
  async function look() {
    if (home.looking) return;
    const watched = new Set(prefs().watched);
    const needed = LOOK_SOURCES.filter(([source]) => BACKGROUND_SOURCES.includes(source)
      || FLAT.some((item) => item.source === source && watched.has(item.key)));
    home.looking = true;
    home.readings.clear();
    render();
    let done = 0;
    if (needed.length) beginWork("home-look", "Looking at what Home watches", `0 / ${needed.length}`);
    await Promise.all(needed.map(async ([source, label, read]) => {
      try {
        home.readings.set(source, { value: await read() });
      } catch (error) {
        home.readings.set(source, { error: String(error) });
      }
      done += 1;
      updateWork("home-look", `${done} / ${needed.length} · ${label.replace(/^Reading |^Checking /, "")} read`);
      render();
    }));
    home.looking = false;
    home.lookedAt = Date.now();
    endWork("home-look");
    render();
    markDirty("activity");
  }

  /* ---------------------------------------------------------- background */

  window.addEventListener("wint:time-tracker-changed", (event) => {
    if (!event.detail?.status) return;
    home.readings.set("tracker", { value: event.detail.status });
    render();
  });

  /** Sources the background strip reads on every look, watched or not. */
  const BACKGROUND_SOURCES = ["stall", "awake", "clip", "tracker"];

  /** What WinT does while nobody is looking: one row per thing that runs on
   *  its own. `records` marks the ones that keep information about this PC. */
  function backgroundRows() {
    const clip = reading("clip");
    const stall = reading("stall");
    const awake = reading("awake");
    const tracker = reading("tracker");
    const pending = (key, iconName, label, tool) => ({ key, icon: iconName, label, tool, pending: true });
    return [
      clip ? {
        key: "clip", icon: "content_paste", label: "Clipboard history", on: clip.value === true, records: true, tool: "clipboard",
        detail: clip.error ? "Could not be read" : clip.value
          ? "Recording · keeps your last 250 copies, text and images, on this PC"
          : "Paused · nothing you copy is kept",
      } : pending("clip", "content_paste", "Clipboard history", "clipboard"),
      tracker ? {
        key: "tracker", icon: "schedule", label: "Active window tracking", on: tracker.value?.enabled === true, records: true, tool: "time-tracker",
        detail: tracker.error ? "Could not be read" : tracker.value?.enabled
          ? "Recording · notes which window is in front every few seconds, whether or not the tool is open"
          : "Off · not noting which window you use",
      } : pending("tracker", "schedule", "Active window tracking", "time-tracker"),
      stall ? {
        key: "stall", icon: "mouse", label: "Input stall tracking", on: stall.value?.watching === true, records: true, tool: "stall-watch",
        detail: stall.error ? "Could not be read" : stall.value?.watching
          ? `Recording · catching freezes longer than ${stall.value.thresholdMs} ms`
          : "Off · not watching for freezes",
      } : pending("stall", "mouse", "Input stall tracking", "stall-watch"),
      awake ? {
        key: "awake", icon: "coffee", label: "Keep Awake", on: awake.value?.active === true, records: false, tool: "keep-awake",
        detail: awake.value?.active ? "On · holding sleep off, records nothing" : "Off · Windows sleeps as usual",
      } : pending("awake", "coffee", "Keep Awake", "keep-awake"),
      {
        key: "usage", icon: "favorite", label: "Usage tracking", on: state.analyticsChosen && state.analytics, records: false, go: "settings",
        detail: state.analyticsChosen && state.analytics
          ? "On · thank you! Tells us which screens get used - anonymous, never your projects"
          : "Off · switch on to help us see which parts of WinT people enjoy",
      },
    ];
  }

  function backgroundHtml() {
    const rows = backgroundRows();
    const pending = rows.some((row) => row.pending);
    const recording = rows.filter((row) => row.on && row.records);
    const summary = pending ? "reading…"
      : recording.length ? `recording: ${recording.map((row) => row.label.toLowerCase()).join(", ")}`
        : "not recording any information";
    return `<span class="home-bg-head">${icon("sensors")}<strong>Running in the background</strong><small>${esc(summary)}</small>
        ${recording.length ? `<span class="home-fill"></span><button type="button" class="home-ghost small" data-home-act="bg-all-off">${icon("block")}Stop all recording</button>` : ""}</span>
      <span class="home-bg-rows">${rows.map((row) => {
        if (row.pending) {
          return `<span class="home-bg-row skeleton">${icon(row.icon)}<span class="home-fav-text"><strong>${esc(row.label)}</strong><small>Reading…</small></span></span>`;
        }
        const busy = home.switching.has(row.key);
        return `<span class="home-bg-row${row.on ? " on" : ""}">
          <button type="button" class="home-bg-open" data-home-go="${esc(row.go || `tool:${row.tool}`)}" title="Open ${esc(row.label)}">
            <i class="home-bg-dot"></i>${icon(row.icon)}<span class="home-fav-text"><strong>${esc(row.label)}</strong><small>${esc(busy ? (row.on ? "Turning off…" : "Turning on…") : row.detail)}</small></span></button>
          <button type="button" class="home-bg-switch${row.on ? " on" : ""}" role="switch" aria-checked="${row.on}" data-home-bg="${row.key}"
            title="${row.on ? "Turn off" : "Turn on"} ${esc(row.label)}"${busy ? " disabled" : ""}><i></i></button>
        </span>`;
      }).join("")}</span>
      ${!pending && !recording.length ? `<span class="home-bg-none">${icon("verified_user")}WinT is not recording any information right now.</span>` : ""}`;
  }

  /** Turns one background activity on or off, and keeps it that way across
   *  restarts where the activity itself remembers (all but Keep Awake). */
  async function switchBackground(key, on) {
    if (home.switching.has(key)) return;
    const label = { clip: "clipboard history", tracker: "active window tracking", stall: "input stall tracking", awake: "Keep Awake", usage: "usage tracking" }[key];
    home.switching.add(key);
    beginWork(`home-bg-${key}`, `${on ? "Turning on" : "Turning off"} ${label}`);
    render();
    try {
      if (key === "clip") {
        home.readings.set("clip", { value: await invoke("clipboard_recording_set", { on }) });
      } else if (key === "tracker") {
        home.readings.set("tracker", { value: await invoke("time_tracker_set", { enabled: on }) });
      } else if (key === "stall") {
        const thresholdMs = reading("stall")?.value?.thresholdMs || 100;
        home.readings.set("stall", { value: await invoke("stall_watch_set", { watching: on, thresholdMs }) });
      } else if (key === "usage") {
        state.analytics = on;
        state.analyticsChosen = true;
        savePrefs();
        applyAnalytics();
        if (on) window.wintTrackPageView?.(currentPath());
      } else if (key === "awake") {
        home.readings.set("awake", { value: await invoke("keep_awake_set", {
          system: on, display: false, awayMode: false, minutes: 0, nudge: false, nudgeSeconds: 120,
          reason: on ? "Turned on from Home" : "",
        }) });
      }
    } catch (error) {
      console.error(`Could not switch ${label}`, error);
    }
    home.switching.delete(key);
    endWork(`home-bg-${key}`);
    render();
  }

  async function stopAllRecording() {
    const rows = backgroundRows().filter((row) => row.on && row.records && !row.pending);
    await Promise.all(rows.map((row) => switchBackground(row.key, false)));
  }

  /* ------------------------------------------------------------- drawing */

  function insights() {
    const h = prefs();
    const watched = new Set(h.watched);
    const cards = [];
    const loading = [];
    for (const item of FLAT) {
      if (!watched.has(item.key)) continue;
      const pendingLook = !["scan", "live"].includes(item.source) && !home.readings.has(item.source);
      if (pendingLook) {
        if (home.looking) loading.push(item);
        continue;
      }
      const result = item.read();
      if (!result) continue;
      const signature = `${result.title}|${result.fact}|${result.factTail}`;
      if (h.dismissed[item.key] === signature) continue;
      cards.push({ item, signature, ...result });
    }
    return { cards: cards.slice(0, 8), loading };
  }

  function sectionHead(key, iconName, tone, title, extra = "") {
    const editing = home.ui.editing;
    return `<header class="home-sec-head">
      ${editing ? `<span class="home-grip" title="Drag to reorder">${icon("drag_indicator")}</span>` : ""}
      <span class="home-sec-icon" style="color:${tone}">${icon(iconName)}</span>
      <strong>${esc(title)}</strong>${extra}${extra.includes("home-fill") ? "" : `<span class="home-fill"></span>`}
      ${editing ? `<span class="home-sec-edit">
        <button type="button" data-home-wide="${key}" title="Wide or half width">${icon("swap_horiz")}</button>
        <button type="button" data-home-hide="${key}" title="Hide this section">${icon("visibility_off")}</button>
      </span>` : ""}
    </header>`;
  }

  function attentionHtml() {
    const h = prefs();
    const { cards, loading } = insights();
    const watchedCount = h.watched.length;
    const head = sectionHead("attention", "notifications", "var(--amber)", "Needs attention",
      `<span class="home-count">${cards.length}</span><span class="home-fill"></span>
       <button type="button" class="home-ghost${home.ui.watchOpen ? " on" : ""}" data-home-act="watch">${icon("tune")}What's watched</button>`);
    const watch = home.ui.watchOpen ? `<div class="home-watch">
      <span class="home-watch-head"><span class="home-eyebrow">Watch on this front page</span>
        <small>${watchedCount} of ${FLAT.length} watched — nothing is watched unless you say so</small><span class="home-fill"></span>
        <button type="button" class="home-ghost small" data-home-act="watch-none">Watch nothing</button>
        <button type="button" class="home-ghost small" data-home-act="watch-all">Watch everything</button></span>
      ${CATALOGUE.map((group, index) => {
        const on = group.items.filter((item) => h.watched.includes(item.key)).length;
        return `<span class="home-watch-group">
          <span class="home-watch-cat"><span style="color:${TONE[group.tone][0]}">${icon(group.icon)}</span><strong>${esc(group.cat)}</strong>
            <small>${on}/${group.items.length}</small><i></i>
            <button type="button" data-home-watch-group="${index}">${on === group.items.length ? "none" : "all"}</button></span>
          <span class="home-pills">${group.items.map((item) => {
            const lit = h.watched.includes(item.key);
            return `<button type="button" class="home-pill${lit ? " on" : ""}" data-home-watch="${item.key}">${icon(lit ? "check_circle" : "add")}${esc(item.label)}<small>${esc(item.tool)}</small></button>`;
          }).join("")}</span></span>`;
      }).join("")}
    </div>` : "";
    const body = cards.map((c) => `<article class="home-insight">
        <i class="home-stripe" style="background:${c.tone}"></i>
        <div class="home-insight-top">
          <span class="home-plate" style="background:${c.wash};color:${c.tone}">${icon(c.icon)}</span>
          <span class="home-insight-title"><strong>${esc(c.title)}</strong><small>${esc(c.source)}</small></span>
          <button type="button" class="home-x" data-home-dismiss="${c.item.key}" data-signature="${esc(c.signature)}" title="Dismiss until it changes">${icon("close")}</button>
        </div>
        <div class="home-fact"><span style="color:${c.tone}">${esc(c.fact)}</span><span>${esc(c.factTail)}</span></div>
        ${c.bar ? `<span class="home-bar"><i style="width:${c.bar};background:${c.tone}"></i></span>` : ""}
        <div class="home-detail">${esc(c.detail)}</div>
        <div class="home-actions">${c.actions.map(([label, iconName, action, primary]) => `<button type="button" data-home-go="${esc(action)}"
          class="home-action${primary ? " primary" : ""}"${primary ? ` style="border-color:${c.tone};background:${c.wash};color:${c.tone}"` : ""}>${icon(iconName)}${esc(label)}</button>`).join("")}</div>
      </article>`).join("")
      + loading.map((item) => `<article class="home-insight skeleton">
        <div class="home-insight-top"><span class="home-plate sk"></span>
          <span class="home-insight-title"><strong>${esc(item.label)}</strong><small>reading ${esc(item.tool)}…</small></span></div>
        <span class="sk sk-line" style="width:40%"></span><span class="sk sk-line" style="width:85%"></span></article>`).join("");
    const quiet = !cards.length && !loading.length
      ? `<div class="home-quiet">${icon("check_circle")}<span>${watchedCount
        ? "Nothing needs you right now. Everything watched was quiet at the last look."
        : "Nothing is watched. Open What's watched to choose what Home keeps an eye on."}</span></div>` : "";
    return head + watch + (body ? `<div class="home-insights">${body}</div>` : "") + quiet;
  }

  function favoritesHtml() {
    const tools = state.toolPins.map(toolById).filter(Boolean).map((tool) => ({
      go: `tool:${tool.id}`, icon: tool.icon, name: tool.name, sub: tool.hint, kind: "tool", tone: "blue",
    }));
    const projects = [...state.favorites].map((path) => state.byPath.get(path)).filter(Boolean).map((p) => ({
      go: `project:${p.path}`, icon: "folder_copy", name: p.name, sub: p.git?.branch ? `${p.path} · ${p.git.branch}` : p.path, kind: "project", tone: "purple",
    }));
    const items = [...tools, ...projects];
    return sectionHead("fav", "star", "var(--amber)", "Favorites", `<span class="home-note">pinned tools and starred projects</span>`)
      + `<div class="home-favs">${items.map((f) => `<button type="button" class="home-fav" data-home-go="${esc(f.go)}">
          <span class="home-plate" style="background:${TONE[f.tone][1]};color:${TONE[f.tone][0]}">${icon(f.icon)}</span>
          <span class="home-fav-text"><strong>${esc(f.name)}</strong><small>${esc(f.sub)}</small></span>
          <span class="home-kind">${f.kind}</span></button>`).join("")}
        <button type="button" class="home-fav hint" data-home-go="search">${icon("push_pin")}Pin a tool from its header, or star a project</button>
      </div>`;
  }

  function recentHtml() {
    const used = state.toolUsedAt || {};
    const rows = state.toolRecent.map((id) => toolById(id)).filter(Boolean).slice(0, 6);
    return sectionHead("recent", "history", "var(--accent)", "Jump back in")
      + (rows.length ? `<div class="home-recent">${rows.map((tool) => `<button type="button" data-home-go="tool:${tool.id}">
          <span class="home-recent-icon">${icon(tool.icon)}</span>
          <span class="home-fav-text"><strong>${esc(tool.name)}</strong><small>${esc(tool.hint)}</small></span>
          <small class="home-when">${used[tool.id] ? esc(when(used[tool.id])) : ""}</small></button>`).join("")}</div>`
        : `<div class="home-quiet">${icon("history")}<span>Tools you open show up here, most recent first.</span></div>`);
  }

  function discoverHtml() {
    const used = state.toolUsedAt || {};
    const opened = new Set([...state.toolRecent, ...Object.keys(used), ...state.toolPins]);
    const never = TOOLS.filter((tool) => !opened.has(tool.id) && tool.id !== "help");
    // A stable pick per day, so the list does not shuffle on every redraw.
    const day = Math.floor(Date.now() / 86400000);
    const start = never.length ? day % never.length : 0;
    const picks = [...never.slice(start), ...never.slice(0, start)].slice(0, 4);
    return sectionHead("discover", "handyman", "var(--teal)", "You have never opened these",
      `<span class="home-fill"></span><button type="button" class="home-ghost" data-home-go="tool:help">All ${TOOLS.length} tools${icon("arrow_forward")}</button>`)
      + (picks.length ? `<div class="home-discover">${picks.map((tool) => `<button type="button" data-home-go="tool:${tool.id}">
          <span class="home-plate" style="background:${TONE.teal[1]};color:var(--teal)">${icon(tool.icon)}</span>
          <span class="home-fav-text wrap"><strong>${esc(tool.name)}</strong><small>${esc(tool.hint)}</small></span>
          ${icon("arrow_forward")}</button>`).join("")}</div>`
        : `<div class="home-quiet">${icon("check_circle")}<span>You have opened every tool at least once.</span></div>`);
  }

  function projectsHtml() {
    const sorted = [...state.projects].sort((a, b) => activity(b) - activity(a)).slice(0, 4);
    return sectionHead("projects", "folder_copy", "var(--purple)", "Projects",
      `<span class="home-note mono">${esc(rootsLabel())}</span><span class="home-fill"></span>
       <button type="button" class="home-ghost" data-home-go="tool:projects">All ${state.projects.length}${icon("arrow_forward")}</button>`)
      + `<div class="home-projects">${sorted.map((p) => {
        if (p.pending) {
          return `<button type="button" class="home-project skeleton" data-home-go="project:${esc(p.path)}"><strong>${esc(p.name)}</strong>
            <span class="sk sk-line" style="width:60%"></span><small>Reading git status…</small></button>`;
        }
        const changed = changeCount(p);
        const running = p.running.length;
        const tone = changed && running ? "linear-gradient(180deg,var(--green) 50%,var(--amber) 50%)"
          : changed ? "var(--amber)" : running ? "var(--green)" : "var(--line)";
        const bits = [!p.git ? "not a repo" : changed ? `${changed} changed` : "clean"];
        if (p.git && !p.git.remote) bits.push("no remote");
        if (running) bits.push(`${running} running`);
        const stateTone = changed ? "var(--amber)" : running ? "var(--green)" : "var(--dim2)";
        const at = activity(p);
        return `<button type="button" class="home-project" data-home-go="project:${esc(p.path)}">
          <i class="home-stripe" style="background:${tone}"></i>
          <span class="home-project-name"><strong>${esc(p.name)}</strong>${p.git?.branch ? `<small class="mono">${esc(p.git.branch)}</small>` : ""}</span>
          <span class="home-project-state"><span style="color:${stateTone}">${esc(bits.join(" · "))}</span>${at ? `<span>${esc(ago(at))}</span>` : ""}</span>
        </button>`;
      }).join("")}${!sorted.length ? `<div class="home-quiet">${icon(state.scanning ? "hourglass_top" : "folder_off")}<span>${state.scanning ? "Scanning for projects…" : "No projects found in that folder yet."}</span></div>` : ""}</div>`;
  }

  function effectiveHidden() {
    const h = prefs();
    const hidden = { ...h.hidden };
    if (!state.roots.length) hidden.projects = true;
    return hidden;
  }

  function toolbarHtml() {
    const h = prefs();
    const hidden = effectiveHidden();
    const shown = SECTIONS.filter(([key]) => !hidden[key]).length;
    const last = home.looking ? "looking now…" : home.lookedAt ? `last look ${when(home.lookedAt)}` : "not looked yet";
    return `<span class="home-title">${icon("home")}Home</span>
      <span class="home-last">${icon("history")}${esc(last)}</span>
      <button type="button" class="home-tbtn home-push${home.ui.sectionsOpen ? " on" : ""}" data-home-act="sections">${icon("visibility")}<span>Sections</span><span class="mono">${shown}/${SECTIONS.length}</span></button>
      <button type="button" class="home-tbtn${home.ui.editing ? " done" : ""}" data-home-act="edit">${icon(home.ui.editing ? "check_circle" : "tune")}<span>${home.ui.editing ? "Done" : "Customize"}</span></button>
      <button type="button" class="btn primary home-refresh" data-home-act="refresh"${home.looking ? " disabled" : ""}>${icon("refresh")}<span>Refresh</span></button>
      <span class="home-promise">${icon("bolt")}Home only looks when opened or refreshed</span>`;
  }

  function sectionsPanelHtml() {
    const h = prefs();
    const hidden = effectiveHidden();
    const notes = {
      attention: `${h.watched.length} watched`,
      fav: `${state.toolPins.length + state.favorites.size} pinned`,
      recent: `${state.toolRecent.filter((id) => toolById(id)).length} tools`,
      discover: `of ${TOOLS.length}`,
      projects: state.roots.length ? `${state.projects.length} found` : "no folder set",
    };
    return `<span class="home-panel-head">${icon("visibility")}<strong>What this front page shows</strong>
        <small>turn any block off — the rest closes the gap</small><span class="home-fill"></span>
        <button type="button" class="home-x" data-home-act="sections">${icon("close")}</button></span>
      <span class="home-pills">${SECTIONS.map(([key, label]) => {
        const on = !hidden[key];
        return `<button type="button" class="home-pill big${on ? " on" : ""}" data-home-toggle="${key}">${icon(on ? "visibility" : "visibility_off")}${label}<small>${esc(notes[key])}</small></button>`;
      }).join("")}</span>`;
  }

  function setupHtml() {
    return `<div class="home-setup-head"><span class="home-plate big">${icon("rocket_launch")}</span>
        <div><div class="home-setup-title">Four things to set up, whenever you like</div>
        <div class="home-setup-sub">WinT never starts a long job on its own. Each card below runs once you ask, and then keeps showing its last result here.</div></div>
        <button type="button" class="home-x" data-home-act="setup-done" title="Hide these">${icon("close")}</button></div>
      <div class="home-setup-grid">${[
        ["var(--amber)", "hard_drive", "Scan a drive once", "Disk Space Usage shows what fills a drive. Home keeps the free-space figure on every look.", "Open Disk Space Usage", "tool:disk-space"],
        ["var(--accent)", "shield", "Investigate this PC", "Looks at what starts, runs and listens, and works out where anything odd came from. Nothing changes without your approval.", "Open PC Detective", "tool:security-audit"],
        ["var(--purple)", "folder_copy", "Point at a code folder", "Optional. Adds git status, running dev servers and detected tech for every project under it.", "Choose a folder", "choose-folder"],
        ["var(--teal)", "push_pin", "Pin what you use", "Any tool can sit in Favorites and the status bar: use the pin in its header, or the one beside it in search.", "Browse tools", "search"],
      ].map(([tone, iconName, title, body, action, go]) => `<div class="home-setup-card">
          <span class="home-setup-card-title" style="color:${tone}">${icon(iconName)}${title}</span>
          <span>${body}</span>
          <button type="button" data-home-go="${go}">${action}</button></div>`).join("")}</div>`;
  }

  function noRootHtml() {
    return `${icon("folder_copy")}<span class="home-fav-text wrap"><strong>Point WinT at a code folder to get the Projects section</strong>
        <small>Git status, running dev servers and detected tech for every project under it. Nothing else on this page needs it.</small></span>
      <button type="button" class="home-ghost solid" data-home-go="choose-folder">${icon("folder_open")}Choose a folder</button>`;
  }

  function editBarHtml() {
    const h = prefs();
    return `${icon("edit_note")}<span>Drag a section by its handle to reorder. Hidden sections come back from here.</span><span class="home-fill"></span>
      ${SECTIONS.filter(([key]) => h.hidden[key]).map(([key, label]) => `<button type="button" class="home-pill" data-home-toggle="${key}">${icon("visibility")}${label}</button>`).join("")}
      <button type="button" class="home-ghost" data-home-act="reset">${icon("restart_alt")}Reset layout</button>`;
  }

  const SECTION_HTML = { attention: attentionHtml, fav: favoritesHtml, recent: recentHtml, discover: discoverHtml, projects: projectsHtml };

  /** Writes a region only when its markup changed, so focus, hover and a
   *  running shimmer survive redraws that had nothing new to say. */
  function patch(node, key, html) {
    if (home.drawn.get(key) === html) return;
    home.drawn.set(key, html);
    node.innerHTML = html;
  }

  function mount(host) {
    home.host = host;
    host.innerHTML = `<div class="home-toolbar" data-region="toolbar"></div>
      <div class="home-bg" data-region="background"></div>
      <div class="home-scroll"><div class="home-grid" data-region="grid">
        <section class="home-sec home-panel" data-region="sections" hidden></section>
        <section class="home-sec home-setup" data-region="setup" hidden></section>
        ${SECTIONS.map(([key]) => `<section class="home-sec" data-home-section="${key}"></section>`).join("")}
        <section class="home-sec home-noroot" data-region="noroot" hidden></section>
        <section class="home-sec home-editbar" data-region="editbar" hidden></section>
      </div></div>`;
    host.addEventListener("click", onClick);
    window.addEventListener("wint:time-tracker-changed", () => render());
    // Clipboard recording can be paused from its own tool as well as here.
    listen("clipboard:recording", (event) => {
      home.readings.set("clip", { value: event.payload === true });
      render();
    });
    host.addEventListener("dragstart", (event) => {
      const section = event.target.closest?.("[data-home-section]");
      if (!section || !home.ui.editing) return;
      home.ui.dragging = section.dataset.homeSection;
      event.dataTransfer.effectAllowed = "move";
    });
    host.addEventListener("dragover", (event) => {
      if (home.ui.dragging && event.target.closest?.("[data-home-section]")) event.preventDefault();
    });
    host.addEventListener("drop", (event) => {
      const target = event.target.closest?.("[data-home-section]")?.dataset.homeSection;
      const from = home.ui.dragging;
      home.ui.dragging = null;
      if (!target || !from || target === from) return;
      event.preventDefault();
      const h = prefs();
      const next = h.order.filter((key) => key !== from);
      next.splice(next.indexOf(target), 0, from);
      h.order = next;
      save();
    });
  }

  function render() {
    const host = home.host;
    if (!host || host.hidden) return;
    const h = prefs();
    const hidden = effectiveHidden();
    const region = (name) => host.querySelector(`[data-region="${name}"]`);
    patch(region("toolbar"), "toolbar", toolbarHtml());
    patch(region("background"), "background", backgroundHtml());
    region("grid").classList.toggle("editing", home.ui.editing);

    const sections = region("sections");
    sections.hidden = !home.ui.sectionsOpen;
    if (!sections.hidden) patch(sections, "sections", sectionsPanelHtml());

    const setup = region("setup");
    setup.hidden = Boolean(h.setupDone) || state.toolRecent.length > 2;
    if (!setup.hidden) patch(setup, "setup", setupHtml());

    for (const [key] of SECTIONS) {
      const node = host.querySelector(`[data-home-section="${key}"]`);
      node.hidden = Boolean(hidden[key]);
      node.style.order = String(h.order.indexOf(key) + 1);
      node.classList.toggle("wide", Boolean(h.wide[key]));
      node.draggable = home.ui.editing;
      if (!node.hidden) patch(node, key, SECTION_HTML[key]());
    }

    const noroot = region("noroot");
    noroot.hidden = state.roots.length > 0;
    if (!noroot.hidden) patch(noroot, "noroot", noRootHtml());

    const editbar = region("editbar");
    editbar.hidden = !home.ui.editing;
    if (!editbar.hidden) patch(editbar, "editbar", editBarHtml());
  }

  function go(action, button) {
    const [kind, ...rest] = action.split(":");
    const value = rest.join(":");
    if (kind === "tool") return openTool(value);
    if (kind === "project") {
      const project = state.byPath.get(value);
      if (project) projectAction("open", project);
      return;
    }
    if (kind === "filter") {
      state.filters = new Set([value]);
      savePrefs();
      openTool("projects");
      markDirty("grid", "filters");
      return;
    }
    if (kind === "rescan") return rescan();
    if (kind === "settings") return document.getElementById("open-settings")?.click();
    if (kind === "orphans") return document.getElementById("status-orphan")?.click();
    if (kind === "search") return openSearchCommands({ fresh: true });
    if (kind === "choose-folder") {
      openTool("projects");
      requestAnimationFrame(() => openRootEditor());
      return;
    }
    void button;
  }

  function onClick(event) {
    const target = event.target.closest("button");
    if (!target || !home.host.contains(target)) return;
    const h = prefs();
    const d = target.dataset;
    if (d.homeGo) return go(d.homeGo, target);
    if (d.homeBg) return switchBackground(d.homeBg, target.getAttribute("aria-checked") !== "true");
    if (d.homeToggle) {
      h.hidden[d.homeToggle] = !effectiveHidden()[d.homeToggle];
      if (d.homeToggle === "projects" && !state.roots.length) return go("choose-folder");
      return save();
    }
    if (d.homeWide) { h.wide[d.homeWide] = !h.wide[d.homeWide]; return save(); }
    if (d.homeHide) { h.hidden[d.homeHide] = true; return save(); }
    if (d.homeDismiss) { h.dismissed[d.homeDismiss] = d.signature; return save(); }
    if (d.homeWatch) {
      const watched = new Set(h.watched);
      if (watched.has(d.homeWatch)) watched.delete(d.homeWatch);
      else watched.add(d.homeWatch);
      h.watched = [...watched];
      save();
      return lookIfMissing();
    }
    if (d.homeWatchGroup) {
      const keys = CATALOGUE[Number(d.homeWatchGroup)].items.map((item) => item.key);
      const all = keys.every((key) => h.watched.includes(key));
      h.watched = all ? h.watched.filter((key) => !keys.includes(key)) : [...new Set([...h.watched, ...keys])];
      save();
      return lookIfMissing();
    }
    switch (d.homeAct) {
      case "watch": home.ui.watchOpen = !home.ui.watchOpen; return render();
      case "watch-all": h.watched = FLAT.map((item) => item.key); save(); return lookIfMissing();
      case "watch-none": h.watched = []; return save();
      case "sections": home.ui.sectionsOpen = !home.ui.sectionsOpen; return render();
      case "edit": home.ui.editing = !home.ui.editing; return render();
      case "refresh": return look();
      case "bg-all-off": return stopAllRecording();
      case "reset":
        h.order = [...DEFAULT_ORDER];
        h.hidden = {};
        h.wide = { ...DEFAULT_WIDE };
        return save();
      case "setup-done": h.setupDone = true; return save();
    }
  }

  /** A newly watched item whose source was never read gets read now, rather
   *  than sitting blank until the next Refresh. */
  function lookIfMissing() {
    const watched = new Set(prefs().watched);
    const missing = FLAT.some((item) => watched.has(item.key) && !["scan", "live"].includes(item.source) && !home.readings.has(item.source));
    if (missing && !home.looking) look();
  }

  function opened() {
    render();
    if (!home.looking && Date.now() - home.lookedAt > LOOK_FRESH_MS) look();
  }

  /** The idle line in the status bar while Home is on screen. */
  function idleDetail() {
    const watched = prefs().watched.length;
    const shown = insights().cards.length;
    const last = home.lookedAt ? `last look ${when(home.lookedAt)}` : "not looked yet";
    return `${watched} things watched · ${shown} need${shown === 1 ? "s" : ""} attention · ${last}`;
  }

  return { mount, render, opened, look, idleDetail };
})();
