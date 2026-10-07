// The stand-in for `window.__TAURI__` that lets WinT's `terminal.js` run in a
// VS Code webview unchanged.
//
// `invoke` posts to the extension and resolves with its reply. Session events
// arrive from the extension as the JSON line the host wrote, and are handed to
// whatever `listen`ed for that name - `term:update`, `term:exit` - exactly as
// Tauri would have delivered them.

(() => {
  const vscode = acquireVsCodeApi();
  const pending = new Map();
  const listeners = new Map();
  let seq = 0;

  function dispatch(name, payload) {
    for (const callback of listeners.get(name) || []) {
      try { callback({ event: name, payload }); } catch (error) { console.error(error); }
    }
  }

  window.addEventListener("message", (e) => {
    const message = e.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "reply") {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error !== undefined) waiting.reject(new Error(message.error));
      else waiting.resolve(message.ok);
      return;
    }
    if (message.type === "event") {
      let line;
      try { line = JSON.parse(message.raw); } catch { return; }
      dispatch(line.event, line.payload);
      return;
    }
    // Everything else is for the panel itself.
    window.dispatchEvent(new CustomEvent("wint-panel", { detail: message }));
  });

  window.__TAURI__ = {
    core: {
      invoke(cmd, args = {}) {
        const id = ++seq;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          vscode.postMessage({ type: "invoke", id, cmd, args });
        });
      },
    },
    event: {
      listen(name, callback) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(callback);
        return Promise.resolve(() => listeners.get(name)?.delete(callback));
      },
      // Inside WinT this tells the other windows about a new terminal theme.
      // There are no other windows here.
      emit() {
        return Promise.resolve();
      },
    },
    window: {
      getCurrentWindow: () => ({ label: "vscode" }),
    },
  };
})();
