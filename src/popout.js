// The popped-out terminal window. It attaches to a session that already exists
// in Rust, so nothing restarts when a terminal moves between here and the
// DevHQ panel — a running build keeps running.

(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const emit = window.__TAURI__.event.emit;
  const win = window.__TAURI__.window.getCurrentWindow();

  const id = new URLSearchParams(location.search).get("id");
  const host = document.getElementById("pop-term");

  document.querySelectorAll("[data-win]").forEach((btn) => {
    btn.onclick = () => {
      const act = btn.dataset.win;
      if (act === "min") win.minimize();
      else if (act === "max") win.toggleMaximize();
      else win.close();
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
  document.title = `${info.projectName} — Terminal`;
  view.fit();
  view.focus();

  // Docking is the mirror of popping out: tell DevHQ to take the session back
  // into its panel, and this window's job is done.
  //
  // It must be said exactly once. DevHQ answers "docked" by closing this
  // window, and a close handled as a close request would announce a dock of its
  // own - two windows telling each other to dock, round and round, with this
  // one too busy to repaint. The flag closes that loop, and `destroy` leaves
  // without raising a close request nobody needs to hear.
  let handedOver = false;
  const handOver = async () => {
    if (handedOver) return;
    handedOver = true;
    await emit("term:docked", { id });
  };

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

  // A closed window would otherwise leave the session running with no view.
  // The session belongs to the project, not the window, so it is handed back
  // to DevHQ rather than killed.
  win.onCloseRequested(async () => {
    await handOver();
  });
})();
