// The popped-out terminal window. It attaches to a session that already exists
// in Rust, so nothing restarts when a terminal moves between here and the
// DevHQ panel — a running build keeps running.

(async () => {
  window.devhqTrackPageView?.("/terminal");
  const invoke = window.__TAURI__.core.invoke;
  const emit = window.__TAURI__.event.emit;
  const listen = window.__TAURI__.event.listen;
  const win = window.__TAURI__.window.getCurrentWindow();

  const id = new URLSearchParams(location.search).get("id");
  const host = document.getElementById("pop-term");

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
  let shuttingDown = false;
  let shutdownTimer = 0;
  let shutdownEscalationTimer = 0;
  const handOver = async () => {
    if (handedOver || closed) return;
    handedOver = true;
    await emit("term:docked", { id });
  };

  // Closing is not docking. The cross ends the shell, the way the cross on a
  // tab in the panel does; only the dock button and a drag onto the panel hand
  // the session back. DevHQ is told so it can forget the terminal instead of
  // reopening it on the next launch.
  const gracefulCloseEnabled = () => {
    try {
      const prefs = JSON.parse(localStorage.getItem("devhq.terminals.v1") || "{}");
      return prefs.gracefulClose !== false;
    } catch {
      return true;
    }
  };

  const neverWaitFor = (commandName) => {
    if (!commandName) return false;
    try {
      const prefs = JSON.parse(localStorage.getItem("devhq.terminals.v1") || "{}");
      return Array.isArray(prefs.neverWaitFor) && prefs.neverWaitFor.includes(commandName);
    } catch {
      return false;
    }
  };

  const finishClose = async () => {
    if (handedOver || closed) return;
    closed = true;
    clearTimeout(shutdownTimer);
    clearTimeout(shutdownEscalationTimer);
    await emit("term:close-watch", { id }).catch(() => {});
    await emit("term:closed", { id }).catch(() => {});
    await win.destroy().catch(() => {});
  };

  const waitForInterrupt = () => {
    if (!shuttingDown || closed) return;
    if (view.isAtPrompt()) return finishClose();
    shutdownTimer = setTimeout(waitForInterrupt, 100);
  };

  const closeSession = async (force = false) => {
    if (handedOver || closed || shuttingDown) return;
    const commandName = view.runningCommandName();
    if (commandName && neverWaitFor(commandName)) return finishClose();
    if (force || !gracefulCloseEnabled() || info?.alive === false) return finishClose();
    shuttingDown = true;
    const dialog = document.getElementById("pop-shutdown");
    dialog.querySelector("strong").textContent = "Closing…";
    dialog.querySelector("p").textContent = "Giving the terminal a moment to finish safely.";
    dialog.querySelector("#pop-interrupt-again").hidden = true;
    dialog.querySelector("#pop-close-now").hidden = true;
    const neverWait = document.getElementById("pop-never-wait");
    neverWait.hidden = !commandName;
    document.getElementById("pop-never-wait-name").textContent = commandName;
    const neverWaitInput = document.getElementById("pop-never-wait-input");
    neverWaitInput.dataset.commandName = commandName;
    neverWaitInput.checked = neverWaitFor(commandName);
    dialog.hidden = false;
    shutdownEscalationTimer = setTimeout(() => {
      if (!shuttingDown || closed) return;
      dialog.querySelector("strong").textContent = "Shutting down";
      dialog.querySelector("p").textContent = "The terminal is taking longer than expected to finish…";
      dialog.querySelector("#pop-interrupt-again").hidden = false;
      dialog.querySelector("#pop-close-now").hidden = false;
    }, 3000);
    await invoke("term_write", { id, data: "\u0003" })
      .then(() => new Promise((resolve) => setTimeout(resolve, 75)))
      .then(() => shuttingDown && !closed ? invoke("term_write", { id, data: "\u0003" }) : undefined)
      .catch(() => finishClose());
    if (shuttingDown && !closed) waitForInterrupt();
  };

  const cancelShutdown = () => {
    if (!shuttingDown || closed) return;
    clearTimeout(shutdownTimer);
    clearTimeout(shutdownEscalationTimer);
    shuttingDown = false;
    document.getElementById("pop-shutdown").hidden = true;
    view?.focus();
  };

  document.querySelectorAll("[data-win]").forEach((btn) => {
    btn.onclick = async () => {
      const act = btn.dataset.win;
      if (act === "min") win.minimize();
      else if (act === "max") win.toggleMaximize();
      else {
        // The window stays up while Ctrl+C is being handled; finishClose uses
        // destroy so this click cannot race the native close request.
        await closeSession();
      }
    };
  });

  if (!id) {
    host.textContent = "No terminal id.";
    return;
  }

  const view = new TermView(host, id);
  view.onTitle = (t) => {
    document.getElementById("pop-title").textContent = t;
  };
  view.onExit = () => {
    document.getElementById("pop-title").textContent = "exited";
    if (shuttingDown) finishClose();
  };

  let info;
  try {
    info = await view.attach();
  } catch (e) {
    host.textContent = String(e);
    return;
  }
  document.getElementById("pop-project").textContent = info.projectName;
  const marker = document.getElementById("pop-shell");
  const markerProfile = (() => {
    const command = String(info.command || "").toLowerCase();
    if (command.includes("git\\bin\\bash.exe")) return "git-bash";
    if (command.includes("7-preview\\pwsh.exe")) return "pwsh-preview";
    if (command.includes("pwsh.exe")) return "pwsh";
    if (command.includes("wsl.exe") || command.startsWith("wsl")) return "wsl";
    if (command.includes("powershell.exe") || command.startsWith("powershell")) return "powershell";
    if (command.includes("cmd.exe") || command.startsWith("cmd")) return "cmd";
    if (command.includes("nu.exe") || command.startsWith("nu")) return "nu";
    return "auto";
  })();
  const markerCodes = { auto: "SH", pwsh: "PW7", "pwsh-preview": "PWP", powershell: "PS", cmd: "CMD", "git-bash": "GIT", wsl: "WSL", nu: "NU" };
  const markerLabels = { auto: "Terminal", pwsh: "PowerShell 7", "pwsh-preview": "PowerShell Preview", powershell: "Windows PowerShell", cmd: "Command Prompt", "git-bash": "Git Bash", wsl: "WSL Bash", nu: "NuShell" };
  const markerDefaults = { auto: "#42b3c2", pwsh: "#4d9df5", "pwsh-preview": "#c162de", powershell: "#61afef", cmd: "#8cc265", "git-bash": "#e05561", wsl: "#d5a458", nu: "#c162de" };
  const applyMarkers = (next) => {
    const style = ["none", "dot", "code"].includes(next?.style) ? next.style : "code";
    document.body.classList.remove("shell-markers-none", "shell-markers-dot", "shell-markers-code");
    document.body.classList.add(`shell-markers-${style}`);
    const color = next?.colors?.[markerProfile] || markerDefaults[markerProfile];
    if (/^#[0-9a-f]{6}$/i.test(color)) document.documentElement.style.setProperty(`--shell-color-${markerProfile}`, color);
    marker.className = `shell-mark shell-${markerProfile}`;
    marker.textContent = markerCodes[markerProfile];
    marker.title = markerLabels[markerProfile];
    marker.hidden = false;
  };
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
  view.fit();
  view.focus();

  document.getElementById("pop-dock").onclick = async () => {
    await handOver();
    win.destroy();
  };
  document.getElementById("pop-close-now").onclick = () => {
    if (shuttingDown) {
      shuttingDown = false;
      finishClose();
    }
  };
  document.getElementById("pop-shutdown-cancel").onclick = cancelShutdown;
  document.getElementById("pop-interrupt-again").onclick = () => {
    if (shuttingDown && !closed) invoke("term_write", { id, data: "\u0003" }).catch(() => {});
  };
  document.getElementById("pop-never-wait-input").onchange = (event) => {
    const commandName = event.target.dataset.commandName;
    if (!commandName) return;
    try {
      const prefs = JSON.parse(localStorage.getItem("devhq.terminals.v1") || "{}");
      const names = new Set(Array.isArray(prefs.neverWaitFor) ? prefs.neverWaitFor : []);
      if (event.target.checked) names.add(commandName);
      else names.delete(commandName);
      prefs.neverWaitFor = [...names];
      localStorage.setItem("devhq.terminals.v1", JSON.stringify(prefs));
      emit("term:never-wait", { name: commandName, enabled: event.target.checked }).catch(() => {});
    } catch {}
  };
  document.getElementById("pop-shutdown").onclick = (event) => {
    if (event.target.id === "pop-shutdown") cancelShutdown();
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

  // Native window dragging keeps movement smooth. Once Windows releases the
  // drag, report the pointer's physical screen position; DevHQ accepts it only
  // when it lands on the terminal dock.
  document.querySelector(".titlebar .drag").addEventListener("pointerdown", async (e) => {
    if (e.button !== 0) return;
    const grabX = e.clientX;
    const grabY = e.clientY;
    await win.startDragging();
    if (handedOver) return;
    const pos = await win.outerPosition();
    const scale = window.devicePixelRatio || 1;
    await emit("term:drop", {
      id,
      x: pos.x + grabX * scale,
      y: pos.y + grabY * scale,
    });
  });

  let pending;
  new ResizeObserver(() => {
    clearTimeout(pending);
    pending = setTimeout(() => view.fit(), 60);
  }).observe(host);

  // Alt+F4 and anything else Windows counts as a close request mean the same
  // as the cross: the shell ends here.
  win.onCloseRequested(async (event) => {
    if (!closed && !handedOver) event.preventDefault();
    await closeSession();
  });
})();
