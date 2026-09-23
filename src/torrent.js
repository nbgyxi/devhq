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
  /** Rows drawn above and below the viewport, so a fast scroll does not show
   *  blank space before the next frame. */
  const OVERSCAN = 6;

  const st = {
    host: null,
    tab: "transfers",
    engine: { state: "stopped" },
    /** The newest snapshot. Replaced wholesale; never appended to. */
    snap: null,
    /** Torrent id the detail pane is showing. */
    selected: null,
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
    quiet: false,
    tick: 0,
    settings: null,
    /** What Windows makes of `.torrent` and `magnet:` — see `refreshAssoc`.
     *  Null until the first answer; the ask strip stays out of the way until
     *  then rather than flashing a question that may not apply. */
    assoc: null,
    assocBusy: false,
    assocTried: false,
    listening: false,
    unlisten: [],
  };

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
    if (row.state === "error") return { text: row.error || "Error", tone: "bad" };
    if (row.state === "initializing") return { text: "Checking files", tone: "warn" };
    if (row.state === "queued") return { text: "Waiting its turn", tone: "muted" };
    if (row.state === "paused") return { text: "Paused", tone: "muted" };
    if (row.finished) return { text: "Seeding", tone: "good" };
    const left = eta(row.etaSeconds);
    return { text: left || "Downloading", tone: "" };
  }

  function percent(row) {
    if (!row.totalBytes) return 0;
    return Math.min(100, (row.progressBytes / row.totalBytes) * 100);
  }

  // ------------------------------------------------------------------- shell

  function mount(node) {
    st.host = node;
    node.innerHTML = `
      <div class="tr-page">
        <div class="tr-banner" data-tr-banner hidden></div>
        <div class="tr-ask" data-tr-ask hidden></div>
        <div class="tr-tabs" role="tablist">
          <button type="button" class="tr-tab on" data-tr-tab="transfers" role="tab">Transfers</button>
          <button type="button" class="tr-tab" data-tr-tab="settings" role="tab">Settings</button>
          <span class="tr-count" data-tr-count></span>
        </div>

        <section class="tr-view" data-tr-view="transfers">
          <div class="tr-add">
            ${icon("add_link")}
            <input type="text" class="tr-magnet" data-tr-magnet spellcheck="false"
                   placeholder="Paste a magnet link, or drop a .torrent file here — it starts right away" />
            <button type="button" class="btn" data-tr-browse>${icon("folder_open")}<span>Choose a file…</span></button>
          </div>

          <div class="tr-work">
            <div class="tr-list" data-tr-list>
              <div class="tr-head">
                <span>Name</span><span>Size</span><span>Done</span><span>Status</span>
                <span>Down</span><span>Up</span><span>Peers</span>
              </div>
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

          <footer class="tr-foot">
            <span class="tr-rate" data-tr-down>${icon("south")}<strong>—</strong></span>
            <span class="tr-rate" data-tr-up>${icon("north")}<strong>—</strong></span>
            <span class="tr-note" data-tr-note></span>
          </footer>
        </section>

        <section class="tr-view" data-tr-view="settings" hidden></section>
      </div>`;

    node.addEventListener("click", click);
    node.addEventListener("keydown", keydown);
    node.addEventListener("contextmenu", (event) => {
      const el = event.target.closest("[data-tr-id]");
      if (!el) return;
      const row = (st.snap?.torrents || []).find((x) => x.id === Number(el.dataset.trId));
      if (!row) return;
      event.preventDefault();
      openMenu(event, row);
    });
    node.addEventListener("dblclick", (event) => {
      const file = event.target.closest("[data-tr-file]");
      if (!file || event.target.matches(".tr-fcheck")) return;
      event.preventDefault();
      openFile(Number(file.dataset.trFile));
    });
    node.querySelector("[data-tr-scroll]").addEventListener("scroll", () => drawRows(), { passive: true });

    listen();
    drawBanner();
    drawSkeleton();
    // What the shell may already have handed over, and what Windows makes of
    // torrents today. Both are one call each and neither blocks the mount.
    drainPending();
    refreshAssoc();

    // The page's own pulse. It exists only to notice that nothing is arriving
    // and to say so; it draws no torrent data, so it costs the same whether
    // there is one torrent or a thousand.
    clearInterval(st.tick);
    st.tick = setInterval(() => {
      if (!st.host?.isConnected) return clearInterval(st.tick);
      const running = st.engine?.state === "running" || st.engine?.state === "starting";
      const silent = st.lastSnapshotAt > 0 && Date.now() - st.lastSnapshotAt > 4000;
      if (running && silent !== st.quiet) { st.quiet = silent; drawBanner(); }
    }, 1000);
    // Bring the engine up. Until it answers, the list shows skeletons; the
    // page is interactive the whole time.
    invoke("torrent_start")
      .then((engine) => { st.engine = engine; drawBanner(); })
      .catch((error) => { st.engine = { state: "failed", message: String(error) }; drawBanner(); });
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
        const list = host.querySelector("[data-tr-list]");
        if (payload.type === "enter" || payload.type === "over") return list?.classList.add("tr-drop");
        list?.classList.remove("tr-drop");
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
        drawFoot();
        drawDetail();
      } else {
        drawSettings();
      }
      drawCount();
    } catch (error) {
      note(`That update could not be drawn: ${error?.message || error}`);
    }
  }

  function drawCount() {
    const el = st.host.querySelector("[data-tr-count]");
    if (!el) return;
    const rows = st.snap?.torrents || [];
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

  function drawBanner() {
    const el = st.host?.querySelector("[data-tr-banner]");
    if (!el) return;
    const s = st.engine || {};
    // Gone quiet, but still nominally up: the numbers on screen have stopped
    // being true and the page says so rather than letting them sit there
    // looking live. The list stays on screen and stays clickable throughout.
    if (st.quiet && (s.state === "running" || s.state === "starting")) {
      el.hidden = false;
      el.className = "tr-banner";
      el.innerHTML = `${icon("warning")}<span>The torrent engine has gone quiet — what is below is the last it said.
        It may just be busy checking files.</span>
        <button type="button" class="btn" data-tr-restart>${icon("restart_alt")}<span>Restart the engine</span></button>`;
      return;
    }
    if (s.state === "running" || s.state === "starting") {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    const message = s.message
      || (s.state === "stopped" ? "The torrent engine is not running." : "The torrent engine is not responding.");
    el.hidden = false;
    el.className = `tr-banner ${s.state === "failed" || s.state === "not-responding" ? "bad" : ""}`;
    el.innerHTML = `${icon("warning")}<span>${esc(message)}</span>
      <button type="button" class="btn" data-tr-restart>${icon("restart_alt")}<span>Restart the engine</span></button>`;
  }

  function note(text) {
    st.notice = text;
    const el = st.host?.querySelector("[data-tr-note]");
    if (el) el.textContent = text;
    if (!text) return;
    clearTimeout(note.timer);
    note.timer = setTimeout(() => { st.notice = ""; const n = st.host?.querySelector("[data-tr-note]"); if (n) n.textContent = ""; }, 6000);
  }

  function drawFoot() {
    const snap = st.snap;
    if (!snap) return;
    const down = st.host.querySelector("[data-tr-down] strong");
    const up = st.host.querySelector("[data-tr-up] strong");
    if (down) down.textContent = speed(snap.downloadBps);
    if (up) up.textContent = speed(snap.uploadBps);
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

    const rows = st.snap?.torrents || [];
    if (!st.snap) return drawSkeleton();

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
    const el = document.createElement("button");
    el.type = "button";
    el.className = "tr-row";
    el.dataset.trPooled = "row";
    el.innerHTML = `
      <span class="tr-name"><i class="tr-dot"></i><span></span></span>
      <span class="tr-size"></span>
      <span class="tr-done"><i class="tr-bar"><b></b></i><small></small></span>
      <span class="tr-status"></span>
      <span class="tr-down"></span>
      <span class="tr-up"></span>
      <span class="tr-peers"></span>`;
    return el;
  }

  function fillRow(el, row) {
    if (!row) return;
    const status = statusWords(row);
    const pct = percent(row);
    if (el.dataset.trId !== String(row.id)) el.dataset.trId = String(row.id);
    el.classList.toggle("on", st.selected === row.id);
    el.querySelector(".tr-dot").className = `tr-dot ${status.tone}`;
    setText(el.querySelector(".tr-name span"), row.name);
    el.querySelector(".tr-name span").title = row.name;
    setText(el.querySelector(".tr-size"), row.totalBytes ? bytes(row.totalBytes) : "—");
    el.querySelector(".tr-bar b").style.width = `${pct}%`;
    setText(el.querySelector(".tr-done small"), `${pct.toFixed(pct >= 100 || pct === 0 ? 0 : 1)}%`);
    const statusEl = el.querySelector(".tr-status");
    setText(statusEl, status.text);
    statusEl.className = `tr-status ${status.tone}`;
    statusEl.title = row.error || "";
    setText(el.querySelector(".tr-down"), row.state === "live" && !row.finished ? speed(row.downloadBps) : "—");
    setText(el.querySelector(".tr-up"), row.uploadBps ? speed(row.uploadBps) : "—");
    setText(el.querySelector(".tr-peers"), row.state === "live" ? String(row.peers) : "—");
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
    if (!a || !a.supported || settled || asked()) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    const owner = a.fileOwner || a.magnetOwner;
    el.hidden = false;
    el.innerHTML = `${icon("link")}
      <span>Let WinT open torrents? A <b>.torrent</b> double-clicked in Files, or a
        <b>magnet</b> link followed in a browser, would come straight here.${
          owner ? ` They open in ${esc(owner)} today.` : ""
        }</span>
      <button type="button" class="btn primary" data-tr-assoc-default>${icon("done")}<span>Make WinT the default</span></button>
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
            ? "WinT gets both. Nothing more to do."
            : "Take both. Where Windows has already been told otherwise it asks you to confirm, because only you can change that."}</span>
        <button type="button" class="btn primary" data-tr-assoc-default${busy}>${icon(a.registered ? "done" : "open_in_new")}<span>${st.assocBusy ? "Asking Windows…" : "Make WinT the default"}</span></button>
      </div>
      <div class="tr-setrow">
        <span>${a.registered
            ? "Or take WinT back out of Open with entirely."
            : "Or just appear under Open with, without taking anything over."}</span>
        ${a.registered
            ? `<button type="button" class="btn" data-tr-assoc-remove${busy}>${icon("delete")}<span>Remove</span></button>`
            : `<button type="button" class="btn" data-tr-assoc-register${busy}>${icon("link")}<span>Register</span></button>`}
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
    note("Asking Windows…");
    invoke(command)
      .then((assoc) => {
        st.assoc = assoc;
        note(typeof message === "function" ? message(assoc) : message);
      })
      .catch((error) => note(String(error)))
      .finally(() => { st.assocBusy = false; drawAsk(); drawAssocPanel(); });
  }

  // ----------------------------------------------------------------- actions

  function keydown(event) {
    if (!event.target.matches("[data-tr-magnet]") || event.key !== "Enter") return;
    const value = event.target.value.trim();
    if (!value) return;
    event.target.value = "";
    addUrl(value);
  }

  function click(event) {
    const t = event.target;

    const tab = t.closest("[data-tr-tab]");
    if (tab) {
      st.tab = tab.dataset.trTab;
      for (const el of st.host.querySelectorAll("[data-tr-tab]")) el.classList.toggle("on", el === tab);
      for (const el of st.host.querySelectorAll("[data-tr-view]")) el.hidden = el.dataset.trView !== st.tab;
      return draw();
    }

    if (t.closest("[data-tr-restart]")) {
      note("Restarting the torrent engine…");
      return void invoke("torrent_restart")
        .then((engine) => { st.engine = engine; note("The torrent engine was restarted."); drawBanner(); })
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
      const id = Number(row.dataset.trId);
      st.selected = st.selected === id ? null : id;
      drawRows();
      return drawDetail();
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
          : assoc.defaultFile || assoc.defaultMagnet
            ? "Partly done — the rest is Windows' to give, on the page it just opened."
            : "Windows has the question now. Pick WinT there and it sticks.");
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
    const queue = paths.slice();
    const total = queue.length;
    let added = 0;
    let done = 0;
    let failed = "";
    const progress = () => note(total === 1 ? "Adding…" : `Adding ${done} / ${total} torrents…`);
    progress();

    const worker = async () => {
      for (;;) {
        const path = queue.shift();
        if (!path) return;
        try {
          await invoke("torrent_add", { path });
          added++;
        } catch (error) {
          failed = String(error);
        }
        done++;
        progress();
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, total) }, worker));
    note(added ? `Added ${added} torrent${added === 1 ? "" : "s"}.` : failed || "Nothing was added.");
  }

  function toggleSelected() {
    const row = (st.snap?.torrents || []).find((x) => x.id === st.selected);
    if (!row) return;
    const action = row.state === "paused" ? "start" : "pause";
    invoke("torrent_action", { id: row.id, action }).catch((error) => note(String(error)));
  }

  async function removeSelected() {
    const row = (st.snap?.torrents || []).find((x) => x.id === st.selected);
    if (!row) return;
    // Three answers, because there are three: bin the files, leave them where
    // they are, or do nothing. `true` is the confirm button, `"alternate"` the
    // middle one, `false` cancel. Deleting for good is not offered here — it
    // is on the right-click menu, where it has to be chosen deliberately.
    const answer = await window.wintConfirm?.({
      title: `Remove ${row.name}?`,
      message: "The transfer stops either way. The question is what happens to what has already been downloaded.",
      confirmLabel: "Remove and bin the files",
      alternateLabel: "Remove but keep the files",
      cancelLabel: "Cancel",
      icon: "delete",
      tone: "danger",
    });
    if (answer !== true && answer !== "alternate") return;
    removeTorrent(row, answer === true ? "recycle" : "keep");
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
    if (st.selected === row.id) { st.selected = null; drawDetail(); }

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

  // ------------------------------------------------------------ right-click

  function closeMenu() {
    document.querySelector(".tr-context")?.remove();
  }

  function openMenu(event, row) {
    closeMenu();
    const paused = row.state === "paused";
    const menu = document.createElement("div");
    menu.className = "tr-context";
    menu.innerHTML = `
      <button type="button" data-act="explorer">${icon("folder_open")}Open folder</button>
      <button type="button" data-act="files">${icon("dock_to_right")}Show in Files</button>
      <hr />
      <button type="button" data-act="toggle">${icon(paused ? "play_arrow" : "pause")}${paused ? "Resume" : "Pause"}</button>
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
      if (act === "files") return void window.wintShell?.openExplorerWindow?.(await torrentFolder(row));
      if (act === "toggle") return void invoke("torrent_action", { id: row.id, action: paused ? "start" : "pause" })
        .catch((error) => note(String(error)));
      if (act === "keep") return void removeTorrent(row, "keep");

      const forGood = act === "forever";
      const ok = await window.wintConfirm?.({
        title: forGood ? `Delete ${row.name} and its files?` : `Remove ${row.name}?`,
        message: forGood
          ? "The files are deleted straight away, not sent to the Recycle Bin. This cannot be undone."
          : "The torrent is removed and its files go to the Recycle Bin, where Windows can still bring them back.",
        confirmLabel: forGood ? "Delete for good" : "Move to Recycle Bin",
        cancelLabel: "Cancel",
        icon: forGood ? "delete_forever" : "delete",
        tone: "danger",
      });
      if (ok === true) removeTorrent(row, forGood ? "forever" : "recycle");
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
