// What a window is left in, reported to the one place that keeps it.
//
// A window reopens the size it was left, on the screen it was left on, and
// maximized if it was maximized. The backend applies that while the window is
// built and fits it to the monitors that exist at the time; the measuring can
// only be done here, in the page that owns the window.
//
// It goes to the backend and not to `localStorage`, which WebView2 flushes to
// disk on a schedule of its own — a window resized and closed in the same
// breath lost the new size every time.
//
// Values are **physical** pixels. Logical ones cannot be compared against a
// monitor on a mixed-DPI desktop, and comparing against monitors is the whole
// reason the backend keeps these.
(() => {
  const invoke = window.__TAURI__.core.invoke;

  // Windows resizes and moves in a loop of its own, so these fire constantly
  // while a window is dragged. Only where it comes to rest matters.
  const SETTLE = 250;

  /**
   * Starts reporting one window's shape.
   *
   * @param {object} win     the window, from `getCurrentWindow()`
   * @param {string} scope   which kind of window: `tool-window`,
   *                         `workspace-window` or `terminal-window`
   * @param {string} name    which one within that kind — the tool id, the
   *                         project path, or `popout` for a terminal
   * @returns {{save: () => Promise<void>, stop: () => void}}
   */
  function track(win, scope, name) {
    if (!win || !scope || !name) return { save: async () => {}, stop: () => {} };
    let timer = 0;
    let last = null;
    let stopped = false;

    const save = async () => {
      if (stopped) return;
      try {
        const maximized = await win.isMaximized().catch(() => false);
        const minimized = await win.isMinimized().catch(() => false);
        const geometry = { ...(last || {}), maximized, minimized, units: "physical" };
        // While maximized or minimized the size and place kept are the
        // *restored* ones, so un-maximizing a reopened window lands on the box
        // it had before rather than on a screen-sized one.
        if (!maximized && !minimized) {
          const size = await win.innerSize();
          const position = await win.outerPosition();
          // A minimize Windows has not finished reporting reads as a window of
          // no size in the far corner. Keeping that would lose the real box.
          if (size.width > 0 && size.height > 0) {
            geometry.width = Math.round(size.width);
            geometry.height = Math.round(size.height);
            geometry.x = Math.round(position.x);
            geometry.y = Math.round(position.y);
          }
        }
        if (JSON.stringify(geometry) === JSON.stringify(last)) return;
        last = geometry;
        await invoke("window_remember_geometry", { scope, name, geometry });
      } catch {
        // A window that cannot be measured simply reopens at the default.
      }
    };

    const queue = () => {
      clearTimeout(timer);
      timer = setTimeout(save, SETTLE);
    };

    // Nothing is saved on load: the window the backend just placed is still
    // settling — a restored maximize arrives as a resize of its own — and a
    // page that saved first would write the un-maximized state back over the
    // one it was given.
    win.onResized(() => queue()).catch(() => {});
    win.onMoved(() => queue()).catch(() => {});

    return {
      // For the way out, while there is still a window to measure: the last
      // move may be sitting in the debounce.
      save: async () => {
        clearTimeout(timer);
        await save();
      },
      stop: () => {
        stopped = true;
        clearTimeout(timer);
      },
    };
  }

  window.wintWindowGeometry = { track };
})();
