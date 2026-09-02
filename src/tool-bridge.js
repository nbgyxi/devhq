// DevHQ isolated tool protocol v1. This is the only API a tool renderer gets
// from the parent shell. Requests are correlated and session-scoped.
(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;
  const emit = window.__TAURI__.event.emit;
  const listen = window.__TAURI__.event.listen;
  const query = new URLSearchParams(location.search);
  const id = query.get("id") || "";
  const session = query.get("session") || "";
  const pending = new Map();
  let sequence = 0, context = null, api = null, persistTimer = 0, awake = true, persistLoop = 0;
  const responseListening = listen("tool:bridge-response", (event) => {
    const response = event.payload || {};
    if (response.session !== session) return;
    const waiter = pending.get(response.requestId);
    if (!waiter) return;
    pending.delete(response.requestId);
    response.ok ? waiter.resolve(response.value) : waiter.reject(new Error(response.error || "Tool bridge request failed."));
  });
  listen("tool:bridge-command", async (event) => {
    const command = event.payload || {};
    if (command.session !== session) return;
    let ok = true, error = "";
    try {
      if (command.action === "persist") await persist();
      // The shell now keeps the last few tools alive after you leave them, so
      // a tool can be running with nothing on screen. Suspend is what stops
      // that being a tool polling forever behind your back - destroying the
      // webview used to do it for free. Anything the user explicitly started,
      // like a packet capture or a log tail, is left to keep running.
      else if (command.action === "suspend") setAwake(false);
      else if (command.action === "resume") setAwake(true);
      else throw new Error(`Unknown shell command: ${command.action}`);
    } catch (caught) { ok = false; error = String(caught); }
    await emit("tool:bridge-command-result", { session, commandId: command.commandId, ok, error }).catch(() => {});
  });
  function request(action, value = null, timeout = 15000) {
    const requestId = `${session}:${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Tool bridge timed out: ${action}`)); }, timeout);
      pending.set(requestId, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
      emit("tool:bridge-request", { session, requestId, action, value }).catch(reject);
    });
  }
  const ready = responseListening.then(() => request("context")).then((value) => { context = value; return value; });
  const icon = (name) => `<span class="ms" aria-hidden="true">${name}</span>`;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  async function persist() {
    clearTimeout(persistTimer);
    const state = api?.exportState?.(id);
    if (state !== undefined) await invoke("tool_bridge_state_put", { id, state }).catch(() => {});
  }
  function schedulePersist() { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 250); }
  /** Awake means visible. Asleep, the tool stops its own automatic polling and
   *  the bridge stops its save timer; one last save happens on the way down so
   *  nothing is lost if the shell evicts it while it sleeps. */
  function setAwake(next) {
    if (awake === next) return;
    awake = next;
    if (awake) {
      persistLoop = setInterval(() => { persist().catch(() => {}); }, 2000);
      api?.resume?.(id);
    } else {
      clearInterval(persistLoop);
      persistLoop = 0;
      api?.suspend?.(id);
      persist().catch(() => {});
    }
  }
  window.devhqToolBridge = {
    protocol: 1, id, session, ready, request, context: () => context,
    attach(nextApi) { api = nextApi; }, persist,
    takeState: () => invoke("tool_bridge_state_take", { id }).catch(() => null),
    reportReady: () => request("ready"),
  };
  window.devhqShell = {
    icon, esc,
    markDirty(...regions) { api?.render?.(...regions); schedulePersist(); },
    isToolPinned: (toolId) => toolId === id && context?.pinned === true,
    isToolPopped: (toolId) => toolId === id && context?.popped === true,
    async toggleToolPin() { const result = await request("toggle-pin"); if (context) context.pinned = result?.pinned === true; api?.render?.(); },
    openTool: (toolId) => request("navigate", toolId), popOutTool: () => request("pop-out"),
    projects: () => (context?.projects || []).map((project) => ({ ...project })),
  };
  window.devhqConfirm = (options) => request("confirm", options);
  window.devhqWork = { beginWork() {}, updateWork() {}, endWork() {} };
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const editing = target instanceof Element && (target.matches("input,textarea,select") || target.isContentEditable);
    const controlSearch = event.ctrlKey && !event.altKey && ["k", "f"].includes(event.key.toLowerCase());
    const commandSearch = event.key === ">" && !event.ctrlKey && !event.altKey && !editing;
    if (!controlSearch && !commandSearch) return;
    event.preventDefault();
    request("search", commandSearch ? { initialQuery: "> " } : null).catch(() => {});
  });
  persistLoop = setInterval(() => { persist().catch(() => {}); }, 2000);
  window.addEventListener("pagehide", () => { persist().catch(() => {}); });
})();
