// A borderless window on Windows keeps the wide invisible resize border on its
// left, right and bottom, but along the top Tauri only leaves a strip one
// system frame tall - about four pixels - and right under it sits a title bar
// that drags the window instead. This lays a taller grab strip over the top
// edge, with corners, so resizing from the top is as easy as from the sides.
(() => {
  const win = window.__TAURI__?.window?.getCurrentWindow?.();
  if (!win || typeof win.startResizeDragging !== "function") return;

  const style = document.createElement("style");
  style.textContent = `
    .window-edge{position:fixed;top:0;height:7px;z-index:2147483647;-webkit-app-region:no-drag;app-region:no-drag;touch-action:none}
    .window-edge[hidden]{display:none}
    .window-edge-n{left:12px;right:12px;cursor:ns-resize}
    .window-edge-nw{left:0;width:12px;cursor:nwse-resize}
    .window-edge-ne{right:0;width:12px;cursor:nesw-resize}
  `;
  document.head.appendChild(style);

  const edges = [
    ["window-edge-nw", "NorthWest"],
    ["window-edge-n", "North"],
    ["window-edge-ne", "NorthEast"],
  ].map(([name, direction]) => {
    const edge = document.createElement("div");
    edge.className = `window-edge ${name}`;
    edge.hidden = true;
    edge.setAttribute("aria-hidden", "true");
    edge.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      win.startResizeDragging(direction).catch(() => {});
    });
    // Double clicking the top edge does nothing rather than reaching the title
    // bar beneath, which would maximize the window out from under the pointer.
    edge.addEventListener("dblclick", (event) => event.stopPropagation());
    return edge;
  });

  // Only while there is an edge to pull: not maximized, not fixed in size, and
  // not when Windows is drawing its own frame (WinT's native-frame setting).
  let pending = 0;
  const refresh = () => {
    const ticket = ++pending;
    Promise.all([win.isMaximized(), win.isResizable(), win.isDecorated()])
      .then(([maximized, resizable, decorated]) => {
        if (ticket !== pending) return;
        const show = resizable && !maximized && !decorated;
        for (const edge of edges) edge.hidden = !show;
      })
      .catch(() => {});
  };

  const mount = () => {
    for (const edge of edges) document.body.appendChild(edge);
    refresh();
    // Turning the native frame on or off toggles a class on the body and does
    // not always resize the window.
    let wasNative = document.body.classList.contains("native-frame");
    new MutationObserver(() => {
      const isNative = document.body.classList.contains("native-frame");
      if (isNative === wasNative) return;
      wasNative = isNative;
      refresh();
    }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });

  // A drag resize fires this every frame; one look per frame is plenty.
  let frame = 0;
  win.onResized(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      refresh();
    });
  }).catch(() => {});
})();

// Every frameless window's title bar - `.titlebar .drag`, or a header marked
// `data-drag-region` - moves the window when dragged and maximizes or restores
// it when double clicked, as a native caption does. It is one listener here
// rather than one per page because a drag started on the first click swallows
// the dblclick event, so each page that wired its own never heard the second
// click. The second mousedown still arrives, counted in `detail`, and that is
// what is read. Buttons, fields and the corner icon (double click closes) in
// the bar keep their own clicks.
(() => {
  const win = window.__TAURI__?.window?.getCurrentWindow?.();
  if (!win || typeof win.startDragging !== "function") return;
  const BAR = ".titlebar .drag, [data-drag-region]";
  const OWN_CLICKS = "button, a, input, select, textarea, [contenteditable], [data-maturity], .brand img, .brand-close";
  document.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || !event.target.closest?.(BAR) || event.target.closest(OWN_CLICKS)) return;
    if (event.detail === 2) {
      event.preventDefault();
      Promise.all([win.isResizable(), win.isMaximizable()])
        .then(([resizable, maximizable]) => (resizable && maximizable ? win.toggleMaximize() : null))
        .catch(() => {});
      return;
    }
    if (event.detail === 1) win.startDragging().catch(() => {});
  });
})();
