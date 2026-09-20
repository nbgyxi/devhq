// Security Sweep: an installed coding agent audits this PC.
//
// WinT does no auditing of its own. Every check, trace and fix is work the
// agent does in its own shell; this file only chooses what to ask for, sends
// it as one turn of a single agent session, and reports what comes back:
//
// - Activity (left) is every command the agent ran, read from the CLI's own
//   stream, with the reason and result the agent gives for it.
// - Findings (right) is what the agent's closing JSON block says it found.
//   Tracing an origin, applying a fix and going deeper are all further turns
//   in the same session, so nothing the agent learned is lost.
//
// A turn runs in print mode, where nobody can answer the CLI's own prompts. The
// closing JSON block is therefore the agent's only way to ask anything.
//
// Rights are chosen once, before the first scan. Changing them later would
// restart the agent and lose its context.

(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;
  const listen = window.__TAURI__.event.listen;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name) => window.wintShell?.icon?.(name) || `<span class="ms" aria-hidden="true">${name}</span>`;
  const PREFS_KEY = "wint.security-audit.v2";

  /* ------------------------------------------------------------ the menu */

  const AREAS = [
    { id: "Autostart", chip: "Autostart", glyph: "restart_alt", admin: false, name: "Autostart and persistence",
      what: "Run keys, startup folders, scheduled tasks outside \\Microsoft\\, auto-start services, Winlogon and IFEO debuggers — each target resolved and its signature checked." },
    { id: "Startup", chip: "Startup", glyph: "rocket_launch", admin: false, name: "Why these start",
      what: "WinT's own list of what starts with Windows and what sits in the tray, handed to the agent to explain one by one: what each program is, why it starts, whether it is needed, and what stopping it would cost. The ones WinT cannot account for — a tray icon with no startup entry — are chased down to the service, task or parent that starts them." },
    { id: "Running processes", chip: "Processes", glyph: "memory", admin: false, name: "Running processes",
      what: "What is running, from where, whether it is signed, and which ports and connections it holds." },
    { id: "Browser extensions", chip: "Extensions", glyph: "extension", admin: false, name: "Browser extensions",
      what: "Extensions in every Chrome, Edge and Firefox profile, their permissions, and whether they came from a store." },
    { id: "Installed software", chip: "Software", glyph: "inventory", admin: false, name: "Installed software",
      what: "Uninstall entries with version, publisher and install date — recent unknown installs and software past its support." },
    { id: "Remote access", chip: "Remote", glyph: "lock_person", admin: false, name: "Remote access",
      what: "RDP, WinRM, SSH and other listeners, the firewall profiles that expose them, and who may sign in." },
    { id: "Defender", chip: "Defender", glyph: "security", admin: false, name: "Defender and threat history",
      what: "Real-time protection, definition age, exclusions, and past detections with what was done about them." },
    { id: "WMI", chip: "WMI", glyph: "manage_history", admin: true, name: "WMI subscriptions and Security log",
      what: "Permanent WMI event consumers and the Security log — both hidden from a standard user." },
    { id: "Event logs", chip: "Events", glyph: "receipt_long", admin: false, name: "Event log health",
      what: "Warnings, errors and critical events in the System and Application logs from the last 7 days — grouped, the ones every Windows PC logs set apart as normal, and the real problems explained with a fix." },
    { id: "Stalls", chip: "Stalls", glyph: "mouse", admin: false, name: "Diagnose stalls",
      what: "The freezes Input Stall Watch caught — driver time, busy cores, paging and the processes around each — traced to the driver, device, power setting or program behind them. Stalls caught while the audit is open are passed on as they arrive." },
  ];
  const SEV = {
    high: { word: "High", glyph: "gpp_bad", order: 0 },
    medium: { word: "Medium", glyph: "warning", order: 1 },
    low: { word: "Low", glyph: "info", order: 2 },
  };
  const TAGS = { Scan: "scan", Trace: "trace", Agent: "agent", Fix: "fix" };

  const saved = (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch { return {}; } })();

  const st = {
    agents: null,
    agent: saved.agent || "",
    elevated: saved.elevated === true,
    scope: Array.isArray(saved.scope) && saved.scope.length ? saved.scope.slice(0, 1) : [AREAS[0].id],
    expected: new Set(Array.isArray(saved.expected) ? saved.expected : []),

    /** setup | audit */
    view: "setup",
    starting: false,
    error: "",
    stamp: "",
    dir: "",
    computer: "",
    ranAsAdmin: false,
    session: null,
    scannedAt: 0,
    scanSeconds: 0,

    findings: [],
    passed: [],
    traces: {},
    threads: {},
    log: [],
    reply: null,

    /** The turn in flight, or null. */
    turn: null,

    area: "all",
    logFilter: "all",
    sel: "",
    open: new Set(),
    showPassed: false,
    hidden: new Set(),
    notice: "",

    /** Which saved run is on screen, and whether it is live: started in this
     *  window, with an agent session that still holds its context. A run
     *  opened from history is not live until someone continues it. */
    runId: "",
    live: false,
    startedAt: 0,
    updatedAt: 0,
    fresh: false,
    history: [],
    historyLoaded: false,
    draft: "",

    /** What Input Stall Watch has caught, for the stall scan. `stallMark` is
     *  the newest stall id the agent has been told about in this run. */
    stallWatch: null,
    stallMark: 0,

    /** WinT's own startup and tray lists, for the "Why these start" area. */
    startup: null,
  };

  const savePrefs = () => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ agent: st.agent, elevated: st.elevated, scope: st.scope, expected: [...st.expected] }));
    } catch {}
  };
  /* ------------------------------------------------------------ history */

  // Every run is kept on disk in its own audit folder - run.json in full and a
  // small summary.json for the list - so the docked tool and a popped-out
  // window, which have separate browser storage, see the same history. A
  // run's id is its folder.

  function snapshot() {
    return {
      startedAt: st.startedAt, updatedAt: Date.now(), agent: st.agent, ranAsAdmin: st.ranAsAdmin,
      scope: st.scope, computer: st.computer, scannedAt: st.scannedAt, scanSeconds: st.scanSeconds, continuedFrom: st.continuedFrom || 0,
      findings: st.findings, passed: st.passed, traces: Object.fromEntries(Object.entries(st.traces).filter(([, t]) => !t.busy)),
      threads: st.threads, log: st.log, reply: st.reply ? { ...st.reply, retry: undefined, raw: undefined } : null,
      stallMark: st.stallMark,
    };
  }

  async function saveRun() {
    if (!st.runId || !st.live) return;
    try {
      const run = snapshot();
      st.updatedAt = run.updatedAt;
      const open = st.findings.filter((f) => !f.fixed);
      const summary = {
        startedAt: run.startedAt, updatedAt: run.updatedAt, agent: run.agent, ranAsAdmin: run.ranAsAdmin, scope: run.scope,
        computer: run.computer, continuedFrom: run.continuedFrom, commands: st.log.filter((x) => x.kind !== "note").length,
        high: open.filter((f) => f.severity === "high").length,
        medium: open.filter((f) => f.severity === "medium").length,
        low: open.filter((f) => f.severity === "low").length,
      };
      await invoke("audit_save", { dir: st.runId, name: "run.json", text: JSON.stringify(run) });
      await invoke("audit_save", { dir: st.runId, name: "summary.json", text: JSON.stringify(summary) });
      await loadHistory();
    } catch (err) {
      st.notice = `This audit could not be saved to history: ${err}`;
      dirty();
    }
  }

  let historyLoading = false;
  async function loadHistory() {
    historyLoading = true;
    try {
      const runs = await invoke("audit_history");
      st.history = runs.map((r) => ({ ...r, id: r.dir, scope: Array.isArray(r.scope) ? r.scope : [] }))
        .sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0));
    } catch {
      st.history = [];
    }
    st.historyLoaded = true;
    historyLoading = false;
    dirty();
  }

  // The live run, parked while a past one is on screen, so going back to it
  // keeps its agent session and everything it has learned.
  let parked = null;
  const LIVE_FIELDS = ["runId", "dir", "live", "fresh", "startedAt", "updatedAt", "continuedFrom", "agent", "ranAsAdmin", "scope", "computer",
    "scannedAt", "scanSeconds", "findings", "passed", "traces", "threads", "log", "reply", "session", "sel", "area", "logFilter", "open", "hidden", "stallMark"];

  async function openRun(id) {
    if (st.turn) return;
    if (id === st.runId) { st.view = "audit"; return dirty(); }
    if (st.live) parked = Object.fromEntries(LIVE_FIELDS.map((k) => [k, st[k]]));
    if (parked?.runId === id) {
      Object.assign(st, parked, { view: "audit", notice: "" });
      parked = null;
      return dirty();
    }
    let run;
    try {
      run = JSON.parse(await invoke("audit_load", { dir: id }));
    } catch (err) {
      st.notice = String(err);
      return dirty();
    }
    Object.assign(st, {
      runId: id, dir: id, live: false, fresh: false, startedAt: run.startedAt, updatedAt: run.updatedAt, continuedFrom: run.continuedFrom || 0,
      agent: st.agents?.some((x) => x.id === run.agent && x.installed) ? run.agent : st.agent,
      ranAsAdmin: run.ranAsAdmin === true, scope: run.scope || st.scope, computer: run.computer || "",
      scannedAt: run.scannedAt || 0, scanSeconds: run.scanSeconds || 0, findings: run.findings || [], passed: run.passed || [],
      traces: run.traces || {}, threads: run.threads || {}, log: run.log || [], reply: run.reply || null, stallMark: run.stallMark || 0,
      session: null, view: "audit", sel: "", area: "all", logFilter: "all", open: new Set(), hidden: new Set(), notice: "",
    });
    dirty();
  }

  async function deleteRun(id) {
    try {
      await invoke("audit_delete", { dir: id });
    } catch (err) {
      st.notice = String(err);
    }
    if (id === st.runId && !st.live) Object.assign(st, { runId: "", findings: [], log: [], passed: [], traces: {}, threads: {}, reply: null });
    loadHistory();
  }

  function age(ms) {
    const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (minutes < 60) return minutes <= 1 ? "a minute" : `${minutes} minutes`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return hours === 1 ? "an hour" : `${hours} hours`;
    const days = Math.round(hours / 24);
    return `${days} days`;
  }

  /** Asks before anything is sent from a run that is not live. Continuing it
   *  means a new agent with none of the old one's context. */
  async function confirmContinue() {
    const old = age(st.startedAt);
    const message = `This audit is from history. Continuing it starts a new ${agentName()} session, and that agent does not have the context of the one that ran it: it only gets the findings WinT kept, so it may have lost details and may need to redo work, which can cost more. This audit is ${old} old, so what it shows may no longer be current.`;
    const answer = window.wintConfirm
      ? await window.wintConfirm({ title: "Start a new agent for this old audit?", message, confirmLabel: "Start a new agent", cancelLabel: "Cancel", icon: "history", tone: "accent" })
      : window.confirm(message);
    return answer === true;
  }

  /** Makes a history run live: a fresh audit folder and a fresh agent session
   *  with the same rights, as a new entry so the old run stays as it was. */
  async function continueRun() {
    work(st.ranAsAdmin ? "Security Sweep · waiting for the administrator prompt" : "Security Sweep · starting a new agent");
    try {
      const begun = await invoke("audit_begin", { elevated: st.ranAsAdmin, stamp: stampNow() });
      const from = st.startedAt;
      Object.assign(st, {
        dir: begun.dir, ranAsAdmin: begun.elevated, computer: begun.computer || st.computer,
        runId: (parked = null, begun.dir), live: true, fresh: true, continuedFrom: from, startedAt: Date.now(),
        session: st.agent === "claude" ? crypto.randomUUID() : null,
      });
      return true;
    } catch (err) {
      st.notice = String(err);
      return false;
    } finally {
      work(null);
      dirty();
    }
  }

  /** What a new agent is told about a run it did not do. */
  function handover() {
    const brief = {
      findings: st.findings.map((f) => ({ id: f.id, severity: f.severity, area: f.area, title: f.title, where: f.where, fixed: !!f.fixed, verdict: f.verdict, evidence: f.evidence, fix: f.fix })),
      passed: st.passed,
      traces: Object.fromEntries(Object.entries(st.traces).map(([id, t]) => [id, { headline: t.headline, conclusion: t.conclusion }])),
      lastSummary: st.reply?.summary || "",
    };
    return `You are continuing a security sweep of this Windows PC for WinT's Security Sweep tool. A previous agent session ran it ${age(st.continuedFrom || st.startedAt)} ago; you do not have its context, only what it reported, below. Things may have changed since: re-check anything before relying on it, and always before changing something. ${st.ranAsAdmin ? "Your shell runs as Administrator." : "Your shell runs WITHOUT administrator rights."}

Previous findings (JSON):
${JSON.stringify(brief)}

${RULES}

`;
  }

  const agentName = () => st.agents?.find((a) => a.id === st.agent)?.label || "The agent";
  const areaOf = (id) => AREAS.find((a) => a.id === id);
  const findingById = (id) => st.findings.find((f) => f.id === id);
  const expectedKey = (f) => `${f.area}|${f.where || f.title}`;

  let root = null;
  let ticker = 0;
  let queued = false;

  /** Redraws are batched to a frame, spaced out while a turn streams (an agent
   *  can print dozens of lines a second), and held entirely while a mouse
   *  button is down - replacing a button under the pointer swallows the click,
   *  which is what made the tool look frozen during an investigation. */
  let holding = false;
  let holdTimer = 0;
  let held = false;
  let lastDraw = 0;
  function dirty() {
    if (holding) { held = true; return; }
    if (queued) return;
    queued = true;
    const wait = st.turn ? Math.max(0, 300 - (Date.now() - lastDraw)) : 0;
    const go = () => requestAnimationFrame(() => {
      queued = false;
      if (holding) { held = true; return; }
      lastDraw = Date.now();
      draw();
    });
    if (wait) setTimeout(go, wait); else go();
  }

  const elapsed = (started) => {
    const secs = Math.floor((Date.now() - started) / 1000);
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  };

  function work(label) {
    if (label) window.wintWork?.beginWork("security-audit", label);
    else window.wintWork?.endWork("security-audit");
  }

  /* ------------------------------------------------------------ prompts */

  const FORMAT = `WinT cannot see your CLI's own prompts or question tools and nobody can answer them. Everything the user sees comes from the one block below. End EVERY turn with exactly one fenced \`\`\`json block and nothing after it:
{
 "summary": "1-2 short sentences: what you did this turn",
 "activity": [{"command": "the command as you ran it (first line is enough)", "why": "one line: why you ran it", "result": "a few words: what it showed", "finding": "id of the finding it produced or supports, or empty"}],
 "findings": [{"id": "stable-kebab-id", "severity": "high|medium|low", "area": "one of: ${AREAS.map((a) => a.id).join(", ")}", "title": "short", "why": "one sentence", "where": "path, key, task or PID", "age": "e.g. 4 days old, running 2h, since 2019", "isNew": true, "verdict": "2 sentences: what this is and how worried to be", "evidence": [{"label": "Runs|Target|Signature|File created|Downloaded from|...", "value": "..."}], "fix": {"label": "short", "detail": "one sentence", "commands": [{"step": "Back up|Change|Verify", "cmd": "exact PowerShell"}], "undo": "how to undo, or that it cannot be undone"}, "asks": ["2-3 short things you could look into next for this finding"]}],
 "resolved": ["ids of findings that are fixed or turned out to be nothing"],
 "passed": [{"name": "a check that found nothing wrong", "detail": "a few words"}],
 "trace": null,
 "question": "one short question for the user, or empty",
 "options": [{"label": "2-6 words", "detail": "one sentence: exactly what you will do", "changesSystem": false}],
 "done": false
}
Rules for the block: list every command you ran this turn in "activity". Findings are merged by id, so repeat a finding only when something about it changed, and keep its id stable. Only report real concerns as findings (high = act now, medium = worth a look, low = tidy-up); everything checked and fine goes in "passed". Give every finding a fix when one exists. "trace" is only filled when you were asked to trace an origin: {"finding": "id", "headline": "one sentence", "timeline": [{"time": "", "label": "", "detail": "", "how": "which source proves it"}], "conclusion": "", "confidence": ""}. Set "done": true when you have nothing more to do unprompted.`;

  const RULES = `Rules:
- Use your shell to run PowerShell (powershell.exe -NoProfile -Command ...). Keep output small: select only the properties you need.
- Never change anything unless this turn's instruction says the user approved that exact change. Before a change, save what is needed to undo it into %ProgramData%\\WinT-Quarantine (export the key, the task XML, the start type); move files there rather than deleting them. Verify the change afterwards.
- Do not call something suspicious just because it is unfamiliar. Signed software from a known vendor in Program Files is normal. Real red flags: unsigned or invalid signatures, executables in user-writable folders, random-looking names, script hosts and LOLBins (powershell -enc, mshta, wscript, rundll32/regsvr32 with odd arguments), missing targets, names imitating Windows components, recent creation dates.`;

  /* ------------------------------------------------------------ stalls */

  // The stall scan works from what Input Stall Watch recorded. The backend
  // keeps ninety seconds of context per stall; the agent gets only the seconds
  // that overlap it, which is what the watch's own diagnosis was made from.

  async function loadStalls() {
    try { st.stallWatch = await invoke("stall_watch_status"); } catch { st.stallWatch = { watching: false, stalls: [] }; }
    dirty();
    return st.stallWatch;
  }

  const startupInScope = () => st.scope.includes("Startup");

  /** What starts with Windows and what is in the tray, from WinT's own reader
   *  — the same lists the Startup and tray tool shows. The agent is handed
   *  these rather than being asked to go and find them: they are already
   *  measured, and what is worth an agent's time is the part WinT cannot
   *  answer, which is why each one is there. */
  async function loadStartup() {
    try {
      const [entries, icons] = await Promise.all([
        invoke("startup_entries"),
        invoke("startup_tray_icons"),
      ]);
      st.startup = { entries, icons };
    } catch {
      st.startup = { entries: [], icons: [] };
    }
    dirty();
    return st.startup;
  }

  const stallsInScope = () => st.scope.includes("Stalls");

  function stallDigest(stalls) {
    return stalls.slice(0, 40).map((s) => ({
      id: s.id, at: new Date(s.at).toISOString(), ms: s.durationMs, kind: s.kind, cause: s.cause, verdict: s.verdict, evidence: s.evidence,
      seconds: (s.context || []).filter((c) => c.at >= s.at - 1000 && c.at - 1000 <= s.at + s.durationMs + 1100).map((c) => ({
        busy: Math.round(c.busy), driver: +(c.dpc + c.interrupt).toFixed(1), worstCore: c.worstCore, worstCoreDriver: Math.round(c.worstCoreDriver),
        hardFaults: c.hardFaults, memory: c.memoryLoad,
        top: (c.top || []).slice(0, 4).map((p) => `${p.name}#${p.pid} ${p.cpu.toFixed(0)}%${p.hardFaults ? ` ${p.hardFaults}pf` : ""}`),
      })),
    }));
  }

  /** Diagnosed stalls the agent has not been told about yet, newest first. */
  async function newStalls() {
    const status = await loadStalls();
    const fresh = (status.stalls || []).filter((s) => s.id > st.stallMark && s.verdict);
    if (fresh.length) st.stallMark = Math.max(st.stallMark, ...fresh.map((s) => s.id));
    return fresh;
  }

  const STALL_TASK = `Diagnose the input stalls below. WinT's Input Stall Watch caught them: a time-critical thread wakes every 4 ms. A "system" stall is one where it woke far too late, so something above normal scheduling held the CPU. A "pointer" stall is the cursor freezing mid-movement and then jumping while the system kept running. "manual" is the user pressing "it just happened". Each stall carries the watch's own first guess (cause, verdict) and the one-second samples that overlap it: busy %, DPC+interrupt % over all cores, the worst core and its DPC+interrupt %, hard page faults per second, memory load, and the busiest processes (name#pid cpu% and page faults).

Find what is actually behind them. Look for the pattern across stalls first: same cause, same core, same process, time of day, a regular interval. Then go after the culprit with read-only checks, for example: GPU, network/Wi-Fi, audio, storage, USB and chipset drivers with their dates and versions (Get-CimInstance Win32_PnPSignedDriver); System log warnings and errors near the stall times (Get-WinEvent with a time window), especially WHEA, disk, storport, display driver, Kernel-Power and Kernel-Processor-Power; the power plan, USB selective suspend and PCIe link state power management (powercfg); power management on USB hubs and HID devices; programs with global input hooks, overlays, RGB or monitoring tools among the busy processes; and paging pressure. If only a kernel trace would settle it, say so and give the exact command (for example wpr -start CPU -start DPC_ISR), but do not start one unless asked.

Report each distinct cause as a finding in area "Stalls", with the ids of the stalls it explains in its evidence under the label "Stalls". Its fix is the change most likely to stop them (driver update or rollback, a power setting, a device setting, removing a hook), with backup and undo. Say which stalls remain unexplained, if any.`;

  const STARTUP_TASK = `Account for everything that starts on this PC. The list below is WinT's own reading, so do not go and rediscover it: every Run value in HKCU and HKLM, everything in both Startup folders, and every program Windows has a notification-area icon recorded for, each already matched to the startup entry that starts it where one does.\n\nYour job is the part that list cannot answer.\n\n1. Say what each one actually is, in a sentence a non-expert understands: the product, who publishes it, and what it does while it sits there. Check the signature and publisher of each exe (Get-AuthenticodeSignature) and say when something is unsigned, signed by someone other than the product's vendor, or living somewhere a program of that name should not (a user temp folder, a random AppData subfolder).\n2. Explain why it starts. For an entry in the list, that is the entry. For anything with \"origin\": \"No startup entry\" — running, with a tray icon, and nothing in Startup that accounts for it — find what really starts it: an auto-start service (Get-CimInstance Win32_Service, StartMode Auto), a scheduled task with a logon or boot trigger (Get-ScheduledTask, look outside \\Microsoft\\ first), a packaged app's StartupTask (Get-StartApps / the Appx manifest), a parent process that spawns it (a launcher, an updater, a vendor 'host' or 'agent' service), a shell extension, or a browser auto-launch. Name the exact mechanism and where it lives. If you genuinely cannot tell, say so plainly rather than guessing.\n3. Judge it. Put in \"passed\" the ones that earn their place — the ones the user obviously chose (a chat app, a VPN, a backup client) and the ones Windows itself needs — with one line each saying what it is and why it is fine. Report as findings the ones worth acting on: an updater or 'helper' that could run on demand instead, a vendor bloat agent, duplicates of the same product started twice, something the user almost certainly never installed on purpose, and anything the signature check made suspicious (severity high for those).\n4. For each finding, the fix is how to stop it starting, and it must be reversible and never delete anything. Prefer, in order: WinT's own switch, which is the flag Task Manager writes — reg add \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run\" /v \"<value name>\" /t REG_BINARY /d 03000000000000000000000000 /f (use StartupFolder for a Startup folder shortcut, Run32 for a 32-bit HKLM entry); Disable-ScheduledTask for a task; Set-Service -StartupType Manual for a service, which leaves it able to start when something asks for it. Say in the finding what the user loses by stopping it — no auto-update, no cloud sync, the tray icon gone — so the choice is an informed one. Back up the current value first and give the undo.\n\nReport findings in area \"Startup\". Put the programs in the list you are happy with in \"passed\", so the user ends with every single one accounted for.`;

  function startupBlock() {
    const data = st.startup || { entries: [], icons: [] };
    // Trimmed to what the agent reasons about: the shape of the row, not the
    // shape of WinT's structs.
    const entries = (data.entries || []).map((entry) => ({
      name: entry.name,
      product: entry.description || undefined,
      command: entry.command,
      exe: entry.exe || undefined,
      startsFrom: entry.source,
      allUsers: entry.machineWide || undefined,
      switchedOff: entry.enabled ? undefined : true,
      runningNow: entry.running || undefined,
      hasTrayIcon: entry.tray || undefined,
    }));
    const icons = (data.icons || [])
      .filter((item) => item.running)
      .map((item) => ({
        name: item.name,
        exe: item.exe,
        tooltip: item.tooltip || undefined,
        origin: item.startupId ? item.origin : "No startup entry",
      }));
    const unexplained = icons.filter((item) => item.origin === "No startup entry").length;
    return `What starts with Windows, as WinT reads it. JSON:
${JSON.stringify(entries)}

In the notification area right now. JSON:
${JSON.stringify(icons)}

${unexplained
  ? `${unexplained} of those tray icons have no startup entry behind them. Those are the ones to chase: find what starts each one.`
  : "Every tray icon has a startup entry behind it."}`;
  }

  function stallsBlock(stalls, later) {
    const status = st.stallWatch || {};
    const n = stalls.length;
    if (!n) {
      return later ? "" : `Input Stall Watch has caught no stalls yet (it is ${status.watching ? "watching" : "not watching"}). Say so, check the usual causes anyway, and tell the user to ${status.watching ? "keep using the PC until a stall is caught" : "start Input Stall Watch"} and ask again.`;
    }
    const head = later
      ? `Input Stall Watch caught ${n} more stall${n === 1 ? "" : "s"} since your last turn. Take ${n === 1 ? "it" : "them"} into account: add ${n === 1 ? "its id" : "their ids"} to the Stalls finding that explains ${n === 1 ? "it" : "them"}, or report a new finding if the cause is different. JSON:`
      : `Caught stalls, newest first${(status.stalls || []).length > 40 ? " (the newest 40)" : ""}; the watch is ${status.watching ? "still running" : "off"}. JSON:`;
    return `${head}\n${JSON.stringify(stallDigest(stalls))}`;
  }

  const EVENT_TASK = `How to sweep the event logs: read Critical, Error and Warning events (levels 1-3) from the last 7 days at least, e.g. Get-WinEvent -FilterHashtable @{LogName='System','Application'; Level=1,2,3; StartTime=(Get-Date).AddDays(-7)}, plus Microsoft-Windows-Windows Defender/Operational and, with administrator, the Security log's failed sign-ins (4625) and audit-log clears (1102). Group by log, provider and event id with count, first and last seen, and one sample message. Do not print every event.
Judge each group. Many are normal on every Windows PC and need nothing: DistributedCOM 10016, a Service Control Manager 7000/7009/7031 for a service that started later, Kernel-Power 41 after a known power cut, ESENT, Perflib, VSS, Time-Service sync warnings, an app that crashed once. Put each normal group in "passed" with its count and one line saying why it is harmless. Report as findings what points at a real problem: disk, NTFS or storport errors, WHEA hardware errors, repeated bugchecks (BugCheck 1001) or unexpected shutdowns, the same app or service crashing again and again, failed Windows Update or driver installs, Defender detections or disabled protection, many failed sign-ins, a cleared audit log. Each finding carries the event ids and counts in its evidence, the likely cause, and a fix with backup and undo where it changes anything.`;

  function scanPrompt() {
    const events = st.scope.includes("Event logs") ? `\n${EVENT_TASK}\n` : "";
    const stalls =stallsInScope() ? `\n${STALL_TASK}\n\n${stallsBlock(st.stallWatch?.stalls || [], false)}\n` : "";
    const startup = startupInScope() ? `\n${STARTUP_TASK}\n\n${startupBlock()}\n` : "";
    const rights = st.ranAsAdmin
      ? "Your shell runs as Administrator."
      : "Your shell runs WITHOUT administrator rights. When a check needs admin, list it under passed with detail \"skipped — needs administrator\" and move on; do not try to elevate.";
    const areas = st.scope.map((id) => `- ${areaOf(id).name}: ${areaOf(id).what}`).join("\n");
    const expected = [...st.expected];
    return `You are the engine of WinT's Security Sweep tool, auditing this Windows PC (${st.computer || "this computer"}) for its owner. WinT does no checking of its own: it shows the user the commands you run and the JSON block you end each turn with, and sends you what the user asks for next. ${rights}

Scan these areas now, and only these:
${areas}
${events}${stalls}${startup}${expected.length ? `\nThe user has marked these as expected; do not report them again:\n${expected.map((k) => `- ${k}`).join("\n")}\n` : ""}
${RULES}

${FORMAT}`;
  }

  function findingContext(f) {
    return `Finding "${f.id}" (${f.severity}, ${f.area}): ${f.title} — ${f.where}`;
  }

  const followPrompt = (instruction) => `${instruction}

Same rules as before. ${FORMAT}`;

  const tracePrompt = (f) => followPrompt(`Trace where ${findingContext(f)} came from. Reconstruct what happened in the minutes around the moment it appeared: what was downloaded (browser history, Zone.Identifier streams), what ran (Prefetch), what wrote the file (file and registry timestamps in a ±5 minute window), task and service registration (TaskScheduler, System and Security logs), installer records and Defender history, and what else appeared at the same time. Read-only: change nothing. Fill "trace" for this finding, and update any findings that turn out to share its origin.`);

  const fixPrompt = (f) => followPrompt(`The user approved the recommended fix for ${findingContext(f)}: "${f.fix?.label}". Run exactly these steps, in order, stopping if a Back up step fails:
${(f.fix?.commands || []).map((c) => `[${c.step}] ${c.cmd}`).join("\n")}
Then verify it worked. Put the finding in "resolved" if it did, or update it with what went wrong.`);

  const askPrompt = (f, ask) => followPrompt(`About ${findingContext(f)}: ${ask}`);

  /* ------------------------------------------------------------ turns */

  let wired = false;
  async function wire() {
    if (wired) return;
    wired = true;
    await listen("audit:line", ({ payload }) => {
      if (!st.turn || payload?.run !== st.turn.run) return;
      takeLine(payload.line);
    });
    await listen("audit:end", ({ payload }) => {
      if (!st.turn || payload?.run !== st.turn.run) return;
      finishTurn(payload);
    });
  }

  let agentsLoading = false;
  async function loadAgents() {
    agentsLoading = true;
    try { st.agents = await invoke("audit_agents"); } catch { st.agents = []; }
    agentsLoading = false;
    const installed = st.agents.filter((a) => a.installed);
    if (!installed.some((a) => a.id === st.agent)) st.agent = installed[0]?.id || "";
    dirty();
  }

  function stampNow() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  /** Starts a scan: a fresh audit folder and a fresh agent session. */
  async function startScan() {
    if (!st.agent || !st.scope.length || st.starting || st.turn) return;
    savePrefs();
    st.starting = true;
    st.error = "";
    work(st.elevated ? "Security Sweep · waiting for the administrator prompt" : "Security Sweep · starting");
    dirty();
    const stamp = stampNow();
    try {
      const begun = await invoke("audit_begin", { elevated: st.elevated, stamp });
      Object.assign(st, { dir: begun.dir, ranAsAdmin: begun.elevated, computer: begun.computer, stamp });
    } catch (err) {
      st.starting = false;
      st.error = String(err);
      work(null);
      return dirty();
    }
    Object.assign(st, {
      starting: false, view: "audit", findings: [], passed: [], traces: {}, threads: {}, log: [], reply: null,
      session: st.agent === "claude" ? crypto.randomUUID() : null, sel: "", area: "all", logFilter: "all",
      open: new Set(), hidden: new Set(), notice: "",
      runId: (parked = null, st.dir), live: true, fresh: false, startedAt: Date.now(), continuedFrom: 0, scannedAt: 0,
    });
    st.stallMark = 0;
    if (stallsInScope()) {
      await loadStalls();
      st.stallMark = Math.max(0, ...(st.stallWatch.stalls || []).map((s) => s.id));
    }
    saveRun();
    send({ kind: "Scan", label: stallsInScope() ? "Diagnosing caught stalls" : `Scanning ${areaOf(st.scope[0]).name}`, prompt: scanPrompt(), first: true });
  }

  /** Every agent action goes through here. Returns whether it was sent, so a
   *  box that was typed into keeps its text when the person cancels. */
  async function send({ kind, label, prompt, finding = "", first = false, ask = "" }) {
    if (st.turn) return false;
    if (!st.live) {
      if (!(await confirmContinue())) return false;
      if (!(await continueRun())) return false;
    }
    // A stall audit keeps tracking: whatever the watch caught since the last
    // turn goes along with the next one.
    if (stallsInScope() && kind !== "Scan") {
      const fresh = await newStalls();
      if (fresh.length) prompt = `${stallsBlock(fresh, true)}\n\n${prompt}`;
    }
    if (st.fresh) {
      prompt = handover() + prompt;
      first = true;
      st.fresh = false;
    }
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    st.turn = { run, kind, label, finding, ask, started: Date.now(), rows: [], text: "", pending: "", note: "", notes: [], activity: "", calls: new Map(), cancelled: false };
    if (finding && kind === "Agent") (st.threads[finding] ||= []).push({ ask, reply: null });
    if (kind === "Trace") st.traces[finding] = { busy: true };
    work(`Security Sweep · ${agentName()}: ${label}`);
    dirty();
    tick();
    try {
      await invoke("audit_turn", { run, agent: st.agent, prompt, dir: st.dir, session: st.session, first });
    } catch (err) {
      finishTurn({ code: -1, error: String(err) });
    }
    return true;
  }

  function tick() {
    clearInterval(ticker);
    ticker = setInterval(() => {
      const node = root?.querySelector("[data-audit-elapsed]");
      if (!node || !st.turn) return;
      node.textContent = elapsed(st.turn.started);
    }, 1000);
  }

  /* ---------------------------------------------- reading the agent's stream */

  const clip = (text, max = 6000) => {
    const value = typeof text === "string" ? text : text == null ? "" : JSON.stringify(text, null, 1);
    return value.length > max ? `${value.slice(0, max)}\n… ${value.length - max} more characters` : value;
  };
  const clock = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  /** Removes the closing JSON block from something the agent said, leaving
   *  only what it wrote for a person to read. */
  function prose(text) {
    let value = String(text || "").replace(/```(?:json)?\s*([\s\S]*?)```/g, (whole, body) => {
      try { const v = JSON.parse(body.trim()); return v && typeof v === "object" && ("summary" in v || "findings" in v) ? "" : whole; } catch { return whole; }
    });
    const first = value.indexOf("{");
    if (first >= 0) {
      try {
        const v = JSON.parse(value.slice(first, value.lastIndexOf("}") + 1));
        if (v && typeof v === "object" && ("summary" in v || "findings" in v)) value = value.slice(0, first);
      } catch {}
    }
    return value.trim();
  }

  /** Something the agent wrote between commands: a remark, a plan, a question.
   *  It lands in the Activity list where it was said, so nothing the agent
   *  tells the person is lost between the commands around it. */
  function addNote(text) {
    const turn = st.turn;
    const said = prose(text);
    if (!turn || !said || turn.notes.includes(said)) return;
    turn.notes.push(said);
    st.log.push({ id: `${turn.run}-n${turn.notes.length}`, kind: "note", time: clock(), source: turn.kind, finding: turn.finding, text: said });
    turn.activity = said.split("\n")[0];
    dirty();
  }

  /** Gemini streams what it says in pieces; they become one note when it
   *  stops talking - at its next command or the end of the turn. */
  function flushNote() {
    const turn = st.turn;
    if (!turn?.note) return;
    const text = turn.note;
    turn.note = "";
    addNote(text);
  }

  /** A command the agent started. `key` ties it to its result when the CLI
   *  reports that separately. */
  function commandStarted(key, cmd) {
    const turn = st.turn;
    const text = String(cmd || "").trim();
    if (!turn || !text) return;
    flushNote();
    const row = {
      id: `${turn.run}-${turn.rows.length}`, time: clock(), source: turn.kind, finding: turn.finding,
      cmd: text, output: "", status: "running", why: "", result: "", link: "", started: Date.now(), ms: 0,
    };
    turn.rows.push(row);
    st.log.push(row);
    if (key) turn.calls.set(key, row);
    turn.activity = text.split("\n")[0];
    dirty();
  }

  function commandEnded(key, output, failed) {
    const turn = st.turn;
    if (!turn) return;
    const row = (key && turn.calls.get(key)) || [...turn.rows].reverse().find((r) => r.status === "running");
    if (!row) return;
    row.output = clip(output);
    row.status = failed ? "failed" : "ok";
    row.ms = Date.now() - row.started;
    dirty();
  }

  const toolText = (content) => Array.isArray(content)
    ? content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("\n")
    : typeof content === "string" ? content : clip(content);

  function takeLine(line) {
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    const turn = st.turn;
    const sid = obj.session_id || obj.sessionId || obj.data?.sessionId || (obj.type === "thread.started" && obj.thread_id);
    if (typeof sid === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(sid)) st.session = sid;

    // Claude Code and Cursor.
    if (obj.type === "result" && typeof obj.result === "string") turn.text = obj.result;
    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      for (const block of obj.message.content) {
        if (block.type === "tool_use") {
          const input = block.input || {};
          commandStarted(block.id, input.command || input.file_path || input.pattern || `${block.name} ${clip(input, 300)}`);
        }
        if (block.type === "text" && block.text) { turn.pending += block.text; addNote(block.text); }
      }
    }
    if (obj.type === "user" && Array.isArray(obj.message?.content)) {
      for (const block of obj.message.content) {
        if (block.type === "tool_result") commandEnded(block.tool_use_id, toolText(block.content), block.is_error === true);
      }
    }
    if (obj.type === "tool_call") {
      const call = obj.tool_call || {};
      const inner = Object.values(call)[0] || {};
      if (obj.subtype === "started") commandStarted(obj.call_id, inner.args?.command || inner.args?.path || Object.keys(call)[0]);
      if (obj.subtype === "completed") {
        const result = inner.result || {};
        commandEnded(obj.call_id, result.success?.stdout ?? result.success ?? result.error ?? result, !!result.error);
      }
    }
    // Codex.
    if (obj.item?.type === "command_execution") {
      if (obj.type === "item.started") commandStarted(obj.item.id, obj.item.command);
      if (obj.type === "item.completed") commandEnded(obj.item.id, obj.item.aggregated_output || obj.item.output || "", obj.item.status === "failed" || Number(obj.item.exit_code) > 0);
    }
    if (obj.type === "item.completed" && obj.item?.type === "agent_message") { turn.text = String(obj.item.text || ""); addNote(turn.text); }
    // Gemini.
    if (obj.type === "tool_use") commandStarted(obj.tool_id, obj.parameters?.command || obj.tool_name);
    if (obj.type === "tool_result") commandEnded(obj.tool_id, obj.output ?? obj.error?.message ?? "", obj.status === "error");
    if (obj.type === "message" && obj.role === "assistant" && obj.content) { turn.pending += obj.content; turn.note += obj.content; }
    // GitHub Copilot.
    if (obj.type === "tool.execution_start") commandStarted(obj.data?.toolCallId, obj.data?.arguments?.command || obj.data?.toolName);
    if (obj.type === "tool.execution_complete") commandEnded(obj.data?.toolCallId, obj.data?.result?.content ?? obj.data?.error ?? "", obj.data?.success === false);
    if (obj.type === "assistant.message") {
      const msg = obj.data?.message;
      const text = msg?.content?.join ? msg.content.join("") : msg?.content || msg?.text || "";
      if (text) { turn.text = text; addNote(text); }
    }
    const node = root?.querySelector("[data-audit-activity]");
    if (node && turn.activity) node.textContent = turn.activity;
  }

  function parseBlock(text) {
    const fenced = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]).reverse();
    const first = text.indexOf("{"), last = text.lastIndexOf("}");
    if (first >= 0 && last > first) fenced.push(text.slice(first, last + 1));
    for (const body of fenced) {
      try {
        const value = JSON.parse(body.trim());
        if (value && typeof value === "object" && ("summary" in value || "findings" in value)) return value;
      } catch {}
    }
    return null;
  }

  const list = (value) => (Array.isArray(value) ? value : []);
  const str = (value) => (value == null ? "" : String(value));

  function finishTurn(ended) {
    finishTurnInner(ended);
    saveRun();
  }

  function finishTurnInner({ code, error }) {
    clearInterval(ticker); ticker = 0;
    const turn = st.turn;
    if (!turn) return;
    flushNote();
    st.turn = null;
    work(null);
    for (const row of turn.rows) if (row.status === "running") row.status = turn.cancelled ? "failed" : "ok";
    const block = parseBlock(turn.text || turn.pending || "");

    if (!block) {
      const reason = turn.cancelled ? "Stopped before the agent answered."
        : str(error).trim() || (turn.text || turn.pending ? "The agent answered without the JSON block WinT reads." : `The agent stopped without an answer (exit code ${code}).`);
      st.reply = { summary: reason, failed: true, raw: turn.text || turn.pending, retry: turn };
      if (turn.kind === "Trace") delete st.traces[turn.finding];
      if (turn.kind === "Agent") { const thread = st.threads[turn.finding]; if (thread?.length) thread[thread.length - 1].reply = { summary: reason, failed: true }; }
      return dirty();
    }

    // What the agent says about its own commands fills in the rows the stream
    // already drew. Commands the stream never showed still get a row, marked
    // as reported rather than observed.
    for (const said of list(block.activity)) {
      const cmd = str(said.command).trim();
      if (!cmd) continue;
      const head = cmd.split("\n")[0].slice(0, 60);
      const row = turn.rows.find((r) => !r.why && (r.cmd.includes(head) || cmd.includes(r.cmd.split("\n")[0].slice(0, 60))));
      const target = row || { id: `${turn.run}-r${st.log.length}`, time: clock(), source: turn.kind, finding: turn.finding, cmd, output: "", status: "reported", ms: 0 };
      target.why = str(said.why);
      target.result = str(said.result);
      target.link = str(said.finding);
      if (!row) st.log.push(target);
    }
    for (const row of turn.rows) if (!row.why) row.why = turn.label;

    const areas = new Set(AREAS.map((a) => a.id));
    for (const raw of list(block.findings)) {
      const id = str(raw.id).trim();
      if (!id) continue;
      const found = {
        id,
        severity: SEV[str(raw.severity).toLowerCase()] ? str(raw.severity).toLowerCase() : "low",
        area: areas.has(raw.area) ? raw.area : "Autostart",
        title: str(raw.title), why: str(raw.why), where: str(raw.where), age: str(raw.age), isNew: raw.isNew === true,
        verdict: str(raw.verdict),
        evidence: list(raw.evidence).map((e) => ({ label: str(e.label), value: str(e.value) })),
        fix: raw.fix && list(raw.fix.commands).length ? {
          label: str(raw.fix.label), detail: str(raw.fix.detail), undo: str(raw.fix.undo),
          commands: list(raw.fix.commands).map((c) => ({ step: str(c.step), cmd: str(c.cmd) })),
        } : null,
        asks: list(raw.asks).map(str).filter(Boolean).slice(0, 4),
      };
      if (st.expected.has(expectedKey(found))) continue;
      const index = st.findings.findIndex((f) => f.id === id);
      if (index >= 0) st.findings[index] = { ...st.findings[index], ...found, fixed: false };
      else st.findings.push(found);
    }
    for (const id of list(block.resolved)) {
      const f = findingById(str(id));
      if (f) f.fixed = true;
    }
    if (list(block.passed).length) {
      const seen = new Set(st.passed.map((p) => p.name));
      for (const p of list(block.passed)) if (!seen.has(str(p.name))) st.passed.push({ name: str(p.name), detail: str(p.detail) });
    }
    const trace = block.trace && typeof block.trace === "object" ? block.trace : null;
    if (trace) {
      st.traces[str(trace.finding) || turn.finding] = {
        headline: str(trace.headline), conclusion: str(trace.conclusion), confidence: str(trace.confidence),
        timeline: list(trace.timeline).map((t) => ({ time: str(t.time), label: str(t.label), detail: str(t.detail), how: str(t.how) })),
        commands: turn.rows.length,
      };
    } else if (turn.kind === "Trace") {
      delete st.traces[turn.finding];
    }
    if (turn.kind === "Scan") {
      st.scannedAt = Date.now();
      st.scanSeconds = Math.round((Date.now() - turn.started) / 1000);
    }

    st.reply = {
      summary: str(block.summary), question: str(block.question), done: block.done === true,
      options: list(block.options).filter((o) => o?.label).slice(0, 4).map((o) => ({ label: str(o.label), detail: str(o.detail), changesSystem: o.changesSystem === true })),
    };
    if (turn.kind === "Agent") {
      const thread = st.threads[turn.finding];
      if (thread?.length) thread[thread.length - 1].reply = { summary: str(block.summary) };
    }
    if (turn.kind === "Fix") st.notice = findingById(turn.finding)?.fixed ? `Fixed: ${findingById(turn.finding).title}` : `The fix for “${findingById(turn.finding)?.title || turn.finding}” did not finish — see its latest details.`;
    dirty();
  }

  /* ---------------------------------------------------------------- actions */

  async function cancel() {
    if (!st.turn) return;
    st.turn.cancelled = true;
    dirty();
    await invoke("audit_cancel").catch(() => {});
  }

  function say(text, changesSystem = false) {
    const instruction = changesSystem
      ? `The user chose: "${text}". The user approves this change: carry it out now, then verify it.`
      : `The user says: ${text}`;
    return send({ kind: "Agent", label: text, prompt: followPrompt(instruction) });
  }

  function markdown() {
    const lines = [`# Security sweep of ${st.computer || "this PC"}`, "",
      `${new Date(st.scannedAt || Date.now()).toLocaleString()} · ${agentName()} · ${st.ranAsAdmin ? "administrator" : "standard rights"} · ${st.scope.join(", ")}`, ""];
    for (const f of sortedFindings(st.findings)) {
      lines.push(`## ${f.fixed ? "[fixed] " : ""}${SEV[f.severity].word}: ${f.title}`, "", `${f.area} · ${f.where}`, "", f.verdict || f.why, "");
      for (const e of f.evidence) lines.push(`- **${e.label}:** ${e.value}`);
      const trace = st.traces[f.id];
      if (trace?.headline) {
        lines.push("", `**Origin:** ${trace.headline}`, "");
        for (const t of trace.timeline) lines.push(`- ${t.time} — ${t.label}: ${t.detail}`);
        if (trace.conclusion) lines.push("", trace.conclusion);
      }
      if (f.fix) {
        lines.push("", `**Fix:** ${f.fix.label} — ${f.fix.detail}`, "", "```powershell", ...f.fix.commands.map((c) => `# ${c.step}\n${c.cmd}`), "```", "", f.fix.undo);
      }
      lines.push("");
    }
    if (st.passed.length) {
      lines.push("## Passed", "");
      for (const p of st.passed) lines.push(`- ${p.name} — ${p.detail}`);
    }
    return lines.join("\n");
  }

  function logText() {
    return st.log.map((r) => r.kind === "note" ? `## ${r.time} · ${r.source} · the agent said

${r.text}` : [`## ${r.time} · ${r.source} · ${r.status}`, r.why ? `Why: ${r.why}` : "", r.result ? `Result: ${r.result}` : "",
      "```", r.cmd, "```", r.output ? `\`\`\`\n${r.output}\n\`\`\`` : ""].filter(Boolean).join("\n")).join("\n\n");
  }

  async function exportFile(name, text) {
    try {
      const path = await invoke("audit_save", { dir: st.dir, name, text });
      st.notice = `Saved ${path}`;
      invoke("open_in", { path, target: "reveal", context: null }).catch(() => {});
    } catch (err) {
      st.notice = String(err);
    }
    dirty();
  }

  /* ---------------------------------------------------------------- drawing */

  const sortedFindings = (items) => [...items].sort((a, b) => (a.fixed - b.fixed) || SEV[a.severity].order - SEV[b.severity].order);
  const openFindings = () => st.findings.filter((f) => !f.fixed && !st.hidden.has(f.id));

  function band() {
    if (st.view === "setup") {
      return { tone: "accent", glyph: "tune", title: "Before it starts",
        detail: `${st.agent ? agentName() : "No agent"} · ${st.elevated ? "administrator" : "standard rights"} · ${st.scope.length} of ${AREAS.length} areas — nothing runs until you start it` };
    }
    const open = openFindings();
    const high = open.filter((f) => f.severity === "high").length;
    const rest = open.length - high;
    const commands = st.log.filter((r) => r.kind !== "note").length;
    if (st.turn?.kind === "Scan") {
      return { tone: "accent", glyph: "progress_activity", spin: true, title: stallsInScope() ? `${agentName()} is diagnosing caught stalls` : `${agentName()} is scanning ${areaOf(st.scope[0]).name}`,
        detail: `${commands} command${commands === 1 ? "" : "s"} so far · ${open.length} finding${open.length === 1 ? "" : "s"} arrive when it reports back` };
    }
    if (!st.live && st.runId) {
      const open = openFindings().length;
      return { tone: "history", glyph: "history", title: `From history · ${age(st.startedAt)} old`,
        detail: `${new Date(st.startedAt).toLocaleString()} · ${open} open finding${open === 1 ? "" : "s"} · ${commands} commands · may no longer be current — acting on it starts a new agent without the old context` };
    }
    const when = st.scannedAt ? `scanned ${Math.max(1, Math.round((Date.now() - st.scannedAt) / 60000))} min ago in ${st.scanSeconds}s` : "not scanned yet";
    const tail = `${st.passed.length} checks passed · ${commands} commands run · ${when}`;
    if (high) return { tone: "bad", glyph: "gpp_bad", title: `${high} thing${high === 1 ? "" : "s"} need${high === 1 ? "s" : ""} attention now`, detail: `${rest ? `${rest} more worth a look · ` : ""}${tail}` };
    if (rest) return { tone: "warn", glyph: "warning", title: `${rest} thing${rest === 1 ? "" : "s"} worth a look`, detail: tail };
    if (!st.scannedAt && st.reply?.failed) {
      return { tone: "warn", glyph: "block", title: "The scan did not finish", detail: `${st.reply.summary} · ${commands} command${commands === 1 ? "" : "s"} ran first · New scan to start over` };
    }
    return { tone: "ok", glyph: "verified_user", title: st.scannedAt ? "Nothing needs attention" : "No results", detail: tail };
  }

  function bandHtml() {
    const b = band();
    const actions = st.view === "audit"
      ? `<button type="button" class="btn" data-sa="history"${st.turn ? " disabled" : ""}>${icon("history")}History</button>
         <button type="button" class="btn" data-sa="report"${st.findings.length ? "" : " disabled"}>${icon("download")}Export report</button>
         <button type="button" class="btn primary" data-sa="setup"${st.turn ? " disabled" : ""}>${icon("add")}New scan</button>`
      : "";
    return `<div class="sa-band"><span class="sa-plate" data-tone="${b.tone}">${icon(b.glyph)}</span>
      <span class="sa-band-text"><strong>${esc(b.title)}</strong><small>${esc(b.detail)}</small></span><i></i>${actions}</div>`;
  }

  function cards(items, key) {
    return items.map((item) => `<button type="button" class="sa-card${item.on ? " on" : ""}" data-sa-${key}="${esc(item.id)}"${item.disabled ? " disabled" : ""}>
      <strong>${icon(item.glyph)}${esc(item.name)}</strong><small>${esc(item.detail)}</small></button>`).join("");
  }

  function historyHtml() {
    if (!st.historyLoaded) {
      return `<section><h3>Past audits</h3><div class="sa-history"><div class="sa-history-row"><span class="sa-history-open">${icon("history")}<span><i class="sk" style="width:150px"></i></span><small><i class="sk" style="width:200px"></i></small><small></small></span></div></div></section>`;
    }
    if (!st.history.length) return "";
    const rows = st.history.slice(0, 30).map((r) => {
      const current = r.id === st.runId;
      const live = (current && st.live) || r.id === parked?.runId;
      const counts = [r.high && `<b class="high">${r.high} high</b>`, r.medium && `<b class="medium">${r.medium} medium</b>`, r.low && `<b>${r.low} low</b>`].filter(Boolean).join(" · ") || "no open findings";
      const agent = st.agents?.find((a) => a.id === r.agent)?.label || r.agent;
      return `<div class="sa-history-row${current ? " on" : ""}">
        <button type="button" class="sa-history-open" data-sa-run="${esc(r.id)}"${st.turn ? " disabled" : ""}>
          ${icon(live ? "radio_button_checked" : "history")}
          <span><strong>${esc(new Date(r.startedAt).toLocaleString())}</strong>${live ? `<em class="sa-pill ok">Live</em>` : `<small>${esc(age(r.startedAt))} ago</small>`}</span>
          <small>${esc(agent)} · ${r.ranAsAdmin ? "administrator" : "standard rights"} · ${r.scope.length} areas · ${r.commands} commands</small>
          <small class="sa-history-counts">${counts}</small>
        </button>
        <button type="button" class="sa-history-delete" data-sa-delrun="${esc(r.id)}" title="Delete this run from history"${live ? " disabled" : ""}>${icon("delete")}</button></div>`;
    }).join("");
    return `<section><h3>Past audits</h3><div class="sa-history">${rows}</div></section>`;
  }

  /** What there is to diagnose, drawn on the stall scan's card. */
  function stallLine() {
    const s = st.stallWatch;
    if (!s) return `<small><i class="sk" style="width:220px"></i></small>`;
    const caught = (s.stalls || []).filter((x) => x.kind !== "manual").length;
    const marked = (s.stalls || []).length - caught;
    const counts = [`${caught} stall${caught === 1 ? "" : "s"} caught`, marked ? `${marked} marked by you` : ""].filter(Boolean).join(" · ");
    return `<small class="sa-stall-line">${icon(s.watching ? "monitoring" : "mouse")}${esc(counts)} · Input Stall Watch is ${s.watching ? "watching" : "off, so nothing new will be caught"}</small>`;
  }

  /** What there is to account for, drawn on the startup scan's card. */
  function startupLine() {
    if (!st.startup) return `<small><i class="sk" style="width:220px"></i></small>`;
    const entries = st.startup.entries || [];
    const running = (st.startup.icons || []).filter((item) => item.running);
    const unexplained = running.filter((item) => !item.startupId).length;
    const counts = [
      `${entries.length} startup entr${entries.length === 1 ? "y" : "ies"}`,
      `${running.length} tray icon${running.length === 1 ? "" : "s"}`,
      unexplained ? `${unexplained} unaccounted for` : "all accounted for",
    ].join(" · ");
    return `<small class="sa-stall-line">${icon("rocket_launch")}${esc(counts)}</small>`;
  }

  function setupHtml() {
    const installed = (st.agents || []).filter((a) => a.installed);
    const needsAdmin = st.scope.some((id) => areaOf(id)?.admin);
    const agents = st.agents === null
      ? `<div class="sa-card skeleton"><strong>Looking for coding agents on this PC…</strong><i class="sk"></i></div>
         <div class="sa-card skeleton"><i class="sk"></i><i class="sk"></i></div>`
      : installed.length
        ? cards(st.agents.map((a) => ({ id: a.id, name: a.label, glyph: "smart_toy", on: a.id === st.agent, disabled: !a.installed,
            detail: a.installed ? "Installed · does the whole audit in its own shell" : "Not installed" })), "agent")
        : `<div class="sa-empty">No coding agent is installed. The audit is done entirely by one you already have — Claude Code, Codex, Gemini, GitHub Copilot or Cursor Agent. Install one from a workspace's Agent panel.
            <button type="button" class="btn" data-sa="agents">${icon("refresh")}Look again</button></div>`;
    const rights = cards([
      { id: "standard", name: "Standard", glyph: "person", on: !st.elevated, detail: "No Windows prompt. Checks that need administrator are reported as skipped." },
      { id: "admin", name: "Administrator", glyph: "admin_panel_settings", on: st.elevated,
        detail: `One prompt now, for the whole audit. The agent can see and change everything, so read what you approve.${needsAdmin ? " One of the areas you chose needs it." : ""}` },
    ], "rights");
    const areas = AREAS.map((a) => {
      const on = st.scope.includes(a.id);
      return `<button type="button" class="sa-area${on ? " on" : ""}" data-sa-area="${esc(a.id)}">
        <span class="sa-tick">${icon(on ? "radio_button_checked" : "radio_button_unchecked")}</span>
        <span class="sa-area-name"><strong>${esc(a.name)}</strong>${a.admin ? `<em class="sa-pill warn">Administrator</em>` : ""}</span>
        <small>${esc(a.what)}</small>${a.id === "Stalls" ? stallLine() : ""}${a.id === "Startup" ? startupLine() : ""}</button>`;
    }).join("");
    const kept = st.findings.length || st.log.length;
    return `<div class="sa-setup"><div class="sa-setup-scroll" data-sa-scroll="setup"><div class="sa-setup-body">
        ${historyHtml()}
        <section><h3>1 · Who does the audit</h3>
          <p>WinT does no checking of its own. The agent runs every command in its own shell, and WinT shows each one with its reason and result, then what it found.</p>
          <div class="sa-cards">${agents}</div></section>
        <section><h3>2 · Rights for the whole audit</h3><div class="sa-cards wide">${rights}</div>
          <small class="sa-note">Rights cannot change once the audit is running: switching would restart the agent and lose everything it has learned.</small></section>
        <section><h3>3 · What to look at</h3><p>Pick one kind of scan.</p><div class="sa-areas">${areas}</div></section>
      </div></div>
      <footer class="sa-setup-foot">
        <span><strong>${st.scope.length ? esc(areaOf(st.scope[0]).name) : "No scan chosen"}</strong>
          <small>${needsAdmin && !st.elevated ? "This scan needs administrator — the agent will report it as skipped." : stallsInScope() ? "Every stall caught while the audit is open goes to the agent with your next step." : "The Activity list will show every command the agent runs."}</small></span>
        <i></i>
        ${st.error ? `<span class="sa-error">${esc(st.error)}</span>` : ""}
        ${kept ? `<button type="button" class="btn" data-sa="keep">${icon("arrow_back")}Keep the last results</button>` : ""}
        <button type="button" class="btn primary" data-sa="start"${!st.agent || !st.scope.length || st.starting ? " disabled" : ""}>${icon(st.starting ? "progress_activity" : "play_arrow")}${
          st.starting ? (st.elevated ? "Waiting for the administrator prompt…" : "Starting…") : !st.scope.length ? "Choose a scan first" : kept ? "Start a new scan" : "Start scan"}</button>
      </footer></div>`;
  }

  function chip(id, name, glyph, count, on, key) {
    return `<button type="button" class="sa-chip${on ? " on" : ""}" data-sa-${key}="${esc(id)}">${icon(glyph)}${esc(name)}<b>${count}</b></button>`;
  }

  function logHtml() {
    const sel = findingById(st.sel);
    const rows = st.log.filter((r) => st.logFilter === "all" ? true : st.logFilter === "finding" ? (r.finding === st.sel || r.link === st.sel) : r.source === st.logFilter);
    const count = (source) => st.log.filter((r) => r.source === source).length;
    const chips = [
      chip("all", "All", "receipt_long", st.log.length, st.logFilter === "all", "log"),
      chip("Scan", "Scan", "shield", count("Scan"), st.logFilter === "Scan", "log"),
      chip("Trace", "Origin traces", "manage_search", count("Trace"), st.logFilter === "Trace", "log"),
      chip("Agent", "Deeper", "smart_toy", count("Agent"), st.logFilter === "Agent", "log"),
      chip("Fix", "Fixes", "build", count("Fix"), st.logFilter === "Fix", "log"),
      sel ? chip("finding", "Only this finding", "filter_alt", st.log.filter((r) => r.finding === sel.id || r.link === sel.id).length, st.logFilter === "finding", "log") : "",
    ].join("");
    const body = rows.map((r) => {
      if (r.kind === "note") {
        return `<div class="sa-note-row"><span class="sa-status">${icon("chat")}</span><small class="mono">${esc(r.time)}</small><small class="sa-tag" data-tag="${TAGS[r.source]}">${esc(r.source)}</small>
          <p>${esc(r.text)}</p></div>`;
      }
      const open = st.open.has(r.id);
      const glyph = { running: "progress_activity", ok: "task_alt", failed: "error", reported: "chat" }[r.status];
      const link = findingById(r.link || r.finding);
      return `<div class="sa-log-row${open ? " open" : ""}" data-status="${r.status}">
        <button type="button" class="sa-log-head" data-sa-row="${esc(r.id)}">
          <span class="sa-status">${icon(glyph)}</span><small class="mono">${esc(r.time)}</small><small class="sa-tag" data-tag="${TAGS[r.source]}">${esc(r.source)}</small>
          <span class="sa-log-text"><code>${esc(r.cmd.split("\n")[0])}</code><small>${esc(r.why || (r.status === "running" ? "Running…" : ""))}</small>
            <small class="sa-result">${esc(r.status === "running" ? "running" : [r.result, r.ms ? `${(r.ms / 1000).toFixed(1)}s` : ""].filter(Boolean).join(" · ") || (r.status === "reported" ? "reported by the agent" : "done"))}</small></span>
          ${icon(open ? "expand_less" : "expand_more")}</button>
        ${open ? `<div class="sa-log-body">
          ${r.why ? `<div><h4>Why it ran</h4><p>${esc(r.why)}</p></div>` : ""}
          <div><h4>Command · ${esc(agentName())}, ${st.ranAsAdmin ? "administrator" : "standard rights"}</h4><pre>${esc(r.cmd)}</pre></div>
          <div><h4>${r.status === "failed" ? "Error" : "Output"}</h4><pre class="out">${esc(r.output || (r.status === "reported" ? "The agent reported this command in its summary; its output was not in the stream." : "(no output)"))}</pre></div>
          <div class="sa-row-actions"><i></i>
            ${link ? `<button type="button" class="btn small" data-sa-open="${esc(link.id)}">${icon("chevron_right")}Open the finding</button>` : ""}
            <button type="button" class="btn small" data-sa-copy="cmd:${esc(r.id)}">${icon("content_paste")}Copy command</button>
            ${r.output ? `<button type="button" class="btn small" data-sa-copy="out:${esc(r.id)}">${icon("content_paste")}Copy output</button>` : ""}</div>
        </div>` : ""}</div>`;
    }).join("");
    const empty = st.turn || rows.length ? "" : `<div class="sa-empty">${st.logFilter === "all" ? "No commands yet." : "No commands match this filter."}</div>`;
    return `<div class="sa-pane-head">${icon("receipt_long")}<strong>Activity</strong><small>${(() => { const all = st.log.filter((r) => r.kind !== "note").length; const shown = rows.filter((r) => r.kind !== "note").length; return shown === all ? `${all} commands and what the agent said, newest last` : `${shown} of ${all} commands`; })()}</small><i></i>
        <button type="button" class="btn small" data-sa="log"${st.log.length ? "" : " disabled"}>${icon("download")}Export log</button></div>
      <div class="sa-chips">${chips}</div>
      <div class="sa-scroll" data-sa-scroll="log"><div class="sa-log">${body}${empty}${turnHtml()}</div></div>
      ${replyHtml()}`;
  }

  /** The turn in flight, drawn where its commands are landing. */
  function turnHtml() {
    const t = st.turn;
    if (!t) return "";
    return `<div class="sa-working"><span class="sa-spin">${icon("progress_activity")}</span>
      <span class="sa-working-text"><strong>${esc(agentName())} · ${esc(t.label)}</strong><small class="mono" data-audit-activity>${esc(t.activity || "Starting the agent…")}</small></span>
      <span class="sa-elapsed mono" data-audit-elapsed>${elapsed(t.started)}</span>
      <button type="button" class="btn small" data-sa="cancel"${t.cancelled ? " disabled" : ""}>${icon("stop")}${t.cancelled ? "Stopping…" : "Stop"}</button></div>`;
  }

  /** What the agent said last, its question, and the free-text follow-up. The
   *  textarea itself lives outside this markup and is never redrawn. */
  function replyHtml() {
    const r = st.reply;
    if (!r || st.turn) return "";
    const options = (r.options || []).map((o, i) => `<button type="button" class="sa-option${o.changesSystem ? " changes" : ""}" data-sa-option="${i}">
      <strong>${icon(o.changesSystem ? "build" : "arrow_forward")}${esc(o.label)}</strong><small>${o.changesSystem ? "<b>Changes your system.</b> " : ""}${esc(o.detail)}</small></button>`).join("");
    return `<div class="sa-reply${r.failed ? " failed" : r.done ? " done" : ""}">
      <p>${icon(r.failed ? "error" : r.done ? "task_alt" : "smart_toy")}<span>${esc(r.summary)}</span></p>
      ${r.question ? `<p class="sa-question">${icon("help")}${esc(r.question)}</p>` : ""}
      ${options ? `<div class="sa-options">${options}</div>` : ""}
      ${r.failed ? `<div class="sa-row-actions">${r.raw ? `<button type="button" class="btn small" data-sa="raw">${icon("notes")}What the agent said</button>` : ""}<button type="button" class="btn small" data-sa="retry">${icon("refresh")}Ask again</button></div>` : ""}
    </div>`;
  }

  function findingHtml(f) {
    const on = f.id === st.sel;
    const sev = SEV[f.severity];
    const head = `<button type="button" class="sa-finding-head" data-sa-pick="${esc(f.id)}"><i class="sa-edge"></i>
      <span class="sa-finding-main"><span class="sa-finding-title">${icon(f.fixed ? "task_alt" : sev.glyph)}<strong>${esc(f.title)}</strong>
        ${f.fixed ? `<em class="sa-pill ok">Fixed</em>` : f.isNew ? `<em class="sa-pill accent">New</em>` : ""}</span>
        <small>${esc(f.why)}</small><code>${esc(f.where)}</code></span>
      <span class="sa-finding-side"><b>${esc(sev.word)}</b><small>${esc(areaOf(f.area)?.chip || f.area)}</small><small>${esc(f.age)}</small>${icon(on ? "expand_less" : "expand_more")}</span></button>`;
    if (!on) return `<div class="sa-finding" data-sev="${f.severity}"${f.fixed ? " data-fixed" : ""}>${head}</div>`;

    const busy = !!st.turn;
    const trace = st.traces[f.id];
    const traceHtml = trace?.busy
      ? `<div class="sa-box accent"><strong>${icon("progress_activity")}Tracing</strong><small>Each command the agent runs appears in the Activity list on the left as it runs, with its output.</small></div>`
      : trace?.headline
        ? `<div class="sa-box sev"><strong>${esc(trace.headline)}</strong>
            <div class="sa-timeline">${trace.timeline.map((t) => `<span><i></i><small class="mono">${esc(t.time)}</small><strong>${esc(t.label)}</strong><span class="mono">${esc(t.detail)}</span><small>${esc(t.how)}</small></span>`).join("")}</div>
            ${trace.conclusion ? `<div class="sa-conclusion"><strong>${icon(sev.glyph)}Conclusion</strong><small>${esc(trace.conclusion)}</small><small class="dim">${esc(trace.confidence)}</small></div>` : ""}
            <div class="sa-row-actions"><button type="button" class="btn small" data-sa-copy="trace:${esc(f.id)}">${icon("content_paste")}Copy the origin as Markdown</button>
              <button type="button" class="btn small" data-sa-tracelog="${esc(f.id)}">${icon("receipt_long")}See the ${trace.commands} command${trace.commands === 1 ? "" : "s"} this trace ran</button>
              <button type="button" class="btn small" data-sa-untrace="${esc(f.id)}">${icon("expand_less")}Collapse trace</button></div></div>`
        : `<div class="sa-box"><strong>${icon("manage_search")}Trace the origin of this item</strong>
            <small>${esc(agentName())} reconstructs what happened in the minutes around the moment it appeared: what was downloaded, what ran, what wrote the file, and what else appeared at the same time. It changes nothing.</small>
            <div class="sa-sources"><span>What it will read</span>${[["download", "Browser download history and Zone.Identifier streams"], ["schedule", "File and registry timestamps in a ±5 minute window"], ["receipt_long", "TaskScheduler, System and Security event logs"], ["memory", "Prefetch entries — what ran, and when it first ran"], ["inventory", "Uninstall keys, installer records and Defender history"]].map(([g, n]) => `<span>${icon(g)}${n}</span>`).join("")}</div>
            <button type="button" class="btn sa-accent" data-sa-trace="${esc(f.id)}"${busy ? " disabled" : ""}>${icon("manage_search")}Trace where this came from</button></div>`;

    const evidence = f.evidence.length ? `<section><h3>Evidence</h3><div class="sa-facts">${f.evidence.map((e) => `<span><small>${esc(e.label)}</small><span class="mono">${esc(e.value)}</span></span>`).join("")}</div></section>` : "";
    const fix = f.fix && !f.fixed ? `<section><h3>Recommended fix</h3><div class="sa-box warn"><strong>${icon("build")}${esc(f.fix.label)}</strong><small>${esc(f.fix.detail)}</small>
        <div class="sa-sources cmds"><span>Exactly what the agent will run</span>${f.fix.commands.map((c) => `<span><small class="mono">${esc(c.step)}</small><code>${esc(c.cmd)}</code></span>`).join("")}</div>
        ${f.fix.undo ? `<small class="sa-undo">${icon("history")}${esc(f.fix.undo)}</small>` : ""}
        <div class="sa-row-actions"><button type="button" class="btn sa-warn" data-sa-fix="${esc(f.id)}"${busy ? " disabled" : ""}>${icon("play_arrow")}Apply this fix</button>
          <button type="button" class="btn" data-sa-copy="fix:${esc(f.id)}">${icon("content_paste")}Copy</button></div></div></section>` : "";
    const thread = (st.threads[f.id] || []).map((t) => `<div class="sa-thread"><small>${icon("subdirectory_arrow_right")}${esc(t.ask)}</small><p${t.reply?.failed ? ' class="bad"' : ""}>${esc(t.reply ? t.reply.summary : "Working…")}</p></div>`).join("");
    const deeper = `<section><h3>Go deeper</h3><div class="sa-box accent"><strong>${icon("smart_toy")}Ask ${esc(agentName())} to investigate further</strong>
        <small>The agent already has this finding, its evidence and any trace in its context. It runs its own PowerShell and changes nothing unless you approve it.</small>
        ${thread}
        ${f.asks.length ? `<div class="sa-row-actions left">${f.asks.map((a, i) => `<button type="button" class="btn small" data-sa-ask="${esc(f.id)}:${i}"${busy ? " disabled" : ""}>${icon("manage_search")}${esc(a)}</button>`).join("")}</div>` : ""}
        <form class="sa-ask" data-sa-askform="${esc(f.id)}"><input type="text" placeholder="Or ask something else about this finding…"${busy ? " disabled" : ""}><button type="submit" class="btn small"${busy ? " disabled" : ""}>${icon("send")}Ask</button></form>
        <small class="dim">${st.ranAsAdmin ? "Administrator" : "Standard rights"} — the agent will say so if a check needs more.</small></div></section>`;
    const dismiss = `<div class="sa-dismiss"><button type="button" data-sa-expect="${esc(f.id)}">${icon("verified_user")}I know what this is — mark as expected</button>
      <button type="button" data-sa-hide="${esc(f.id)}">${icon("schedule")}Hide until the next scan</button></div>`;
    return `<div class="sa-finding on" data-sev="${f.severity}"${f.fixed ? " data-fixed" : ""}>${head}<div class="sa-finding-body">
      <p class="sa-verdict">${esc(f.verdict || f.why)}</p>
      <section><h3>Where did it come from</h3>${traceHtml}</section>
      ${evidence}${fix}${deeper}${dismiss}</div></div>`;
  }

  function findingsHtml() {
    const visible = st.findings.filter((f) => !st.hidden.has(f.id));
    const counts = new Map();
    for (const f of visible) if (!f.fixed) counts.set(f.area, (counts.get(f.area) || 0) + 1);
    const chips = [chip("all", "All", "shield", visible.filter((f) => !f.fixed).length, st.area === "all", "areachip"),
      ...st.scope.map((id) => chip(id, areaOf(id).chip, areaOf(id).glyph, counts.get(id) || 0, st.area === id, "areachip"))].join("");
    const shown = sortedFindings(visible.filter((f) => st.area === "all" || f.area === st.area));
    const none = !shown.length ? `<div class="sa-empty">${st.scannedAt ? "No findings here." : st.reply?.failed ? "No findings — the scan did not finish." : "No findings yet..."}</div>` : "";
    const passed = st.passed.length ? `<button type="button" class="sa-passed" data-sa="passed">${icon("verified_user")}<span>${st.passed.length} checks passed${st.showPassed ? "" : " — nothing to do here"}</span>${icon(st.showPassed ? "expand_less" : "expand_more")}</button>
      ${st.showPassed ? `<div class="sa-passed-list">${st.passed.map((p) => `<span>${icon("task_alt")}<span>${esc(p.name)}</span><small>${esc(p.detail)}</small></span>`).join("")}</div>` : ""}` : "";
    const open = visible.filter((f) => !f.fixed && (st.area === "all" || f.area === st.area)).length;
    return `<div class="sa-pane-head">${icon("shield")}<strong>Findings</strong><small>${st.area === "all" ? `${open} open` : `${open} in ${esc(areaOf(st.area)?.chip)}`}</small><i></i><small>Risk first</small></div>
      <div class="sa-chips">${chips}</div>
      <div class="sa-scroll" data-sa-scroll="findings"><div class="sa-findings">${shown.map(findingHtml).join("")}${none}${passed}</div></div>`;
  }

  /** Replaces a region only when its markup changed. Streaming usually changes
   *  the Activity pane alone, so Findings - and whatever is being clicked
   *  there - is left in place. Scroll position and a half-typed question
   *  survive a region that does get replaced. */
  function region(node, html) {
    if (node.__html === html) return;
    const scroller = node.querySelector("[data-sa-scroll]");
    const was = scroller ? { top: scroller.scrollTop, bottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40, first: false } : { first: true };
    const asking = node.querySelector("[data-sa-askform] input");
    const draft = asking ? { id: asking.form.dataset.saAskform, value: asking.value, focused: document.activeElement === asking } : null;
    node.innerHTML = html;
    node.__html = html;
    const again = node.querySelector("[data-sa-scroll]");
    if (again) {
      const log = again.dataset.saScroll === "log";
      again.scrollTop = was.first ? (log ? again.scrollHeight : 0) : log && was.bottom ? again.scrollHeight : was.top;
    }
    if (draft) {
      const input = node.querySelector(`[data-sa-askform="${CSS.escape(draft.id)}"] input`);
      if (input) { input.value = draft.value; if (draft.focused && !input.disabled) input.focus(); }
    }
  }

  /** Draws one region. If building it throws, the region shows the error rather
   *  than silently keeping whatever it showed before. */
  function safely(node, build) {
    try {
      region(node, build());
    } catch (err) {
      console.error("Security Sweep could not draw", err);
      region(node, `<div class="sa-empty sa-draw-error">${icon("error")}Security Sweep could not draw this part: ${esc(err?.message || err)}</div>`);
    }
  }

  function draw() {
    if (!root) return;
    const main = root.querySelector("[data-sa-main]");
    safely(root.querySelector("[data-sa-band]"), bandHtml);
    if (st.view === "setup") {
      if (main.dataset.view !== "setup") { main.dataset.view = "setup"; main.innerHTML = `<div class="sa-setup-host" data-sa-region></div>`; }
      safely(main.querySelector("[data-sa-region]"), setupHtml);
    } else {
      if (main.dataset.view !== "audit") {
        main.dataset.view = "audit";
        main.innerHTML = `<div class="sa-audit"><div class="sa-pane sa-left" data-sa-left></div><div class="sa-pane sa-right" data-sa-right></div></div>`;
      }
      safely(main.querySelector("[data-sa-left]"), logHtml);
      safely(main.querySelector("[data-sa-right]"), findingsHtml);
    }
    const composer = root.querySelector("[data-sa-composer]");
    composer.hidden = st.view !== "audit";
    const input = composer.querySelector("textarea");
    input.disabled = !!st.turn;
    composer.querySelector("button").disabled = !!st.turn;
    input.placeholder = st.reply?.done
      ? "Ask the agent to continue in any direction…"
      : "Tell the agent what to do next, or answer its question…";
    const status = root.querySelector("[data-sa-notice]");
    status.textContent = st.notice || (st.view === "audit" ? `Audit of ${st.computer || "this PC"} · ${agentName()} · ${st.ranAsAdmin ? "administrator" : "standard rights"} · log and report in ${st.dir}` : "");
  }

  /* ---------------------------------------------------------------- events */

  async function copy(what, button) {
    const [kind, id] = [what.slice(0, what.indexOf(":")), what.slice(what.indexOf(":") + 1)];
    let text = "";
    if (kind === "cmd" || kind === "out") { const row = st.log.find((r) => r.id === id); text = kind === "cmd" ? row?.cmd : row?.output; }
    if (kind === "fix") text = (findingById(id)?.fix?.commands || []).map((c) => `# ${c.step}\n${c.cmd}`).join("\n");
    if (kind === "trace") {
      const t = st.traces[id];
      const f = findingById(id);
      if (t) text = [`### Origin: ${f?.title}`, "", t.headline, "", ...t.timeline.map((s) => `- **${s.time}** ${s.label} — \`${s.detail}\` (${s.how})`), "", t.conclusion, "", `_${t.confidence}_`].join("\n");
    }
    if (!text) return;
    if (window.wintCopy?.copy) await window.wintCopy.copy(text, button).catch(() => {});
    else await navigator.clipboard?.writeText(text).catch(() => {});
  }

  function click(event) {
    const t = event.target;
    const get = (attr) => t.closest(`[data-sa-${attr}]`)?.getAttribute(`data-sa-${attr}`);

    const agent = get("agent");
    if (agent) { st.agent = agent; savePrefs(); return dirty(); }
    const rights = get("rights");
    if (rights) { st.elevated = rights === "admin"; savePrefs(); return dirty(); }
    const area = get("area");
    if (area) { st.scope = [area]; savePrefs(); if (area === "Stalls") loadStalls(); if (area === "Startup") loadStartup(); return dirty(); }

    const runId = get("run");
    if (runId) return openRun(runId);
    const delRun = get("delrun");
    if (delRun) return deleteRun(delRun);
    const logChip = get("log");
    if (logChip) { st.logFilter = logChip; return dirty(); }
    const areaChip = get("areachip");
    if (areaChip) { st.area = areaChip; return dirty(); }
    const row = get("row");
    if (row) { st.open.has(row) ? st.open.delete(row) : st.open.add(row); return dirty(); }
    const pick = get("pick");
    if (pick) { st.sel = st.sel === pick ? "" : pick; if (st.logFilter === "finding" && !st.sel) st.logFilter = "all"; return dirty(); }
    const openFinding = get("open");
    if (openFinding) { st.sel = openFinding; st.area = "all"; return dirty(); }
    const copyWhat = get("copy");
    if (copyWhat) return copy(copyWhat, t.closest("button"));

    const trace = get("trace");
    if (trace) { const f = findingById(trace); return send({ kind: "Trace", label: `Tracing the origin of “${f.title}”`, prompt: tracePrompt(f), finding: f.id }); }
    const untrace = get("untrace");
    if (untrace) { delete st.traces[untrace]; return dirty(); }
    const traceLog = get("tracelog");
    if (traceLog) { st.sel = traceLog; st.logFilter = "Trace"; return dirty(); }
    const fix = get("fix");
    if (fix) { const f = findingById(fix); return send({ kind: "Fix", label: `Applying “${f.fix.label}”`, prompt: fixPrompt(f), finding: f.id }); }
    const ask = get("ask");
    if (ask) {
      const cut = ask.lastIndexOf(":");
      const f = findingById(ask.slice(0, cut));
      const text = f?.asks[Number(ask.slice(cut + 1))];
      if (f && text) return send({ kind: "Agent", label: text, prompt: askPrompt(f, text), finding: f.id, ask: text });
    }
    const expect = get("expect");
    if (expect) {
      const f = findingById(expect);
      st.expected.add(expectedKey(f));
      st.findings = st.findings.filter((x) => x.id !== expect);
      st.sel = "";
      st.notice = `Marked as expected: ${f.title}. Later scans will leave it out.`;
      savePrefs();
      return dirty();
    }
    const hide = get("hide");
    if (hide) { st.hidden.add(hide); st.sel = ""; return dirty(); }
    const option = get("option");
    if (option !== null && option !== undefined) {
      const o = st.reply?.options?.[Number(option)];
      if (o) return say(`${o.label}${o.detail ? ` - ${o.detail}` : ""}`, o.changesSystem);
    }

    switch (t.closest("[data-sa]")?.dataset.sa) {
      case "start": return startScan();
      case "setup": st.view = "setup"; st.error = ""; return dirty();
      case "keep": st.view = "audit"; return dirty();
      case "history": st.view = "setup"; st.error = ""; return dirty();
      case "cancel": return cancel();
      case "agents": st.agents = null; dirty(); return loadAgents();
      case "passed": st.showPassed = !st.showPassed; return dirty();
      case "report": return exportFile("report.md", markdown());
      case "log": return exportFile("log.md", logText());
      case "raw": st.reply.summary = `${st.reply.summary}\n\n${st.reply.raw}`; st.reply.raw = ""; return dirty();
      case "retry": {
        const last = st.reply?.retry;
        if (!last) return;
        st.reply = null;
        if (last.kind === "Scan" && !st.findings.length) st.session = st.agent === "claude" ? crypto.randomUUID() : null;
        const f = findingById(last.finding);
        const prompt = last.kind === "Scan" ? scanPrompt() : last.kind === "Trace" ? tracePrompt(f) : last.kind === "Fix" ? fixPrompt(f) : f && last.ask ? askPrompt(f, last.ask) : followPrompt(`The user says: ${last.label}`);
        return send({ kind: last.kind, label: last.label, prompt, finding: last.finding, ask: last.ask, first: last.kind === "Scan" && !st.findings.length });
      }
    }
  }

  function submit(event) {
    const form = event.target.closest("[data-sa-askform]");
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector("input");
    const text = input.value.trim();
    const f = findingById(form.dataset.saAskform);
    if (!text || !f) return;
    send({ kind: "Agent", label: text, prompt: askPrompt(f, text), finding: f.id, ask: text }).then((sent) => {
      if (sent) { const again = root?.querySelector(`[data-sa-askform="${CSS.escape(f.id)}"] input`); if (again) again.value = ""; }
    });
  }

  function mount(node) {
    root = node;
    if (window.wintAuditHandoff) {
      const handed = window.wintAuditHandoff;
      window.wintAuditHandoff = null;
      importState(handed);
    }
    // The composer is built once per mount and never redrawn, so typing
    // survives every turn that streams in.
    root.innerHTML = `<div class="sa">
      <div data-sa-band></div>
      <div class="sa-main" data-sa-main></div>
      <form class="sa-composer" data-sa-composer hidden>
        <textarea rows="1" data-sa-say></textarea>
        <button type="submit" class="btn primary">${icon("send")}Send</button>
      </form>
      <div class="sa-statusbar" data-sa-notice></div></div>`;
    const composer = root.querySelector("[data-sa-composer]");
    const input = composer.querySelector("textarea");
    input.value = st.draft || "";
    input.addEventListener("input", () => { st.draft = input.value; });
    const sendDraft = async () => {
      const text = input.value.trim();
      if (!text || st.turn) return;
      if (await say(text)) {
        if (input.value.trim() === text) input.value = "";
        st.draft = input.value;
      }
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendDraft(); } });
    composer.addEventListener("submit", (e) => { e.preventDefault(); sendDraft(); });
    root.addEventListener("click", click);
    // A button replaced between mouse-down and mouse-up never receives the
    // click, so nothing is redrawn while a button is held.
    root.addEventListener("pointerdown", () => {
      holding = true;
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => { holding = false; if (held) { held = false; dirty(); } }, 1500);
    });
    if (!window.__saPointerUp) {
      window.__saPointerUp = true;
      const release = () => { if (!holding) return; holding = false; if (held) { held = false; dirty(); } };
      window.addEventListener("pointerup", release, true);
      window.addEventListener("pointercancel", release, true);
    }
    root.addEventListener("submit", submit);
    draw();
    if (st.turn) tick();
    setTimeout(() => {
      wire();
      if (!st.agents && !agentsLoading) loadAgents();
      if (!st.historyLoaded && !historyLoading) loadHistory();
      loadStalls();
      if (startupInScope()) loadStartup();
    }, 0);
  }

  /** Moving between the main window and a window of its own means a new copy
   *  of this file in a new webview. What it carries over is the audit itself -
   *  never its markup, which would be a dead picture of the tool. A step that
   *  is running keeps streaming: the events reach every window, and this copy
   *  takes over the rows.*/
  function exportState() {
    return {
      runId: st.runId, dir: st.dir, live: st.live, fresh: st.fresh, session: st.session, agent: st.agent,
      elevated: st.elevated, ranAsAdmin: st.ranAsAdmin, scope: st.scope, computer: st.computer,
      startedAt: st.startedAt, updatedAt: st.updatedAt, continuedFrom: st.continuedFrom || 0,
      scannedAt: st.scannedAt, scanSeconds: st.scanSeconds, findings: st.findings, passed: st.passed,
      traces: st.traces, threads: st.threads, log: st.log, reply: st.reply ? { ...st.reply, retry: undefined } : null,
      stallMark: st.stallMark, view: st.view, sel: st.sel, area: st.area, logFilter: st.logFilter, showPassed: st.showPassed,
      open: [...st.open], hidden: [...st.hidden], expected: [...st.expected], draft: st.draft, notice: st.notice,
      turn: st.turn ? { run: st.turn.run, kind: st.turn.kind, label: st.turn.label, finding: st.turn.finding, ask: st.turn.ask, started: st.turn.started, activity: st.turn.activity, notes: st.turn.notes, text: st.turn.text, pending: st.turn.pending, note: st.turn.note, cancelled: st.turn.cancelled } : null,
    };
  }

  function importState(state) {
    if (!state || typeof state !== "object") return;
    const { open, hidden, expected, turn, ...rest } = state;
    Object.assign(st, rest);
    st.open = new Set(Array.isArray(open) ? open : []);
    st.hidden = new Set(Array.isArray(hidden) ? hidden : []);
    st.expected = new Set(Array.isArray(expected) ? expected : []);
    st.turn = turn ? { ...turn, rows: st.log.filter((r) => r.kind !== "note" && String(r.id).startsWith(`${turn.run}-`)), calls: new Map() } : null;
    if (st.turn) { work(`Security Sweep · ${agentName()}: ${st.turn.label}`); tick(); }
  }

  window.wintSecurityAudit = { mount, exportState, importState };
})();
