(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name) => window.devhqShell?.icon?.(name) || `<span class="ms" aria-hidden="true">${name}</span>`;
  const catalog = [
    { id: "help", name: "Help", icon: "help", hint: "project commands, application commands, and available tools", keywords: "help guide guides docs documentation manual readme ? about faq how to getting started what can commands run terminal pull code explorer tools shortcuts keyboard hotkeys" },
    { id: "cli", name: "CLI", icon: "terminal", hint: "use every headless DevHQ command from any terminal", keywords: "cli command line commandline terminal console shell powershell pwsh cmd bash headless script scripting automation arguments flags json output scan git dns ports help docs devhq exe" },
    { id: "events", name: "Event Log Streamer", icon: "receipt_long", hint: "filter Windows events as they arrive", keywords: "event events viewer eventvwr log logs evtx application system security setup errors warnings critical crash audit login source id level filter regex stream live follow windows log" },
    { id: "registry", name: "Registry", icon: "database", hint: "browse and carefully edit registry values", keywords: "registry regedit reg hive hkey hkcu hklm hkcr hkey_current_user hkey keys value values dword qword string expand binary edit browse search environment run startup uninstall" },
    { id: "system", name: "System", icon: "tune", hint: "audit PATH and environment variables", keywords: "system path %path% environment variable variables env envvar user machine system-wide missing broken duplicate order folders directories not recognized command not found diagnostics audit" },
    { id: "log-tail", name: "Log Tail", icon: "subject", hint: "follow the newest lines in any local log file", keywords: "log tail logs follow file live stream watch monitor grep filter search lines output text last newest realtime" },
    { id: "lock-inspector", name: "Lock Inspector", icon: "lock_open", hint: "find processes holding a file or folder", keywords: "lock locked file folder handle handles process who holds using delete remove rename move in use cannot access being used by another sharing violation access denied unlock close restart manager" },
    { id: "clipboard", name: "Clipboard History", icon: "content_paste", hint: "search, pin, restore and forget copied text", keywords: "clipboard clip clips history copied copy cut paste buffer text links urls code snippets search restore pin forget clear earlier" },
    { id: "keep-awake", name: "Keep Awake", icon: "coffee", hint: "keep Windows and the display awake for as long as you need", keywords: "keep awake stay awake sleep no sleep power display screen monitor timeout screensaver lock idle prevent caffeine caffeinate insomnia presentation meeting build download transfer render" },
    { id: "time-tracker", name: "Active Window Time Tracker", icon: "schedule", hint: "local time by application and window title", keywords: "time tracker tracking activity active window title productivity apps applications usage screen time hours focus idle away log history what did i do local private" },
  ];
  const repairTools = [
    ["audio", "Audio Subsystem Bouncer", "graphic_eq", "Restarts Windows Audio and its endpoint builder.", "Restart audio"],
    ["swap", "Sound Device Switcher", "swap_calls", "Pick the default playback or recording device for Console, Multimedia, and Communications.", "Set default"],
    ["gpu", "GPU & Display Driver Reset", "monitor", "Signals the display driver reset shortcut. The screen may blank.", "Reset display"],
    ["bounds", "Window Bounds Recalibrator", "picture_in_picture", "Finds windows outside every monitor and moves the selected one into the primary viewport.", "Inspect windows"],
    ["net", "Full Network Stack Purge", "cleaning_services", "Flushes DNS, resets Winsock and ARP, then renews DHCP.", "Purge network"],
    ["wifi", "Wi-Fi & Internet Reset", "wifi", "Asks for administrator once, then bounces the chosen connection, flushes DNS and ARP, renews the DHCP lease, and reports which resolver still answers.", "Choose connection"],
    ["radio", "Adapter & Bluetooth Power-Cycler", "wifi_tethering", "Lists network adapters and Bluetooth devices, then restarts only the selected one.", "Choose device"],
    ["usb", "USB Hub Re-enumerator", "usb", "Lists present USB devices and asks Plug and Play to restart the selected device.", "Choose USB device"],
    ["shell", "Clean Shell & Cache Purger", "desktop_windows", "Restarts Explorer and removes icon and thumbnail caches.", "Restart shell"],
    ["spooler", "Print Spooler Jam Clearer", "print", "Stops the spooler, removes queued jobs, and starts it again.", "Clear print queue"],
  ];
  /** What each repair answers to besides its name - mostly the symptom that
   *  sends you looking for it, since nobody searches for "bouncer". */
  const repairKeywords = {
    audio: "audio sound no sound silent silence speakers headphones headset mute crackling stutter distorted playback device audiosrv endpoint builder restart bounce",
    swap: "sound device switcher swap change default playback recording output input speakers headphones headset microphone mic monitor hdmi console multimedia communications",
    gpu: "gpu graphics display driver reset restart screen frozen freeze black blank flicker artefacts artifacts glitch stuck monitor nvidia amd intel recover",
    bounds: "window bounds offscreen off-screen off screen lost missing window disappeared outside monitor second screen move back recover reposition restore",
    net: "network stack purge reset flush dns winsock arp dhcp renew release ipconfig internet connection no internet cannot connect broken networking repair",
    wifi: "wifi wi-fi wireless internet connection dropout drops intermittent offline no internet dhcp dns resolver adapter reconnect reset bounce nameserver hotspot",
    radio: "adapter bluetooth radio power cycle restart disable enable nic wireless ethernet device pair pairing not connecting airplane mode",
    usb: "usb hub port device not recognized unknown device reconnect replug plug and play re-enumerate restart peripheral mouse keyboard drive dock",
    shell: "explorer shell restart taskbar desktop frozen hung not responding refresh icon cache thumbnail cache broken icons blank icons start menu",
    spooler: "print spooler printer printing queue stuck jam jammed jobs clear cancel not printing restart service",
  };
  for (const [id, name, glyph, detail] of repairTools) catalog.push({
    id: `repair-${id}`, name, icon: glyph, hint: detail,
    keywords: `repair reset restart fix broken tool tools windows ${id} ${repairKeywords[id] || ""}`, repairId: id,
  });
  let host = null;
  let active = "events";
  let timer = 0;
  let armed = "";
  let regPath = "HKCU\\Environment";
  let regRows = [];
  let regSelected = "";
  let regMode = "browse";
  let regWatch = new Map();
  let regFeed = [];
  let eventRows = [];
  let eventSelected = 0;
  let eventDetailTab = "message";
  const EVENT_TRANSFER_KEY = "devhq.windows-tools.events.popout.v1";
  let systemMode = "environment";
  let systemScope = "user";
  let systemReport = { paths: [], variables: [] };
  let systemSelected = "Path";
  const CLIPBOARD_DB = "devhq-clipboard";
  let clipboardKind = "all";
  let clipboardPinnedOnly = false;
  let clipboardSelected = "";
  let clipboardTimer = 0;
  let clipboardRows = [];
  let clipboardDb = null;
  const TRACKER_DB = "devhq-time-tracker";
  const TRACKER_ALWAYS_KEY = "devhq-time-tracker-always";
  const TRACKER_IDLE_MS = 5 * 60 * 1000;
  const TRACKER_SAMPLE_MS = 5000;
  let trackerDb = null;
  let trackerRows = [];
  let trackerTimer = 0;
  let trackerAlways = localStorage.getItem(TRACKER_ALWAYS_KEY) === "true";
  let trackerEnabled = trackerAlways;
  let trackerRange = "today";
  let trackerSelected = "";
  const trackerCanSample = !location.pathname.endsWith("/tool.html");
  let awakeActive = false;
  let awakeSystem = true;
  let awakeDisplay = true;
  let awakeAway = false;
  let awakeUntil = 0;
  let awakeDuration = 0;
  let awakeStarted = 0;
  let awakeTimer = 0;
  let awakeLog = [];
  let handoffHtml = "";
  let handoffRunning = false;

  const clipboardReady = new Promise((resolve) => {
    const request = indexedDB.open(CLIPBOARD_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("clips", { keyPath: "id" });
    request.onerror = () => resolve();
    request.onsuccess = () => {
      clipboardDb = request.result;
      const transaction = clipboardDb.transaction("clips", "readonly");
      const all = transaction.objectStore("clips").getAll();
      all.onsuccess = () => {
        clipboardRows = (all.result || []).sort((a, b) => b.time - a.time).slice(0, 250);
        if (active === "clipboard" && host) renderClipboard(catalog.find((item) => item.id === "clipboard"));
        resolve();
      };
      all.onerror = () => resolve();
    };
  });

  const trackerReady = new Promise((resolve) => {
    const request = indexedDB.open(TRACKER_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("sessions", { keyPath: "id" });
    request.onerror = () => resolve();
    request.onsuccess = () => {
      trackerDb = request.result;
      const all = trackerDb.transaction("sessions", "readonly").objectStore("sessions").getAll();
      all.onsuccess = () => { trackerRows = (all.result || []).sort((a, b) => b.end - a.end); resolve(); if (active === "time-tracker") renderTimeTracker(catalog.find((x) => x.id === active)); };
      all.onerror = () => resolve();
    };
  });
  trackerReady.then(() => { if (trackerEnabled && trackerCanSample) setTrackerEnabled(true); });
  window.addEventListener("storage", (event) => {
    if (event.key !== TRACKER_ALWAYS_KEY) return;
    trackerAlways = event.newValue === "true";
    if (trackerAlways) setTrackerEnabled(true);
    if (active === "time-tracker" && host) renderTimeTracker(catalog.find((x) => x.id === active));
  });

  function saveTrackerRow(row) {
    if (!trackerDb) return;
    try { trackerDb.transaction("sessions", "readwrite").objectStore("sessions").put(row); } catch { /* keep this session in memory */ }
  }
  function trackerCutoff() {
    const now = new Date();
    if (trackerRange === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return Date.now() - (trackerRange === "week" ? 7 : 30) * 86400000;
  }
  function trackerVisibleRows() { const cutoff = trackerCutoff(); return trackerRows.filter((row) => row.end >= cutoff); }
  function duration(ms) { const minutes = Math.floor(ms / 60000); if (minutes < 1) return "<1m"; return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`; }
  function trackerGroups() {
    const groups = new Map();
    for (const row of trackerVisibleRows()) { const key = row.process || "Unknown"; const item = groups.get(key) || { process: key, ms: 0, count: 0, title: row.title }; item.ms += row.end - row.start; item.count++; groups.set(key, item); }
    return [...groups.values()].sort((a, b) => b.ms - a.ms);
  }
  async function sampleActiveWindow() {
    if (!trackerEnabled) return;
    try {
      const shot = await invoke("active_window_snapshot");
      const now = Date.now();
      if (!shot.title || shot.idleMs >= TRACKER_IDLE_MS) { if (active === "time-tracker") updateTrackerLive(shot.idleMs); return; }
      const activeAt = now - Math.max(0, shot.idleMs || 0);
      const last = trackerRows[0];
      if (last && last.process === shot.process && last.title === shot.title && activeAt - last.end < TRACKER_SAMPLE_MS * 2.5) last.end = Math.max(last.end, activeAt);
      else trackerRows.unshift({ id: `${now}-${Math.random().toString(36).slice(2, 8)}`, start: activeAt, end: activeAt + TRACKER_SAMPLE_MS, title: shot.title, process: shot.process || "Unknown", path: shot.path || "", pid: shot.pid });
      saveTrackerRow(trackerRows[0]);
      if (active === "time-tracker") renderTimeTracker(catalog.find((x) => x.id === active));
    } catch { /* a locked desktop can temporarily have no foreground window */ }
  }
  function setTrackerEnabled(enabled) {
    trackerEnabled = enabled;
    clearInterval(trackerTimer); trackerTimer = 0;
    if (enabled && trackerCanSample) { sampleActiveWindow(); trackerTimer = setInterval(sampleActiveWindow, TRACKER_SAMPLE_MS); }
    window.dispatchEvent(new CustomEvent("devhq:time-tracker-changed", { detail: { enabled } }));
  }
  function setTrackerAlways(enabled) {
    trackerAlways = enabled === true;
    localStorage.setItem(TRACKER_ALWAYS_KEY, String(trackerAlways));
    if (trackerAlways) setTrackerEnabled(true);
    window.dispatchEvent(new CustomEvent("devhq:time-tracker-always-changed", { detail: { enabled: trackerAlways } }));
  }

  window.devhqTimeTracker = {
    getEnabled: () => trackerEnabled,
    setEnabled: (enabled) => setTrackerEnabled(enabled === true),
    getAlways: () => trackerAlways,
    setAlways: (enabled) => setTrackerAlways(enabled),
    async confirmLeave() {
      if (active !== "time-tracker" || !trackerEnabled || trackerAlways) return true;
      const answer = await window.devhqConfirm?.({
        title: "Keep tracking active-window usage?",
        message: "Tracking is running, but Always track is off. What should DevHQ do after you leave this tool?",
        cancelLabel: "Cancel",
        confirmLabel: "Stop tracking",
        alternateLabel: "Continue tracking while tool is closed",
        icon: "schedule",
      });
      if (answer === false || answer === undefined) return false;
      if (answer === "alternate") setTrackerAlways(true);
      else setTrackerEnabled(false);
      return true;
    },
  };
  function updateTrackerLive(idleMs = 0) { const node = host?.querySelector("[data-tracker-live]"); if (node) node.textContent = idleMs >= TRACKER_IDLE_MS ? `Idle for ${duration(idleMs)} · not recording` : trackerEnabled ? "Recording locally while DevHQ is open" : "Tracking is paused"; }

  function readClips() {
    return clipboardRows.filter((row) => row && (typeof row.text === "string" || typeof row.dataUrl === "string")).slice(0, 250);
  }
  function writeClips(rows) {
    clipboardRows = rows.slice(0, 250);
    if (!clipboardDb) return;
    try {
      const transaction = clipboardDb.transaction("clips", "readwrite");
      const store = transaction.objectStore("clips");
      store.clear();
      for (const row of clipboardRows) store.put(row);
    } catch { /* database unavailable; keep the session's in-memory history */ }
  }
  function clipKind(text) {
    const value = text.trim();
    if (/^https?:\/\/\S+$/i.test(value)) return "links";
    if (/\n|[{}();]|\b(const|let|fn|class|select|git|npm|cargo|pkmon)\b/i.test(value)) return "code";
    return "text";
  }
  function clipIcon(kind) { return kind === "links" ? "link" : kind === "code" ? "code" : kind === "images" ? "image" : "notes"; }
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }
  function imageDimensions(dataUrl) {
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => resolve({ width: 0, height: 0 });
      image.src = dataUrl;
    });
  }
  function dataUrlBlob(dataUrl) {
    const [head, encoded] = dataUrl.split(",", 2);
    const mime = head.match(/^data:([^;]+)/)?.[1] || "image/png";
    const bytes = Uint8Array.from(atob(encoded || ""), (char) => char.charCodeAt(0));
    return new Blob([bytes], { type: mime });
  }

  function contextActions(tool) {
    if (tool.id === "repair-audio") return `<div class="win-context-actions"><button class="btn" data-related-tool="repair-swap">${icon("swap_calls")}Sound Device Switcher</button><i></i><button class="btn" data-win-refresh>${icon("refresh")}Inspect again</button></div>`;
    if (tool.id === "repair-swap") return `<div class="win-context-actions"><button class="btn" data-related-tool="repair-audio">${icon("graphic_eq")}Audio Subsystem Bouncer</button><i></i><button class="btn" data-win-refresh>${icon("refresh")}Reload devices</button></div>`;
    if (tool.repairId) return `<div class="win-context-actions"><span>Available targets and current state</span><button class="btn" data-win-refresh>${icon("refresh")}Inspect again</button></div>`;
    return "";
  }

  function header(tool, body) {
    // Embedded tools get universal navigation chrome from the parent shell.
    // Only their body belongs in this renderer; actions such as Refresh stay
    // inside the failure boundary and can never masquerade as shell controls.
    if (window.devhqExternalToolChrome === true || window.devhqEmbeddedTool === true) {
      return `<div class="win-tool-body">${contextActions(tool)}${body}</div>`;
    }
    const pinned = window.devhqShell?.isToolPinned?.(tool.id) || false;
    const popped = window.devhqShell?.isToolPopped?.(tool.id) || false;
    return `<header class="tool-head"><button class="btn back tool-back" type="button" data-close-win title="Back to the overview">${icon("arrow_back")}Back</button><span class="tool-plate">${icon(tool.icon)}</span><span class="tool-title"><strong>${esc(tool.name)}</strong><small>${esc(tool.hint)}</small></span>${window.devhqMaturity?.badge(tool.id) ?? ""}<button class="tool-popout${popped ? " on" : ""}" data-popout-tool="${esc(tool.id)}">${icon("open_in_new")}${popped ? "Show window" : "Pop out"}</button><button class="tool-pin${pinned ? " on" : ""}" data-win-pin="${esc(tool.id)}">${icon("push_pin")}${pinned ? "Pinned" : "Pin"}</button><button class="tool-close" data-close-win title="Back to overview">${icon("close")}</button></header><div class="win-tool-body">${contextActions(tool)}${body}</div>`;
  }
  function status(message, tone = "") {
    const node = host?.querySelector("[data-win-status]");
    if (node) { node.textContent = message; node.dataset.tone = tone; }
  }
  function work(key, label, promise) {
    window.devhqWork?.beginWork(key, label);
    return promise.finally(() => window.devhqWork?.endWork(key));
  }
  function render() {
    if (!host) return;
    clearInterval(timer); timer = 0;
    if (active !== "clipboard") { clearInterval(clipboardTimer); clipboardTimer = 0; }
    const tool = catalog.find((x) => x.id === active) || catalog[0];
    if (active === "events") renderEvents(tool);
    if (active === "help") renderHelp(tool);
    if (active === "cli") renderCli(tool);
    if (active === "registry") renderRegistry(tool);
    if (active === "system") renderSystem(tool);
    if (active === "log-tail") renderLogTail(tool);
    if (active === "lock-inspector") renderLockInspector(tool);
    if (active === "clipboard") renderClipboard(tool);
    if (active === "keep-awake") renderKeepAwake(tool);
    if (active === "time-tracker") renderTimeTracker(tool);
    if (active === "repair-swap") renderAudioChooser(tool);
    else if (["repair-radio","repair-usb","repair-bounds","repair-wifi"].includes(active)) renderTargetRepair(tool);
    else if (active.startsWith("repair-")) renderRepair(tool);
  }

  const cliGroups = [
    ["Projects and Git", [
      ["devhq scan [ROOT] --pretty", "Scan a code root and return every project as JSON."],
      ["devhq git status PATH --pretty", "Inspect branch, remote, changes, commits, and stashes."],
      ["devhq git diff PATH", "Print the staged and unstaged patch."],
      ["devhq git pull PATH", "Pull without interactive prompts, then inspect again."],
      ["devhq todo scan PATH --pretty", "Find TODO and FIXME notes in project source."],
    ]],
    ["Processes and Windows", [
      ["devhq ports list --pretty", "List listening processes, sockets, and browser URLs."],
      ["devhq disk scan PATH --pretty", "Measure the direct children of a folder."],
      ["devhq system report --pretty", "Audit PATH entries and environment variables."],
      ["devhq log tail PATH [LINES]", "Read the newest lines of a local log."],
      ["devhq lock inspect PATH", "Find processes holding a file or folder."],
    ]],
    ["DNS, network, and GitHub", [
      ["devhq dns lookup NAME [SERVER] [TYPE…]", "Resolve one or more DNS record types."],
      ["devhq dns compare NAME [TYPE]", "Compare the system and public resolvers."],
      ["devhq net capability", "Inspect packet-capture support."],
      ["devhq github status", "Check GitHub CLI installation and authentication."],
      ["devhq github api METHOD ENDPOINT [JSON]", "Call an allow-listed GitHub API endpoint."],
    ]],
  ];

  const completeCliGroups = [
    ["Basics", [
      ["devhq help", "Print the complete terminal command overview."],
      ["devhq version", "Print the CLI package version."],
      ["devhq root", "Print DevHQ's detected default code root."],
      ["devhq app", "Launch the bundled DevHQ desktop application."],
    ]],
    ["Projects", [
      ["devhq scan [ROOT] --pretty", "Scan a code root; ROOT defaults to the detected code root."],
      ["devhq open PATH TARGET", "TARGET is explorer, reveal, vscode, or terminal."],
      ["devhq todo scan PATH --pretty", "Find TODO and FIXME notes in project source."],
      ["devhq todo excerpt PATH FILE LINE", "Return source around one TODO or FIXME."],
    ]],
    ["Git", [
      ["devhq git status PATH --pretty", "Inspect branch, remote, changes, commits, and stashes."],
      ["devhq git diff PATH", "Print staged and unstaged patches; --pretty returns structured JSON."],
      ["devhq git pull PATH [GROUP]", "Pull without prompts and return the refreshed project."],
    ]],
    ["Processes and disks", [
      ["devhq ports list --pretty", "List listening processes, sockets, and browser URLs."],
      ["devhq ports sample PID...", "Sample CPU and memory for one or more process IDs."],
      ["devhq ports kill PID EXE PROCESS [--tree]", "Kill only if the process identity still matches."],
      ["devhq disk drives", "List local fixed and removable drives with free space."],
      ["devhq disk scan PATH --pretty", "Measure the direct children of a folder."],
    ]],
    ["Windows diagnostics", [
      ["devhq system report --pretty", "Audit PATH entries and environment variables."],
      ["devhq system active-window", "Describe the foreground window and idle time."],
      ["devhq system keep-awake on|off [--display] [--away]", "Control this process's Windows idle request."],
      ["devhq event-log QUERY_JSON", "Query channels and levels with an optional text filter."],
      ["devhq registry list PATH", "List subkeys and values beneath a registry path."],
      ["devhq registry change CHANGE_JSON", "Create, edit, or delete a registry value."],
      ["devhq log tail PATH [LINES]", "Read the newest lines; LINES defaults to 200."],
      ["devhq lock inspect PATH", "Find processes holding a file or folder."],
    ]],
    ["Audio and repairs", [
      ["devhq audio list", "List playback and recording endpoints."],
      ["devhq audio default ID", "Set an endpoint as the Windows default for every role."],
      ["devhq repair list ID", "Inspect targets available to one repair tool."],
      ["devhq repair run ID [TARGET]", "Run a repair globally or against one selected target."],
    ]],
    ["DNS and hosts", [
      ["devhq dns lookup NAME [SERVER] [TYPE...]", "Resolve record types; omit SERVER to use the system resolver."],
      ["devhq dns compare NAME [TYPE]", "Compare resolvers; TYPE defaults to A."],
      ["devhq dns reverse ADDRESS", "Perform a PTR lookup for an IPv4 or IPv6 address."],
      ["devhq dns flush", "Flush the Windows DNS resolver cache."],
      ["devhq dns hosts", "Read the hosts file and DevHQ backups."],
      ["devhq dns hosts-write REQUEST_JSON", "Write if baseText still matches, taking a backup first."],
    ]],
    ["Packet capture", [
      ["devhq net capability", "Inspect pktmon availability and capture permissions."],
      ["devhq net components", "List filterable network components."],
      ["devhq net rate", "Read the current capture rate and totals."],
      ["devhq net backlog [LIMIT]", "Read frames from the ring; LIMIT defaults to 500."],
      ["devhq net stop", "Stop the current DevHQ packet capture."],
      ["devhq net clear", "Clear captured frames from the ring."],
      ["devhq net export [PATH]", "Export pcapng; omit PATH for the default capture folder."],
    ]],
    ["GitHub", [
      ["devhq github status", "Check GitHub CLI installation and authentication."],
      ["devhq github api METHOD ENDPOINT [JSON]", "Call an allow-listed endpoint with GET, POST, PUT, PATCH, or DELETE."],
    ]],
    ["Structured JSON arguments", [
      ["event-log QUERY_JSON", "Fields: channels[], levels[], text, limit. Click to copy an example.", "devhq event-log '{\"channels\":[\"System\"],\"levels\":[\"Error\"],\"text\":\"\",\"limit\":100}'"],
      ["registry change CHANGE_JSON", "Fields: path, name, kind, value, delete. Click to copy an example.", "devhq registry change '{\"path\":\"HKCU\\\\Environment\",\"name\":\"NAME\",\"kind\":\"REG_SZ\",\"value\":\"VALUE\",\"delete\":false}'"],
      ["dns hosts-write REQUEST_JSON", "Fields: baseText and text. Click to copy an example.", "devhq dns hosts-write '{\"baseText\":\"...\",\"text\":\"...\"}'"],
    ]],
  ];

  async function renderCli(tool) {
    const groups = completeCliGroups.map(([name, commands]) => `<section class="help-panel"><header>${icon("terminal")}<strong>${esc(name)}</strong></header>${commands.map(([command, detail, copy = command]) => `<button class="help-command" type="button" data-cli-copy="${esc(copy)}" title="Copy command"><code>${esc(command)}</code><span>${esc(detail)}</span>${icon("content_copy")}</button>`).join("")}</section>`).join("");
    host.innerHTML = header(tool, `<div class="help-page cli-help-page">
      <div class="win-status" data-win-status>Checking CLI registration…</div>
      <div class="cli-help-actions"><button class="btn primary" type="button" data-cli-toggle disabled>Checking…</button><button class="btn" type="button" data-cli-copy="devhq help">${icon("content_copy")}Copy <code>devhq help</code></button></div>
      <div class="help-columns cli-help-columns">${groups}</div>
      <section class="help-panel"><header>${icon("info")}<strong>Conventions and safety</strong></header><ul><li>Run <code>devhq help</code> for the complete command list.</li><li>Paths may be absolute, so the current terminal does not need to be inside DevHQ.</li><li>Errors go to stderr and return a non-zero exit code.</li><li>Process termination verifies PID, executable, and process name before acting.</li><li>Registry, repair, hosts-file, and process commands can change the machine; review arguments before running them.</li></ul></section>
    </div>`);
    host.querySelector("[data-win-status]")?.remove();
    await refreshCliPage();
  }

  function showCliPathSaved(result) {
    const actions = host?.querySelector(".cli-help-actions");
    if (!actions) return;
    const field = document.createElement("div");
    field.className = "win-status cli-path-saved";
    field.dataset.tone = "ok";
    field.textContent = `CLI installed and user PATH saved · ${result.path}`;
    actions.insertAdjacentElement("afterend", field);
    setTimeout(() => field.remove(), 2400);
  }

  async function refreshCliPage(given = null) {
    const button = host?.querySelector("[data-cli-toggle]");
    if (!button) return;
    try {
      const result = given || await invoke("cli_status");
      const installed = result.installed && result.onPath;
      button.dataset.installed = String(installed);
      button.textContent = installed ? "Remove CLI from PATH" : "Install CLI";
      button.classList.remove("danger");
      button.classList.toggle("primary", !installed);
      button.disabled = false;
      status(installed ? `Ready · ${result.path} · open a new terminal after PATH changes` : "Not installed · install for the current Windows user without administrator access", installed ? "ok" : "warn");
    } catch (error) {
      button.textContent = "CLI unavailable";
      button.disabled = true;
      status(String(error), "bad");
    }
  }
  /*
  function renderHelp(tool){
    const utility=(window.devhqUtilTools?.catalog?.()||[]).map((item)=>({id:item.id,name:item.name,icon:item.icon,hint:item.hint}));
    const byId=(id)=>catalog.find((item)=>item.id===id);
    const useful=[
      byId('time-tracker'),byId('clipboard'),
      {id:'disk-space',name:'Disk Space Usage',icon:'hard_drive',hint:'see what fills a drive and drill into folders'},
      {id:'path-ping',name:'Path Ping',icon:'route',hint:'find latency and packet loss at every hop'},
    ].filter(Boolean);
    const developer=[
      {id:'ports',name:'Process Explorer',icon:'lan',hint:'ports, processes, resource use, and termination'},
      {id:'dns',name:'DNS',icon:'dns',hint:'lookups and resolver comparison'},
      {id:'hosts',name:'Hosts File',icon:'edit_note',hint:'inspect and safely edit local hostname overrides'},
      {id:'network',name:'Network',icon:'network_check',hint:'inspect live traffic and the processes behind it'},
      byId('log-tail'),byId('lock-inspector'),
    ].filter(Boolean);
    const technical=catalog.filter((item)=>item.id!=='help'&&!['time-tracker','clipboard','log-tail','lock-inspector'].includes(item.id)).map((item)=>({id:item.id,name:item.name,icon:item.icon,hint:item.hint}));
    const cards=(items)=>items.map((item)=>`<button type="button" class="help-tool" data-help-tool="${esc(item.id)}" title="Open ${esc(item.name)}">${icon(item.icon)}<span><strong>${esc(item.name)}</strong><small>${esc(item.hint)}</small></span>${icon('arrow_forward')}</button>`).join('');
    host.innerHTML=header(tool,`<div class="help-page"><section class="help-lead"><span>${icon('search')}</span><div><h2>Search is how you get anywhere</h2><p>Press <kbd>Ctrl</kbd> + <kbd>K</kbd> from any screen, or type <kbd>&gt;</kbd> while you are not editing a field. Start typing a tool, project, action, technology, port, or process.</p></div></section><div class="help-columns"><section class="help-panel"><header>${icon('manage_search')}<strong>How results work</strong></header><ul><li>An empty search only shows destinations you opened recently.</li><li>Typing searches names first, then descriptions and keywords.</li><li>Use <kbd>↑</kbd>/<kbd>↓</kbd> and <kbd>Enter</kbd>, or click a row.</li><li>The pin beside a tool keeps it in the bottom status bar.</li><li><kbd>Ctrl</kbd> + <kbd>1</kbd>…<kbd>9</kbd> opens the matching pinned tool.</li><li>Type <kbd>kill</kbd> plus a process, PID, or port to find termination commands.</li></ul></section><section class="help-panel"><header>${icon('bolt')}<strong>Commands and destinations</strong></header><div class="help-command"><code>Rescan projects</code><span>Run the project scan again · F5</span></div><div class="help-command"><code>Toggle terminal panel</code><span>Show or hide docked terminals · Ctrl+`</span></div><div class="help-command"><code>Show / Remove …</code><span>Turn project filters on and off</span></div><div class="help-command"><code>Run / Terminal / Pull …</code><span>Project actions generated from scanned repositories</span></div><div class="help-command"><code>Kill …</code><span>Terminate a matching process from search</span></div><div class="help-command"><code>Overview / Settings</code><span>Navigate without permanent tabs</span></div></section></div><section class="help-tools"><header><div>${icon('handyman')}<strong>Available tools</strong></div><small>${core.length+native.length+utility.length} tools · type any name in search</small></header><h3>Core</h3><div class="help-tool-grid">${cards(core)}</div><h3>Windows and diagnostics</h3><div class="help-tool-grid">${cards(native)}</div><h3>Encode, hash, time, and formats</h3><div class="help-tool-grid">${cards(utility)}</div></section></div>`);
  }
  */
  function renderEvents(tool) {
    host.innerHTML = header(tool, `<div class="event-toolbar"><div class="event-checks"><strong>Channels</strong>${['Application','System','Security'].map((x)=>`<label><input type="checkbox" data-event-channel value="${x}"${x!=='Security'?' checked':''}>${x}</label>`).join('')}</div><div class="event-checks"><strong>Levels</strong>${['Critical','Error','Warning','Information'].map((x)=>`<label><input type="checkbox" data-event-level value="${x}"${x!=='Information'?' checked':''}>${x==='Information'?'Info':x}</label>`).join('')}</div><label class="event-filter">${icon('filter_alt')}<input data-event-text placeholder="Regex filter provider, ID, or message"></label><button class="btn" data-win-refresh>${icon('refresh')}Read latest</button><button class="btn primary" data-event-stream>${icon('play_arrow')}Start</button></div><div class="event-presets"><span>Presets</span>${[['Unhandled exceptions','Unhandled exception|System\\.\\w+Exception'],['Win32 errors','0x[0-9A-Fa-f]{8}'],['Timeouts','timed out|ECONNREFUSED|Retrying'],['Access denied','Access is denied|0x80070005'],['Port collisions',':\\d{4,5}.*(?:bind|socket)']].map(([name,value])=>`<button data-event-preset="${esc(value)}">${esc(name)}</button>`).join('')}<button data-event-clear>${icon('delete_sweep')}Clear</button></div><div class="win-status event-status" data-win-status>Subscribed to Application and System · paused</div><div class="event-workspace"><section class="event-list"><header><span>Time</span><span>Level</span><span>Provider</span><span>ID</span><span>Channel</span></header><div data-event-results><div class="win-empty">Press Start to read the newest matching events.</div></div></section><aside class="event-detail" data-event-detail>${renderEventDetail()}</aside></div>`);
  }

  function renderTimeTracker(tool) {
    const rows = trackerVisibleRows();
    const groups = trackerGroups();
    const total = rows.reduce((sum, row) => sum + row.end - row.start, 0);
    const longest = rows.reduce((best, row) => !best || row.end - row.start > best.end - best.start ? row : best, null);
    const selected = trackerSelected || groups[0]?.process || "";
    trackerSelected = selected;
    const selectedRows = rows.filter((row) => row.process === selected).sort((a, b) => b.end - a.end);
    const max = groups[0]?.ms || 1;
    const groupHtml = groups.map((group) => `<button type="button" class="tracker-app${selected === group.process ? " on" : ""}" data-tracker-app="${esc(group.process)}"><span class="tracker-dot"></span><span><strong>${esc(group.process)}</strong><small>${group.count} session${group.count === 1 ? "" : "s"}</small></span><b>${duration(group.ms)}</b><i style="--usage:${Math.max(2, group.ms / max * 100)}%"></i></button>`).join("") || '<div class="win-empty">No recorded activity in this range.</div>';
    const sessions = selectedRows.slice(0, 100).map((row) => `<div class="tracker-session"><time>${esc(new Date(row.start).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}))}–${esc(new Date(row.end).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}))}</time><b>${duration(row.end - row.start)}</b><span><strong>${esc(row.title)}</strong><small>${esc(row.process)}${row.path ? ` · ${esc(row.path)}` : ""}</small></span></div>`).join("") || '<div class="win-empty">Choose an application to see its sessions.</div>';
    host.innerHTML = header(tool, `<div class="tracker-controls"><div class="tracker-ranges">${[["today","Today"],["week","7 days"],["month","30 days"]].map(([id,label]) => `<button class="${trackerRange === id ? "on" : ""}" data-tracker-range="${id}">${label}</button>`).join("")}</div><span class="tracker-privacy">${icon("lock")}Local only · idle after 5m</span><button class="btn" data-tracker-export>${icon("download")}Export CSV</button><button class="btn ${trackerEnabled ? "tracking-on" : "primary"}" data-tracker-toggle>${icon(trackerEnabled ? "pause" : "play_arrow")}${trackerEnabled ? "Tracking" : "Start tracking"}</button></div><div class="win-status" data-tracker-live>${trackerEnabled ? "Recording locally while DevHQ is open" : "Tracking is paused"}</div><div class="tracker-stats"><section><small>Tracked</small><strong>${duration(total)}</strong><span>${rows.length} sessions</span></section><section><small>Applications</small><strong>${groups.length}</strong><span>in this range</span></section><section><small>Longest session</small><strong>${longest ? duration(longest.end - longest.start) : "—"}</strong><span>${esc(longest?.process || "No activity yet")}</span></section></div><div class="tracker-workspace"><section class="tracker-apps"><header><strong>Applications</strong><small>active time</small></header><div>${groupHtml}</div></section><section class="tracker-history"><header><div><strong>${esc(selected || "Focus sessions")}</strong><small>${selectedRows.length} session${selectedRows.length === 1 ? "" : "s"}</small></div></header><div>${sessions}</div></section></div>`);
  }

  function awakeElapsed() {
    if (!awakeStarted) return "00:00:00";
    const total = Math.max(0, Math.floor((Date.now() - awakeStarted) / 1000));
    return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map((x) => String(x).padStart(2, "0")).join(":");
  }
  function awakeRemaining() {
    if (!awakeUntil) return "Until you stop it";
    const seconds = Math.max(0, Math.ceil((awakeUntil - Date.now()) / 1000));
    if (seconds < 60) return `${seconds}s remaining`;
    const minutes = Math.ceil(seconds / 60);
    return minutes < 60 ? `${minutes}m remaining` : `${Math.floor(minutes / 60)}h ${minutes % 60}m remaining`;
  }
  function awakeFlags() {
    return [awakeSystem && "ES_SYSTEM_REQUIRED", awakeDisplay && "ES_DISPLAY_REQUIRED", awakeAway && "ES_AWAYMODE_REQUIRED"].filter(Boolean);
  }
  function renderKeepAwake(tool) {
    const flags = awakeFlags();
    const log = awakeLog.length ? awakeLog.map((row) => `<div class="awake-log-row"><time>${esc(row.time)}</time><span class="awake-log-dot ${row.tone}"></span><div><strong>${esc(row.title)}</strong><small>${esc(row.detail)}</small></div></div>`).join("") : '<div class="awake-empty">Your hold history will appear here.</div>';
    host.innerHTML = header(tool, `<div class="awake-page">
      <section class="awake-hero ${awakeActive ? "is-awake" : ""}"><div class="awake-orbit">${icon(awakeActive ? "coffee" : "bedtime")}</div><div class="awake-hero-copy"><small>${awakeActive ? "HOLDING" : "RELEASED"}</small><h2>${awakeActive ? "You’re bright-eyed and running" : "Power policy is in charge"}</h2><p>${awakeActive ? "Windows idle sleep is paused with the requirements below." : "Nothing held. Windows can dim, sleep, and lock on its usual schedule."}</p><div class="awake-clock"><strong data-awake-elapsed>${awakeElapsed()}</strong><span data-awake-remaining>${awakeActive ? awakeRemaining() : "idle"}</span></div></div><button class="btn awake-main ${awakeActive ? "release" : "primary"}" data-awake-toggle>${icon(awakeActive ? "bedtime" : "coffee")}${awakeActive ? "Let it sleep" : "Keep awake"}</button></section>
      <div class="awake-grid"><section class="awake-panel awake-flags"><header>${icon("flag")}<strong>Execution state flags</strong><small>${flags.length} selected</small></header>${[["system","memory","Keep the computer awake","Prevents idle sleep while work is running.",awakeSystem],["display","desktop_windows","Keep the display awake","Prevents the screen from dimming or turning off.",awakeDisplay],["away","cloud","Away mode","Keeps background media tasks available with the display off.",awakeAway]].map(([id,glyph,title,detail,on]) => `<button class="awake-flag ${on ? "on" : ""}" data-awake-flag="${id}" ${awakeActive ? "disabled" : ""}><span class="awake-check">${icon(on ? "check" : "")}</span>${icon(glyph)}<span><strong>${title}</strong><small>${detail}</small></span></button>`).join("")}</section>
      <section class="awake-panel awake-presets"><header>${icon("bolt")}<strong>Quick presets</strong></header>${[["Long build","system","4 h",240],["Presenting","system + display","2 h",120],["Overnight transfer","system + away mode","8 h",480],["Attached debugger","system + display","Until stopped",0]].map(([name,flagsText,time,minutes]) => `<button data-awake-preset="${minutes}" data-awake-preset-name="${name}"><span>${icon(name === "Presenting" ? "cast" : name === "Overnight transfer" ? "cloud_upload" : name === "Attached debugger" ? "bug_report" : "build")}<span><strong>${name}</strong><small>${flagsText}</small></span></span><em>${time}${icon("arrow_forward")}</em></button>`).join("")}</section>
      <section class="awake-panel awake-duration"><header>${icon("timer")}<strong>Auto-release</strong></header><div class="awake-segments">${[[0,"Until I stop it"],[30,"30 min"],[120,"2 h"],[480,"8 h"]].map(([minutes,label]) => `<button class="${awakeDuration === minutes ? "on" : ""}" data-awake-duration="${minutes}" ${awakeActive ? "disabled" : ""}>${label}</button>`).join("")}</div><p>A timed hold releases automatically—even if you leave this screen open.</p><div class="awake-call"><span>The call, as issued</span><button data-awake-copy>${icon("content_copy")}Copy</button><code>SetThreadExecutionState(ES_CONTINUOUS${flags.length ? ` | ${flags.join(" | ")}` : ""});</code></div></section>
      <section class="awake-panel awake-history"><header>${icon("history")}<strong>Hold log</strong><small>${awakeLog.length} events</small></header><div>${log}</div></section></div></div>`);
  }
  function tickKeepAwake() {
    if (!awakeActive) return;
    if (awakeUntil && Date.now() >= awakeUntil) { setKeepAwake(false, 0, "Timer expired"); return; }
    const elapsed = host?.querySelector("[data-awake-elapsed]");
    const remaining = host?.querySelector("[data-awake-remaining]");
    if (elapsed) elapsed.textContent = awakeElapsed();
    if (remaining) remaining.textContent = awakeRemaining();
  }
  async function setKeepAwake(enabled, minutes = 0, reason = "") {
    if (enabled && !awakeFlags().length) awakeSystem = true;
    try {
      await invoke("keep_awake_set", { system: enabled && awakeSystem, display: enabled && awakeDisplay, awayMode: enabled && awakeAway });
      clearInterval(awakeTimer); awakeTimer = 0;
      awakeActive = enabled;
      if (enabled) { awakeStarted = Date.now(); awakeUntil = minutes ? Date.now() + minutes * 60000 : 0; awakeTimer = setInterval(tickKeepAwake, 1000); }
      else { awakeStarted = 0; awakeUntil = 0; }
      awakeLog.unshift({ time: new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"}), tone: enabled ? "good" : reason ? "warn" : "muted", title: enabled ? "Hold acquired" : reason || "Released by hand", detail: enabled ? awakeFlags().join(" · ") : "ES_CONTINUOUS" });
      awakeLog = awakeLog.slice(0, 8);
      if (active === "keep-awake") renderKeepAwake(catalog.find((x) => x.id === active));
    } catch (error) { status(String(error), "bad"); }
  }

  function exportTrackerCsv() {
    const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const lines = [["start","end","duration_seconds","process","window_title","executable"], ...trackerVisibleRows().map((row) => [new Date(row.start).toISOString(), new Date(row.end).toISOString(), Math.round((row.end-row.start)/1000), row.process, row.title, row.path])];
    const blob = new Blob([lines.map((line) => line.map(quote).join(",")).join("\r\n")], { type: "text/csv" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `devhq-time-${new Date().toISOString().slice(0,10)}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  function renderEventDetail(){const row=eventRows[eventSelected];if(!row)return '<div class="win-empty">Select an event to inspect its message and XML.</div>';return `<header><span class="event-level ${esc((row.level||'').toLowerCase())}">${esc(row.level||'Log')}</span><div><strong>${esc(row.provider)}</strong><small>${esc(row.channel)} · Event ${esc(row.id)} · ${esc(new Date(row.time).toLocaleString())}</small></div></header><div class="event-detail-tabs"><button class="${eventDetailTab==='message'?'on':''}" data-event-detail-tab="message">Message</button><button class="${eventDetailTab==='xml'?'on':''}" data-event-detail-tab="xml">XML</button></div><pre>${esc(eventDetailTab==='xml'?(row.xml||'XML unavailable'):(row.message||'No message'))}</pre>`;}
  async function loadEvents() {
    const channels = [...host.querySelectorAll("[data-event-channel]:checked")].map((x) => x.value);
    const levels = [...host.querySelectorAll("[data-event-level]:checked")].map((x) => x.value);
    const text = host.querySelector("[data-event-text]").value.trim();
    status("Reading newest events…");
    try {
      const rows = await work("event-log", "Reading Windows Event Log", invoke("event_log_query", { query: { channels, levels, text, limit: 200 } }));
      eventRows=rows;eventSelected=Math.min(eventSelected,Math.max(0,rows.length-1));const out = host.querySelector("[data-event-results]");
      out.innerHTML = rows.length ? rows.map((row,index) => `<button class="event-row${index===eventSelected?' on':''}" data-event-row="${index}" type="button"><time>${esc(new Date(row.time).toLocaleTimeString())}</time><span class="event-level ${esc((row.level || "").toLowerCase())}">${esc(row.level || "Log")}</span><strong>${esc(row.provider)}</strong><code>${esc(row.id)}</code><small>${esc(row.channel)}</small><p>${esc((row.message||'No message').split(/\r?\n/)[0])}</p></button>`).join("") : `<div class="win-empty">No events match.</div>`;
      const detail=host.querySelector('[data-event-detail]');if(detail)detail.innerHTML=renderEventDetail();
      status(`${rows.length} matching event${rows.length === 1 ? "" : "s"}`, "ok");
    } catch (error) { status(String(error), "bad"); }
  }
  function renderHelp(tool){
    const utility=(window.devhqUtilTools?.catalog?.()||[]).map((item)=>({id:item.id,name:item.name,icon:item.icon,hint:item.hint}));
    const byId=(id)=>catalog.find((item)=>item.id===id);
    const core=[
      {id:'overview',name:'Overview',icon:'dashboard',hint:'projects, Git status, and technology at a glance'},
      {id:'git',name:'Git',icon:'commit',hint:'changes, staging, commits, branches, remotes, and history'},
      {id:'github',name:'GitHub',icon:'merge',hint:'inbox, pull requests, issues, Actions, and repositories'},
      {id:'ports',name:'Process Explorer',icon:'lan',hint:'ports, processes, resource use, and termination'},
      {id:'dns',name:'DNS',icon:'dns',hint:'lookups and resolver comparison'},
      {id:'hosts',name:'Hosts File',icon:'edit_note',hint:'inspect and safely edit local hostname overrides'},
      {id:'network',name:'Network',icon:'network_check',hint:'inspect live traffic and the processes behind it'},
    ];
    const useful=[byId('time-tracker'),byId('clipboard'),byId('keep-awake'),
      {id:'disk-space',name:'Disk Space Usage',icon:'hard_drive',hint:'see what fills a drive and drill into folders'},
      {id:'path-ping',name:'Path Ping',icon:'route',hint:'find latency and packet loss at every hop'},
    ].filter(Boolean);
    const developer=[byId('cli'),byId('log-tail'),byId('lock-inspector')].filter(Boolean);
    const used=new Set(['help',...useful.map((item)=>item.id),...developer.map((item)=>item.id)]);
    const technical=catalog.filter((item)=>!used.has(item.id)).map((item)=>({id:item.id,name:item.name,icon:item.icon,hint:item.hint}));
    const cards=(items)=>items.map((item)=>`<button type="button" class="help-tool" data-help-tool="${esc(item.id)}" title="Open ${esc(item.name)}">${icon(item.icon)}<span><strong>${esc(item.name)}</strong><small>${esc(item.hint)}</small></span>${icon('arrow_forward')}</button>`).join('');
    const rows=(items)=>items.map(([name,detail])=>`<div class="help-command"><code>${esc(name)}</code><span>${esc(detail)}</span></div>`).join('');
    const searchableCommands=rows([['<project>','Open that project'],['Run <project>','Run its detected start command; only offered when one is known'],['Terminal — <project>','Open a terminal in its folder'],['Pull <project>','Run git pull; only offered for Git projects'],['Rescan projects','Scan configured project folders again (F5)'],['Toggle terminal panel','Show or hide docked terminals (Ctrl+`)'],['Show / Remove <filter>','Turn a project filter on or off'],['Kill <process | PID | port>','Terminate a matching process']]);
    const projectActions=rows([['Run','Run the detected project command'],['Code / VS Code','Open the project folder in VS Code'],['Terminal','Open a terminal in the project folder'],['Pull','Run git pull for a Git project'],['Explorer','Open the folder in Windows Explorer'],['External shell','Open the configured shell outside DevHQ'],['Copy path','Copy the project folder path']]);
    const total=core.length+useful.length+developer.length+technical.length+utility.length;
    host.innerHTML=header(tool,`<div class="help-page"><section class="help-lead"><span>${icon('search')}</span><div><h2>Search is how you get anywhere</h2><p>Press <kbd>Ctrl</kbd> + <kbd>K</kbd> from any screen, or type <kbd>&gt;</kbd> while you are not editing a field. Search for a tool, project, action, technology, port, or process.</p></div></section><div class="help-columns"><section class="help-panel"><header>${icon('bolt')}<strong>Available commands</strong></header>${searchableCommands}</section><section class="help-panel"><header>${icon('folder_open')}<strong>Actions on an open project</strong></header>${projectActions}</section></div><section class="help-tools"><header><div>${icon('handyman')}<strong>Available tools</strong></div><small>${total} tools</small></header><h3>Core</h3><div class="help-tool-grid">${cards(core)}</div><h3>Everyday utilities</h3><div class="help-tool-grid">${cards(useful)}</div><h3>Developer tools</h3><div class="help-tool-grid">${cards(developer)}</div><h3>Technical Windows tools and repairs</h3><div class="help-tool-grid">${cards(technical)}</div><h3>Encode, hash, time, and data formats</h3><div class="help-tool-grid">${cards(utility)}</div></section></div>`);
  }
  function renderRegistry(tool) {
    host.innerHTML = header(tool, `<div class="registry-tabs"><button class="${regMode==='browse'?'on':''}" data-reg-mode="browse">${icon('account_tree')}Browse</button><button class="${regMode==='watch'?'on':''}" data-reg-mode="watch">${icon('visibility')}Change Watch</button></div><div class="registry-workspace"><aside class="registry-nav">${regMode==='browse'?`<div class="registry-nav-actions"><button class="btn" data-win-refresh>${icon('refresh')}Reload key</button></div>`:''}<h3>Hives</h3>${[['HKCR','HKEY_CLASSES_ROOT'],['HKCU','HKEY_CURRENT_USER'],['HKLM','HKEY_LOCAL_MACHINE'],['HKU','HKEY_USERS']].map(([short,long])=>`<button data-reg-jump="${short}">${icon('database')}<span><strong>${short}</strong><small>${long}</small></span></button>`).join('')}<h3>Bookmarks</h3>${[['HKCU\\Environment','User environment'],['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','Startup apps'],['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced','Explorer advanced'],['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment','Machine environment'],['HKLM\\SYSTEM\\CurrentControlSet\\Services','Services']].map(([path,name])=>`<button data-reg-jump="${esc(path)}">${icon('bookmark')}<span><strong>${esc(name)}</strong><small>${esc(path)}</small></span></button>`).join('')}</aside><section class="registry-main">${regMode==='browse'?`<div class="registry-path"><button data-reg-up title="Parent key">${icon('arrow_upward')}</button><input data-reg-path value="${esc(regPath)}" spellcheck="false"><button class="btn primary" data-reg-go>${icon('arrow_forward')}Go</button></div><div class="win-status" data-win-status>Read-only until you explicitly save or delete a value.</div><div class="registry-results" data-reg-results><div class="win-empty">Reading key…</div></div>`:`<div class="registry-watch-head"><div><strong>Watching ${esc(regPath)}</strong><small>Polling the selected key for creates, edits and deletes</small></div><button class="btn primary" data-reg-watch>${icon(timer?'pause':'play_arrow')}${timer?'Pause':'Start watch'}</button></div><div class="win-status" data-win-status>${timer?'Watching for registry changes…':'Watch is paused.'}</div><div class="registry-feed" data-reg-feed>${renderRegistryFeed()}</div>`}</section><aside class="registry-detail" data-reg-detail><div class="win-empty">Select a value to inspect and edit it.</div></aside></div>`);
    if(regMode==='browse') loadRegistry();
  }
  function renderRegistryFeed(){return regFeed.length?regFeed.map((x)=>`<div class="registry-feed-row"><time>${esc(x.time)}</time>${icon(x.op==='deleted'?'delete':x.op==='created'?'add_circle':'edit')}<strong>${esc(x.op)}</strong><span class="mono">${esc(x.name)}</span><small>${esc(x.value)}</small></div>`).join(''):'<div class="win-empty">No changes observed yet.</div>';}
  async function loadRegistry() {
    const input=host.querySelector("[data-reg-path]");const path=(input?.value||regPath).trim();regPath=path; status(`Reading ${path}…`);
    try {
      const rows = await work("registry", `Reading ${path}`, invoke("registry_list", { path }));
      regRows=rows;const keys=rows.filter((r)=>r.isKey),values=rows.filter((r)=>!r.isKey);host.querySelector("[data-reg-results]").innerHTML = rows.length ? `${keys.length?`<div class="registry-key-grid">${keys.map((r)=>`<button data-reg-key="${esc(r.name)}">${icon('folder')}<span>${esc(r.name)}</span>${icon('chevron_right')}</button>`).join('')}</div>`:''}<table class="win-table registry-values"><thead><tr><th>Name</th><th>Type</th><th>Data</th></tr></thead><tbody>${values.map((r)=>`<tr class="${regSelected===r.name?'on':''}" data-reg-value="${esc(r.name)}"><td>${icon('draft')} ${esc(r.name)}</td><td>${esc(r.kind)}</td><td class="mono">${esc(r.value)}</td></tr>`).join('')}</tbody></table>` : `<div class="win-empty">This key has no children or values.</div>`;
      renderRegistryDetail();
      status(`${rows.length} item${rows.length === 1 ? "" : "s"}`, "ok");
    } catch (error) { status(String(error), "bad"); }
  }
  function renderRegistryDetail(){const pane=host.querySelector('[data-reg-detail]');if(!pane)return;const row=regRows.find((r)=>!r.isKey&&r.name===regSelected);pane.innerHTML=row?`<header>${icon('draft')}<div><strong>${esc(row.name)}</strong><small>${esc(regPath)}</small></div></header><label>Type<select data-reg-kind>${['String','ExpandString','DWord','QWord','MultiString','Binary'].map((k)=>`<option${row.kind===k?' selected':''}>${k}</option>`).join('')}</select></label><label>Value data<textarea data-reg-data class="mono" spellcheck="false">${esc(row.value)}</textarea></label><div class="registry-detail-actions"><button class="btn primary" data-reg-save>${icon('save')}Save value</button><button class="btn${armed===`reg:${row.name}`?' danger':''}" data-reg-delete="${esc(row.name)}">${icon('delete')}${armed===`reg:${row.name}`?'Confirm delete':'Delete'}</button></div><p>Changes are written directly to Windows. Machine keys may require administrator rights.</p>`:'<div class="win-empty">Select a value to inspect and edit it.</div>';}
  async function pollRegistry(){try{const rows=await invoke('registry_list',{path:regPath});const next=new Map(rows.filter((r)=>!r.isKey).map((r)=>[r.name,`${r.kind}\0${r.value}`]));if(regWatch.size){for(const [name,value] of next){if(!regWatch.has(name))regFeed.unshift({time:new Date().toLocaleTimeString(),op:'created',name,value:value.split('\0')[1]});else if(regWatch.get(name)!==value)regFeed.unshift({time:new Date().toLocaleTimeString(),op:'changed',name,value:value.split('\0')[1]});}for(const name of regWatch.keys())if(!next.has(name))regFeed.unshift({time:new Date().toLocaleTimeString(),op:'deleted',name,value:''});regFeed=regFeed.slice(0,200);}regWatch=next;const feed=host.querySelector('[data-reg-feed]');if(feed)feed.innerHTML=renderRegistryFeed();}catch(error){status(String(error),'bad');}}
  async function changeRegistry(change) {
    const result = await work("registry-write", change.delete ? "Deleting registry value" : "Saving registry value", invoke("registry_change", { change }));
    if (!result.ok) return status(result.error || "Registry change failed.", "bad");
    armed = ""; await loadRegistry();
  }
  function renderSystem(tool) {
    const tabs=`<div class="system-tabs">${[['environment','route','Environment'],['locks','lock_person','Lock Inspector'],['logs','description','Log Tail']].map(([id,glyph,name])=>`<button class="${systemMode===id?'on':''}" data-system-mode="${id}">${icon(glyph)}${name}</button>`).join('')}</div>`;
    if(systemMode==='locks'){host.innerHTML=header(tool,`${tabs}<div class="system-subtool"><div class="win-controls"><label class="grow">File or folder<input data-lock-path spellcheck="false" placeholder="Drop or paste a path"></label><button class="btn primary" data-lock-go>${icon('search')}Inspect locks</button></div><div class="win-status" data-win-status>Restart Manager will ask Windows which processes hold this path.</div><div data-lock-results></div></div>`);return;}
    if(systemMode==='logs'){host.innerHTML=header(tool,`${tabs}<div class="system-subtool"><div class="win-controls"><label class="grow">Log file<input data-log-path spellcheck="false" placeholder="C:\\logs\\app.log"></label><label>Lines<input data-log-lines type="number" min="10" max="2000" value="300"></label><label class="grow">Filter<input data-log-filter placeholder="text or regular expression"></label><button class="btn primary" data-log-start>${icon('play_arrow')}Follow</button></div><div class="win-status" data-win-status>Choose a local text log to follow.</div><pre class="log-tail-output" data-log-output></pre></div>`);return;}
    host.innerHTML = header(tool, `${tabs}<div class="system-env" data-system-results><div class="win-empty">Reading user and machine environment…</div></div>`);
    loadSystem();
  }
  async function loadSystem() {
    status("Scanning user and machine environment…");
    try {
      const report = await work("system-report", "Auditing PATH and environment", invoke("system_report"));
      systemReport=report;renderSystemEnvironment();const bad = report.paths.filter((x) => x.status !== "ok").length;
      status(`${report.paths.length} PATH entries scanned`, bad ? "warn" : "ok");
    } catch (error) { status(String(error), "bad"); }
  }
  /* Legacy draft kept out of execution while the structured renderer below is used.
  function renderSystemEnvironment(){const root=host.querySelector('[data-system-results]');if(!root)return;const paths=systemReport.paths.filter((p)=>p.scope===systemScope),vars=systemReport.variables.filter((v)=>v.scope===systemScope),issues=paths.filter((p)=>p.status!=='ok');const selected=systemSelected==='Path'?{name:'Path',value:paths.map((p)=>p.value).join(';')}:(vars.find((v)=>v.name===systemSelected)||vars[0]);root.innerHTML=`<aside class="system-vars"><div class="system-scopes"><button class="${systemScope==='user'?'on':''}" data-system-scope="user">${icon('person')}User</button><button class="${systemScope==='machine'?'on':''}" data-system-scope="machine">${icon('computer')}Machine</button></div><button class="system-var ${systemSelected==='Path'?'on':''}" data-system-var="Path">${icon('route')}<span><strong>Path</strong><small>${paths.length} entries · ${issues.length} findings</small></span></button>${vars.map((v)=>`<button class="system-var ${systemSelected===v.name?'on':''}" data-system-var="${esc(v.name)}">${icon('data_object')}<span><strong>${esc(v.name)}</strong><small>${esc(v.value)}</small></span></button>`).join('')}<footer>${vars.length+1} variables in ${systemScope} scope</footer></aside><section class="system-path-panel"><header>${icon('route')}<strong>${systemScope==='user'?'User':'Machine'} PATH</strong><span>${paths.length} entries</span><i></i>${['missing','duplicate','unresolved'].map((kind)=>`<em class="path-${kind}">${paths.filter((p)=>p.status===kind).length} ${kind}</em>`).join('')}</header><div class="system-path-rows">${paths.map((p,index)=>`<div class="system-path-row path-${esc(p.status)}"><code>${index+1}</code>${icon(p.status==='ok'?'check_circle':p.status==='missing'?'folder_off':p.status==='duplicate'?'filter_none':'help')}<span><strong class="mono">${esc(p.value)}</strong>${p.detail?`<small>${icon('subdirectory_arrow_right')}${esc(p.detail)}</small>`:''}</span><em>${esc(p.status)}</em></div>`).join('')}</div></section><aside class="system-findings"><section><header>${icon('data_object')}<strong>${esc(selected?.name||'Variable')}</strong><small>${esc(systemScope)}</small></header><p class="mono">${esc(selected?.value||'')}</p></section><section class="findings"><header>${icon('rule')}<strong>Findings</strong><small>${issues.length}</small></header>${issues.length?issues.map((p)=>`<div>${icon(p.status==='missing'?'folder_off':p.status==='duplicate'?'filter_none':'help')}<span><strong>${esc(p.status)}</strong><small class="mono">${esc(p.value)} · ${esc(p.detail)}</small></span></div>`).join(''):'<div class="system-clean">${icon('check_circle')}No PATH findings in this scope.</div>'}</section></aside>`;}
  */
  function renderSystemEnvironment(){
    const root=host.querySelector('[data-system-results]');if(!root)return;
    const paths=systemReport.paths.filter((p)=>p.scope===systemScope);
    const vars=systemReport.variables.filter((v)=>v.scope===systemScope);
    const issues=paths.filter((p)=>p.status!=='ok');
    const selected=systemSelected==='Path'?{name:'Path',value:paths.map((p)=>p.value).join(';')}:(vars.find((v)=>v.name===systemSelected)||vars[0]||{name:'Variable',value:''});
    const varRows=vars.map((v)=>`<button class="system-var ${systemSelected===v.name?'on':''}" data-system-var="${esc(v.name)}">${icon('data_object')}<span><strong>${esc(v.name)}</strong><small>${esc(v.value)}</small></span></button>`).join('');
    const pathRows=paths.map((p,index)=>{const glyph=p.status==='ok'?'check_circle':p.status==='missing'?'folder_off':p.status==='duplicate'?'filter_none':'help';const note=p.detail?`<small>${icon('subdirectory_arrow_right')}${esc(p.detail)}</small>`:'';return `<div class="system-path-row path-${esc(p.status)}"><code>${index+1}</code>${icon(glyph)}<span><strong class="mono">${esc(p.value)}</strong>${note}</span><em>${esc(p.status)}</em></div>`;}).join('');
    const findingRows=issues.length?issues.map((p)=>{const glyph=p.status==='missing'?'folder_off':p.status==='duplicate'?'filter_none':'help';return `<div>${icon(glyph)}<span><strong>${esc(p.status)}</strong><small class="mono">${esc(p.value)} · ${esc(p.detail)}</small></span></div>`;}).join(''):`<div class="system-clean">${icon('check_circle')}No PATH findings in this scope.</div>`;
    root.innerHTML=`<aside class="system-vars"><div class="system-vars-actions"><button class="btn" data-win-refresh>${icon('refresh')}Scan again</button></div><div class="system-scopes"><button class="${systemScope==='user'?'on':''}" data-system-scope="user">${icon('person')}User</button><button class="${systemScope==='machine'?'on':''}" data-system-scope="machine">${icon('computer')}Machine</button></div><button class="system-var ${systemSelected==='Path'?'on':''}" data-system-var="Path">${icon('route')}<span><strong>Path</strong><small>${paths.length} entries · ${issues.length} findings</small></span></button>${varRows}<footer>${vars.length+1} variables in ${systemScope} scope</footer></aside><section class="system-path-panel"><header>${icon('route')}<strong>${systemScope==='user'?'User':'Machine'} PATH</strong><span>${paths.length} entries</span><i></i></header><div class="system-path-rows">${pathRows}</div></section><aside class="system-findings"><section><header>${icon('data_object')}<strong>${esc(selected.name)}</strong><small>${esc(systemScope)}</small></header><p class="mono">${esc(selected.value)}</p></section><section class="findings"><header>${icon('rule')}<strong>Findings</strong><small>${issues.length}</small></header>${findingRows}</section></aside>`;
  }
  function renderRepair(tool) {
    const row = repairTools.find((item) => `repair-${item[0]}` === active);
    if (!row) return;
    const [id, , glyph, detail, action] = row;
    const related = "";
    host.innerHTML = header(tool, `<div class="repair-intro"><span>${icon(glyph)}</span><div><p>${esc(detail)}</p></div><code>${esc(id==='audio'?'Restart-Service':id==='gpu'?'D3DKMT / keybd_event':id==='net'?'4 ordered steps':id==='shell'?'Explorer + caches':'Spooler + queue')}</code></div><div class="win-status" data-win-status>Inspecting current state…</div><div class="repair-designed" data-repair-state><div class="win-empty">Reading services and devices…</div></div><footer class="repair-action-bar"><span>${id==='gpu'?'The screen may blank for about a second.':id==='net'?'Winsock reset may require a reboot.':id==='shell'?'The taskbar and Explorer windows briefly close.':id==='spooler'?'Every queued print job will be removed.':'Dependent audio services briefly stop.'}</span><button class="btn${armed === id ? " danger" : " primary"}" data-repair="${id}">${icon(armed === id ? "warning" : "play_arrow")}${esc(armed === id ? "Click again to confirm" : action)}</button></footer>`,related);
    loadRepairOverview(id);
  }
  async function loadRepairOverview(id){try{const rows=await invoke('repair_targets',{id});const target=host.querySelector('[data-repair-state]');if(!target)return;target.innerHTML=rows.length?rows.map((row,index)=>`<div class="repair-state-row"><code>${id==='net'?index+1:''}</code>${icon(id==='net'?'check_circle':id==='shell'&&row.id!=='explorer'?'database':id==='spooler'&&row.id!=='service'?'description':id==='gpu'?'monitor':'settings_applications')}<span><strong>${esc(row.name)}</strong><small class="mono">${esc(row.detail)}</small></span><em class="state-pill">${esc(row.status)}</em></div>`).join(''):'<div class="win-empty">No matching services or devices were found.</div>';status(`${rows.length} item${rows.length===1?'':'s'} inspected`,'ok');}catch(error){status(String(error),'bad');}}
  function renderAudioChooser(tool) {
    const related = "";
    host.innerHTML=header(tool,`<div class="win-status" data-win-status>Reading active playback and recording endpoints…</div><div class="audio-groups" data-audio-groups><div class="win-empty">Reading Windows Core Audio…</div></div>`,related);
    loadAudioDevices();
  }
  async function loadAudioDevices(){
    try{const rows=await work("audio-devices","Reading audio devices",invoke("audio_devices"));const groups=[['playback','Playback','volume_up'],['recording','Recording','mic']];
      host.querySelector("[data-audio-groups]").innerHTML=groups.map(([flow,label,glyph])=>`<section class="audio-group"><header>${icon(glyph)}<strong>${label}</strong><small>Console · Multimedia · Communications</small></header>${rows.filter((r)=>r.flow===flow).map((r)=>`<div class="audio-device-row${r.isDefault?' on':''}${r.muted?' muted':''}"><button class="audio-device" data-audio-device="${esc(r.id)}"><span>${icon(r.isDefault?'check_circle':'radio_button_unchecked')}<strong>${esc(r.name)}</strong></span><small>${r.isDefault?'Default for all roles':'Set as default for all roles'}</small></button><div class="audio-device-controls"><label class="audio-volume"><span>${icon(r.muted?'volume_off':'volume_up')}<output>${r.volume}%</output></span><input type="range" min="0" max="100" value="${r.volume}" data-audio-volume="${esc(r.id)}" aria-label="Volume for ${esc(r.name)}" ${r.muted?'disabled':''}></label><button class="btn" data-audio-muted="${esc(r.id)}" data-muted="${r.muted}">${icon(r.muted?'volume_up':'volume_off')} ${r.muted?'Unmute':'Mute'}</button><button class="btn" data-audio-test="${esc(r.id)}" data-audio-flow="${flow}">${icon(flow==='playback'?'play_arrow':'mic')} ${flow==='playback'?'Play test':'Test mic'}</button></div></div>`).join('')||'<div class="win-empty">No active devices.</div>'}</section>`).join('');status(`${rows.length} active audio device${rows.length===1?'':'s'}`,"ok");
    }catch(error){status(String(error),"bad");}}
  async function setAudioDevice(id){status("Setting Console, Multimedia, and Communications roles…");const result=await work("audio-default","Changing the default audio device",invoke("audio_set_default",{id}));if(!result.ok)return status(result.error||"Could not change the endpoint.","bad");await loadAudioDevices();status(result.output||"Default endpoint changed.","ok");}
  async function setAudioVolume(id,volume){const result=await work("audio-volume","Changing device volume",invoke("audio_set_volume",{id,volume}));if(!result.ok){await loadAudioDevices();return status(result.error||"Could not change the volume.","bad");}status(result.output||`Volume changed to ${volume}%.`,"ok");}
  async function setAudioMuted(id,muted,button){button.disabled=true;button.classList.add('spinning');button.setAttribute('aria-busy','true');button.innerHTML=`${icon('progress_activity')} ${muted?'Muting…':'Unmuting…'}`;try{const result=await work("audio-muted",muted?'Muting device':'Unmuting device',invoke("audio_set_muted",{id,muted}));await loadAudioDevices();status(result.ok?(result.output||(muted?'Device muted.':'Device unmuted.')):(result.error||"Could not change mute state."),result.ok?'ok':'bad');}catch(error){status(String(error),'bad');}finally{if(button.isConnected){button.disabled=false;button.classList.remove('spinning');button.removeAttribute('aria-busy');button.innerHTML=`${icon(muted?'volume_off':'volume_up')} ${muted?'Mute':'Unmute'}`;}}}
  async function testAudioDevice(id,flow,button){const playback=flow==='playback';button.disabled=true;button.classList.add('spinning');button.setAttribute('aria-busy','true');button.innerHTML=`${icon('progress_activity')} ${playback?'Playing…':'Testing…'}`;status(playback?'Playing a test sound…':'Listening to the microphone for 1.5 seconds…');try{const result=await work("audio-test",playback?'Playing test sound':'Testing microphone',invoke("audio_test",{id,flow}));if(!result.ok)return status(result.error||"Could not test the device.","bad");if(playback)await loadAudioDevices();status(result.output||"Device test completed.","ok");}catch(error){status(String(error),'bad');}finally{if(button.isConnected){button.disabled=false;button.classList.remove('spinning');button.removeAttribute('aria-busy');button.innerHTML=`${icon(playback?'play_arrow':'mic')} ${playback?'Play test':'Test mic'}`;}}}
  function renderTargetRepair(tool){host.innerHTML=header(tool,`<div class="win-status" data-win-status>Inspecting this machine…</div><div class="target-list" data-target-list><div class="win-empty">Reading available targets…</div></div>`);loadRepairTargets();}
  async function loadRepairTargets(){const id=active.replace("repair-","");try{const rows=await work(`repair-targets-${id}`,"Reading repair targets",invoke("repair_targets",{id}));host.querySelector("[data-target-list]").innerHTML=rows.length?rows.map((r)=>`<button class="target-row${armed===r.id?' armed':''}" data-target-id="${esc(r.id)}"><span>${icon(armed===r.id?'warning':'radio_button_unchecked')}<strong>${esc(r.name)}</strong><small>${esc(r.detail)}</small></span><em>${esc(armed===r.id?'Click again to confirm':r.status)}</em></button>`).join(''):`<div class="win-empty">${id==='bounds'?'Every visible window is already on-screen.':id==='wifi'?'No physical network adapters were found on this machine.':'No matching active devices were found.'}</div>`;status(`${rows.length} target${rows.length===1?'':'s'} found`,rows.length?'ok':'');}catch(error){status(String(error),'bad');}}
  async function runTargetRepair(target){const id=active.replace('repair-','');if(armed!==target){armed=target;await loadRepairTargets();return status('Review the selected item, then click it again to confirm.','warn');}const result=await work(`repair-target-${id}`,id==='wifi'?'Resetting the connection':`Running ${id} repair`,invoke('repair_target_run',{id,target}));armed='';if(!result.ok)return status(result.error||'Repair failed.','bad');await loadRepairTargets();status(result.output||'Completed.','ok');}
  async function runRepair(id) {
    if (armed !== id) { armed = id; renderRepair(catalog.find((x) => x.id === active)); status("Review the impact, then click the same action again.", "warn"); return; }
    status("Running repair…");
    const result = await work(`repair-${id}`, `Running ${repairTools.find((x) => x[0] === id)?.[1] || "repair"}`, invoke("repair_run", { id }));
    armed = ""; renderRepair(catalog.find((x) => x.id === active));
    status(result.ok ? (result.output || "Repair completed.") : (result.error || "Repair failed."), result.ok ? "ok" : "bad");
  }
  function renderLogTail(tool) {
    host.innerHTML = header(tool, `<div class="win-controls"><label class="grow">Log file<input data-log-path spellcheck="false" placeholder="C:\\logs\\app.log"></label><label>Lines<input data-log-lines type="number" min="10" max="2000" value="300"></label><label class="grow">Filter<input data-log-filter placeholder="text or regular expression"></label><button class="btn primary" data-log-start>${icon("play_arrow")} Start</button></div><div class="win-status" data-win-status>Choose a local text log to follow.</div><pre class="log-tail-output" data-log-output></pre>`);
  }
  async function loadLogTail() {
    const path=host.querySelector("[data-log-path]").value.trim(); if(!path)return status("Enter a log file path.","warn");
    const lines=Number(host.querySelector("[data-log-lines]").value)||300; const filter=host.querySelector("[data-log-filter]").value;
    try { const result=await work("log-tail",`Reading ${path}`,invoke("log_tail",{path,lines})); let rows=result.lines;
      if(filter){try{const re=new RegExp(filter,"i");rows=rows.filter((line)=>re.test(line));}catch{rows=rows.filter((line)=>line.toLowerCase().includes(filter.toLowerCase()));}}
      host.querySelector("[data-log-output]").textContent=rows.join("\n"); host.querySelector("[data-log-output]").scrollTop=host.querySelector("[data-log-output]").scrollHeight;
      status(`${rows.length} lines shown · ${(result.size/1024).toFixed(1)} KB`,"ok");
    } catch(error){status(String(error),"bad");}
  }
  function renderLockInspector(tool) {
    host.innerHTML=header(tool,`<div class="win-controls"><label class="grow">File or folder<input data-lock-path spellcheck="false" placeholder="C:\\code\\project\\target"></label><button class="btn primary" data-lock-go>${icon("search")} Inspect</button></div><div class="win-status" data-win-status>Restart Manager will ask Windows which processes hold this path.</div><div data-lock-results></div>`);
  }
  function renderClipboard(tool) {
    const rows = readClips();
    if (!clipboardSelected && rows[0]) clipboardSelected = rows[0].id;
    const visible = rows.filter((row) => (clipboardKind === "all" || row.kind === clipboardKind) && (!clipboardPinnedOnly || row.pinned));
    const selected = rows.find((row) => row.id === clipboardSelected) || visible[0] || null;
    if (selected) clipboardSelected = selected.id;
    const count = (kind) => rows.filter((row) => kind === "all" || row.kind === kind).length;
    const kinds = [["all","All","select_all"],["text","Text","notes"],["links","Links","link"],["code","Code","code"],["images","Images","image"]];
    host.innerHTML = header(tool, `<div class="clipboard-toolbar"><button class="btn primary" data-clip-capture>${icon("content_paste")}Capture current clipboard</button><span>Text copied while DevHQ is open can be added here. Pinned entries are kept until you forget them.</span></div><div class="clipboard-workspace">
      <aside class="clipboard-kinds"><h3>Kinds</h3>${kinds.map(([id,label,glyph])=>`<button class="${clipboardKind===id?'on':''}" data-clip-kind="${id}">${icon(glyph)}<strong>${label}</strong><small>${count(id)}</small></button>`).join("")}</aside>
      <section class="clipboard-list"><header><strong>${clipboardKind === 'all' ? 'All clips' : clipboardKind}</strong><button class="${clipboardPinnedOnly?'on':''}" data-clip-pinned>${icon("push_pin")}Pinned only</button><small>${visible.length} of ${rows.length} entries</small></header><div>${visible.length ? visible.map((row)=>`<button class="clipboard-row${row.id===clipboardSelected?' on':''}" data-clip-row="${esc(row.id)}">${row.kind === 'images' ? `<img src="${esc(row.dataUrl)}" alt="">` : icon(clipIcon(row.kind))}<span><strong>${row.kind === 'images' ? `${esc(row.width || '?')} × ${esc(row.height || '?')} ${esc(row.mime || 'image')}` : esc(row.text.replace(/\s+/g,' ').slice(0,160))}</strong><small>${esc(new Date(row.time).toLocaleString())} · ${row.kind === 'images' ? `${Math.round((row.size || 0) / 1024)} KB` : `${row.text.length} characters`}</small></span>${row.pinned?icon('push_pin'):''}</button>`).join('') : `<div class="win-empty">${rows.length ? 'No clips match this view.' : 'Capture the current clipboard to start a private local history.'}</div>`}</div></section>
      <aside class="clipboard-detail">${selected ? `<header>${icon(clipIcon(selected.kind))}<strong>Entry</strong><small>${esc(selected.kind)}</small></header>${selected.kind === 'images' ? `<div class="clipboard-image-preview"><img src="${esc(selected.dataUrl)}" alt="Clipboard image"></div>` : `<pre>${esc(selected.text)}</pre>`}<dl><dt>Captured</dt><dd>${esc(new Date(selected.time).toLocaleString())}</dd><dt>Size</dt><dd>${selected.kind === 'images' ? `${esc(selected.width)} × ${esc(selected.height)} · ${Math.round((selected.size || 0) / 1024)} KB` : `${selected.text.length} characters`}</dd><dt>Format</dt><dd>${esc(selected.mime || 'text/plain')}</dd><dt>Store</dt><dd>local · up to 250 entries</dd></dl><footer><button class="btn primary" data-clip-copy>${icon('content_copy')}Copy back</button><button class="btn" data-clip-pin>${icon('push_pin')}${selected.pinned?'Unpin':'Pin'}</button><button class="btn danger" data-clip-forget>${icon('delete')}Forget</button></footer>` : '<div class="win-empty">Select an entry to inspect it.</div>'}</aside>
    </div>`);
    if (!clipboardTimer) clipboardTimer = setInterval(() => captureClipboard(true), 1200);
  }
  async function captureClipboard(silent = false) {
    try {
      const rows = readClips();
      if (navigator.clipboard.read) {
        let items = [];
        try { items = await navigator.clipboard.read(); } catch { /* text fallback below */ }
        const imageType = items.flatMap((item) => item.types).find((type) => type.startsWith("image/"));
        if (imageType) {
          const item = items.find((entry) => entry.types.includes(imageType));
          const blob = await item.getType(imageType);
          if (blob.size > 25 * 1024 * 1024) return silent ? undefined : status("That image is larger than the 25 MB clipboard-history limit.", "warn");
          const dataUrl = await blobToDataUrl(blob);
          if (rows[0]?.dataUrl === dataUrl) return;
          const dimensions = await imageDimensions(dataUrl);
          const row = { id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`, kind: "images", dataUrl, mime: blob.type || imageType, size: blob.size, ...dimensions, time: Date.now(), pinned: false };
          writeClips([row, ...rows]);
          clipboardSelected = row.id;
          renderClipboard(catalog.find((entry) => entry.id === "clipboard"));
          return;
        }
      }
      const text = await navigator.clipboard.readText();
      if (!text) return silent ? undefined : status("The clipboard has no supported text or image to capture.", "warn");
      if (rows[0]?.text === text) return;
      const duplicate = rows.find((row) => row.text === text);
      const row = duplicate || { id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`, text, kind: clipKind(text), time: Date.now(), pinned: false };
      row.time = Date.now();
      writeClips([row, ...rows.filter((item) => item.id !== row.id)]);
      clipboardSelected = row.id;
      renderClipboard(catalog.find((item) => item.id === "clipboard"));
      if (!silent) status("Clipboard entry captured.", "ok");
    } catch { if (!silent) status("Windows did not allow DevHQ to read the clipboard. Try pasting into the tool.", "bad"); }
  }
  function updateSelectedClip(action) {
    const rows = readClips();
    const row = rows.find((item) => item.id === clipboardSelected);
    if (!row) return;
    if (action === "pin") row.pinned = !row.pinned;
    else if (action === "forget") rows.splice(rows.indexOf(row), 1);
    writeClips(rows);
    if (action === "forget") clipboardSelected = rows[0]?.id || "";
    renderClipboard(catalog.find((item) => item.id === "clipboard"));
  }
  async function inspectLocks(){const path=host.querySelector("[data-lock-path]").value.trim();if(!path)return status("Enter a file or folder path.","warn");status("Asking Restart Manager…");
    try{const rows=await work("lock-inspect",`Inspecting locks on ${path}`,invoke("lock_inspect",{path}));host.querySelector("[data-lock-results]").innerHTML=rows.length?`<table class="win-table"><thead><tr><th>Process</th><th>PID</th><th>Service</th><th>Restartable</th></tr></thead><tbody>${rows.map((r)=>`<tr><td>${esc(r.name||"Unknown")}</td><td class="mono">${esc(r.pid)}</td><td>${esc(r.service||"—")}</td><td>${r.restartable?"yes":"no"}</td></tr>`).join("")}</tbody></table>`:`<div class="win-empty">Windows reports no process holding this path.</div>`;status(`${rows.length} locking process${rows.length===1?"":"es"}`,rows.length?"warn":"ok");}catch(error){status(String(error),"bad");}}
  function click(event) {
    const helpTool=event.target.closest('[data-help-tool]');if(helpTool){window.devhqShell?.openTool(helpTool.dataset.helpTool);return;}
    const cliCopy=event.target.closest('[data-cli-copy]');if(cliCopy){window.devhqCopy.copy(cliCopy.dataset.cliCopy,cliCopy).catch(()=>{});return;}
    const cliToggle=event.target.closest('[data-cli-toggle]');if(cliToggle){const installed=cliToggle.dataset.installed==='true';cliToggle.disabled=true;cliToggle.textContent=installed?'Removing…':'Installing…';invoke(installed?'cli_uninstall':'cli_install').then((result)=>{refreshCliPage(result);if(!installed)showCliPathSaved(result);}).catch(()=>{cliToggle.disabled=false;cliToggle.textContent=installed?'Remove CLI from PATH':'Install CLI';});return;}
    if (event.target.closest("[data-close-win]")) return window.devhqShell?.openTool("overview");
    const pop = event.target.closest("[data-popout-tool]");
    if (pop) return window.devhqShell?.popOutTool?.(pop.dataset.popoutTool);
    const pin = event.target.closest("[data-win-pin]");
    if (pin) { window.devhqShell?.toggleToolPin(pin.dataset.winPin); return render(); }
    const related=event.target.closest("[data-related-tool]");if(related){window.devhqShell?.openTool(related.dataset.relatedTool);return;}
    if (event.target.closest("[data-win-refresh]")) return active === "events" ? loadEvents() : active === "registry" ? (regMode === "watch" ? pollRegistry() : loadRegistry()) : active === "system" ? (systemMode === "environment" ? loadSystem() : systemMode === "locks" ? inspectLocks() : loadLogTail()) : active === "log-tail" ? loadLogTail() : active === "lock-inspector" ? inspectLocks() : render();
    if (event.target.closest("[data-tracker-toggle]")) { setTrackerEnabled(!trackerEnabled); return renderTimeTracker(catalog.find((x) => x.id === "time-tracker")); }
    if (event.target.closest("[data-awake-toggle]")) return setKeepAwake(!awakeActive, awakeDuration);
    const awakeFlag=event.target.closest("[data-awake-flag]");if(awakeFlag&&!awakeActive){const id=awakeFlag.dataset.awakeFlag;if(id==="system"){awakeSystem=!awakeSystem;if(!awakeSystem)awakeAway=false;}if(id==="display")awakeDisplay=!awakeDisplay;if(id==="away"){awakeAway=!awakeAway;if(awakeAway)awakeSystem=true;}return renderKeepAwake(catalog.find((x)=>x.id===active));}
    const awakeDurationButton=event.target.closest("[data-awake-duration]");if(awakeDurationButton&&!awakeActive){awakeDuration=Number(awakeDurationButton.dataset.awakeDuration);return renderKeepAwake(catalog.find((x)=>x.id===active));}
    const awakePreset=event.target.closest("[data-awake-preset]");if(awakePreset){const name=awakePreset.dataset.awakePresetName;awakeSystem=true;awakeDisplay=name==="Presenting"||name==="Attached debugger";awakeAway=name==="Overnight transfer";return setKeepAwake(true,Number(awakePreset.dataset.awakePreset));}
    const awakeCopy=event.target.closest("[data-awake-copy]");if(awakeCopy){const call=host.querySelector(".awake-call code")?.textContent||"";return window.devhqCopy.copy(call,awakeCopy).catch(()=>{});}
    if (event.target.closest("[data-tracker-export]")) return exportTrackerCsv();
    const trackerRangeButton=event.target.closest("[data-tracker-range]");if(trackerRangeButton){trackerRange=trackerRangeButton.dataset.trackerRange;trackerSelected="";return renderTimeTracker(catalog.find((x)=>x.id==="time-tracker"));}
    const trackerApp=event.target.closest("[data-tracker-app]");if(trackerApp){trackerSelected=trackerApp.dataset.trackerApp;return renderTimeTracker(catalog.find((x)=>x.id==="time-tracker"));}
    if(event.target.closest('[data-clip-capture]'))return captureClipboard();
    const clipKindButton=event.target.closest('[data-clip-kind]');if(clipKindButton){clipboardKind=clipKindButton.dataset.clipKind;return renderClipboard(catalog.find((item)=>item.id==='clipboard'));}
    if(event.target.closest('[data-clip-pinned]')){clipboardPinnedOnly=!clipboardPinnedOnly;return renderClipboard(catalog.find((item)=>item.id==='clipboard'));}
    const clipRow=event.target.closest('[data-clip-row]');if(clipRow){clipboardSelected=clipRow.dataset.clipRow;return renderClipboard(catalog.find((item)=>item.id==='clipboard'));}
    const clipCopy=event.target.closest('[data-clip-copy]');if(clipCopy){const row=readClips().find((item)=>item.id===clipboardSelected);if(!row)return;if(row.kind==='images'){const blob=dataUrlBlob(row.dataUrl);navigator.clipboard.write([new ClipboardItem({[blob.type]:blob})]).then(()=>window.devhqCopy.feedback(clipCopy,true)).catch(()=>window.devhqCopy.feedback(clipCopy,false));}else window.devhqCopy.copy(row.text,clipCopy).catch(()=>{});return;}
    if(event.target.closest('[data-clip-pin]'))return updateSelectedClip('pin');
    if(event.target.closest('[data-clip-forget]'))return updateSelectedClip('forget');
    if (event.target.closest("[data-event-stream]")) { const button=event.target.closest("[data-event-stream]"); if(timer){clearInterval(timer);timer=0;button.innerHTML=`${icon("play_arrow")} Start`;status("Stream paused.");}else{loadEvents();timer=setInterval(loadEvents,3000);button.innerHTML=`${icon("pause")} Pause`;} return; }
    const preset=event.target.closest('[data-event-preset]');if(preset){host.querySelector('[data-event-text]').value=preset.dataset.eventPreset;return loadEvents();}
    if(event.target.closest('[data-event-clear]')){eventRows=[];eventSelected=0;host.querySelector('[data-event-results]').innerHTML='<div class="win-empty">The captured events were cleared.</div>';host.querySelector('[data-event-detail]').innerHTML=renderEventDetail();return status('Captured events cleared.');}
    const eventRow=event.target.closest('[data-event-row]');if(eventRow){eventSelected=Number(eventRow.dataset.eventRow);for(const row of host.querySelectorAll('[data-event-row]'))row.classList.toggle('on',row===eventRow);host.querySelector('[data-event-detail]').innerHTML=renderEventDetail();return;}
    const detailTab=event.target.closest('[data-event-detail-tab]');if(detailTab){eventDetailTab=detailTab.dataset.eventDetailTab;host.querySelector('[data-event-detail]').innerHTML=renderEventDetail();return;}
    if (event.target.closest("[data-reg-go]")) return loadRegistry();
    const mode=event.target.closest('[data-reg-mode]');if(mode){clearInterval(timer);timer=0;regMode=mode.dataset.regMode;return renderRegistry(catalog.find((x)=>x.id==='registry'));}
    const jump=event.target.closest('[data-reg-jump]');if(jump){regPath=jump.dataset.regJump;regMode='browse';return renderRegistry(catalog.find((x)=>x.id==='registry'));}
    if(event.target.closest('[data-reg-up]')){const cut=regPath.lastIndexOf('\\');if(cut>0)regPath=regPath.slice(0,cut);return renderRegistry(catalog.find((x)=>x.id==='registry'));}
    const valueRow=event.target.closest('[data-reg-value]');if(valueRow){regSelected=valueRow.dataset.regValue;for(const row of host.querySelectorAll('[data-reg-value]'))row.classList.toggle('on',row===valueRow);return renderRegistryDetail();}
    if(event.target.closest('[data-reg-save]')){const row=regRows.find((r)=>r.name===regSelected);if(!row)return;return changeRegistry({path:regPath,name:row.name,kind:host.querySelector('[data-reg-kind]').value,value:host.querySelector('[data-reg-data]').value,delete:false});}
    if(event.target.closest('[data-reg-watch]')){const button=event.target.closest('[data-reg-watch]');if(timer){clearInterval(timer);timer=0;button.innerHTML=`${icon('play_arrow')}Start watch`;return status('Watch paused.');}regWatch.clear();pollRegistry();timer=setInterval(pollRegistry,2000);button.innerHTML=`${icon('pause')}Pause`;return status(`Watching ${regPath}…`,'ok');}
    if(event.target.closest("[data-log-start]")){const button=event.target.closest("[data-log-start]");if(timer){clearInterval(timer);timer=0;button.innerHTML=`${icon("play_arrow")} Start`;return status("Tail paused.");}loadLogTail();timer=setInterval(loadLogTail,1500);button.innerHTML=`${icon("pause")} Pause`;return;}
    if(event.target.closest("[data-lock-go]"))return inspectLocks();
    const systemTab=event.target.closest('[data-system-mode]');if(systemTab){clearInterval(timer);timer=0;systemMode=systemTab.dataset.systemMode;return renderSystem(catalog.find((x)=>x.id==='system'));}
    const scopeButton=event.target.closest('[data-system-scope]');if(scopeButton){systemScope=scopeButton.dataset.systemScope;systemSelected='Path';return renderSystemEnvironment();}
    const variable=event.target.closest('[data-system-var]');if(variable){systemSelected=variable.dataset.systemVar;return renderSystemEnvironment();}
    const key=event.target.closest("[data-reg-key]"); if(key){regPath += `\\${key.dataset.regKey}`;regSelected='';return renderRegistry(catalog.find((x)=>x.id==='registry')); }
    const del=event.target.closest("[data-reg-delete]"); if(del){const key=`reg:${del.dataset.regDelete}`;if(armed!==key){armed=key;renderRegistryDetail();status(`Click delete again to confirm ${del.dataset.regDelete}.`,"warn");return;}return changeRegistry({path:regPath,name:del.dataset.regDelete,kind:"REG_SZ",value:"",delete:true});}
    const repair=event.target.closest("[data-repair]"); if(repair)return runRepair(repair.dataset.repair);
    const audioMuted=event.target.closest("[data-audio-muted]");if(audioMuted)return setAudioMuted(audioMuted.dataset.audioMuted,audioMuted.dataset.muted!=='true',audioMuted);
    const audioTest=event.target.closest("[data-audio-test]");if(audioTest)return testAudioDevice(audioTest.dataset.audioTest,audioTest.dataset.audioFlow,audioTest);
    const audio=event.target.closest("[data-audio-device]");if(audio)return setAudioDevice(audio.dataset.audioDevice);
    const target=event.target.closest("[data-target-id]");if(target)return runTargetRepair(target.dataset.targetId);
  }

  function preparePopout(id) {
    if (id !== "events" || active !== "events" || !host) return;
    const transfer = {
      channels: [...host.querySelectorAll("[data-event-channel]:checked")].map((x) => x.value),
      levels: [...host.querySelectorAll("[data-event-level]:checked")].map((x) => x.value),
      text: host.querySelector("[data-event-text]")?.value || "",
      rows: eventRows,
      selected: eventSelected,
      detailTab: eventDetailTab,
      streaming: Boolean(timer),
    };
    try {
      localStorage.setItem(EVENT_TRANSFER_KEY, JSON.stringify(transfer));
    } catch (_) {
      // Event XML can be unusually large. Preserve the live subscription and
      // filters even when the captured row payload exceeds the storage quota.
      try { localStorage.setItem(EVENT_TRANSFER_KEY, JSON.stringify({ ...transfer, rows: [] })); } catch (_) { /* open with defaults */ }
    }
    clearInterval(timer);
    timer = 0;
  }

  function restoreEventPopout() {
    let transfer = null;
    try {
      transfer = JSON.parse(localStorage.getItem(EVENT_TRANSFER_KEY) || "null");
      if (transfer) localStorage.removeItem(EVENT_TRANSFER_KEY);
    } catch (_) { /* malformed or unavailable handoff */ }
    if (!transfer) return;
    for (const input of host.querySelectorAll("[data-event-channel]")) input.checked = transfer.channels?.includes(input.value) === true;
    for (const input of host.querySelectorAll("[data-event-level]")) input.checked = transfer.levels?.includes(input.value) === true;
    const text = host.querySelector("[data-event-text]");
    if (text) text.value = transfer.text || "";
    eventRows = Array.isArray(transfer.rows) ? transfer.rows : [];
    eventSelected = Math.min(Number(transfer.selected) || 0, Math.max(0, eventRows.length - 1));
    eventDetailTab = transfer.detailTab === "xml" ? "xml" : "message";
    const out = host.querySelector("[data-event-results]");
    if (out && eventRows.length) out.innerHTML = eventRows.map((row,index) => `<button class="event-row${index===eventSelected?' on':''}" data-event-row="${index}" type="button"><time>${esc(new Date(row.time).toLocaleTimeString())}</time><span class="event-level ${esc((row.level || "").toLowerCase())}">${esc(row.level || "Log")}</span><strong>${esc(row.provider)}</strong><code>${esc(row.id)}</code><small>${esc(row.channel)}</small><p>${esc((row.message||'No message').split(/\r?\n/)[0])}</p></button>`).join("");
    const detail = host.querySelector("[data-event-detail]");
    if (detail) detail.innerHTML = renderEventDetail();
    if (transfer.streaming) {
      const button = host.querySelector("[data-event-stream]");
      if (button) button.innerHTML = `${icon("pause")} Pause`;
      timer = setInterval(loadEvents, 3000);
    }
  }
  function exportState(id) {
    return { active:id||active, html:active===(id||active)?host?.innerHTML||"":"", running:Boolean(timer), armed,
      regPath,regRows,regSelected,regMode,regWatch:[...regWatch],regFeed,eventRows,eventSelected,eventDetailTab,
      systemMode,systemScope,systemReport,systemSelected,clipboardKind,clipboardPinnedOnly,clipboardSelected,
      trackerRows,trackerEnabled,trackerRange,trackerSelected,awakeActive,awakeSystem,awakeDisplay,awakeAway,
      awakeUntil,awakeDuration,awakeStarted,awakeLog };
  }
  function importState(state) {
    if(!state)return;
    clearInterval(timer);timer=0;clearInterval(awakeTimer);awakeTimer=0;
    ({armed,regPath,regRows,regSelected,regMode,regFeed,eventRows,eventSelected,eventDetailTab,
      systemMode,systemScope,systemReport,systemSelected,clipboardKind,clipboardPinnedOnly,clipboardSelected,
      trackerRows,trackerEnabled,trackerRange,trackerSelected,awakeActive,awakeSystem,awakeDisplay,awakeAway,
      awakeUntil,awakeDuration,awakeStarted,awakeLog}=state);
    regWatch=new Map(state.regWatch||[]);handoffHtml=state.html||"";handoffRunning=state.running===true;
  }
  function resumeHandoff(id){
    if(handoffHtml){host.innerHTML=handoffHtml;handoffHtml="";}
    if(handoffRunning&&!timer){
      const tick=id==="events"?loadEvents:id==="registry"?pollRegistry:id==="log-tail"?loadLogTail:null;
      if(tick)timer=setInterval(tick,id==="events"?3000:id==="registry"?2000:1500);
    }
    handoffRunning=false;
    if(id==="keep-awake"&&awakeActive&&!awakeTimer)awakeTimer=setInterval(tickKeepAwake,1000);
  }
  window.devhqWindowsTools = {
    catalog: () => catalog.map((x) => ({ ...x })),
    mount(node) { host = node; host.onclick = click; host.oninput = (event) => { const slider=event.target.closest("[data-audio-volume]");if(slider)slider.closest(".audio-volume")?.querySelector("output")?.replaceChildren(`${slider.value}%`); }; host.onchange = (event) => { const slider=event.target.closest("[data-audio-volume]");if(slider)setAudioVolume(slider.dataset.audioVolume,Number(slider.value)); }; host.onkeydown = (e) => { if (e.key !== "Enter") return; if(e.target.matches("[data-event-text]"))loadEvents();else if(e.target.matches("[data-reg-path]"))loadRegistry();else if(e.target.matches("[data-log-path],[data-log-filter]"))loadLogTail();else if(e.target.matches("[data-lock-path]"))inspectLocks(); }; render(); },
    open(id) { if (!catalog.some((x) => x.id === id)) return; active = id; render(); if (id === "events") restoreEventPopout(); resumeHandoff(id); },
    opened() { if (active === "events" && timer) loadEvents(); },
    active: () => active,
    preparePopout,
    exportState,
    importState,
  };
})();
