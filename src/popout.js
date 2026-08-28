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
  const handOver = async () => {
    if (handedOver || closed) return;
    handedOver = true;
    await emit("term:docked", { id });
  };

  // Closing is not docking. The cross ends the shell, the way the cross on a
  // tab in the panel does; only the dock button and a drag onto the panel hand
  // the session back. DevHQ is told so it can forget the terminal instead of
  // reopening it on the next launch.
  const closeSession = async () => {
    if (handedOver || closed) return;
    closed = true;
    await invoke("term_close", { id }).catch(() => {});
    await emit("term:closed", { id }).catch(() => {});
  };

  document.querySelectorAll("[data-win]").forEach((btn) => {
    btn.onclick = async () => {
      const act = btn.dataset.win;
      if (act === "min") win.minimize();
      else if (act === "max") win.toggleMaximize();
      else {
        // Ending the shell first, then leaving without a close request: the
        // request handler is for Alt+F4, and running both would race.
        await closeSession();
        win.destroy();
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
  win.onCloseRequested(async () => {
    await closeSession();
  });
})();
