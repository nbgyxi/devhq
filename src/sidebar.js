// The docked sidebar.
//
// The window's position and size are the shell's business, not this page's:
// Rust registers it as an appbar and Windows tells it where to be. All this
// page does is draw the rail and ask the backend to change edge or to undock.
(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;

  const geometry = document.querySelector("[data-geometry]");
  let state = { docked: true, edge: "left", width: 200, taskbarAutoHidden: false };

  function paint() {
    document.body.dataset.edge = state.edge;
    geometry.innerHTML = `<span>${state.edge}</span><code>${state.width} dip</code><span>${state.taskbarAutoHidden ? "taskbar hidden" : "taskbar as-is"}</span>`;
    const taskbar = document.querySelector("[data-action=taskbar]");
    taskbar.querySelector(".ms").textContent = state.taskbarAutoHidden ? "visibility" : "visibility_off";
    taskbar.querySelector("small").textContent = state.taskbarAutoHidden ? "Show taskbar" : "Hide taskbar";
  }

  async function ask(command, args) {
    try {
      state = await invoke(command, args);
      paint();
    } catch (error) {
      geometry.textContent = String(error);
    }
  }

  // A launcher that fails says so on its own label for a few seconds, rather
  // than leaving a click that seemed to do nothing.
  function flash(button, error) {
    const label = button.querySelector("small");
    if (!label) return;
    const text = label.dataset.text || label.textContent;
    label.dataset.text = text;
    label.textContent = String(error || "Failed");
    button.title = label.textContent;
    clearTimeout(button.flashTimer);
    button.flashTimer = setTimeout(() => { label.textContent = text; button.title = ""; }, 4000);
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "start") return invoke("sidebar_start_menu").catch(() => {});
    if (action === "close") return ask("sidebar_close");
    if (action === "taskbar") return toggleTaskbar();
    if (action === "tray") return invoke("sidebar_hidden_icons").catch((error) => flash(button, error));
    if (action === "edge") return ask("sidebar_configure", { edge: state.edge === "left" ? "right" : "left" });
    // The rest open WinT's own windows; the sidebar is only the launcher.
    if (action === "search") return invoke("search_show", {}).catch(() => {});
    if (action === "terminal") return openTerminal(button);
    if (action === "clipboard") return invoke("clipboard_picker_show", {}).catch(() => {});
    if (action === "focus") return invoke("focus_mode_toggle").catch((error) => flash(button, error));
    // Tool shortcuts always open in a window of their own. The main window
    // owns the pop-out handoff, so it is asked to do it.
    if (action === "tool") {
      return window.__TAURI__.event.emit("sidebar:open-tool", { id: button.dataset.tool })
        .catch((error) => flash(button, error));
    }
  });

  // The Focus mode button shows whether it is holding windows back, whether
  // the press came from here, the shortcut or the tool.
  function paintFocus(focus) {
    const button = document.querySelector("[data-action=focus]");
    const hidden = focus?.hidden || 0;
    button.classList.toggle("active", hidden > 0);
    button.querySelector(".ms").textContent = hidden ? "visibility" : "shield_lock";
    const label = button.querySelector("small");
    label.textContent = hidden ? `Show ${hidden} hidden` : "Focus mode";
    delete label.dataset.text;
    button.title = focus?.message || (hidden ? "Bring the hidden windows back" : "Hide the windows your Focus mode rules pick");
  }
  window.__TAURI__.event.listen("focus-mode:state", (event) => {
    paintFocus(event.payload);
    refreshWindows();
  });
  invoke("focus_mode_state").then(paintFocus, () => {});

  // Starting a shell and building its window takes a moment; the label says so.
  async function openTerminal(button) {
    if (button.disabled) return;
    const label = button.querySelector("small");
    const text = label.textContent;
    button.disabled = true;
    label.textContent = "Opening terminal";
    try {
      await invoke("sidebar_open_terminal");
      label.textContent = text;
    } catch (error) {
      label.textContent = text;
      flash(button, error);
    } finally {
      button.disabled = false;
    }
  }

  // ---- settings ----------------------------------------------------------------
  // Kept by the backend and changed from the Docked Sidebar tool page. That page
  // runs in an isolated webview with storage of its own, so every change
  // reaches this rail as a `sidebar:settings` event, the moment it is made.
  const DEFAULT_SETTINGS = {
    slots: { brand: true, start: true, clipboard: true, focus: true, network: true, windows: true, geometry: true, trayapps: true, tray: true, taskbar: true, edge: true, close: true },
    textSize: 10,
    iconSize: 22,
    hideTaskbar: true,
    // [{ id, name, icon }], in the order they were added. Name and icon are
    // kept with the id so the rail can draw them without the tool catalog.
    tools: [],
  };
  let settings = DEFAULT_SETTINGS;

  function applySettings(saved) {
    settings = {
      ...DEFAULT_SETTINGS,
      ...(saved || {}),
      slots: { ...DEFAULT_SETTINGS.slots, ...(saved?.slots || {}) },
    };
    for (const slot of document.querySelectorAll("[data-slot]")) {
      slot.hidden = settings.slots[slot.dataset.slot] === false;
    }
    // With no window list to fill the middle, the bottom buttons still belong
    // at the bottom.
    document.querySelector("[data-spacer]").hidden = settings.slots.windows !== false;
    paintTools();
    paintTray();
    document.documentElement.style.setProperty("--bar-text", `${settings.textSize}px`);
    document.documentElement.style.setProperty("--bar-icon", `${settings.iconSize}px`);
  }

  const toolsBox = document.querySelector("[data-tools]");
  let toolsDrawn = "";
  function paintTools() {
    const tools = Array.isArray(settings.tools) ? settings.tools.filter((tool) => tool?.id) : [];
    const key = JSON.stringify(tools);
    if (key === toolsDrawn) return;
    toolsDrawn = key;
    toolsBox.hidden = !tools.length;
    toolsBox.replaceChildren(...tools.map((tool) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bar-slot";
      button.dataset.action = "tool";
      button.dataset.tool = tool.id;
      button.title = `Open ${tool.name || tool.id} in its own window`;
      const glyph = document.createElement("span");
      glyph.className = "ms";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = tool.icon || "build";
      const label = document.createElement("small");
      label.textContent = tool.name || tool.id;
      button.append(glyph, label);
      return button;
    }));
  }

  window.__TAURI__.event.listen("sidebar:settings", (event) => applySettings(event.payload));
  invoke("sidebar_settings").then(applySettings, () => {});

  // The taskbar button flips the same setting the tool page's checkbox does,
  // and saves it, so the next dock remembers the choice.
  async function toggleTaskbar() {
    const hide = !state.taskbarAutoHidden;
    await ask("sidebar_configure", { hideTaskbar: hide });
    applySettings({ ...settings, hideTaskbar: hide });
    invoke("sidebar_settings_set", { settings }).catch(() => {});
  }

  // ---- open windows ----------------------------------------------------------
  // The rail is also a taskbar. Rows are keyed by window handle and patched in
  // place, so a refresh never rebuilds a button under the pointer. A window
  // keeps its place once it has one; only a drag moves it.
  //
  // The order outlives the windows. Each row has a key made of what the window
  // is (its AppUserModelID, which is one per browser profile, or its exe) and
  // which of that app's windows it is, and the dragged order of keys is saved.
  // A window that opens later takes the place its key had last time.
  const list = document.querySelector("[data-windows]");
  const rows = new Map();
  const REFRESH_MS = 1000;
  const ORDER_KEY = "wint.sidebar.order";
  const ORDER_LIMIT = 200;

  let order = [];
  try { order = JSON.parse(localStorage.getItem(ORDER_KEY) || "[]"); } catch (_) { order = []; }
  if (!Array.isArray(order)) order = [];

  function saveOrder() {
    const shown = [...list.querySelectorAll("[data-window]")].map((button) => button.dataset.key);
    // Apps that are closed right now keep their remembered places.
    order = [...shown, ...order.filter((key) => !shown.includes(key))].slice(0, ORDER_LIMIT);
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(order)); } catch (_) { /* order lasts this run */ }
  }

  function keyFor(win) {
    let n = 0;
    for (const entry of rows.values()) if (entry.app === win.app) n += 1;
    return `${win.app.toLowerCase()}#${n}`;
  }

  /** Where a new row goes: before the first row that comes after it in the
   *  saved order, or at the end when its key has never been placed. */
  function placeNew(button) {
    const rank = order.indexOf(button.dataset.key);
    let before = list.querySelector(".skeleton");
    if (rank !== -1) {
      for (const other of list.querySelectorAll("[data-window]")) {
        const otherRank = order.indexOf(other.dataset.key);
        if (otherRank === -1 || otherRank > rank) { before = other; break; }
      }
    }
    list.insertBefore(button, before);
  }

  // Each window's own icon, asked for when it first appears and again when its
  // title changes - that is when apps swap icons (a document opened, a call
  // started). A stale answer for an older title is dropped.
  function loadIcon(id, entry) {
    const asked = entry.label.textContent;
    invoke("sidebar_window_icon", { id })
      .catch(() => null)
      .then((url) => {
        if (!url || rows.get(id) !== entry || entry.label.textContent !== asked) return;
        entry.img.src = url;
        entry.img.hidden = false;
        entry.glyph.hidden = true;
      });
  }

  function row(win) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bar-win";
    button.dataset.window = win.id;
    button.dataset.key = keyFor(win);
    const img = document.createElement("img");
    img.alt = "";
    img.hidden = true;
    img.draggable = false;
    const glyph = document.createElement("span");
    glyph.className = "ms";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = "window";
    const label = document.createElement("small");
    button.append(img, glyph, label);
    return { button, img, glyph, label, app: win.app };
  }

  function paintWindows(windows) {
    const seen = new Set(windows.map((win) => win.id));
    for (const [id, entry] of rows) {
      if (!seen.has(id)) {
        entry.button.remove();
        rows.delete(id);
      }
    }
    for (const win of windows) {
      let entry = rows.get(win.id);
      if (!entry) {
        entry = row(win);
        rows.set(win.id, entry);
        placeNew(entry.button);
      }
      const { button, label } = entry;
      if (label.textContent !== win.title) {
        label.textContent = win.title;
        button.title = win.title;
        loadIcon(win.id, entry);
      }
      button.classList.toggle("active", win.active);
      button.classList.toggle("minimized", win.minimized);
    }
    list.querySelector(".skeleton")?.remove();
  }

  let refreshing = false;
  async function refreshWindows() {
    if (refreshing || moving) return;
    refreshing = true;
    try {
      paintWindows(await invoke("sidebar_windows"));
    } catch {
      // A failed read leaves the last good list up; the next tick retries.
    } finally {
      refreshing = false;
    }
  }

  // ---- reordering by drag -----------------------------------------------------
  // Pointer events, not HTML drag and drop: Tauri claims native drags for file
  // drops. A press becomes a drag only after the pointer has moved a few
  // pixels, so an ordinary click still switches windows.
  const DRAG_START_PX = 5;
  let press = null;
  let moving = null;
  let swallowClick = false;

  list.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("[data-window]");
    if (!button || event.button !== 0) return;
    press = { button, y: event.clientY, pointer: event.pointerId };
  });

  list.addEventListener("pointermove", (event) => {
    if (!press) return;
    if (!moving) {
      if (Math.abs(event.clientY - press.y) < DRAG_START_PX) return;
      moving = press.button;
      moving.setPointerCapture(press.pointer);
      moving.classList.add("dragging");
      document.body.classList.add("reordering");
    }
    // Slide the row past any neighbour whose middle the pointer has crossed.
    // Always move the neighbour, never the dragged row: moving the row out of
    // the DOM drops its pointer capture and ends the drag after one step.
    const next = moving.nextElementSibling;
    const prev = moving.previousElementSibling;
    if (next?.dataset.window && event.clientY > next.getBoundingClientRect().top + next.offsetHeight / 2) {
      list.insertBefore(next, moving);
    } else if (prev?.dataset.window && event.clientY < prev.getBoundingClientRect().top + prev.offsetHeight / 2) {
      list.insertBefore(prev, moving.nextElementSibling);
    }
    // Near the ends of a list that scrolls, keep it scrolling.
    const box = list.getBoundingClientRect();
    if (event.clientY < box.top + 24) list.scrollTop -= 8;
    else if (event.clientY > box.bottom - 24) list.scrollTop += 8;
  });

  function endPress() {
    if (moving) {
      moving.classList.remove("dragging");
      document.body.classList.remove("reordering");
      moving = null;
      swallowClick = true;
      // A click only follows a release over the same row; clear the flag in
      // case this one never comes.
      setTimeout(() => { swallowClick = false; }, 0);
      saveOrder();
    }
    press = null;
  }
  list.addEventListener("pointerup", endPress);
  list.addEventListener("pointercancel", endPress);
  list.addEventListener("lostpointercapture", endPress);

  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-window]");
    if (!button) return;
    if (swallowClick) { swallowClick = false; return; }
    invoke("sidebar_activate", { id: button.dataset.window })
      .catch(() => {})
      .finally(refreshWindows);
  });

  // ---- right-click menu -------------------------------------------------------
  // The taskbar's own right-click, approximated: the app's name starts another
  // copy of it, then the window's minimize / restore / maximize and close. It
  // is a native popup, so it is not clipped to the width of the rail.
  const { Menu, MenuItem, PredefinedMenuItem, Submenu } = window.__TAURI__.menu;

  function windowCommand(button, id, command) {
    return invoke("sidebar_window_command", { id, command })
      .catch((error) => flash(button, error))
      .finally(refreshWindows);
  }

  list.addEventListener("contextmenu", async (event) => {
    const button = event.target.closest("[data-window]");
    if (!button) return;
    event.preventDefault();
    const id = button.dataset.window;
    let info, recent;
    try {
      [info, recent] = await Promise.all([
        invoke("sidebar_window_menu", { id }),
        invoke("sidebar_window_recent", { id }).catch(() => []),
      ]);
    } catch (error) {
      flash(button, error);
      return;
    }
    const app = rows.get(id)?.app;
    const siblings = [...rows].filter(([, entry]) => entry.app === app).map(([other]) => other);
    // A single "&" in a native menu marks the underlined access key.
    const item = (text, action, enabled = true) => MenuItem.new({ text: text.replaceAll("&", "&&"), enabled, action });
    const items = [];
    // Recent files and folders sit on top, as in the taskbar's jump list.
    if (recent.length) {
      items.push(await item("Recent", () => {}, false));
      for (const entry of recent) {
        items.push(await item(entry.name, () =>
          invoke("sidebar_launch_new", { id, path: entry.path }).catch((error) => flash(button, error))));
      }
      items.push(await PredefinedMenuItem.new({ item: "Separator" }));
    }
    items.push(
      await item(info.name || "New window", () =>
        invoke("sidebar_launch_new", { id }).catch((error) => flash(button, error)), info.canLaunch),
      await PredefinedMenuItem.new({ item: "Separator" }),
      info.minimized
        ? await item("Restore", () => windowCommand(button, id, "restore"))
        : await item("Minimize", () => windowCommand(button, id, "minimize")),
      await item("Maximize", () => windowCommand(button, id, "maximize")),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await item("Close window", () => windowCommand(button, id, "close")),
    );
    if (siblings.length > 1) {
      items.push(await item(`Close all ${siblings.length} windows`, () => {
        for (const other of siblings) windowCommand(rows.get(other)?.button || button, other, "close");
      }));
    }
    const menu = await Menu.new({ items });
    await menu.popup();
  });

  // ---- suggested apps ---------------------------------------------------------
  // Right-clicking anywhere else on the rail opens a context menu: the dock's
  // settings, then the apps Windows' launch history says are likely to be
  // wanted next, each with its own icon. A native menu cannot show a spinner
  // or change once it is open, so the list and its icons are read ahead of
  // time and kept fresh in the background; the right-click only builds the
  // menu from what is already here.
  const { IconMenuItem } = window.__TAURI__.menu;
  const SUGGEST_REFRESH_MS = 60_000;
  let suggestions = null;
  let suggestLoading = null;

  function dataUrlBytes(url) {
    const base64 = url?.split(",")[1];
    if (!base64) return null;
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  }

  function loadSuggestions() {
    suggestLoading ??= (async () => {
      const apps = await invoke("sidebar_suggestions").catch(() => []);
      const icons = await Promise.all(apps.map((app) =>
        invoke("sidebar_suggest_icon", { target: app.target }).catch(() => null)));
      suggestions = apps.map((app, index) => ({ ...app, icon: dataUrlBytes(icons[index]) }));
    })().finally(() => { suggestLoading = null; });
    return suggestLoading;
  }

  let suggesting = false;
  document.addEventListener("contextmenu", async (event) => {
    event.preventDefault();
    if (event.target.closest("[data-window]") || suggesting) return;
    suggesting = true;
    try {
      // Only the very first right-click, before the first read is back, waits.
      if (!suggestions) await loadSuggestions();
      const text = (value) => value.replaceAll("&", "&&");
      const items = [
        await MenuItem.new({ text: "Dock settings", action: () =>
          window.__TAURI__.event.emit("sidebar:open-settings").catch(() => {}) }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await MenuItem.new({ text: "Suggested apps", enabled: false }),
      ];
      if (!suggestions.length) items.push(await MenuItem.new({ text: "Nothing to suggest yet", enabled: false }));
      for (const app of suggestions) {
        const action = () => invoke("sidebar_suggest_launch", { target: app.target })
          .catch((error) => { geometry.textContent = String(error); })
          .finally(loadSuggestions);
        items.push(app.icon
          ? await IconMenuItem.new({ text: text(app.name), icon: app.icon, action })
          : await MenuItem.new({ text: text(app.name), action }));
      }
      const menu = await Menu.new({ items });
      await menu.popup();
    } finally {
      suggesting = false;
    }
  });

  loadSuggestions();
  setInterval(() => { if (!document.hidden) loadSuggestions(); }, SUGGEST_REFRESH_MS);

  // ---- the notification area ------------------------------------------------------
  // The rail's own tray. It reads the way the real one does: a row of icons
  // with no names, the network first, and a chevron that opens the rest into a
  // named list. The icons Windows promotes onto its taskbar are the ones shown
  // while it is closed.
  //
  // Everything the menus need is read on a timer and kept here, because a
  // native menu cannot show a spinner or change once it is open.
  const trayBox = document.querySelector("[data-tray-apps]");
  const TRAY_REFRESH_MS = 15_000;
  const NET_REFRESH_MS = 10_000;
  const CONNECTIONS_REFRESH_MS = 20_000;
  const WIFI_REFRESH_MS = 20_000;
  const NET_GLYPH = { wifi: "wifi", wired: "lan", offline: "public_off" };
  // WinT's own tools that are about the network, for the menu's last section.
  const NET_TOOLS = [
    ["ports", "Ports and processes"],
    ["dns", "DNS"],
    ["hosts", "Hosts file"],
    ["network", "Packet capture"],
    ["path-ping", "Path and ping"],
    ["startup", "Startup and tray"],
  ];

  // Icons are keyed by program, not by window: the handle changes between
  // reads, the icon does not.
  const trayIcons = new Map();
  let trayApps = null;
  let trayLoading = null;
  let trayExpanded = false;
  let trayDrawn = "";
  let netStatus = { kind: "offline", name: "" };
  let wifiNetworks = [];
  let connections = null;
  let connectionsLoading = null;

  /// A line in the readout at the foot of the rail, put back after a moment.
  /// The rail is too narrow for an error on an icon.
  function say(text) {
    geometry.textContent = String(text);
    clearTimeout(say.timer);
    say.timer = setTimeout(paint, 4000);
  }

  function netDetail() {
    return [
      netStatus.signal ? `${netStatus.signal}% signal` : "",
      netStatus.ipv4 ? `IP ${netStatus.ipv4}` : "",
      netStatus.gateway ? `gateway ${netStatus.gateway}` : "",
    ].filter(Boolean).join(" · ");
  }

  function tile(kind, glyph, iconUrl, label, title) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = trayExpanded ? "bar-win" : "bar-win icon-only";
    button.dataset[kind] = "";
    button.title = title;
    if (iconUrl) {
      const img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      img.src = iconUrl;
      button.append(img);
    } else {
      const span = document.createElement("span");
      span.className = "ms";
      span.setAttribute("aria-hidden", "true");
      span.textContent = glyph;
      button.append(span);
    }
    if (trayExpanded) {
      const small = document.createElement("small");
      small.textContent = label;
      button.append(small);
    }
    return button;
  }

  function paintTray() {
    const showNetwork = settings.slots.network !== false;
    const showApps = settings.slots.trayapps !== false;
    // Every icon shows either way: what the chevron opens is the names, not
    // more of the tray. A rail that hid half of them would be answering a
    // question nobody asked — the tray is there to be glanced at whole.
    const shown = showApps && trayApps ? trayApps : [];

    trayBox.hidden = !showNetwork && !apps.length;
    trayBox.classList.toggle("expanded", trayExpanded);
    const key = JSON.stringify([
      trayExpanded, showNetwork, netStatus.kind, netStatus.name,
      shown.map((app) => [app.id, app.name, !!trayIcons.get(app.exe)]),
    ]);
    if (key === trayDrawn) return;
    trayDrawn = key;

    const items = [];
    if (showNetwork) {
      const detail = netDetail();
      items.push(tile(
        "trayNetwork",
        NET_GLYPH[netStatus.kind] || "public_off",
        null,
        netStatus.name || "No network",
        detail ? `${netStatus.name} — ${detail}` : "No network",
      ));
    }
    for (const app of shown) {
      items.push(tile("trayApp", "web_asset", trayIcons.get(app.exe), app.name, app.name));
    }
    if (shown.length) {
      const more = tile(
        "trayMore",
        trayExpanded ? "expand_less" : "expand_more",
        null,
        "Icons only",
        trayExpanded ? "Back to icons only" : `Name all ${shown.length} of them`,
      );
      more.classList.add("chevron");
      items.push(more);
    }
    for (const [index, app] of shown.entries()) {
      items[index + (showNetwork ? 1 : 0)].dataset.trayApp = app.id;
      items[index + (showNetwork ? 1 : 0)].dataset.trayExe = app.exe;
    }
    trayBox.replaceChildren(...items);
  }

  // ---- what the menus are built from ---------------------------------------------
  function refreshNetwork() {
    return invoke("sidebar_network").then((status) => {
      netStatus = status;
      paintTray();
    }, () => {});
  }

  function loadWifi() {
    return invoke("sidebar_wifi_networks").then((found) => { wifiNetworks = found; }, () => {});
  }

  function loadConnections() {
    connectionsLoading ??= invoke("sidebar_connections")
      .then((rows) => { connections = rows; }, () => { connections ??= []; })
      .finally(() => { connectionsLoading = null; });
    return connectionsLoading;
  }

  function loadTrayApps() {
    trayLoading ??= (async () => {
      const apps = await invoke("sidebar_tray_apps").catch(() => []);
      // An icon is read once per program and kept; only a program never seen
      // before costs a call.
      await Promise.all(apps.map(async (app) => {
        if (trayIcons.has(app.exe)) return;
        const url = await invoke("sidebar_window_icon", { id: app.id }).catch(() => null);
        if (url) trayIcons.set(app.exe, url);
      }));
      trayApps = apps;
      paintTray();
    })().finally(() => { trayLoading = null; });
    return trayLoading;
  }

  // ---- the network menu ------------------------------------------------------------
  // A menu row that is only there to be read.
  const note = (text) => MenuItem.new({ text: text.replaceAll("&", "&&"), enabled: false });
  const act = (text, action) => MenuItem.new({ text: text.replaceAll("&", "&&"), action });

  let networkMenuOpen = false;
  async function openNetworkMenu() {
    if (networkMenuOpen) return;
    networkMenuOpen = true;
    try {
      // Only the very first click, before the first read is back, waits.
      if (!connections) await loadConnections();
      const items = [await note(netStatus.name || "No network")];
      const detail = netDetail();
      if (detail) items.push(await note(detail));
      items.push(await PredefinedMenuItem.new({ item: "Separator" }));

      // Wi-Fi: what is in range, and the one we are on.
      if (wifiNetworks.length) {
        items.push(await note("Wi-Fi"));
        for (const network of wifiNetworks.slice(0, 12)) {
          const marks = [`${network.signal}%`];
          if (network.secured) marks.push("secured");
          if (!network.known) marks.push("not saved");
          const text = `${network.connected ? "• " : "   "}${network.ssid}  (${marks.join(", ")})`;
          items.push(await act(text, () => {
            if (network.connected) return;
            // A network Windows has no profile for needs a password, which
            // belongs in Windows' own flyout, not in a sidebar.
            const call = network.known
              ? invoke("sidebar_wifi_connect", { ssid: network.ssid })
              : invoke("sidebar_wifi_picker");
            say(network.known ? `Joining ${network.ssid}` : "Opening the Wi-Fi list");
            call.catch((error) => say(error)).finally(() => {
              setTimeout(() => { refreshNetwork(); loadWifi(); }, 1500);
            });
          }));
        }
        const connected = wifiNetworks.some((network) => network.connected);
        if (connected) {
          items.push(await act("Disconnect", () => {
            say("Disconnecting");
            invoke("sidebar_wifi_disconnect")
              .catch((error) => say(error))
              .finally(() => { refreshNetwork(); loadWifi(); });
          }));
        }
        items.push(await act("Other networks and settings…", () =>
          invoke("sidebar_wifi_picker").catch((error) => say(error))));
        items.push(await PredefinedMenuItem.new({ item: "Separator" }));
      }

      // Who is using the connection, tucked away so the menu stays short.
      const rows = await Promise.all(connections.slice(0, 25).map((connection) => {
        const text = `${connection.process} → ${connection.remote}`
          + (connection.count > 1 ? ` ×${connection.count}` : "");
        // A connection whose program has a window jumps to it; the rest are
        // background services with nothing to bring forward.
        return connection.window
          ? act(text, () => invoke("sidebar_activate", { id: connection.window })
              .catch(() => {})
              .finally(refreshWindows))
          : note(text);
      }));
      items.push(await Submenu.new({
        text: `Open connections (${connections.length})`,
        enabled: rows.length > 0,
        items: rows,
      }));
      items.push(await Submenu.new({
        text: "Network tools",
        items: await Promise.all(NET_TOOLS.map(([id, name]) => act(name, () =>
          window.__TAURI__.event.emit("sidebar:open-tool", { id }).catch((error) => say(error))))),
      }));

      const menu = await Menu.new({ items });
      await menu.popup();
    } catch (error) {
      say(error);
    } finally {
      networkMenuOpen = false;
      // The lists a menu was just built from are the stalest they will ever be.
      loadConnections();
      loadWifi();
    }
  }

  // Right-clicking an icon does what right-clicking a tray icon does: the few
  // things worth doing to the program behind it. Its own tray menu is out of
  // reach — Windows keeps those callbacks to Explorer — so this is WinT's own
  // short version of it.
  trayBox.addEventListener("contextmenu", async (event) => {
    const button = event.target.closest("[data-tray-app]");
    if (!button) return;
    event.preventDefault();
    const { trayApp: id, trayExe: exe } = button.dataset;
    const name = button.title || "this app";
    const items = [
      await act("Show it", () => invoke("sidebar_reveal", { id, exe })
        .catch((error) => say(error))
        .finally(refreshWindows)),
      await act("Close it", () => invoke("startup_close", { exe })
        .then(say, say)
        .finally(() => { refreshWindows(); loadTrayApps(); })),
      await PredefinedMenuItem.new({ item: "Separator" }),
      // Where the rest of it lives: what starts it, and the switch for it.
      await act("Startup and tray…", () =>
        window.__TAURI__.event.emit("sidebar:open-tool", { id: "startup" }).catch((error) => say(error))),
    ];
    const menu = await Menu.new({ items: [await note(name), await PredefinedMenuItem.new({ item: "Separator" }), ...items] });
    await menu.popup();
  });

  trayBox.addEventListener("click", (event) => {
    if (event.target.closest("[data-tray-more]")) {
      trayExpanded = !trayExpanded;
      paintTray();
      return;
    }
    if (event.target.closest("[data-tray-network]")) return openNetworkMenu();
    const button = event.target.closest("[data-tray-app]");
    if (!button) return;
    invoke("sidebar_reveal", { id: button.dataset.trayApp, exe: button.dataset.trayExe })
      .catch((error) => say(error))
      .finally(refreshWindows);
  });

  refreshNetwork();
  loadWifi();
  loadConnections();
  loadTrayApps();
  setInterval(() => { if (!document.hidden) refreshNetwork(); }, NET_REFRESH_MS);
  setInterval(() => { if (!document.hidden) loadWifi(); }, WIFI_REFRESH_MS);
  setInterval(() => { if (!document.hidden) loadConnections(); }, CONNECTIONS_REFRESH_MS);
  setInterval(() => { if (!document.hidden) loadTrayApps(); }, TRAY_REFRESH_MS);

  // ---- dragging the width ------------------------------------------------------
  // The grip sits on the inner edge. Re-docking moves the work area and every
  // maximized window with it, so it happens once, when the pointer is let go.
  // While dragging, the grip's badge shows the width that will be applied.
  // The pointer is captured, so moves still arrive once it leaves the window.
  const grip = document.querySelector("[data-grip]");
  const badge = document.querySelector("[data-grip-badge]");
  let drag = null;

  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    grip.setPointerCapture(event.pointerId);
    drag = { x: event.screenX, width: state.width, want: state.width };
    badge.textContent = `${state.width} dip`;
    document.body.classList.add("resizing");
    event.preventDefault();
  });

  grip.addEventListener("pointermove", (event) => {
    if (!drag) return;
    // screenX is in DIPs, the same unit the width is kept in.
    const delta = event.screenX - drag.x;
    drag.want = Math.round(Math.min(480, Math.max(48, drag.width + (state.edge === "right" ? -delta : delta))));
    badge.textContent = `${drag.want} dip`;
  });

  function endDrag() {
    if (!drag) return;
    const want = drag.want;
    drag = null;
    document.body.classList.remove("resizing");
    if (want !== state.width) ask("sidebar_configure", { width: want });
  }
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);
  grip.addEventListener("lostpointercapture", endDrag);

  // The Docked Sidebar tool page can change the edge or width too.
  window.__TAURI__.event.listen("sidebar:state", (event) => { state = event.payload; paint(); });
  ask("sidebar_state");
  refreshWindows();
  setInterval(() => {
    if (!document.hidden && !list.hidden) refreshWindows();
  }, REFRESH_MS);
})();
