(() => {
const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;
const ds = { host: null, drives: [], drive: null, path: "", items: [], scanning: false, scanId: null, scanToken: "", history: [], skipped: 0, error: "", wired: false, loadingDrives: false };
const TRANSFER_KEY = "wint.disk-space.popout.v1";
let popoutHandoff = false;
let leavePrompt = null;
window.addEventListener("storage", (event) => {
  if (event.key === TRANSFER_KEY && event.newValue === null) popoutHandoff = false;
});
try {
  const transfer = JSON.parse(localStorage.getItem(TRANSFER_KEY) || "null");
  if (transfer && Date.now() - transfer.savedAt < 30000) {
    Object.assign(ds, transfer.state, { host: null, wired: false, loadingDrives: false });
    localStorage.removeItem(TRANSFER_KEY);
  }
} catch (_) { /* A fresh tool state is safe if storage is unavailable. */ }
const icon = (name) => window.wintShell?.icon(name) || `<span class="ms">${name}</span>`;
const esc = (value) => window.wintShell?.esc(value) || String(value ?? "");
const dirty = () => window.wintShell?.markDirty("disk-space");
function saveTransfer() {
  if (!popoutHandoff) return;
  try {
    localStorage.setItem(TRANSFER_KEY, JSON.stringify({ savedAt: Date.now(), state: {
      drives: ds.drives, drive: ds.drive, path: ds.path, items: ds.items,
      scanning: ds.scanning, scanId: ds.scanId, scanToken: ds.scanToken,
      history: ds.history, skipped: ds.skipped, error: ds.error,
    } }));
  } catch (_) { /* The pop-out can still open with an empty state. */ }
}
const bytes = (n) => {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 2 ? 1 : 0)} ${units[i]}`;
};

function treemap(items) {
  const rects = new Map();
  const place = (group, x, y, width, height) => {
    if (!group.length) return;
    if (group.length === 1) { rects.set(group[0].path, { x, y, width, height }); return; }
    const total = group.reduce((sum, item) => sum + Math.max(1, item.bytes), 0);
    let split = 1, running = Math.max(1, group[0].bytes), best = Math.abs(total / 2 - running);
    for (let i = 1; i < group.length; i += 1) {
      running += Math.max(1, group[i].bytes);
      const distance = Math.abs(total / 2 - running);
      if (distance > best) break;
      best = distance; split = i + 1;
    }
    const first = group.slice(0, split), second = group.slice(split);
    const ratio = first.reduce((sum, item) => sum + Math.max(1, item.bytes), 0) / total;
    if (width >= height) {
      place(first, x, y, width * ratio, height); place(second, x + width * ratio, y, width * (1 - ratio), height);
    } else {
      place(first, x, y, width, height * ratio); place(second, x, y + height * ratio, width, height * (1 - ratio));
    }
  };
  place(items, 0, 0, 100, 100);
  return rects;
}

async function opened() {
  if (!ds.wired) await wire();
  if (ds.drives.length || ds.loadingDrives) return;
  ds.loadingDrives = true;
  ds.error = "";
  dirty();
  window.wintWork?.beginWork("disk-drives", "Reading available drives");
  try { ds.drives = await invoke("disk_space_drives"); }
  catch (error) { ds.error = String(error); }
  ds.loadingDrives = false;
  window.wintWork?.endWork("disk-drives");
  dirty();
}

async function wire() {
  ds.wired = true;
  await listen("disk-space:item", ({ payload }) => {
    if (!ds.scanning || payload.token !== ds.scanToken) return;
    if (ds.scanId === null) ds.scanId = payload.scanId;
    ds.items.push(payload.item);
    ds.items.sort((a, b) => b.bytes - a.bytes);
    window.wintWork?.updateWork("disk-scan", `${ds.items.length} areas measured · ${bytes(ds.items.reduce((n, x) => n + x.bytes, 0))}`);
    dirty();
    saveTransfer();
  });
  await listen("disk-space:done", ({ payload }) => {
    if (!ds.scanning || payload.token !== ds.scanToken) return;
    ds.scanning = false;
    ds.scanId = payload.scanId;
    ds.error = payload.error || "";
    if (payload.result) { ds.items = payload.result.children; ds.path = payload.result.path; ds.skipped = payload.result.skipped; }
    window.wintWork?.endWork("disk-scan");
    dirty();
    saveTransfer();
  });
}

async function scan(path, push = true) {
  // Drilling into a completed box should not wait for the rest of its parent.
  // Starting the new native scan advances the scan generation and causes the
  // previous workers to stop at their next filesystem entry.
  if (ds.scanning) {
    ds.scanning = false;
    ds.scanId = null;
    ds.scanToken = "";
    window.wintWork?.endWork("disk-scan");
  }
  if (push && ds.path) ds.history.push(ds.path);
  ds.path = path; ds.items = []; ds.skipped = 0; ds.error = ""; ds.scanning = true; ds.scanId = null;
  ds.scanToken = `${Date.now()}-${Math.random()}`;
  window.wintWork?.beginWork("disk-scan", `Scanning ${path}`, "measuring folders as they appear");
  dirty();
  try { const id = await invoke("disk_space_scan_start", { path, token: ds.scanToken }); if (ds.scanId === null) ds.scanId = id; }
  catch (error) { ds.scanning = false; ds.error = String(error); window.wintWork?.endWork("disk-scan"); dirty(); }
}

function cancelScan() {
  if (!ds.scanning) return;
  ds.scanning = false;
  ds.scanId = null;
  ds.scanToken = "";
  invoke("disk_space_scan_cancel").catch(() => {});
  window.wintWork?.endWork("disk-scan");
}

function confirmLeave() {
  if (popoutHandoff) return true;
  if (!ds.scanning) return true;
  if (leavePrompt) return leavePrompt;
  const canPopOut = !window.wintShell?.isToolPopped?.("disk-space");
  const ask = window.wintConfirm
    ? window.wintConfirm({
        title: "Stop scanning this drive?",
        message: canPopOut
          ? "Disk Space Usage is still measuring folders. Keep it open in its own window, stay here, or stop the scan."
          : "Disk Space Usage is still measuring folders. Leaving now will stop the scan and discard its unfinished results.",
        confirmLabel: "Stop and leave",
        cancelLabel: "Keep scanning",
        alternateLabel: canPopOut ? "Pop out & continue" : "",
        icon: "scan_delete",
        tone: "danger",
      })
    : Promise.resolve(window.confirm("Stop the active disk scan and leave?"));
  leavePrompt = ask.then((choice) => {
    if (choice === "alternate") {
      window.wintShell?.popOutTool?.("disk-space");
      return true;
    }
    if (choice) cancelScan();
    return choice;
  }).finally(() => { leavePrompt = null; });
  return leavePrompt;
}

function preparePopout() {
  popoutHandoff = true;
  saveTransfer();
}

function choose(path) {
  ds.drive = ds.drives.find((drive) => drive.path === path) || null;
  ds.history = [];
  scan(path, false);
}

function render() {
  if (!ds.host) return;
  const measured = ds.items.reduce((sum, item) => sum + item.bytes, 0);
  const rects = treemap(ds.items);
  const driveOptions = ds.drives.map((drive) => `<button type="button" class="disk-drive" data-disk-drive="${esc(drive.path)}">
    <span>${icon("hard_drive")}<strong>${esc(drive.label)}</strong></span><b>${bytes(drive.totalBytes - drive.freeBytes)} used</b>
    <i><em style="width:${drive.totalBytes ? ((drive.totalBytes - drive.freeBytes) / drive.totalBytes) * 100 : 0}%"></em></i><small>${bytes(drive.freeBytes)} free of ${bytes(drive.totalBytes)}</small></button>`).join("");
  const tiles = ds.items.map((item, index) => {
    const rect = rects.get(item.path) || { x: 0, y: 0, width: 0, height: 0 };
    const tiny = rect.width * rect.height < 80;
    return `<button class="disk-tile tone-${index % 8}${tiny ? " tiny" : ""}" style="left:${rect.x}%;top:${rect.y}%;width:${rect.width}%;height:${rect.height}%" type="button" data-disk-path="${esc(item.path)}" data-disk-dir="${item.isDir}" title="${esc(item.path)} · ${bytes(item.bytes)}">
      <span>${icon(item.isDir ? "folder" : "draft")}<strong>${esc(item.name)}</strong></span><b>${bytes(item.bytes)}</b></button>`;
  }).join("");
  ds.host.innerHTML = `<header class="tool-head"><button class="btn back tool-back" type="button" data-open-tool="overview">${icon("arrow_back")}Back</button><span class="tool-plate">${icon("hard_drive")}</span><span class="tool-title"><strong>Disk Space Usage</strong><small>choose a drive, then click any folder to drill down</small></span><button class="tool-popout" type="button" data-popout-tool="disk-space"></button><button class="tool-pin" type="button" data-pin-tool="disk-space"></button><button class="tool-close" type="button" data-open-tool="overview">${icon("close")}</button></header>
    ${!ds.drive ? `<section class="disk-choose"><div><span class="disk-hero">${icon("donut_large")}</span><h2>Choose one drive to scan</h2><p>Nothing is read until you choose. Areas will appear in the diagram while the scan is still running.</p></div><div class="disk-drives">${driveOptions || (ds.loadingDrives ? `<div class="disk-loading">${icon("progress_activity")}<span><strong>Reading available drives…</strong><small>Asking Windows which local disks are ready.</small></span></div>` : `<div class="disk-empty"><p>${esc(ds.error || "No fixed or removable drives were found.")}</p><button class="btn" type="button" data-disk-retry>${icon("refresh")}Retry</button></div>`)}</div></section>` : `<section class="disk-work"><div class="disk-toolbar"><button class="btn" data-disk-back ${ds.history.length ? "" : "disabled"}>${icon("arrow_upward")}Up</button><span class="disk-path mono">${esc(ds.path)}</span><span class="disk-total">${ds.scanning ? `${icon("progress_activity")} Scanning · ` : ""}${ds.items.length} items · ${bytes(measured)}</span><button class="btn" data-disk-change>${icon("swap_horiz")}Drive</button></div>
      ${ds.error ? `<div class="disk-error">${icon("error")} ${esc(ds.error)}</div>` : ""}
      <div class="disk-treemap ${ds.scanning ? "scanning" : ""}">${tiles}${!ds.scanning && !tiles ? `<div class="disk-empty">This folder is empty, or its contents could not be read.</div>` : ""}</div>
      <footer class="disk-foot"><span>${icon("mouse")}Click a folder to open it</span><span>${icon("right_click")}Right-click any area to Reveal in Explorer</span>${ds.skipped ? `<span>${icon("warning")}${ds.skipped} protected areas skipped</span>` : ""}${ds.scanning ? `<span class="disk-scan-status"><i></i>Measuring ${esc(ds.path)}</span>` : ""}</footer></section>`}`;
  const pin = ds.host.querySelector('.tool-pin[data-pin-tool="disk-space"]');
  const pop = ds.host.querySelector('.tool-popout[data-popout-tool="disk-space"]');
  if (pin) {
    const on = !!window.wintShell?.isToolPinned?.("disk-space");
    pin.classList.toggle("on", on); pin.setAttribute("aria-pressed", String(on));
    pin.innerHTML = `${icon("push_pin")}${on ? "Pinned" : "Pin to dock"}`;
  }
  if (pop) {
    const out = !!window.wintShell?.isToolPopped?.("disk-space");
    pop.classList.toggle("on", out);
    pop.innerHTML = `${icon("open_in_new")}${out ? "Show window" : "Pop out"}`;
  }
}

function mount(host) {
  ds.host = host;
  host.addEventListener("click", (event) => {
    const pop = event.target.closest("[data-popout-tool]");
    const pin = event.target.closest("[data-pin-tool]");
    const go = event.target.closest("[data-open-tool]");
    if (pop) return window.wintShell?.popOutTool?.(pop.dataset.popoutTool);
    if (pin) return window.wintShell?.toggleToolPin?.(pin.dataset.pinTool);
    if (go) return window.wintShell?.openTool?.(go.dataset.openTool);
    const drive = event.target.closest("[data-disk-drive]");
    const tile = event.target.closest("[data-disk-path]");
    if (drive) choose(drive.dataset.diskDrive);
    else if (event.target.closest("[data-disk-retry]")) opened();
    else if (tile?.dataset.diskDir === "true") scan(tile.dataset.diskPath);
    else if (event.target.closest("[data-disk-change]")) { cancelScan(); ds.drive = null; ds.path = ""; ds.items = []; ds.history = []; dirty(); }
    else if (event.target.closest("[data-disk-back]") && ds.history.length) scan(ds.history.pop(), false);
  });
  host.addEventListener("contextmenu", (event) => {
    const tile = event.target.closest("[data-disk-path]");
    if (!tile) return;
    event.preventDefault();
    document.querySelector(".disk-context")?.remove();
    const menu = document.createElement("button"); menu.type = "button"; menu.className = "disk-context"; menu.innerHTML = `${icon("folder_open")}Reveal in Explorer`;
    menu.style.left = `${event.clientX}px`; menu.style.top = `${event.clientY}px`;
    menu.onclick = () => { invoke("open_in", { path: tile.dataset.diskPath, target: "reveal" }); menu.remove(); };
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
  });
  render();
}

function exportState(){return {drives:ds.drives,drive:ds.drive,path:ds.path,items:ds.items,scanning:ds.scanning,scanId:ds.scanId,scanToken:ds.scanToken,history:ds.history,skipped:ds.skipped,error:ds.error};}
// `scanning` joins `loadingDrives` here for the same reason: it describes a
// scan running in a webview that has gone, whose progress events can never
// arrive, so restoring it true shows a scan that will never finish.
function importState(state){if(!state)return;Object.assign(ds,state,{host:ds.host,wired:ds.wired,loadingDrives:false,scanning:false});if(ds.host)render();}
window.wintDiskSpace = { mount, render, opened, confirmLeave, preparePopout, exportState, importState };
})();
