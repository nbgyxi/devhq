// The popped-out terminal window. It attaches to a session that already exists
// in Rust, so nothing restarts when a terminal moves between here and the
// DevHQ panel — a running build keeps running.
//
// It splits the way the panel does: up to two panes, side by side or stacked,
// each with its own tab saying which shell it is, a divider that can be
// dragged, and a cross that closes one pane without taking the window with it.

(async () => {
  window.devhqTrackPageView?.("/terminal");
  const invoke = window.__TAURI__.core.invoke;
  const emit = window.__TAURI__.event.emit;
  const listen = window.__TAURI__.event.listen;
  const win = window.__TAURI__.window.getCurrentWindow();

  const id = new URLSearchParams(location.search).get("id");
  const host = document.getElementById("pop-term");
  const layout = document.getElementById("pop-term-layout");
  const divider = document.querySelector(".pop-divider");
  const subtitle = document.getElementById("pop-title");

  // Docking is the mirror of popping out: tell DevHQ to take the session back
  // into its panel, and this window's job is done.
  //
  // It must be said exactly once. DevHQ answers "docked" by closing this
  // window, and a close handled as a close request would announce a dock of its
  // own - two windows telling each other to dock, round and round, with this
  // one too busy to repaint. The flag closes that loop, and `destroy` leaves
  // without raising a close request nobody needs to hear.
  let handedOver = false;
  let closed = false;

  // Up to two panes, in the order they are shown. `panes[0]` is the one the
  // window is named after; when it is closed the other takes its place rather
  // than the window going with it.
  const panes = [];
  let activePane = 0;
  let splitDirection = "vertical";
  let splitRatio = 0.5;
  const companion = () => panes[1] || null;
  const ownedIds = () => panes.map((pane) => pane.id);
  const current = () => panes[activePane] || panes[0];

  const handOver = async () => {
    if (handedOver || closed) return;
    handedOver = true;
    await Promise.all(ownedIds().map((sessionId, pane) => emit("term:docked", { id: sessionId, pane })));
  };

  // Closing is not docking. The cross ends the shell immediately, the way the
  // cross on a tab in the panel does — no Ctrl+C wait dialog. Only the dock
  // button and a drag onto the panel hand the session back. DevHQ is told so
  // it can forget the terminal instead of reopening it on the next launch.
  const finishClose = async () => {
    if (handedOver || closed) return;
    closed = true;
    await Promise.all(ownedIds().flatMap((sessionId) => [
      emit("term:close-watch", { id: sessionId }).catch(() => {}),
      emit("term:closed", { id: sessionId }).catch(() => {}),
    ]));
    await win.destroy().catch(() => {});
  };

  document.querySelectorAll("[data-win]").forEach((btn) => {
    btn.onclick = async () => {
      const act = btn.dataset.win;
      if (act === "min") win.minimize();
      else if (act === "max") {
        await win.toggleMaximize().catch(() => {});
        syncMaximizeButton();
      } else {
        // destroy so this click cannot race the native close request.
        await finishClose();
      }
    };
  });

  const maxButton = document.querySelector('[data-win="max"]');
  let wasMaximized = false;
  let pendingRestoreSettle = false;
  async function syncMaximizeButton() {
    if (!maxButton) return;
    const maxed = await win.isMaximized().catch(() => false);
    // Restoring from maximized is the one size change that may place the
    // scroller; an edge-drag resize must not.
    if (wasMaximized && !maxed) pendingRestoreSettle = true;
    wasMaximized = maxed;
    const glyph = maxButton.querySelector(".ms");
    if (glyph) glyph.textContent = maxed ? "filter_none" : "crop_square";
    maxButton.title = maxed ? "Restore" : "Maximize";
    maxButton.setAttribute("aria-label", maxed ? "Restore" : "Maximize");
  }
  win.isMaximized().then((maxed) => { wasMaximized = !!maxed; }).catch(() => {});
  syncMaximizeButton();
  win.onResized(() => syncMaximizeButton());

  if (!id) {
    host.textContent = "No terminal id.";
    return;
  }

  /* ------------------------------------------------------ shell identity */

  const SHELL_CODES = { auto: "SH", pwsh: "PW7", "pwsh-preview": "PWP", powershell: "PS", cmd: "CMD", "git-bash": "GIT", wsl: "WSL", nu: "NU" };
  const SHELL_LABELS = { auto: "Terminal", pwsh: "PowerShell 7", "pwsh-preview": "PowerShell Preview", powershell: "Windows PowerShell", cmd: "Command Prompt", "git-bash": "Git Bash", wsl: "WSL Bash", nu: "NuShell" };
  const SHELL_COLORS = { auto: "#42b3c2", pwsh: "#4d9df5", "pwsh-preview": "#c162de", powershell: "#61afef", cmd: "#8cc265", "git-bash": "#e05561", wsl: "#d5a458", nu: "#c162de" };

  /** Which shell a session is running, read from the command line it was
   *  started with. A shell DevHQ downloaded itself lives under its own profile
   *  folder, which is what tells the two PowerShells apart when neither is the
   *  one in Program Files. */
  const shellProfileFromCommand = (command) => {
    const value = String(command || "").toLowerCase();
    if (value.includes("git\\bin\\bash.exe") || value.includes("shells\\git-bash\\")) return "git-bash";
    if (value.includes("7-preview\\pwsh.exe") || value.includes("shells\\pwsh-preview\\")) return "pwsh-preview";
    if (value.includes("pwsh.exe")) return "pwsh";
    if (value.includes("wsl.exe") || value.startsWith("wsl")) return "wsl";
    if (value.includes("powershell.exe") || value.startsWith("powershell")) return "powershell";
    if (value.includes("cmd.exe") || value.startsWith("cmd")) return "cmd";
    if (value.includes("nu.exe") || value.startsWith("nu")) return "nu";
    return "auto";
  };

  /** The profile a `wt --profile` name asks for. */
  const profileShell = (profile) => {
    const value = String(profile || "").toLowerCase();
    if (value.includes("command prompt") || value === "cmd") return "cmd";
    if (value.includes("wsl") || value.includes("ubuntu") || value.includes("debian")) return "wsl";
    if (value.includes("nu")) return "nu";
    if (value.includes("git")) return "git-bash";
    if (value.includes("powershell") || value.includes("pwsh")) return value.includes("7") ? "pwsh" : "powershell";
    return "auto";
  };

  let markerStyle = "code";
  let markerColors = {};
  const applyMarkers = (next) => {
    markerStyle = ["none", "dot", "code"].includes(next?.style) ? next.style : "code";
    markerColors = next?.colors || {};
    document.body.classList.remove("shell-markers-none", "shell-markers-dot", "shell-markers-code");
    document.body.classList.add(`shell-markers-${markerStyle}`);
    for (const [profile, fallback] of Object.entries(SHELL_COLORS)) {
      const color = markerColors[profile] || fallback;
      if (/^#[0-9a-f]{6}$/i.test(color)) document.documentElement.style.setProperty(`--shell-color-${profile}`, color);
    }
    renderPanes();
  };

  /** Paints one shell mark - the coloured dot or short code the panel uses -
   *  so a pane says what it is without being clicked. */
  const paintMark = (mark, profile) => {
    if (!mark) return;
    mark.className = `shell-mark shell-${profile}`;
    mark.textContent = SHELL_CODES[profile] || "SH";
    mark.title = SHELL_LABELS[profile] || "Terminal";
    mark.hidden = false;
  };

  /* --------------------------------------------------------------- panes */

  const paneElements = (el) => ({
    el,
    host: el.querySelector(".term-host"),
    tab: el.querySelector(".pop-pane-tab"),
    mark: el.querySelector(".pop-pane-tab .shell-mark"),
    name: el.querySelector(".pop-pane-name"),
    close: el.querySelector(".pop-pane-close"),
  });

  const createPaneElement = () => {
    const el = document.createElement("div");
    el.className = "pop-pane";
    el.innerHTML = `<div class="pop-pane-tab">
        <i class="shell-mark" hidden></i>
        <span class="pop-pane-name"></span>
        <button class="pop-pane-close" type="button" title="Close this pane" aria-label="Close this pane"><span class="ms">close</span></button>
      </div>
      <div class="term-host"></div>`;
    return el;
  };

  /** Draws what the panes are: which is focused, what each one is running, and
   *  whether there is a split at all. Everything that changes a pane ends
   *  here, so the tabs, the divider and the title can never disagree. */
  function renderPanes() {
    const split = panes.length > 1;
    layout.classList.toggle("split", split);
    layout.classList.toggle("horizontal", split && splitDirection === "horizontal");
    layout.style.setProperty("--pop-split", `${splitRatio * 100}%`);
    divider.hidden = !split;
    divider.setAttribute("aria-orientation", splitDirection === "horizontal" ? "horizontal" : "vertical");
    // The layout follows pane order, so a swap is a change to the array and
    // nothing else has to know the DOM order. It is only ever touched when the
    // order really differs: moving a scroller in the DOM puts it back to the
    // top, and this runs on every title the shell sets.
    const wanted = [panes[0]?.el, split ? divider : null, panes[1]?.el].filter(Boolean);
    if (wanted.some((node, index) => layout.children[index] !== node)) layout.append(...wanted);
    panes.forEach((pane, index) => {
      pane.el.dataset.pane = String(index);
      pane.el.classList.toggle("active", index === activePane && split);
      paintMark(pane.mark, pane.profile);
      pane.name.textContent = pane.title || pane.info.projectName || "Terminal";
      pane.name.title = pane.info.projectPath || "";
      pane.close.hidden = !split;
      pane.el.classList.toggle("exited", pane.exited);
    });
    const splitButtonEl = document.getElementById("pop-split");
    if (splitButtonEl) {
      splitButtonEl.title = split ? "Close the second pane" : "Split this terminal";
      splitButtonEl.classList.toggle("on", split);
      const glyph = splitButtonEl.querySelector(".ms");
      if (glyph) glyph.textContent = split ? "close_fullscreen" : "splitscreen_right";
    }
    const active = current();
    if (active) {
      subtitle.textContent = active.exited ? "exited" : active.title || "";
      document.getElementById("pop-project").textContent = active.info.projectName || "Terminal";
      paintMark(document.getElementById("pop-shell"), active.profile);
    }
  }

  function focusPane(index) {
    if (!panes[index]) return;
    activePane = index;
    renderPanes();
    panes[index].view.focus();
  }

  /** Attaches a view to a session and adds it as a pane. The session is
   *  already running in Rust - this only ever builds the window's side of it. */
  async function addPane(sessionId, el) {
    const parts = paneElements(el);
    const view = new TermView(parts.host, sessionId);
    const pane = { id: sessionId, view, ...parts, title: "", exited: false, profile: "auto", info: {} };
    view.onTitle = (text) => {
      pane.title = text;
      renderPanes();
    };
    view.onExit = () => {
      pane.exited = true;
      renderPanes();
    };
    pane.info = await view.attach();
    pane.profile = shellProfileFromCommand(pane.info.command);
    panes.push(pane);
    // Clicking anywhere in a pane makes it the one the window is talking about.
    el.addEventListener("pointerdown", () => {
      const index = panes.indexOf(pane);
      if (index >= 0 && index !== activePane) focusPane(index);
    }, true);
    parts.close.onclick = (e) => {
      e.stopPropagation();
      closePane(panes.indexOf(pane));
    };
    return pane;
  }

  /** Splits this window, or reports why it could not. The session is opened
   *  the same way the panel opens one, so a pane here and a tab there are the
   *  same kind of thing. */
  async function openCompanion({ shell = "", command = "", cwd = "", name = "", direction = "vertical", size = 0 } = {}) {
    if (panes.length > 1) return null;
    const source = current();
    const folder = cwd || source?.info.projectPath || "";
    const next = await invoke("term_open", { args: {
      projectPath: folder,
      projectName: name || folder.split(/[\\/]/).filter(Boolean).pop() || "Terminal",
      ...(command ? { command } : {}),
      // An empty profile is not a profile: Rust would refuse it, where "auto"
      // means "whatever this machine has".
      shell: shell || "auto",
    }});
    splitDirection = direction === "horizontal" ? "horizontal" : "vertical";
    if (size >= .1 && size <= .9) splitRatio = 1 - size;
    const el = createPaneElement();
    layout.appendChild(el);
    const pane = await addPane(next.id, el);
    activePane = panes.indexOf(pane);
    renderPanes();
    await emit("term:popped-created", { info: next }).catch(() => {});
    for (const item of panes) item.view.fit();
    pane.view.focus();
    return next;
  }

  /** Closes one pane and leaves the window to the other. Closing the last one
   *  is closing the window, which is what the titlebar cross already means. */
  async function closePane(index) {
    const pane = panes[index];
    if (!pane) return;
    if (panes.length === 1) return finishClose();
    panes.splice(index, 1);
    pane.view.dispose();
    pane.el.remove();
    await emit("term:close-watch", { id: pane.id }).catch(() => {});
    await emit("term:closed", { id: pane.id }).catch(() => {});
    activePane = 0;
    renderPanes();
    panes[0].view.fit();
    panes[0].view.focus();
  }

  /* ------------------------------------------------- the first pane */

  const first = document.querySelector('.pop-pane[data-pane="0"]');
  let info;
  try {
    info = (await addPane(id, first)).info;
  } catch (e) {
    host.textContent = String(e);
    return;
  }

  try {
    const prefs = JSON.parse(localStorage.getItem("devhq.terminals.v1") || "{}");
    applyMarkers({ style: prefs.shellMarkerStyle, colors: prefs.shellColors });
  } catch {
    applyMarkers({ style: "code", colors: {} });
  }
  listen("term:markers", (event) => applyMarkers(event.payload));

  const folderTitle = String(info.projectPath || "")
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop();
  document.title = folderTitle || info.projectName || "Terminal";
  renderPanes();
  panes[0].view.fit();
  panes[0].view.focus();

  /* ---------------------------------------------------------- splitting */

  const splitButton = document.getElementById("pop-split");
  const paneMenu = document.getElementById("pop-menu");
  let shellProfiles = [];
  let menuPane = 0;

  const closePaneMenu = () => {
    paneMenu.hidden = true;
  };

  /** Splitting is one click and no questions: side by side, running the same
   *  shell as the pane it came from. The shell is the pane's own business, and
   *  right-clicking its tab is where that is changed. */
  splitButton.onclick = async () => {
    if (panes.length > 1) {
      // Already split: the button folds it back up, which is the only other
      // thing it could sensibly mean.
      return closePane(1);
    }
    try {
      await openCompanion({ shell: current()?.profile || "auto", direction: "vertical" });
    } catch (error) {
      sayInTitle(String(error));
    }
  };

  /** The shells this computer has, asked for once. What is missing is greyed
   *  out rather than left out: a shell that is not installed is worth knowing
   *  about, and it says why on hover. */
  async function renderPaneMenu(index) {
    if (!shellProfiles.length) {
      shellProfiles = await invoke("term_shell_availability").catch(() => []);
    }
    const running = panes[index]?.profile;
    const rows = shellProfiles
      .filter((profile) => profile.profile !== "auto")
      .map((profile) => {
        const on = profile.profile === running;
        const note = on ? "<span>Running</span>" : profile.available === false ? "<span>Unavailable</span>" : "";
        return `<button role="menuitem" data-pane-shell="${profile.profile}"${profile.available === false || on ? " disabled" : ""}${profile.reason ? ` title="${profile.reason.replace(/"/g, "&quot;")}"` : ""}>${SHELL_LABELS[profile.profile] || profile.profile}${note}</button>`;
      })
      .join("");
    paneMenu.innerHTML = `<div class="pop-menu-label">Restart this pane with</div>${rows}`;
  }

  /** Opens the shell menu at the pointer, kept inside the window so a tab near
   *  the right edge does not put half of it off screen. */
  async function openPaneMenu(index, x, y) {
    if (!panes[index]) return;
    menuPane = index;
    await renderPaneMenu(index);
    paneMenu.hidden = false;
    const box = paneMenu.getBoundingClientRect();
    paneMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - box.width - 4))}px`;
    paneMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - box.height - 4))}px`;
  }

  paneMenu.onclick = async (e) => {
    const choice = e.target.closest("[data-pane-shell]");
    if (!choice || choice.disabled) return;
    closePaneMenu();
    await changePaneShell(menuPane, choice.dataset.paneShell);
  };

  // The pane tab when there is one, the window's own title when there is not:
  // a single terminal has no tab to right-click, and its titlebar is the same
  // thing by another name.
  document.addEventListener("contextmenu", (e) => {
    const tab = e.target.closest(".pop-pane-tab");
    const brand = e.target.closest(".titlebar .brand");
    if (!tab && !brand) return;
    e.preventDefault();
    const index = tab ? panes.findIndex((pane) => pane.el.contains(tab)) : activePane;
    openPaneMenu(index < 0 ? 0 : index, e.clientX, e.clientY);
  });

  document.addEventListener("pointerdown", (e) => {
    if (!paneMenu.hidden && !e.target.closest("#pop-menu")) closePaneMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePaneMenu();
  });

  /** Restarts one pane on a different shell, in the same folder and the same
   *  place on screen. The session behind it is a new one - a running shell
   *  cannot become another kind - so the old one is ended once the new one is
   *  attached, never before. */
  async function changePaneShell(index, shell) {
    const pane = panes[index];
    if (!pane || !shell || pane.profile === shell) return;
    const label = SHELL_LABELS[shell] || shell;
    let replacement = null;
    try {
      replacement = await invoke("term_open", { args: {
        projectPath: pane.info.projectPath,
        projectName: pane.info.projectName || "Terminal",
        shell,
      }});
      const previousId = pane.id;
      pane.view.dispose();
      pane.host.innerHTML = "";
      pane.id = replacement.id;
      pane.exited = false;
      pane.title = "";
      pane.view = new TermView(pane.host, replacement.id);
      pane.view.onTitle = (text) => { pane.title = text; renderPanes(); };
      pane.view.onExit = () => { pane.exited = true; renderPanes(); };
      pane.info = await pane.view.attach();
      pane.profile = shellProfileFromCommand(pane.info.command);
      await emit("term:popped-created", { info: pane.info }).catch(() => {});
      await emit("term:close-watch", { id: previousId }).catch(() => {});
      await emit("term:closed", { id: previousId }).catch(() => {});
      renderPanes();
      pane.view.fit();
      pane.view.focus();
    } catch (error) {
      // The half-opened session must not be left running with nothing showing
      // it, and the pane says what went wrong where it was asked for.
      if (replacement?.id && panes.every((item) => item.id !== replacement.id)) {
        await emit("term:closed", { id: replacement.id }).catch(() => {});
      }
      sayInTitle(`${label} couldn't start: ${error}`);
    }
  }

  /** Drag the divider to give one pane more room. Fitting both shells is left
   *  until the drag ends: a pseudoconsole resize per pointer move would be one
   *  round trip to Rust per frame, for a size nobody has settled on yet. */
  divider.addEventListener("pointerdown", (down) => {
    if (panes.length < 2) return;
    down.preventDefault();
    divider.setPointerCapture(down.pointerId);
    const move = (e) => {
      const rect = layout.getBoundingClientRect();
      const ratio = splitDirection === "horizontal"
        ? (e.clientY - rect.top) / rect.height
        : (e.clientX - rect.left) / rect.width;
      splitRatio = Math.min(.8, Math.max(.2, ratio));
      layout.style.setProperty("--pop-split", `${splitRatio * 100}%`);
    };
    const up = () => {
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
      for (const pane of panes) pane.view.fit();
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
  });

  /** A line the window says for a few seconds and then takes back - the
   *  console is not somewhere anyone is looking. */
  function sayInTitle(text) {
    const previous = subtitle.textContent;
    subtitle.textContent = text;
    setTimeout(() => { if (subtitle.textContent === text) subtitle.textContent = previous; }, 8000);
  }

  /* --------------------------------------------------------- wt commands */

  listen("term:wt-request", async (event) => {
    const request = event.payload;
    if (!request || !ownedIds().includes(request.termId)) return;
    if (!["new", "-1"].includes(request.window)) {
      if (request.maximized) await win.maximize().catch(() => {});
      if (request.fullscreen) await win.setFullscreen(true).catch(() => {});
      if (request.focus) await win.setFocus().catch(() => {});
      const values = (text) => String(text || "").split(",").map(Number);
      const [x, y] = values(request.position);
      const Position = window.__TAURI__.dpi?.LogicalPosition;
      if (Position && Number.isFinite(x) && Number.isFinite(y)) await win.setPosition(new Position(x, y)).catch(() => {});
      const [cols, rows] = values(request.dimensions);
      const Size = window.__TAURI__.dpi?.LogicalSize;
      if (Size && Number.isFinite(cols) && Number.isFinite(rows)) {
        await win.setSize(new Size(Math.max(400, cols * 9), Math.max(200, rows * 18))).catch(() => {});
      }
    }
    const asked = panes.findIndex((pane) => pane.id === request.termId);
    if (asked >= 0) activePane = asked;
    for (const action of request.actions || []) {
      if (action.kind === "focus-tab") {
        focusPane(action.target === 1 && companion() ? 1 : 0);
        continue;
      }
      if (action.kind === "move-focus") {
        const firstPane = ["left", "up", "first", "previous", "previousInOrder"].includes(action.direction);
        focusPane(firstPane || !companion() ? 0 : 1);
        continue;
      }
      if (action.kind === "swap-pane" && companion()) {
        panes.reverse();
        activePane = 1 - activePane;
        renderPanes();
        continue;
      }
      if (!["new-tab", "split-pane"].includes(action.kind)) continue;
      try {
        const source = current();
        const cwd = action.cwd || source?.info.projectPath || info.projectPath;
        const shell = action.duplicate ? (source?.profile || "auto") : profileShell(action.profile);
        const name = action.title || cwd.split(/[\\/]/).filter(Boolean).pop() || "Terminal";
        if (action.kind === "split-pane" && !companion()) {
          await openCompanion({
            shell,
            command: action.duplicate ? "" : action.command,
            cwd,
            name,
            direction: action.direction || "vertical",
            size: action.size,
          });
        } else {
          const next = await invoke("term_open", { args: {
            projectPath: cwd,
            projectName: name,
            ...(action.command && !action.duplicate ? { command: action.command } : {}),
            shell,
          }});
          await invoke("term_popout", {
            id: next.id, x: null, y: null, position: request.position || null,
            dimensions: request.dimensions || null, maximized: !!request.maximized,
            fullscreen: !!request.fullscreen, focus: request.focus !== false,
          });
          await emit("term:popped-created", { info: next }).catch(() => {});
        }
      } catch (error) {
        // The console is not somewhere anyone is looking. A pane that never
        // arrives says why in the window that was asked for it, and back in
        // the shell that asked, where a script can read it.
        const program = String(action.command || "").trim().match(/^"([^"]+)"|^(\S+)/);
        const named = program ? (program[1] || program[2]).split(/[\\/]/).pop() : "That command";
        // A program that is simply not here already says so in one sentence;
        // anything else needs to name what the pane was trying to do.
        const said = /is not installed/i.test(String(error))
          ? String(error)
          : `${/could not start/i.test(String(error)) ? `${named} couldn't start` : "That pane couldn't open"}: ${error}`;
        sayInTitle(said);
        if (request.token) await invoke("wt_report", { token: request.token, ok: false, message: String(error) }).catch(() => {});
        return;
      }
    }
    if (request.token) await invoke("wt_report", { token: request.token, ok: true, message: "" }).catch(() => {});
  });

  /* ----------------------------------------------------- window controls */

  document.getElementById("pop-debug").onclick = () => {
    navigator.clipboard.writeText(current().view.debugReport()).catch(() => {});
  };

  document.getElementById("pop-dock").onclick = async () => {
    await handOver();
    win.destroy();
  };

  // Staying on top is remembered per session, not per window: a terminal that
  // was pinned, docked and popped out again comes back pinned. The list is
  // this window's own key, so writing it can never tread on the settings the
  // main window keeps in its own.
  const ONTOP_KEY = "devhq.terminals.ontop.v1";
  const readPinned = () => {
    try {
      const list = JSON.parse(localStorage.getItem(ONTOP_KEY) || "[]");
      return Array.isArray(list) ? list.filter((value) => typeof value === "string") : [];
    } catch {
      return [];
    }
  };
  const writePinned = (list) => {
    try {
      localStorage.setItem(ONTOP_KEY, JSON.stringify(list));
    } catch {
      /* storage disabled - the window still pins, it just does not remember */
    }
  };

  const ontopButton = document.getElementById("pop-ontop");
  let onTop = readPinned().includes(id);
  const applyOnTop = async () => {
    ontopButton.classList.toggle("on", onTop);
    ontopButton.setAttribute("aria-pressed", String(onTop));
    ontopButton.title = onTop ? "Stop keeping this window on top" : "Keep this window on top";
    window.devhqI18n?.refresh(ontopButton);
    await win.setAlwaysOnTop(onTop).catch(() => {});
  };
  ontopButton.onclick = async () => {
    onTop = !onTop;
    const list = readPinned().filter((value) => value !== id);
    if (onTop) list.push(id);
    writePinned(list);
    await applyOnTop();
  };
  await applyOnTop();

  // Sessions that no longer exist would keep their pin for ever, so the list is
  // measured against the live ones whenever a window opens.
  invoke("term_list", {})
    .then((sessions) => {
      const live = new Set(sessions.map((session) => session.id));
      const kept = readPinned().filter((value) => live.has(value));
      if (kept.length !== readPinned().length) writePinned(kept);
    })
    .catch(() => {});

  // Dragging the titlebar moves the window and nothing else. Releasing it over
  // DevHQ's terminal area used to dock the terminal back in, which was never
  // reliable enough to aim at; the dock button beside it always was.
  document.querySelector(".titlebar .drag").addEventListener("pointerdown", async (e) => {
    if (e.button !== 0) return;
    await win.startDragging();
  });

  let pending;
  new ResizeObserver(() => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      for (const pane of panes) pane.view.fit();
      if (!pendingRestoreSettle) return;
      pendingRestoreSettle = false;
    }, 60);
  }).observe(layout);

  // Alt+F4 and anything else Windows counts as a close request mean the same
  // as the cross: the shell ends here.
  win.onCloseRequested(async (event) => {
    if (!closed && !handedOver) event.preventDefault();
    await finishClose();
  });
})();
