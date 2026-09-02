(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;
  const PREFIX = "wint.tool-handoff.v1:";
  const dbReady = new Promise((resolve) => {
    const request = indexedDB.open("wint-tool-handoff", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("states");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  async function dbPut(key, value) { const db=await dbReady;if(!db)return false;return new Promise((resolve)=>{const request=db.transaction("states","readwrite").objectStore("states").put(value,key);request.onsuccess=()=>resolve(true);request.onerror=()=>resolve(false);}); }
  async function dbTake(key) { const db=await dbReady;if(!db)return null;return new Promise((resolve)=>{const store=db.transaction("states","readwrite").objectStore("states");const request=store.get(key);request.onsuccess=()=>{const value=request.result||null;store.delete(key);resolve(value);};request.onerror=()=>resolve(null);}); }
  const apiFor = (id) => {
    if (id === "ports") return window.wintPortsTool || window.wintPortsState;
    if (id === "dns") return window.wintDns;
    if (id === "hosts") return window.wintHosts;
    if (id === "network") return window.wintNetwork;
    if (id === "path-ping") return window.wintPathPing;
    if (id === "disk-space") return window.wintDiskSpace;
    if (id === "github") return window.wintGithub;
    if (id === "git") return window.wintGit;
    if (window.wintUtilTools?.byId?.(id)) return window.wintUtilTools;
    if (window.wintWindowsTools?.catalog?.().some((tool) => tool.id === id)) return window.wintWindowsTools;
    return null;
  };
  async function send(id) {
    const state = apiFor(id)?.exportState?.(id);
    if (state === undefined) return false;
    // Rust storage crosses isolated WebView2 data directories. Keep the old
    // browser handoff as compatibility for builds/windows without the bridge.
    if (await invoke("tool_bridge_state_put", { id, state }).then(() => true).catch(() => false)) return true;
    const transfer={ savedAt:Date.now(), state },key=`${PREFIX}${id}`;
    try { localStorage.setItem(key,JSON.stringify(transfer)); return true; }
    catch (_) { return dbPut(key,transfer); }
  }
  async function receive(id) {
    const bridged = await invoke("tool_bridge_state_take", { id }).catch(() => null);
    if (bridged) { apiFor(id)?.importState?.(bridged, id); return true; }
    const key = `${PREFIX}${id}`;
    let transfer;
    try { transfer = JSON.parse(localStorage.getItem(key) || "null"); localStorage.removeItem(key); }
    catch (_) { /* try the larger IndexedDB handoff */ }
    if(!transfer)transfer=await dbTake(key);
    if (!transfer || Date.now() - transfer.savedAt > 60000) return false;
    apiFor(id)?.importState?.(transfer.state, id);
    return true;
  }
  window.wintToolState = { send, receive };
})();
