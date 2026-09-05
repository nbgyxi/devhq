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
  const emit = window.__TAURI__.event.emit;
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

  /** One panel's `resized`, and never anyone else's problem. These run in a
   *  loop that ends by putting the browser webview back over its hole, so a
   *  panel that throws while measuring itself used to take the whole pass with
   *  it - and the webview stayed the size it was, drawn over the terminal. */
  const resizePanel = (panel) => {
    try { panel.resized(); } catch (err) { console.error(`${panel.id} could not resize:`, err); }
  };

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
        for (const panel of panels.values()) if (visible(panel.id)) resizePanel(panel);
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
        // A capture lost to anything else - the window losing focus, a touch
        // cancelled - ends the drag as surely as letting go does, and without
        // this the webview stayed hidden and the sizes stayed unsaved.
        grip.removeEventListener("pointercancel", up);
        grip.removeEventListener("lostpointercapture", up);
        document.body.classList.remove("ws-resizing");
        saveLayout();
        for (const panel of panels.values()) if (visible(panel.id)) resizePanel(panel);
        syncBrowser();
        say("Resized the panels");
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
      grip.addEventListener("lostpointercapture", up);
    });
  }

  window.addEventListener("resize", () => {
    for (const panel of panels.values()) if (visible(panel.id)) resizePanel(panel);
    queueSyncBrowser();
  });

  // Windows resizes a window in a loop of its own that can starve the page's
  // own resize event, so the native side reports it too.
  win.onResized(() => queueSyncBrowser()).catch(() => {});

  /* ------------------------------------------------------ window geometry */

  // A workspace reopens where it was left — same screen, same size, and
  // maximized if it was maximized. Rust applies this while building the
  // window, so the geometry is written where the main window can read it back:
  // both pages share one origin, and the main window is what asks for the
  // workspace to open.
  //
  // While maximized the size and place kept are the *restored* ones, so
  // un-maximizing a reopened window lands on the box it had before, not on the
  // screen-sized one.
  const GEOM_KEY = `wint.workspace.geom:${projectPath.toLowerCase()}`;
  const readGeometry = () => {
    try { return JSON.parse(localStorage.getItem(GEOM_KEY) || "null") || {}; } catch { return {}; }
  };
  let geomTimer = 0;
  const saveGeometry = async () => {
    try {
      const maximized = await win.isMaximized();
      const geometry = { ...readGeometry(), maximized };
      if (!maximized) {
        const scale = await win.scaleFactor();
        const size = (await win.innerSize()).toLogical(scale);
        const position = (await win.outerPosition()).toLogical(scale);
        geometry.width = Math.round(size.width);
        geometry.height = Math.round(size.height);
        geometry.x = Math.round(position.x);
        geometry.y = Math.round(position.y);
      }
      localStorage.setItem(GEOM_KEY, JSON.stringify(geometry));
    } catch { /* A window that cannot be measured simply reopens at the default. */ }
  };
  // Windows resizes and moves in a loop of its own, so this fires constantly
  // while a window is dragged. Only the value it comes to rest at matters.
  const queueSaveGeometry = () => {
    clearTimeout(geomTimer);
    geomTimer = setTimeout(saveGeometry, 250);
  };
  win.onResized(() => queueSaveGeometry()).catch(() => {});
  win.onMoved(() => queueSaveGeometry()).catch(() => {});
  // Nothing is saved on load: the window Rust just placed is still settling —
  // a restored maximize arrives as a resize of its own — and a page that saved
  // first would write the un-maximized state back over the one it was given.

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
      return win.close();
    });
  });

  /** Everything this window holds open outside the page itself, put away
   *  before the window goes: the child webview, which is not destroyed with
   *  the page, and every shell this workspace was showing.
   *
   *  The cross and Alt+F4 both arrive here, so it runs once either way. */
  let closing = false;
  win.onCloseRequested(async (event) => {
    if (closing) return;
    closing = true;
    event.preventDefault();
    // The last resize or move may still be waiting out its debounce, and where
    // the window was when it closed is exactly where it should come back.
    clearTimeout(geomTimer);
    await saveGeometry();
    await panels.get("browser")?.settlePreviewEdit?.();
    await invoke("workspace_browser_close", { window: label }).catch(() => {});
    await closeWorkspaceTerminals();
    win.close();
  }).catch(() => {});

  /** Closes every shell this workspace had - the terminal panel's tabs, and a
   *  conversation the agent panel handed to a terminal of its own - and has
   *  whatever they leave behind watched.
   *
   *  Closing a terminal tab already checks that what was running under it
   *  really ended; closing the window those tabs live in is the same act on
   *  all of them at once, and the same check is owed. The survivors are handed
   *  to WinT's own window, because that is where the warning is shown and this
   *  one is about to be gone. */
  async function closeWorkspaceTerminals() {
    const expected = [];
    const open = agentOverlay?.session;
    if (open) {
      agentOverlay.session = null;
      const processes = await invoke("term_close_snapshot", { id: open.id }).catch(async () => {
        await invoke("term_close", { id: open.id }).catch(() => {});
        return [];
      });
      expected.push(...(processes || []));
    }
    const dockLeftovers = await (window.wintTermDock?.closeAll?.().catch(() => []) ?? []);
    expected.push(...(dockLeftovers || []));
    if (expected.length) await emit("term:orphan-watch", { expected }).catch(() => {});
  }

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

  /** The full-window overlay is a page element, so the browser must stay away
   *  while it is up. Asked of the DOM rather than of the overlay itself so this
   *  holds for a sync from anywhere, at any point in the window's life. */
  const fullOverlayOpen = () =>
    !!document.querySelector(".ws-cursor-full:not([hidden])");

  /** Puts the webview exactly over the hole, creating it the first time. */
  const syncBrowser = () => {
    const rect = browserRect();
    if (!rect || !browserUrl || fullOverlayOpen() || panels.get("browser")?.previewOpen) return hideBrowser();
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

  // Resizes arrive in bursts - a window edge being dragged is one event per
  // frame - and each one is an IPC call that moves a native webview. One per
  // frame is what the window can actually draw, so they are coalesced.
  // While a divider or a panel is being dragged the webview is deliberately
  // hidden - it swallows the mouse - so a resize arriving mid-drag must not
  // put it back. The drag ends by syncing itself.
  let syncQueued = false;
  const queueSyncBrowser = () => {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      if (document.body.classList.contains("ws-resizing") || document.body.classList.contains("ws-dragging")) return;
      syncBrowser();
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

  /* --------------------------------------- how wide the page is drawn */

  // A page is often worth seeing at a phone's width, and dragging the panel
  // splitter to get there rearranges the whole workspace - the terminal and
  // the file tree pay for a look at a narrow layout. So the page is narrowed
  // inside the panel instead: the hole the webview is positioned over gets a
  // max width and is centred, the splitters never move, and the site sees a
  // genuinely narrower viewport because the webview really is that wide.
  const WIDTHS = [
    { width: 0, icon: "desktop_windows", title: "Fill the panel" },
    { width: 1024, icon: "laptop_windows", title: "Laptop width (1024px)" },
    { width: 768, icon: "tablet", title: "Tablet width (768px)" },
    { width: 390, icon: "mobile", title: "Phone width (390px)" },
  ];
  const WIDTH_KEY = `wint.workspace.browser-width:${projectPath.toLowerCase()}`;
  const savedWidth = () => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      return WIDTHS.some((w) => w.width === saved) ? saved : 0;
    } catch { return 0; }
  };
  let browserWidth = savedWidth();

  /** Draws the current choice: the hole is capped and centred, and the button
   *  that did it is lit. The hole's ResizeObserver moves the webview to match,
   *  so nothing else has to be told. */
  const applyWidth = (panel) => {
    if (!panel?.hole) return;
    panel.hole.style.maxWidth = browserWidth ? `${browserWidth}px` : "";
    panel.hole.classList.toggle("narrow", Boolean(browserWidth));
    for (const button of panel.widths?.querySelectorAll("[data-width]") || [])
      button.classList.toggle("on", Number(button.dataset.width) === browserWidth);
  };

  const setWidth = (width) => {
    browserWidth = WIDTHS.some((w) => w.width === width) ? width : 0;
    try { localStorage.setItem(WIDTH_KEY, String(browserWidth)); } catch {}
    applyWidth(panels.get("browser"));
    say(browserWidth ? `Page drawn ${browserWidth}px wide` : "Page fills the panel");
  };

  /* ------------------------------------------------ the run button */

  // An empty browser panel is one command away from not being empty, so that
  // is what it shows: a play button carrying the command this project is
  // started with. The command is only ever a guess, so it sits in a real
  // input - what gets typed there is what runs, and it is kept for the
  // project so the guess is only made once.
  const RUN_KEY = `wint.workspace.run:${projectPath.toLowerCase()}`;
  const savedRunCommand = () => { try { return localStorage.getItem(RUN_KEY) || ""; } catch { return ""; } };
  const saveRunCommand = (value) => { try { localStorage.setItem(RUN_KEY, value); } catch {} };

  /** How this project is started, worked out by the same detector the project
   *  list's Run button uses - the dev script that is really declared, run
   *  through the package manager the lock file names, and the handful of
   *  ecosystems without one. Empty when the folder says nothing. */
  const guessRunCommand = () => invoke("project_run_command", { path: projectPath }).catch(() => "");

  /** Types the command into this workspace's terminal and presses Enter. The
   *  terminal panel is opened if it was put away, and a workspace whose dock
   *  has not finished starting is waited on rather than told no. */
  const runCommand = (command) => {
    const value = String(command || "").trim();
    if (!value) return say("Type the command that starts this project first");
    saveRunCommand(value);
    const slot = slotOf("terminal");
    if (slot && layout.hidden[slot]) { layout.hidden[slot] = false; render(); }
    let asked = false;
    const send = (tries = 0) => {
      if (window.wintTermDock?.write(`${value}\r`)) return say(`Running ${value}`);
      if (!asked && window.wintTermDock) { asked = true; window.wintTermDock.newTerminal(); }
      if (tries < 20) setTimeout(() => send(tries + 1), 250);
      else say("There is no terminal to run that in yet.");
    };
    send();
  };

  definePanel("browser", {
    label: "Browser",
    icon: "public",
    mount(body, panel) {
      panel.tools.innerHTML = `
        <button class="ws-mini" data-browser="reload" type="button" title="Reload">${icon("refresh")}</button>
        <input class="ws-address" data-browser="address" placeholder="Type an address" spellcheck="false" />
        <button class="ws-mini" data-browser="external" type="button" title="Open in your real browser">${icon("open_in_new")}</button>
        <span class="ws-widths" role="group" aria-label="Page width">${WIDTHS.map((w) => `
          <button class="ws-mini" data-width="${w.width}" type="button" title="${esc(w.title)}">${icon(w.icon)}</button>`).join("")}</span>`;
      panel.address = panel.tools.querySelector("[data-browser=address]");
      panel.widths = panel.tools.querySelector(".ws-widths");
      body.innerHTML = `<div class="ws-browser-hole"></div>
        <div class="ws-browser-empty">
          <button class="ws-run" data-browser="run" type="button" title="Run this command in the terminal below">${icon("play_arrow")}</button>
          <input class="ws-run-cmd" data-browser="command" spellcheck="false" autocomplete="off" placeholder="Working out how this project starts…" />
          <p>Runs in the terminal below. The moment it prints a localhost address, this panel opens it.
             Wrong command? Edit it — it is kept for this project.</p>
        </div>
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
      // The hole is the only truth about where the webview belongs, so watch
      // it rather than the things that move it. A window resized by its edge
      // reflows the grid without any of the layout code running, and the
      // webview - drawn over the page, not in it - stayed the size it was and
      // sat on top of the terminal until something else happened to sync it.
      new ResizeObserver(() => queueSyncBrowser()).observe(panel.hole);
      applyWidth(panel);
      panel.empty = body.querySelector(".ws-browser-empty");
      panel.command = body.querySelector(".ws-run-cmd");
      panel.command.value = savedRunCommand();
      if (panel.command.value) panel.command.placeholder = "Command that starts this project";
      if (!panel.command.value) {
        guessRunCommand().then((guess) => {
          // Whatever was typed while the guess was being worked out wins.
          if (!panel.command.value) panel.command.value = guess;
          panel.command.placeholder = "Command that starts this project";
        });
      }
      panel.command.addEventListener("change", () => saveRunCommand(panel.command.value.trim()));
      panel.command.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        runCommand(panel.command.value);
      });
      panel.empty.querySelector(".ws-run").addEventListener("click", () => runCommand(panel.command.value));
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
        const width = e.target.closest("[data-width]")?.dataset.width;
        if (width !== undefined) setWidth(Number(width));
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
          // With no page loaded there is nothing behind the preview, so the
          // play button comes back rather than a blank panel.
          panel.empty.hidden = Boolean(browserUrl);
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

  async function loadDir(panel, host, path, depth, options = {}) {
    host.dataset.loaded = "1";
    if (!options.silent) host.innerHTML = `<div class="ws-tree-note">Reading…</div>`;
    try {
      const rows = await busy(depth ? `Reading ${path.split(/[\\/]/).pop()}` : "Reading the project folder", () => invoke("workspace_list_dir", { path }));
      const html = rows.map((row) => `
        <button class="ws-tree-row${row.directory ? " dir" : ""}" data-path="${esc(row.path)}" data-name="${esc(row.name)}"
                data-directory="${row.directory}" data-depth="${depth}" style="--ws-depth:${depth}">
          <span class="ms ws-tree-caret" aria-hidden="true">${row.directory ? "chevron_right" : "description"}</span>
          <span class="ws-tree-name">${esc(row.name)}</span>
        </button>${row.directory ? `<div class="ws-tree" hidden></div>` : ""}`).join("")
        || `<div class="ws-tree-note">This folder is empty.</div>`;
      const signature = JSON.stringify(rows.map(({ name, path, directory }) => [name, path, directory]));
      if (host.dataset.signature !== signature) {
        host.innerHTML = html;
        host.dataset.signature = signature;
      }
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
    const kids = [...body.children].filter((el) => !el.hidden);
    // The list of saved-but-not-uploaded versions is the one child allowed to
    // scroll, so its own box is already whatever height it was given last
    // time. Its content height is what the panel wants; the ceiling below is
    // what it gets.
    const kidHeight = (el) => Math.max(el.getBoundingClientRect().height, el.classList.contains("ws-git-saved") ? el.scrollHeight : 0);
    const content = kids.reduce((sum, el) => sum + kidHeight(el), 0)
      + gap * Math.max(0, kids.length - 1)
      + parseFloat(box.paddingTop) + parseFloat(box.paddingBottom);
    const head = panel.el.querySelector(".ws-head");
    const slotBox = getComputedStyle(slot);
    // The slot border (and a scrollbar, if one is somehow still there) plus
    // the gap the slot keeps from its neighbours.
    const chrome = slot.offsetHeight - slot.clientHeight
      + parseFloat(slotBox.marginTop) + parseFloat(slotBox.marginBottom);
    const want = content + (head?.getBoundingClientRect().height || 0) + chrome;
    // The panel above it still has to exist, and a long list of saved versions
    // must not take the column over: two fifths of it is as far as this panel
    // grows, and past that the list scrolls inside it.
    const column = slot.parentElement;
    const columnHeight = column?.clientHeight || 0;
    const ceiling = Math.max(90, Math.min(columnHeight - 120, columnHeight * 0.4));
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
        <div class="ws-git-branchline" hidden></div>
        <div class="ws-git-saved" hidden></div>
        <div class="ws-git-note" hidden></div>
        <div class="ws-git-operation" role="status" aria-live="polite" hidden></div>
        <form class="ws-git-form"><input name="message" placeholder="What did you change?" autocomplete="off" />
          <div class="ws-git-buttons">
            <button type="submit" class="ws-btn primary" data-git="save">${icon("bookmark_add")}Save</button>
            <button type="button" class="ws-btn" data-git="push">${icon("cloud_upload")}Upload</button>
            <button type="button" class="ws-btn" data-git="pull">${icon("cloud_download")}Get</button>
          </div></form>
        <div class="ws-git-jobs" hidden></div>`;
      panel.state = body.querySelector(".ws-git-state");
      panel.branchline = body.querySelector(".ws-git-branchline");
      panel.saved = body.querySelector(".ws-git-saved");
      panel.jobs = body.querySelector(".ws-git-jobs");
      panel.note = body.querySelector(".ws-git-note");
      panel.operation = body.querySelector(".ws-git-operation");
      panel.form = body.querySelector(".ws-git-form");
      panel.tools.addEventListener("click", () => loadGit(panel));
      panel.form.addEventListener("submit", (e) => { e.preventDefault(); saveVersion(panel); });
      body.addEventListener("click", (e) => {
        const action = e.target.closest("[data-git]")?.dataset.git;
        if (action === "push") gitAct(panel, "push", "Uploading your work");
        if (action === "pull") gitAct(panel, "pull", "Getting your team's changes");
        if (action === "branch-out") askBranchName(panel);
        if (action === "branch-cancel") renderBranchLine(panel);
        if (action === "branch-make") makeBranch(panel);
        if (action === "merge-main") mergeToMain(panel);
        if (action === "note-close") gitNote(panel, "");
        if (action === "open-run") {
          const url = e.target.closest("[data-run-url]")?.dataset.runUrl;
          if (url) invoke("plugin:opener|open_url", { url }).catch(() => {});
        }
      });
      panel.branchline.addEventListener("submit", (e) => { e.preventDefault(); makeBranch(panel); });
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
      heightObserver.observe(panel.branchline);
      heightObserver.observe(panel.saved);
      heightObserver.observe(panel.jobs);
      heightObserver.observe(panel.note);
      heightObserver.observe(panel.operation);
      heightObserver.observe(panel.form);
      panel.resized = () => syncGitHeight(panel);
      loadGit(panel);
    },
  });

  let gitLoading = false;
  async function loadGit(panel, options = {}) {
    if (gitLoading || panel.working) return;
    gitLoading = true;
    try {
      const data = await busy("Checking what changed", () => invoke("git_workspace", { path: projectPath }));
      panel.data = data;
      const g = data.info;
      const changed = g.changed || [];
      // Where the work is, said the way people think about it: the folder
      // everyone shares, or one of your own. The branch name is no use as the
      // headline - it is what the folder is called, so it goes underneath, and
      // only when you are not on the shared one.
      const main = mainBranch(panel);
      const onMain = !!main && g.branch === main;
      panel.state.innerHTML = `
        <p class="ws-git-branch">${icon(onMain ? "folder" : "alt_route")}
          <strong>${onMain ? `Working on the ${esc(main)} folder` : "Working on a separate folder"}</strong>
          ${g.ahead ? `<b title="Recorded here, not uploaded">${g.ahead} to upload</b>` : ""}
          ${g.behind ? `<b title="Waiting from your team">${g.behind} to get</b>` : ""}</p>
        ${onMain ? "" : `<p class="ws-git-branch-name" title="What this folder is called">${esc(g.branch || "a detached snapshot")}</p>`}
        <p class="ws-git-line">${changed.length
          ? `${changed.length} changed file${changed.length === 1 ? "" : "s"} not saved yet.`
          : g.ahead ? "Everything is saved here, but not uploaded yet." : "Nothing to save. You are up to date."}</p>`;
      renderUnpushed(panel, data.unpushed || []);
      renderBranchLine(panel);
      publishChanged(changed);
      if (!options.skipJobs) loadGithubJobs(panel);
      say(changed.length ? `${changed.length} file${changed.length === 1 ? "" : "s"} changed` : "Nothing to save");
    } catch (err) {
      panel.state.innerHTML = `<p class="ws-git-line">${esc(String(err))}</p>`;
      renderUnpushed(panel, []);
      say(String(err));
    } finally {
      gitLoading = false;
    }
  }

  const githubSlug = (remote = "") => {
    const value = String(remote).trim().replace(/\.git$/i, "");
    return value.match(/github\.com(?::|\/)([^/]+\/[^/]+)$/i)?.[1] || "";
  };

  async function loadGithubJobs(panel) {
    if (panel.jobsLoading) return;
    const slug = githubSlug(panel.data?.info?.remote);
    if (!slug) { panel.jobs.hidden = true; return; }
    panel.jobsLoading = true;
    try {
      panel.githubStatus ||= await invoke("github_status");
      if (!panel.githubStatus?.authenticated) { panel.jobs.hidden = true; return; }
      const result = await invoke("github_api", { method: "GET", endpoint: `repos/${slug}/actions/runs?per_page=10`, body: null });
      const runs = result?.workflow_runs || [];
      // One useful answer: an active run takes precedence; otherwise show the
      // newest run GitHub returned. Older runs belong on GitHub's own page.
      const run = runs.find((item) => item.status !== "completed") || runs[0];
      panel.jobs.hidden = false;
      if (!run) {
        panel.jobs.innerHTML = `<p class="ws-git-jobs-head">${icon("rocket_launch")}GitHub action</p><small>No runs yet.</small>`;
      } else {
        const running = run.status !== "completed";
        const ok = run.conclusion === "success";
        const glyph = running ? "progress_activity" : ok ? "check_circle" : run.conclusion === "cancelled" ? "cancel" : "error";
        const status = running ? run.status : run.conclusion || "completed";
        panel.jobs.innerHTML = `<p class="ws-git-jobs-head">${icon("rocket_launch")}GitHub action</p>
          <div class="ws-git-job ${running ? "running" : ok ? "ok" : "failed"}">
            <span class="ms">${glyph}</span>
            <span><strong>${esc(run.name || run.display_title || "Workflow")}</strong><small>${esc(String(status).replaceAll("_", " "))} · ${esc(run.head_branch || "")}${running ? "" : ` · ${esc(whenAgo(Date.parse(run.updated_at)))}`}</small></span>
            <button class="ws-mini" type="button" data-git="open-run" data-run-url="${esc(run.html_url || "")}" title="View this run on GitHub" aria-label="View this run on GitHub">${icon("open_in_new")}</button>
          </div>`;
      }
      syncGitHeight(panel);
    } catch (_) {
      panel.jobs.hidden = true;
    } finally { panel.jobsLoading = false; }
  }

  /** Lists what has been saved here but not uploaded yet - one line per
   *  version, newest first. Hidden entirely when there is nothing waiting, so
   *  a repository that is up to date keeps the small panel it had. */
  function renderUnpushed(panel, commits) {
    if (!panel.saved) return;
    panel.saved.hidden = commits.length === 0;
    panel.saved.innerHTML = commits.length
      ? `<p class="ws-git-saved-head">${icon("cloud_off")}${commits.length} saved, waiting to upload</p>
        <ul>${commits.map((c) => `<li title="${esc(c.hash)} - ${esc(c.author)}">
          <span class="ws-git-saved-subject">${esc(c.subject)}</span>
          <span class="ws-git-saved-when">${esc(whenAgo(c.timestamp * 1000))}</span></li>`).join("")}</ul>`
      : "";
    syncGitHeight(panel);
  }

  /** The branch everyone shares. Named `main` or `master` in almost every
   *  repository; without either there is nothing to offer to join work into,
   *  and the row stays away rather than guessing. */
  const mainBranch = (panel) => {
    const named = panel.data?.mainBranch;
    if (named) return named;
    const names = panel.data?.info?.branches || [];
    return names.includes("main") ? "main" : names.includes("master") ? "master" : "";
  };

  /** Says something at length, inside the panel - a merge that could not be
   *  done, or an upload the team's rules turned down. The status bar only has
   *  room for one line and these need more than that. */
  function gitNote(panel, text, kind = "warn") {
    if (!panel.note) return;
    panel.note.hidden = !text;
    panel.note.className = `ws-git-note ws-git-note-${kind}`;
    panel.note.innerHTML = text
      ? `<button class="ws-mini" data-git="note-close" type="button" title="Close">${icon("close")}</button>
        ${String(text).trim().split("\n\n").map((para) => `<p>${esc(para.trim())}</p>`).join("")}`
      : "";
    syncGitHeight(panel);
  }

  /** One button, and which one depends on where the work is: on the shared
   *  branch it offers to move the work off it, and anywhere else it offers to
   *  put the work back on it. */
  function renderBranchLine(panel) {
    const g = panel.data?.info;
    const main = mainBranch(panel);
    if (!panel.branchline) return;
    panel.branchline.hidden = !main;
    panel.branchline.innerHTML = !main ? ""
      : g.branch === main
        ? `<button class="ws-btn" data-git="branch-out" type="button"
            title="Keep working, but somewhere of your own, so ${esc(main)} stays as it is">${icon("alt_route")}Work on this separately</button>`
        : `<button class="ws-btn" data-git="merge-main" type="button"
            title="Join everything you saved on ${esc(g.branch)} into ${esc(main)} and upload it">${icon("merge")}Save this on ${esc(main)}</button>`;
    syncGitHeight(panel);
  }

  /** Asks for a name for the work, suggesting today's date so there is always
   *  something to press Enter on. Anything unsaved comes along to the new
   *  branch, which is the point: this is what people reach for once they are
   *  already half way through a change on the shared branch. */
  function askBranchName(panel) {
    const suggestion = `my-changes-${new Date().toISOString().slice(0, 10)}`;
    panel.branchline.innerHTML = `<form class="ws-git-branch-new">
      <input name="branch" value="${esc(suggestion)}" autocomplete="off" spellcheck="false" aria-label="Name for this work" />
      <div class="ws-git-buttons">
        <button type="submit" class="ws-btn primary" data-git="branch-make">${icon("check")}Create</button>
        <button type="button" class="ws-btn" data-git="branch-cancel">${icon("close")}Cancel</button>
      </div></form>`;
    const input = panel.branchline.querySelector("input");
    input.focus();
    input.select();
    syncGitHeight(panel);
  }

  /** Git will not take spaces or most punctuation in a branch name, and being
   *  told so is no use to someone who was only naming their work. */
  const branchSlug = (name) => name.trim().toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-").replace(/^[-/.]+|[-/.]+$/g, "").slice(0, 60);

  async function makeBranch(panel) {
    const input = panel.branchline.querySelector("input");
    const name = branchSlug(input?.value || "");
    if (!name) { input?.focus(); return say("Give this work a name first"); }
    gitNote(panel, "");
    try {
      const result = await busy("Moving your work to its own branch",
        () => invoke("git_action", { request: { path: projectPath, action: "create_branch", value: name, amend: false } }));
      if (result.ok) say(`You are now working on ${name}`);
      else gitNote(panel, `That branch could not be made.\n\n${result.output}`);
    } catch (err) {
      gitNote(panel, String(err));
    }
    await loadGit(panel);
  }

  /** Joins this branch into the shared one and uploads it. The backend does
   *  the whole sequence and puts everything back if the join fails, so all
   *  that is left here is to show what it said. */
  async function mergeToMain(panel) {
    const main = mainBranch(panel);
    if (!main) return;
    gitNote(panel, "");
    try {
      const result = await busy(`Saving your work on ${main}`,
        () => invoke("git_action", { request: { path: projectPath, action: "merge_into", value: main, amend: false } }));
      if (result.ok) say(result.output);
      else gitNote(panel, result.output);
    } catch (err) {
      gitNote(panel, String(err));
    }
    await loadGit(panel);
  }

  async function gitAct(panel, action, label) {
    if (panel.working) return;
    setGitOperation(panel, true, label, "working", action);
    try {
      const result = await busy(label, () => invoke("git_action", { request: { path: projectPath, action, value: "", amend: false } }));
      say(result.ok ? result.output?.trim().split("\n").pop() || "Done" : String(result.output));
      if (!result.ok) gitNote(panel, result.output || `${label} failed.`);
      setGitOperation(panel, false, result.ok ? `${label} complete` : `${label} failed`, result.ok ? "done" : "error", action);
    } catch (err) {
      say(String(err));
      gitNote(panel, String(err));
      setGitOperation(panel, false, `${label} failed`, "error", action);
    }
    await loadGit(panel);
  }

  function setGitOperation(panel, working, text, kind = "working", action = "") {
    panel.working = working;
    const actionButton = action ? panel.body.querySelector(`button[data-git="${action}"]`) : null;
    if (actionButton) {
      actionButton.dataset.idleHtml ||= actionButton.innerHTML;
      const activeLabels = { save: "Saving", push: "Uploading", pull: "Getting changes" };
      actionButton.innerHTML = working
        ? `${icon("progress_activity")}<span>${activeLabels[action] || text}…</span>`
        : actionButton.dataset.idleHtml;
      actionButton.classList.toggle("working", working);
    }
    for (const control of panel.form.querySelectorAll("button,input")) control.disabled = working;
    for (const button of panel.body.querySelectorAll("button[data-git]")) button.disabled = working;
    panel.operation.hidden = !text;
    panel.operation.className = `ws-git-operation ${kind}`;
    panel.operation.innerHTML = text ? `${icon(working ? "progress_activity" : kind === "error" ? "error" : "check_circle")}<span>${esc(text)}${working ? "…" : ""}</span>` : "";
    clearTimeout(panel.operationTimer);
    if (!working && kind === "done") panel.operationTimer = setTimeout(() => {
      panel.operation.hidden = true;
      syncGitHeight(panel);
    }, 3000);
    syncGitHeight(panel);
  }

  /** Stage everything, commit it, and say plainly that it is not uploaded yet
   *  — the one thing people get wrong about committing. */
  async function saveVersion(panel) {
    const input = panel.form.querySelector("input");
    const message = input.value.trim();
    if (!message) { input.focus(); return say("Say what you changed first"); }
    const changed = panel.data?.info?.changed || [];
    if (!changed.length) return say("There is nothing to save");
    if (panel.working) return;
    setGitOperation(panel, true, `Saving ${changed.length} file${changed.length === 1 ? "" : "s"}`, "working", "save");
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
      setGitOperation(panel, false, "Save complete — ready to upload", "done", "save");
    } catch (err) {
      say(String(err));
      gitNote(panel, String(err));
      setGitOperation(panel, false, "Save failed", "error", "save");
    }
    await loadGit(panel);
  }

  // Editors and agents change this folder without going through the workspace.
  // Keep Git and the top-level file overview close to disk automatically.
  setInterval(() => {
    if (document.hidden) return;
    const git = panels.get("git");
    if (git?.state) loadGit(git, { skipJobs: true });
    const files = panels.get("files");
    if (files?.tree && !files.changedOnly) loadDir(files, files.tree, projectPath, 0, { silent: true });
  }, 1200);
  setInterval(() => {
    if (document.hidden) return;
    const git = panels.get("git");
    if (git?.jobs) loadGithubJobs(git);
  }, 5000);

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

  /* ------------------------------------ shared by the agent panel below */

  /** A conversation's name, minted by the window rather than read back off the
   *  stream, so a terminal can be pointed at a conversation before it has said
   *  anything. `--session-id` requires a UUID. */
  const newSessionId = () => (crypto.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      }));

  /** Enough markdown for what a chat answer actually contains: fenced code,
   *  inline code, bold, and paragraphs. Everything is escaped first, so this
   *  can only ever add the tags it puts in itself. */
  function markdown(text) {
    const fences = [];
    let out = esc(text).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      fences.push(`<pre class="ws-code"${lang ? ` data-lang="${esc(lang)}"` : ""}><button type="button" class="ws-code-copy" data-copy-code title="Copy code" aria-label="Copy code">${
        icon("content_copy")}<span>Copy</span></button><code>${code.replace(/\n$/, "")}</code></pre>`);
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

  const TOOL_ICONS = {
    Read: "description", Edit: "edit", Write: "note_add", Bash: "terminal",
    Glob: "search", Grep: "search", WebFetch: "public", WebSearch: "travel_explore",
    Task: "account_tree", TodoWrite: "checklist",
  };

  // The tools that change a file, and so have a change worth showing under
  // the step rather than a one-line outcome beside it.
  const CHANGE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

  const toolLine = (block) => {
    const input = block.input || {};
    const what = input.file_path || input.path || input.pattern || input.command || input.url || input.description || "";
    const short = String(what).replace(projectPath, "").replace(/^[\\/]/, "");
    return short ? `${block.name} · ${short.slice(0, 120)}` : block.name;
  };

  /* --- the raw stream, kept for when the panel cannot explain itself ----- */

  // Everything the CLI said, before this file made sense of it. The panel is
  // a reading of that stream, and a reading can be wrong or incomplete - a
  // line whose shape nothing here matches simply vanishes. So the stream is
  // kept as it arrived, and the debug view marks the lines this file
  // understood: a long silence is then either lines arriving that nothing
  // renders, or no lines at all, and those are very different faults.
  const RAW_KEEP = 800;

  /** Which lines are one of a run rather than an event of their own. Text and
   *  thinking arrive a token at a time, and a thousand of them would push
   *  every line worth reading out of the record - so a run of them is one row
   *  that counts itself, and the last one stands for the rest. */
  const deltaRun = (line) =>
    line.includes('"text_delta"') ? "text"
    : line.includes('"thinking_delta"') ? "thinking"
    : line.includes('"input_json_delta"') ? "arguments"
    // Cursor streams a whole message envelope per token rather than a delta,
    // and closes each message by repeating it in full with a model_call_id -
    // so the repeat is an event of its own, not one more of the run.
    : line.includes('"thinking"') && line.includes('"subtype":"delta"') ? "thinking"
    : line.includes('"type":"assistant"') && line.includes('"timestamp_ms"')
      && !line.includes('"model_call_id"') ? "text"
    : "";

  function recordRaw(tab, kind, line) {
    if (!tab.raw) tab.raw = [];
    const text = String(line).slice(0, 4000);
    const since = tab.startedAt ? Date.now() - tab.startedAt : 0;
    const run = kind === "out" ? deltaRun(text) : "";
    const last = tab.raw[tab.raw.length - 1];
    if (run && last?.run === run) {
      last.repeat += 1;
      last.line = text;
      last.until = since;
      if (tab.debugOpen) markDebugDirty(tab);
      return;
    }
    tab.raw.push({ at: Date.now(), since, until: since, kind, run, repeat: 1, line: text, tag: "" });
    if (tab.raw.length > RAW_KEEP) tab.raw.splice(0, tab.raw.length - RAW_KEEP);
    if (tab.debugOpen) markDebugDirty(tab);
  }

  /** Names what this file did with the line just recorded. A line left
   *  untagged is one nothing here matched - which is the whole point. */
  function tagRaw(tab, tag, quiet = false) {
    const last = tab.raw?.[tab.raw.length - 1];
    if (last && !last.tag) {
      last.tag = tag;
      last.quiet = quiet;
    }
    if (tab.debugOpen) markDebugDirty(tab);
  }

  /* --- what a turn is doing, while it is doing it ------------------------ */

  // The CLI's own phase names, said the way the status bar says everything
  // else. An unknown one is dropped rather than shown raw.
  // How much the agent may do without being asked.
  //
  // Nothing here can answer a permission prompt: the CLI is driven over a
  // pipe, and a pipe has nobody to ask. So the mode is not a preference, it
  // is the whole of what the chat is allowed to do - anything that would have
  // prompted is refused instead, and the way to approve it is the terminal.
  // `auto` is the default because it is the mode that judges each tool on its
  // own merits rather than refusing everything that is not an edit.
  const PERMISSION_MODES = {
    auto: {
      label: "Automatic",
      short: "deciding for itself",
      blurb: "Judges each tool on its own merits. The most a conversation here can do without a terminal.",
      icon: "auto_awesome",
    },
    acceptEdits: {
      label: "Edits only",
      short: "edits accepted, the rest refused",
      blurb: "Files may be changed. Anything else that would ask - a command, a fetch - is refused instead.",
      icon: "edit",
    },
    plan: {
      label: "Plan only",
      short: "planning, no changes",
      blurb: "Reads and reasons, changes nothing. Good for asking what it would do before letting it.",
      icon: "checklist",
    },
    dontAsk: {
      label: "Refuse anything unapproved",
      short: "never asks, refuses instead",
      blurb: "Every tool that is not already allowed by your settings is refused outright.",
      icon: "lock",
    },
  };

  const DEFAULT_PERMISSION_MODE = "auto";
  const permissionMode = (tab) => (PERMISSION_MODES[tab.mode] ? tab.mode : DEFAULT_PERMISSION_MODE);

  const STATUS_PHASES = {
    requesting: "Asking the model",
    thinking: "Thinking",
    tool_use: "Running a tool",
    compacting: "Compacting the conversation",
    retrying: "Retrying",
    waiting: "Waiting",
  };

  /** A tool result's content, whether it is a bare string or the list of
   *  blocks a tool that returned images or structure sends back. */
  const resultText = (content) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.filter((b) => b?.type === "text").map((b) => b.text || "").join("\n");
  };

  /** The first line of what a tool said back, short enough to sit at the end
   *  of the step it belongs to. */
  const resultSummary = (text) => {
    const first = String(text).split("\n").map((l) => l.trim()).find(Boolean) || "";
    return first.length > 90 ? `${first.slice(0, 90)}…` : first;
  };

  const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

  /** How a tool went, said in its own terms.
   *
   *  The CLI reports what a tool returned as well as its text, and the count
   *  is the useful half: the first line of a file says nothing about a Read,
   *  where '34 lines' says all of it. The text is what stands in when there
   *  is no count - which is most of what a command prints. */
  function toolOutcome(result, text) {
    if (result && typeof result === "object") {
      if (Number.isFinite(result.numFiles) && result.numFiles > 0) return plural(result.numFiles, "file");
      if (Number.isFinite(result.totalMatches)) return plural(result.totalMatches, "match", "matches");
      if (Number.isFinite(result.totalLines)) return plural(result.totalLines, "line");
      if (Number.isFinite(result.file?.numLines)) return plural(result.file.numLines, "line");
    }
    return resultSummary(text);
  }

  // A change is only worth showing the lines of; a file written whole is
  // worth showing the top of. Beyond this it is a file, not a change, and
  // belongs in an editor rather than in a chat log.
  const CHANGE_KEEP = 400;

  /** The lines an edit changed, read off the arguments the tool was called
   *  with. Written as a diff - what left, what arrived - because that is the
   *  only form in which three lines say anything useful. */
  function changeFromInput(name, input = {}) {
    const lines = [];
    const push = (sign, text) => {
      for (const line of String(text ?? "").split(/\r?\n/)) lines.push({ sign, text: line.slice(0, 400) });
    };
    if (name === "Write") push("+", input.content);
    else if (name === "NotebookEdit") push("+", input.new_source);
    else {
      // MultiEdit passes its edits in a list; Edit is the same shape, once.
      for (const edit of Array.isArray(input.edits) ? input.edits : [input]) {
        if (typeof edit?.old_string === "string") push("-", edit.old_string);
        if (typeof edit?.new_string === "string") push("+", edit.new_string);
      }
    }
    return lines.length > CHANGE_KEEP ? lines.slice(0, CHANGE_KEEP) : lines;
  }

  /** The same lines, but as the CLI itself worked them out: a real patch, with
   *  the context around the change. Better than reading the arguments when it
   *  is there, which is whenever an edit actually landed. */
  function changeFromPatch(result) {
    const hunks = result && typeof result === "object" ? result.structuredPatch : null;
    if (!Array.isArray(hunks) || !hunks.length) return null;
    const lines = [];
    for (const hunk of hunks) {
      for (const line of hunk?.lines || []) {
        const text = String(line);
        lines.push({ sign: "+-".includes(text[0]) ? text[0] : " ", text: text.slice(1, 401) });
        if (lines.length >= CHANGE_KEEP) return lines;
      }
    }
    return lines.length ? lines : null;
  }

  /** Opens a step, or fills in the arguments of one already open.
   *
   *  A tool is announced twice - once as its block opens, with only a name,
   *  and again in the finished assistant message with its arguments - and the
   *  same step has to serve both, or every tool would appear twice. */
  function beginToolTurn(tab, block) {
    const existing = block.id && tab.turns.find((t) => t.role === "tool" && t.id === block.id);
    const line = toolLine(block);
    // The arguments only arrive with the finished message, so the change is
    // read on that second pass rather than when the step opened empty.
    const change = CHANGE_TOOLS.has(block.name) && block.input ? changeFromInput(block.name, block.input) : null;
    if (existing) {
      if (line) existing.text = line;
      if (change?.length && !existing.patched) existing.change = change;
      return existing;
    }
    const turn = {
      role: "tool",
      id: block.id || "",
      icon: TOOL_ICONS[block.name] || "build",
      text: line || block.name || "Tool",
      state: "run",
      detail: "",
      change: change?.length ? change : null,
    };
    tab.turns.push(turn);
    return turn;
  }

  /** Marks a step finished, and says in one line what came back. */
  function finishToolTurn(tab, id, isError, text, result) {
    const turn = id && tab.turns.find((t) => t.role === "tool" && t.id === id);
    if (!turn) return false;
    turn.state = isError ? "err" : "ok";
    // A failure is always its own words; only a success is worth counting.
    turn.detail = isError ? resultSummary(text) : toolOutcome(result, text);
    const patch = isError ? null : changeFromPatch(result);
    if (patch) { turn.change = patch; turn.patched = true; }
    return true;
  }

  /** What a finished turn cost, on one line under the answer. */
  function turnReceipt(msg) {
    const bits = [];
    const ms = Number(msg.duration_ms ?? msg.duration_api_ms ?? 0);
    if (ms > 0) bits.push(ms >= 60000 ? `${Math.round(ms / 6000) / 10}m` : `${Math.round(ms / 100) / 10}s`);
    const used = msg.usage || {};
    const out = Number(used.output_tokens || 0);
    if (out) bits.push(`${out.toLocaleString()} tokens out`);
    const cost = Number(msg.total_cost_usd || 0);
    if (cost) bits.push(`$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`);
    return bits.join(" · ");
  }

  /** Everything a running turn holds, put down. Called from every end event,
   *  so a turn that dies without a result still stops looking alive. */
  function endAgentTurn(tab) {
    tab.streaming = null;
    tab.thought = null;
    tab.running = false;
    tab.phase = "";
    for (const turn of tab.turns) {
      if (turn.role === "tool" && turn.state === "run") turn.state = "";
    }
  }

  function growAgentInput(tab) {
    tab.input.style.height = "auto";
    if (tab.input.value) tab.input.style.height = `${Math.min(160, tab.input.scrollHeight)}px`;
  }

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
      sessionsCmd: "claude_sessions",
      transcriptCmd: "claude_transcript",
      mintSession: true,
      models: [
        { id: "sonnet", label: "Sonnet", note: "Recommended for everyday coding" },
        { id: "opus", label: "Opus", note: "Most capable, uses more of your allowance" },
        { id: "haiku", label: "Haiku", note: "Fastest for small tasks" },
      ],
      defaultModel: "sonnet",
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
      sessionsCmd: "cursor_sessions",
      transcriptCmd: "cursor_transcript",
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
      sessionsCmd: "copilot_sessions",
      transcriptCmd: "copilot_transcript",
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
      sessionsCmd: "codex_sessions",
      transcriptCmd: "codex_transcript",
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
      sessionsCmd: "gemini_sessions",
      transcriptCmd: "gemini_transcript",
      mintSession: false,
      installHint: `WinT doesn't ship it and holds no key for it. You install Gemini CLI and sign in as
           yourself; this panel gives it somewhere to talk.`,
    },
    qwen: {
      id: "qwen",
      label: "Qwen",
      product: "Local Qwen coding agent",
      icon: "memory",
      placeholder: "Ask local Qwen to work on this projectâ€¦",
      statusCmd: "assistant_status",
      sendCmd: "assistant_chat",
      cancelCmd: "assistant_chat_cancel",
      installCmd: "assistant_pull",
      terminalCmd: null,
      localModel: "qwen2.5-coder-7b-q4",
      localModels: [
        { id: "qwen2.5-coder-7b-q4", label: "Qwen2.5-Coder 7B · 4.7 GB · 8 GB RAM" },
        { id: "qwen3-coder-30b-a3b-q4", label: "Qwen3-Coder 30B-A3B · 18.6 GB · 24 GB RAM" },
      ],
      localHistory: true,
      mintSession: false,
      installHint: `Runs privately through WinT's existing llama.cpp runtime. Choose the 4.7 GB model for an 8 GB machine, or the stronger 18.6 GB model when 24 GB of memory is available.`,
    },
  };

  // Settings owns local model downloads and the user's active-model choice.
  // A Qwen workspace follows that choice when it is one of the coding models
  // this staged agent supports; otherwise it uses the smaller default.
  const workspaceLocalModel = (spec) => {
    if (!spec?.localModel) return "";
    try {
      const selected = JSON.parse(localStorage.getItem("wint.assistant.v1") || "{}").model;
      if (spec.localModels?.some((model) => model.id === selected)) return selected;
    } catch {}
    return spec.localModel;
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
      model: AGENTS[kind].defaultModel || "",
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

  // Every role that is *not* something the agent said in prose. Written as
  // what to exclude because the roles that are prose are one per agent kind,
  // and a new kind should not have to be added here to be readable.
  const NOT_SAID = new Set(["you", "tool", "error", "denied", "notice", "thought"]);
  const isSaid = (turn) => !NOT_SAID.has(turn.role);

  /** Text long enough that showing all of it would bury everything around it:
   *  a pasted file, a long stretch of thinking. */
  const isLong = (text, lines, chars) => text.split("\n").length > lines || text.length > chars;

  /** A block that is clamped to its first few lines until it is opened. The
   *  key is the turn's index, which never shifts - turns are only appended. */
  function clampHtml(key, tab, body, openLabel, shutLabel) {
    const open = tab.openTurns?.has(key);
    return `${open ? body : `<div class="ws-clamp">${body}</div>`}<button type="button" class="ws-steps-more" data-more="${key}">${
      icon(open ? "unfold_less" : "unfold_more")}${open ? shutLabel : openLabel}</button>`;
  }

  /** How much of an answer has been written out so far. Every answer starts at
   *  nothing and is revealed towards its full text, so a reply that arrives in
   *  one piece reads the same way as one that arrives token by token. */
  const revealed = (turn) => turn.text.slice(0, turn.shown === undefined ? 0 : turn.shown);

  function agentTurnHtml(turn, key, tab) {
    if (turn.role === "you") {
      // A pasted file is a wall between the question above it and the answer
      // below, so anything this long is folded down to its opening lines.
      const body = `<div class="ws-turn-body">${esc(turn.text)}</div>`;
      const lines = turn.text.split("\n").length;
      return `<div class="ws-turn you">${
        isLong(turn.text, 12, 900)
          ? clampHtml(key, tab, body, `Show all ${lines} lines`, "Show less")
          : body}</div>`;
    }
    if (turn.role === "error") {
      return `<div class="ws-turn error">${icon("error")}<span>${esc(turn.text)}</span></div>`;
    }
    if (turn.role === "notice") {
      return `<div class="ws-turn denied">${icon("info")}<span>${esc(turn.text)}</span></div>`;
    }
    if (turn.role === "denied") {
      return `<div class="ws-turn denied">${icon("lock")}
        <span>${esc(turn.text)}</span>
        <button type="button" class="ws-btn tiny" data-chat="terminal">${icon("terminal")}Approve in a terminal</button>
      </div>`;
    }
    if (turn.role === "thought") {
      // Thinking the CLI counted but would not send the text of. On its own -
      // no steps around it to sit with - it is still worth its one line.
      if (!turn.text.trim()) return turn.tokens ? `<div class="ws-steps">${toolHtml(turn, key, tab)}</div>` : "";
      const body = `<div class="ws-turn-body">${markdown(turn.text)}</div>`;
      return `<div class="ws-turn thought">${icon("neurology")}${
        isLong(turn.text, 6, 400) ? clampHtml(key, tab, body, "Show the whole thought", "Show less") : body}</div>`;
    }
    const text = revealed(turn);
    if (!text) return "";
    const live = text.length < turn.text.length ? " data-live" : "";
    return `<div class="ws-turn claude ${esc(turn.role)}"${live}><div class="ws-turn-body">${markdown(text)}</div></div>`;
  }

  /** What an edit did to a file, as the few lines that changed. A step saying
   *  only 'Edit · workspace.js' is a step whose change nobody can see without
   *  leaving the panel, so the change comes with it - three lines of it, and
   *  the rest a click away. */
  function changeHtml(turn, key, tab) {
    const lines = turn.change;
    if (!lines?.length) return "";
    const open = tab.openChanges?.has(key);
    // Unopened, only the lines that actually changed are worth the room -
    // context lines are there to read the change by, not to preview it.
    const preview = lines.filter((line) => line.sign !== " ").slice(0, 3);
    const shown = open ? lines : preview;
    const rest = lines.length - shown.length;
    const body = shown.map((line) => `<code class="${
      line.sign === "+" ? "add" : line.sign === "-" ? "del" : "same"}">${esc(`${line.sign} ${line.text}`)}</code>`).join("");
    const more = rest > 0 || open
      ? `<button type="button" class="ws-steps-more" data-change="${esc(key)}">${icon(open ? "unfold_less" : "unfold_more")}${
          open ? "Show less" : `and ${rest.toLocaleString()} more line${rest === 1 ? "" : "s"}`}</button>`
      : "";
    return `<div class="ws-step-change">${body}${more}</div>`;
  }

  /** One step: what it is doing, and - once it is over - how it went. A step
   *  that only ever says it started cannot be told from one that hung. */
  function toolHtml(turn, key, tab) {
    // Thinking whose text the CLI withheld: the count is all there is, and it
    // is still the difference between a silent minute and a wasted one.
    if (turn.role === "thought") {
      return `<div class="ws-turn tool thought-step">${icon("neurology")}<span class="ws-step-what">Thought for ${
        turn.tokens.toLocaleString()} tokens</span><em class="ws-step-detail">text withheld</em></div>`;
    }
    const state = turn.state === "run" ? " running" : turn.state === "err" ? " failed" : turn.state === "ok" ? " done" : "";
    const mark = turn.state === "run"
      ? '<span class="ws-step-run"></span>'
      : turn.state === "err" ? icon("error") : turn.state === "ok" ? icon("check") : "";
    const detail = turn.detail ? `<em class="ws-step-detail">${esc(turn.detail)}</em>` : "";
    const line = `<div class="ws-turn tool${state}">${icon(turn.icon || "build")}<span class="ws-step-what">${
      esc(turn.text)}</span>${detail}${mark}</div>`;
    const change = changeHtml(turn, key, tab);
    return change ? `<div class="ws-step-with-change">${line}${change}</div>` : line;
  }

  /** A run of steps between two answers. Only the three most recent are worth
   *  reading - they are what the agent is doing now - so the rest fold behind
   *  a line that opens them in place. */
  function agentStepsHtml(steps, key, tab) {
    const open = tab.openSteps?.has(key);
    // Folded, the three lines go to the tools: what is being done beats how
    // much was thought before doing it. The thinking is still there, counted
    // into the fold and shown the moment the run is opened - and the one
    // happening right now is on the line below the log anyway.
    const tools = steps.filter((step) => step.turn.role === "tool");
    const shown = open || !tools.length ? steps : tools.slice(-3);
    const folded = steps.length - shown.length;
    const more = folded > 0 || open
      ? `<button type="button" class="ws-steps-more" data-steps="${key}">${icon("expand_more")}${
          open ? "Show fewer" : `and ${folded.toLocaleString()} more`}</button>`
      : "";
    return `<div class="ws-steps${open ? " open" : ""}">${more}${
      shown.map((step) => toolHtml(step.turn, step.key, tab)).join("")}</div>`;
  }

  /** The line that says the turn is still running. It is drawn from the turn
   *  being in flight rather than from text arriving, so it is there in the
   *  moment it matters most: right after the question was sent. */
  function agentThinkingHtml(tab) {
    const last = tab.turns[tab.turns.length - 1];
    // Keep this line for the whole turn, including while prose is streaming.
    // The animated caret says text is arriving, but it does not answer the
    // more useful question of what the agent is doing right now.
    const running = [...tab.turns].reverse().find((t) => t.role === "tool" && t.state === "run");
    const writing = last && isSaid(last) && revealed(last).length < last.text.length;
    const label = tab.phase
      || (running ? running.text
        : tab.thought ? "Thinking"
        : writing || tab.streaming ? "Writing an answer"
        : last?.role === "tool" ? "Working"
        : "Thinking");
    const secs = Math.round((Date.now() - (tab.startedAt || Date.now())) / 1000);
    // The token count is the only thing that moves while it thinks, so it goes
    // beside the clock rather than nowhere.
    const thought = tab.thinkingTokens ? `${tab.thinkingTokens.toLocaleString()} thinking tokens · ` : "";
    return `<div class="ws-turn thinking"><span class="ws-dots"><i></i><i></i><i></i></span>
      <span class="ws-thinking-what">${esc(label)}…</span><span class="ws-thinking-for">${thought}${secs}s</span></div>`;
  }

  /** A turn that draws nothing at all: a thought the CLI never sent the text
   *  of and never counted, an answer whose first token has not been revealed
   *  yet. It must not break a run of steps in two - one of these between every
   *  pair of tools is what turned a fold of ten steps into ten unfolded ones. */
  function drawsNothing(turn) {
    if (turn.role === "thought") return !turn.text.trim() && !turn.tokens;
    if (NOT_SAID.has(turn.role)) return false;
    return !revealed(turn);
  }

  /** Whether a turn belongs inside the run of steps being collected rather
   *  than after it. Thinking sits with the steps it happened between - it is
   *  the same work - unless its text arrived, which is worth reading on its
   *  own. */
  const joinsRun = (turn) => turn.role === "tool" || drawsNothing(turn)
    || (turn.role === "thought" && !turn.text.trim());

  function agentLogHtml(tab) {
    const parts = [];
    for (let i = 0; i < tab.turns.length; i++) {
      const turn = tab.turns[i];
      if (!joinsRun(turn)) {
        if (!drawsNothing(turn)) parts.push(agentTurnHtml(turn, i, tab));
        continue;
      }
      // Everything from here until something the agent said out loud is one
      // run, whatever mixture of steps and silent thinking it is made of.
      const steps = [];
      let last = i - 1;
      for (let at = i; at < tab.turns.length && joinsRun(tab.turns[at]); at++) {
        if (drawsNothing(tab.turns[at])) continue;
        steps.push({ turn: tab.turns[at], key: tab.turns[at].id || `${i}:${at}` });
        last = at;
      }
      if (steps.length) parts.push(agentStepsHtml(steps, i, tab));
      if (last > i) i = last;
    }
    if (isAgentBusy(tab)) parts.push(agentThinkingHtml(tab));
    else if (tab.receipt) parts.push(`<div class="ws-turn receipt">${esc(tab.receipt)}</div>`);
    return parts.join("");
  }

  /** Whether a turn is still in flight. Not the same question as whether text
   *  is arriving: the gap between a tool finishing and the next token is the
   *  longest silence in a turn, and the one that most needs a line saying so. */
  function isAgentBusy(tab) { return Boolean(tab.running || tab.streaming); }

  /** The elapsed second on the thinking line, without redrawing the log for
   *  it - a turn that is only waiting produces no events of its own. */
  function syncThinkingClock(panel, tab) {
    if (isAgentBusy(tab) && !tab.clock) {
      tab.clock = setInterval(() => {
        const el = tab.log?.querySelector(".ws-thinking-for");
        if (el) {
          const thought = tab.thinkingTokens ? `${tab.thinkingTokens.toLocaleString()} thinking tokens · ` : "";
          el.textContent = `${thought}${Math.round((Date.now() - (tab.startedAt || Date.now())) / 1000)}s`;
        }
      }, 1000);
    } else if (!isAgentBusy(tab) && tab.clock) {
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

  /** The raw stream, drawn. Newest at the bottom, each line stamped with how
   *  far into the turn it arrived - a gap in that column is the silence the
   *  panel could not explain - and marked with what this file made of it.
   *  A line with no mark is one nothing here matched. */
  function renderDebug(tab) {
    if (!tab.debug || !tab.debugOpen) return;
    const rows = tab.raw || [];
    // Only lines nothing matched at all count as missing. A line this file
    // deliberately passes over - the bookkeeping around a message, a signature
    // - is not a hole in the panel, and counting it as one buries the ones
    // that are.
    const unknown = rows.filter((r) => r.kind === "out" && !r.tag).length;
    const body = tab.debug.querySelector(".ws-debug-lines");
    tab.debug.querySelector(".ws-debug-count").textContent =
      `${rows.length} line${rows.length === 1 ? "" : "s"}${unknown ? ` · ${unknown} not rendered` : ""}`;
    const stick = body.scrollTop + body.clientHeight >= body.scrollHeight - 40;
    body.innerHTML = rows.length
      ? rows.map((r) => `<div class="ws-debug-row ${r.kind}${r.tag ? (r.quiet ? " quiet" : "") : " unknown"}">` +
          `<i>${debugWhen(r)}</i>` +
          (r.tag ? `<b>${esc(r.tag)}${r.repeat > 1 ? ` ×${r.repeat}` : ""}</b>` : '<b class="none">not rendered</b>') +
          `<code>${esc(r.line)}</code></div>`).join("")
      : '<div class="ws-debug-empty">Nothing yet. Ask something, and every line the CLI sends lands here.</div>';
    if (stick) body.scrollTop = body.scrollHeight;
  }

  /** When a line arrived, counted from the question. A run of tokens spans a
   *  stretch of the turn rather than a moment, and the stretch is the point:
   *  the gap between one row's end and the next row's start is the silence. */
  const debugWhen = (r) => {
    const at = (r.since / 1000).toFixed(1);
    return r.repeat > 1 ? `${at}–${(r.until / 1000).toFixed(1)}s` : `${at}s`;
  };

  // Lines arrive one per token, so the view is redrawn on a frame like every
  // other region rather than once per line.
  const dirtyDebug = new Set();
  let debugQueued = false;
  function markDebugDirty(tab) {
    dirtyDebug.add(tab);
    if (debugQueued) return;
    debugQueued = true;
    requestAnimationFrame(() => {
      debugQueued = false;
      const tabs = [...dirtyDebug];
      dirtyDebug.clear();
      for (const t of tabs) renderDebug(t);
    });
  }

  /** The record as text, for pasting into a bug report. */
  const debugText = (tab) => (tab.raw || [])
    .map((r) => `[${debugWhen(r)} ${r.kind}] ${r.tag || "(not rendered)"}${
      r.repeat > 1 ? ` ×${r.repeat}` : ""}\n${r.line}`)
    .join("\n");

  /** The windows the CLI counts usage against, in the order they run out. */
  const LIMIT_WINDOWS = { five_hour: "5-hour", seven_day: "7-day", seven_day_opus: "7-day Opus", opus_week: "Opus week" };

  /** When a window comes back, said the shortest way that is still true: a
   *  clock for today, a day and a clock for anything further out. */
  function limitResets(at) {
    const when = Number(at) ? new Date(Number(at) * 1000) : null;
    if (!when || Number.isNaN(when.getTime())) return "";
    const clock = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const soon = when.getTime() - Date.now() < 20 * 60 * 60 * 1000;
    return soon ? `resets ${clock}` : `resets ${when.toLocaleDateString([], { weekday: "short" })} ${clock}`;
  }

  /** How much of the account's usage this conversation has spent, as a bar
   *  that is rewritten in place. The CLI says this on nearly every turn, so
   *  saying it in the log meant saying the same sentence again and again -
   *  and a percentage that only ever grows is worth a meter, not a message. */
  function renderAgentLimit(tab) {
    if (!tab.limitBar) return;
    const info = tab.limit;
    const unified = info?.unifiedWindows;
    const windows = unified
      ? Object.entries(unified).map(([key, w]) => ({ key, ...w }))
      : info ? [{ key: info.rateLimitType || "five_hour", utilization: info.utilization, resetsAt: info.resetsAt }] : [];
    if (!windows.length) { tab.limitBar.hidden = true; return; }
    const order = Object.keys(LIMIT_WINDOWS);
    windows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    const worst = Math.max(...windows.map((w) => Number(w.utilization) || 0));
    const out = info.status === "rejected" || worst >= 1;
    // The CLI's own word for it beats the number: it is what decides whether
    // the next turn starts.
    const warn = !out && (worst >= 0.8 || (info.status && info.status !== "allowed"));
    tab.limitBar.className = `ws-agent-limit${out ? " out" : warn ? " warn" : ""}`;
    tab.limitBar.hidden = false;
    tab.limitBar.innerHTML = windows.map((w) => {
      const pct = Math.round(Math.min(1, Math.max(0, Number(w.utilization) || 0)) * 100);
      return `<span class="ws-limit-w">
        <span class="ws-limit-k">${esc(LIMIT_WINDOWS[w.key] || String(w.key).replace(/_/g, " "))}</span>
        <span class="ws-limit-meter"><i style="width:${pct}%"></i></span>
        <span class="ws-limit-v">${pct}%</span>
        <span class="ws-limit-r">${esc(limitResets(w.resetsAt))}</span>
      </span>`;
    }).join("") + (info.isUsingOverage ? '<span class="ws-limit-note">on extra usage</span>' : "");
  }

  function toggleDebug(panel, tab) {
    tab.debugOpen = !tab.debugOpen;
    tab.debug.hidden = !tab.debugOpen;
    if (tab.debugOpen) renderDebug(tab);
    renderAgentTabs(panel);
  }
  // Every tab keeps its own log/ask/input, mounted once when the tab was
  // created and never rebuilt - only this tab's own innerHTML changes here,
  // so a conversation streaming in a background tab does not touch the one
  // on screen, and switching tabs does not lose scroll position or a draft.
  function renderAgentTab(panel, tab) {
    const spec = AGENTS[tab.kind];
    if (!spec || !tab.log) return;

    const busy = isAgentBusy(tab);
    syncThinkingClock(panel, tab);
    // The box stays live while a turn runs. A new question interrupts that
    // turn and starts at once, so its wording must not imply a hidden queue.
    tab.input.placeholder = busy ? `Interrupt ${spec.label} with a new message` : spec.placeholder;
    tab.ask.hidden = !tab.status?.installed;
    const send = tab.ask.querySelector(".ws-chat-send");
    send.hidden = false;
    send.classList.toggle("interrupting", busy);
    send.title = busy ? "Interrupt and send now (Enter)" : "Send (Enter)";
    tab.ask.querySelector(".ws-chat-stop").hidden = !busy;
    if (tab.modelPicker) {
      tab.modelPicker.hidden = tab.kind !== "claude";
      tab.modelSelect.disabled = tab.started || busy;
      tab.modelSelect.value = tab.model;
      tab.modelPicker.querySelector("small").textContent = tab.started
        ? `${AGENTS.claude.models.find((model) => model.id === tab.model)?.label || tab.model} is locked for this session`
        : "Choose before you send the first message";
    }

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
      if (spec.localModel) {
        const model = status.models?.find((item) => item.name === workspaceLocalModel(spec));
        status = {
          installed: Boolean(status.available && model),
          path: "",
          version: model?.displayName || model?.name || status.version || "",
        };
      }
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
    if (isAgentBusy(tab)) {
      say(`Wait for ${spec.label} to finish, or stop it before opening the same conversation in a terminal`);
      return;
    }

    // One terminal at a time, and it belongs to a conversation. Showing the
    // one already open was right only when it was this tab's - for any other
    // it silently handed over somebody else's session.
    const open = agentOverlay.session;
    if (open && open.tabId === tab.id) {
      showAgentOverlay(tab);
      open.view.focus();
      return;
    }
    if (open) await closeAgentTerminal();

    let launch;
    try {
      if (tab.kind === "claude") {
        const command = await invoke(spec.terminalCmd, { session: tab.session || null, model: tab.model || null });
        launch = { command, session: tab.session || null };
      } else if (tab.kind === "cursor") {
        launch = await invoke(spec.terminalCmd, { cwd: projectPath, session: tab.session || null, login });
      } else {
        launch = await invoke(spec.terminalCmd, { session: tab.session || null, login });
      }
    } catch (err) {
      return say(String(err));
    }

    showAgentOverlay(tab);

    try {
      const info = await busy("Opening agent in a terminal", () => invoke("term_open", {
        args: { projectPath, projectName, command: launch.command || launch },
      }));
      const view = new window.TermView(agentOverlay.host, info.id);
      agentOverlay.session = { id: info.id, view, tabId: tab.id, kind: tab.kind };
      await view.attach();
      view.fit();
      // Nothing was giving it the keyboard, so it opened as something to look
      // at rather than something to type into - and approving a command is
      // the one thing this window exists to let you do.
      view.focus();

      // A terminal that cannot be resized with the window is a terminal drawn
      // at whatever size it happened to open at.
      agentOverlay.watcher = new ResizeObserver(() => view.fit());
      agentOverlay.watcher.observe(agentOverlay.host);

      // Quitting the CLI is how a conversation in a terminal ends, so that is
      // the moment to come back to the chat rather than leaving a dead screen
      // with a close button on it.
      view.onExit = () => {
        agentOverlay.note.textContent = `${spec.label} has finished. Closing…`;
        setTimeout(() => {
          if (agentOverlay.session?.id === info.id) closeAgentTerminal();
        }, 900);
      };
      // A shell that died before this line was reached never fires the event,
      // so the state `attach` already read is checked as well.
      if (view.exited) view.onExit();

      // A conversation opened in a terminal must be resumed in the chat.
      if (tab.kind === "claude") tab.started = true;
      if (launch?.session) tab.session = launch.session;
      saveAgentTabs(panel);
      say(`${spec.label} is open in a terminal`);
    } catch (err) {
      agentOverlay.host.innerHTML = `<div class="ws-term-error">${esc(String(err))}</div>`;
      say(String(err));
    }
  }

  /** Puts the terminal on screen and says whose it is.
   *
   *  The header has to name the agent and the way back, because this window
   *  covers everything and there is nothing else on it to read. */
  function showAgentOverlay(tab) {
    const spec = AGENTS[tab.kind];
    agentOverlay.title.textContent = spec.product;
    agentOverlay.note.textContent = tab.started
      ? "The same conversation, in its own interface. Approve what it needs, then close this and carry on in the chat."
      : "Its own interface. Anything you do here is in the conversation the chat picks up.";
    agentOverlay.el.hidden = false;
    hideBrowser();
  }
  async function closeAgentTerminal() {
    const open = agentOverlay.session;
    agentOverlay.session = null;
    agentOverlay.watcher?.disconnect();
    agentOverlay.watcher = null;
    // The view holds a place in the module's map of live terminals; dropping
    // the element without saying so leaves it there being painted into.
    open?.view?.dispose();
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
    el.innerHTML = `<header>${icon("auto_awesome")}<strong class="ws-agent-full-title">Agent</strong>
        <span class="ws-agent-note"></span>
        <button type="button" class="ws-btn" data-agent-full="close">${icon("close")}Back to the chat</button>
      </header>
      <div class="term-host"></div>`;
    document.body.appendChild(el);
    el.querySelector("[data-agent-full=close]").addEventListener("click", closeAgentTerminal);
    // Clicking anywhere on the terminal gives it the keyboard, the way
    // clicking a terminal anywhere else does.
    el.querySelector(".term-host").addEventListener("mousedown", () => agentOverlay.session?.view.focus());
    return {
      el,
      host: el.querySelector(".term-host"),
      note: el.querySelector(".ws-agent-note"),
      title: el.querySelector(".ws-agent-full-title"),
      session: null,
      watcher: null,
    };
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
    // An install belongs to a kind, not to a conversation: the CLI it puts on
    // the machine is the same one every tab of that kind runs, and the events
    // it reports back say only which window asked. So the tab that asked is
    // remembered here, because the events cannot say.
    panel.installing.set(tab.kind, tab.id);
    try {
      const spec = AGENTS[tab.kind];
      const args = spec.localModel ? { model: workspaceLocalModel(spec) } : { window: label };
      await busy(`Installing ${spec.label}`, () => invoke(spec.installCmd, args));
    } catch (err) {
      if (pre) pre.textContent += `\n${err}`;
      say(String(err));
    }
  }

  /** Sends what is in the box. A message submitted during a running turn
   *  replaces that turn immediately: these CLIs consume one closed stdin per
   *  turn, so interruption plus a resumed turn is their live follow-up path. */
  async function sendToAgent(panel, tab) {
    const spec = AGENTS[tab.kind];
    const text = tab.input.value.trim();
    if (!spec || !text) return;
    if (agentOverlay.session?.tabId === tab.id) {
      say(`Close the ${spec.label} terminal before continuing the same conversation here`);
      return;
    }
    const replacing = isAgentBusy(tab);
    const replacedRun = tab.runId || tab.id;
    tab.input.value = "";
    growAgentInput(tab);
    if (replacing) {
      endAgentTurn(tab);
      tab.turns.push({ role: "tool", icon: "stop_circle", text: "Interrupted by your next message", state: "err" });
    }
    tab.turns.push({ role: "you", text });

    tab.startedAt = Date.now();
    tab.running = true;
    tab.receipt = "";
    tab.phase = `Starting ${spec.label}`;
    tab.thought = null;
    tab.deniedSomething = false;
    tab.sawDeltas = false;
    tab.thinkingTokens = 0;
    tab.localSteps = new Map();
    // Every run has its own routing id. Output from the process just replaced
    // can still be crossing the event queue; it must not finish or write into
    // the new turn that is already on screen.
    tab.runId = `${tab.id}:${newSessionId()}`;
    // The record starts fresh with the question, so what is kept is always
    // this turn rather than an afternoon of them.
    tab.raw = [];
    recordRaw(tab, "meta", `sent · ${spec.label} · session ${tab.session || "new"} · ${tab.started ? "resume" : "create"} · ${projectPath}`);
    tagRaw(tab, "the question");
    // The bubble is not opened here any more: a turn that starts by running a
    // tool would otherwise leave an empty answer sitting above its own steps.
    tab.streaming = null;
    renderAgentTab(panel, tab);
    renderAgentTabs(panel);

    try {
      if (replacing) {
        await invoke(spec.cancelCmd, spec.localModel ? undefined : { tab: replacedRun });
      }
      if (spec.localModel) {
        const history = tab.turns
          .filter((turn) => turn.role === "you" || isSaid(turn))
          .slice(0, -1)
          .map((turn) => `${turn.role === "you" ? "User" : "Assistant"}: ${turn.text}`)
          .join("\n\n");
        const mode = permissionMode(tab);
        const canEdit = ["auto", "acceptEdits"].includes(mode);
        const area = mode === "auto" ? "project-agent" : canEdit ? "project-write" : "project";
        const prompt = `You are Qwen, a private local coding agent working in ${projectPath}. Inspect relevant files before acting.${mode === "auto" ? " You may edit files and run project checks. Evaluate the result and iterate when checks fail." : canEdit ? " You may edit project files, but do not run commands." : " Plan and inspect only; do not change files or run commands."}\n\nConversation:\n${history}\n\nAssistant:`;
        const args = {
          requestId: tab.runId,
          model: workspaceLocalModel(spec),
          question: text,
          prompt,
          projectContext: `Project: ${projectName}\nRoot: ${projectPath}`,
          roots: [projectPath],
          areas: [{ id: area, name: "Project coding agent", description: "Inspect, change, and evaluate the open project" }],
          // A workspace agent must be able to inspect first and decide its next
          // action from each result. The normal assistant loop does that for up
          // to toolCallCap calls; the separate Think pipeline only permits one
          // tool call per pre-written step and adds a costly model pass before
          // Qwen can read the project at all.
          think: false,
          toolCallCap: 100,
        };
        // Cancelling llama.cpp is cooperative: its command returns as soon as
        // the stop is requested, while the model thread may need another
        // moment to release the single local-agent slot. Retry only that brief
        // handoff; all other launch errors still surface immediately.
        for (let attempt = 0; ; attempt++) {
          try {
            await invoke(spec.sendCmd, args);
            break;
          } catch (err) {
            if (!replacing || attempt >= 100 || !/already answering/i.test(String(err))) throw err;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        say("Local Qwen is working");
      } else if (tab.kind === "claude") {
        await invoke(spec.sendCmd, {
          window: label,
          tab: tab.runId,
          prompt: text,
          cwd: projectPath,
          session: tab.session || null,
          resume: tab.started,
          permissionMode: permissionMode(tab),
          model: tab.model || null,
        });
        tab.started = true;
        say("Claude is working");
      } else {
        await invoke(spec.sendCmd, {
          window: label,
          tab: tab.runId,
          prompt: text,
          cwd: projectPath,
          session: tab.session || null,
        });
        say(`${spec.label} is working`);
      }
    } catch (err) {
      endAgentTurn(tab);
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
  const QWEN_HISTORY_KEY = `wint.workspace.agent.qwen-history.v1:${projectPath.toLowerCase()}`;

  const loadQwenHistory = () => {
    try { return JSON.parse(localStorage.getItem(QWEN_HISTORY_KEY) || "[]"); }
    catch { return []; }
  };

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
      const tabs = [...panel.tabs.values()].map((t) => ({ id: t.id, kind: t.kind, pane: t.pane, session: t.session || null, started: Boolean(t.started), title: t.title || "", mode: permissionMode(t), model: t.model || "", ...(t.kind === "qwen" ? { turns: t.turns } : {}) }));
      localStorage.setItem(AGENT_TABS_KEY, JSON.stringify({ tabs, active: panel.active, splitRatio: panel.splitRatio }));
      const history = new Map(loadQwenHistory().map((item) => [item.id, item]));
      for (const tab of tabs.filter((item) => item.kind === "qwen" && item.turns?.length)) {
        history.set(tab.id, { id: tab.id, title: tab.title || agentTabTitle(tab), turns: tab.turns, modified: Date.now() });
      }
      localStorage.setItem(QWEN_HISTORY_KEY, JSON.stringify([...history.values()].sort((a, b) => b.modified - a.modified).slice(0, 50)));
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
        return `<div class="${cls.join(" ")}" data-tab="${t.id}" title="Drag to reorder or split · ${esc(spec.label)}">${icon(spec.icon)}<span>${esc(spec.label)}</span>${isAgentBusy(t) ? '<span class="ws-chat-tab-live"></span>' : ""}<button type="button" class="ws-chat-tab-x" data-close="${t.id}" title="Close this conversation">${icon("close")}</button></div>`;
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
      const isTerminal = button.dataset.dock === "terminal";
      button.disabled = !tab || (isHistory && !spec.sessionsCmd && !spec.localHistory) || (isTerminal && !spec.terminalCmd);
      if (button.dataset.dock === "debug") button.classList.toggle("on", Boolean(tab?.debugOpen));
      if (button.dataset.dock === "mode" && tab) {
        const mode = PERMISSION_MODES[permissionMode(tab)];
        button.title = `${mode.label} — ${mode.blurb}`;
        button.classList.toggle("warn", permissionMode(tab) !== DEFAULT_PERMISSION_MODE);
      }
      if (isHistory) {
        button.title = !tab || spec.sessionsCmd || spec.localHistory
          ? "Earlier conversations in this project"
          : `${spec.product} does not keep conversations WinT can read back`;
      }
    }
  }

  /** Keeps a popover inside the panel it belongs to.
   *
   *  The browser panel is a native child webview - a window over the window,
   *  not a layer in the page - so it is in front of everything the page draws
   *  and no z-index reaches past it. A popover that leaves its own panel is
   *  therefore simply gone wherever it crosses the browser, and moving the
   *  webview out of its way is not something the page can do reliably: it is
   *  put back by a resize, a layout pass, an observer, any of which know
   *  nothing about a popover. So the popover stays home instead. The width is
   *  held inside the panel by the stylesheet; the height is measured, because
   *  only the panel knows how much room is under the bar.
   *
   *  This runs when the popover opens and its content can only grow after -
   *  the cap is what the panel allows, not what the list wants, so a longer
   *  list scrolls rather than reaching past the panel. */
  const fitMenu = (menu) => {
    const panel = menu.closest(".ws-panel");
    if (!panel) return;
    const room = panel.getBoundingClientRect().bottom - menu.getBoundingClientRect().top - 8;
    menu.style.maxHeight = `${Math.max(120, room)}px`;
  };

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
  /** How much this conversation may do unasked, and what each answer means.
   *
   *  It is a per-conversation choice rather than a setting because the same
   *  project wants different answers at once: a tab reading the code and a
   *  tab changing it are not owed the same trust. */
  function showModeMenu(tab, menu) {
    const current = permissionMode(tab);
    menu.innerHTML = `<div class="ws-chat-menu-label">What it may do without asking</div>`
      + Object.entries(PERMISSION_MODES).map(([id, mode]) => `
        <button type="button" data-mode="${id}" class="${id === current ? "on" : ""}" title="${esc(mode.blurb)}">
          <strong>${icon(id === current ? "check" : mode.icon)}${esc(mode.label)}</strong>
          <small>${esc(mode.blurb)}</small>
        </button>`).join("")
      + `<div class="ws-agent-history-note">Nothing here can answer a permission prompt, so whatever the mode
         will not allow is refused rather than asked. Open the conversation in a terminal to approve it there.</div>`;
  }

  async function showAgentHistory(panel, tab, menu) {
    const spec = AGENTS[tab.kind];
    if (spec?.localHistory) {
      const sessions = loadQwenHistory();
      menu.innerHTML = `<div class="ws-chat-menu-label">Earlier conversations</div>`
        + (sessions.length
          ? sessions.map((s) => `<button type="button" data-session="${esc(s.id)}" data-session-title="${esc(s.title || "")}" title="${esc(s.title || s.id)}">
              <strong>${esc(s.title || "Untitled conversation")}</strong>
              <small>${esc(whenAgo(s.modified))} Â· ${s.turns.filter((t) => t.role === "you").length} questions</small>
            </button>`).join("")
          : `<div class="ws-agent-history-note">Nothing here yet.</div>`);
      return;
    }
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
    if (spec?.localHistory) {
      const saved = loadQwenHistory().find((session) => session.id === id);
      if (!saved) return;
      tab.turns = saved.turns.map((turn) => ({ ...turn, shown: turn.text?.length || 0 }));
      tab.title = title || saved.title || "";
      tab.localSteps = new Map();
      saveAgentTabs(panel);
      return renderAgentTab(panel, tab);
    }
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
    tab.openChanges = new Set();
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

  function createAgentTab(panel, kind, { pane = 0, id, session, started = false, title = "", turns = [], mode = DEFAULT_PERMISSION_MODE, model = "", activate = true } = {}) {
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
      turns: turns.map((turn) => ({ ...turn, shown: turn.text?.length || 0 })),
      streaming: null,
      // A turn is in flight (running) whether or not text is arriving; the
      // live bubble (streaming) comes and goes within it, once per stretch
      // of prose between tool calls.
      running: false,
      // What the agent last said it was doing, and the live thinking block.
      phase: "",
      thought: null,
      // What the last finished turn cost, shown under it.
      receipt: "",
      status: fresh.status,
      needsSignIn: fresh.needsSignIn,
      model: AGENTS[kind].models?.some((item) => item.id === model) ? model : fresh.model,
      openSteps: new Set(),
      // Which file changes the reader has opened past their first lines, by
      // the id of the step that made them.
      openChanges: new Set(),
      // Which long blocks (a pasted wall of text, a stretch of thinking) the
      // reader has opened, by turn index.
      openTurns: new Set(),
      // How much this conversation may do unasked. Per conversation, because
      // one tab reading the code and one changing it want different answers.
      mode: PERMISSION_MODES[mode] ? mode : DEFAULT_PERMISSION_MODE,
      // Every line the CLI sent for the turn in flight, and whether the view
      // over it is open.
      raw: [],
      debugOpen: false,
      // The last usage the CLI reported, drawn as a bar above the box rather
      // than as a line in the log: it is one fact that changes, not news.
      limit: null,
      startedAt: 0,
      clock: null,
    };

    const el = document.createElement("div");
    el.className = "ws-agent-conv";
    el.innerHTML = `<div class="ws-chat-log"></div>
      <div class="ws-agent-debug" hidden>
        <header>${icon("bug_report")}<strong>Raw stream</strong><span class="ws-debug-count"></span>
          <button type="button" class="ws-btn tiny" data-debug="copy">${icon("content_copy")}Copy</button>
          <button type="button" class="ws-btn tiny" data-debug="close">${icon("close")}Close</button>
        </header>
        <div class="ws-debug-lines"></div>
      </div>
      <div class="ws-agent-limit" hidden></div>
      <form class="ws-chat-ask" hidden>
        <label class="ws-agent-model" hidden>
          <span>${icon("neurology")}<strong>Model for this session</strong><small></small></span>
          <select aria-label="Model for this session">${(AGENTS[kind].models || []).map((item) => `<option value="${esc(item.id)}">${esc(item.label)} — ${esc(item.note)}</option>`).join("")}</select>
        </label>
        <div class="ws-chat-row">
          <textarea rows="1" placeholder="" spellcheck="false"></textarea>
          <button type="submit" class="ws-chat-send" title="Send (Enter)">${icon("send")}</button>
          <button type="button" class="ws-chat-stop" title="Stop" hidden>${icon("stop_circle")}</button>
        </div>
      </form>`;
    tab.el = el;
    tab.log = el.querySelector(".ws-chat-log");
    tab.debug = el.querySelector(".ws-agent-debug");
    tab.ask = el.querySelector(".ws-chat-ask");
    tab.limitBar = el.querySelector(".ws-agent-limit");
    tab.input = el.querySelector("textarea");
    tab.modelPicker = el.querySelector(".ws-agent-model");
    tab.modelSelect = tab.modelPicker.querySelector("select");
    panel.views.appendChild(el);

    tab.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); tab.ask.requestSubmit(); }
    });
    tab.input.addEventListener("input", () => growAgentInput(tab));
    tab.modelSelect.addEventListener("change", () => {
      if (tab.started || !AGENTS[tab.kind].models?.some((item) => item.id === tab.modelSelect.value)) return;
      tab.model = tab.modelSelect.value;
      saveAgentTabs(panel);
      renderAgentTab(panel, tab);
    });
    tab.ask.addEventListener("submit", (e) => { e.preventDefault(); sendToAgent(panel, tab); });
    tab.ask.querySelector(".ws-chat-stop").addEventListener("click", () => {
      const spec = AGENTS[tab.kind];
      if (spec) invoke(spec.cancelCmd, spec.localModel ? undefined : { tab: tab.runId || tab.id }).catch(() => {});
      recordRaw(tab, "meta", "stopped by you");
      tagRaw(tab, "stopped");
      endAgentTurn(tab);
      tab.turns.push({ role: "tool", icon: "stop_circle", text: "Stopped", state: "err" });
      renderAgentTab(panel, tab);
      renderAgentTabs(panel);
    });
    tab.el.addEventListener("click", (e) => {
      const copyCode = e.target.closest("[data-copy-code]");
      if (copyCode) {
        const code = copyCode.closest(".ws-code")?.querySelector("code")?.textContent || "";
        window.wintCopy.copy(code, copyCode, "Code copied").catch(() => say("Could not copy the code"));
        return;
      }
      const debugAction = e.target.closest("[data-debug]")?.dataset.debug;
      if (debugAction === "close") return toggleDebug(panel, tab);
      if (debugAction === "copy") {
        navigator.clipboard.writeText(debugText(tab)).then(
          () => say("The raw stream is on the clipboard"),
          () => say("Could not copy the raw stream"),
        );
        return;
      }
      const steps = e.target.closest("[data-steps]");
      if (steps) {
        const key = Number(steps.dataset.steps);
        if (!tab.openSteps.delete(key)) tab.openSteps.add(key);
        return renderAgentTab(panel, tab);
      }
      const change = e.target.closest("[data-change]");
      if (change) {
        const key = change.dataset.change;
        if (!tab.openChanges.delete(key)) tab.openChanges.add(key);
        return renderAgentTab(panel, tab);
      }
      const more = e.target.closest("[data-more]");
      if (more) {
        const key = Number(more.dataset.more);
        if (!tab.openTurns.delete(key)) tab.openTurns.add(key);
        return renderAgentTab(panel, tab);
      }
      const action = e.target.closest("[data-chat]")?.dataset.chat;
      if (action === "install") return installAgent(panel, tab).catch(() => {});
      if (action === "signin") return openAgentTerminal(panel, tab, { login: true }).catch(() => {});
      if (action === "recheck") return checkAgent(panel, tab, { force: true }).catch(() => {});
      if (action === "terminal") return openAgentTerminal(panel, tab).catch(() => {});
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
    if (isAgentBusy(tab)) {
      const spec = AGENTS[tab.kind];
      if (spec) invoke(spec.cancelCmd, spec.localModel ? undefined : { tab: tab.runId || tab.id }).catch(() => {});
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
      // Which tab asked for a kind to be installed, so the install's own
      // events - which name a window and nothing finer - can report back.
      panel.installing = new Map();

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
                <div class="ws-agent-history ws-agent-modes" data-modes-for="${pane}">
                  <button type="button" data-dock="mode" title="How much this conversation may do without asking">${icon("shield")}</button>
                  <div class="ws-agent-history-menu" hidden></div>
                </div>
                <button type="button" data-dock="debug" title="What the CLI is actually sending">${icon("bug_report")}</button>
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
          closeAgentMenus(body);
          menu.hidden = !wasHidden;
          if (!menu.hidden) fitMenu(menu);
          return;
        }
        const newKind = e.target.closest("[data-new-kind]")?.dataset.newKind;
        if (newKind) {
          // The picker is inside a pane's actions, but a click can land on a
          // node that has already been replaced by a redraw - so a missing
          // pane means the first one rather than a thrown TypeError.
          const pane = Number(e.target.closest("[data-pane-actions]")?.dataset.paneActions ?? 0) === 1 ? 1 : 0;
          closeAgentMenus(body);
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
        if (dockAction === "mode") {
          const menu = e.target.closest(".ws-agent-modes").querySelector(".ws-agent-history-menu");
          const wasHidden = menu.hidden;
          closeAgentMenus(body);
          menu.hidden = !wasHidden;
          if (!menu.hidden) {
            showModeMenu(tab, menu);
            fitMenu(menu);
          }
          return;
        }
        const pickedMode = e.target.closest("[data-mode]")?.dataset.mode;
        if (pickedMode) {
          closeAgentMenus(body);
          tab.mode = PERMISSION_MODES[pickedMode] ? pickedMode : DEFAULT_PERMISSION_MODE;
          saveAgentTabs(panel);
          renderAgentTabs(panel);
          say(`This conversation is now ${PERMISSION_MODES[tab.mode].short}`);
          return;
        }
        if (dockAction === "history") {
          const menu = e.target.closest(".ws-agent-history").querySelector(".ws-agent-history-menu");
          const wasHidden = menu.hidden;
          closeAgentMenus(body);
          menu.hidden = !wasHidden;
          if (!menu.hidden) {
            fitMenu(menu);
            showAgentHistory(panel, tab, menu).catch(() => {});
          }
          return;
        }
        if (dockAction === "debug") return toggleDebug(panel, tab);
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
          createAgentTab(panel, t.kind, { pane: t.pane === 1 ? 1 : 0, id: t.id, session: t.session, started: Boolean(t.started), title: t.title || "", turns: t.kind === "qwen" ? (t.turns || []) : [], mode: t.mode, model: t.model, activate: false });
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
    if (!panel) return null;
    const tab = panel.tabs.get(payload.tab) || [...panel.tabs.values()].find((candidate) => candidate.runId === payload.tab);
    return tab ? { panel, tab } : null;
  }

  /** The tab an install is reporting to.
   *
   *  Install events name a window and nothing finer - there is one copy of a
   *  CLI on the machine, so an install was never per conversation. Routing
   *  them through `agentTabFor` meant every one of them was dropped, which is
   *  why an install printed nothing and never noticed it had finished. */
  function installTabFor(payload, kind) {
    if (payload.window !== label) return null;
    const panel = panels.get("agent");
    if (!panel) return null;
    const asked = panel.tabs.get(panel.installing.get(kind));
    const tab = asked || [...panel.tabs.values()].find((t) => t.kind === kind);
    return tab ? { panel, tab } : null;
  }

  await listen("claude:install", ({ payload }) => {
    const found = installTabFor(payload, "claude");
    if (!found) return;
    const { panel, tab } = found;
    const pre = tab.log?.querySelector(".ws-chat-install");
    if (pre && payload.line) {
      pre.textContent += `${payload.line}\n`;
      pre.scrollTop = pre.scrollHeight;
    }
    if (!payload.done) return;
    panel.installing.delete(tab.kind);
    say(payload.ok ? `${AGENTS[tab.kind].product} installed` : `The ${AGENTS[tab.kind].label} install did not finish`);
    if (payload.ok) checkAgent(panel, tab, { force: true }).catch(() => {});
  }).catch(() => {});

  await listen("claude:line", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    recordRaw(tab, "out", payload.line);
    let msg;
    try { msg = JSON.parse(payload.line); } catch { return; }

    // The id is minted here and handed to the CLI, so the CLI naming it back
    // is what says the session now exists on disk. From that moment on this
    // conversation has to be resumed rather than created - and the command
    // streaming it does not return until the whole turn is over, which is far
    // too late to learn that from.
    if (msg.session_id) {
      tab.session = msg.session_id;
      tab.started = true;
    }

    // A subagent's own stream carries the id of the Task that spawned it. Its
    // steps belong under that Task, not interleaved with the main thread, and
    // there is nothing here yet that can nest them - so only the fact that a
    // subagent is working is kept, as the phase on the thinking line.
    if (msg.parent_tool_use_id) {
      tagRaw(tab, "subagent");
      tab.phase = "Running a subagent";
      return markAgentTabDirty(panel, tab);
    }

    if (msg.type === "stream_event") {
      const event = msg.event || {};
      // A tool is named the moment the block opens, before its arguments have
      // finished streaming - which is the difference between a step appearing
      // as it starts and appearing once it is already over.
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        tab.streaming = null;
        tab.phase = "";
        tagRaw(tab, `tool starts · ${event.content_block.name || "?"}`);
        beginToolTurn(tab, event.content_block);
        return markAgentTabDirty(panel, tab);
      }
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        tab.phase = "";
        tab.sawDeltas = true;
        tagRaw(tab, "answer text");
        if (!tab.streaming) { tab.streaming = { role: "claude", text: "", shown: 0 }; tab.turns.push(tab.streaming); }
        tab.streaming.text += event.delta.text || "";
        return markAgentTabDirty(panel, tab);
      }
      // Thinking is the longest silence in a turn, so it is shown as it
      // happens - dimmed, clamped to a few lines, and openable in place.
      if (event.type === "content_block_start" && event.content_block?.type === "thinking") {
        tab.streaming = null;
        tab.phase = "";
        tagRaw(tab, "thinking starts");
        tab.thought = { role: "thought", text: "" };
        tab.turns.push(tab.thought);
        return markAgentTabDirty(panel, tab);
      }
      if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
        if (!tab.thought) { tab.thought = { role: "thought", text: "" }; tab.turns.push(tab.thought); }
        tab.thought.text += event.delta.thinking || "";
        tagRaw(tab, "thinking");
        return markAgentTabDirty(panel, tab);
      }
      if (event.type === "content_block_stop") tab.thought = null;
      // The rest of the stream is bookkeeping around the message rather than
      // anything a reader wants: where a block began and ended, the
      // signature on a thought, the arguments filling into a tool whose name
      // is already on screen. Named anyway, so the debug view can tell them
      // from a shape nothing here knows.
      tagRaw(tab, `${event.type}${event.delta?.type ? ` · ${event.delta.type}` : ""}`, true);
      return;
    }

    // The whole assistant message, once it is complete. The tool blocks were
    // already opened from the stream; this is what fills in their arguments.
    if (msg.type === "assistant") {
      for (const block of msg.message?.content || []) {
        tagRaw(tab, `assistant · ${block.type}`);
        if (block.type === "tool_use") { beginToolTurn(tab, block); continue; }
        // Text normally arrives as deltas and is already on screen. A CLI
        // that will not stream them - an older one, or one built without
        // partial messages - would otherwise answer into an empty panel.
        if (block.type === "text" && !tab.sawDeltas && block.text) {
          tab.streaming = null;
          tab.turns.push({ role: "claude", text: block.text, shown: 0 });
        }
      }
      return markAgentTabDirty(panel, tab);
    }

    // What a tool actually did. A step that says only that it started is a
    // step that cannot be told from one that hung.
    if (msg.type === "user") {
      const content = msg.message?.content;
      if (!Array.isArray(content)) return;
      let touched = false;
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        tagRaw(tab, block.is_error ? "tool failed" : "tool result");
        touched = finishToolTurn(tab, block.tool_use_id, block.is_error, resultText(block.content), msg.tool_use_result) || touched;
      }
      return touched ? markAgentTabDirty(panel, tab) : undefined;
    }

    if (msg.type === "system") {
      // Nothing can answer a permission prompt from here - the CLI is running
      // without a host to ask - so a tool that needed approval is refused and
      // says so on its own line, with the way to actually approve it next to
      // it. Silence here is what made a denied turn look like a stuck one.
      if (msg.subtype === "permission_denied") {
        tagRaw(tab, `permission denied · ${msg.tool_name || "?"}`);
        finishToolTurn(tab, msg.tool_use_id, true, msg.decision_reason || "needs your approval");
        const name = msg.tool_name || "That tool";
        const last = tab.turns[tab.turns.length - 1];
        if (!(last?.role === "denied" && last.tool === name)) {
          tab.turns.push({
            role: "denied",
            tool: name,
            text: permissionMode(tab) === "auto"
              ? `${name} needs your approval, and nothing here can ask for it.`
              : `${name} needs your approval. This conversation is set to ${PERMISSION_MODES[permissionMode(tab)].short}.`,
          });
        }
        tab.deniedSomething = true;
        return markAgentTabDirty(panel, tab);
      }
      // The CLI's own account of which phase it is in, which is the only thing
      // that moves during a long wait for the model.
      if (msg.subtype === "status") {
        tagRaw(tab, `status · ${msg.status || "?"}`);
        tab.phase = STATUS_PHASES[msg.status] || "";
        return markAgentTabDirty(panel, tab);
      }
      // Connection failures can spend minutes in exponential backoff. These
      // are progress events, not debug-only bookkeeping: keep the latest
      // attempt and its wait visible on the always-present activity line.
      if (msg.subtype === "api_retry") {
        const attempt = Number(msg.attempt) || 0;
        const maximum = Number(msg.max_retries) || 0;
        const delay = Number(msg.retry_delay_ms) || 0;
        const count = attempt ? `attempt ${attempt}${maximum ? ` of ${maximum}` : ""}` : "request";
        const wait = delay > 0
          ? ` in ${delay >= 1000 ? `${Math.ceil(delay / 1000)}s` : `${delay}ms`}`
          : "";
        tab.phase = `Retrying ${count}${wait}`;
        tagRaw(tab, `API retry · ${count}${wait}`);
        return markAgentTabDirty(panel, tab);
      }
      if (msg.subtype === "compact_boundary") {
        tagRaw(tab, "compacted");
        tab.turns.push({ role: "tool", icon: "compress", text: "Compacted the conversation", state: "ok" });
        return markAgentTabDirty(panel, tab);
      }
      // Thinking arrives with its text withheld - the deltas are empty and
      // only the running token count is real - so this is the only thing
      // that moves during a long think, and the only honest way to say a
      // silent minute is being spent rather than wasted.
      if (msg.subtype === "thinking_tokens") {
        // Some CLI versions report zero (or restart their estimate) between
        // thinking blocks. Keep the best count seen for the whole turn so the
        // status does not flash between a count and nothing.
        tab.thinkingTokens = Math.max(tab.thinkingTokens || 0, Number(msg.estimated_tokens) || 0);
        // Counted against the thought it belongs to as well as against the
        // turn, so the log keeps a line for a think that left no words.
        if (tab.thought) tab.thought.tokens = tab.thinkingTokens;
        tagRaw(tab, `thinking · ${tab.thinkingTokens} tokens`);
        return markAgentTabDirty(panel, tab);
      }
      // Which model answered and under which permission mode, said once at
      // the top of the conversation - the two facts that decide what every
      // answer below is worth.
      if (msg.subtype === "init") {
        tagRaw(tab, `init · ${msg.model || "?"}`);
        const mode = PERMISSION_MODES[msg.permissionMode]?.short || msg.permissionMode;
        const setup = [msg.model, mode].filter(Boolean).join(" · ");
        if (setup) tab.turns.push({ role: "tool", icon: "tune", text: setup, state: "ok" });
        return markAgentTabDirty(panel, tab);
      }
      tagRaw(tab, `system · ${msg.subtype || "?"}`, true);
      return;
    }

    // Usage arrives with nearly every turn and only ever climbs, so it is one
    // bar above the box that is rewritten in place - never a line in the log,
    // which is where the same warning used to be repeated turn after turn.
    if (msg.type === "rate_limit_event") {
      const info = msg.rate_limit_info || {};
      tab.limit = info;
      const quiet = !info.status || info.status === "allowed";
      tagRaw(tab, `rate limit · ${info.status || "?"}`, quiet);
      renderAgentLimit(tab);
      return;
    }

    if (msg.type === "result") {
      tab.streaming = null;
      tab.thought = null;
      tab.running = false;
      tab.phase = "";
      const text = String(msg.result || "");
      if (msg.is_error || msg.subtype === "error_during_execution") {
        tab.turns.push({ role: "error", text: text || "That turn did not finish." });
      }
      if (/log ?in|sign ?in|not authenticated|invalid api key|credit balance/i.test(text)) {
        tab.needsSignIn = true;
      }
      tagRaw(tab, msg.is_error ? "result · error" : "result");
      tab.receipt = turnReceipt(msg);
      renderAgentTab(panel, tab);
      renderAgentTabs(panel);
      say(msg.is_error ? "Claude reported a problem" : "Claude answered");
    }
  }).catch(() => {});

  await listen("claude:end", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    recordRaw(tab, payload.code === 0 ? "meta" : "err", `exited ${payload.code}${payload.error ? ` · ${payload.error.trim()}` : ""}`);
    tagRaw(tab, "the end");
    endAgentTurn(tab);
    const error = (payload.error || "").trim();
    if (payload.code !== 0 && error) {
      // The CLI refuses to create a session that already exists. A tab in that
      // state would fail the same way forever, because nothing in it would
      // ever learn that the conversation is already on disk - so the answer is
      // to remember that it is and resume it, and to say so once rather than
      // handing over the raw complaint about an id nobody typed.
      if (/session id .* is already in use/i.test(error)) {
        tab.started = true;
        saveAgentTabs(panel);
        tab.turns.push({ role: "tool", icon: "history", text: "Picked the conversation back up · ask again", state: "ok" });
      } else {
        tab.turns.push({ role: "error", text: error });
      }
    }
    renderAgentTab(panel, tab);
    renderAgentTabs(panel);
    // Whether this conversation exists on disk yet is the one thing a reload
    // must not get wrong, so it is written down at the end of every turn.
    saveAgentTabs(panel);
  }).catch(() => {});

  await listen("cursor:install", ({ payload }) => {
    const found = installTabFor(payload, "cursor");
    if (!found) return;
    const { panel, tab } = found;
    const pre = tab.log?.querySelector(".ws-chat-install");
    if (pre && payload.line) {
      pre.textContent += `${payload.line}\n`;
      pre.scrollTop = pre.scrollHeight;
    }
    if (!payload.done) return;
    panel.installing.delete(tab.kind);
    say(payload.ok ? `${AGENTS[tab.kind].product} installed` : `The ${AGENTS[tab.kind].label} install did not finish`);
    if (payload.ok) checkAgent(panel, tab, { force: true }).catch(() => {});
  }).catch(() => {});

  await listen("cursor:line", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    recordRaw(tab, "out", payload.line);
    let obj;
    try { obj = JSON.parse(payload.line); } catch { return; }

    if (obj.session_id && !tab.session) tab.session = obj.session_id;

    if (obj.type === "system") return tagRaw(tab, `system · ${obj.subtype || "?"}`, true);
    // The question, handed straight back at the start of the turn. It is
    // already the bubble the turn was sent from.
    if (obj.type === "user") return tagRaw(tab, "the question, echoed", true);

    // Cursor thinks a token at a time, the same way it answers. Thinking is
    // the longest silence in a turn, so it is shown as it happens rather than
    // dropped - dimmed and clamped, like every other agent's.
    if (obj.type === "thinking") {
      if (obj.subtype !== "delta") {
        tab.thought = null;
        return tagRaw(tab, "thinking ends", true);
      }
      if (!obj.text) return tagRaw(tab, "thinking", true);
      // A thought ends whatever was being said: what comes after it is a
      // paragraph of its own, below the steps, not more of the bubble above.
      tab.streaming = null;
      if (!tab.thought) { tab.thought = { role: "thought", text: "" }; tab.turns.push(tab.thought); }
      tab.thought.text += obj.text;
      tagRaw(tab, "thinking");
      return markAgentTabDirty(panel, tab);
    }

    if (obj.type === "assistant") {
      const text = cursorAssistantText(obj);
      if (!text) return tagRaw(tab, "assistant · no text", true);

      const hasTs = obj.timestamp_ms !== undefined && obj.timestamp_ms !== null;
      const hasModelCallId = obj.model_call_id !== undefined && obj.model_call_id !== null;
      if (hasTs && hasModelCallId) {
        // The finished message, repeated in full as the turn moves on. Its
        // tokens are already on screen, so it is not appended again - but it
        // is what says the message is over, and the next one is its own
        // paragraph rather than the same sentence continuing.
        if (tab.streaming) tab.streaming.text = text;
        tab.streaming = null;
        tagRaw(tab, "answer ends");
        return markAgentTabDirty(panel, tab);
      }
      if (hasTs) {
        tab.thought = null;
        if (!tab.streaming) { tab.streaming = { role: "cursor", text: "", shown: 0 }; tab.turns.push(tab.streaming); }
        tab.streaming.text += text;
        tagRaw(tab, "answer text");
        return markAgentTabDirty(panel, tab);
      }

      // A whole message with no token stream behind it - an older CLI, or one
      // that buffered the lot.
      tab.thought = null;
      if (tab.streaming) tab.streaming.text = text;
      else tab.turns.push({ role: "cursor", text, shown: 0 });
      tab.streaming = null;
      tagRaw(tab, "answer");
      renderAgentTab(panel, tab);
      renderAgentTabs(panel);
      return;
    }

    if (obj.type === "tool_call") {
      const summary = cursorToolSummary(obj);
      if (!summary) return tagRaw(tab, "tool · unnamed", true);
      // Cursor names a call twice, as it starts and as it ends. The id it
      // carries is not in a fixed place across versions, so the summary -
      // which is built from the call itself - stands in when there is none.
      const id = obj.call_id || obj.callId || `cursor:${summary}`;
      if (obj.subtype === "started") {
        // The step goes after whatever was just said, so the answer stops
        // growing here. Left running, every later answer folded back into the
        // first bubble and every step piled up below it, in no order at all.
        tab.streaming = null;
        tab.thought = null;
        beginToolTurn(tab, { id, name: summary, input: {} });
        tagRaw(tab, `tool starts · ${summary}`);
        return markAgentTabDirty(panel, tab);
      }
      if (obj.subtype === "completed" || obj.subtype === "failed") {
        const turn = beginToolTurn(tab, { id, name: summary, input: {} });
        turn.text = summary;
        turn.state = obj.subtype === "failed" ? "err" : "ok";
        turn.detail = resultSummary(obj.error?.message || obj.result || "");
        tagRaw(tab, obj.subtype === "failed" ? "tool failed" : "tool result");
        return markAgentTabDirty(panel, tab);
      }
      return tagRaw(tab, `tool · ${obj.subtype || "?"}`, true);
    }

    tagRaw(tab, `${obj.type || "?"}`, true);
  }).catch(() => {});

  await listen("cursor:end", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    recordRaw(tab, payload.code === 0 ? "meta" : "err", `exited ${payload.code}${payload.error ? ` · ${payload.error.trim()}` : ""}`);
    tagRaw(tab, "the end");
    endAgentTurn(tab);
    if (payload.code !== 0 && payload.error) {
      tab.turns.push({ role: "error", text: payload.error.trim() });
    }
    renderAgentTab(panel, tab);
    renderAgentTabs(panel);
  }).catch(() => {});

  await listen("copilot:install", ({ payload }) => {
    const found = installTabFor(payload, "copilot");
    if (!found) return;
    const { panel, tab } = found;
    const pre = tab.log?.querySelector(".ws-chat-install");
    if (pre && payload.line) {
      pre.textContent += `${payload.line}\n`;
      pre.scrollTop = pre.scrollHeight;
    }
    if (!payload.done) return;
    panel.installing.delete(tab.kind);
    say(payload.ok ? `${AGENTS[tab.kind].product} installed` : `The ${AGENTS[tab.kind].label} install did not finish`);
    if (payload.ok) checkAgent(panel, tab, { force: true }).catch(() => {});
  }).catch(() => {});

  await listen("copilot:line", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    recordRaw(tab, "out", payload.line);
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
    recordRaw(tab, payload.code === 0 ? "meta" : "err", `exited ${payload.code}${payload.error ? ` · ${payload.error.trim()}` : ""}`);
    tagRaw(tab, "the end");
    endAgentTurn(tab);
    if (payload.code !== 0 && payload.error) {
      tab.turns.push({ role: "error", text: payload.error.trim() });
    }
    renderAgentTab(panel, tab);
    renderAgentTabs(panel);
  }).catch(() => {});

  await listen("gemini:install", ({ payload }) => {
    const found = installTabFor(payload, "gemini");
    if (!found) return;
    const { panel, tab } = found;
    const pre = tab.log?.querySelector(".ws-chat-install");
    if (pre && payload.line) {
      pre.textContent += `${payload.line}\n`;
      pre.scrollTop = pre.scrollHeight;
    }
    if (!payload.done) return;
    panel.installing.delete(tab.kind);
    say(payload.ok ? `${AGENTS[tab.kind].product} installed` : `The ${AGENTS[tab.kind].label} install did not finish`);
    if (payload.ok) checkAgent(panel, tab, { force: true }).catch(() => {});
  }).catch(() => {});

  await listen("gemini:line", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    recordRaw(tab, "out", payload.line);
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
    recordRaw(tab, payload.code === 0 ? "meta" : "err", `exited ${payload.code}${payload.error ? ` · ${payload.error.trim()}` : ""}`);
    tagRaw(tab, "the end");
    endAgentTurn(tab);
    if (payload.code !== 0 && payload.error) {
      tab.turns.push({ role: "error", text: payload.error.trim() });
    }
    renderAgentTab(panel, tab);
    renderAgentTabs(panel);
  }).catch(() => {});

  await listen("codex:install", ({ payload }) => {
    const found = installTabFor(payload, "codex");
    if (!found) return;
    const { panel, tab } = found;
    const pre = tab.log?.querySelector(".ws-chat-install");
    if (pre && payload.line) {
      pre.textContent += `${payload.line}\n`;
      pre.scrollTop = pre.scrollHeight;
    }
    if (!payload.done) return;
    panel.installing.delete(tab.kind);
    say(payload.ok ? `${AGENTS[tab.kind].product} installed` : `The ${AGENTS[tab.kind].label} install did not finish`);
    if (payload.ok) checkAgent(panel, tab, { force: true }).catch(() => {});
  }).catch(() => {});

  await listen("codex:line", ({ payload }) => {
    const found = agentTabFor(payload);
    if (!found?.tab) return;
    const { panel, tab } = found;
    recordRaw(tab, "out", payload.line);
    let obj;
    try { obj = JSON.parse(payload.line); } catch { return; }

    if (obj.type === "thread.started" && obj.thread_id) tab.session = obj.thread_id;

    // An item is announced when it starts and again when it ends; both are
    // taken, so a command that takes a minute is on screen for that minute
    // rather than appearing only once it is over. An id is what ties the two
    // together - without one the second announcement opens its own step.
    if ((obj.type === "item.started" || obj.type === "item.updated" || obj.type === "item.completed")
        && obj.item && obj.item.type !== "agent_message" && obj.item.type !== "reasoning") {
      const line = codexToolLine(obj.item);
      if (!line) return;
      const turn = beginToolTurn(tab, {
        id: obj.item.id || `codex:${line}`,
        name: line,
        input: {},
      });
      turn.text = line;
      turn.icon = CODEX_ITEM_ICONS[obj.item.type] || "build";
      if (obj.type === "item.completed") {
        const failed = obj.item.status === "failed" || Number(obj.item.exit_code) > 0;
        turn.state = failed ? "err" : "ok";
        turn.detail = resultSummary(obj.item.aggregated_output || obj.item.output || obj.item.error || "");
      }
      return markAgentTabDirty(panel, tab);
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
    recordRaw(tab, payload.code === 0 ? "meta" : "err", `exited ${payload.code}${payload.error ? ` · ${payload.error.trim()}` : ""}`);
    tagRaw(tab, "the end");
    endAgentTurn(tab);
    if (payload.code !== 0 && payload.error) {
      tab.turns.push({ role: "error", text: payload.error.trim() });
    }
    renderAgentTab(panel, tab);
    renderAgentTabs(panel);
  }).catch(() => {});

  // The local Qwen coding agent reuses the assistant runtime. Its request id
  // is the workspace tab id, which keeps the shared assistant event stream
  // isolated from the docked assistant and from other workspace tabs.
  await listen("assistant:chunk", ({ payload }) => {
    const panel = panels.get("agent");
    const tab = panel && [...panel.tabs.values()].find((candidate) => candidate.runId === payload.requestId);
    if (!tab || tab.kind !== "qwen") return;
    if (!tab.streaming) {
      tab.streaming = { role: "qwen", text: "", shown: 0 };
      tab.turns.push(tab.streaming);
    }
    if (payload.kind === "replace") tab.streaming.text = payload.text || "";
    else tab.streaming.text += payload.text || "";
    if (payload.done) {
      if (payload.error) tab.turns.push({ role: "error", text: payload.error });
      tab.streaming = null;
      endAgentTurn(tab);
      saveAgentTabs(panel);
      say(payload.error ? "Local Qwen reported a problem" : "Local Qwen answered");
    }
    renderAgentTab(panel, tab);
    renderAgentTabs(panel);
  }).catch(() => {});

  await listen("assistant:step", ({ payload }) => {
    const panel = panels.get("agent");
    const tab = panel && [...panel.tabs.values()].find((candidate) => candidate.runId === payload.requestId);
    if (!tab || tab.kind !== "qwen") return;
    tab.localSteps ||= new Map();
    let turn = tab.localSteps.get(payload.id);
    if (!turn) {
      turn = { role: "tool", icon: "build", text: payload.name, detail: "", state: "run" };
      tab.localSteps.set(payload.id, turn);
      tab.turns.push(turn);
    }
    turn.text = payload.name || turn.text;
    turn.detail = payload.detail || turn.detail;
    turn.state = payload.status === "error" ? "err" : payload.status === "done" ? "ok" : "run";
    markAgentTabDirty(panel, tab);
  }).catch(() => {});

  await listen("assistant:step-chunk", ({ payload }) => {
    const panel = panels.get("agent");
    const tab = panel && [...panel.tabs.values()].find((candidate) => candidate.runId === payload.requestId);
    const turn = tab?.localSteps?.get(payload.id);
    if (!tab || tab.kind !== "qwen" || !turn) return;
    turn.detail = `${turn.detail || ""}${payload.text || ""}`;
    markAgentTabDirty(panel, tab);
  }).catch(() => {});

  await listen("assistant:model-progress", ({ payload }) => {
    if (!AGENTS.qwen.localModels.some((model) => model.id === payload.model)) return;
    const panel = panels.get("agent");
    const id = panel?.installing.get("qwen");
    const tab = id && panel.tabs.get(id);
    const pre = tab?.log?.querySelector(".ws-chat-install");
    if (pre) pre.textContent = payload.error || payload.detail || `${payload.phase || "Downloading"} ${payload.downloaded || 0} / ${payload.total || 0}`;
    if (!payload.done || !panel || !tab) return;
    panel.installing.delete("qwen");
    if (payload.error) say(payload.error);
    else checkAgent(panel, tab, { force: true }).catch(() => {});
  }).catch(() => {});

  /* ------------------------------------ the port a server could not have */

  // A dev server that asks for a port, finds it taken and quietly settles for
  // another one leaves the developer with the wrong address to open and a
  // second copy of yesterday's server still running. The terminal says it in
  // one line; this is the offer to do something about it - free the port and
  // start the command over.
  //
  // A card rather than a dialog on purpose: nothing here is urgent, and a
  // modal over a terminal that is still printing would be in the way. Anyone
  // who never wants the offer can say so on the card itself.
  const PORT_OFFER_KEY = "wint.workspace.portOffer";
  const portOfferMuted = () => { try { return localStorage.getItem(PORT_OFFER_KEY) === "off"; } catch { return false; } };
  const mutePortOffer = (muted) => { try { localStorage.setItem(PORT_OFFER_KEY, muted ? "off" : "on"); } catch {} };

  /** The card on screen, if there is one: the port it is about and the
   *  terminal that complained, so the retry goes back where it came from. */
  let portOffer = null;

  const closePortOffer = () => { portOffer?.el.remove(); portOffer = null; };

  const portOfferStatus = (text, bad = false) => {
    const line = portOffer?.el.querySelector(".ws-port-offer-status");
    if (!line) return;
    line.textContent = text;
    line.classList.toggle("bad", bad);
    line.hidden = !text;
  };

  const portHolderName = (row) => row?.process || row?.executablePath?.split(/[\/]/).pop() || "a process";

  /** Whatever is listening on the port now. Read at the moment it is needed
   *  rather than kept: between the server complaining and the click, the thing
   *  holding the port may well have gone on its own. */
  const holderOfPort = (port) => invoke("port_list")
    .then((rows) => (rows || []).find((row) => (row.ports || []).some((binding) => binding.port === port)) || null)
    .catch(() => null);

  /** Frees the port and runs the same command again: interrupt whatever the
   *  terminal is running now, then recall the last command from the shell's
   *  own history and press Enter. The shell is the one that knows what was
   *  typed, so the shell is the one asked. */
  const freePortAndRetry = async () => {
    if (!portOffer) return;
    const { port, id } = portOffer;
    const button = portOffer.el.querySelector('[data-port-offer="kill"]');
    button.disabled = true;
    portOfferStatus(`Looking for what is holding ${port}…`);
    const holder = await holderOfPort(port);
    if (!holder) {
      portOfferStatus(`Nothing is listening on ${port} any more.`, true);
      button.disabled = false;
      return;
    }
    portOfferStatus(`Stopping ${portHolderName(holder)} (PID ${holder.pid})…`);
    try {
      await invoke("port_kill", {
        pid: holder.pid,
        expectedExecutable: holder.executablePath || "",
        expectedProcess: holder.process || "",
        tree: true,
      });
    } catch (err) {
      portOfferStatus(`Could not stop PID ${holder.pid}: ${String(err)}`, true);
      button.disabled = false;
      return;
    }
    if (!window.wintTermDock?.writeTo(id, "\x03")) {
      portOfferStatus(`Freed ${port}, but that terminal has gone - start the command again yourself.`, true);
      return;
    }
    portOfferStatus(`Freed ${port}. Running it again…`);
    // The interrupt has to reach the program and the shell has to draw its
    // prompt again before a recalled command means anything, and neither of
    // those is something the terminal reports. This is the one place in the
    // window that waits on a guess; guessing short costs a line of gibberish
    // in the terminal rather than anything broken.
    setTimeout(() => {
      window.wintTermDock?.writeTo(id, "\x1b[A");
      setTimeout(() => window.wintTermDock?.writeTo(id, "\r"), 150);
      setTimeout(closePortOffer, 1800);
    }, 800);
  };

  /** Puts the offer on screen for a port a terminal in this window could not
   *  have. The same port complaining twice does not stack a second card. */
  const showPortOffer = ({ id, port, fallback }) => {
    if (portOfferMuted() || portOffer?.port === port) return;
    closePortOffer();
    const who = window.wintTermDock?.label(id) || "The terminal";
    const el = document.createElement("section");
    el.className = "ws-port-offer";
    el.setAttribute("role", "status");
    el.innerHTML = `
      <span class="ws-port-offer-icon">${icon("lan")}</span>
      <div class="ws-port-offer-copy">
        <strong>Port ${port} was already taken</strong>
        <p>${esc(who)} asked for ${port}${fallback ? ` and settled for ${fallback}` : ""}. Free ${port} and start it again?</p>
        <p class="ws-port-offer-status" hidden></p>
      </div>
      <div class="ws-port-offer-actions">
        <button class="ws-btn primary" type="button" data-port-offer="kill">Free ${port} and retry</button>
        <button class="ws-btn" type="button" data-port-offer="dismiss">Not now</button>
      </div>
      <label class="ws-port-offer-mute"><input type="checkbox" data-port-offer="mute" /> Don't show this again</label>`;
    document.body.appendChild(el);
    portOffer = { el, id, port };
    el.addEventListener("click", (event) => {
      const action = event.target.closest("[data-port-offer]")?.dataset.portOffer;
      if (action === "kill") freePortAndRetry().catch((err) => portOfferStatus(String(err), true));
      if (action === "dismiss") closePortOffer();
    });
    el.querySelector('[data-port-offer="mute"]').addEventListener("change", (event) => {
      mutePortOffer(event.target.checked);
      if (event.target.checked) portOfferStatus("Offers about taken ports are off for every workspace.");
    });
    // Say what is on the port while it is being read, so the button is never a
    // leap in the dark. A lookup that finds nothing changes nothing - the
    // click looks again anyway.
    holderOfPort(port).then((holder) => {
      if (portOffer?.el !== el || !holder) return;
      const line = el.querySelector(".ws-port-offer-copy p");
      line.textContent = `${line.textContent} It is held by ${portHolderName(holder)} (PID ${holder.pid}).`;
    });
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
  // The event is broadcast to every window, so a dev server started in some
  // other project's terminal must not steer this workspace's browser. The dock
  // is the only thing that knows which terminals are this window's, and it does
  // not exist until the terminal panel has loaded terminals.js.
  // Where the browser panel has got to on its own - a link followed, a
  // redirect, a router rewriting the address. Broadcast to every window, so
  // only this window's own events are worth anything, and the box is left
  // alone while it is being typed in.
  listen("workspace:browser-url", ({ payload }) => {
    if (payload?.window !== label || !payload.url) return;
    browserUrl = payload.url;
    const panel = panels.get("browser");
    if (panel?.address && document.activeElement !== panel.address) panel.address.value = payload.url;
  }).catch(() => {});

  // The other line the window acts on: a port a program in one of this
  // window's terminals asked for and could not have.
  listen("term:port-taken", ({ payload }) => {
    if (!payload?.port || !window.wintTermDock?.has(payload.id)) return;
    showPortOffer(payload);
  }).catch(() => {});

  listen("term:serving", ({ payload }) => {
    const dock = window.wintTermDock;
    if (!dock?.has(payload.id)) return;
    goTo(payload.url, `${dock.label(payload.id)} is serving ${payload.url}`);
  }).catch((err) => say(`Cannot watch the terminals for a dev server: ${err}`));

  window.wintTrackPageView?.("/workspace");
})().catch((err) => {
  console.error("The workspace could not start:", err);
});
