// The workspace: one window per project, holding the four things that project
// needs open at once.
//
// The window owns a layout, not the panels. Five named slots — left-top,
// left-bottom, center, right, bottom — each hold exactly one panel element,
// and rearranging is swapping which slot an element sits in. Panels are built
// once and *moved*, never rebuilt: a terminal that got re-mounted every time a
// divider moved would lose its scrollback and, worse, its running dev server.
//
// The browser is the exception to all of this. It is a native child webview
// floating over a hole in the page, so it cannot be covered by anything the
// page draws and it does not move when the page reflows. Every layout change
// therefore ends by telling Rust where the hole now is, and anything that
// needs to draw over that area — a drag, a divider, a file preview — hides the
// webview first and puts it back afterwards.

(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const listen = window.__TAURI__.event.listen;
  const win = window.__TAURI__.window.getCurrentWindow();
  const label = win.label;

  const params = new URLSearchParams(location.search);
  const projectPath = params.get("path") || "";
  const projectName = params.get("name") || projectPath.split(/[\\/]/).filter(Boolean).pop() || "Project";

  document.getElementById("ws-project").textContent = projectName;
  document.getElementById("ws-subtitle").textContent = projectPath;
  document.title = `${projectName} — workspace`;

  // The same badge every tool header carries, and for the same reason: the
  // workspace has been built and not put through its paces, and that is
  // something to be told rather than to discover. `maturity.js` wires the
  // explanation popover itself, so this is the whole of it.
  const maturityEl = document.getElementById("ws-maturity");
  if (maturityEl) maturityEl.innerHTML = window.wintMaturity?.badge("workspace") ?? "";

  const esc = (v = "") => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (name) => `<span class="ms" aria-hidden="true">${name}</span>`;

  /* ------------------------------------------------------------ status bar */

  // Never empty, the way the main window's is never empty: with nothing in
  // flight it says what the workspace last did, because a line that comes and
  // goes cannot be glanced at.
  const statusEl = document.getElementById("ws-status");
  let busyCount = 0;
  const say = (text) => { statusEl.firstChild ? (statusEl.firstChild.nodeValue = text) : (statusEl.textContent = text); };
  const busy = async (text, work) => {
    busyCount += 1;
    statusEl.classList.add("busy");
    say(text);
    try {
      return await work();
    } finally {
      busyCount -= 1;
      if (busyCount === 0) statusEl.classList.remove("busy");
    }
  };
  say("Opening the workspace");

  /* --------------------------------------------------------------- layout */

  const SLOTS = ["left-top", "left-bottom", "center", "right", "bottom"];
  // v2: the default split changed, and a saved v1 layout would keep handing the
  // save-and-upload panel half the column it no longer needs.
  const KEY = `wint.workspace.v2:${projectPath.toLowerCase()}`;
  const DEFAULT_LAYOUT = {
    slots: { "left-top": "files", "left-bottom": "git", center: "browser", right: "chat", bottom: "terminal" },
    hidden: {},
    // The save-and-upload panel is a message box and three buttons, so it gets
    // what that needs and the file list gets the rest of the column.
    size: { left: 280, right: 420, bottom: 260, leftSplit: 0.78 },
  };

  const layout = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!saved?.slots) return structuredClone(DEFAULT_LAYOUT);
      // A layout saved by an older build can name a panel this one no longer
      // has, or miss one it has gained. Rebuilding the assignment from the
      // panel list rather than trusting the file is what stops a slot ending
      // up empty and a panel ending up nowhere.
      return {
        slots: { ...DEFAULT_LAYOUT.slots, ...saved.slots },
        hidden: { ...saved.hidden },
        size: { ...DEFAULT_LAYOUT.size, ...saved.size },
      };
    } catch {
      return structuredClone(DEFAULT_LAYOUT);
    }
  })();

  const saveLayout = () => { try { localStorage.setItem(KEY, JSON.stringify(layout)); } catch {} };
  const slotOf = (panelId) => SLOTS.find((slot) => layout.slots[slot] === panelId) || "";
  const visible = (panelId) => { const slot = slotOf(panelId); return Boolean(slot) && !layout.hidden[slot]; };

  /* --------------------------------------------------------------- panels */

  /** Every panel is built once, into its own element, and then only ever moved
   *  between slots. `resized` is called after any move or resize that could
   *  have changed its box. */
  const panels = new Map();
  const definePanel = (id, def) => panels.set(id, { id, resized: () => {}, ...def });

  const panelEl = (panel) => {
    if (panel.el) return panel.el;
    const el = document.createElement("div");
    el.className = `ws-panel ws-panel-${panel.id}`;
    el.dataset.panel = panel.id;
    el.innerHTML = `<header class="ws-head" draggable="true">
        <span class="ws-head-grip">${icon("drag_indicator")}</span>
        ${icon(panel.icon)}<strong>${esc(panel.label)}</strong>
        <span class="ws-head-tools"></span>
        <button class="ws-head-hide" type="button" title="Hide this panel" aria-label="Hide this panel">${icon("close")}</button>
      </header>
      <div class="ws-panel-body"></div>`;
    panel.el = el;
    panel.body = el.querySelector(".ws-panel-body");
    panel.tools = el.querySelector(".ws-head-tools");
    el.querySelector(".ws-head-hide").addEventListener("click", () => {
      const slot = slotOf(panel.id);
      if (slot) { layout.hidden[slot] = true; render(); }
    });
    panel.mount?.(panel.body, panel);
    return el;
  };

  /* ------------------------------------------------------------- the grid */

  const grid = document.getElementById("ws-grid");
  const slotEls = new Map(SLOTS.map((slot) => [slot, document.querySelector(`[data-slot="${slot}"]`)]));
  const gripEls = [...document.querySelectorAll("[data-grip]")];
  const togglesEl = document.getElementById("ws-toggles");
  const centerColEl = document.getElementById("ws-center-col");
  const bottomDock = document.getElementById("ws-bottom-dock");

  /** Where the bottom panel hangs from.
   *
   *  Under the center panel while there is one, because a terminal belongs to
   *  the thing above it — running under the file list and the chat as well
   *  makes the window read as four unrelated strips. With the center panel
   *  hidden there is nothing to sit under, so it goes to the foot of the
   *  window and takes the full width. */
  const dockBottom = () => {
    const host = layout.slots.center && !layout.hidden.center ? centerColEl : document.body;
    if (bottomDock.parentElement === host) return false;
    host === document.body ? document.body.insertBefore(bottomDock, statusEl) : host.appendChild(bottomDock);
    return true;
  };

  const applySizes = () => {
    // On `body`, not on `:root`. The defaults are declared in the stylesheet on
    // `body.workspace` itself, and an element's own declaration beats the value
    // it would otherwise inherit - so a size written to the root element is
    // shadowed here and every divider drag is silently a no-op.
    const root = document.body.style;
    const shown = (slot) => Boolean(layout.slots[slot]) && !layout.hidden[slot];
    const leftShown = shown("left-top") || shown("left-bottom");
    root.setProperty("--ws-left", leftShown ? `${layout.size.left}px` : "0px");
    root.setProperty("--ws-right", shown("right") ? `${layout.size.right}px` : "0px");
    root.setProperty("--ws-bottom", shown("bottom") ? `${layout.size.bottom}px` : "0px");
    // With one of the two left panels hidden the other takes the whole column,
    // rather than the survivor keeping half and leaving a gap.
    const split = shown("left-top") && shown("left-bottom") ? layout.size.leftSplit : shown("left-top") ? 1 : 0;
    root.setProperty("--ws-left-split", `${split * 100}%`);
    document.body.classList.toggle("ws-no-left", !leftShown);
    // With nothing in the middle there is no middle: the two sides close up
    // against each other rather than leaving a hole where the browser was, and
    // the right one takes whatever the left does not want.
    document.body.classList.toggle("ws-no-center", !shown("center"));
    for (const [slot, el] of slotEls) el.hidden = !shown(slot);
    bottomDock.hidden = !shown("bottom");
    dockBottom();
    for (const grip of gripEls) {
      grip.hidden =
        grip.dataset.grip === "left" ? !leftShown
        // With the middle gone the right column is what fills the space, so
        // there is only one boundary left to drag and the left grip is it.
        : grip.dataset.grip === "right" ? !shown("right") || !shown("center")
        : grip.dataset.grip === "bottom" ? !shown("bottom")
        : !(shown("left-top") && shown("left-bottom"));
    }
  };

  let renderQueued = false;
  const render = () => {
    if (renderQueued) return;
    renderQueued = true;
    // The whole window redraws on one frame, the way the main window does, so
    // a swap that moves two panels never paints a half-applied layout.
    requestAnimationFrame(() => {
      renderQueued = false;
      for (const slot of SLOTS) {
        const host = slotEls.get(slot);
        const panel = panels.get(layout.slots[slot]);
        if (!panel) { host.replaceChildren(); continue; }
        const el = panelEl(panel);
        if (el.parentElement !== host) host.replaceChildren(el);
      }
      applySizes();
      renderToggles();
      saveLayout();
      // Sizes are only real once the browser has laid the grid out, so
      // everything that measures waits for the frame after this one.
      requestAnimationFrame(() => {
        for (const panel of panels.values()) if (visible(panel.id)) panel.resized();
        syncBrowser();
      });
    });
  };

  const renderToggles = () => {
    togglesEl.innerHTML = SLOTS.map((slot) => {
      const panel = panels.get(layout.slots[slot]);
      if (!panel) return "";
      const on = !layout.hidden[slot];
      return `<button class="ws-toggle${on ? " on" : ""}" data-toggle="${slot}" type="button" aria-pressed="${on}" title="${esc(panel.label)}">${icon(panel.icon)}</button>`;
    }).join("");
  };

  togglesEl.addEventListener("click", (e) => {
    const button = e.target.closest("[data-toggle]");
    if (!button) return;
    const slot = button.dataset.toggle;
    layout.hidden[slot] = !layout.hidden[slot];
    say(`${layout.hidden[slot] ? "Hid" : "Showed"} ${panels.get(layout.slots[slot])?.label || slot}`);
    render();
  });

  /* -------------------------------------------------------- moving panels */

  // Dragging a panel's header onto another panel swaps the two. Swapping keeps
  // every slot filled, which is the whole reason the layout is five slots and
  // not a free-form tree: there is no arrangement you can drag it into that
  // leaves a hole or loses a panel.
  let dragging = "";
  const dropEl = document.getElementById("ws-drop");

  grid.addEventListener("dragstart", (e) => {
    const head = e.target.closest(".ws-head");
    if (!head) return;
    dragging = head.closest(".ws-panel").dataset.panel;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragging);
    document.body.classList.add("ws-dragging");
    // The browser webview is drawn over the page, so during a drag it would
    // swallow every drop target underneath it.
    hideBrowser();
  }, true);

  const endDrag = () => {
    dragging = "";
    document.body.classList.remove("ws-dragging");
    dropEl.hidden = true;
    for (const el of slotEls.values()) el.classList.remove("ws-over");
    syncBrowser();
  };
  document.addEventListener("dragend", endDrag);

  for (const [slot, el] of slotEls) {
    el.addEventListener("dragover", (e) => {
      if (!dragging || layout.slots[slot] === dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("ws-over");
    });
    el.addEventListener("dragleave", () => el.classList.remove("ws-over"));
    el.addEventListener("drop", (e) => {
      if (!dragging) return;
      e.preventDefault();
      const from = slotOf(dragging);
      if (!from || from === slot) return endDrag();
      const moved = panels.get(dragging)?.label || dragging;
      const displaced = panels.get(layout.slots[slot])?.label || "";
      [layout.slots[from], layout.slots[slot]] = [layout.slots[slot], layout.slots[from]];
      // Visibility belongs to the panel, not the hole it was sitting in:
      // dropping a panel onto a hidden slot must not hide it.
      [layout.hidden[from], layout.hidden[slot]] = [layout.hidden[slot], layout.hidden[from]];
      say(`Moved ${moved}${displaced ? `, swapped with ${displaced}` : ""}`);
      endDrag();
      render();
    });
  }

  /* ----------------------------------------------------------- the grips */

  for (const grip of gripEls) {
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const which = grip.dataset.grip;
      const start = { x: e.clientX, y: e.clientY, ...layout.size };
      // A native child webview does not forward pointer events to the page, so
      // a drag that crosses it would simply stop. Hiding it for the duration is
      // what keeps the divider following the pointer all the way across.
      hideBrowser();
      document.body.classList.add("ws-resizing");

      const move = (ev) => {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (which === "left") layout.size.left = Math.max(160, Math.min(640, start.left + dx));
        else if (which === "right") layout.size.right = Math.max(220, Math.min(760, start.right - dx));
        else if (which === "bottom") {
          // How far it can grow depends on where it is hanging from: the whole
          // window at the foot, or just the center column when it is under the
          // center panel.
          const room = bottomDock.parentElement === document.body
            ? window.innerHeight - 120
            : centerColEl.getBoundingClientRect().height - 60;
          layout.size.bottom = Math.max(120, Math.min(Math.max(120, room), start.bottom - dy));
        }
        else {
          const column = slotEls.get("left-top").parentElement.getBoundingClientRect();
          layout.size.leftSplit = Math.max(0.15, Math.min(0.85, start.leftSplit + dy / Math.max(1, column.height)));
        }
        applySizes();
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        document.body.classList.remove("ws-resizing");
        saveLayout();
        for (const panel of panels.values()) if (visible(panel.id)) panel.resized();
        syncBrowser();
        say("Resized the panels");
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
  }

  window.addEventListener("resize", () => {
    for (const panel of panels.values()) if (visible(panel.id)) panel.resized();
    syncBrowser();
  });

  /* --------------------------------------------------------- window chrome */

  // The window has no native frame, so the title bar has to move it itself.
  document.querySelector(".titlebar .drag")?.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    win.startDragging().catch(() => {});
  });
  document.querySelector(".titlebar .drag")?.addEventListener("dblclick", async () => {
    (await win.isMaximized()) ? win.unmaximize() : win.maximize();
  });

  document.querySelectorAll("[data-win]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.win;
      if (action === "min") return win.minimize();
      if (action === "max") return (await win.isMaximized()) ? win.unmaximize() : win.maximize();
      // The child webview is not destroyed with the page, so it is closed
      // explicitly rather than left behind holding a page open.
      await invoke("workspace_browser_close", { window: label }).catch(() => {});
      return win.close();
    });
  });

  /* ------------------------------------------------------- panel: browser */

  let browserUrl = "";
  let browserShown = false;

  /** Where the hole in the page is, in the window's own coordinates. */
  const browserRect = () => {
    const panel = panels.get("browser");
    const hole = panel?.hole;
    if (!hole || !visible("browser")) return null;
    const rect = hole.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return null;
    return rect;
  };

  const hideBrowser = () => {
    if (!browserShown) return;
    browserShown = false;
    invoke("workspace_browser_hide", { window: label }).catch(() => {});
  };

  /** Puts the webview exactly over the hole, creating it the first time. */
  const syncBrowser = () => {
    const rect = browserRect();
    if (!rect || !browserUrl || panels.get("browser")?.previewOpen) return hideBrowser();
    browserShown = true;
    invoke("workspace_browser_show", {
      window: label,
      url: browserUrl,
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    }).catch((err) => {
      browserShown = false;
      say(String(err));
    });
  };

  const goTo = (url, reason = "") => {
    const target = /^[a-z]+:\/\//i.test(url) ? url : `http://${url}`;
    const first = !browserUrl;
    browserUrl = target;
    const panel = panels.get("browser");
    if (panel?.address) panel.address.value = target;
    if (panel) panel.previewOpen = false;
    if (panel?.preview) panel.preview.hidden = true;
    if (panel?.empty) panel.empty.hidden = true;
    // An address arriving while the browser is hidden is still worth having:
    // it loads as soon as the panel is shown again.
    if (!first && browserShown) invoke("workspace_browser_navigate", { window: label, url: target }).catch(() => {});
    else syncBrowser();
    say(reason || `Browsing ${target}`);
  };

  definePanel("browser", {
    label: "Browser",
    icon: "public",
    mount(body, panel) {
      panel.tools.innerHTML = `
        <button class="ws-mini" data-browser="reload" type="button" title="Reload">${icon("refresh")}</button>
        <input class="ws-address" data-browser="address" placeholder="localhost:3000" spellcheck="false" />
        <button class="ws-mini" data-browser="external" type="button" title="Open in your real browser">${icon("open_in_new")}</button>`;
      panel.address = panel.tools.querySelector("[data-browser=address]");
      body.innerHTML = `<div class="ws-browser-hole"></div>
        <div class="ws-browser-empty">${icon("public")}<strong>Nothing to show yet</strong>
          <p>Start a dev server in the terminal below. The moment it prints a localhost address, this panel opens it.</p></div>
        <div class="ws-preview" hidden><header><strong></strong><button type="button" class="ws-mini">${icon("close")}</button></header><pre></pre></div>`;
      panel.hole = body.querySelector(".ws-browser-hole");
      panel.empty = body.querySelector(".ws-browser-empty");
      panel.preview = body.querySelector(".ws-preview");
      panel.previewOpen = false;

      panel.tools.addEventListener("click", (e) => {
        const action = e.target.closest("[data-browser]")?.dataset.browser;
        if (action === "reload" && browserUrl) invoke("workspace_browser_reload", { window: label }).catch(() => {});
        if (action === "external" && browserUrl) invoke("plugin:opener|open_url", { url: browserUrl }).catch(() => {});
      });
      panel.address.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && panel.address.value.trim()) goTo(panel.address.value.trim());
      });
      panel.preview.querySelector("button").addEventListener("click", () => {
        panel.previewOpen = false;
        panel.preview.hidden = true;
        syncBrowser();
        say("Closed the preview");
      });
    },
    resized: () => syncBrowser(),
  });

  /** Shows a file's text over the browser hole. The webview has to go away
   *  while this is up: it is drawn above the page and would sit on top of it. */
  const showPreview = async (path, name) => {
    const panel = panels.get("browser");
    if (!panel?.preview) return;
    if (!visible("browser")) {
      const slot = slotOf("browser");
      if (slot) layout.hidden[slot] = false;
      render();
    }
    panel.previewOpen = true;
    panel.empty.hidden = true;
    panel.preview.hidden = false;
    panel.preview.querySelector("strong").textContent = name;
    panel.preview.querySelector("pre").textContent = "Reading…";
    hideBrowser();
    try {
      const text = await busy(`Reading ${name}`, () => invoke("workspace_read_file", { path }));
      panel.preview.querySelector("pre").textContent = text;
      say(`Showing ${name}`);
    } catch (err) {
      panel.preview.querySelector("pre").textContent = String(err);
      say(String(err));
    }
  };

  /* --------------------------------------------------------- panel: files */

  /** The files git says have changed, as the file panel wants them: absolute,
   *  in this machine's separator, newest information wins. Published from the
   *  git panel because that is what already asks; held here because the file
   *  panel is what shows it. */
  let changedFiles = [];
  const publishChanged = (changed) => {
    changedFiles = changed.map((file) => ({
      ...file,
      full: `${projectPath.replace(/[\\/]+$/, "")}\\${file.path.replace(/\//g, "\\")}`,
      name: file.path.split(/[\\/]/).pop(),
    }));
    const files = panels.get("files");
    if (!files?.tree) return;
    renderFilesTools(files);
    if (files.changedOnly) renderChangedOnly(files);
  };

  /** All / Changed, as two words rather than a funnel that could mean anything.
   *  The count rides on the Changed side, so how much there is to look at is
   *  readable without switching to it. */
  const renderFilesTools = (panel) => {
    const count = changedFiles.length;
    panel.tools.innerHTML = `
      <span class="ws-seg" role="group" aria-label="Which files to show">
        <button type="button" data-files="all" class="${panel.changedOnly ? "" : "on"}"
                aria-pressed="${!panel.changedOnly}">All</button>
        <button type="button" data-files="changed" class="${panel.changedOnly ? "on" : ""}"
                aria-pressed="${panel.changedOnly}" title="Only the files you have changed">Changed${count ? ` <b>${count}</b>` : ""}</button>
      </span>
      <button class="ws-mini" data-files="refresh" type="button" title="Look again">${icon("refresh")}</button>`;
  };

  definePanel("files", {
    label: "Files",
    icon: "folder_open",
    mount(body, panel) {
      body.className += " ws-files";
      body.innerHTML = `<div class="ws-tree" data-depth="0"></div>`;
      panel.tree = body.querySelector(".ws-tree");
      panel.open = new Set();
      panel.changedOnly = false;
      renderFilesTools(panel);
      panel.tools.addEventListener("click", (e) => {
        const action = e.target.closest("[data-files]")?.dataset.files;
        if (action === "refresh") {
          return panel.changedOnly ? refreshGit() : loadDir(panel, panel.tree, projectPath, 0);
        }
        if (action !== "all" && action !== "changed") return;
        const wanted = action === "changed";
        if (wanted === panel.changedOnly) return;
        panel.changedOnly = wanted;
        renderFilesTools(panel);
        if (wanted) {
          renderChangedOnly(panel);
          // The list is only as fresh as the last look at git, and the panel
          // that looks may not even be showing.
          refreshGit();
        } else {
          loadDir(panel, panel.tree, projectPath, 0);
        }
      });
      body.addEventListener("click", async (e) => {
        const row = e.target.closest("[data-path]");
        if (!row) return;
        if (row.dataset.directory === "true") {
          const children = row.nextElementSibling;
          const open = row.classList.toggle("open");
          row.querySelector(".ws-tree-caret").textContent = open ? "expand_more" : "chevron_right";
          open ? panel.open.add(row.dataset.path) : panel.open.delete(row.dataset.path);
          children.hidden = !open;
          if (open && !children.dataset.loaded) await loadDir(panel, children, row.dataset.path, Number(row.dataset.depth) + 1);
          return;
        }
        showPreview(row.dataset.path, row.dataset.name);
      });
      loadDir(panel, panel.tree, projectPath, 0);
    },
  });

  /** Asks git again, whoever is asking. The git panel owns the call; the file
   *  panel needs the answer, and neither is guaranteed to be on screen. */
  const refreshGit = () => {
    const git = panels.get("git");
    if (git?.state) loadGit(git);
  };

  /** The changed files, in the same tree shape as everything else - only the
   *  branches that contain a change, and every one of them already open.
   *
   *  Built whole rather than folder by folder: git has already said exactly
   *  which paths changed, so there is nothing to go and look up and no reason
   *  to make anyone click. The folder rows are labels, not buttons, because
   *  there is nothing behind them to reveal. */
  function renderChangedOnly(panel) {
    const mark = (status) => status === "untracked" ? "note_add" : status === "conflict" ? "error" : "edit";

    // { folders: Map<name, node>, files: [] } - insertion order is git's, which
    // is already alphabetical within a folder.
    const root = { folders: new Map(), files: [] };
    for (const file of changedFiles) {
      const parts = file.path.split(/[\\/]/);
      let node = root;
      for (const folder of parts.slice(0, -1)) {
        if (!node.folders.has(folder)) node.folders.set(folder, { folders: new Map(), files: [] });
        node = node.folders.get(folder);
      }
      node.files.push(file);
    }

    const draw = (node, depth) => [
      ...[...node.folders].map(([name, child]) => `
        <div class="ws-tree-row dir static" style="--ws-depth:${depth}">
          <span class="ms ws-tree-caret" aria-hidden="true">expand_more</span>
          <span class="ws-tree-name">${esc(name)}</span>
        </div>${draw(child, depth + 1)}`),
      ...node.files.map((file) => `
        <button class="ws-tree-row" data-path="${esc(file.full)}" data-name="${esc(file.name)}"
                data-directory="false" data-depth="${depth}" style="--ws-depth:${depth}" title="${esc(file.path)}">
          <span class="ms ws-tree-caret ${file.status === "conflict" ? "bad" : "changed"}" aria-hidden="true">${mark(file.status)}</span>
          <span class="ws-tree-name">${esc(file.name)}</span>
        </button>`),
    ].join("");

    panel.tree.innerHTML = draw(root, 0)
      || `<div class="ws-tree-note">Nothing has changed since your last save.</div>`;
  }

  async function loadDir(panel, host, path, depth) {
    host.dataset.loaded = "1";
    host.innerHTML = `<div class="ws-tree-note">Reading…</div>`;
    try {
      const rows = await busy(depth ? `Reading ${path.split(/[\\/]/).pop()}` : "Reading the project folder", () => invoke("workspace_list_dir", { path }));
      host.innerHTML = rows.map((row) => `
        <button class="ws-tree-row${row.directory ? " dir" : ""}" data-path="${esc(row.path)}" data-name="${esc(row.name)}"
                data-directory="${row.directory}" data-depth="${depth}" style="--ws-depth:${depth}">
          <span class="ms ws-tree-caret" aria-hidden="true">${row.directory ? "chevron_right" : "description"}</span>
          <span class="ws-tree-name">${esc(row.name)}</span>
        </button>${row.directory ? `<div class="ws-tree" hidden></div>` : ""}`).join("")
        || `<div class="ws-tree-note">This folder is empty.</div>`;
      if (!depth) say(`${rows.length} item${rows.length === 1 ? "" : "s"} in ${projectName}`);
    } catch (err) {
      host.innerHTML = `<div class="ws-tree-note">${esc(String(err))}</div>`;
      say(String(err));
    }
  }

  /* ----------------------------------------------------------- panel: git */

  definePanel("git", {
    label: "Save & upload",
    icon: "backup",
    mount(body, panel) {
      panel.tools.innerHTML = `<button class="ws-mini" data-git="refresh" type="button" title="Check again">${icon("refresh")}</button>`;
      body.className += " ws-git";
      // Deliberately no list of changed files. The file panel above already
      // lists this project's files and can be filtered down to the changed
      // ones, and two lists of the same thing in one column is one too many.
      body.innerHTML = `<div class="ws-git-state"></div>
        <form class="ws-git-form"><input name="message" placeholder="What did you change?" autocomplete="off" />
          <div class="ws-git-buttons">
            <button type="submit" class="ws-btn primary" data-git="save">${icon("bookmark_add")}Save</button>
            <button type="button" class="ws-btn" data-git="push">${icon("cloud_upload")}Upload</button>
            <button type="button" class="ws-btn" data-git="pull">${icon("cloud_download")}Get</button>
          </div></form>`;
      panel.state = body.querySelector(".ws-git-state");
      panel.form = body.querySelector(".ws-git-form");
      panel.tools.addEventListener("click", () => loadGit(panel));
      panel.form.addEventListener("submit", (e) => { e.preventDefault(); saveVersion(panel); });
      body.addEventListener("click", (e) => {
        const action = e.target.closest("[data-git]")?.dataset.git;
        if (action === "push") gitAct(panel, "push", "Uploading your work");
        if (action === "pull") gitAct(panel, "pull", "Getting your team's changes");
      });
      loadGit(panel);
    },
  });

  async function loadGit(panel) {
    try {
      const data = await busy("Checking what changed", () => invoke("git_workspace", { path: projectPath }));
      panel.data = data;
      const g = data.info;
      const changed = g.changed || [];
      panel.state.innerHTML = `
        <p class="ws-git-branch">${icon("fork_right")}<strong>${esc(g.branch || "detached")}</strong>
          ${g.ahead ? `<b title="Recorded here, not uploaded">${g.ahead} to upload</b>` : ""}
          ${g.behind ? `<b title="Waiting from your team">${g.behind} to get</b>` : ""}</p>
        <p class="ws-git-line">${changed.length
          ? `${changed.length} changed file${changed.length === 1 ? "" : "s"} not saved yet.`
          : g.ahead ? "Everything is saved here, but not uploaded yet." : "Nothing to save. You are up to date."}</p>`;
      publishChanged(changed);
      say(changed.length ? `${changed.length} file${changed.length === 1 ? "" : "s"} changed` : "Nothing to save");
    } catch (err) {
      panel.state.innerHTML = `<p class="ws-git-line">${esc(String(err))}</p>`;
      say(String(err));
    }
  }

  async function gitAct(panel, action, label) {
    try {
      const result = await busy(label, () => invoke("git_action", { request: { path: projectPath, action, value: "", amend: false } }));
      say(result.ok ? result.output?.trim().split("\n").pop() || "Done" : String(result.output));
    } catch (err) {
      say(String(err));
    }
    await loadGit(panel);
  }

  /** Stage everything, commit it, and say plainly that it is not uploaded yet
   *  — the one thing people get wrong about committing. */
  async function saveVersion(panel) {
    const input = panel.form.querySelector("input");
    const message = input.value.trim();
    if (!message) { input.focus(); return say("Say what you changed first"); }
    const changed = panel.data?.info?.changed || [];
    if (!changed.length) return say("There is nothing to save");
    try {
      await busy(`Saving ${changed.length} file${changed.length === 1 ? "" : "s"}`, async () => {
        for (const file of changed) {
          await invoke("git_action", { request: { path: projectPath, action: "stage", value: file.path, amend: false } });
        }
        const result = await invoke("git_action", { request: { path: projectPath, action: "commit", value: message, amend: false } });
        if (!result.ok) throw new Error(result.output);
      });
      input.value = "";
      say("Saved on this computer. Not uploaded yet — press Upload when you're ready.");
    } catch (err) {
      say(String(err));
    }
    await loadGit(panel);
  }

  /* --------------------------------------------------- panels: terminals */

  const sessions = new Map();

  /** A terminal panel. The session lives in Rust, so moving this panel between
   *  slots — or closing the window entirely — leaves whatever is running in it
   *  running. */
  const defineTerminal = (id, { label: name, icon: glyph, shell, hint }) => definePanel(id, {
    label: name,
    icon: glyph,
    async mount(body, panel) {
      body.className += " ws-term";
      const host = document.createElement("div");
      host.className = "term-host";
      body.appendChild(host);
      try {
        const info = await busy(`Starting ${name}`, () => invoke("term_open", {
          args: { projectPath, projectName, shell },
        }));
        const view = new window.TermView(host, info.id);
        panel.view = view;
        panel.info = await view.attach();
        sessions.set(info.id, panel);
        view.onExit = () => say(`${name} ended`);
        view.fit();
        say(hint || `${name} is ready`);
        // A dev server that was already running before this window opened has
        // said where it is; nobody was listening at the time.
        const already = await invoke("term_serving", { id: info.id }).catch(() => null);
        if (already && !browserUrl) goTo(already, `Found ${already} already running`);
      } catch (err) {
        host.innerHTML = `<div class="ws-term-error">${esc(String(err))}</div>`;
        say(String(err));
      }
    },
    resized() { this.view?.fit(); },
  });

  // "auto" is what the Rust side calls "whichever shell this machine has".
  // An empty string is not a profile it knows, and asking for one is how this
  // panel used to open onto "Unknown terminal shell."
  defineTerminal("terminal", { label: "Terminal", icon: "terminal", shell: "auto", hint: "Terminal ready" });
  /* ------------------------------------------------------- panel: Claude */

  // A chat, not a terminal. The CLI has a machine-readable mode - one JSON
  // object per line - so the conversation is rendered here rather than folding
  // a full-screen terminal program into a narrow pane, which is how this panel
  // used to open onto theme pickers and wrapped ASCII art.
  //
  // The schema is Anthropic's and it grows. Every line is matched on the few
  // fields this needs and anything else is ignored rather than dropped, so a
  // newer CLI adding an event type cannot break the panel.
  definePanel("chat", {
    label: "Claude",
    icon: "forum",
    mount(body, panel) {
      // The workspace mints the conversation's id rather than reading one back
      // off the stream, so a terminal can be pointed at the same conversation
      // before the chat has said anything. `--session-id` names it on the first
      // turn; every turn after that resumes it.
      panel.session = newSessionId();
      panel.started = false;
      panel.turns = [];
      panel.streaming = null;
      body.className += " ws-chat";
      body.innerHTML = `<div class="ws-chat-log"></div>
        <form class="ws-chat-ask" hidden>
          <textarea rows="1" placeholder="Ask Claude about this project…" spellcheck="false"></textarea>
          <button type="submit" class="ws-chat-send" title="Send (Enter)">${icon("send")}</button>
          <button type="button" class="ws-chat-stop" title="Stop" hidden>${icon("stop_circle")}</button>
        </form>`;
      panel.log = body.querySelector(".ws-chat-log");
      panel.ask = body.querySelector(".ws-chat-ask");
      panel.input = panel.ask.querySelector("textarea");
      panel.tools.innerHTML = `
        <button class="ws-mini" data-chat="terminal" type="button" title="Open this conversation in a terminal">${icon("terminal")}</button>
        <button class="ws-mini" data-chat="new" type="button" title="Start a new conversation">${icon("refresh")}</button>`;
      panel.tools.addEventListener("click", (e) => {
        const action = e.target.closest("[data-chat]")?.dataset.chat;
        if (action === "terminal") return openClaudeTerminal(panel);
        if (action !== "new") return;
        panel.session = newSessionId();
        panel.started = false;
        panel.turns = [];
        renderChat(panel);
        say("Started a new conversation");
      });

      // Enter sends, Shift+Enter is a newline - the same bargain every chat
      // makes, and the one people's hands already expect.
      panel.input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); panel.ask.requestSubmit(); }
      });
      panel.input.addEventListener("input", () => {
        panel.input.style.height = "auto";
        panel.input.style.height = `${Math.min(160, panel.input.scrollHeight)}px`;
      });
      panel.ask.addEventListener("submit", (e) => { e.preventDefault(); sendToClaude(panel); });
      panel.ask.querySelector(".ws-chat-stop").addEventListener("click", () => {
        invoke("claude_cancel", { window: label }).catch(() => {});
        say("Stopped");
      });
      body.addEventListener("click", (e) => {
        const action = e.target.closest("[data-chat]")?.dataset.chat;
        if (action === "install") installClaude(panel);
        if (action === "signin") signInToClaude(panel);
        if (action === "recheck") checkClaude(panel);
        if (action === "terminal") openClaudeTerminal(panel);
      });
      checkClaude(panel);
    },
  });

  /** A conversation's name, minted here so both surfaces can use it.
   *  `--session-id` requires a UUID. */
  const newSessionId = () => (crypto.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      }));

  /** The whole conversation, in the CLI's own interface, over the window.
   *
   *  This is the way out of everything the chat cannot do: approving a command
   *  Claude wants to run, signing in, a slash command, plan mode. It is the
   *  same conversation because both surfaces name it - `--resume` takes a
   *  session id interactively as well as in print mode - so an answer given
   *  here is in the history the chat picks up again afterwards.
   *
   *  Full window, because the CLI's interface is a full-screen program and
   *  cramming it into a pane is what this panel exists to stop. */
  async function openClaudeTerminal(panel) {
    if (claudeOverlay.session) { claudeOverlay.el.hidden = false; hideBrowser(); return; }
    let command;
    try {
      command = await invoke("claude_terminal_command", { session: panel.session || null });
    } catch (err) {
      return say(String(err));
    }
    claudeOverlay.el.hidden = false;
    // The browser panel is a native webview drawn over the page, so it would
    // sit on top of this overlay rather than behind it.
    hideBrowser();
    claudeOverlay.note.textContent = panel.started
      ? "The same conversation, in Claude's own interface. Answer here, then close this and carry on in the chat."
      : "Claude's own interface. Anything you do here is in the conversation the chat picks up.";
    try {
      const info = await busy("Opening Claude in a terminal", () => invoke("term_open", {
        args: { projectPath, projectName, command },
      }));
      const view = new window.TermView(claudeOverlay.host, info.id);
      claudeOverlay.session = { id: info.id, view };
      await view.attach();
      view.fit();
      // A conversation the chat had not started yet has been started now, by
      // the terminal - so the next chat turn must resume rather than claim it.
      panel.started = true;
      say("Claude is open in a terminal");
    } catch (err) {
      claudeOverlay.host.innerHTML = `<div class="ws-term-error">${esc(String(err))}</div>`;
      say(String(err));
    }
  }

  /** Closing puts the chat back in charge. The session in Rust is ended: two
   *  processes holding the same conversation open is how a session file ends up
   *  written by whichever exits last. */
  async function closeClaudeTerminal() {
    const open = claudeOverlay.session;
    claudeOverlay.session = null;
    claudeOverlay.el.hidden = true;
    claudeOverlay.host.replaceChildren();
    syncBrowser();
    if (open) await invoke("term_close", { id: open.id }).catch(() => {});
    const panel = panels.get("chat");
    if (panel) renderChat(panel);
    say("Back to the chat");
  }

  const claudeOverlay = (() => {
    const el = document.createElement("div");
    el.className = "ws-claude-full";
    el.hidden = true;
    el.innerHTML = `<header>${icon("forum")}<strong>Claude Code</strong>
        <span class="ws-claude-note"></span>
        <button type="button" class="ws-btn" data-claude-full="close">${icon("close")}Back to the chat</button>
      </header>
      <div class="term-host"></div>`;
    document.body.appendChild(el);
    el.querySelector("[data-claude-full=close]").addEventListener("click", closeClaudeTerminal);
    return { el, host: el.querySelector(".term-host"), note: el.querySelector(".ws-claude-note"), session: null };
  })();

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !claudeOverlay.el.hidden) closeClaudeTerminal();
  });

  async function checkClaude(panel) {
    panel.status = await invoke("claude_status").catch(() => ({ installed: false }));
    renderChat(panel);
  }

  /** The whole panel: the install card, the sign-in card, or the conversation.
   *  One function so the panel can never show two of those at once. */
  function renderChat(panel) {
    const busy = Boolean(panel.streaming);
    panel.ask.hidden = !panel.status?.installed;
    panel.ask.querySelector(".ws-chat-send").hidden = busy;
    panel.ask.querySelector(".ws-chat-stop").hidden = !busy;

    if (!panel.status?.installed) {
      panel.log.innerHTML = `<div class="ws-chat-card">${icon("forum")}
        <strong>Claude Code isn't installed</strong>
        <p>WinT doesn't ship it and holds no key for it. You install Anthropic's CLI and sign in as
           yourself; this panel gives it somewhere to talk.</p>
        <div class="ws-chat-card-actions">
          <button class="ws-btn primary" data-chat="install" type="button">${icon("download")}Install with npm</button>
          <button class="ws-btn" data-chat="recheck" type="button">${icon("refresh")}Check again</button>
        </div>
        <pre class="ws-chat-install" hidden></pre></div>`;
      return;
    }
    if (panel.needsSignIn) {
      panel.log.innerHTML = `<div class="ws-chat-card">${icon("account_circle")}
        <strong>Sign in to Claude Code</strong>
        <p>The CLI is installed but not signed in. Signing in happens in a terminal, once —
           it opens your browser and the account it signs in as is yours, not WinT's.</p>
        <div class="ws-chat-card-actions">
          <button class="ws-btn primary" data-chat="signin" type="button">${icon("terminal")}Open a terminal to sign in</button>
          <button class="ws-btn" data-chat="recheck" type="button">${icon("refresh")}I've signed in</button>
        </div></div>`;
      return;
    }
    if (!panel.turns.length) {
      panel.log.innerHTML = `<div class="ws-chat-card quiet">${icon("forum")}
        <strong>Claude Code ${esc(panel.status.version || "")}</strong>
        <p>Working in <code>${esc(projectName)}</code>. Ask it anything about this project.</p></div>`;
      return;
    }
    // A turn that ended badly is nearly always a tool Claude was not allowed to
    // run: in this mode there is nobody to ask, so it declines. The way to say
    // yes is the CLI's own interface, on this same conversation.
    const stuck = !busy && panel.turns[panel.turns.length - 1]?.role === "error";
    panel.log.innerHTML = panel.turns.map(turnHtml).join("")
      + (stuck ? `<div class="ws-chat-rescue">${icon("terminal")}
          <span>Claude may have wanted permission to run something. It can only ask you in its own
                interface — this opens the same conversation there.</span>
          <button class="ws-btn primary" data-chat="terminal" type="button">Continue in a terminal</button>
        </div>` : "");
    panel.log.scrollTop = panel.log.scrollHeight;
  }

  const turnHtml = (turn) => {
    if (turn.role === "you") {
      return `<div class="ws-turn you"><div class="ws-turn-body">${esc(turn.text)}</div></div>`;
    }
    if (turn.role === "tool") {
      return `<div class="ws-turn tool">${icon(turn.icon || "build")}<span>${esc(turn.text)}</span></div>`;
    }
    if (turn.role === "error") {
      return `<div class="ws-turn error">${icon("error")}<span>${esc(turn.text)}</span></div>`;
    }
    return `<div class="ws-turn claude"><div class="ws-turn-body">${markdown(turn.text)}</div></div>`;
  };

  /** Enough markdown for what a chat answer actually contains: fenced code,
   *  inline code, bold, and paragraphs. Everything is escaped first, so this
   *  can only ever add the tags it puts in itself. */
  function markdown(text) {
    const fences = [];
    let out = esc(text).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      fences.push(`<pre class="ws-code"${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${code.replace(/\n$/, "")}</code></pre>`);
      return `\u0000${fences.length - 1}\u0000`;
    });
    out = out
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/^### (.+)$/gm, "<strong>$1</strong>")
      .replace(/\n{2,}/g, "</p><p>")
      .replace(/\n/g, "<br>");
    return `<p>${out}</p>`.replace(/\u0000(\d+)\u0000/g, (_, i) => fences[Number(i)]);
  }

  async function sendToClaude(panel) {
    const text = panel.input.value.trim();
    if (!text || panel.streaming) return;
    panel.input.value = "";
    panel.input.style.height = "auto";
    panel.turns.push({ role: "you", text });
    panel.streaming = { role: "claude", text: "" };
    panel.turns.push(panel.streaming);
    renderChat(panel);
    try {
      await invoke("claude_send", {
        window: label,
        prompt: text,
        cwd: projectPath,
        session: panel.session || null,
        resume: panel.started,
        // Edits land without a prompt; anything else Claude Code would have
        // asked about, it still asks about - and in this mode there is nobody
        // to ask, so it declines and says so in the conversation.
        permissionMode: "acceptEdits",
      });
      panel.started = true;
      say("Claude is working");
    } catch (err) {
      panel.streaming = null;
      panel.turns.push({ role: "error", text: String(err) });
      renderChat(panel);
      say(String(err));
    }
  }

  async function installClaude(panel) {
    const pre = panel.log.querySelector(".ws-chat-install");
    if (pre) { pre.hidden = false; pre.textContent = "Installing…\n"; }
    try {
      await busy("Installing Claude Code", () => invoke("claude_install", { window: label }));
    } catch (err) {
      if (pre) pre.textContent += `\n${err}`;
      say(String(err));
    }
  }

  /** Signing in needs a real terminal - it is an interactive prompt and a
   *  browser round trip - so it borrows the terminal panel rather than
   *  pretending this one can do it. */
  async function signInToClaude(panel) {
    const terminal = panels.get("terminal");
    const slot = slotOf("terminal");
    if (slot) layout.hidden[slot] = false;
    render();
    try {
      await invoke("term_write", { id: terminal?.info?.id, data: "claude\r" });
      say("Sign in to Claude in the terminal below");
    } catch {
      say("Run `claude` in the terminal below to sign in");
    }
  }

  await listen("claude:install", ({ payload }) => {
    if (payload.window !== label) return;
    const panel = panels.get("chat");
    const pre = panel?.log?.querySelector(".ws-chat-install");
    if (pre && payload.line) { pre.textContent += `${payload.line}\n`; pre.scrollTop = pre.scrollHeight; }
    if (!payload.done) return;
    say(payload.ok ? "Claude Code installed" : "The install did not finish");
    if (payload.ok) checkClaude(panel);
  }).catch(() => {});

  // One line of the CLI's stream. Matched on the few fields the panel needs;
  // anything else is ignored rather than treated as an error.
  await listen("claude:line", ({ payload }) => {
    if (payload.window !== label) return;
    const panel = panels.get("chat");
    if (!panel) return;
    let msg;
    try { msg = JSON.parse(payload.line); } catch { return; }

    if (msg.session_id) panel.session = msg.session_id;

    if (msg.type === "stream_event" && msg.event?.delta?.type === "text_delta") {
      if (!panel.streaming) { panel.streaming = { role: "claude", text: "" }; panel.turns.push(panel.streaming); }
      panel.streaming.text += msg.event.delta.text || "";
      return markChatDirty(panel);
    }
    if (msg.type === "assistant") {
      for (const block of msg.message?.content || []) {
        if (block.type !== "tool_use") continue;
        panel.turns.push({ role: "tool", icon: TOOL_ICONS[block.name] || "build", text: toolLine(block) });
      }
      return markChatDirty(panel);
    }
    if (msg.type === "result") {
      panel.streaming = null;
      // A run that could not authenticate reports it as the result rather than
      // as a failure, so the text is what says whether to offer signing in.
      const text = String(msg.result || "");
      if (msg.is_error || msg.subtype === "error_during_execution") {
        panel.turns.push({ role: "error", text: text || "That turn did not finish." });
      }
      if (/log ?in|sign ?in|not authenticated|invalid api key|credit balance/i.test(text)) {
        panel.needsSignIn = true;
      }
      renderChat(panel);
      say(msg.is_error ? "Claude reported a problem" : "Claude answered");
    }
  }).catch(() => {});

  await listen("claude:end", ({ payload }) => {
    if (payload.window !== label) return;
    const panel = panels.get("chat");
    if (!panel) return;
    panel.streaming = null;
    if (payload.code !== 0 && payload.error) {
      panel.turns.push({ role: "error", text: payload.error.trim() });
    }
    renderChat(panel);
  }).catch(() => {});

  /** Streaming text arrives a token at a time; the log is redrawn on a frame
   *  rather than per token, the way everything else in this window paints. */
  let chatDirty = false;
  function markChatDirty(panel) {
    if (chatDirty) return;
    chatDirty = true;
    requestAnimationFrame(() => { chatDirty = false; renderChat(panel); });
  }

  const TOOL_ICONS = {
    Read: "description", Edit: "edit", Write: "note_add", Bash: "terminal",
    Glob: "search", Grep: "search", WebFetch: "public", WebSearch: "travel_explore",
    Task: "account_tree", TodoWrite: "checklist",
  };

  const toolLine = (block) => {
    const input = block.input || {};
    const what = input.file_path || input.path || input.pattern || input.command || input.url || input.description || "";
    const short = String(what).replace(projectPath, "").replace(/^[\\/]/, "");
    return short ? `${block.name} · ${short.slice(0, 120)}` : block.name;
  };

  /* ----------------------------------------------------------------- go */

  // Drawn before anything is subscribed to or awaited. This window has no
  // native frame, so a page that dies on the way up is a window with no title
  // bar buttons and no way to close it - the layout goes up first, and
  // everything that can fail comes after it.
  render();

  // The one line of terminal output the rest of the window acts on. A
  // subscription that cannot be set up costs the browser panel its automatic
  // address and nothing else, so it is not allowed to take the window with it.
  listen("term:serving", ({ payload }) => {
    if (!sessions.has(payload.id)) return;
    goTo(payload.url, `${sessions.get(payload.id).label} is serving ${payload.url}`);
  }).catch((err) => say(`Cannot watch the terminals for a dev server: ${err}`));

  window.wintTrackPageView?.("/workspace");
})().catch((err) => {
  // Nothing below the title bar is trustworthy at this point, so the report
  // goes somewhere that needs no state: the status line, which is in the HTML.
  const status = document.getElementById("ws-status");
  if (status) status.textContent = `The workspace could not start: ${err}`;
});
