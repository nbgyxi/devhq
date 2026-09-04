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

  // The title bar is drawn by the page, not Windows, so it needs its own copy
  // of the icon the taskbar already shows — the generic app mark left over in
  // the markup otherwise reads as a different window.
  const brandImg = document.querySelector(".titlebar .brand img");
  if (brandImg) {
    const themeKey = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    brandImg.src = `tool-icons/${themeKey}/workspace.png`;
    brandImg.onerror = () => {
      brandImg.onerror = null;
      brandImg.src = `tool-icons/${themeKey}/_default.png`;
    };
  }

  // The same badge every tool header carries, and for the same reason: the
  // workspace has been built and not put through its paces, and that is
  // something to be told rather than to discover. `maturity.js` wires the
  // explanation popover itself, so this is the whole of it.
  const maturityEl = document.getElementById("ws-maturity");
  if (maturityEl) maturityEl.innerHTML = window.wintMaturity?.badge("workspace") ?? "";

  const esc = (v = "") => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (name) => `<span class="ms" aria-hidden="true">${name}</span>`;

  /* The status bar was removed to free vertical space. say() and busy() are
     kept as no-ops so the rest of the code does not break. */
  const say = () => {};
  const busy = async (text, work) => work();

  /* --------------------------------------------------------------- layout */

  const SLOTS = ["left-top", "left-bottom", "center", "right-top", "right-bottom", "bottom"];
  // v3: the right column can split when two panels live there. v2 had a
  // single `right` slot; that assignment is kept as the top panel. Claude and
  // Cursor share one Agent panel, so the bottom right starts empty.
  const KEY = `wint.workspace.v3:${projectPath.toLowerCase()}`;
  const KEY_V2 = `wint.workspace.v2:${projectPath.toLowerCase()}`;
  const DEFAULT_LAYOUT = {
    slots: { "left-top": "files", "left-bottom": "git", center: "browser", "right-top": "agent", "right-bottom": null, bottom: "terminal" },
    hidden: {},
    // The save-and-upload panel is a message box and three buttons, so it gets
    // what that needs and the file list gets the rest of the column.
    size: { left: 280, right: 420, bottom: 260, leftSplit: 0.78, rightSplit: 0.5 },
    centerHidden: 0, // Width given up when center panel was hidden, so it can be restored.
  };

  const migrateLayout = (saved) => {
    if (!saved?.slots) return structuredClone(DEFAULT_LAYOUT);
    const slots = { ...saved.slots };
    const hidden = { ...saved.hidden };
    if (slots.right && !slots["right-top"]) {
      slots["right-top"] = slots.right;
      if (hidden.right) hidden["right-top"] = hidden.right;
    }
    // Older builds used the single Claude panel here.
    if (slots["right-top"] === "chat") slots["right-top"] = "agent";
    delete slots.right;
    delete hidden.right;
    // An earlier build reserved right-bottom for a separate Cursor panel.
    // Cursor lives in the Agent panel now, so that placeholder goes away.
    if (slots["right-bottom"] === "cursor") {
      slots["right-bottom"] = null;
      delete hidden["right-bottom"];
    }
    return {
      slots: { ...DEFAULT_LAYOUT.slots, ...slots },
      hidden: { ...DEFAULT_LAYOUT.hidden, ...hidden },
      size: { ...DEFAULT_LAYOUT.size, ...saved.size },
    };
  };

  const layout = (() => {
    try {
      const raw = localStorage.getItem(KEY) || localStorage.getItem(KEY_V2);
      const saved = JSON.parse(raw || "null");
      return migrateLayout(saved);
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
    // A panel that already draws a bar of its own - the terminal, whose tab
    // strip says what every tab is - gets no header: two rows saying the same
    // thing read as a headline printed twice, and the second one costs a row
    // of the panel.
    el.innerHTML = (panel.bare ? "" : `<header class="ws-head">
        ${icon(panel.icon)}<strong>${esc(panel.label)}</strong>
        <span class="ws-head-tools"></span>
      </header>`)
      + `<div class="ws-panel-body"></div>`;
    panel.el = el;
    panel.body = el.querySelector(".ws-panel-body");
    panel.tools = el.querySelector(".ws-head-tools");
    panel.mount?.(panel.body, panel);
    return el;
  };

  /* ------------------------------------------------------------- the grid */

  const grid = document.getElementById("ws-grid");
  const slotEls = new Map(SLOTS.map((slot) => [slot, document.querySelector(`[data-slot="${slot}"]`)]));
  const gripEls = [...document.querySelectorAll("[data-grip]")];
  const togglesEl = document.getElementById("ws-toggles");
  const leftColEl = document.querySelector(".ws-col.ws-left");
  const rightColEl = document.querySelector(".ws-col.ws-right-col");
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
    host.appendChild(bottomDock);
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
    root.setProperty("--ws-right", (shown("right-top") || shown("right-bottom")) ? `${layout.size.right}px` : "0px");
    root.setProperty("--ws-bottom", shown("bottom") ? `${layout.size.bottom}px` : "0px");
    // Save & upload is sized to its own content, not a draggable fraction of
    // the column - wherever it sits, the other panel in that column gets what
    // is left over and the divider between them cannot be dragged. Only while
    // it is actually showing, though: a row held open at its height with the
    // panel hidden is a gap the other panel cannot have.
    const gitAt = (slot) => layout.slots[slot] === "git" && shown(slot);
    const gitLeftBottom = gitAt("left-bottom");
    const gitLeftTop = gitAt("left-top");
    const gitRightBottom = gitAt("right-bottom");
    const gitRightTop = gitAt("right-top");
    leftColEl.classList.toggle("ws-git-fixed", gitLeftBottom);
    leftColEl.classList.toggle("ws-git-fixed-top", gitLeftTop);
    rightColEl.classList.toggle("ws-git-fixed", gitRightBottom);
    rightColEl.classList.toggle("ws-git-fixed-top", gitRightTop);
    // With one of the two left panels hidden the other takes the whole column,
    // rather than the survivor keeping half and leaving a gap.
    const split = shown("left-top") && shown("left-bottom") ? layout.size.leftSplit : shown("left-top") ? 1 : 0;
    root.setProperty("--ws-left-split", `${split * 100}%`);
    // Same deal on the right: with only the top slot in use (the common case -
    // the Agent panel with nothing docked below it) it takes the whole column
    // rather than being capped at the split fraction with a blank row below.
    const rightSplit = shown("right-top") && shown("right-bottom") ? layout.size.rightSplit : shown("right-top") ? 1 : 0;
    root.setProperty("--ws-right-split", `${rightSplit * 100}%`);
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
        : grip.dataset.grip === "right" ? !(shown("right-top") || shown("right-bottom")) || !shown("center")
        : grip.dataset.grip === "bottom" ? !shown("bottom")
        // Save & upload's own row is fixed to its content, so there is
        // nothing left for this divider to decide.
        : grip.dataset.grip === "leftSplit" ? !(shown("left-top") && shown("left-bottom")) || gitLeftBottom || gitLeftTop
        : grip.dataset.grip === "rightSplit" ? !(shown("right-top") && shown("right-bottom")) || gitRightBottom || gitRightTop
        : false;
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

  togglesEl.addEventListener("click", async (e) => {
    const button = e.target.closest("[data-toggle]");
    if (!button) return;
    const slot = button.dataset.toggle;
    const wasHidden = layout.hidden[slot];
    const isCenterToggle = slot === "center" && layout.slots.center;

    // Measure center width before hiding it, so we know how much to shrink/grow.
    let centerW = 0;
    if (isCenterToggle && !wasHidden) {
      const grip = gripEls.find((g) => g.dataset.grip === "right");
      const gripW = grip && !grip.hidden ? grip.getBoundingClientRect().width : 0;
      centerW = centerColEl.getBoundingClientRect().width + gripW;
    }

    layout.hidden[slot] = !layout.hidden[slot];
    say(`${layout.hidden[slot] ? "Hid" : "Showed"} ${panels.get(layout.slots[slot])?.label || slot}`);

    // Hide browser before resizing so it doesn't interfere or stay visible.
    if (isCenterToggle && browserShown) hideBrowser();

    // Resize window around the center panel hide/show.
    if (isCenterToggle) {
      try {
        const Size = window.__TAURI__.dpi?.LogicalSize;
        if (Size && !await win.isMaximized()) {
          const inner = await win.innerSize();
          const willResize = layout.hidden[slot]
            ? centerW > 0 // Hiding: shrink by center width
            : layout.centerHidden > 0; // Showing: grow back by what was saved
          if (willResize) {
            const delta = layout.hidden[slot] ? -centerW : layout.centerHidden;
            const newWidth = Math.max(760, inner.width + delta);
            if (layout.hidden[slot]) {
              layout.centerHidden = centerW; // Remember how much we shrunk
            } else {
              layout.centerHidden = 0; // Clear since we restored it
            }
            saveLayout();
            await win.setSize(new Size(newWidth, inner.height));
          }
        }
      } catch (err) {
        // Silently fail; layout still updates visually even if window doesn't resize.
      }
    }

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
      await panels.get("browser")?.settlePreviewEdit?.();
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
        <div class="ws-preview" hidden>
          <header>
            <strong></strong><span class="ws-preview-dot" hidden title="Unsaved changes"></span><small></small>
            <button type="button" class="ws-mini" data-preview="save" title="Save" hidden>${icon("save")}</button>
            <button type="button" class="ws-mini" data-preview="reveal" title="Reveal in Explorer">${icon("folder_open")}</button>
            <button type="button" class="ws-mini" data-preview="vscode" title="Open in VS Code">${icon("code")}</button>
            <button type="button" class="ws-mini" data-preview="close" title="Close">${icon("close")}</button>
          </header>
          <div class="ws-preview-code"><div class="ws-preview-gutter"></div><pre spellcheck="false"></pre></div>
          <div class="ws-preview-image" hidden><img alt="" /></div>
        </div>`;
      panel.hole = body.querySelector(".ws-browser-hole");
      panel.empty = body.querySelector(".ws-browser-empty");
      panel.preview = body.querySelector(".ws-preview");
      panel.previewOpen = false;
      panel.previewPath = "";
      panel.previewName = "";
      panel.previewOriginal = "";
      panel.previewDirty = false;

      const setPreviewDirty = (dirty) => {
        panel.previewDirty = dirty;
        panel.preview.querySelector(".ws-preview-dot").hidden = !dirty;
        panel.preview.querySelector('[data-preview="save"]').hidden = !dirty;
      };

      const savePreview = async () => {
        if (!panel.previewDirty || !panel.previewPath) return;
        const pre = panel.preview.querySelector(".ws-preview-code pre");
        const text = pre.textContent;
        try {
          await busy(`Saving ${panel.previewName}`, () => invoke("workspace_write_file", { path: panel.previewPath, contents: text }));
          panel.previewOriginal = text;
          setPreviewDirty(false);
          say(`Saved ${panel.previewName}`);
        } catch (err) {
          say(String(err));
        }
      };

      // Asks before whatever is about to happen throws away an edit: closing
      // the preview, opening a different file, navigating the browser, or
      // closing the window. Resolves once it is safe to proceed - saved,
      // discarded, or there was nothing to lose.
      const settlePreviewEdit = async () => {
        if (!panel.previewDirty) return;
        const pre = panel.preview.querySelector(".ws-preview-code pre");
        const wantsSave = window.confirm(
          `"${panel.previewName}" has unsaved changes.\n\nOK to save them, Cancel to discard.`,
        );
        if (wantsSave) {
          await savePreview();
        } else {
          pre.textContent = panel.previewOriginal;
          setPreviewDirty(false);
        }
      };
      panel.settlePreviewEdit = settlePreviewEdit;

      const pre = panel.preview.querySelector(".ws-preview-code pre");

      // Where the caret sits, as a plain character count into the element's
      // text - stable across an innerHTML rebuild, unlike a node+offset pair.
      const caretOffset = () => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || !pre.contains(sel.focusNode)) return null;
        const range = sel.getRangeAt(0).cloneRange();
        range.selectNodeContents(pre);
        range.setEnd(sel.focusNode, sel.focusOffset);
        return range.toString().length;
      };
      const setCaretOffset = (offset) => {
        const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        let remaining = offset;
        let last = null;
        while (node) {
          if (remaining <= node.textContent.length) {
            const range = document.createRange();
            range.setStart(node, remaining);
            range.collapse(true);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            return;
          }
          remaining -= node.textContent.length;
          last = node;
          node = walker.nextNode();
        }
        if (last) {
          const range = document.createRange();
          range.setStart(last, last.textContent.length);
          range.collapse(true);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      };

      // Recolours on every keystroke, restoring the caret afterwards: an
      // innerHTML rebuild is the only way to keep the token spans in step
      // with edited text, and it throws the caret to the start of the
      // element unless something puts it back.
      pre.addEventListener("input", () => {
        const text = pre.textContent;
        setPreviewDirty(text !== panel.previewOriginal);
        const offset = caretOffset();
        pre.innerHTML = window.wintHighlight ? window.wintHighlight.html(text, panel.previewName) : esc(text);
        if (offset !== null) setCaretOffset(offset);
        panel.preview.querySelector(".ws-preview-gutter").textContent =
          text.split("\n").map((_, i) => i + 1).join("\n");
      });
      pre.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
          e.preventDefault();
          savePreview();
          return;
        }
        // A `<pre>` needs its line breaks to stay literal `\n` characters, not
        // the `<div>` the browser inserts by default - and Tab typing a
        // character beats it jumping focus to the next button.
        if (e.key === "Enter") {
          e.preventDefault();
          document.execCommand("insertText", false, "\n");
        } else if (e.key === "Tab") {
          e.preventDefault();
          document.execCommand("insertText", false, "  ");
        }
      });

      panel.tools.addEventListener("click", (e) => {
        const action = e.target.closest("[data-browser]")?.dataset.browser;
        if (action === "reload" && browserUrl) invoke("workspace_browser_reload", { window: label }).catch(() => {});
        if (action === "external" && browserUrl) invoke("plugin:opener|open_url", { url: browserUrl }).catch(() => {});
      });
      panel.address.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && panel.address.value.trim()) goTo(panel.address.value.trim());
      });
      panel.preview.querySelector("header").addEventListener("click", async (e) => {
        const action = e.target.closest("[data-preview]")?.dataset.preview;
        if (!action) return;
        if (action === "save") return savePreview();
        if (action === "close") {
          await settlePreviewEdit();
          panel.previewOpen = false;
          panel.preview.hidden = true;
          syncBrowser();
          say("Closed the preview");
          return;
        }
        if (!panel.previewPath) return;
        if (action === "reveal") invoke("open_in", { path: panel.previewPath, target: "reveal" }).catch(() => {});
        if (action === "vscode") invoke("open_in", { path: panel.previewPath, target: "vscode", context: projectPath }).catch(() => {});
      });
    },
    resized: () => syncBrowser(),
  });

  /** Shows a file over the browser hole — syntax-highlighted text, or an image
   *  drawn full size. The webview has to go away while this is up: it is drawn
   *  above the page and would sit on top of it. */
  const showPreview = async (path, name) => {
    const panel = panels.get("browser");
    if (!panel?.preview) return;
    await panel.settlePreviewEdit?.();
    if (!visible("browser")) {
      const slot = slotOf("browser");
      if (slot) layout.hidden[slot] = false;
      render();
    }
    panel.previewOpen = true;
    panel.previewPath = path;
    panel.previewName = name;
    panel.empty.hidden = true;
    panel.preview.hidden = false;
    panel.preview.querySelector("header strong").textContent = name;
    panel.preview.querySelector("header small").textContent = window.wintHighlight?.languageOf(name) ?? "";
    hideBrowser();

    const codeEl = panel.preview.querySelector(".ws-preview-code");
    const imageEl = panel.preview.querySelector(".ws-preview-image");
    const gutter = codeEl.querySelector(".ws-preview-gutter");
    const pre = codeEl.querySelector("pre");
    const img = imageEl.querySelector("img");
    pre.contentEditable = "false";

    if (window.wintHighlight?.isImage(name)) {
      codeEl.hidden = true;
      imageEl.hidden = false;
      img.removeAttribute("src");
      try {
        img.src = await busy(`Reading ${name}`, () => invoke("workspace_read_image", { path }));
        say(`Showing ${name}`);
      } catch (err) {
        imageEl.hidden = true;
        codeEl.hidden = false;
        gutter.textContent = "";
        pre.textContent = String(err);
        say(String(err));
      }
      return;
    }

    imageEl.hidden = true;
    codeEl.hidden = false;
    gutter.textContent = "";
    pre.textContent = "Reading…";
    try {
      const text = await busy(`Reading ${name}`, () => invoke("workspace_read_file", { path }));
      const lines = text.split("\n");
      gutter.textContent = lines.map((_, i) => i + 1).join("\n");
      pre.innerHTML = window.wintHighlight ? window.wintHighlight.html(text, name) : esc(text);
      panel.previewOriginal = text;
      pre.contentEditable = "true";
      say(`Showing ${name}`);
    } catch (err) {
      gutter.textContent = "";
      pre.textContent = String(err);
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

  // The row Save & upload sits in is sized in pixels (`--ws-git-h`), not a
  // draggable fraction, so it can be measured from the panel's own content
  // and never shows blank space or clips its buttons. `panel.body` is a flex
  // child stretched to fill whatever the column gives it, so its own box
  // can't be measured for this - state and form are natural-height children
  // of that box, so they are what gets measured instead.
  /** Keeps the row Save & upload lives in exactly as tall as what it is
   *  showing, so the panel never has to scroll.
   *
   *  Everything is measured rather than added up from constants. Narrowing the
   *  column is what makes this panel taller - the header wraps its buttons
   *  onto a second line, the branch line wraps, the three buttons stack - and
   *  a hardcoded header height is wrong by a whole row exactly when it matters.
   *  The content is measured child by child rather than from `scrollHeight`,
   *  because `scrollHeight` can never report less than the box it is in and
   *  the row would then only ever grow. */
  const syncGitHeight = (panel) => {
    const body = panel.body;
    const slot = panel.el?.parentElement;
    if (!body || !slot || slot.hidden) return;
    const box = getComputedStyle(body);
    const gap = parseFloat(box.rowGap) || 0;
    const kids = [...body.children];
    const content = kids.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0)
      + gap * Math.max(0, kids.length - 1)
      + parseFloat(box.paddingTop) + parseFloat(box.paddingBottom);
    const head = panel.el.querySelector(".ws-head");
    const slotBox = getComputedStyle(slot);
    // The slot border (and a scrollbar, if one is somehow still there) plus
    // the gap the slot keeps from its neighbours.
    const chrome = slot.offsetHeight - slot.clientHeight
      + parseFloat(slotBox.marginTop) + parseFloat(slotBox.marginBottom);
    const want = content + (head?.getBoundingClientRect().height || 0) + chrome;
    // The panel above it still has to exist: past this the row stops growing
    // and this panel scrolls after all, rather than squeezing its neighbour
    // out of the column.
    const column = slot.parentElement;
    const ceiling = Math.max(90, (column?.clientHeight || 0) - 120);
    const px = `${Math.min(ceiling, Math.max(90, Math.ceil(want)))}px`;
    if (document.body.style.getPropertyValue("--ws-git-h") !== px) {
      document.body.style.setProperty("--ws-git-h", px);
    }
  };

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
      // Catches everything that can change the content's height - the state
      // line wrapping to two lines, a longer branch name, an error message -
      // without having to call this from every place that updates them.
      // Observing the body catches both kinds of change: the content growing
      // (a longer branch name, an error line) and the column being narrowed,
      // which is what makes the content wrap in the first place. The header is
      // watched too - it wraps its own buttons and is part of the height.
      const heightObserver = new ResizeObserver(() => syncGitHeight(panel));
      heightObserver.observe(body);
      heightObserver.observe(panel.el.querySelector(".ws-head"));
      heightObserver.observe(panel.state);
      heightObserver.observe(panel.form);
      panel.resized = () => syncGitHeight(panel);
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

  /** Load a script file and wait for it to load. */
  const loadScript = (src) => new Promise((ok, fail) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = ok;
    script.onerror = fail;
    document.body.appendChild(script);
  });

  /* --------------------------------------------------- panel: terminal */

  definePanel("terminal", {
    label: "Terminal",
    icon: "terminal",
    // The dock's tab strip is this panel's header: it says which terminal each
    // tab is and carries the buttons a header would have. A second bar above
    // it saying "Terminal" is the same headline twice, and a row of the panel
    // spent on it.
    bare: true,
    async mount(body) {
      body.className += " ws-term";
      window.wintDockHost = {
        id: projectPath.toLowerCase(),
        container: body,
        projectPath,
        projectName,
        autoOpen: true,
        // A terminal popped out of this workspace comes back to this
        // workspace, and the panel opens for it if it had been put away.
        // A terminal that printed its address before this panel existed - a
        // restored one, or one whose server was already up - never fires the
        // event, so each terminal is asked what it serves as it is mounted.
        onSession: (id) => {
          invoke("term_serving", { id }).then((url) => {
            if (url && !browserUrl) goTo(url, `${window.wintTermDock?.label(id) || "The terminal"} is serving ${url}`);
          }).catch(() => {});
        },
        onDock: () => {
          const slot = slotOf("terminal");
          if (slot && layout.hidden[slot]) {
            layout.hidden[slot] = false;
            render();
          }
          say("Took the terminal back into the workspace");
        },
      };
      try {
        await busy("Starting the terminal", () => loadScript("terminals.js"));
      } catch (err) {
        body.innerHTML = `<div class="ws-term-error">${esc(String(err))}</div>`;
        say(String(err));
      }
    },
    resized() { window.wintTermDock?.fit(); },
  });
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
          <div class="ws-chat-row">
            <textarea rows="1" placeholder="Ask Claude about this project…" spellcheck="false"></textarea>
            <button type="submit" class="ws-chat-send" title="Send (Enter)">${icon("send")}</button>
            <button type="button" class="ws-chat-stop" title="Stop" hidden>${icon("stop_circle")}</button>
          </div>
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
    if (payload.ok && panel) checkClaude(panel);
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

  // Codex names what it did as items on its thread rather than as tool calls,
  // so the same line is built from whichever field the item happens to carry.
  const CODEX_ITEM_ICONS = {
    command_execution: "terminal", file_change: "edit", mcp_tool_call: "build",
    web_search: "travel_explore", todo_list: "checklist",
  };

  const CODEX_ITEM_NAMES = {
    command_execution: "Bash", file_change: "Edit", mcp_tool_call: "Tool",
    web_search: "Search", todo_list: "Todos",
  };

  const codexToolLine = (item) => {
    const changed = Array.isArray(item.changes) ? item.changes.map((c) => c.path || c).join(", ") : "";
    const what = item.command || item.path || changed || item.query || item.title || item.name || "";
    const short = String(what).replace(projectPath, "").replace(/^[\\/]/, "").replace(/\s+/g, " ");
    const name = CODEX_ITEM_NAMES[item.type] || String(item.type || "").replace(/_/g, " ");
    if (!name && !short) return "";
    return short ? `${name} · ${short.slice(0, 120)}` : name;
  };

  /* ------------------------------------------------------- panel: Agent */

  const AGENT_STATUS_KEY = (kind) => `wint.workspace.agent.status.v1:${kind}`;

  const readStatusCache = (kind) => {
    try {
      const raw = localStorage.getItem(AGENT_STATUS_KEY(kind));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  const rememberStatus = (kind, status) => {
    try {
      localStorage.setItem(AGENT_STATUS_KEY(kind), JSON.stringify(status));
    } catch {}
  };

  // CLI-driven agents in the workspace Agent panel.
  const AGENTS = {
    claude: {
      id: "claude",
      label: "Claude",
      product: "Claude Code",
      icon: "forum",
      placeholder: "Ask Claude about this project…",
      statusCmd: "claude_status",
      sendCmd: "claude_send",
      cancelCmd: "claude_cancel",
      installCmd: "claude_install",
      terminalCmd: "claude_terminal_command",
      // Only Claude Code keeps its conversations somewhere WinT can read them
      // back, so it is the only kind whose history button has anything to
      // open. The others get the button disabled rather than hidden, so the
      // title line does not change shape from one tab to the next.
      sessionsCmd: "claude_sessions",
      transcriptCmd: "claude_transcript",
      mintSession: true,
      installHint: `WinT doesn't ship it and holds no key for it. You install Anthropic's CLI and sign in as
           yourself; this panel gives it somewhere to talk.`,
    },
    cursor: {
      id: "cursor",
      label: "Cursor",
      product: "Cursor Agent",
      icon: "code",
      placeholder: "Ask Cursor Agent about this project…",
      statusCmd: "cursor_status",
      sendCmd: "cursor_send",
      cancelCmd: "cursor_cancel",
      installCmd: "cursor_install",
      terminalCmd: "cursor_terminal_command",
      mintSession: false,
      installHint: `WinT doesn't ship it and holds no key for it. You install Cursor Agent and sign in as
           yourself; this panel gives it somewhere to talk.`,
    },
    copilot: {
      id: "copilot",
      label: "Copilot",
      product: "GitHub Copilot",
      icon: "robot",
      placeholder: "Ask Copilot about this project…",
      statusCmd: "copilot_status",
      sendCmd: "copilot_send",
      cancelCmd: "copilot_cancel",
      installCmd: "copilot_install",
      terminalCmd: "copilot_terminal_command",
      mintSession: false,
      installHint: `WinT doesn't ship it and holds no key for it. You install GitHub Copilot CLI and sign in as
           yourself; this panel gives it somewhere to talk.`,
    },
    codex: {
      id: "codex",
      label: "Codex",
      product: "Codex",
      icon: "token",
      placeholder: "Ask Codex about this project…",
      statusCmd: "codex_status",
      sendCmd: "codex_send",
      cancelCmd: "codex_cancel",
      installCmd: "codex_install",
      terminalCmd: "codex_terminal_command",
      mintSession: false,
      installHint: `WinT doesn't ship it and holds no key for it. You install OpenAI Codex CLI and sign in as
           yourself; this panel gives it somewhere to talk.`,
    },
    gemini: {
      id: "gemini",
      label: "Gemini",
      product: "Gemini",
      icon: "auto_awesome",
      placeholder: "Ask Gemini about this project…",
      statusCmd: "gemini_status",
      sendCmd: "gemini_send",
      cancelCmd: "gemini_cancel",
      installCmd: "gemini_install",
      terminalCmd: "gemini_terminal_command",
      mintSession: false,
      installHint: `WinT doesn't ship it and holds no key for it. You install Gemini CLI and sign in as
           yourself; this panel gives it somewhere to talk.`,
    },
  };

  const freshAgentState = (kind) => {
    const cached = readStatusCache(kind);
    const status = cached === null ? null : cached;
    return {
      session: AGENTS[kind].mintSession ? newSessionId() : null,
      started: false,
      turns: [],
      streaming: null,
      status,
      needsSignIn: kind === "cursor" && Boolean(status?.installed && !status?.signedIn),
    };
  };

  // Several tabs can be streaming at once now, so the dirty set is per tab
  // rather than a single flag for the whole panel.
  const dirtyAgentTabs = new Set();
  let agentDirtyQueued = false;
  function markAgentTabDirty(panel, tab) {
    dirtyAgentTabs.add(tab.id);
    if (agentDirtyQueued) return;
    agentDirtyQueued = true;
    requestAnimationFrame(() => {
      agentDirtyQueued = false;
      const ids = [...dirtyAgentTabs];
      dirtyAgentTabs.clear();
      for (const id of ids) {
        const t = panel.tabs.get(id);
        if (t) renderAgentTab(panel, t);
      }
    });
  }

  const isSaid = (turn) => turn.role !== "you" && turn.role !== "tool" && turn.role !== "error";

  /** How much of an answer has been written out so far. Every answer starts at
   *  nothing and is revealed towards its full text, so a reply that arrives in
   *  one piece reads the same way as one that arrives token by token. */
  const revealed = (turn) => turn.text.slice(0, turn.shown === undefined ? 0 : turn.shown);

  function agentTurnHtml(turn) {
    if (turn.role === "you") {
      return `<div class="ws-turn you"><div class="ws-turn-body">${esc(turn.text)}</div></div>`;
    }
    if (turn.role === "error") {
      return `<div class="ws-turn error">${icon("error")}<span>${esc(turn.text)}</span></div>`;
    }
    const text = revealed(turn);
    if (!text) return "";
    const live = text.length < turn.text.length ? " data-live" : "";
    return `<div class="ws-turn claude ${esc(turn.role)}"${live}><div class="ws-turn-body">${markdown(text)}</div></div>`;
  }

  const toolHtml = (turn) =>
    `<div class="ws-turn tool">${icon(turn.icon || "build")}<span>${esc(turn.text)}</span></div>`;

  /** A run of tool lines between two answers. Only the three most recent are
   *  worth reading - they are what the agent is doing now - so the rest fold
   *  behind a line that opens them in place. */
  function agentStepsHtml(steps, key, tab) {
    const open = tab.openSteps?.has(key);
    const folded = steps.length - 3;
    const shown = open || folded <= 0 ? steps : steps.slice(-3);
    const more = folded > 0
      ? `<button type="button" class="ws-steps-more" data-steps="${key}">${icon("expand_more")}${
          open ? "Show fewer steps" : `Show ${folded} earlier step${folded === 1 ? "" : "s"}`}</button>`
      : "";
    return `<div class="ws-steps${open ? " open" : ""}">${more}${shown.map(toolHtml).join("")}</div>`;
  }

  /** The line that says the turn is still running. It is drawn from the turn
   *  being in flight rather than from text arriving, so it is there in the
   *  moment it matters most: right after the question was sent. */
  function agentThinkingHtml(tab) {
    const last = tab.turns[tab.turns.length - 1];
    // Hidden only while an answer is actually being written out - the caret on
    // the bubble says that. Every other moment of a running turn gets the line.
    const writing = last && isSaid(last) && revealed(last).length < last.text.length;
    if (writing) return "";
    const label = last?.role === "tool" ? "Working" : "Thinking";
    const secs = Math.round((Date.now() - (tab.startedAt || Date.now())) / 1000);
    return `<div class="ws-turn thinking"><span class="ws-dots"><i></i><i></i><i></i></span>
      <span>${label}…</span><span class="ws-thinking-for">${secs}s</span></div>`;
  }

  function agentLogHtml(tab) {
    const parts = [];
    for (let i = 0; i < tab.turns.length; i++) {
      if (tab.turns[i].role !== "tool") { parts.push(agentTurnHtml(tab.turns[i])); continue; }
      let end = i;
      while (end + 1 < tab.turns.length && tab.turns[end + 1].role === "tool") end += 1;
      parts.push(agentStepsHtml(tab.turns.slice(i, end + 1), i, tab));
      i = end;
    }
    if (tab.streaming) parts.push(agentThinkingHtml(tab));
    return parts.join("");
  }

  /** The elapsed second on the thinking line, without redrawing the log for
   *  it - a turn that is only waiting produces no events of its own. */
  function syncThinkingClock(panel, tab) {
    if (tab.streaming && !tab.clock) {
      tab.clock = setInterval(() => {
        const el = tab.log?.querySelector(".ws-thinking-for");
        if (el) el.textContent = `${Math.round((Date.now() - (tab.startedAt || Date.now())) / 1000)}s`;
      }, 1000);
    } else if (!tab.streaming && tab.clock) {
      clearInterval(tab.clock);
      tab.clock = null;
    }
  }

  /** Writes out whatever text has arrived but not yet been shown, a frame at a
   *  time, catching up faster the further behind it is. */
  function revealAgentText(panel, tab) {
    if (tab.revealing) return;
    const behind = () => tab.turns.some((t) => isSaid(t) && (t.shown === undefined ? 0 : t.shown) < t.text.length);
    if (!behind()) return;
    tab.revealing = true;
    requestAnimationFrame(function step() {
      for (const turn of tab.turns) {
        if (!isSaid(turn)) continue;
        if (turn.shown === undefined) turn.shown = 0;
        if (turn.shown >= turn.text.length) continue;
        turn.shown = Math.min(turn.text.length, turn.shown + Math.max(3, Math.ceil((turn.text.length - turn.shown) / 10)));
      }
      const more = behind();
      tab.revealing = more;
      renderAgentTab(panel, tab);
      if (more) requestAnimationFrame(step);
    });
  }

  // Every tab keeps its own log/ask/input, mounted once when the tab was
  // created and never rebuilt - only this tab's own innerHTML changes here,
  // so a conversation streaming in a background tab does not touch the one
  // on screen, and switching tabs does not lose scroll position or a draft.
  function renderAgentTab(panel, tab) {
    const spec = AGENTS[tab.kind];
    if (!spec || !tab.log) return;

    const busy = Boolean(tab.streaming);
    syncThinkingClock(panel, tab);
    tab.input.placeholder = spec.placeholder;
    tab.ask.hidden = !tab.status?.installed;
    tab.ask.querySelector(".ws-chat-send").hidden = busy;
    tab.ask.querySelector(".ws-chat-stop").hidden = !busy;

    if (tab.status === null) {
      tab.log.innerHTML = `<div class="ws-chat-card checking">${icon("progress_activity")}Checking if ${esc(spec.label)} is installed...</div>`;
      return;
    }

    if (!tab.status?.installed) {
      tab.log.innerHTML = `<div class="ws-chat-card">${icon("download")}
        <strong>${esc(spec.product)} isn't installed</strong>
        <p>${spec.installHint.replace(/\n/g, "<br>")}</p>
        <div class="ws-chat-card-actions">
          <button class="ws-btn primary" data-chat="install" type="button">${icon("download")}Install</button>
          <button class="ws-btn" data-chat="recheck" type="button">${icon("refresh")}Check again</button>
        </div>
        <pre class="ws-chat-install" hidden></pre></div>`;
      return;
    }

    if (tab.kind === "cursor" && tab.needsSignIn) {
      tab.log.innerHTML = `<div class="ws-chat-card">${icon("account_circle")}
        <strong>Sign in to Cursor Agent</strong>
        <p>The CLI is installed but not signed in. Signing in happens in a terminal, once — it opens your
           browser and the account it signs in as is yours, not WinT's.</p>
        <div class="ws-chat-card-actions">
          <button class="ws-btn primary" data-chat="signin" type="button">${icon("terminal")}Open a terminal to sign in</button>
          <button class="ws-btn" data-chat="recheck" type="button">${icon("refresh")}I've signed in</button>
        </div></div>`;
      return;
    }

    if (!tab.turns.length) {
      tab.log.innerHTML = `<div class="ws-chat-card quiet">${icon(spec.icon)}
        <strong>${esc(spec.product)} ${esc(tab.status.version || "")}</strong>
        <p>Working in <code>${esc(projectName)}</code>. Ask it anything about this project.</p></div>`;
      return;
    }

    const stick = tab.log.scrollTop + tab.log.clientHeight >= tab.log.scrollHeight - 40;
    tab.log.innerHTML = agentLogHtml(tab);
    if (stick) tab.log.scrollTop = tab.log.scrollHeight;
    revealAgentText(panel, tab);
  }

  // Install/sign-in status is a fact about the kind, not the conversation, so
  // one check refreshes every open tab of that kind - not just the one that
  // asked - the same way the cached status is shared across them at creation.
  async function checkAgent(panel, tab, { force = false } = {}) {
    const spec = AGENTS[tab.kind];
    if (!spec) return;

    const shouldShowSpinner = force || tab.status === null;
    if (shouldShowSpinner) {
      for (const t of panel.tabs.values()) {
        if (t.kind !== tab.kind) continue;
        t.status = null;
        t.needsSignIn = false;
        renderAgentTab(panel, t);
      }
    }

    let status;
    try {
      status = await invoke(spec.statusCmd);
    } catch {
      status = { installed: false, path: "", version: "" };
    }
    rememberStatus(tab.kind, status);

    for (const t of panel.tabs.values()) {
      if (t.kind !== tab.kind) continue;
      t.status = status;
      t.needsSignIn = tab.kind === "cursor" && Boolean(status.installed && !status.signedIn);
      renderAgentTab(panel, t);
    }
  }

  async function openAgentTerminal(panel, tab, { login = false } = {}) {
    const spec = AGENTS[tab.kind];
    if (!spec) return;

    const open = agentOverlay.session;
    if (open) {
      agentOverlay.el.hidden = false;
      hideBrowser();
      return;
    }

    let launch;
    try {
      if (tab.kind === "claude") {
        const command = await invoke(spec.terminalCmd, { session: tab.session || null });
        launch = { command, session: tab.session || null };
      } else if (tab.kind === "cursor") {
        launch = await invoke(spec.terminalCmd, { cwd: projectPath, session: tab.session || null, login });
      } else {
        launch = await invoke(spec.terminalCmd, { session: tab.session || null, login });
      }
    } catch (err) {
      return say(String(err));
    }

    agentOverlay.el.hidden = false;
    hideBrowser();
    agentOverlay.note.textContent = `${spec.label} is open in a terminal. Anything you do there is in the same conversation.`;

    try {
      const info = await busy("Opening agent in a terminal", () => invoke("term_open", {
        args: { projectPath, projectName, command: launch.command || launch },
      }));
      const view = new window.TermView(agentOverlay.host, info.id);
      agentOverlay.session = { id: info.id, view, tabId: tab.id };
      await view.attach();
      view.fit();

      // A conversation opened in a terminal must be resumed in the chat.
      if (tab.kind === "claude") tab.started = true;
      if (launch?.session) tab.session = launch.session;
      say(`${spec.label} is open in a terminal`);
    } catch (err) {
      agentOverlay.host.innerHTML = `<div class="ws-term-error">${esc(String(err))}</div>`;
      say(String(err));
    }
  }

  async function closeAgentTerminal() {
    const open = agentOverlay.session;
    agentOverlay.session = null;
    agentOverlay.el.hidden = true;
    agentOverlay.host.replaceChildren();
    syncBrowser();
    if (open) await invoke("term_close", { id: open.id }).catch(() => {});
    const panel = panels.get("agent");
    const tab = open && panel?.tabs.get(open.tabId);
    if (tab) renderAgentTab(panel, tab);
    say("Back to the chat");
  }

  const agentOverlay = (() => {
    const el = document.createElement("div");
    el.className = "ws-cursor-full";
    el.hidden = true;
    el.innerHTML = `<header>${icon("auto_awesome")}<strong>Agent</strong>
        <span class="ws-agent-note"></span>
        <button type="button" class="ws-btn" data-agent-full="close">${icon("close")}Back to the chat</button>
      </header>
      <div class="term-host"></div>`;
    document.body.appendChild(el);
    el.querySelector("[data-agent-full=close]").addEventListener("click", closeAgentTerminal);
    return { el, host: el.querySelector(".term-host"), note: el.querySelector(".ws-agent-note"), session: null };
  })();

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !agentOverlay.el.hidden) closeAgentTerminal();
  });

  async function installAgent(panel, tab) {
    const pre = tab.log.querySelector(".ws-chat-install");
    if (pre) {
      pre.hidden = false;
      pre.textContent = "Installing…\n";
    }
    try {
      await busy(`Installing ${AGENTS[tab.kind].label}`, () => invoke(AGENTS[tab.kind].installCmd, { window: label }));
    } catch (err) {
      if (pre) pre.textContent += `\n${err}`;
      say(String(err));
    }
  }

  async function sendToAgent(panel, tab) {
    const spec = AGENTS[tab.kind];
    const text = tab.input.value.trim();
    if (!spec || !text || tab.streaming) return;

    tab.input.value = "";
    tab.input.style.height = "auto";
    tab.turns.push({ role: "you", text });

    tab.startedAt = Date.now();
    tab.streaming = { role: tab.kind, text: "", shown: 0 };
    tab.turns.push(tab.streaming);
    renderAgentTab(panel, tab);
    renderAgentTabs(panel);

    try {
      if (tab.kind === "claude") {
        await invoke(spec.sendCmd, {
          window: label,
          tab: tab.id,
          prompt: text,
          cwd: projectPath,
          session: tab.session || null,
          resume: tab.started,
          permissionMode: "acceptEdits",
        });
        tab.started = true;
        say("Claude is working");
      } else {
        await invoke(spec.sendCmd, {
          window: label,
          tab: tab.id,
          prompt: text,
          cwd: projectPath,
          session: tab.session || null,
        });
        say(`${spec.label} is working`);
      }
    } catch (err) {
      tab.streaming = null;
      tab.turns.push({ role: "error", text: String(err) });
      renderAgentTab(panel, tab);
      renderAgentTabs(panel);
      say(String(err));
    }
  }

  // Tabs survive a reload (which kind, which pane, which conversation id) even
  // though the turns inside them do not - matching the pre-tabs limitation
  // that a chat's own history was never persisted either.
  const AGENT_TABS_KEY = `wint.workspace.agent.tabs.v1:${projectPath.toLowerCase()}`;

  const loadAgentTabs = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(AGENT_TABS_KEY) || "null");
      return saved?.tabs?.length ? saved : null;
    } catch {
      return null;
    }
  };

  const saveAgentTabs = (panel) => {
    try {
      const tabs = [...panel.tabs.values()].map((t) => ({ id: t.id, kind: t.kind, pane: t.pane, session: t.session || null, started: Boolean(t.started), title: t.title || "" }));
      localStorage.setItem(AGENT_TABS_KEY, JSON.stringify({ tabs, active: panel.active, splitRatio: panel.splitRatio }));
    } catch {}
  };

  function renderAgentTabs(panel) {
    for (let pane = 0; pane < 2; pane++) {
      const bar = panel.el.querySelector(`.ws-agent-tab-pane[data-tab-pane="${pane}"] .ws-agent-tabs`);
      const tabs = [...panel.tabs.values()].filter((t) => t.pane === pane);
      bar.innerHTML = tabs.length ? tabs.map((t) => {
        const spec = AGENTS[t.kind];
        const cls = ["ws-chat-tab"];
        if (t.id === panel.active) cls.push("on");
        return `<div class="${cls.join(" ")}" data-tab="${t.id}" title="Drag to reorder or split · ${esc(spec.label)}">${icon(spec.icon)}<span>${esc(spec.label)}</span>${t.streaming ? '<span class="ws-chat-tab-live"></span>' : ""}<button type="button" class="ws-chat-tab-x" data-close="${t.id}" title="Close this conversation">${icon("close")}</button></div>`;
      }).join("") : '<span class="ws-chat-tab-empty">No conversations</span>';

      const paneTab = panel.paneActive[pane] && panel.tabs.get(panel.paneActive[pane]);
      renderAgentTitle(panel, pane, paneTab || null);
    }
    syncAgentBarHeight(panel);
  }

  /** What a conversation is called on the title line: the name it was opened
   *  from history under, else the first thing asked in it, else nothing yet. */
  function agentTabTitle(tab) {
    if (tab.title) return tab.title;
    const first = tab.turns.find((t) => t.role === "you");
    if (!first) return "New conversation";
    const text = first.text.split(/\s+/).join(" ");
    return text.length > 90 ? `${text.slice(0, 90)}…` : text;
  }

  // The line under the tabs: which conversation the pane is showing, and the
  // buttons that act on that one conversation.
  function renderAgentTitle(panel, pane, tab) {
    const title = panel.el.querySelector(`[data-title="${pane}"]`);
    const actions = panel.el.querySelector(`[data-title-actions="${pane}"]`);
    const spec = tab && AGENTS[tab.kind];
    title.innerHTML = spec
      ? `${icon(spec.icon)}<strong>${esc(spec.product)}</strong><span>${esc(agentTabTitle(tab))}</span>`
      : `<span class="quiet">No conversation open</span>`;
    for (const button of actions.querySelectorAll("[data-dock]")) {
      const isHistory = button.dataset.dock === "history";
      button.disabled = !tab || (isHistory && !spec.sessionsCmd);
      if (isHistory) {
        button.title = !tab || spec.sessionsCmd
          ? "Earlier conversations in this project"
          : `${spec.product} does not keep conversations WinT can read back`;
      }
    }
  }

  const closeAgentMenus = (root) => {
    root.querySelectorAll(".ws-chat-agent-menu,.ws-agent-history-menu").forEach((m) => { m.hidden = true; });
  };

  const whenAgo = (ms) => {
    const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    return days < 7 ? `${days} d ago` : new Date(ms).toLocaleDateString();
  };

  /** Fills the history popover with this project's earlier conversations. The
   *  list is read every time it is opened - a conversation held in a terminal
   *  writes to the same place, so a cached list would go stale unseen. */
  async function showAgentHistory(panel, tab, menu) {
    const spec = AGENTS[tab.kind];
    if (!spec?.sessionsCmd) return;
    menu.innerHTML = `<div class="ws-chat-menu-label">Earlier conversations</div>
      <div class="ws-agent-history-note">${icon("progress_activity")}Reading transcripts…</div>`;
    let sessions = [];
    try {
      sessions = await invoke(spec.sessionsCmd, { cwd: projectPath });
    } catch (err) {
      menu.innerHTML = `<div class="ws-chat-menu-label">Earlier conversations</div>
        <div class="ws-agent-history-note">${esc(String(err))}</div>`;
      return;
    }
    if (menu.hidden) return;
    menu.innerHTML = `<div class="ws-chat-menu-label">Earlier conversations</div>`
      + (sessions.length
        ? sessions.map((s) => `<button type="button" data-session="${esc(s.id)}" data-session-title="${esc(s.title || "")}" title="${esc(s.title || s.id)}">
            <strong>${esc(s.title || "Untitled conversation")}</strong>
            <small>${esc(whenAgo(s.modified))} · ${s.turns} ${s.turns === 1 ? "question" : "questions"}</small>
          </button>`).join("")
        : `<div class="ws-agent-history-note">Nothing here yet.</div>`);
  }

  /** Replays a past conversation into this tab and carries on with it: the
   *  next question sent resumes that session rather than starting a new one. */
  async function loadAgentSession(panel, tab, id, title = "") {
    const spec = AGENTS[tab.kind];
    if (!spec?.transcriptCmd || tab.streaming) return;
    tab.log.innerHTML = `<div class="ws-chat-card checking">${icon("progress_activity")}Opening that conversation…</div>`;
    let turns;
    try {
      turns = await invoke(spec.transcriptCmd, { cwd: projectPath, session: id });
    } catch (err) {
      tab.turns.push({ role: "error", text: String(err) });
      return renderAgentTab(panel, tab);
    }
    tab.session = id;
    tab.started = true;
    tab.openSteps = new Set();
    // Nothing here is arriving live, so every answer is already fully written
    // out rather than typing itself back in a week later.
    tab.turns = turns.map((t) => ({ ...t, shown: t.text.length }));
    // The name the list showed it under, so the title line agrees with what
    // was clicked; the first question stands in when it has no name yet.
    tab.title = title;
    tab.title = agentTabTitle(tab);
    renderAgentTab(panel, tab);
    renderAgentTabs(panel);
    saveAgentTabs(panel);
  }

  // Tabs wrap instead of scrolling, so the bar has to grow with them. A split
  // pane's strip is position:absolute (needed so left/right panes don't share
  // width the normal flex way), which takes it out of the flow the bar would
  // otherwise auto-size to - so the height is measured and set here instead.
  function syncAgentBarHeight(panel) {
    const rows = [...panel.bar.querySelectorAll(".ws-agent-tabs")].map((el) => el.scrollHeight);
    panel.bar.style.height = `${Math.max(30, ...rows)}px`;
  }

  function syncAgentPaneLayout(panel) {
    const split = [...panel.tabs.values()].some((t) => t.pane === 1);
    panel.views.classList.toggle("split", split);
    panel.bar.classList.toggle("split", split);
    panel.titles.classList.toggle("split", split);
    for (const el of [panel.views, panel.bar, panel.titles]) el.style.setProperty("--agent-split", `${panel.splitRatio * 100}%`);
    for (const tab of panel.tabs.values()) {
      tab.el.dataset.pane = tab.pane;
      tab.el.classList.toggle("on", panel.paneActive[tab.pane] === tab.id);
    }
    for (const empty of panel.views.querySelectorAll("[data-empty-pane]")) {
      const pane = Number(empty.dataset.emptyPane);
      empty.hidden = !split || panel.paneActive[pane] !== null;
    }
  }

  function setActiveAgentTab(panel, id, { focus = true } = {}) {
    const tab = panel.tabs.get(id);
    if (!tab) return;
    panel.active = id;
    panel.paneActive[tab.pane] = id;
    renderAgentTabs(panel);
    syncAgentPaneLayout(panel);
    if (focus) tab.input.focus();
    saveAgentTabs(panel);
  }

  function createAgentTab(panel, kind, { pane = 0, id, session, started = false, title = "", activate = true } = {}) {
    const fresh = freshAgentState(kind);
    const tab = {
      id: id || newSessionId(),
      kind,
      pane,
      session: session ?? fresh.session,
      started,
      // Set once a conversation has a name of its own - opened from history, or
      // the first thing asked in it. Empty reads as "New conversation".
      title,
      turns: [],
      streaming: null,
      status: fresh.status,
      needsSignIn: fresh.needsSignIn,
      openSteps: new Set(),
      startedAt: 0,
      clock: null,
    };

    const el = document.createElement("div");
    el.className = "ws-agent-conv";
    el.innerHTML = `<div class="ws-chat-log"></div>
      <form class="ws-chat-ask" hidden>
        <div class="ws-chat-row">
          <textarea rows="1" placeholder="" spellcheck="false"></textarea>
          <button type="submit" class="ws-chat-send" title="Send (Enter)">${icon("send")}</button>
          <button type="button" class="ws-chat-stop" title="Stop" hidden>${icon("stop_circle")}</button>
        </div>
      </form>`;
    tab.el = el;
    tab.log = el.querySelector(".ws-chat-log");
    tab.ask = el.querySelector(".ws-chat-ask");
    tab.input = el.querySelector("textarea");
    panel.views.appendChild(el);

    tab.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); tab.ask.requestSubmit(); }
    });
    tab.input.addEventListener("input", () => {
      tab.input.style.height = "auto";
      tab.input.style.height = `${Math.min(160, tab.input.scrollHeight)}px`;
    });
    tab.ask.addEventListener("submit", (e) => { e.preventDefault(); sendToAgent(panel, tab); });
    tab.ask.querySelector(".ws-chat-stop").addEventListener("click", () => {
      const spec = AGENTS[tab.kind];
      if (spec) invoke(spec.cancelCmd, { tab: tab.id }).catch(() => {});
      tab.streaming = null;
      renderAgentTab(panel, tab);
      renderAgentTabs(panel);
    });
    tab.el.addEventListener("click", (e) => {
      const steps = e.target.closest("[data-steps]");
      if (steps) {
        const key = Number(steps.dataset.steps);
        if (!tab.openSteps.delete(key)) tab.openSteps.add(key);
        return renderAgentTab(panel, tab);
      }
      const action = e.target.closest("[data-chat]")?.dataset.chat;
      if (action === "install") return installAgent(panel, tab).catch(() => {});
      if (action === "signin") return openAgentTerminal(panel, tab, { login: true }).catch(() => {});
      if (action === "recheck") return checkAgent(panel, tab, { force: true }).catch(() => {});
    });

    panel.tabs.set(tab.id, tab);
    if (activate || panel.active === null) setActiveAgentTab(panel, tab.id, { focus: activate });
    renderAgentTabs(panel);
    syncAgentPaneLayout(panel);
    saveAgentTabs(panel);
    renderAgentTab(panel, tab);
    checkAgent(panel, tab).catch(() => {});
    return tab;
  }

  function closeAgentTab(panel, id) {
    const tab = panel.tabs.get(id);
    if (!tab) return;
    if (tab.streaming) {
      const spec = AGENTS[tab.kind];
      if (spec) invoke(spec.cancelCmd, { tab: tab.id }).catch(() => {});
    }
    if (tab.clock) clearInterval(tab.clock);
    tab.el.remove();
    panel.tabs.delete(id);

    for (const pane of [0, 1]) {
      if (panel.paneActive[pane] !== id) continue;
      const next = [...panel.tabs.values()].find((t) => t.pane === pane);
      panel.paneActive[pane] = next ? next.id : null;
    }
    if (panel.active === id) {
      const next = panel.paneActive[0] || panel.paneActive[1] || null;
      panel.active = next;
    }
    renderAgentTabs(panel);
    syncAgentPaneLayout(panel);
    saveAgentTabs(panel);
  }

  function moveAgentTabToPane(panel, id, pane) {
    const tab = panel.tabs.get(id);
    if (!tab) return;
    const oldPane = tab.pane;
    tab.pane = pane;
    panel.paneActive[pane] = id;
    if (panel.paneActive[oldPane] === id) {
      const next = [...panel.tabs.values()].find((t) => t.id !== id && t.pane === oldPane);
      panel.paneActive[oldPane] = next ? next.id : null;
    }
    panel.active = id;
    renderAgentTabs(panel);
    syncAgentPaneLayout(panel);
    tab.input.focus();
    saveAgentTabs(panel);
  }

  function reorderAgentTab(panel, id, target, after, pane) {
    if (target?.dataset.tab === id) return;
    const tab = panel.tabs.get(id);
    if (!tab) return;
    const oldPane = tab.pane;
    tab.pane = pane;
    panel.paneActive[pane] = id;
    if (oldPane !== pane && panel.paneActive[oldPane] === id) {
      const next = [...panel.tabs.values()].find((t) => t.id !== id && t.pane === oldPane);
      panel.paneActive[oldPane] = next ? next.id : null;
    }
    const ordered = [...panel.tabs.keys()].filter((tid) => tid !== id);
    if (target) {
      let at = ordered.indexOf(target.dataset.tab);
      if (after) at += 1;
      ordered.splice(at, 0, id);
    } else {
      ordered.push(id);
    }
    panel.tabs = new Map(ordered.map((tid) => [tid, panel.tabs.get(tid)]));
    panel.active = id;
    renderAgentTabs(panel);
    syncAgentPaneLayout(panel);
    saveAgentTabs(panel);
  }

  definePanel("agent", {
    label: "Agent",
    icon: "auto_awesome",
    bare: true,
    mount(body, panel) {
      panel.tabs = new Map();
      panel.active = null;
      panel.paneActive = [null, null];
      panel.splitRatio = 0.5;

      body.className += " ws-agent-dock";
      const agentMenu = (pane) => `<div class="ws-chat-tab-add" data-pane-add="${pane}">
          <button type="button" data-dock="add" title="New conversation">${icon("add")}</button>
          <div class="ws-chat-agent-menu" hidden>
            <div class="ws-chat-menu-label">New conversation</div>
            ${Object.values(AGENTS).map((spec) => `<button type="button" data-new-kind="${spec.id}">${icon(spec.icon)}${spec.label}</button>`).join("")}
          </div>
        </div>`;
      // Two rows, not one: the top row is nothing but the open conversations,
      // and the row under it names whichever of them the pane is showing and
      // carries the buttons that act on that one conversation. On a single
      // row the buttons sat beside every tab and read as if they belonged to
      // the strip rather than to the tab on screen.
      body.innerHTML = `<div class="ws-agent-bar">
          ${[0, 1].map((pane) => `
            <div class="ws-agent-tab-pane" data-tab-pane="${pane}">
              <div class="ws-agent-tabs"></div>
              <div class="ws-agent-pane-actions" data-pane-actions="${pane}">
                ${agentMenu(pane)}
              </div>
            </div>`).join("")}
        </div>
        <div class="ws-agent-titles">
          ${[0, 1].map((pane) => `
            <div class="ws-agent-title-pane" data-title-pane="${pane}">
              <span class="ws-agent-title" data-title="${pane}"></span>
              <div class="ws-agent-title-actions" data-title-actions="${pane}">
                <div class="ws-agent-history" data-history-for="${pane}">
                  <button type="button" data-dock="history" title="Earlier conversations in this project">${icon("history")}</button>
                  <div class="ws-agent-history-menu" hidden></div>
                </div>
                <button type="button" data-dock="terminal" title="Open in a terminal">${icon("terminal")}</button>
                <button type="button" data-dock="close" title="Close this conversation">${icon("close")}</button>
              </div>
            </div>`).join("")}
        </div>
        <div class="ws-agent-views">
          <div class="ws-agent-pane-empty" data-empty-pane="0">No conversation open</div>
          <div class="ws-agent-divider"></div>
          <div class="ws-agent-pane-empty" data-empty-pane="1">Drop a tab here to split</div>
          <div class="ws-agent-drop-zones">
            <div data-drop-pane="0"><span>${icon("dock_to_left")}Dock left</span></div>
            <div data-drop-pane="1"><span>${icon("dock_to_right")}Dock right</span></div>
          </div>
        </div>`;
      panel.bar = body.querySelector(".ws-agent-bar");
      panel.titles = body.querySelector(".ws-agent-titles");
      panel.views = body.querySelector(".ws-agent-views");
      // A column resize can change how many tabs fit per row, so the wrapped
      // bar height has to be re-measured whenever this panel's box changes.
      panel.resized = () => syncAgentBarHeight(panel);

      const paneOf = (el) => Number(el.closest("[data-title-actions]")?.dataset.titleActions ?? 0);
      // Set true for the duration of a tab drag, so the click that a pointerup
      // generates right after releasing it does not also switch tabs.
      let suppressTabClick = false;

      // Clicking a pane's "+" opens that pane's agent-kind picker; the rest of
      // the pane actions act on whichever tab is currently shown in that pane.
      panel.bar.addEventListener("click", (e) => {
        if (suppressTabClick) return;
        const addButton = e.target.closest('[data-dock="add"]');
        if (addButton) {
          const menu = addButton.nextElementSibling;
          const wasHidden = menu.hidden;
          body.querySelectorAll(".ws-chat-agent-menu").forEach((m) => { m.hidden = true; });
          menu.hidden = !wasHidden;
          return;
        }
        const newKind = e.target.closest("[data-new-kind]")?.dataset.newKind;
        if (newKind) {
          const pane = Number(e.target.closest("[data-pane-actions]").dataset.paneActions);
          e.target.closest(".ws-chat-agent-menu").hidden = true;
          createAgentTab(panel, newKind, { pane });
          return;
        }
        const closeId = e.target.closest("[data-close]")?.dataset.close;
        if (closeId) return closeAgentTab(panel, closeId);
        const tabEl = e.target.closest("[data-tab]");
        if (tabEl) return setActiveAgentTab(panel, tabEl.dataset.tab);
      });

      // The title line acts on one conversation only: whichever this pane is
      // showing. Picking an earlier conversation from the history list drops
      // it into that same tab rather than opening another one.
      panel.titles.addEventListener("click", (e) => {
        const pickedId = e.target.closest("[data-session]")?.dataset.session;
        const pane = paneOf(e.target);
        const tab = panel.paneActive[pane] && panel.tabs.get(panel.paneActive[pane]);
        if (!tab) return;
        if (pickedId) {
          const picked = e.target.closest("[data-session]");
          closeAgentMenus(body);
          return loadAgentSession(panel, tab, pickedId, picked.dataset.sessionTitle || "").catch(() => {});
        }
        const dockAction = e.target.closest("[data-dock]")?.dataset.dock;
        if (dockAction === "history") {
          const menu = e.target.closest(".ws-agent-history").querySelector(".ws-agent-history-menu");
          const wasHidden = menu.hidden;
          closeAgentMenus(body);
          menu.hidden = !wasHidden;
          if (!menu.hidden) showAgentHistory(panel, tab, menu).catch(() => {});
          return;
        }
        if (dockAction === "terminal") openAgentTerminal(panel, tab).catch(() => {});
        else if (dockAction === "close") closeAgentTab(panel, tab.id);
      });
      document.addEventListener("click", (e) => {
        if (e.target.closest(".ws-chat-tab-add") || e.target.closest(".ws-agent-history")) return;
        closeAgentMenus(body);
      });

      // Drag to reorder within a pane, or drag onto a drop zone to split into
      // the other pane. Pointer events (not native HTML5 drag) keep the whole
      // gesture inside the webview, the same reasoning terminals.js uses for
      // its own tab strip.
      const clearDropMarks = () => panel.bar.querySelectorAll(".drop-before,.drop-after").forEach((t) => t.classList.remove("drop-before", "drop-after"));
      panel.bar.addEventListener("pointerdown", (down) => {
        const tabEl = down.target.closest("[data-tab]");
        if (!tabEl || down.target.closest("[data-close]") || down.button !== 0) return;
        const id = tabEl.dataset.tab;
        const startX = down.clientX;
        const startY = down.clientY;
        let dragging = false;
        let target = null;
        let after = false;
        let ghost = null;
        tabEl.setPointerCapture(down.pointerId);

        const move = (e) => {
          if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
          if (!dragging) {
            dragging = true;
            suppressTabClick = true;
            tabEl.classList.add("dragging");
            ghost = document.createElement("div");
            ghost.className = "ws-chat-tab ws-agent-tab-ghost";
            ghost.innerHTML = tabEl.innerHTML;
            document.body.appendChild(ghost);
            panel.views.classList.add("choosing-pane");
          }
          ghost.style.transform = `translate(${e.clientX + 12}px,${e.clientY + 12}px)`;
          clearDropMarks();
          panel.views.querySelectorAll("[data-drop-pane]").forEach((zone) => zone.classList.remove("hover"));
          const dropZone = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-drop-pane]");
          dropZone?.classList.add("hover");
          const strip = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-tab-pane]")?.getBoundingClientRect();
          const inStrip = strip && e.clientX >= strip.left && e.clientX <= strip.right && e.clientY >= strip.top && e.clientY <= strip.bottom;
          target = inStrip ? document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-tab]") : null;
          if (target && target !== tabEl) {
            const rect = target.getBoundingClientRect();
            after = e.clientX >= rect.left + rect.width / 2;
            target.classList.add(after ? "drop-after" : "drop-before");
          }
        };
        const finish = (e, cancelled = false) => {
          const destination = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-drop-pane]");
          tabEl.removeEventListener("pointermove", move);
          tabEl.removeEventListener("pointerup", up);
          tabEl.removeEventListener("pointercancel", cancel);
          tabEl.classList.remove("dragging");
          clearDropMarks();
          ghost?.remove();
          panel.views.classList.remove("choosing-pane");
          panel.views.querySelectorAll("[data-drop-pane]").forEach((zone) => zone.classList.remove("hover"));
          if (!dragging || cancelled) { suppressTabClick = false; return; }
          const tabPane = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-tab-pane]");
          const strip = tabPane?.getBoundingClientRect();
          const inStrip = strip && e.clientX >= strip.left && e.clientX <= strip.right && e.clientY >= strip.top && e.clientY <= strip.bottom;
          if (destination) moveAgentTabToPane(panel, id, Number(destination.dataset.dropPane));
          else if (inStrip) reorderAgentTab(panel, id, target, after, Number(tabPane.dataset.tabPane));
          setTimeout(() => { suppressTabClick = false; }, 0);
        };
        const up = (e) => finish(e);
        const cancel = (e) => finish(e, true);
        tabEl.addEventListener("pointermove", move);
        tabEl.addEventListener("pointerup", up);
        tabEl.addEventListener("pointercancel", cancel);
      });

      const divider = panel.views.querySelector(".ws-agent-divider");
      divider.addEventListener("pointerdown", (down) => {
        down.preventDefault();
        divider.setPointerCapture(down.pointerId);
        const move = (e) => {
          const rect = panel.views.getBoundingClientRect();
          panel.splitRatio = Math.min(0.75, Math.max(0.25, (e.clientX - rect.left) / rect.width));
          syncAgentPaneLayout(panel);
        };
        const up = () => {
          divider.removeEventListener("pointermove", move);
          divider.removeEventListener("pointerup", up);
          saveAgentTabs(panel);
        };
        divider.addEventListener("pointermove", move);
        divider.addEventListener("pointerup", up);
      });

      const saved = loadAgentTabs();
      if (saved) {
        panel.splitRatio = Math.min(0.75, Math.max(0.25, saved.splitRatio || 0.5));
        for (const t of saved.tabs) {
          if (!AGENTS[t.kind]) continue;
          createAgentTab(panel, t.kind, { pane: t.pane === 1 ? 1 : 0, id: t.id, session: t.session, started: Boolean(t.started), title: t.title || "", activate: false });
        }
        // Restoring with activate:false only sets paneActive for whichever
        // tab happened to land first overall - make sure a split's second
        // pane also has something showing rather than an empty placeholder.
        for (const pane of [0, 1]) {
          if (panel.paneActive[pane]) continue;
          const first = [...panel.tabs.values()].find((t) => t.pane === pane);
          if (first) panel.paneActive[pane] = first.id;
        }
        setActiveAgentTab(panel, saved.active && panel.tabs.has(saved.active) ? saved.active : panel.tabs.keys().next().value, { focus: false });
      } else {
        createAgentTab(panel, "claude");
      }
    },
  });

  // ---------------------------------------------------------- install/line parsers

  function cursorAssistantText(obj) {
    const content = obj?.message?.content;
    if (!Array.isArray(content)) return "";
    return content.filter((c) => c.type === "text").map((c) => c.text || "").join("");
  }

  function cursorToolSummary(obj) {
    const toolCall = obj?.tool_call || {};
    const key = Object.keys(toolCall).find((k) => k.endsWith("ToolCall"));
    if (!key) return "";
    const rawName = key.replace(/ToolCall$/, "");
    const toolName = rawName ? rawName[0].toUpperCase() + rawName.slice(1) : "Tool";
    const args = toolCall[key]?.args || {};
    if (args.path) return `${toolName} · ${args.path}`;
    if (args.pattern) return `${toolName} · ${args.pattern}`;
    if (args.command) return `${toolName} · ${args.command}`;
    return `${toolName}`;
  }

  // Every kind's events carry the tab id that started the turn, so with
  // several tabs (even several of the same kind) open at once the line lands
  // on the conversation that asked for it, not a single kind-wide slot.
  function agentTabFor(payload) {
    if (payload.window !== label) return null;
    const panel = panels.get("agent");
    return panel ? { panel, tab: panel.tabs.get(payload.tab) } : null;
  }

  await listen("claude:install", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    const pre = tab.log?.querySelector(".ws-chat-install");
    if (pre && payload.line) {
      pre.textContent += `${payload.line}\n`;
      pre.scrollTop = pre.scrollHeight;
    }
    if (!payload.done) return;
    if (payload.ok) checkAgent(panel, tab, { force: true }).catch(() => {});
  }).catch(() => {});

  await listen("claude:line", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    let msg;
    try { msg = JSON.parse(payload.line); } catch { return; }

    if (msg.session_id) tab.session = msg.session_id;

    if (msg.type === "stream_event" && msg.event?.delta?.type === "text_delta") {
      if (!tab.streaming) { tab.streaming = { role: "claude", text: "" }; tab.turns.push(tab.streaming); }
      tab.streaming.text += msg.event.delta.text || "";
      return markAgentTabDirty(panel, tab);
    }
    if (msg.type === "assistant") {
      for (const block of msg.message?.content || []) {
        if (block.type !== "tool_use") continue;
        tab.turns.push({ role: "tool", icon: TOOL_ICONS[block.name] || "build", text: toolLine(block) });
      }
      return markAgentTabDirty(panel, tab);
    }
    if (msg.type === "result") {
      tab.streaming = null;
      const text = String(msg.result || "");
      if (msg.is_error || msg.subtype === "error_during_execution") {
        tab.turns.push({ role: "error", text: text || "That turn did not finish." });
      }
      if (/log ?in|sign ?in|not authenticated|invalid api key|credit balance/i.test(text)) {
        tab.needsSignIn = true;
      }
      renderAgentTab(panel, tab);
      renderAgentTabs(panel);
    }
  }).catch(() => {});

  await listen("claude:end", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    tab.streaming = null;
    if (payload.code !== 0 && payload.error) {
      tab.turns.push({ role: "error", text: payload.error.trim() });
    }
    renderAgentTab(panel, tab);
    renderAgentTabs(panel);
  }).catch(() => {});

  await listen("cursor:install", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    const pre = tab.log?.querySelector(".ws-chat-install");
    if (pre && payload.line) {
      pre.textContent += `${payload.line}\n`;
      pre.scrollTop = pre.scrollHeight;
    }
    if (!payload.done) return;
    if (payload.ok) checkAgent(panel, tab, { force: true }).catch(() => {});
  }).catch(() => {});

  await listen("cursor:line", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    let obj;
    try { obj = JSON.parse(payload.line); } catch { return; }

    if (obj.session_id && !tab.session) tab.session = obj.session_id;

    if (obj.type === "assistant") {
      const text = cursorAssistantText(obj);
      if (!text) return;

      const hasTs = obj.timestamp_ms !== undefined && obj.timestamp_ms !== null;
      const hasModelCallId = obj.model_call_id !== undefined && obj.model_call_id !== null;
      if (hasTs && hasModelCallId) {
        // Buffered flush before a tool call: duplicates the token stream.
        return;
      }
      if (hasTs) {
        if (!tab.streaming) { tab.streaming = { role: "cursor", text: "" }; tab.turns.push(tab.streaming); }
        tab.streaming.text += text;
        return markAgentTabDirty(panel, tab);
      }

      // Final assistant message chunk between tool calls.
      if (tab.streaming) tab.streaming.text = text;
      else tab.turns.push({ role: "cursor", text });
      tab.streaming = null;
      renderAgentTab(panel, tab);
      renderAgentTabs(panel);
      return;
    }

    if (obj.type === "tool_call" && obj.subtype === "completed") {
      const summary = cursorToolSummary(obj);
      if (!summary) return;
      tab.turns.push({ role: "tool", icon: "build", text: summary });
      renderAgentTab(panel, tab);
    }
  }).catch(() => {});

  await listen("cursor:end", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    tab.streaming = null;
    if (payload.code !== 0 && payload.error) {
      tab.turns.push({ role: "error", text: payload.error.trim() });
    }
    renderAgentTab(panel, tab);
    renderAgentTabs(panel);
  }).catch(() => {});

  await listen("copilot:install", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    const pre = tab.log?.querySelector(".ws-chat-install");
    if (pre && payload.line) {
      pre.textContent += `${payload.line}\n`;
      pre.scrollTop = pre.scrollHeight;
    }
    if (!payload.done) return;
    if (payload.ok) checkAgent(panel, tab, { force: true }).catch(() => {});
  }).catch(() => {});

  await listen("copilot:line", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    let obj;
    try { obj = JSON.parse(payload.line); } catch { return; }

    const sid = obj.sessionId || obj.session_id || obj.data?.sessionId;
    if (typeof sid === "string" && sid.length <= 64) tab.session = sid;

    if (obj.type === "assistant.message_delta") {
      const delta = obj.data?.deltaContent;
      if (!delta) return;
      if (!tab.streaming) { tab.streaming = { role: "copilot", text: "" }; tab.turns.push(tab.streaming); }
      tab.streaming.text += delta;
      return markAgentTabDirty(panel, tab);
    }

    if (obj.type === "assistant.message") {
      const msg = obj.data?.message;
      const text = msg?.content?.join ? msg.content.join("") : msg?.content || msg?.text || "";
      if (!text) return;
      if (!tab.streaming) tab.turns.push({ role: "copilot", text });
      else tab.streaming.text = text;
      tab.streaming = null;
      renderAgentTab(panel, tab);
      renderAgentTabs(panel);
    }
  }).catch(() => {});

  await listen("copilot:end", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    tab.streaming = null;
    if (payload.code !== 0 && payload.error) {
      tab.turns.push({ role: "error", text: payload.error.trim() });
    }
    renderAgentTab(panel, tab);
    renderAgentTabs(panel);
  }).catch(() => {});

  await listen("gemini:install", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    const pre = tab.log?.querySelector(".ws-chat-install");
    if (pre && payload.line) {
      pre.textContent += `${payload.line}\n`;
      pre.scrollTop = pre.scrollHeight;
    }
    if (!payload.done) return;
    if (payload.ok) checkAgent(panel, tab, { force: true }).catch(() => {});
  }).catch(() => {});

  await listen("gemini:line", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    let obj;
    try { obj = JSON.parse(payload.line); } catch { return; }

    if (obj.type === "init" && obj.session_id) tab.session = obj.session_id;

    if (obj.type === "message" && obj.role === "assistant") {
      const text = obj.content || "";
      if (!text) return;
      if (obj.delta) {
        if (!tab.streaming) { tab.streaming = { role: "gemini", text: "" }; tab.turns.push(tab.streaming); }
        tab.streaming.text += text;
        return markAgentTabDirty(panel, tab);
      }

      if (!tab.streaming) tab.turns.push({ role: "gemini", text });
      else tab.streaming.text += text;
      tab.streaming = null;
      renderAgentTab(panel, tab);
      renderAgentTabs(panel);
      return;
    }

    if (obj.type === "error") {
      tab.turns.push({ role: "error", text: String(obj.message || obj.error || "Gemini error") });
      tab.streaming = null;
      renderAgentTab(panel, tab);
      renderAgentTabs(panel);
    }
  }).catch(() => {});

  await listen("gemini:end", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    tab.streaming = null;
    if (payload.code !== 0 && payload.error) {
      tab.turns.push({ role: "error", text: payload.error.trim() });
    }
    renderAgentTab(panel, tab);
    renderAgentTabs(panel);
  }).catch(() => {});

  await listen("codex:install", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    const pre = tab.log?.querySelector(".ws-chat-install");
    if (pre && payload.line) {
      pre.textContent += `${payload.line}\n`;
      pre.scrollTop = pre.scrollHeight;
    }
    if (!payload.done) return;
    if (payload.ok) checkAgent(panel, tab, { force: true }).catch(() => {});
  }).catch(() => {});

  await listen("codex:line", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    let obj;
    try { obj = JSON.parse(payload.line); } catch { return; }

    if (obj.type === "thread.started" && obj.thread_id) tab.session = obj.thread_id;

    if (obj.type === "item.completed" && obj.item && obj.item.type !== "agent_message" && obj.item.type !== "reasoning") {
      const line = codexToolLine(obj.item);
      if (line) {
        tab.turns.push({ role: "tool", icon: CODEX_ITEM_ICONS[obj.item.type] || "build", text: line });
        markAgentTabDirty(panel, tab);
      }
      return;
    }

    if (obj.type === "item.completed" && obj.item?.type === "agent_message") {
      const text = String(obj.item?.text || "");
      if (!tab.streaming) {
        tab.streaming = { role: "codex", text: "" };
        tab.turns.push(tab.streaming);
      }
      tab.streaming.text = text;
      tab.streaming = null;
      renderAgentTab(panel, tab);
      renderAgentTabs(panel);
      return;
    }

    if (obj.type === "turn.failed" && obj.error?.message) {
      tab.streaming = null;
      tab.turns.push({ role: "error", text: String(obj.error.message) });
      renderAgentTab(panel, tab);
      renderAgentTabs(panel);
      return;
    }
    if (obj.type === "error" && obj.message) {
      tab.streaming = null;
      tab.turns.push({ role: "error", text: String(obj.message) });
      renderAgentTab(panel, tab);
      renderAgentTabs(panel);
      return;
    }
  }).catch(() => {});

  await listen("codex:end", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    tab.streaming = null;
    if (payload.code !== 0 && payload.error) {
      tab.turns.push({ role: "error", text: payload.error.trim() });
    }
    renderAgentTab(panel, tab);
    renderAgentTabs(panel);
  }).catch(() => {});

  /* ----------------------------------------------------------------- go */

  // Drawn before anything is subscribed to or awaited. This window has no
  // native frame, so a page that dies on the way up is a window with no title
  // bar buttons and no way to close it - the layout goes up first, and
  // everything that can fail comes after it.
  render();

  // The one line of terminal output the rest of the window acts on. A
  // subscription that cannot be set up costs the browser panel its automatic
  // address and nothing else, so it is not allowed to take the window with it.
  // The event is broadcast to every window, so a dev server started in some
  // other project's terminal must not steer this workspace's browser. The dock
  // is the only thing that knows which terminals are this window's, and it does
  // not exist until the terminal panel has loaded terminals.js.
  listen("term:serving", ({ payload }) => {
    const dock = window.wintTermDock;
    if (!dock?.has(payload.id)) return;
    goTo(payload.url, `${dock.label(payload.id)} is serving ${payload.url}`);
  }).catch((err) => say(`Cannot watch the terminals for a dev server: ${err}`));

  window.wintTrackPageView?.("/workspace");
})().catch((err) => {
  console.error("The workspace could not start:", err);
});
