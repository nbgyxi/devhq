// The dev box: one window per project, holding the four things that project
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

  document.getElementById("db-project").textContent = projectName;
  document.getElementById("db-subtitle").textContent = projectPath;
  document.title = `${projectName} — dev box`;

  const esc = (v = "") => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (name) => `<span class="ms" aria-hidden="true">${name}</span>`;

  /* ------------------------------------------------------------ status bar */

  // Never empty, the way the main window's is never empty: with nothing in
  // flight it says what the dev box last did, because a line that comes and
  // goes cannot be glanced at.
  const statusEl = document.getElementById("db-status");
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
  say("Opening the dev box");

  /* --------------------------------------------------------------- layout */

  const SLOTS = ["left-top", "left-bottom", "center", "right", "bottom"];
  const KEY = `wint.devbox.v1:${projectPath.toLowerCase()}`;
  const DEFAULT_LAYOUT = {
    slots: { "left-top": "files", "left-bottom": "git", center: "browser", right: "chat", bottom: "terminal" },
    hidden: {},
    size: { left: 280, right: 420, bottom: 260, leftSplit: 0.5 },
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
    el.className = `db-panel db-panel-${panel.id}`;
    el.dataset.panel = panel.id;
    el.innerHTML = `<header class="db-head" draggable="true">
        <span class="db-head-grip">${icon("drag_indicator")}</span>
        ${icon(panel.icon)}<strong>${esc(panel.label)}</strong>
        <span class="db-head-tools"></span>
        <button class="db-head-hide" type="button" title="Hide this panel" aria-label="Hide this panel">${icon("close")}</button>
      </header>
      <div class="db-panel-body"></div>`;
    panel.el = el;
    panel.body = el.querySelector(".db-panel-body");
    panel.tools = el.querySelector(".db-head-tools");
    el.querySelector(".db-head-hide").addEventListener("click", () => {
      const slot = slotOf(panel.id);
      if (slot) { layout.hidden[slot] = true; render(); }
    });
    panel.mount?.(panel.body, panel);
    return el;
  };

  /* ------------------------------------------------------------- the grid */

  const grid = document.getElementById("db-grid");
  const slotEls = new Map(SLOTS.map((slot) => [slot, document.querySelector(`[data-slot="${slot}"]`)]));
  const gripEls = [...document.querySelectorAll("[data-grip]")];
  const togglesEl = document.getElementById("db-toggles");
  const centerColEl = document.getElementById("db-center-col");
  const bottomDock = document.getElementById("db-bottom-dock");

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
    const root = document.documentElement.style;
    const shown = (slot) => Boolean(layout.slots[slot]) && !layout.hidden[slot];
    const leftShown = shown("left-top") || shown("left-bottom");
    root.setProperty("--db-left", leftShown ? `${layout.size.left}px` : "0px");
    root.setProperty("--db-right", shown("right") ? `${layout.size.right}px` : "0px");
    root.setProperty("--db-bottom", shown("bottom") ? `${layout.size.bottom}px` : "0px");
    // With one of the two left panels hidden the other takes the whole column,
    // rather than the survivor keeping half and leaving a gap.
    const split = shown("left-top") && shown("left-bottom") ? layout.size.leftSplit : shown("left-top") ? 1 : 0;
    root.setProperty("--db-left-split", `${split * 100}%`);
    document.body.classList.toggle("db-no-left", !leftShown);
    for (const [slot, el] of slotEls) el.hidden = !shown(slot);
    bottomDock.hidden = !shown("bottom");
    dockBottom();
    for (const grip of gripEls) {
      grip.hidden =
        grip.dataset.grip === "left" ? !leftShown
        : grip.dataset.grip === "right" ? !shown("right")
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
      return `<button class="db-toggle${on ? " on" : ""}" data-toggle="${slot}" type="button" aria-pressed="${on}" title="${esc(panel.label)}">${icon(panel.icon)}</button>`;
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
  const dropEl = document.getElementById("db-drop");

  grid.addEventListener("dragstart", (e) => {
    const head = e.target.closest(".db-head");
    if (!head) return;
    dragging = head.closest(".db-panel").dataset.panel;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragging);
    document.body.classList.add("db-dragging");
    // The browser webview is drawn over the page, so during a drag it would
    // swallow every drop target underneath it.
    hideBrowser();
  }, true);

  const endDrag = () => {
    dragging = "";
    document.body.classList.remove("db-dragging");
    dropEl.hidden = true;
    for (const el of slotEls.values()) el.classList.remove("db-over");
    syncBrowser();
  };
  document.addEventListener("dragend", endDrag);

  for (const [slot, el] of slotEls) {
    el.addEventListener("dragover", (e) => {
      if (!dragging || layout.slots[slot] === dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("db-over");
    });
    el.addEventListener("dragleave", () => el.classList.remove("db-over"));
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
      document.body.classList.add("db-resizing");

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
        document.body.classList.remove("db-resizing");
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
      await invoke("devbox_browser_close", { window: label }).catch(() => {});
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
    invoke("devbox_browser_hide", { window: label }).catch(() => {});
  };

  /** Puts the webview exactly over the hole, creating it the first time. */
  const syncBrowser = () => {
    const rect = browserRect();
    if (!rect || !browserUrl || panels.get("browser")?.previewOpen) return hideBrowser();
    browserShown = true;
    invoke("devbox_browser_show", {
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
    if (!first && browserShown) invoke("devbox_browser_navigate", { window: label, url: target }).catch(() => {});
    else syncBrowser();
    say(reason || `Browsing ${target}`);
  };

  definePanel("browser", {
    label: "Browser",
    icon: "public",
    mount(body, panel) {
      panel.tools.innerHTML = `
        <button class="db-mini" data-browser="reload" type="button" title="Reload">${icon("refresh")}</button>
        <input class="db-address" data-browser="address" placeholder="localhost:3000" spellcheck="false" />
        <button class="db-mini" data-browser="external" type="button" title="Open in your real browser">${icon("open_in_new")}</button>`;
      panel.address = panel.tools.querySelector("[data-browser=address]");
      body.innerHTML = `<div class="db-browser-hole"></div>
        <div class="db-browser-empty">${icon("public")}<strong>Nothing to show yet</strong>
          <p>Start a dev server in the terminal below. The moment it prints a localhost address, this panel opens it.</p></div>
        <div class="db-preview" hidden><header><strong></strong><button type="button" class="db-mini">${icon("close")}</button></header><pre></pre></div>`;
      panel.hole = body.querySelector(".db-browser-hole");
      panel.empty = body.querySelector(".db-browser-empty");
      panel.preview = body.querySelector(".db-preview");
      panel.previewOpen = false;

      panel.tools.addEventListener("click", (e) => {
        const action = e.target.closest("[data-browser]")?.dataset.browser;
        if (action === "reload" && browserUrl) invoke("devbox_browser_reload", { window: label }).catch(() => {});
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
      const text = await busy(`Reading ${name}`, () => invoke("devbox_read_file", { path }));
      panel.preview.querySelector("pre").textContent = text;
      say(`Showing ${name}`);
    } catch (err) {
      panel.preview.querySelector("pre").textContent = String(err);
      say(String(err));
    }
  };

  /* --------------------------------------------------------- panel: files */

  definePanel("files", {
    label: "Files",
    icon: "folder_open",
    mount(body, panel) {
      panel.tools.innerHTML = `<button class="db-mini" data-files="refresh" type="button" title="Read the folder again">${icon("refresh")}</button>`;
      body.className += " db-files";
      body.innerHTML = `<div class="db-tree" data-depth="0"></div>`;
      panel.tree = body.querySelector(".db-tree");
      panel.open = new Set();
      panel.tools.addEventListener("click", () => loadDir(panel, panel.tree, projectPath, 0));
      body.addEventListener("click", async (e) => {
        const row = e.target.closest("[data-path]");
        if (!row) return;
        if (row.dataset.directory === "true") {
          const children = row.nextElementSibling;
          const open = row.classList.toggle("open");
          row.querySelector(".db-tree-caret").textContent = open ? "expand_more" : "chevron_right";
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

  async function loadDir(panel, host, path, depth) {
    host.dataset.loaded = "1";
    host.innerHTML = `<div class="db-tree-note">Reading…</div>`;
    try {
      const rows = await busy(depth ? `Reading ${path.split(/[\\/]/).pop()}` : "Reading the project folder", () => invoke("devbox_list_dir", { path }));
      host.innerHTML = rows.map((row) => `
        <button class="db-tree-row${row.directory ? " dir" : ""}" data-path="${esc(row.path)}" data-name="${esc(row.name)}"
                data-directory="${row.directory}" data-depth="${depth}" style="--db-depth:${depth}">
          <span class="ms db-tree-caret" aria-hidden="true">${row.directory ? "chevron_right" : "description"}</span>
          <span class="db-tree-name">${esc(row.name)}</span>
        </button>${row.directory ? `<div class="db-tree" hidden></div>` : ""}`).join("")
        || `<div class="db-tree-note">This folder is empty.</div>`;
      if (!depth) say(`${rows.length} item${rows.length === 1 ? "" : "s"} in ${projectName}`);
    } catch (err) {
      host.innerHTML = `<div class="db-tree-note">${esc(String(err))}</div>`;
      say(String(err));
    }
  }

  /* ----------------------------------------------------------- panel: git */

  definePanel("git", {
    label: "Save & upload",
    icon: "backup",
    mount(body, panel) {
      panel.tools.innerHTML = `<button class="db-mini" data-git="refresh" type="button" title="Check again">${icon("refresh")}</button>`;
      body.className += " db-git";
      body.innerHTML = `<div class="db-git-state"></div>
        <form class="db-git-form"><input name="message" placeholder="What did you change?" autocomplete="off" />
          <div class="db-git-buttons">
            <button type="submit" class="db-btn primary" data-git="save">${icon("bookmark_add")}Save</button>
            <button type="button" class="db-btn" data-git="push">${icon("cloud_upload")}Upload</button>
            <button type="button" class="db-btn" data-git="pull">${icon("cloud_download")}Get</button>
          </div></form>
        <div class="db-git-files"></div>`;
      panel.state = body.querySelector(".db-git-state");
      panel.files = body.querySelector(".db-git-files");
      panel.form = body.querySelector(".db-git-form");
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
        <p class="db-git-branch">${icon("fork_right")}<strong>${esc(g.branch || "detached")}</strong>
          ${g.ahead ? `<b title="Recorded here, not uploaded">${g.ahead} to upload</b>` : ""}
          ${g.behind ? `<b title="Waiting from your team">${g.behind} to get</b>` : ""}</p>
        <p class="db-git-line">${changed.length
          ? `${changed.length} changed file${changed.length === 1 ? "" : "s"} not saved yet.`
          : g.ahead ? "Everything is saved here, but not uploaded yet." : "Nothing to save. You are up to date."}</p>`;
      panel.files.innerHTML = changed.slice(0, 200).map((file) => `
        <div class="db-git-file"><span class="ms">${file.status === "untracked" ? "note_add" : file.status === "conflict" ? "error" : "edit"}</span>
          <span title="${esc(file.path)}">${esc(file.path)}</span></div>`).join("");
      say(changed.length ? `${changed.length} file${changed.length === 1 ? "" : "s"} changed` : "Nothing to save");
    } catch (err) {
      panel.state.innerHTML = `<p class="db-git-line">${esc(String(err))}</p>`;
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
      body.className += " db-term";
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
        host.innerHTML = `<div class="db-term-error">${esc(String(err))}</div>`;
        say(String(err));
      }
    },
    resized() { this.view?.fit(); },
  });

  defineTerminal("terminal", { label: "Terminal", icon: "terminal", shell: "", hint: "Terminal ready" });
  defineTerminal("chat", { label: "Claude", icon: "forum", shell: "claude", hint: "Claude is starting" });

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

  window.wintTrackPageView?.("/devbox");
})().catch((err) => {
  // Nothing below the title bar is trustworthy at this point, so the report
  // goes somewhere that needs no state: the status line, which is in the HTML.
  const status = document.getElementById("db-status");
  if (status) status.textContent = `The dev box could not start: ${err}`;
});
