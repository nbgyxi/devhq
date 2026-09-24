// Torrents: the page over the engine that runs in its own process.
//
// Nothing here does any torrent work. `torrent.rs` supervises a helper
// executable and forwards one aggregate snapshot every 300ms; this file is a
// view of that snapshot and nothing else. Every button sends a command and
// returns immediately — what actually happened shows up in the next snapshot,
// so a click is never waiting on a tracker or a disk.
//
// Three rules shape the drawing:
//
//  * The shell is built once. Snapshots update text in place, never
//    `innerHTML` over a region, so the selection, the scroll position and a
//    half-typed magnet link all survive.
//  * The lists are virtualized. A torrent with 40,000 files, or a session with
//    hundreds of torrents, costs the same number of DOM nodes as one with ten.
//  * The engine is a thing that can fail. When it stops answering the page
//    says so and offers to restart it, rather than quietly showing stale rows.

(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name) => window.wintShell?.icon?.(name) || `<span class="ms" aria-hidden="true">${name}</span>`;

  /** One row's height, in pixels. Fixed, because that is what lets the list be
   *  virtualized without measuring anything. Kept in step with `.tr-row` in
   *  styles.css. */
  const ROW = 34;
  const FILE_ROW = 28;
  const UI_CRASH_KEY = "wint:torrent-ui-crash";
  /** Where the table's own shape is kept — which columns are shown, in what
   *  order, how wide, and what it is sorted by. This goes to the backend and
   *  not to `localStorage`: that is flushed to disk whenever WebView2 gets
   *  round to it, so a column dragged to a new width just before the window
   *  closed came back at the old one. */
  const LAYOUT_KEY = "torrent-layout";
  const COLUMNS = [
    ["mark", "Mark", "48px"],
    ["name", "Name", "minmax(0,1fr)"], ["size", "Size", "80px"],
    ["done", "Done", "120px"], ["status", "Status", "150px"],
    ["completed", "Completed", "136px"], ["down", "Down", "84px"],
    ["up", "Up", "84px"], ["peers", "Connected", "72px"],
    ["remaining", "Remaining", "86px"], ["eta", "ETA", "82px"],
    ["uploaded", "Uploaded", "86px"], ["ratio", "Ratio", "62px"],
    ["known", "Known peers", "82px"], ["folder", "Folder", "120px"],
  ];
  const ALL_COLUMN_IDS = COLUMNS.map(([id]) => id);
  const DEFAULT_COLUMNS = ["mark", "name", "size", "done", "status", "completed", "down", "up", "folder"];
  /** Oldest completion first, which puts everything still running at the
   *  bottom — an unfinished torrent has no date, so it sorts as one still to
   *  come. See `sortedRows`. */
  const DEFAULT_SORT = { id: "completed", direction: "asc" };
  /** The columns to show, in the user's order. A saved layout records which
   *  columns were switched *off*, so a column that did not exist when it was
   *  written is simply one nobody has switched off: it shows, in the place
   *  this list puts it. Nothing has to be migrated, and unticking it sticks. */
  function usableColumns(saved, hidden) {
    // A layout from before that rule says nothing about what was switched off,
    // so there is no telling a column someone dropped from one that had not
    // been written yet. Those start again from the defaults — a column picker
    // is two clicks — rather than coming back with all thirteen showing.
    if (!Array.isArray(hidden)) return DEFAULT_COLUMNS;
    const order = Array.isArray(saved) ? saved.filter((id) => ALL_COLUMN_IDS.includes(id)) : [];
    if (!order.length) return DEFAULT_COLUMNS;
    const off = new Set(hidden);
    for (const id of ALL_COLUMN_IDS) {
      if (order.includes(id) || off.has(id)) continue;
      // Next to the columns it sits between in COLUMNS, so a new column turns
      // up where it was meant to rather than tacked onto the end.
      const before = ALL_COLUMN_IDS.slice(0, ALL_COLUMN_IDS.indexOf(id))
        .reverse().find((other) => order.includes(other));
      order.splice(before ? order.indexOf(before) + 1 : 0, 0, id);
    }
    return order;
  }

  /** Reads the table's shape back from disk. Called once, on mount; the table
   *  draws with the defaults until it answers, which is one frame's worth. */
  function loadLayout() {
    return invoke("ui_state_get", { key: LAYOUT_KEY })
      .then((saved) => {
        const layout = saved && typeof saved === "object" ? saved : {};
        st.columns = usableColumns(layout.columns, layout.hidden);
        st.columnWidths = layout.widths && typeof layout.widths === "object" ? layout.widths : {};
        const sort = layout.sort
          && ALL_COLUMN_IDS.includes(layout.sort.id)
          && ["asc", "desc"].includes(layout.sort.direction)
          ? layout.sort : null;
        // Only a table nobody has arranged yet falls back to the default sort;
        // one that was saved without a sort was sorted by nothing on purpose.
        st.columnSort = sort || (saved ? null : DEFAULT_SORT);
        if (!saved) saveLayout();
        drawColumns();
        drawRows();
      })
      .catch((error) => console.warn("The torrent column layout could not be read", error));
  }

  /** Writes the table's shape. Called the moment something about it changes —
   *  a column switched on, dropped in a new place, let go after a drag, or a
   *  heading clicked — so there is nothing left to lose at shutdown. */
  function saveLayout() {
    return invoke("ui_state_set", {
      key: LAYOUT_KEY,
      value: {
        columns: st.columns,
        hidden: ALL_COLUMN_IDS.filter((id) => !st.columns.includes(id)),
        widths: st.columnWidths,
        sort: st.columnSort,
      },
    }).catch((error) => note(`The column layout could not be saved: ${error}`));
  }

  /** Reads the ticked-off info hashes back from disk. Called once, on mount;
   *  until it answers the boxes simply draw unticked. */
  function loadMarks() {
    return invoke("torrent_marks")
      .then((hashes) => {
        if (!Array.isArray(hashes)) return;
        // A tick made while this was in flight wins over what was on disk.
        for (const hash of hashes) if (!st.markCleared.has(hash)) st.marks.add(hash);
        drawRows();
      })
      .catch((error) => console.warn("Torrent marks could not be read", error));
  }

  /** Rows drawn above and below the viewport, so a fast scroll does not show
   *  blank space before the next frame. */
  const OVERSCAN = 6;

  const st = {
    host: null,
    tab: "transfers",
    engine: { state: "stopped" },
    /** The app's version, for the diagnostics people paste. This tool runs in
     * a webview of its own, which does not load `changelog.js`, so the global
     * the rest of the app reads is not there — it is asked for instead. */
    appVersion: null,
    /** When the engine's resume last got a torrent further. A start-up that is
     * slow says a bigger number every so often; one that is stuck says the
     * same number forever, and only the clock can tell them apart. */
    resumeMovedAt: 0,
    resumeMark: "",
    /** The newest snapshot. Replaced wholesale; never appended to. */
    snap: null,
    /** Shell-opened files shown before the engine has finished accepting them. */
    pendingAdds: [],
    pendingSequence: 0,
    /** Torrent id the detail pane is showing. */
    selected: null,
    /** All selected torrent ids. `selected` is the focused item whose files
     * are shown; this set drives bulk actions. */
    selectedIds: new Set(),
    selectionAnchor: null,
    /** The file list for `selected`, fetched once per selection. */
    details: null,
    detailsFor: null,
    detailsBusy: false,
    /** How the contents are ordered, and the files' own indices in that
     *  order. See `orderFiles`. */
    fileSort: { key: "name", dir: 1 },
    fileOrder: [],
    /** Which files are picked out in the contents list, by the files' own
     *  indices, and the row a Shift-click measures from. */
    fileSelection: new Set(),
    fileAnchor: null,
    /** Set while a command is in flight, so the buttons can say so. */
    busy: "",
    notice: "",
    /** When the last snapshot arrived, and whether the page has already said
     *  that they stopped coming. The page watches for silence itself rather
     *  than trusting the backend to report its own trouble: if the supervisor
     *  is the thing that is stuck, no event it would have sent ever arrives. */
    lastSnapshotAt: 0,
    engineStartedAt: 0,
    quiet: false,
    tick: 0,
    settings: null,
    /** Seconds since the engine's own state was last asked for. See the tick. */
    statusPolls: 0,
    listenRetries: 0,
    /** Whether the troubleshooting panel is unfolded. Redraws restore it. */
    diagOpen: false,
    /** What the drives have left, and when it was last asked for. Null until
     *  the first answer: with nothing to compare against, the page says
     *  nothing rather than guessing. */
    drives: null,
    spaceTick: 0,
    /** What Windows makes of `.torrent` and `magnet:` — see `refreshAssoc`.
     *  Null until the first answer; the ask strip stays out of the way until
     *  then rather than flashing a question that may not apply. */
    assoc: null,
    assocBusy: false,
    assocTried: false,
    assocFocusBound: false,
    listening: false,
    unlisten: [],
    recoveryTimer: 0,
    columns: DEFAULT_COLUMNS,
    columnWidths: {},
    columnSort: DEFAULT_SORT,
    /** Info hashes the user has ticked off in the list, and the ones unticked
     *  in this session — the latter so a slow read cannot bring one back. */
    marks: new Set(),
    markCleared: new Set(),
    /** The row a Shift-tick measures from. */
    markAnchor: null,
    draggedColumn: null,
    columnDragged: false,
  };

  function recoverView(error) {
    console.error("Torrent view failed", error);
    // The console belongs to this webview alone and is almost never open when
    // it matters; the health log outlives the window.
    window.wintErrorLog?.report("torrent view failed", error);
    const now = Date.now();
    let previous = 0;
    let canRemember = true;
    try { previous = Number(sessionStorage.getItem(UI_CRASH_KEY)) || 0; } catch { canRemember = false; }
    if (canRemember && (!previous || now - previous >= 60000)) {
      try {
        sessionStorage.setItem(UI_CRASH_KEY, String(now));
        window.location.reload();
        return;
      } catch { /* fall through to the manual recovery control */ }
    }

    // A second failure soon after an automatic reload is not healed by
    // reloading forever. Leave a usable, explicit recovery action instead.
    const host = st.host;
    if (!host) return;
    host.innerHTML = `<div class="tr-page"><div class="tr-banner bad tr-ui-failed">
      ${icon("error")}<span>The torrent view failed again. The engine and downloads can continue in the background.</span>
      <button type="button" class="btn" data-tr-refresh>${icon("refresh")}<span>Reload the view</span></button>
    </div></div>`;
    host.querySelector("[data-tr-refresh]")?.addEventListener("click", () => window.location.reload());
  }

  function guarded(action) {
    return (event) => {
      try { return action(event); } catch (error) { recoverView(error); }
    };
  }

  // ------------------------------------------------------------------ format

  function bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB", "PB"];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
  }

  function speed(n) {
    return Number(n) > 0 ? `${bytes(n)}/s` : "—";
  }

  function eta(seconds) {
    if (seconds == null || !isFinite(seconds)) return "";
    if (seconds < 60) return `${Math.round(seconds)}s left`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
    if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h left`;
    return `${Math.round(seconds / 86400)} d left`;
  }

  /** What a row's status column says, in words rather than engine states. */
  function statusWords(row) {
    // Checked ahead of everything else: a torrent whose files have been
    // deleted must never sit there claiming to seed them.
    if (row.state === "missing") return { text: "Files missing", tone: "bad" };
    if (row.state === "adding") return { text: "Adding…", tone: "warn" };
    if (row.state === "needs-check") return { text: "File state changed", tone: "warn" };
    if (row.state === "error") return { text: row.error || "Error", tone: "bad" };
    if (row.state === "initializing") return { text: "Checking files", tone: "warn" };
    if (row.state === "check-queued") return { text: "Waiting to check", tone: "muted" };
    // Known from the saved torrents, not yet read back into the engine. The
    // row is real - name, size, folder - but nothing about its progress is
    // known until the engine gets to it.
    if (row.state === "waiting") return { text: "Waiting for the engine", tone: "muted" };
    if (row.state === "queued") return { text: "Waiting its turn", tone: "muted" };
    if (row.state === "paused") return { text: "Paused", tone: "muted" };
    if (row.forceStarted && !row.finished) return { text: "Force downloading", tone: "" };
    if (row.finished) return { text: "Seeding", tone: "good" };
    if (!row.peers && row.peersQueued) return { text: "Connecting to peers", tone: "muted" };
    if (!row.peers) return { text: "Finding peers", tone: "muted" };
    const left = eta(row.etaSeconds);
    return { text: left || "Downloading", tone: "" };
  }

  function completedAt(value) {
    if (!value) return "—";
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    }).format(new Date(value));
  }

  function percent(row) {
    if (!row.totalBytes) return 0;
    return Math.min(100, (row.progressBytes / row.totalBytes) * 100);
  }

  // ------------------------------------------------------------------- shell

  function mount(node) {
    st.host = node;
    clearTimeout(st.recoveryTimer);
    st.recoveryTimer = setTimeout(() => {
      if (!st.host?.isConnected) return;
      try { sessionStorage.removeItem(UI_CRASH_KEY); } catch { /* unavailable */ }
    }, 60000);
    node.innerHTML = `
      <div class="tr-page">
        <div class="tr-banner" data-tr-banner hidden></div>
        <div class="tr-ask" data-tr-ask hidden></div>
        <div class="tr-tabs" role="tablist">
          <button type="button" class="tr-tab on" data-tr-tab="transfers" role="tab">Transfers</button>
          <button type="button" class="tr-tab" data-tr-tab="settings" role="tab">Settings</button>
          <button type="button" class="tr-tab" data-tr-tab="engine" role="tab">Engine</button>
          <div class="tr-top-add">
            ${icon("add_link")}
            <input type="text" class="tr-magnet" data-tr-magnet spellcheck="false"
                   placeholder="Paste a magnet link" />
          </div>
          <button type="button" class="btn tr-choose" data-tr-browse>${icon("folder_open")}<span>Choose a file…</span></button>
          <span class="tr-count" data-tr-count></span>
          <span class="tr-note" data-tr-note></span>
          <div class="tr-column-control">
            <button type="button" class="btn" data-tr-columns>${icon("tune")}<span>Columns</span></button>
            <div class="tr-column-picker" data-tr-column-picker hidden></div>
          </div>
        </div>

        <section class="tr-view" data-tr-view="transfers">
          <div class="tr-banner bad tr-space" data-tr-space hidden></div>
          <div class="tr-work">
            <div class="tr-list" data-tr-list>
              <div class="tr-head" data-tr-head></div>
              <div class="tr-scroll" data-tr-scroll>
                <div class="tr-spacer" data-tr-spacer></div>
                <div class="tr-rows" data-tr-rows></div>
              </div>
              <div class="tr-empty" data-tr-empty hidden></div>
            </div>

            <!-- Beside the table, not under it: the contents of whichever
                 torrent is selected. Hidden when nothing is, and the table
                 takes the whole width back. -->
            <section class="tr-detail" data-tr-detail hidden></section>
          </div>
        </section>

        <section class="tr-view" data-tr-view="settings" hidden></section>
        <section class="tr-view tr-engineview" data-tr-view="engine" hidden></section>
        <div class="tr-drop-overlay" data-tr-drop-overlay hidden>
          ${icon("download")}<strong>Drop .torrent files anywhere</strong><span>They will start right away</span>
        </div>
      </div>`;

    node.addEventListener("click", guarded(click));
    node.addEventListener("keydown", guarded(keydown));
    node.addEventListener("pointerdown", guarded(startColumnResize));
    node.addEventListener("pointerdown", guarded(startColumnReorder));
    node.addEventListener("contextmenu", (event) => {
      const file = event.target.closest("[data-tr-file]");
      if (file) {
        event.preventDefault();
        return void openFileMenu(event, Number(file.dataset.trFile));
      }
      const el = event.target.closest("[data-tr-id]");
      if (!el) return;
      const row = (st.snap?.torrents || []).find((x) => x.id === Number(el.dataset.trId));
      if (!row) return;
      event.preventDefault();
      if (!st.selectedIds.has(row.id)) selectTorrent(row.id, event);
      openMenu(event, row);
    });
    node.addEventListener("dblclick", (event) => {
      const file = event.target.closest("[data-tr-file]");
      if (!file || event.target.matches(".tr-fcheck")) return;
      event.preventDefault();
      openFile(Number(file.dataset.trFile));
    });
    // Unfolding the troubleshooting panel is remembered, so a redraw that has
    // to happen does not fold it shut again while it is being read.
    node.addEventListener("toggle", (event) => {
      if (event.target.classList?.contains("tr-diagnostics")) st.diagOpen = event.target.open;
    }, true);
    node.querySelector("[data-tr-scroll]").addEventListener("scroll", () => drawRows(), { passive: true });

    drawColumns();
    loadLayout();
    loadMarks();
    listen();
    if (!st.assocFocusBound) {
      st.assocFocusBound = true;
      window.addEventListener("focus", () => {
        if (st.host?.isConnected) refreshAssoc();
      });
    }
    drawBanner();
    drawSkeleton();
    // What the shell may already have handed over, and what Windows makes of
    // torrents today. Both are one call each and neither blocks the mount.
    drainPending();
    refreshAssoc();
    refreshDrives();
    clearInterval(st.spaceTick);
    st.spaceTick = setInterval(() => {
      if (!st.host?.isConnected) return clearInterval(st.spaceTick);
      refreshDrives();
    }, 30000);

    // The page's own pulse. It exists only to notice that nothing is arriving
    // and to say so; it draws no torrent data, so it costs the same whether
    // there is one torrent or a thousand.
    clearInterval(st.tick);
    st.tick = setInterval(() => {
      if (!st.host?.isConnected) return clearInterval(st.tick);
      const running = st.engine?.state === "running" || st.engine?.state === "starting";
      const heardAt = st.lastSnapshotAt || st.engineStartedAt;
      // A helper that has not finished building its session sends no
      // snapshots at all, and "starting" covers the window before its first
      // heartbeat has even said so. Neither is silence.
      const resuming = st.engine?.phase === "resuming" || st.engine?.state === "starting";
      const silent = running && !resuming && heardAt > 0 && Date.now() - heardAt > 4000;
      // Anything other than a running engine is asked about again every few
      // seconds. The page can be left holding a stale or mistaken view — a
      // start-up call that timed out while the engine was busy coming up, a
      // broadcast that arrived before this window was listening — and without
      // this it would sit there behind a Restart button for an engine that is
      // running perfectly well.
      if (st.engine?.state !== "running" && ++st.statusPolls >= 3) {
        st.statusPolls = 0;
        refreshStatus();
      }
      // No event bridge means no snapshot can ever arrive, and the page would
      // sit empty in front of a perfectly healthy engine. Registering again
      // costs nothing and asks the engine for nothing; a handful of attempts,
      // because a bridge that is not there after that is not coming.
      if (!st.unlisten.length && st.listenRetries < 5 && Date.now() - st.engineStartedAt > 10000) {
        st.listenRetries += 1;
        st.listening = false;
        listen();
      }
      if (running && silent !== st.quiet) {
        st.quiet = silent;
        drawBanner();
        if (silent) invoke("torrent_status")
          .then((engine) => { st.engine = engine; drawBanner(); })
          .catch(() => {});
      }
    }, 1000);
    // Bring the engine up. Until it answers, the list shows skeletons; the
    // page is interactive the whole time.
    st.engineStartedAt = Date.now();
    if (!st.appVersion) invoke("app_version").then((v) => { st.appVersion = String(v || ""); }).catch(() => {});
    invoke("torrent_start")
      .then((engine) => { st.engine = engine; drawBanner(); })
      // Only the message. Replacing the whole status with an invented one
      // threw away the pid, the uptime and the restart count and put
      // "Not running · No process ID" under a banner about a call that timed
      // out — which is not the same thing as an engine that is not there.
      .catch((error) => { st.engine = { ...st.engine, message: String(error) }; drawBanner(); refreshStatus(); });
    invoke("torrent_status").then((engine) => { st.engine = engine; drawBanner(); }).catch(() => {});
  }

  function listen() {
    if (st.listening) return;
    st.listening = true;
    const events = window.__TAURI__.event;
    try {
      events.listen("torrent:snapshot", (event) => {
        if (!st.host?.isConnected) return;
        st.snap = event.payload;
        st.lastSnapshotAt = Date.now();
        if (st.quiet) { st.quiet = false; drawBanner(); }
        // Data arriving is proof the engine is up, whatever the page was last
        // told. Ask once for the real status rather than waiting for a tick.
        if (st.engine?.state !== "running") refreshStatus();
        if (!st.settings) st.settings = { ...st.snap.settings };
        draw();
      }).then((off) => st.unlisten.push(off)).catch(() => {});
      // The shell handed a torrent to the WinT that was already running.
      // The payload carries nothing: what arrived is queued in the backend,
      // and this is only the nudge to come and get it.
      events.listen("torrent:open", () => {
        if (!st.host?.isConnected) return;
        drainPending();
      }).then((off) => st.unlisten.push(off)).catch(() => {});
      events.listen("torrent:engine", (event) => {
        if (!st.host?.isConnected) return;
        st.engine = event.payload || st.engine;
        drawBanner();
      }).then((off) => st.unlisten.push(off)).catch(() => {});
    } catch { /* no event bridge in this window */ }

    // Choosing a default happens in Windows' own Settings app, so the only
    // sign that it changed is this window getting the focus back.
    window.addEventListener("focus", () => {
      if (st.host?.isConnected) refreshAssoc();
    });

    // A .torrent dragged in from Explorer arrives as a Tauri drag-drop event,
    // which is the only form that carries a real path. The webview's own
    // HTML5 drop gives a File with no path the engine could open.
    const webview = window.__TAURI__.webview?.getCurrentWebview?.();
    if (webview?.onDragDropEvent) {
      webview.onDragDropEvent(({ payload }) => {
        const host = st.host;
        if (!host?.isConnected || !host.offsetParent) return;
        const overlay = host.querySelector("[data-tr-drop-overlay]");
        if (payload.type === "enter" || payload.type === "over") {
          overlay.hidden = false;
          return;
        }
        overlay.hidden = true;
        if (payload.type !== "drop") return;
        const files = (payload.paths || []).filter((p) => /\.torrent$/i.test(p));
        if (!files.length) return note("Only .torrent files can be dropped here.");
        addFiles(files);
      }).then((off) => st.unlisten.push(off)).catch(() => {});
    }
  }

  // ------------------------------------------------------------------ drawing

  function draw() {
    if (!st.host?.isConnected) return;
    // A snapshot is data from another process. If one ever arrives in a shape
    // this page does not expect, the throw must not take the page's next
    // update with it — the list would freeze on stale rows with no way back.
    try {
      if (st.tab === "transfers") {
        drawRows();
        drawSpace();
        drawDetail();
      } else if (st.tab === "engine") {
        drawEngine();
      } else {
        drawSettings();
      }
      drawCount();
    } catch (error) {
      recoverView(error);
    }
  }

  function drawCount() {
    const el = st.host.querySelector("[data-tr-count]");
    if (!el) return;
    const rows = [...st.pendingAdds, ...(st.snap?.torrents || [])];
    if (!rows.length) return void (el.textContent = "");
    const downloading = rows.filter((r) => !r.finished && r.state === "live").length;
    const seeding = rows.filter((r) => r.finished && r.state === "live").length;
    el.textContent = `${rows.length} torrent${rows.length === 1 ? "" : "s"} · ${downloading} downloading · ${seeding} seeding`;
  }

  /** Named, greyed placeholders while the first snapshot is still coming, so
   *  it is obvious the list is loading rather than empty. */
  function drawSkeleton() {
    const rows = st.host.querySelector("[data-tr-rows]");
    if (!rows || st.snap) return;
    rows.style.transform = "translateY(0)";
    rows.innerHTML = Array.from({ length: 5 }, () => '<div class="tr-row tr-skeleton"></div>').join("");
    st.host.querySelector("[data-tr-spacer]").style.height = `${5 * ROW}px`;
  }

  /** The drive a path is on, as `D:`. A UNC path is on no drive this can ask
   *  about, so it is left out of the sum entirely rather than guessed at. */
  function driveOf(path) {
    return /^[A-Za-z]:/.test(path || "") ? path.slice(0, 2).toUpperCase() : null;
  }

  /** Warns when finishing everything on a drive would need more room than the
   *  drive has. Counted per drive, because torrents can be going to several,
   *  and it is the one that runs out that matters — not the total.
   *
   *  What is counted is what is still to be written: total size less what is
   *  already on disk, for every torrent that has not finished. Paused and
   *  queued ones count too — they are still going to want the room. */
  function drawSpace() {
    const el = st.host?.querySelector("[data-tr-space]");
    if (!el) return;
    const needed = new Map();
    for (const row of st.snap?.torrents || []) {
      if (row.finished) continue;
      const remaining = Math.max(0, (row.totalBytes || 0) - (row.progressBytes || 0));
      const drive = driveOf(row.outputFolder);
      if (!remaining || !drive) continue;
      needed.set(drive, (needed.get(drive) || 0) + remaining);
    }
    const short = (st.drives || [])
      .map((drive) => ({
        label: drive.label || driveOf(drive.path) || drive.path,
        free: Number(drive.freeBytes) || 0,
        need: needed.get(driveOf(drive.path)) || 0,
      }))
      .filter((drive) => drive.need > drive.free)
      .sort((a, b) => (b.need - b.free) - (a.need - a.free));
    el.hidden = !short.length;
    if (!short.length) return;
    const sentence = short
      .map((drive) => `${drive.label} needs ${bytes(drive.need)} and has ${bytes(drive.free)} free — ${bytes(drive.need - drive.free)} short`)
      .join("; ");
    el.innerHTML = `${icon("warning")}<span>Not enough room to finish everything: ${esc(sentence)}. Downloads will fail as the disk fills up.</span>`;
  }

  /** How much room the drives have left. Asked for on mount and every half
   *  minute after — it is a handful of Win32 calls, and free space moves
   *  while downloads run. */
  function refreshDrives() {
    return invoke("disk_space_drives")
      .then((drives) => { st.drives = Array.isArray(drives) ? drives : []; drawSpace(); })
      .catch((error) => console.warn("Drive space could not be read", error));
  }

  /** ------------------------------------------------------------------
   *  Recovering, and what recovery is allowed to cost
   *
   *  The page must come back on its own from every wrong or stale view it can
   *  end up holding — a call that timed out, a broadcast that arrived before
   *  this window was listening, an event bridge that never came up. It does
   *  that by *asking*: `torrent_status` reads a struct WinT already has and
   *  touches neither the disk nor the helper.
   *
   *  What recovery must never do is set the engine working. Restarting it or
   *  rechecking a torrent means reading every saved torrent and hashing what
   *  is on disk — minutes of it — so those stay behind the buttons the user
   *  presses. A page that healed itself by kicking off that work would turn a
   *  cosmetic error into a real one, over and over.
   *  ------------------------------------------------------------------ */

  /** Asks the backend what the engine is really doing and redraws. The page
   *  never decides this for itself: the backend owns the engine. */
  function refreshStatus() {
    return invoke("torrent_status")
      .then((engine) => { if (engine) { st.engine = engine; drawBanner(); } })
      .catch(() => { /* asked again on the next tick */ });
  }

  /** What the engine is doing, in short phrases. Read by the panel and by the
   *  copy button, so what is pasted is exactly what was on screen. */
  function diagnosticFacts() {
    const s = st.engine || {};
    return [
      s.pid ? `PID ${s.pid}` : "No process ID",
      s.uptimeMs != null ? `Uptime ${Math.round(s.uptimeMs / 1000)}s` : "Not running",
      s.lastBeatMs != null ? `Heartbeat ${Math.round(s.lastBeatMs / 1000)}s ago` : "No heartbeat",
      s.lastSnapshotMs != null ? `Snapshot ${Math.round(s.lastSnapshotMs / 1000)}s ago` : "No snapshot",
      `${Number(s.pendingRequests) || 0} pending requests`,
      `${bytes(s.memoryBytes)} memory`,
      `${Number(s.restarts) || 0} restarts`,
      resumeProgress(s),
    ].filter(Boolean);
  }

  /** Everything worth handing to whoever has to work out what went wrong, as
   *  plain text: what this page is looking at, what the engine says about
   *  itself, and the engine's own recent output. */
  function diagnosticReport() {
    const s = st.engine || {};
    const rows = st.snap?.torrents || [];
    return [
      `WinT Torrents diagnostics — ${new Date().toISOString()}`,
      `App version: ${st.appVersion || window.wintChangelog?.current || "unknown"}`,
      `Engine state: ${s.state || "unknown"}${s.phase ? ` (${s.phase})` : ""}`,
      s.engine ? `Engine build: ${s.engine}` : null,
      engineBuild() ? `Engine program: ${engineBuild()}` : null,
      s.message ? `Message: ${s.message}` : null,
      diagnosticFacts().join(" · "),
      `Torrents: ${rows.length}${st.snap ? "" : " (no snapshot yet)"}`,
      ...rows.map((row) => `  ${row.state} · ${percent(row).toFixed(0)}% · ${
        bytes(row.totalBytes)} · ${row.name}`),
      "",
      ...(Array.isArray(s.diagnostics) ? s.diagnostics : []),
    ].filter((line) => line != null).join(String.fromCharCode(10));
  }

  /** Writes the banner only when its contents have actually changed.
   *
   *  The banner is redrawn on every engine event and every status check, and
   *  an `innerHTML` assignment destroys and rebuilds everything under it —
   *  which drops the selection the user was making and folds the
   *  troubleshooting panel shut. Almost every redraw says exactly what the
   *  last one said, so almost every redraw can be skipped. */
  /** How long a start-up may make no progress at all before the page stops
   *  calling it work in hand. Resuming one very large torrent legitimately
   *  takes many minutes, so this is far longer than any single hash check the
   *  page should have to explain. */
  const RESUME_STUCK_MS = 10 * 60 * 1000;

  /** Is the engine coming up rather than failing? `starting` is WinT's own
   *  word for a helper it has spawned and not yet heard `ready` from;
   *  `resuming` is the helper's word for what it is doing while it reads the
   *  saved torrents. Either means work in hand, and neither is an error. */
  function isStarting(s) {
    return s.phase === "resuming" || (s.state === "starting" && !st.lastSnapshotAt);
  }

  /** `9 of 16 saved torrents read`, while that is what is happening. */
  function resumeProgress(s) {
    if (!isStarting(s) || !s.resuming) return null;
    return `${s.resumed || 0} of ${s.resuming} saved torrents read`;
  }

  /** Notices that the resume got somewhere, so a start-up that has genuinely
   *  stopped moving can be told from one that is merely long. */
  function trackResume(s) {
    if (!isStarting(s)) { st.resumeMovedAt = 0; st.resumeMark = ""; return; }
    const mark = `${s.resumed || 0}/${s.resuming || 0}`;
    if (mark !== st.resumeMark || !st.resumeMovedAt) {
      st.resumeMark = mark;
      st.resumeMovedAt = Date.now();
    }
  }

  let bannerHtml = null;
  function setBanner(el, html) {
    if (bannerHtml === html) return;
    bannerHtml = html;
    el.innerHTML = html;
  }

  function drawBanner() {
    const el = st.host?.querySelector("[data-tr-banner]");
    if (!el) return;
    const s = st.engine || {};
    trackResume(s);
    if (st.tab === "engine") drawEngine();
    // How many of the saved torrents the engine has still to read back in.
    // They are already in the list as rows of their own; this is only the line
    // that explains why some of them say nothing about their progress yet.
    const pending = Number(st.snap?.resuming) || 0;
    const diagnostics = () => {
      const lines = Array.isArray(s.diagnostics) ? s.diagnostics : [];
      // Kept open across redraws. This panel is read while the engine is in
      // trouble, which is exactly when the status keeps changing underneath
      // it — and a panel that shut itself every few seconds could not be
      // read at all, let alone have its text selected.
      return `<details class="tr-diagnostics"${st.diagOpen ? " open" : ""}><summary>Troubleshooting details</summary>
        <div class="tr-diag-facts"><span>${esc(diagnosticFacts().join(" · "))}</span><button type="button" class="btn" data-tr-copy-diag title="Copy these details">${icon("content_copy")}<span>Copy</span></button></div>
        ${lines.length ? `<pre>${esc(lines.join("\n"))}</pre>` : ""}</details>`;
    };
    // Busy, not silent. While the engine rebuilds its session it reads every
    // saved torrent and checks what is already on disk, which on a long list
    // takes minutes and produces no snapshots at all. It keeps beating
    // throughout, so the page can say what the wait is for instead of warning
    // that updates have stopped.
    if (isStarting(s)) {
      el.hidden = false;
      const stuck = st.resumeMovedAt > 0 && Date.now() - st.resumeMovedAt > RESUME_STUCK_MS;
      el.className = "tr-banner";
      const progress = s.resuming
        ? `reading ${s.resumed || 0} of ${s.resuming} saved torrent${s.resuming === 1 ? "" : "s"}`
        : "reading the saved torrents";
      const at = s.resumingName ? ` Last one through: ${esc(s.resumingName)}.` : "";
      setBanner(el, stuck
        // Slow is normal; not having moved for this long is not, and the page
        // says which it is rather than leaving an hourglass to be guessed at.
        ? `${icon("warning")}<span>The torrent engine has been starting for ${
            Math.round((Date.now() - st.resumeMovedAt) / 60000)
          } minutes without getting any further — ${progress}.${at} Restarting it begins the same work again; the saved torrents are not lost either way.</span>
          <button type="button" class="btn" data-tr-restart>${icon("restart_alt")}<span>Restart the engine</span></button>
          ${diagnostics()}`
        : `${icon("hourglass_top")}<span>The torrent engine is starting: ${progress} and checking the files already on disk. Files are hash-checked one at a time per drive, so a long queue takes minutes.${at} The list fills in when it finishes.</span>
          ${diagnostics()}`);
      return;
    }

    // Resuming outranks the silence check. Reading a saved torrent back in
    // blocks the engine's own thread for as long as its files take to check,
    // so snapshots can be seconds apart while it works - and warning that
    // updates had stopped, over a list that was visibly filling in, was the
    // page mistaking the work for its absence.
    // Gone quiet, but still nominally up: the numbers on screen have stopped
    // being true and the page says so rather than letting them sit there
    // looking live. The list stays on screen and stays clickable throughout.
    if (st.quiet && !pending && (s.state === "running" || s.state === "starting")) {
      el.hidden = false;
      el.className = "tr-banner";
      setBanner(el, `${icon("warning")}<span>${st.lastSnapshotAt
        ? "No updates have arrived from the torrent engine. The list below may be stale."
        : "The torrent engine started, but it has not sent any torrent data."}</span>
        <button type="button" class="btn" data-tr-restart>${icon("restart_alt")}<span>Restart the engine</span></button>
        ${diagnostics()}`);
      return;
    }
    if (pending > 0 && (s.state === "running" || s.state === "starting")) {
      el.hidden = false;
      el.className = "tr-banner tr-banner-quiet";
      setBanner(el, `${icon("hourglass_top")}<span>Reading ${pending} more saved torrent${
        pending === 1 ? "" : "s"
      } back in - the rows waiting for the engine below. Everything already read back is live, and each shows its own progress while its files are checked.</span>`);
      return;
    }
    if (s.state === "running" || s.state === "starting") {
      el.hidden = true;
      setBanner(el, "");
      return;
    }
    const message = s.message
      || (s.state === "stopped" ? "The torrent engine is not running." : "The torrent engine is not responding.");
    el.hidden = false;
    el.className = `tr-banner ${s.state === "failed" || s.state === "not-responding" ? "bad" : ""}`;
    setBanner(el, `${icon("warning")}<span>${esc(message)}</span>
      <button type="button" class="btn" data-tr-restart>${icon("restart_alt")}<span>Restart the engine</span></button>
      ${diagnostics()}`);
  }

  function note(text) {
    st.notice = text;
    const el = st.host?.querySelector("[data-tr-note]");
    if (el) el.textContent = text;
    if (!text) return;
    clearTimeout(note.timer);
    note.timer = setTimeout(() => { st.notice = ""; const n = st.host?.querySelector("[data-tr-note]"); if (n) n.textContent = ""; }, 6000);
  }

  function drawColumns() {
    const host = st.host;
    if (!host) return;
    const selected = new Set(st.columns);
    applyColumnWidths();
    const head = host.querySelector("[data-tr-head]");
    if (head) head.innerHTML = st.columns
      .map((id) => COLUMNS.find(([key]) => key === id))
      .filter(Boolean)
      .map(([id, label]) => {
        const direction = st.columnSort?.id === id ? st.columnSort.direction : "";
        // Name has no handle: it is whatever the other columns leave it.
        const handle = id === "name" ? "" : `<i data-tr-column-resize="${id}" title="Resize ${label}"></i>`;
        return `<span data-col="${id}" aria-sort="${direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}" title="Sort by ${label}; drag to reorder">${label}<em class="tr-sort-arrow">${direction === "asc" ? "▲" : direction === "desc" ? "▼" : ""}</em>${handle}</span>`;
      })
      .join("");
    const picker = host.querySelector("[data-tr-column-picker]");
    if (picker) picker.innerHTML = COLUMNS.map(([id, label]) => `<label>
      <input type="checkbox" data-tr-column="${id}"${selected.has(id) ? " checked" : ""}>
      <span>${label}</span>
    </label>`).join("");
    for (const row of host.querySelectorAll(".tr-row")) applyRowColumnOrder(row);
  }

  /** Every column is exactly the width it was given. Name is the one that is
   *  not: it takes whatever is left, so widening the window or closing the
   *  detail pane gives the room to the names — the column that can actually
   *  use it — instead of stretching the numbers. It has no width of its own
   *  and no resize handle; this is its floor. */
  const NAME_MIN = 140;

  function columnWidth(id, fallback) {
    return Number(st.columnWidths[id]) || Number.parseInt(fallback, 10);
  }

  function applyColumnWidths() {
    const list = st.host?.querySelector("[data-tr-list]");
    if (!list) return;
    const visible = st.columns.map((id) => COLUMNS.find(([key]) => key === id)).filter(Boolean);
    list.style.setProperty("--tr-columns", visible
      .map(([id, , width]) => id === "name"
        ? `minmax(${NAME_MIN}px,1fr)`
        : `${columnWidth(id, width)}px`)
      .join(" "));
    // What the table cannot be squeezed below. Past this the list scrolls
    // sideways rather than crushing the fixed columns out of shape.
    const minimum = visible.reduce((sum, [id, , width]) =>
      sum + (id === "name" ? NAME_MIN : columnWidth(id, width)), 0)
      + Math.max(0, visible.length - 1) * 10 + 24;
    list.style.setProperty("--tr-table-min-width", `${minimum}px`);
  }

  function startColumnResize(event) {
    const handle = event.target.closest("[data-tr-column-resize]");
    if (!handle || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const id = handle.dataset.trColumnResize;
    const header = handle.parentElement;
    const startX = event.clientX;
    const startWidth = header.getBoundingClientRect().width;
    document.body.classList.add("tr-resizing-column");
    const move = (next) => {
      st.columnWidths[id] = Math.max(48, Math.min(600, Math.round(startWidth + next.clientX - startX)));
      applyColumnWidths();
    };
    const end = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      document.body.classList.remove("tr-resizing-column");
      saveLayout();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end, { once: true });
    document.addEventListener("pointercancel", end, { once: true });
  }

  function startColumnReorder(event) {
    const source = event.target.closest(".tr-head > [data-col]");
    if (!source || event.button !== 0 || event.target.closest("[data-tr-column-resize]")) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let target = null;
    let after = false;

    const clearMarker = () => {
      for (const header of st.host.querySelectorAll(".tr-head .drop-before,.tr-head .drop-after")) {
        header.classList.remove("drop-before", "drop-after");
      }
    };
    const move = (next) => {
      if (!st.columnDragged && Math.hypot(next.clientX - startX, next.clientY - startY) < 5) return;
      st.columnDragged = true;
      st.draggedColumn = source.dataset.col;
      source.classList.add("dragging");
      document.body.classList.add("tr-reordering-column");
      clearMarker();
      target = document.elementFromPoint(next.clientX, next.clientY)?.closest(".tr-head > [data-col]") || null;
      if (!target || target === source) return;
      after = next.clientX > target.getBoundingClientRect().left + target.offsetWidth / 2;
      target.classList.add(after ? "drop-after" : "drop-before");
      next.preventDefault();
    };
    const end = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", cancel);
      if (st.columnDragged && target && target !== source) {
        const order = st.columns.filter((id) => id !== source.dataset.col);
        let index = order.indexOf(target.dataset.col) + (after ? 1 : 0);
        order.splice(Math.max(0, index), 0, source.dataset.col);
        st.columns = order;
        saveLayout();
        drawColumns();
        drawRows();
      }
      clearMarker();
      document.body.classList.remove("tr-reordering-column");
      endColumnDrag();
    };
    const cancel = () => { target = null; end(); };
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", end, { once: true });
    document.addEventListener("pointercancel", cancel, { once: true });
  }

  function endColumnDrag() {
    st.draggedColumn = null;
    for (const header of st.host?.querySelectorAll(".tr-head .dragging,.tr-head .drop-before,.tr-head .drop-after") || []) {
      header.classList.remove("dragging", "drop-before", "drop-after");
    }
    setTimeout(() => { st.columnDragged = false; }, 0);
  }

  function applyRowColumnOrder(row) {
    for (const cell of row.querySelectorAll("[data-col]")) {
      const at = st.columns.indexOf(cell.dataset.col);
      cell.hidden = at < 0;
      // Behind every shown column rather than at -1, which would put a cell in
      // front of the lot if it ever drew in spite of being hidden.
      cell.style.order = String(at < 0 ? COLUMNS.length : at);
    }
  }

  function sortedRows(rows) {
    const sort = st.columnSort;
    if (!sort) return rows;
    const value = (row) => {
      if (sort.id === "mark") return st.marks.has(row.infoHash) ? 1 : 0;
      if (sort.id === "name") return row.name || "";
      if (sort.id === "size") return row.totalBytes || 0;
      if (sort.id === "done") return percent(row);
      if (sort.id === "status") return statusWords(row).text;
      // A torrent that has not finished has no completion date, and it sorts
      // as one still to come: newer than everything already done. Ascending
      // therefore ends with the unfinished ones, descending starts with them.
      if (sort.id === "completed") return row.completedAt || Number.POSITIVE_INFINITY;
      if (sort.id === "down") return row.downloadBps || 0;
      if (sort.id === "up") return row.uploadBps || 0;
      if (sort.id === "peers") return row.peers || 0;
      if (sort.id === "remaining") return Math.max(0, (row.totalBytes || 0) - (row.progressBytes || 0));
      if (sort.id === "eta") return row.etaSeconds ?? Number.MAX_SAFE_INTEGER;
      if (sort.id === "uploaded") return row.uploadedBytes || 0;
      if (sort.id === "ratio") return row.progressBytes ? (row.uploadedBytes || 0) / row.progressBytes : 0;
      if (sort.id === "known") return (row.peers || 0) + (row.peersQueued || 0);
      if (sort.id === "folder") return row.outputFolder || "";
      return 0;
    };
    const direction = sort.direction === "desc" ? -1 : 1;
    return rows.map((row, index) => ({ row, index })).sort((a, b) => {
      const left = value(a.row);
      const right = value(b.row);
      // Two values that are equal - including two infinities, whose
      // difference is not a number - keep the order they came in.
      if (left === right) return a.index - b.index;
      const compared = typeof left === "string"
        ? left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
        : left - right;
      return compared ? compared * direction : a.index - b.index;
    }).map(({ row }) => row);
  }

  // --------------------------------------------------------- the virtual list

  /** Draws only the rows the viewport can show. Each row is reused: if the
   *  element at a slot is already the right torrent, its text is updated in
   *  place and nothing is replaced, so hovering and clicking survive a
   *  snapshot arriving mid-gesture. */
  function drawRows() {
    const host = st.host;
    if (!host?.isConnected || st.tab !== "transfers") return;
    const scroll = host.querySelector("[data-tr-scroll]");
    const spacer = host.querySelector("[data-tr-spacer]");
    const box = host.querySelector("[data-tr-rows]");
    const empty = host.querySelector("[data-tr-empty]");
    if (!scroll || !box) return;

    const rows = sortedRows([...st.pendingAdds, ...(st.snap?.torrents || [])]);
    if (!st.snap && !rows.length) return drawSkeleton();

    spacer.style.height = `${rows.length * ROW}px`;
    if (!rows.length) {
      box.innerHTML = "";
      empty.hidden = false;
      empty.innerHTML = `${icon("download")}<p>Nothing downloading yet. Paste a magnet link above, or drop a .torrent file.</p>`;
      return;
    }
    empty.hidden = true;

    const first = Math.max(0, Math.floor(scroll.scrollTop / ROW) - OVERSCAN);
    const visible = Math.ceil(scroll.clientHeight / ROW) + OVERSCAN * 2;
    const last = Math.min(rows.length, first + visible);
    box.style.transform = `translateY(${first * ROW}px)`;

    // Exactly as many elements as slots, so scrolling neither leaks nodes nor
    // rebuilds the ones that stayed.
    const wanted = last - first;
    pool(box, wanted, rowElement, "row");
    for (let i = 0; i < wanted; i++) fillRow(box.children[i], rows[first + i]);
  }

  /** Makes `box` hold exactly `wanted` rows, reusing the ones already there.
   *
   *  Anything in the box that this pool did not build is replaced rather than
   *  written into. The skeletons drawn before the first answer arrives live in
   *  the same container and have none of the parts the fill step writes to, so
   *  filling one throws — and a throw here stops the whole list being drawn,
   *  which is how four empty rows end up sitting above four more. */
  function pool(box, wanted, make, kind) {
    while (box.children.length > wanted) box.lastChild.remove();
    while (box.children.length < wanted) box.appendChild(make());
    for (let i = 0; i < wanted; i++) {
      if (box.children[i].dataset.trPooled !== kind) box.replaceChild(make(), box.children[i]);
    }
  }

  function rowElement() {
    const el = document.createElement("div");
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.className = "tr-row";
    el.dataset.trPooled = "row";
    el.innerHTML = `
      <span class="tr-mark" data-col="mark"><input type="checkbox" class="tr-check" data-tr-mark tabindex="-1" title="Mark this torrent as dealt with"></span>
      <span class="tr-name" data-col="name"><i class="tr-dot"></i><span></span></span>
      <span class="tr-size" data-col="size"></span>
      <span class="tr-done" data-col="done"><i class="tr-bar"><b></b></i><small></small></span>
      <span class="tr-status" data-col="status"><span></span><button type="button" data-tr-recheck title="Check files">${icon("fact_check")}<span>Check</span></button></span>
      <span class="tr-completed" data-col="completed"></span>
      <span class="tr-down" data-col="down"></span>
      <span class="tr-up" data-col="up"></span>
      <span class="tr-peers" data-col="peers"></span>
      <span data-col="remaining"></span>
      <span data-col="eta"></span>
      <span data-col="uploaded"></span>
      <span data-col="ratio"></span>
      <span data-col="known"></span>
      <span class="tr-folder" data-col="folder"><span></span></span>`;
    applyRowColumnOrder(el);
    return el;
  }

  function fillRow(el, row) {
    if (!row) return;
    const status = statusWords(row);
    const pct = percent(row);
    if (el.dataset.trId !== String(row.id)) el.dataset.trId = String(row.id);
    // A row the engine has not read back in yet has nothing to act on: its
    // name and size come from the saved torrent, but the engine does not know
    // it exists, so pausing or removing it would go nowhere. It is greyed and
    // left out of the keyboard order until it is real.
    const disabled = row.state === "adding" || row.state === "waiting";
    el.classList.toggle("tr-row-waiting", row.state === "waiting");
    el.tabIndex = disabled ? -1 : 0;
    el.setAttribute("aria-disabled", String(disabled));
    el.classList.toggle("on", st.selectedIds.has(row.id));
    el.setAttribute("aria-selected", String(st.selectedIds.has(row.id)));
    const mark = el.querySelector("[data-tr-mark]");
    const marked = st.marks.has(row.infoHash);
    if (mark.checked !== marked) mark.checked = marked;
    el.classList.toggle("marked", marked);
    el.querySelector(".tr-dot").className = `tr-dot ${status.tone}`;
    setText(el.querySelector(".tr-name span"), row.name);
    el.querySelector(".tr-name span").title = row.name;
    setText(el.querySelector(".tr-size"), row.totalBytes ? bytes(row.totalBytes) : "—");
    el.querySelector(".tr-bar b").style.width = `${pct}%`;
    setText(
      el.querySelector(".tr-done small"),
      // Nothing is known about how much of it is on disk until the engine has
      // checked; "0%" would be a claim, and a wrong one for a finished torrent.
      row.state === "waiting" ? "—" : `${pct.toFixed(pct >= 100 || pct === 0 ? 0 : 1)}%`,
    );
    const statusEl = el.querySelector(".tr-status");
    setText(statusEl.querySelector(":scope > span"), status.text);
    statusEl.className = `tr-status ${status.tone}`;
    statusEl.title = row.error || "";
    statusEl.querySelector("[data-tr-recheck]").hidden = row.state !== "needs-check";
    setText(el.querySelector(".tr-completed"), completedAt(row.completedAt));
    setText(el.querySelector(".tr-down"), row.state === "live" && !row.finished ? speed(row.downloadBps) : "—");
    setText(el.querySelector(".tr-up"), row.uploadBps ? speed(row.uploadBps) : "—");
    const peersEl = el.querySelector(".tr-peers");
    setText(peersEl, row.state === "live" ? String(row.peers) : "—");
    peersEl.title = "Peers currently connected to WinT; tracker seeder totals may be higher";
    setText(el.querySelector('[data-col="remaining"]'), bytes(Math.max(0, row.totalBytes - row.progressBytes)));
    setText(el.querySelector('[data-col="eta"]'), eta(row.etaSeconds) || "—");
    setText(el.querySelector('[data-col="uploaded"]'), bytes(row.uploadedBytes));
    setText(el.querySelector('[data-col="ratio"]'), row.progressBytes ? (row.uploadedBytes / row.progressBytes).toFixed(2) : "—");
    setText(el.querySelector('[data-col="known"]'), row.state === "live" ? String(row.peers + row.peersQueued) : "—");
    // The tail of the path, which is the part that tells two downloads apart;
    // the whole thing is on the title, and a click opens it.
    const folder = el.querySelector(".tr-folder");
    const path = row.outputFolder || "";
    setText(folder.querySelector("span"), path ? path.split(/[\/]/).filter(Boolean).slice(-2).join("\\") : "—");
    folder.title = path ? `${path}
Click to open in Explorer` : "";
    folder.classList.toggle("empty", !path);
  }

  /** Ticks a torrent off, or unticks it. Shift extends the tick from the last
   *  one touched down the list as it is currently sorted, the way the rows
   *  themselves are selected. The marks are written out whole, minus any hash
   *  the engine no longer knows about, so removed torrents do not accumulate. */
  function toggleMark(row, checked, event) {
    const rows = sortedRows([...st.pendingAdds, ...(st.snap?.torrents || [])]);
    let touched = [row];
    if (event?.shiftKey && st.markAnchor && st.markAnchor !== row.infoHash) {
      const from = rows.findIndex((item) => item.infoHash === st.markAnchor);
      const to = rows.findIndex((item) => item.infoHash === row.infoHash);
      if (from >= 0 && to >= 0) touched = rows.slice(Math.min(from, to), Math.max(from, to) + 1);
    }
    for (const item of touched) {
      if (!item.infoHash) continue;
      if (checked) {
        st.marks.add(item.infoHash);
        st.markCleared.delete(item.infoHash);
      } else {
        st.marks.delete(item.infoHash);
        st.markCleared.add(item.infoHash);
      }
    }
    st.markAnchor = row.infoHash;
    // Forget marks for torrents the engine no longer has, so the list does
    // not grow for ever — but only against a snapshot that actually arrived.
    // A helper that is restarting reports nothing, and that is not the same
    // as every torrent having been removed.
    if (st.snap?.torrents?.length) {
      const known = new Set(st.snap.torrents.map((item) => item.infoHash).filter(Boolean));
      for (const hash of [...st.marks]) if (!known.has(hash)) st.marks.delete(hash);
    }
    // Drawn first, saved second: the tick is the user's, and it must not wait
    // on a round trip to show. The save is its own little piece of work so the
    // status bar says it is happening, and says so if it fails.
    drawRows();
    note(touched.length > 1
      ? `${touched.length} torrents ${checked ? "marked" : "unmarked"}.`
      : `${row.name} ${checked ? "marked" : "unmarked"}.`);
    invoke("torrent_marks_save", { hashes: [...st.marks] })
      .catch((error) => note(`Your marks could not be saved: ${error}`));
  }

  /** Writes only when the text actually differs. A `textContent` assignment
   *  that changes nothing still invalidates layout for that node. */
  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  // ------------------------------------------------------------- detail pane

  function drawDetail() {
    const pane = st.host.querySelector("[data-tr-detail]");
    if (!pane) return;
    const row = (st.snap?.torrents || []).find((t) => t.id === st.selected);
    if (!row) {
      pane.hidden = true;
      pane.innerHTML = "";
      st.details = null;
      st.detailsFor = null;
      return;
    }

    // The file list is asked for once per selection, not streamed: it is the
    // long part, and it does not change while a torrent downloads.
    if (st.detailsFor !== row.id && !st.detailsBusy) {
      st.detailsBusy = true;
      st.detailsFor = row.id;
      invoke("torrent_details", { id: row.id })
        .then((payload) => { st.details = payload; st.fileOrder = []; st.fileSelection.clear(); st.fileAnchor = null; })
        .catch((error) => { st.details = { error: String(error) }; })
        .finally(() => { st.detailsBusy = false; drawDetail(); });
    }

    const pct = percent(row);
    const paused = row.state === "paused";
    if (pane.hidden) pane.hidden = false;

    // Built once. A snapshot arrives three times a second, and replacing this
    // markup each time would destroy and recreate the very buttons the pointer
    // is over — a click landing between the mousedown and the mouseup would
    // simply be lost. Everything below is written in place instead.
    // Development reloads and restored views can leave a pane built by an
    // older version of this renderer in the DOM. Rebuild when any required
    // control is absent; otherwise one missing node would throw on every
    // snapshot and make both refreshing and row selection appear dead.
    if (!pane.querySelector("[data-tr-dhead]")) {
      // Two columns: what this torrent is and what you can do to it on the
      // left, its contents on the right. The file list is the part that wants
      // room and the part you read down, so it gets the width and its own
      // scroll rather than pushing the buttons off the top.
      pane.innerHTML = `
        <div class="tr-dhead" data-tr-dhead>
          <div class="tr-dtitle"><strong></strong><small></small></div>
          <div class="tr-dactions">
            <button type="button" class="btn" data-tr-open>${icon("folder")}<span>Open folder</span></button>
            <button type="button" class="btn" data-tr-toggle><span class="ms" aria-hidden="true">pause</span><span>Pause</span></button>
            <button type="button" class="btn danger" data-tr-remove>${icon("delete")}<span>Remove</span></button>
          </div>
        </div>
        <div class="tr-files" data-tr-files>
          <div class="tr-fhead" data-tr-fhead>
            <i></i>
            <button type="button" data-tr-fsort="name">File<i class="tr-fsort-arrow"></i></button>
            <button type="button" data-tr-fsort="size">Size<i class="tr-fsort-arrow"></i></button>
            <button type="button" data-tr-fsort="done">Done<i class="tr-fsort-arrow"></i></button>
          </div>
          <div class="tr-fscroll" data-tr-fscroll>
            <div class="tr-spacer" data-tr-fspacer></div>
            <div class="tr-frows" data-tr-frows></div>
          </div>
        </div>`;
      pane.querySelector("[data-tr-fscroll]").addEventListener("scroll", drawFiles, { passive: true });
    }

    const title = pane.querySelector(".tr-dtitle strong");
    setText(title, row.name);
    title.title = row.name;
    // A very long file list is cut by the engine so that parsing it cannot
    // stall this page; when that happens the pane says so rather than
    // pretending the torrent has fewer files than it does.
    const shown = st.details?.details;
    const cut = shown?.filesTruncated
      ? ` · showing the first ${(shown.files || []).length} of ${shown.fileCount} files`
      : "";
    setText(pane.querySelector(".tr-dtitle small"),
      `${bytes(row.totalBytes)} · ${pct.toFixed(pct >= 100 || pct === 0 ? 0 : 1)}% complete · ${row.outputFolder}${cut}`);
    drawFileHead();
    const toggle = pane.querySelector("[data-tr-toggle]");
    if (!toggle) return;
    toggle.hidden = row.state === "needs-check";
    setText(toggle.querySelector(".ms"), paused ? "play_arrow" : "pause");
    setText(toggle.querySelector("span:last-child"), paused ? "Resume" : "Pause");
    drawFiles();
  }

  /** The file list, virtualized the same way as the torrents: a torrent with
   *  tens of thousands of files costs the same as one with three. */
  function drawFiles() {
    const pane = st.host?.querySelector("[data-tr-detail]");
    const scroll = pane?.querySelector("[data-tr-fscroll]");
    const box = pane?.querySelector("[data-tr-frows]");
    if (!scroll || !box) return;

    const payload = st.details;
    const files = payload?.details?.files || [];
    const progress = payload?.fileProgress || [];
    if (payload?.error) {
      box.style.transform = "translateY(0)";
      box.innerHTML = `<div class="tr-frow tr-fnote">${esc(payload.error)}</div>`;
      pane.querySelector("[data-tr-fspacer]").style.height = `${FILE_ROW}px`;
      return;
    }
    if (!payload) {
      box.style.transform = "translateY(0)";
      box.innerHTML = Array.from({ length: 4 }, () => '<div class="tr-frow tr-skeleton"></div>').join("");
      pane.querySelector("[data-tr-fspacer]").style.height = `${4 * FILE_ROW}px`;
      return;
    }

    if (st.fileOrder.length !== files.length) orderFiles();
    pane.querySelector("[data-tr-fspacer]").style.height = `${files.length * FILE_ROW}px`;
    const first = Math.max(0, Math.floor(scroll.scrollTop / FILE_ROW) - OVERSCAN);
    const visible = Math.ceil(scroll.clientHeight / FILE_ROW) + OVERSCAN * 2;
    const last = Math.min(files.length, first + visible);
    box.style.transform = `translateY(${first * FILE_ROW}px)`;

    const wanted = last - first;
    pool(box, wanted, fileElement, "file");
    for (let i = 0; i < wanted; i++) {
      // The row's place in the list and the file's place in the torrent are
      // two different numbers once the list is sorted. Everything below uses
      // the file's own index, because that is what the engine is told about.
      const index = st.fileOrder[first + i];
      const file = files[index];
      const el = box.children[i];
      if (!file) continue;
      const done = Number(progress[index] || 0);
      const pct = file.length ? Math.min(100, (done / file.length) * 100) : 0;
      el.dataset.trFile = String(index);
      el.classList.toggle("off", file.included === false);
      el.classList.toggle("on", st.fileSelection.has(index));
      // Written only when it disagrees: assigning `checked` every frame would
      // fight a click that has landed but whose answer has not come back yet.
      const check = el.querySelector(".tr-fcheck");
      const wanted = file.included !== false;
      if (check.checked !== wanted) check.checked = wanted;
      setText(el.querySelector(".tr-fname"), file.name);
      el.querySelector(".tr-fname").title = file.name;
      setText(el.querySelector(".tr-fsize"), bytes(file.length));
      el.querySelector(".tr-fbar b").style.width = `${pct}%`;
      setText(el.querySelector(".tr-fpct"), `${Math.round(pct)}%`);
    }
  }

  /** Works out the order the contents are listed in.
   *
   *  Worked out once, when the sort changes or a fresh file list arrives —
   *  never per frame. Sorting by how done a file is would otherwise reshuffle
   *  the list three times a second while it downloads, and rows would move out
   *  from under the pointer. The order is a list of the files' own indices, so
   *  the engine is always told about the right file whatever the list shows. */
  function orderFiles() {
    const files = st.details?.details?.files || [];
    const progress = st.details?.fileProgress || [];
    const order = files.map((_, i) => i);
    const { key, dir } = st.fileSort;
    if (key === "name") {
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      order.sort((a, b) => dir * collator.compare(files[a].name, files[b].name));
    } else if (key === "size") {
      order.sort((a, b) => dir * (files[a].length - files[b].length));
    } else if (key === "done") {
      const share = (i) => (files[i].length ? Number(progress[i] || 0) / files[i].length : 0);
      order.sort((a, b) => dir * (share(a) - share(b)));
    }
    st.fileOrder = order;
  }

  function sortFiles(key) {
    // Same column again reverses it; a new column starts ascending, except
    // size and progress, where "biggest" and "least done" are what you are
    // usually looking for.
    if (st.fileSort.key === key) st.fileSort = { key, dir: -st.fileSort.dir };
    else st.fileSort = { key, dir: key === "name" ? 1 : -1 };
    orderFiles();
    const scroll = st.host?.querySelector("[data-tr-fscroll]");
    if (scroll) scroll.scrollTop = 0;
    drawFileHead();
    drawFiles();
  }

  function drawFileHead() {
    const head = st.host?.querySelector("[data-tr-fhead]");
    if (!head) return;
    for (const button of head.querySelectorAll("[data-tr-fsort]")) {
      const on = button.dataset.trFsort === st.fileSort.key;
      button.classList.toggle("on", on);
      setText(button.querySelector(".tr-fsort-arrow"), on ? (st.fileSort.dir > 0 ? "▲" : "▼") : "");
    }
  }

  function fileElement() {
    const el = document.createElement("div");
    el.className = "tr-frow";
    el.dataset.trPooled = "file";
    // The checkbox is its own control and nothing else is part of it: clicking
    // the name selects the row, it does not change what gets downloaded.
    el.innerHTML = `
      <input type="checkbox" class="tr-fcheck" title="Download this file" />
      <span class="tr-fname"></span>
      <span class="tr-fsize"></span>
      <span class="tr-fdone"><i class="tr-bar tr-fbar"><b></b></i><small class="tr-fpct"></small></span>`;
    return el;
  }

  // --------------------------------------------------------------- settings

  /** What the engine is doing and what it has said, in one place.
   *
   *  Everything here was previously only reachable by opening a panel inside a
   *  warning - which meant it was there when something had already gone wrong
   *  and nowhere to be found when someone simply wanted to know what the engine
   *  was up to. The engine is a separate process whose only account of itself
   *  is what it writes to its error stream; this tab is that account, kept as
   *  it arrives, and one button that copies the lot.
   */
  function drawEngine() {
    const view = st.host.querySelector('[data-tr-view="engine"]');
    if (!view) return;
    if (!view.querySelector("[data-tr-log]")) {
      view.innerHTML = `
        <div class="tr-settings">
          <section class="awake-panel">
            <header>${icon("memory")}<strong>The engine</strong></header>
            <div class="tr-setrow tr-enginehead"><span><span data-tr-enginefacts></span><small data-tr-enginebuild></small></span>
              <span class="tr-enginebtns">
                <button type="button" class="btn" data-tr-copy-diag title="Copy everything on this tab, ready to paste">${icon("content_copy")}<span>Copy for support</span></button>
                <button type="button" class="btn" data-tr-restart>${icon("restart_alt")}<span>Restart</span></button>
              </span></div>
          </section>

          <section class="awake-panel tr-logpanel">
            <header>${icon("terminal")}<strong>Engine log</strong><small data-tr-logcount></small></header>
            <pre class="tr-log" data-tr-log tabindex="0"></pre>
          </section>
        </div>`;
    }
    setText(view.querySelector("[data-tr-enginefacts]"), engineLine());
    setText(view.querySelector("[data-tr-enginebuild]"), engineBuild() || "");
    drawEngineLog();
  }

  /** Writes the log, keeping the view pinned to the newest line unless the
   *  reader has scrolled up - which they will have done to read something, and
   *  yanking them back to the bottom every second would make that impossible. */
  function drawEngineLog() {
    const pre = st.host?.querySelector("[data-tr-log]");
    if (!pre) return;
    const lines = Array.isArray(st.engine?.diagnostics) ? st.engine.diagnostics : [];
    const text = lines.length ? lines.join(String.fromCharCode(10)) : "The engine has not said anything yet.";
    if (pre.textContent !== text) {
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
      pre.textContent = text;
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    }
    setText(
      st.host.querySelector("[data-tr-logcount]"),
      lines.length ? `${lines.length} line${lines.length === 1 ? "" : "s"}, newest last` : "",
    );
  }

  /** One line of engine state, for the Engine tab's header row. */
  function engineLine() {
    const s = st.engine || {};
    return [
      `${s.state || "unknown"}${s.phase && s.phase !== "live" ? ` (${s.phase})` : ""}`,
      s.engine || null,
      ...diagnosticFacts(),
    ].filter(Boolean).join(" · ");
  }

  /** The build of the engine that is actually running: the file it was started
   *  from and when that file was written. Whether a change has reached the
   *  running engine is otherwise guesswork, and guessing it wrong sends
   *  everyone looking for a bug in code that is not being run. */
  function engineBuild() {
    const s = st.engine || {};
    if (!s.engineExe) return null;
    const built = s.engineBuiltMs
      ? `built ${new Intl.DateTimeFormat(undefined, {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
        }).format(new Date(s.engineBuiltMs))}`
      : "build time unknown";
    return `${s.engineExe} · ${built}`;
  }

  function drawSettings() {
    const view = st.host.querySelector('[data-tr-view="settings"]');
    if (!view) return;
    const s = st.settings || st.snap?.settings;
    if (!s) {
      view.innerHTML = '<div class="tr-skeleton" style="height:120px"></div>';
      return;
    }
    // Rebuilt only when the shape is missing: the inputs are mounted once so
    // a caret is never lost to a snapshot arriving mid-keystroke.
    if (!view.querySelector("[data-tr-folder]")) {
      view.innerHTML = `
        <div class="tr-settings">
          <section class="awake-panel">
            <header>${icon("folder")}<strong>Where files go</strong></header>
            <div class="tr-setrow">
              <code data-tr-folder></code>
              <button type="button" class="btn" data-tr-pickfolder>${icon("edit")}<span>Change…</span></button>
            </div>
          </section>

          <section class="awake-panel">
            <header>${icon("speed")}<strong>How much load</strong></header>
            <label class="tr-setrow"><span>Download speed</span>
              <select data-tr-dlimit></select></label>
            <label class="tr-setrow"><span>Upload speed</span>
              <select data-tr-ulimit></select></label>
            <label class="tr-setrow"><span>Download at most</span>
              <select data-tr-active></select></label>
            <label class="tr-setrow"><span>Peers per torrent</span>
              <select data-tr-peers></select></label>
          </section>

          <section class="awake-panel">
            <header>${icon("tune")}<strong>Behaviour</strong></header>
            <label class="tr-setrow"><span>Keep seeding when finished<small>Until you remove the torrent</small></span>
              <input type="checkbox" data-tr-seed /></label>
          </section>

          <section class="awake-panel">
            <header>${icon("link")}<strong>Torrent files and magnet links</strong></header>
            <div data-tr-assocbody></div>
          </section>

          <section class="awake-panel tr-enginepanel">
            <header>${icon("memory")}<strong>The engine</strong></header>
            <div class="tr-setrow"><span data-tr-enginestat></span>
              <button type="button" class="btn" data-tr-restart>${icon("restart_alt")}<span>Restart</span></button></div>
          </section>
        </div>`;
      fillOptions(view.querySelector("[data-tr-dlimit]"), speedOptions());
      fillOptions(view.querySelector("[data-tr-ulimit]"), speedOptions());
      fillOptions(view.querySelector("[data-tr-active]"), [1, 2, 3, 4, 6, 8, 12, 16].map((n) => [n, String(n)]));
      fillOptions(view.querySelector("[data-tr-peers]"), [16, 32, 64, 128, 256, 512].map((n) => [n, String(n)]));
      view.addEventListener("change", settingChanged);
    }

    setText(view.querySelector("[data-tr-folder]"), s.downloadFolder || "");
    setValue(view.querySelector("[data-tr-dlimit]"), String(s.downloadBps ?? 0));
    setValue(view.querySelector("[data-tr-ulimit]"), String(s.uploadBps ?? 0));
    setValue(view.querySelector("[data-tr-active]"), String(s.maxActive));
    setValue(view.querySelector("[data-tr-peers]"), String(s.peerLimit));
    const seed = view.querySelector("[data-tr-seed]");
    if (seed && seed.checked !== !!s.seedWhenFinished) seed.checked = !!s.seedWhenFinished;

    drawAssocPanel();

    const e = st.engine || {};
    setText(view.querySelector("[data-tr-enginestat]"),
      e.state === "running"
        ? `${e.engine || "Running"} · pid ${e.pid} · ${bytes(e.memoryBytes)}${e.restarts ? ` · restarted ${e.restarts}×` : ""}`
        : e.message || e.state || "Not running");
  }

  function speedOptions() {
    const steps = [0, 128, 256, 512, 1024, 2048, 5120, 10240, 20480, 51200];
    return steps.map((kb) => [kb * 1024, kb === 0 ? "No limit" : `${kb >= 1024 ? `${kb / 1024} MB` : `${kb} KB`}/s`]);
  }

  function fillOptions(select, pairs) {
    if (!select) return;
    select.innerHTML = pairs.map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join("");
  }

  function setValue(select, value) {
    if (select && select.value !== value) select.value = value;
  }

  function settingChanged(event) {
    const view = st.host.querySelector('[data-tr-view="settings"]');
    const target = event.target;
    const patch = {};
    if (target.matches("[data-tr-dlimit]")) patch.downloadBps = Number(target.value) || null;
    else if (target.matches("[data-tr-ulimit]")) patch.uploadBps = Number(target.value) || null;
    else if (target.matches("[data-tr-active]")) patch.maxActive = Number(target.value);
    else if (target.matches("[data-tr-peers]")) patch.peerLimit = Number(target.value);
    else if (target.matches("[data-tr-seed]")) patch.seedWhenFinished = target.checked;
    else return;
    // Shown as chosen straight away; the engine's answer is what is kept.
    st.settings = { ...st.settings, ...patch };
    invoke("torrent_settings", { patch })
      .then((settings) => { st.settings = settings; drawSettings(); })
      .catch((error) => { note(String(error)); drawSettings(); });
    void view;
  }

  // ------------------------------------------------- torrents from the shell

  /** Remembered per user, not per window: once they have answered the ask
   *  strip — either way — it does not come back. The Settings tab is where it
   *  can be changed afterwards. */
  const ASK_KEY = "wint.torrents.association-asked";

  function asked() {
    try { return localStorage.getItem(ASK_KEY) === "1"; } catch { return true; }
  }

  function markAsked() {
    try { localStorage.setItem(ASK_KEY, "1"); } catch { /* private mode */ }
    if (st.assoc) st.assoc.asked = true;
    invoke("torrent_assoc_mark_asked").catch(() => {});
  }

  /** Collect whatever Explorer or a browser handed to WinT. Draining, not
   *  reading: the backend gives each item out once, so reopening the tool can
   *  never add the same torrent twice.
   *
   *  Magnets go one at a time. Each can sit for up to a minute and a half
   *  waiting for metadata, and a browser that fired three links at once must
   *  not take three of WinT's worker threads with it. */
  async function drainPending() {
    let items = [];
    try {
      items = await invoke("take_pending_torrents");
    } catch { return; }
    if (!items?.length) return;
    const links = items.filter((item) => /^magnet:/i.test(item));
    const files = items.filter((item) => !/^magnet:/i.test(item));
    for (const link of links) {
      try { await addUrl(link); } catch { /* addUrl has already said so */ }
    }
    if (files.length) await addFiles(files);
  }

  function refreshAssoc() {
    invoke("torrent_assoc_status")
      .then((assoc) => {
        if (!st.host?.isConnected) return;
        st.assoc = assoc;
        drawAsk();
        drawAssocPanel();
        offerSelf(assoc);
      })
      .catch(() => { /* not Windows, or the registry would not answer */ });
  }

  /** Put WinT in the list of apps that *can* open a torrent, the first time
   *  the tool is opened and without asking.
   *
   *  This is not taking anything over, and it is worth being clear about why
   *  it needs no permission: it writes only this user's own hive, it changes
   *  nothing about what a double-click does today, and Settings undoes it.
   *  What it buys is that WinT is in "Open with" and on Windows' Default apps
   *  page at all — until it is, the question the strip asks has no answer the
   *  user could give, because WinT is not on the list to pick.
   *
   *  Once per session: a status that comes back unregistered after this has
   *  been tried is a registry that refused, not one nobody has written to. */
  function offerSelf(assoc) {
    if (st.assocTried || !assoc?.supported || assoc.registered || assoc.otherExe) return;
    st.assocTried = true;
    invoke("torrent_assoc_register")
      .then((next) => {
        if (!st.host?.isConnected) return;
        st.assoc = next;
        drawAsk();
        drawAssocPanel();
      })
      .catch(() => { /* left off the list; the Settings tab still offers it */ });
  }

  /** Asked once, at the top of the page, and never as a modal: a question
   *  about file associations must not stand between the user and the torrent
   *  they came here to start. */
  function drawAsk() {
    const el = st.host?.querySelector("[data-tr-ask]");
    if (!el) return;
    const a = st.assoc;
    const settled = a && a.defaultFile && a.defaultMagnet;
    if (!a || !a.supported || settled || a.asked || asked()) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    const owner = a.fileOwner || a.magnetOwner;
    el.hidden = false;
    el.innerHTML = `${icon("link")}
      <span>Open torrents in WinT? Windows will show WinT's Default apps page, where you can assign
        both <b>.torrent</b> files and <b>magnet:</b> links.${
          owner ? ` They open in ${esc(owner)} today.` : ""
        }</span>
      <button type="button" class="btn primary" data-tr-assoc-default>${icon("open_in_new")}<span>Choose in Windows</span></button>
      <button type="button" class="btn" data-tr-ask-dismiss>${icon("close")}<span>Not now</span></button>`;
  }

  /** The Settings tab's version, which says what Windows actually thinks
   *  rather than asking a question. Rewritten whole on every draw — it holds
   *  no input a caret could be sitting in. */
  function drawAssocPanel() {
    const el = st.host?.querySelector("[data-tr-assocbody]");
    if (!el) return;
    const a = st.assoc;
    if (!a) return void (el.innerHTML = '<div class="tr-skeleton" style="height:44px"></div>');
    if (!a.supported) {
      return void (el.innerHTML = '<p class="tr-assocnote">Windows is what hands torrents to an app, so there is nothing to set here.</p>');
    }
    const line = (ok, label, owner) => `<div class="tr-assocline ${ok ? "on" : ""}">
      ${icon(ok ? "check_circle" : "close")}
      <span>${esc(label)}${ok ? " open in WinT" : owner ? ` open in ${esc(owner)}` : " open in something else"}</span>
    </div>`;
    const busy = st.assocBusy ? " disabled" : "";
    el.innerHTML = `
      ${line(a.defaultFile, ".torrent files", a.fileOwner)}
      ${line(a.defaultMagnet, "magnet: links", a.magnetOwner)}
      ${a.otherExe ? `<p class="tr-assocnote">Another copy of WinT is registered: <code>${esc(a.otherExe)}</code></p>` : ""}
      <div class="tr-setrow">
        <span>${a.defaultFile && a.defaultMagnet
            ? "Both types already open in WinT."
            : "Choose WinT for .torrent files and magnet: links on its Windows Default apps page."}</span>
        <button type="button" class="btn primary" data-tr-assoc-default${busy}>${icon("open_in_new")}<span>${st.assocBusy ? "Opening Windows…" : "Open Windows defaults"}</span></button>
      </div>
      <div class="tr-setrow">
        <span>${a.registered
            ? "WinT is available in Windows' app choices. Remove it from that list if you no longer want it offered."
            : "Add WinT to Windows' app choices without changing what opens torrents today."}</span>
        ${a.registered
            ? `<button type="button" class="btn" data-tr-assoc-remove${busy}>${icon("delete")}<span>Remove WinT choice</span></button>`
            : `<button type="button" class="btn" data-tr-assoc-register${busy}>${icon("link")}<span>Add WinT choice</span></button>`}
      </div>`;
  }

  /** `message` is either a line or a function of the state that came back -
   *  taking the default can half-succeed, and saying so beats a flat claim
   *  that it worked. Nothing is awaited: `choose_default` can sit on a modal
   *  Windows dialog for as long as the user leaves it there. */
  function assocAct(command, message) {
    if (st.assocBusy) return;
    st.assocBusy = true;
    // However they answer, they have answered: the strip does not ask again.
    markAsked();
    drawAsk();
    drawAssocPanel();
    note("Opening Windows Default apps…");
    invoke(command)
      .then((assoc) => {
        st.assoc = assoc;
        note(typeof message === "function" ? message(assoc) : message);
      })
      .catch((error) => note(String(error)))
      .finally(() => { st.assocBusy = false; drawAsk(); drawAssocPanel(); });
  }

  // ----------------------------------------------------------------- actions

  function selectedRows(fallback) {
    const picked = (st.snap?.torrents || []).filter((row) => st.selectedIds.has(row.id));
    return picked.length ? picked : (fallback ? [fallback] : []);
  }

  function selectTorrent(id, event = {}) {
    const rows = sortedRows(st.snap?.torrents || []);
    if (event.shiftKey && st.selectionAnchor != null) {
      const from = rows.findIndex((row) => row.id === st.selectionAnchor);
      const to = rows.findIndex((row) => row.id === id);
      if (from >= 0 && to >= 0) {
        if (!event.ctrlKey && !event.metaKey) st.selectedIds.clear();
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
          st.selectedIds.add(rows[i].id);
        }
      }
    } else if (event.ctrlKey || event.metaKey) {
      if (st.selectedIds.has(id)) st.selectedIds.delete(id);
      else st.selectedIds.add(id);
      st.selectionAnchor = id;
    } else {
      st.selectedIds = new Set([id]);
      st.selectionAnchor = id;
    }
    st.selected = st.selectedIds.has(id) ? id : (st.selectedIds.values().next().value ?? null);
    drawRows();
    drawDetail();
  }

  function keydown(event) {
    const row = event.target.closest("[data-tr-id]");
    if (row && event.target === row && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      row.click();
      return;
    }
    if (!event.target.matches("[data-tr-magnet]") || event.key !== "Enter") return;
    const value = event.target.value.trim();
    if (!value) return;
    event.target.value = "";
    addUrl(value);
  }

  function click(event) {
    const t = event.target;

    const heading = t.closest(".tr-head > [data-col]");
    if (heading && !t.closest("[data-tr-column-resize]")) {
      if (st.columnDragged) return;
      const id = heading.dataset.col;
      st.columnSort = st.columnSort?.id === id
        ? { id, direction: st.columnSort.direction === "asc" ? "desc" : "asc" }
        : { id, direction: "asc" };
      saveLayout();
      drawColumns();
      drawRows();
      return;
    }

    if (t.closest("[data-tr-columns]")) {
      const picker = st.host.querySelector("[data-tr-column-picker]");
      if (picker) picker.hidden = !picker.hidden;
      return;
    }

    const column = t.closest("[data-tr-column]");
    if (column) {
      const id = column.dataset.trColumn;
      if (!column.checked && st.columns.length === 1) {
        column.checked = true;
        return;
      }
      st.columns = column.checked
        ? [...st.columns, id]
        : st.columns.filter((key) => key !== id);
      saveLayout();
      drawColumns();
      drawRows();
      return;
    }

    const tab = t.closest("[data-tr-tab]");
    if (tab) {
      st.tab = tab.dataset.trTab;
      for (const el of st.host.querySelectorAll("[data-tr-tab]")) el.classList.toggle("on", el === tab);
      for (const el of st.host.querySelectorAll("[data-tr-view]")) el.hidden = el.dataset.trView !== st.tab;
      const columns = st.host.querySelector(".tr-column-control");
      if (columns) columns.hidden = st.tab !== "transfers";
      return draw();
    }

    const copyDiag = t.closest("[data-tr-copy-diag]");
    if (copyDiag) {
      window.wintCopy?.copy(diagnosticReport(), copyDiag, "Diagnostics copied")
        .then(() => note("The troubleshooting details were copied."))
        .catch(() => note("The troubleshooting details could not be copied."));
      return;
    }

    if (t.closest("[data-tr-restart]")) {
      note("Restarting the torrent engine…");
      st.lastSnapshotAt = 0;
      st.engineStartedAt = Date.now();
      st.quiet = false;
      return void invoke("torrent_restart")
        .then((engine) => { st.engine = engine; note("The torrent engine was restarted."); drawBanner(); })
        .catch((error) => note(String(error)));
    }

    const folderCell = t.closest(".tr-folder");
    if (folderCell && !folderCell.classList.contains("empty")) {
      const el = t.closest("[data-tr-id]");
      const row = (st.snap?.torrents || []).find((item) => item.id === Number(el?.dataset.trId));
      if (row?.outputFolder) {
        note(`Opening ${row.outputFolder}…`);
        invoke("open_in", { path: row.outputFolder, target: "explorer", context: null })
          .then(() => note(""))
          .catch((error) => note(String(error)));
        return;
      }
    }

    if (t.closest("[data-tr-mark]")) {
      const el = t.closest("[data-tr-id]");
      const row = (st.snap?.torrents || []).find((item) => item.id === Number(el?.dataset.trId));
      if (row) toggleMark(row, t.checked, event);
      return;
    }

    if (t.closest("[data-tr-recheck]")) {
      const rowElement = t.closest("[data-tr-id]");
      const id = rowElement ? Number(rowElement.dataset.trId) : st.selected;
      const row = (st.snap?.torrents || []).find((item) => item.id === id);
      if (!row) return;
      note(`Checking ${row.name}…`);
      return void invoke("torrent_recheck", { infoHash: row.infoHash })
        .then((engine) => { st.engine = engine; drawBanner(); })
        .catch((error) => note(String(error)));
    }

    if (t.closest("[data-tr-browse]")) {
      return void invoke("pick_torrent_files")
        .then((paths) => { if (paths?.length) addFiles(paths); })
        .catch((error) => note(String(error)));
    }

    if (t.closest("[data-tr-pickfolder]")) {
      return void invoke("pick_folder", { start: st.settings?.downloadFolder || null })
        .then((folder) => {
          if (!folder) return;
          return invoke("torrent_settings", { patch: { downloadFolder: folder } })
            .then((settings) => { st.settings = settings; drawSettings(); });
        })
        .catch((error) => note(String(error)));
    }

    const row = t.closest("[data-tr-id]");
    if (row) {
      if (row.getAttribute("aria-disabled") === "true") return;
      const id = Number(row.dataset.trId);
      return selectTorrent(id, event);
    }

    const sort = t.closest("[data-tr-fsort]");
    if (sort) return sortFiles(sort.dataset.trFsort);

    const file = t.closest("[data-tr-file]");
    if (file) {
      const index = Number(file.dataset.trFile);
      if (t.matches(".tr-fcheck")) return toggleFile(index, t.checked);
      return selectFile(index, event);
    }

    if (t.closest("[data-tr-toggle]")) return toggleSelected();
    if (t.closest("[data-tr-remove]")) return removeSelected();
    if (t.closest("[data-tr-ask-dismiss]")) {
      markAsked();
      drawAsk();
      return;
    }

    if (t.closest("[data-tr-assoc-default]")) {
      assocAct("torrent_assoc_choose_default", (assoc) =>
        assoc.defaultFile && assoc.defaultMagnet
          ? "Torrents and magnet links now open in WinT."
          : "Windows Default apps is open. Choose WinT for .torrent and magnet there.");
      return;
    }

    if (t.closest("[data-tr-assoc-register]")) {
      assocAct("torrent_assoc_register", "WinT now appears under Open with for torrents.");
      return;
    }

    if (t.closest("[data-tr-assoc-remove]")) {
      assocAct("torrent_assoc_unregister", "WinT no longer offers to open torrents.");
      return;
    }

    if (t.closest("[data-tr-open]")) {
      const current = (st.snap?.torrents || []).find((x) => x.id === st.selected);
      if (current) invoke("open_in", { path: current.outputFolder, target: "explorer", context: null })
        .catch(() => note("That folder could not be opened."));
      return;
    }
  }

  function addUrl(url) {
    note("Adding…");
    return invoke("torrent_add", { url })
      .then((added) => note(`Added ${added?.details?.name || "the torrent"}.`))
      .catch((error) => note(String(error)));
  }

  /** Adds a few at a time, never all at once.
   *
   *  Each add can sit on a worker thread for up to a minute and a half while
   *  a magnet finds its metadata, and that pool is shared with the rest of
   *  WinT. Dropping a folder of three hundred .torrent files and firing three
   *  hundred calls would starve every other tool in the app. Three in flight
   *  keeps it brisk and keeps the pool free; the rest queue here, where the
   *  page can still say what it is doing. */
  async function addFiles(paths) {
    const queue = paths.map((path) => {
      const filename = String(path).split(/[\\/]/).pop() || "Torrent";
      const pending = {
        id: --st.pendingSequence,
        path,
        name: filename.replace(/\.torrent$/i, "") || filename,
        state: "adding",
        totalBytes: 0,
        progressBytes: 0,
        uploadedBytes: 0,
        finished: false,
        downloadBps: 0,
        uploadBps: 0,
        peers: 0,
      };
      st.pendingAdds.push(pending);
      return pending;
    });
    const total = queue.length;
    let added = 0;
    let done = 0;
    let failed = "";
    drawRows();
    drawCount();
    const progress = () => note(total === 1 ? "Adding…" : `Adding ${done} / ${total} torrents…`);
    progress();

    const worker = async () => {
      for (;;) {
        const pending = queue.shift();
        if (!pending) return;
        try {
          await invoke("torrent_add", { path: pending.path });
          added++;
        } catch (error) {
          failed = String(error);
        }
        st.pendingAdds = st.pendingAdds.filter((item) => item !== pending);
        done++;
        progress();
        drawRows();
        drawCount();
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, total) }, worker));
    note(added ? `Added ${added} torrent${added === 1 ? "" : "s"}.` : failed || "Nothing was added.");
  }

  function toggleSelected() {
    const rows = selectedRows();
    if (!rows.length) return;
    const action = rows.every((row) => row.state === "paused" || row.state === "queued") ? "start" : "pause";
    Promise.all(rows.map((row) => invoke("torrent_action", { id: row.id, action })))
      .catch((error) => note(String(error)));
  }

  async function removeSelected() {
    const rows = selectedRows();
    if (!rows.length) return;
    const row = rows[0];
    // Three answers, because there are three: bin the files, leave them where
    // they are, or do nothing. `true` is the confirm button, `"alternate"` the
    // middle one, `false` cancel. Deleting for good is not offered here — it
    // is on the right-click menu, where it has to be chosen deliberately.
    const answer = await window.wintConfirm?.({
      title: rows.length === 1 ? `Remove ${row.name}?` : `Remove ${rows.length} torrents?`,
      message: "The transfer stops either way. The question is what happens to what has already been downloaded.",
      confirmLabel: "Remove and bin the files",
      alternateLabel: "Remove but keep the files",
      cancelLabel: "Cancel",
      icon: "delete",
      tone: "danger",
    });
    if (answer !== true && answer !== "alternate") return;
    for (const item of rows) await removeTorrent(item, answer === true ? "recycle" : "keep");
  }

  /** Takes a torrent off the list, and does the chosen thing with its files.
   *
   *  The paths are read **before** the torrent goes, because afterwards the
   *  engine no longer knows them — and they are the torrent's own paths, never
   *  the download folder, which a remove must never be able to delete. */
  async function removeTorrent(row, mode) {
    // Asking where the files are is allowed to fail — an older backend may
    // not know the question, and files the user already deleted by hand have
    // no paths left to find. Neither is a reason to leave the torrent sitting
    // in the list, which is the one thing the user definitely asked for.
    let target = null;
    let gone = false;
    if (mode !== "keep") {
      try {
        const paths = await invoke("torrent_paths", { id: row.id });
        target = paths?.root ? [paths.root] : (paths?.files || []);
        gone = paths?.root ? paths.rootExists === false : false;
        if (!target.length) target = null;
      } catch {
        target = null;
      }
    }

    // With no paths to work from, the engine's own delete is the fallback for
    // "delete for good"; it cannot use the Recycle Bin, so a recycle with no
    // paths keeps the files rather than silently destroying them.
    const engineDeletes = mode === "forever" && !target;
    try {
      await invoke("torrent_action", { id: row.id, action: "remove", deleteFiles: engineDeletes });
    } catch (error) {
      return note(`${row.name} could not be removed: ${error}`);
    }
    st.selectedIds.delete(row.id);
    if (st.selected === row.id) {
      st.selected = st.selectedIds.values().next().value ?? null;
      drawDetail();
    }

    if (mode === "keep") return note(`Removed ${row.name}. The files were left where they are.`);
    if (gone) return note(`Removed ${row.name}. Its files were already gone.`);
    if (engineDeletes) return note(`Removed ${row.name} and deleted what was on disk.`);
    if (!target) return note(`Removed ${row.name}, but where its files were could not be worked out — they were left alone.`);

    // The engine has only just let go of these files, and Windows can still be
    // holding a handle for a moment after. A couple of retries covers that
    // without making the user do it.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await invoke("explorer_delete", { paths: target, recycle: mode === "recycle" });
        return note(mode === "recycle"
          ? `Removed ${row.name} and sent its files to the Recycle Bin.`
          : `Removed ${row.name} and deleted its files.`);
      } catch (error) {
        if (attempt === 2) return note(`Removed ${row.name}, but its files could not be deleted: ${error}`);
        await new Promise((done) => setTimeout(done, 500));
      }
    }
  }

  /** Where this torrent lives, for opening rather than deleting. Falls back to
   *  the download folder when the torrent has no folder of its own. */
  async function torrentFolder(row) {
    try {
      const paths = await invoke("torrent_paths", { id: row.id });
      return paths?.root || paths?.outputFolder || row.outputFolder;
    } catch {
      return row.outputFolder;
    }
  }

  function openInWintFiles(path) {
    if (!path) return Promise.reject(new Error("That folder could not be worked out."));
    if (window.wintShell?.openExplorerWindow) return window.wintShell.openExplorerWindow(path);
    const emit = window.__TAURI__?.event?.emit;
    if (!emit) return Promise.reject(new Error("WinT Files could not be contacted."));
    return emit("files:open-window", { path });
  }

  // ------------------------------------------------------------ right-click

  function closeMenu() {
    document.querySelector(".tr-context")?.remove();
  }

  function openMenu(event, row) {
    closeMenu();
    const paused = row.state === "paused";
    const targets = selectedRows(row);
    const many = targets.length > 1;
    const allForced = targets.every((item) => item.forceStarted);
    const menu = document.createElement("div");
    menu.className = "tr-context";
    menu.innerHTML = `
      <button type="button" data-act="explorer">${icon("folder_open")}Open folder</button>
      <button type="button" data-act="files">${icon("dock_to_right")}Open in WinT Files</button>
      <hr />
      <button type="button" data-act="toggle">${icon(paused ? "play_arrow" : "pause")}${paused ? "Resume" : "Pause"}${many ? ` ${targets.length} torrents` : ""}</button>
      <button type="button" data-act="force">${icon(allForced ? "playlist_play" : "bolt")}${allForced ? "Use download queue" : "Force start"}${many ? ` ${targets.length} torrents` : ""}</button>
      <hr />
      <button type="button" data-act="keep">${icon("playlist_remove")}Remove, keep the files</button>
      <button type="button" data-act="recycle">${icon("delete")}Remove, files to Recycle Bin</button>
      <button type="button" data-act="forever">${icon("delete_forever")}Remove, delete the files for good</button>`;
    document.body.appendChild(menu);

    // Placed after it is in the document, so its real size is known and it can
    // be kept on screen when the click was near an edge.
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - box.width - 8)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - box.height - 8)}px`;

    menu.onclick = async (click) => {
      const act = click.target.closest("[data-act]")?.dataset.act;
      closeMenu();
      if (!act) return;
      if (act === "explorer") return void invoke("open_in", { path: await torrentFolder(row), target: "explorer", context: null })
        .catch(() => note("That folder could not be opened."));
      if (act === "files") return void openInWintFiles(await torrentFolder(row))
        .catch((error) => note(String(error)));
      if (act === "toggle") return void Promise.all(targets.map((item) => invoke("torrent_action", { id: item.id, action: paused ? "start" : "pause" })))
        .catch((error) => note(String(error)));
      if (act === "force") return void Promise.all(targets.map((item) => invoke("torrent_action", { id: item.id, action: allForced ? "start" : "force_start" })))
        .then(() => note(allForced ? `${targets.length} torrent${many ? "s will" : " will"} use the download queue.` : `${targets.length} torrent${many ? "s were" : " was"} force started.`))
        .catch((error) => note(String(error)));
      if (act === "keep") {
        for (const item of targets) await removeTorrent(item, "keep");
        return;
      }

      const forGood = act === "forever";
      const ok = await window.wintConfirm?.({
        title: many
          ? `${forGood ? "Delete" : "Remove"} ${targets.length} torrents?`
          : (forGood ? `Delete ${row.name} and its files?` : `Remove ${row.name}?`),
        message: forGood
          ? "The files are deleted straight away, not sent to the Recycle Bin. This cannot be undone."
          : "The torrent is removed and its files go to the Recycle Bin, where Windows can still bring them back.",
        confirmLabel: forGood ? "Delete for good" : "Move to Recycle Bin",
        cancelLabel: "Cancel",
        icon: forGood ? "delete_forever" : "delete",
        tone: "danger",
      });
      if (ok === true) {
        for (const item of targets) await removeTorrent(item, forGood ? "forever" : "recycle");
      }
    };
    setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
  }

  function parentPath(path) {
    const normalized = String(path || "").replace(/\/+$/g, "");
    const end = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
    return end > 2 ? normalized.slice(0, end) : normalized;
  }

  async function openFileMenu(event, index) {
    closeMenu();
    if (st.selected == null) return;
    let resolved;
    try {
      resolved = await invoke("torrent_file_path", { id: st.selected, index });
    } catch (error) {
      return note(String(error));
    }
    if (!resolved?.path) return note("That file's path could not be worked out.");
    const exists = resolved.exists !== false;
    const isZip = /\.zip$/i.test(resolved.path);
    const details = st.details?.details?.files?.[index];
    const included = details?.included !== false;
    const menu = document.createElement("div");
    menu.className = "tr-context";
    menu.innerHTML = `
      <button type="button" data-act="open"${exists ? "" : " disabled"}>${icon("open_in_new")}Open with default app</button>
      <button type="button" data-act="files"${exists ? "" : " disabled"}>${icon(isZip ? "folder_zip" : "dock_to_right")}${isZip ? "Browse archive in WinT Files" : "Open containing folder in WinT Files"}</button>
      <button type="button" data-act="reveal"${exists ? "" : " disabled"}>${icon("folder_open")}Show in Windows Explorer</button>
      <hr />
      <button type="button" data-act="copy">${icon("content_copy")}Copy full path</button>
      <button type="button" data-act="include">${icon(included ? "check_box_outline_blank" : "check_box")}${included ? "Do not download this file" : "Download this file"}</button>`;
    document.body.appendChild(menu);
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - box.width - 8)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - box.height - 8)}px`;
    menu.onclick = async (click) => {
      const act = click.target.closest("[data-act]")?.dataset.act;
      closeMenu();
      if (act === "open") return void invoke("open_in", { path: resolved.path, target: "default", context: null })
        .catch((error) => note(String(error)));
      if (act === "files") {
        const destination = isZip ? resolved.path : parentPath(resolved.path);
        return void openInWintFiles(destination).catch((error) => note(String(error)));
      }
      if (act === "reveal") return void invoke("open_in", { path: resolved.path, target: "reveal", context: null })
        .catch((error) => note(String(error)));
      if (act === "copy") return void navigator.clipboard.writeText(resolved.path)
        .then(() => note("Path copied."))
        .catch(() => note("The path could not be copied."));
      if (act === "include") toggleFile(index, !included);
    };
    setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
  }

  /** Sent as the change the user made, never as a whole new selection.
   *
   *  The page may only be holding the first few thousand files of a very long
   *  torrent, and a full list built from that would silently drop everything
   *  past the cut. The engine applies the change to its own list.
   *
   *  A checkbox ticked while several rows are selected applies to all of them,
   *  which is the point of being able to select several. */
  function toggleFile(index, included) {
    const files = st.details?.details?.files || [];
    if (!files.length || st.selected == null) return;

    const targets = st.fileSelection.has(index) && st.fileSelection.size > 1
      ? [...st.fileSelection].filter((i) => files[i])
      : [index];
    const was = new Map(targets.map((i) => [i, files[i].included]));
    for (const i of targets) files[i].included = included;
    drawFiles();

    invoke("torrent_only_files", {
      id: st.selected,
      include: included ? targets : [],
      exclude: included ? [] : targets,
    })
      .then(() => { st.detailsFor = null; drawDetail(); })
      .catch((error) => {
        for (const [i, before] of was) files[i].included = before;
        note(String(error));
        drawFiles();
      });
  }

  /** Click-to-select over the contents, the way a file list behaves anywhere
   *  else: a plain click picks one, Ctrl adds or removes, Shift takes the run
   *  between this row and the last one picked. The run is taken in the order
   *  the list is *shown* in, not the torrent's, so a sorted list selects what
   *  it looks like it selects. */
  function selectFile(index, event) {
    const order = st.fileOrder;
    if (event.shiftKey && st.fileAnchor != null) {
      const from = order.indexOf(st.fileAnchor);
      const to = order.indexOf(index);
      if (from >= 0 && to >= 0) {
        if (!event.ctrlKey) st.fileSelection.clear();
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) st.fileSelection.add(order[i]);
      }
    } else if (event.ctrlKey) {
      if (st.fileSelection.has(index)) st.fileSelection.delete(index);
      else st.fileSelection.add(index);
      st.fileAnchor = index;
    } else {
      st.fileSelection.clear();
      st.fileSelection.add(index);
      st.fileAnchor = index;
    }
    drawFiles();
  }

  /** Opens a file with whatever Windows opens it with. Only makes sense once
   *  the file is actually there, so a part-downloaded one says so instead. */
  async function openFile(index) {
    if (st.selected == null) return;
    try {
      const file = await invoke("torrent_file_path", { id: st.selected, index });
      if (!file?.path) return note("That file's path could not be worked out.");
      if (file.exists === false) return note(`${file.name || "That file"} has not been downloaded yet.`);
      await invoke("open_in", { path: file.path, target: "explorer", context: null });
    } catch (error) {
      note(String(error));
    }
  }

  window.wintTorrent = { mount };
})();
