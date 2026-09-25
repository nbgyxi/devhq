// The docked sidebar.
//
// The window's position and size are the shell's business, not this page's:
// Rust registers it as an appbar and Windows tells it where to be. All this
// page does is draw the rail and ask the backend to change edge or to undock.
(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;

  // ---- state the rail must not lose --------------------------------------------
  // The order of the rows, the pinned apps and the dividers are all things the
  // user arranged by hand, so losing one of them is losing work. WebView2
  // writes `localStorage` to disk when it gets round to it, which means a row
  // dragged shortly before the rail went away was simply gone on the next
  // start — the rail "forgetting the order" is mostly that. All three are kept
  // by the backend instead, fsynced before the write answers. Whatever an
  // older WinT left in `localStorage` is read once, handed to the backend and
  // then never read again.
  const ORDER_KEY = "wint.sidebar.order";
  const PINS_KEY = "wint.sidebar.pins";
  const DIVIDERS_KEY = "wint.sidebar.dividers";

  /// The lists as last read or written, by key. Empty until `restoreRail`.
  const savedLists = new Map([[ORDER_KEY, []], [PINS_KEY, []], [DIVIDERS_KEY, []]]);
  /// Until the backend has answered, nothing is drawn: a row placed against an
  /// empty order would be placed wrongly and then saved there.
  let savedReady = false;

  async function loadSavedLists() {
    await Promise.all([...savedLists.keys()].map(async (key) => {
      let value = await invoke("ui_state_get", { key }).catch(() => null);
      if (!Array.isArray(value)) {
        try { value = JSON.parse(localStorage.getItem(key) || "null"); } catch (_) { value = null; }
        // Moved over as it is found, so the next start reads it from the file
        // even if nothing on the rail is touched this run.
        if (Array.isArray(value)) invoke("ui_state_set", { key, value }).catch(() => {});
      }
      savedLists.set(key, Array.isArray(value) ? value : []);
    }));
    savedReady = true;
  }

  // Rows open and close in bursts, and each save is a file written all the way
  // to the platter, so the writes are coalesced into one per key.
  const saveTimers = new Map();
  function saveList(key, value) {
    savedLists.set(key, value);
    clearTimeout(saveTimers.get(key));
    saveTimers.set(key, setTimeout(() => {
      invoke("ui_state_set", { key, value }).catch(() => { /* the next save retries */ });
    }, 200));
  }

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
    if (action === "time") return openClockMenu();
    if (action === "date") return toggleCalendar(button);
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
    slots: { brand: true, start: true, clipboard: true, focus: true, network: true, volume: true, battery: true, language: true, time: true, date: true, windows: true, geometry: true, trayapps: true, tray: true, taskbar: true, edge: true, close: true },
    textSize: 14,
    iconSize: 14,
    trayIconSize: 14,
    hideTaskbar: true,
    // Auto-hide alone lets Explorer slide the taskbar back in for a button
    // asking for attention, which is any app with a notification. This hides
    // the taskbar's own windows as well, so nothing can.
    hideTaskbarCompletely: false,
    // The clock is written the way Windows writes it here - 24 hours, zero
    // padded - and the seconds are off until someone asks for them.
    clockSeconds: false,
    mediaMode: "playing",
    mediaLast: null,
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
    refreshMedia();
    paintTray();
    // The format may have changed under it, so the last text drawn is no
    // longer a reason to skip the paint.
    timeDrawn = "";
    dateDrawn = "";
    paintClock();
    // A tile just switched back on has nothing read for it yet.
    refreshIndicators();
    document.documentElement.style.setProperty("--bar-text", `${settings.textSize}px`);
    document.documentElement.style.setProperty("--bar-icon", `${settings.iconSize}px`);
    document.documentElement.style.setProperty("--bar-tray-icon", `${settings.trayIconSize || 14}px`);
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

  // ---- media player ----------------------------------------------------------
  // Windows exposes the same active session shown beside the volume flyout, so
  // this works with Spotify as well as media playing in a browser.
  const mediaPlayer = document.querySelector("[data-media-player]");
  const mediaTitle = document.querySelector("[data-media-title]");
  const mediaSource = document.querySelector("[data-media-source]");
  const audioStreamsBox = document.querySelector("[data-audio-streams]");
  const audioStreamList = document.querySelector("[data-audio-stream-list]");
  let mediaBusy = false;
  let lastMediaSaved = "";
  async function refreshMedia() {
    if (mediaBusy) return;
    if (settings.mediaMode === "never") { mediaPlayer.hidden = true; return; }
    try {
      const [media, streams] = await Promise.all([
        invoke("media_state"),
        invoke("media_audio_streams").catch(() => []),
      ]);
      const sourceNeedle = (media.launchTarget || media.sourceId || "").toLowerCase().split(/[\\/]/).pop();
      let selectedStream = media.available && sourceNeedle ? streams.find((stream) => stream.executable.toLowerCase().endsWith(sourceNeedle)) : null;
      if (!media.available && streams.length) {
        const remembered = (settings.mediaLast?.launchTarget || "").toLowerCase();
        selectedStream = streams.find((stream) => remembered && stream.executable.toLowerCase() === remembered) || streams[0];
      }
      const others = streams.filter((stream) => !selectedStream || stream.pid !== selectedStream.pid);
      paintAudioStreams(others);
      if (media.available) {
        const remembered = { title: media.title, artist: media.artist, source: media.source, sourceId: media.sourceId, launchTarget: media.launchTarget };
        const key = JSON.stringify(remembered);
        if (key !== lastMediaSaved) {
          lastMediaSaved = key;
          settings = { ...settings, mediaLast: remembered };
          invoke("sidebar_settings_set", { settings }).catch(() => {});
        }
      }
      const fallback = selectedStream ? { title: selectedStream.name, artist: "Active audio", source: selectedStream.name, sourceId: selectedStream.executable, launchTarget: selectedStream.executable } : null;
      if (fallback && !media.available) {
        const key = JSON.stringify(fallback);
        if (key !== lastMediaSaved) { lastMediaSaved = key; settings = { ...settings, mediaLast: fallback }; invoke("sidebar_settings_set", { settings }).catch(() => {}); }
      }
      const shown = media.available ? media : (fallback || settings.mediaLast || {});
      const visible = settings.mediaMode === "always" || !!(media.available && media.playing) || !!selectedStream;
      mediaPlayer.hidden = !visible;
      if (!visible) return;
      mediaTitle.replaceChildren(document.createTextNode(shown.title || (media.available ? "Now playing" : "No recent media")));
      if (shown.artist) mediaTitle.append(document.createTextNode(" · "), Object.assign(document.createElement("span"), { textContent: shown.artist }));
      mediaSource.textContent = shown.source || "Media app";
      mediaSource.dataset.sourceId = shown.sourceId || "";
      mediaSource.dataset.launchTarget = shown.launchTarget || "";
      // The track is how the backend tells one browser window from the next.
      mediaSource.dataset.track = shown.title || "";
      mediaSource.dataset.artist = shown.artist || "";
      mediaSource.hidden = !shown.sourceId;
      const toggle = mediaPlayer.querySelector('[data-media-command="toggle"]');
      if (!media.available && selectedStream) {
        toggle.querySelector(".ms").textContent = selectedStream.muted ? "volume_off" : "volume_up";
        toggle.title = toggle.ariaLabel = selectedStream.muted ? "Unmute" : "Mute";
        toggle.dataset.audioPid = selectedStream.pid;
        toggle.dataset.audioMuted = String(selectedStream.muted);
      } else {
        toggle.querySelector(".ms").textContent = media.playing ? "pause" : "play_arrow";
        toggle.title = toggle.ariaLabel = media.playing ? "Pause" : "Play";
        delete toggle.dataset.audioPid;
        delete toggle.dataset.audioMuted;
      }
      for (const button of mediaPlayer.querySelectorAll("[data-media-command]")) {
        const command = button.dataset.mediaCommand;
        button.disabled = (!media.available && !(command === "toggle" && selectedStream)) || (command === "previous" ? !media.canPrevious : command === "next" ? !media.canNext : false);
      }
    } catch (_) {
      if (settings.mediaMode !== "always") { mediaPlayer.hidden = true; return; }
      mediaPlayer.hidden = false;
      mediaTitle.textContent = settings.mediaLast?.title || "No recent media";
      mediaSource.textContent = settings.mediaLast?.source || "";
      mediaSource.hidden = !settings.mediaLast?.sourceId;
      mediaSource.dataset.sourceId = settings.mediaLast?.sourceId || "";
      mediaSource.dataset.launchTarget = settings.mediaLast?.launchTarget || "";
      mediaSource.dataset.track = settings.mediaLast?.title || "";
      mediaSource.dataset.artist = settings.mediaLast?.artist || "";
      for (const button of mediaPlayer.querySelectorAll("[data-media-command]")) button.disabled = true;
    }
  }
  mediaPlayer.addEventListener("click", async (event) => {
    const streamToggle = event.target.closest("[data-audio-stream-toggle]");
    if (streamToggle) {
      audioStreamList.hidden = !audioStreamList.hidden;
      if (!audioStreamList.hidden) {
        const box = streamToggle.getBoundingClientRect();
        audioStreamList.style.left = `${Math.max(7, Math.min(box.left, innerWidth - audioStreamList.offsetWidth - 7))}px`;
        audioStreamList.style.top = `${Math.max(7, box.top - audioStreamList.offsetHeight - 5)}px`;
      }
      return;
    }
    const mute = event.target.closest("[data-audio-mute]");
    if (mute) {
      mute.disabled = true;
      await invoke("media_audio_mute", { pid: Number(mute.dataset.audioMute), muted: mute.dataset.muted !== "true" }).catch((error) => flash(mute, error));
      mediaBusy = false; return refreshMedia();
    }
    const openStream = event.target.closest("[data-audio-open]");
    if (openStream) {
      audioStreamList.hidden = true;
      const target = openStream.dataset.audioOpen;
      return invoke("media_focus", { sourceId: target, launchTarget: target }).catch((error) => flash(openStream, error));
    }
    const source = event.target.closest("[data-media-source]");
    if (source) return invoke("media_focus", { sourceId: source.dataset.sourceId, launchTarget: source.dataset.launchTarget || null, title: source.dataset.track || null, artist: source.dataset.artist || null }).catch((error) => flash(source, error));
    const button = event.target.closest("[data-media-command]");
    if (!button || button.disabled || mediaBusy) return;
    mediaBusy = true;
    try {
      if (button.dataset.audioPid) await invoke("media_audio_mute", { pid: Number(button.dataset.audioPid), muted: button.dataset.audioMuted !== "true" });
      else await invoke("media_command", { command: button.dataset.mediaCommand });
    }
    catch (error) { flash(button, error); }
    finally { mediaBusy = false; setTimeout(refreshMedia, 150); }
  });
  function paintAudioStreams(streams) {
    audioStreamsBox.hidden = !streams.length;
    audioStreamsBox.querySelector("button").textContent = streams.length;
    if (!streams.length) { audioStreamList.hidden = true; audioStreamList.replaceChildren(); return; }
    audioStreamList.replaceChildren(...streams.map((stream) => {
      const row = document.createElement("div"); row.className = "bar-stream-row";
      const text = document.createElement("button"); text.type = "button"; text.className = "bar-stream-open"; text.dataset.audioOpen = stream.executable;
      const name = document.createElement("strong"); name.textContent = stream.name;
      const detail = document.createElement("small"); detail.textContent = `${stream.volume}% · active audio`;
      text.append(name, detail);
      const button = document.createElement("button"); button.type = "button"; button.className = "bar-stream-mute";
      button.dataset.audioMute = stream.pid; button.dataset.muted = String(stream.muted);
      button.title = stream.muted ? "Unmute" : "Mute";
      button.innerHTML = `<span class="ms" aria-hidden="true">${stream.muted ? "volume_off" : "volume_up"}</span>`;
      row.append(text, button); return row;
    }));
  }
  refreshMedia();
  setInterval(refreshMedia, 2000);

  // The taskbar button flips the same setting the tool page's checkbox does,
  // and saves it, so the next dock remembers the choice.
  async function toggleTaskbar() {
    const hide = !state.taskbarAutoHidden;
    await ask("sidebar_configure", { hideTaskbar: hide, hideCompletely: settings.hideTaskbarCompletely === true });
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
  //
  // A row is either a window or a pin (see below). Both carry `data-bar`, and
  // everything that treats the rail as a list — the saved order, the drag,
  // the click — works off that; `data-window` and `data-pin` only say which
  // kind a row is.
  const list = document.querySelector("[data-windows]");
  const rows = new Map();
  const REFRESH_MS = 1000;
  const ORDER_LIMIT = 200;

  let order = [];

  function saveOrder() {
    const shown = [...list.querySelectorAll("[data-bar]")].map((button) => button.dataset.key);
    const open = new Set(shown);
    // Apps that are closed right now keep their remembered places, and a place
    // is a neighbour, not a number: every closed key is tied to the last open
    // row above it and written back there. Listing them after the open rows
    // instead would send an app that happened to be closed to the end of the
    // rail — a window put under "Chat" and then closed to the tray came back
    // below every other row rather than where it was left.
    const trailing = new Map();
    let anchor = null;
    const head = [];
    for (const key of order) {
      if (open.has(key)) { anchor = key; continue; }
      if (anchor === null) head.push(key);
      else trailing.set(anchor, [...(trailing.get(anchor) || []), key]);
    }
    order = [...head];
    for (const key of shown) order.push(key, ...(trailing.get(key) || []));
    order = order.slice(0, ORDER_LIMIT);
    saveList(ORDER_KEY, order);
  }

  /** What a row is, as far as the saved order is concerned.
   *
   *  The first half is what the window *is*: its AppUserModelID, which Windows
   *  gives per browser profile and per installed app, so a work Edge and a
   *  private Edge are two different things on the rail and can sit in two
   *  different groups. Where an app gives all its windows one ID but shows a
   *  project in each — VS Code — the backend hands over that workspace and it
   *  is used instead, so a window is tied to the folder open in it rather than
   *  to the order the editor happened to start its windows in.
   *
   *  The second half tells that app's otherwise identical windows apart, and
   *  it is the only part with nothing of its own to hang on to: a second Edge
   *  window of the same profile has no lasting name. It gets a slot number,
   *  and `freeSlot` is what makes that number stick. */
  function keyFor(win, except) {
    const app = String(win.app || "").toLowerCase();
    const workspace = String(win.workspace || "").trim().toLowerCase();
    if (workspace) return `${app}#workspace:${workspace}`;
    return freeSlot(app, except);
  }

  /// The keys the rail is showing right now — windows and the stand-in rows of
  /// pinned apps alike, since both take a place in the order.
  function liveKeys(except) {
    const keys = new Set();
    for (const entry of rows.values()) keys.add(entry.button.dataset.key);
    for (const ghost of ghosts.values()) keys.add(ghost.dataset.key);
    keys.delete(except);
    return keys;
  }

  /** The slot a new window of `app` takes: the first slot the saved order
   *  knows about that no window is using, so a second Edge window coming back
   *  lands where the last one was left rather than at the end of the rail.
   *
   *  Counting the app's open windows instead — what this did — was wrong twice
   *  over. The count moves as windows come and go, so with two windows open
   *  and the first closed, the next one to open was handed the key the
   *  surviving window already had and two rows fought over one place. And even
   *  without that, the number a window got depended on the order Windows
   *  happened to enumerate in, so the same two windows swapped places between
   *  runs. */
  function freeSlot(app, except) {
    const used = liveKeys(except);
    const prefix = `${app}#`;
    for (const key of order) {
      if (!key.startsWith(prefix) || key.startsWith(`${prefix}workspace:`)) continue;
      if (!used.has(key)) return key;
    }
    for (let n = 0; ; n += 1) {
      const key = `${prefix}${n}`;
      if (!used.has(key)) return key;
    }
  }

  /** Many chat and mail apps put their unread count at the start of the native
   * window title (for example "(3) WhatsApp" or "[2] Teams"). Windows does
   * not expose another app's taskbar overlay icon, so the title is the one
   * generic signal a replacement taskbar can read without app-specific APIs. */
  function badgeFromTitle(title) {
    const text = String(title || "").trim();
    const count = text.match(/^[([]\s*(\d{1,4}|\d{1,3}\+)\s*[)\]]/);
    if (count) return count[1];
    if (/^[•●]\s*/u.test(text)) return "";
    return null;
  }

  function isDividerKey(key) {
    return String(key || "").startsWith("divider#");
  }

  /** Which group of the rail a key was left in: the divider it was under the
   *  last time the order was written, or `""` for the rows above every
   *  divider. `null` when the order has never seen this key.
   *
   *  This is the part the neighbour walk on its own could not keep. A window
   *  put under "Work" and closed for the day came back wherever the rows that
   *  were open at that moment happened to leave a gap, which reads as it
   *  having wandered out of its group. The group is decided first, and only
   *  then is a place inside it looked for. */
  function groupOf(key) {
    const rank = order.indexOf(key);
    if (rank === -1) return null;
    for (let i = rank - 1; i >= 0; i -= 1) if (isDividerKey(order[i])) return order[i];
    return "";
  }

  /** The stretch of rows belonging to one group, as it stands on the rail:
   *  everything after that divider and before the next one. `null` if the
   *  divider it names has since been removed. */
  function groupSpan(divider) {
    const bars = [...list.querySelectorAll("[data-bar]")];
    let start = 0;
    if (divider) {
      const at = bars.findIndex((bar) => bar.dataset.bar === "divider" && bar.dataset.key === divider);
      if (at === -1) return null;
      start = at + 1;
    }
    let end = bars.length;
    for (let i = start; i < bars.length; i += 1) {
      if (bars[i].dataset.bar === "divider") { end = i; break; }
    }
    return { bars, start, end };
  }

  /** Where a new row goes: back in the group it was left in, and inside that
   *  group before the first row that comes after it in the saved order.
   *
   *  A row never placed before goes at the end of the rail's first group —
   *  above the first divider — because everything under a divider was
   *  deliberately put there, and a window dropping in below one would read as
   *  belonging to that group. A divider itself is exempt: it is placed among
   *  all the rows, and a new one is made to end the list. */
  function placeNew(button) {
    const rank = order.indexOf(button.dataset.key);
    const tail = list.querySelector(".skeleton");
    // A row nothing is remembered about: the end of the first group.
    if (rank === -1) {
      const before = button.dataset.bar === "divider"
        ? tail
        : list.querySelector('[data-bar="divider"]') || tail;
      list.insertBefore(button, before);
      return;
    }
    // A divider belongs among the dividers, so it is placed against the whole
    // rail rather than inside one of the groups it makes.
    const group = button.dataset.bar === "divider" ? null : groupSpan(groupOf(button.dataset.key));
    const bars = group ? group.bars : [...list.querySelectorAll("[data-bar]")];
    const start = group ? group.start : 0;
    const end = group ? group.end : bars.length;
    // Where the search gives up: the divider that closes this group, or the
    // bottom of the rail.
    let before = group ? bars[group.end] || tail : tail;
    for (let i = start; i < end; i += 1) {
      const otherRank = order.indexOf(bars[i].dataset.key);
      // A row the order has never heard of says nothing about where this one
      // belongs, so it is stepped over rather than stopping the walk —
      // otherwise one unplaced row pulled every returning window up to it.
      if (otherRank !== -1 && otherRank > rank) { before = bars[i]; break; }
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
        // A pinned app's row keeps the last icon its window wore, so the pin
        // does not fall back to a blank glyph once the app is closed.
        const pin = pinned(entry.app);
        if (pin && pin.icon !== url) { pin.icon = url; savePins(); }
      });
  }

  // ---- pinned apps -------------------------------------------------------------
  // A pin keeps an app on the rail after its last window has gone: the row
  // stays where it was, dimmed, and a click starts the app again. It is keyed
  // by the same thing a window row is — the AppUserModelID, or the exe — so a
  // pinned app and its window are the same place on the rail, and the pin's
  // row simply gives way the moment a real window takes over.
  //
  // The name, the icon and how to start it are all remembered here. Once the
  // window is gone there is nothing left to ask.
  let pins = [];

  /// The rows standing in for pinned apps that are not running, by pin key.
  const ghosts = new Map();

  function savePins() {
    saveList(PINS_KEY, pins);
  }

  /** A pin's key and a window row's key are the same string, so a pin holds
   *  the place the app's first window had. */
  function pinKey(app) {
    return String(app || "").toLowerCase();
  }

  function pinned(app) {
    return pins.find((pin) => pin.key === pinKey(app));
  }

  function addPin(pin) {
    pins = [...pins.filter((other) => other.key !== pin.key), pin];
    savePins();
    // The pin's place is the place its window holds right now.
    saveOrder();
    refreshWindows();
  }

  function removePin(key) {
    pins = pins.filter((pin) => pin.key !== key);
    savePins();
    refreshWindows();
  }

  function ghostRow(pin) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bar-win pinned";
    button.dataset.bar = "pin";
    button.dataset.pin = pin.key;
    button.dataset.key = `${pin.key}#0`;
    button.title = `Start ${pin.name}`;
    const img = document.createElement("img");
    img.alt = "";
    img.draggable = false;
    img.hidden = !pin.icon;
    if (pin.icon) img.src = pin.icon;
    const glyph = document.createElement("span");
    glyph.className = "ms";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = "window";
    glyph.hidden = !!pin.icon;
    const label = document.createElement("small");
    label.textContent = pin.name;
    button.append(img, glyph, label);
    return button;
  }

  /** Draw a row for every pinned app that has no window of its own open, and
   *  take away the ones whose app has just started. */
  function paintPins(windows) {
    const running = new Set(windows.map((win) => pinKey(win.app)));
    for (const [key, ghost] of ghosts) {
      if (running.has(key) || !pins.some((pin) => pin.key === key)) {
        ghost.remove();
        ghosts.delete(key);
      }
    }
    for (const pin of pins) {
      if (running.has(pin.key) || ghosts.has(pin.key)) continue;
      const ghost = ghostRow(pin);
      ghosts.set(pin.key, ghost);
      placeNew(ghost);
    }
  }

  // Starting a pinned app takes a moment and opens nothing here, so the row
  // says what it is doing until the app's own window arrives and replaces it.
  function launchPin(button) {
    const pin = pins.find((other) => other.key === button.dataset.pin);
    if (!pin || button.disabled) return;
    const label = button.querySelector("small");
    const text = label.textContent;
    button.disabled = true;
    label.textContent = `Starting ${pin.name}`;
    invoke("sidebar_suggest_launch", { target: pin.target, args: pin.args || [], name: pin.name, app: pin.key })
      .then(() => { label.textContent = text; })
      .catch((error) => { label.textContent = text; flash(button, error); })
      .finally(() => { button.disabled = false; refreshWindows(); });
  }

  // ---- dividers ----------------------------------------------------------------
  // A divider is a titled line in the list of rows. It opens nothing; it is
  // there to group what is under it, so two projects being worked on at once
  // do not read as one heap of windows. It is a row like any other — it has a
  // key, it drags, and the saved order keeps it where it was put — so the
  // windows and pins around it simply flow above and below it.
  //
  // Its name is an <input> mounted once when the divider appears and never
  // replaced, so a refresh in the middle of typing cannot take the caret.
  let dividers = [];

  /// The rows standing for each divider, by key.
  const dividerRows = new Map();

  function saveDividers() {
    saveList(DIVIDERS_KEY, dividers);
  }

  function dividerRow(divider) {
    const box = document.createElement("div");
    box.className = "bar-divider";
    box.dataset.bar = "divider";
    box.dataset.divider = divider.key;
    box.dataset.key = divider.key;
    box.title = "Drag to move this divider; right-click to rename or remove it";
    const input = document.createElement("input");
    input.type = "text";
    input.value = divider.name || "";
    input.placeholder = "Divider";
    input.spellcheck = false;
    // Read-only until Rename is chosen, so the whole row - name included -
    // drags as one piece and a press on the text never puts a caret there.
    input.readOnly = true;
    input.setAttribute("aria-label", "Divider name");
    // Typed straight into the rail, saved as it is typed. Nothing else reads
    // the name, so there is no round trip to wait for.
    input.addEventListener("input", () => {
      divider.name = input.value;
      saveDividers();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === "Escape") input.blur();
    });
    // Leaving the name ends the rename; the row goes back to being a row.
    input.addEventListener("blur", () => { input.readOnly = true; });
    box.append(input);
    return box;
  }

  /** Draw a row for every divider there is, and take away the ones that have
   *  been removed. Existing rows are left alone — that is what keeps a name
   *  being typed from being rebuilt under the caret. */
  function paintDividers() {
    for (const [key, box] of dividerRows) {
      if (dividers.some((divider) => divider.key === key)) continue;
      box.remove();
      dividerRows.delete(key);
    }
    for (const divider of dividers) {
      if (dividerRows.has(divider.key)) continue;
      const box = dividerRow(divider);
      dividerRows.set(divider.key, box);
      placeNew(box);
    }
  }

  /** Put a divider's name into edit: as it is created, and again whenever
   *  Rename is chosen from its menu. Those are the only two ways in, so an
   *  ordinary press on the row - its title included - stays a drag. */
  function renameDivider(key) {
    const input = dividerRows.get(key)?.querySelector("input");
    if (!input) return;
    input.readOnly = false;
    input.focus();
    input.select();
  }

  /** A new divider goes at the end of the list, and its name is put straight
   *  into edit — it is created to be titled, so the caret is already there. */
  function addDivider() {
    const divider = { key: `divider#${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: "" };
    dividers = [...dividers, divider];
    saveDividers();
    paintDividers();
    saveOrder();
    renameDivider(divider.key);
  }

  function removeDivider(key) {
    dividers = dividers.filter((divider) => divider.key !== key);
    saveDividers();
    paintDividers();
    saveOrder();
  }

  function row(win) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bar-win";
    button.dataset.bar = "window";
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
    const badge = document.createElement("span");
    badge.className = "bar-app-badge";
    badge.hidden = true;
    badge.setAttribute("aria-hidden", "true");
    button.append(img, glyph, label, badge);
    return { button, img, glyph, label, badge, app: win.app, workspace: win.workspace || "" };
  }

  function paintWindows(windows) {
    // Before the rows, so a pin whose app has just started gives up its place
    // to that app's window rather than sitting beside it.
    paintPins(windows);
    paintDividers();
    const seen = new Set(windows.map((win) => win.id));
    let changed = false;
    for (const [id, entry] of rows) {
      if (!seen.has(id)) {
        entry.button.remove();
        rows.delete(id);
        changed = true;
      }
    }
    for (const win of windows) {
      let entry = rows.get(win.id);
      if (!entry) {
        entry = row(win);
        rows.set(win.id, entry);
        placeNew(entry.button);
        changed = true;
      }
      const { button, label, badge } = entry;
      // VS Code can reuse a window for another folder. Follow that change so
      // its remembered position belongs to the project now open in it.
      if ((entry.workspace || "") !== (win.workspace || "")) {
        const oldKey = button.dataset.key;
        entry.workspace = win.workspace || "";
        // Its own key is still on the row, so it is left out of what counts as
        // taken — otherwise the row would be moved aside for itself.
        button.dataset.key = keyFor(win, oldKey);
        order = order.filter((key) => key !== oldKey);
        placeNew(button);
        changed = true;
      }
      if (label.textContent !== win.title) {
        label.textContent = win.title;
        button.title = win.title;
        loadIcon(win.id, entry);
      }
      const unread = badgeFromTitle(win.title);
      badge.hidden = unread === null;
      badge.classList.toggle("dot", unread === "");
      badge.textContent = unread || "";
      button.setAttribute("aria-label", unread === null ? win.title : `${win.title}, ${unread || "new"} unread`);
      button.classList.toggle("active", win.active);
      button.classList.toggle("minimized", win.minimized);
    }
    list.querySelector(".skeleton")?.remove();
    // A window that has just opened or just gone is written into the order
    // straight away, anchored to the row above it, so the place it was given
    // is the place it comes back to — waiting for a drag to save anything
    // meant a first visit was never remembered at all.
    if (changed) saveOrder();
  }

  let refreshing = false;
  async function refreshWindows() {
    if (refreshing || moving || !savedReady) return;
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
    const button = event.target.closest("[data-bar]");
    if (!button || event.button !== 0) return;
    // The whole divider drags, its name included. Only while that name is
    // being renamed does the press belong to the text instead.
    if (event.target.matches("input:not([readonly])")) return;
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
    if (next?.dataset.bar && event.clientY > next.getBoundingClientRect().top + next.offsetHeight / 2) {
      list.insertBefore(next, moving);
    } else if (prev?.dataset.bar && event.clientY < prev.getBoundingClientRect().top + prev.offsetHeight / 2) {
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
    const button = event.target.closest("[data-bar]");
    if (!button) return;
    if (swallowClick) { swallowClick = false; return; }
    // A divider is a label, not a launcher.
    if (button.dataset.divider) return;
    // A pinned app that is not running has no window to switch to; its row
    // starts it instead.
    if (button.dataset.pin) return launchPin(button);
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

  /// True while a native menu from the rail is up.
  ///
  /// One flag for all of them, and every menu takes it. Two menus at once is
  /// not a cosmetic problem: opening one holds a lock inside Tauri until it
  /// closes, and building the other needs that same lock, on the thread the
  /// first menu is running on. Neither can finish, and the app is gone — no
  /// work in flight, nothing to see, just a window that stops.
  let menuOpen = false;

  list.addEventListener("contextmenu", async (event) => {
    const button = event.target.closest("[data-bar]");
    if (!button) return;
    event.preventDefault();
    // This right-click has been answered. Without this it carries on up to
    // the rail's own menu on `document`, which would build a second menu
    // beside this one.
    event.stopPropagation();
    if (menuOpen) return;
    menuOpen = true;
    try {
      // A divider: rename it in place, another one under it, or take it away.
      if (button.dataset.divider) {
        const key = button.dataset.divider;
        const menu = await Menu.new({ items: [
          await MenuItem.new({ text: "Rename divider", action: () => renameDivider(key) }),
          await MenuItem.new({ text: "Create divider", action: () => addDivider() }),
          await PredefinedMenuItem.new({ item: "Separator" }),
          await MenuItem.new({ text: "Remove divider", action: () => removeDivider(key) }),
        ] });
        await menu.popup();
        return;
      }
      // A pinned app with nothing running: start it, or take the pin away.
      if (button.dataset.pin) {
        const pin = pins.find((other) => other.key === button.dataset.pin);
        if (!pin) return;
        const menu = await Menu.new({ items: [
          await MenuItem.new({ text: pin.name.replaceAll("&", "&&"), action: () => launchPin(button) }),
          await PredefinedMenuItem.new({ item: "Separator" }),
          await MenuItem.new({ text: "Unpin from sidebar", action: () => removePin(pin.key) }),
        ] });
        await menu.popup();
        return;
      }
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
      // Last, where the taskbar puts it: keep this app on the rail after its
      // last window has gone. Only an app there is a way back into can be
      // pinned — a pin that could not start anything would be a dead row.
      const winRow = rows.get(id);
      const existing = pinned(app);
      items.push(await PredefinedMenuItem.new({ item: "Separator" }));
      items.push(existing
        ? await item("Unpin from sidebar", () => removePin(existing.key))
        : await item("Pin to sidebar", () => addPin({
          key: pinKey(app),
          name: info.name || app,
          target: info.target,
          // A browser profile shares its exe with every other profile, so what
          // makes the pin that profile and not the first one is kept with it.
          args: info.args || [],
          icon: winRow && !winRow.img.hidden ? winRow.img.src : "",
        }), Boolean(app) && Boolean(info.target)));
      // Recent files and folders go at the bottom. The taskbar puts them on
      // top, but there they push what the menu is actually for — minimize,
      // close, pin — down to wherever this app's history happens to end, so
      // the same command is in a different place for every app. Below the
      // fixed commands, every app's menu starts the same way.
      if (recent.length) {
        items.push(await PredefinedMenuItem.new({ item: "Separator" }));
        items.push(await item("Recent", () => {}, false));
        for (const entry of recent) {
          items.push(await item(entry.name, () =>
            invoke("sidebar_launch_new", { id, path: entry.path }).catch((error) => flash(button, error))));
        }
      }
      const menu = await Menu.new({ items });
      await menu.popup();
    } catch (error) {
      flash(button, error);
    } finally {
      menuOpen = false;
    }
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
  // Last in line: this fires for a right-click anywhere on the rail that
  // nothing nearer has already answered and stopped. It used to fire for
  // those too — a right-click on a tray icon opened that icon's menu and
  // this one, both at once, which is what wedged the app.
  document.addEventListener("contextmenu", async (event) => {
    event.preventDefault();
    if (event.target.closest("[data-bar]") || menuOpen) return;
    menuOpen = true;
    suggesting = true;
    try {
      // Only the very first right-click, before the first read is back, waits.
      if (!suggestions) await loadSuggestions();
      const text = (value) => value.replaceAll("&", "&&");
      const items = [
        await MenuItem.new({ text: "Dock settings", action: () =>
          window.__TAURI__.event.emit("sidebar:open-settings").catch(() => {}) }),
        await MenuItem.new({ text: "Create divider", action: () => addDivider() }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await MenuItem.new({ text: "Suggested apps", enabled: false }),
      ];
      if (!suggestions.length) items.push(await MenuItem.new({ text: "Nothing to suggest yet", enabled: false }));
      for (const app of suggestions) {
        const action = () => invoke("sidebar_suggest_launch", { target: app.target, name: app.name })
          .catch((error) => { geometry.textContent = String(error); })
          .finally(loadSuggestions);
        items.push(app.icon
          ? await IconMenuItem.new({ text: text(app.name), icon: app.icon, action })
          : await MenuItem.new({ text: text(app.name), action }));
      }
      const menu = await Menu.new({ items });
      await menu.popup();
    } catch (error) {
      geometry.textContent = String(error);
    } finally {
      suggesting = false;
      menuOpen = false;
    }
  });

  // The heaviest read the rail does — every window, then the shell's icon for
  // each suggestion — for a menu that only a right-click opens. It waits until
  // the rail is up and running, and then keeps itself fresh in the background.
  setTimeout(loadSuggestions, 2500);
  setInterval(() => { if (!document.hidden && !suggesting) loadSuggestions(); }, SUGGEST_REFRESH_MS);

  // ---- the clock -------------------------------------------------------------------
  // Two rows at the end of the rail, where the tray's clock is: the time, and
  // the date under it. Both are drawn from this machine's own formats, and
  // neither costs a call — a clock that asked Rust what time it was would be
  // one IPC round trip a second for something the webview already knows.
  const timeLabel = document.querySelector("[data-time]");
  const dateLabel = document.querySelector("[data-date]");
  const timeButton = document.querySelector("[data-action=time]");
  const dateButton = document.querySelector("[data-action=date]");
  const clockRow = document.querySelector("[data-clock-row]");
  // The two readings are tracked apart, because they change at very different
  // rates: the date once a day, the time once a minute - once a second with
  // the seconds on. Touching the date's text and title on every tick made its
  // tooltip flicker under a held pointer and re-measured a row that had not
  // changed.
  let timeDrawn = "";
  let dateDrawn = "";

  /** The time, in the 24-hour zero-padded shape Windows uses here. The
   *  seconds are off by default: the rail is glanced at, and a figure that
   *  changes under the eye every second is noise. Turning them on in the
   *  Docked Sidebar page puts them on the rail as well as in the flyout. */
  function clockTime(now, seconds = settings.clockSeconds === true) {
    return now.toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit",
      ...(seconds ? { second: "2-digit" } : {}),
      hour12: false,
    });
  }

  function paintClock() {
    const now = new Date();
    const time = clockTime(now);
    // Short enough for a narrow rail, and the full date is in the tooltip.
    const date = now.toLocaleDateString([], { day: "numeric", month: "short" });
    const full = now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    let changed = false;
    if (time !== timeDrawn) {
      timeDrawn = time;
      timeLabel.textContent = time;
      timeButton.title = `${time} — ${full}`;
      changed = true;
    }
    if (date !== dateDrawn) {
      dateDrawn = date;
      dateLabel.textContent = date;
      dateButton.title = full;
      changed = true;
    }
    // Only a reading that actually changed can change what fits on a line.
    if (changed) fitClock();
  }

  /** One line if both readings fit on it, two if they do not.
   *
   *  The rail's width is the user's to drag and its text and icon sizes are
   *  theirs to set, so no width in pixels can answer this. The row is put side
   *  by side and kept there only if neither label had to be cut short — the
   *  measurement is the answer. With one of the two switched off there is
   *  nothing to pair, so it stays as it is. */
  function fitClock() {
    // Never while a native menu is up. It holds this thread, the window is
    // covered by it, and a row that reflows under an open menu is a blink the
    // user did nothing to ask for - nothing can be resized while it is there
    // anyway, so the answer cannot have changed.
    if (menuOpen) return;
    const both = settings.slots.time !== false && settings.slots.date !== false;
    // An empty box would still cost the gap above the buttons under it.
    clockRow.hidden = !both && settings.slots.time === false && settings.slots.date === false;
    if (!both) return clockRow.classList.remove("wide");
    clockRow.classList.add("wide");
    const cut = (label) => label.scrollWidth > label.clientWidth + 1;
    if (cut(timeLabel) || cut(dateLabel)) clockRow.classList.remove("wide");
  }

  paintClock();
  // The rail is resized by dragging its grip, which changes nothing this page
  // draws - but it changes what fits on a line.
  new ResizeObserver(fitClock).observe(document.body);
  // Ticked every second, painted only when the minute turns: waking up often
  // enough that the rail is never a minute behind costs nothing, and the paint
  // is skipped when the text has not changed.
  setInterval(() => { if (!document.hidden) paintClock(); }, 1000);

  /** The calendar is a window of its own — the rail is as narrow as the user
   *  dragged it, and a month grid is not. It is placed against the rail's
   *  inner edge, its foot level with the date that opened it. */
  function toggleCalendar(button) {
    const box = button.getBoundingClientRect();
    const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const width = 300;
    const height = 356;
    const x = state.edge === "right"
      ? window.screenX - width - 6
      : window.screenX + window.innerWidth + 6;
    const y = window.screenY + box.bottom - height;
    invoke("calendar_visible")
      .then((open) => (open
        ? invoke("calendar_hide")
        : invoke("calendar_show", { theme, x: Math.max(0, x), y: Math.max(0, y) })))
      .catch((error) => flash(button, error));
  }

  /** What the time offers: the readings the rail cannot draw, and Windows'
   *  own pages for everything past looking — setting the clock is its job. */
  // The calendar is opened after the menu has gone, never from inside it: a
  // window is created on the thread the menu is running on, and one built
  // while the menu still holds it wedges the rail.
  function openClockMenu() {
    let wanted = false;
    return openMenu(() => clockMenuItems(() => { wanted = true; }))
      .then(() => { if (wanted) toggleCalendar(dateButton); });
  }

  async function clockMenuItems(wantCalendar) {
    const now = new Date();
    const items = [
      await note(clockTime(now, true)),
      await note(now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" })),
      await note(`Week ${isoWeek(now)} · ${Intl.DateTimeFormat().resolvedOptions().timeZone || "local time"}`),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await act("Copy the time", () => copyClock(clockTime(new Date(), true))),
      await act("Copy the date", () => copyClock(now.toLocaleDateString([], { dateStyle: "full" }))),
      await act("Copy as ISO 8601", () => copyClock(isoStamp(now))),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await act(`${settings.clockSeconds === true ? "• " : "   "}Show seconds`, toggleSeconds),
      await act("Calendar…", wantCalendar),
      await settingsItem("Date and time settings…", "datetime"),
      await settingsItem("Region and formats…", "region"),
    ];
    return items;
  }

  /** The ISO week number, which is the one thing about today neither the tile
   *  nor Windows' own clock says. */
  function isoWeek(date) {
    const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    // Thursday decides which year the week belongs to.
    day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
    const start = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
    return Math.ceil(((day - start) / 86400000 + 1) / 7);
  }

  /** The local time written the way a log or a filename wants it, offset and
   *  all — not the UTC that toISOString() would give. */
  function isoStamp(date) {
    const pad = (value, size = 2) => String(Math.abs(value)).padStart(size, "0");
    const offset = -date.getTimezoneOffset();
    const zone = offset === 0 ? "Z" : `${offset > 0 ? "+" : "-"}${pad(offset / 60 | 0)}:${pad(offset % 60)}`;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`;
  }

  /** The same switch the Docked Sidebar page has, within reach of the clock
   *  itself. It is kept by the backend, which hands it back to this rail. */
  function toggleSeconds() {
    const clockSeconds = settings.clockSeconds !== true;
    settings = { ...settings, clockSeconds };
    timeDrawn = "";
    paintClock();
    invoke("sidebar_settings_set", { settings: { ...settings } }).catch((error) => say(error));
  }

  function copyClock(text) {
    navigator.clipboard.writeText(text).then(() => say(`Copied ${text}`), (error) => say(error));
  }

  // ---- the notification area ------------------------------------------------------
  // The rail's own tray. It reads the way the real one does: a row of icons
  // with no names, the network first, and a chevron that opens the rest into a
  // named list. The icons Windows promotes onto its taskbar are the ones shown
  // while it is closed.
  //
  // Everything the menus need is read on a timer and kept here, because a
  // native menu cannot show a spinner or change once it is open.
  const trayBox = document.querySelector("[data-tray-apps]");
  // Only what is drawn is on a timer. The connections and the networks in
  // range are read when the menu that shows them opens and again when it
  // closes, because nothing on the rail displays them — polling them every
  // twenty seconds meant a netstat, a tasklist and a radio scan, three times a
  // minute, for a list nobody was looking at.
  const TRAY_REFRESH_MS = 30_000;
  const NET_REFRESH_MS = 15_000;
  // The volume, the battery and the layout are three in-process reads, so they
  // can be looked at more often than anything that shells out.
  const INDICATOR_REFRESH_MS = 8_000;
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
  // The three readings Windows keeps beside the network in its own tray. Each
  // starts empty and its tile stays out of the row until it has been read, so
  // the rail never shows a made-up zero.
  let volume = null;
  let battery = null;
  let layouts = [];
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

  // A line in the health log, for the steps a freeze can happen inside. The
  // watchdog cannot see a native menu or a window being created — neither is
  // tracked work — so what the rail last said it was doing is the only thing
  // naming where it stopped.
  const trace = (text) => { invoke("health_note", { text: `Sidebar: ${text}` }).catch(() => {}); };

  function netDetail() {
    return [
      netStatus.signal ? `${netStatus.signal}% signal` : "",
      netStatus.ipv4 ? `IP ${netStatus.ipv4}` : "",
      netStatus.gateway ? `gateway ${netStatus.gateway}` : "",
    ].filter(Boolean).join(" · ");
  }

  /** What the volume tile draws: the same four states the tray's own icon has. */
  function volumeGlyph() {
    if (!volume?.present) return "volume_off";
    if (volume.muted || volume.level === 0) return "volume_off";
    if (volume.level < 34) return "volume_mute";
    if (volume.level < 67) return "volume_down";
    return "volume_up";
  }

  const volumeLabel = () => (!volume?.present ? "No playback device"
    : volume.muted ? "Muted" : `Volume ${volume.level}%`);

  /** The battery, drawn at the level Windows reports rather than as one full
   *  or empty glyph — the whole point of the icon is the reading. */
  function batteryGlyph() {
    if (battery?.charging) return "bolt";
    const bars = ["battery_0_bar", "battery_1_bar", "battery_2_bar", "battery_3_bar", "battery_4_bar", "battery_5_bar", "battery_6_bar"];
    const percent = battery?.percent ?? 0;
    if (percent >= 95) return "battery_full";
    if (percent <= 10) return "battery_alert";
    return bars[Math.min(bars.length - 1, Math.round((percent / 100) * (bars.length - 1)))];
  }

  function batteryDetail() {
    if (!battery?.present) return "";
    const hours = Math.floor(battery.minutes / 60);
    const left = battery.minutes ? `${hours ? `${hours} h ` : ""}${battery.minutes % 60} min left` : "";
    return [
      battery.charging ? "charging" : battery.plugged ? "on mains power" : "on battery",
      left,
      battery.saver ? "battery saver on" : "",
    ].filter(Boolean).join(" · ");
  }

  const activeLayout = () => layouts.find((layout) => layout.active) || layouts[0] || null;

  function tile(kind, glyph, iconUrl, label, title, tag = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = trayExpanded ? "bar-win" : "bar-win icon-only";
    button.dataset[kind] = "";
    button.title = title;
    if (tag) {
      // The language is three letters, the way the tray writes it — an icon
      // would say "a keyboard", which is not the thing being shown.
      const span = document.createElement("span");
      span.className = "tray-tag";
      span.textContent = tag;
      button.append(span);
    } else if (iconUrl) {
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
    // Each of the three is drawn only once it has been read, and the battery
    // only on a machine that has one — a desktop has nothing to say there.
    const showVolume = settings.slots.volume !== false && !!volume;
    const showBattery = settings.slots.battery !== false && !!battery?.present;
    const showLanguage = settings.slots.language !== false && layouts.length > 0;
    // Every icon shows either way: what the chevron opens is the names, not
    // more of the tray. A rail that hid half of them would be answering a
    // question nobody asked — the tray is there to be glanced at whole.
    const shown = showApps && trayApps ? trayApps : [];

    trayBox.hidden = !showNetwork && !showVolume && !showBattery && !showLanguage && !shown.length;
    trayBox.classList.toggle("expanded", trayExpanded);
    const key = JSON.stringify([
      trayExpanded, showNetwork, netStatus.kind, netStatus.name,
      showVolume && volumeGlyph(), showVolume && volumeLabel(),
      showBattery && batteryGlyph(), showBattery && batteryDetail(), showBattery && battery.percent,
      showLanguage && activeLayout()?.tag, showLanguage && activeLayout()?.name,
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
    if (showVolume) {
      items.push(tile(
        "trayVolume",
        volumeGlyph(),
        null,
        volumeLabel(),
        volume.device ? `${volumeLabel()} — ${volume.device}` : volumeLabel(),
      ));
    }
    if (showBattery) {
      const detail = batteryDetail();
      items.push(tile(
        "trayBattery",
        batteryGlyph(),
        null,
        `Battery ${battery.percent}%`,
        detail ? `Battery ${battery.percent}% — ${detail}` : `Battery ${battery.percent}%`,
      ));
    }
    if (showLanguage) {
      const layout = activeLayout();
      items.push(tile("trayLanguage", "language", null, layout.name, layout.name, layout.tag));
    }
    // The apps come after the three readings, the way the tray orders them.
    const leading = items.length;
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
      items[leading + index].dataset.trayApp = app.id;
      items[leading + index].dataset.trayExe = app.exe;
      // The name goes along so the backend can tell the app own window from
      // the hidden helpers it keeps, which are named after nothing.
      items[leading + index].dataset.trayName = app.name;
    }
    trayBox.replaceChildren(...items);
  }

  // ---- what the menus are built from ---------------------------------------------
  let netLoading = null;
  function refreshNetwork() {
    netLoading ??= invoke("sidebar_network")
      .then((status) => { netStatus = status; paintTray(); }, () => {})
      .finally(() => { netLoading = null; });
    return netLoading;
  }

  let wifiLoading = null;
  function loadWifi() {
    wifiLoading ??= invoke("sidebar_wifi_networks")
      .then((found) => { wifiNetworks = found; }, () => {})
      .finally(() => { wifiLoading = null; });
    return wifiLoading;
  }

  function loadConnections() {
    connectionsLoading ??= invoke("sidebar_connections")
      .then((rows) => { connections = rows; }, () => { connections ??= []; })
      .finally(() => { connectionsLoading = null; });
    return connectionsLoading;
  }

  // The three readings beside the network. Each is one call, and each repaints
  // on its own so a slow one never holds up the other two.
  let indicatorsLoading = null;
  function refreshIndicators() {
    indicatorsLoading ??= Promise.all([
      settings.slots.volume === false ? null : invoke("sidebar_volume").then((read) => { volume = read; }, () => {}),
      settings.slots.battery === false ? null : invoke("sidebar_battery").then((read) => { battery = read; }, () => {}),
      settings.slots.language === false ? null : invoke("sidebar_layouts").then((read) => { layouts = read; }, () => {}),
    ]).then(paintTray).finally(() => { indicatorsLoading = null; });
    return indicatorsLoading;
  }

  // `force` waits for a sweep already in flight rather than settling for its
  // answer: it was read before the thing that asked for this one happened.
  function loadTrayApps(force = false) {
    if (force && trayLoading) return trayLoading.catch(() => {}).then(() => loadTrayApps());
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

  // The main window owns the pop-out handoff, so it is asked to do it. Never
  // call this from inside a menu item: the window is created on the thread the
  // menu is still holding. Park the id and open it once the menu has closed.
  const openTool = (id) => window.__TAURI__.event.emit("sidebar:open-tool", { id })
    .catch((error) => say(error));


  async function openNetworkMenu() {
    if (menuOpen) return;
    menuOpen = true;
    let openAfter = "";
    try {
      // The menu's own two lists are read here rather than on a timer. The
      // first click waits for them; every later one shows what the close of
      // the last menu already fetched.
      if (!connections) await loadConnections();
      if (!wifiNetworks.length) await loadWifi();
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
        items: await Promise.all(NET_TOOLS.map(([id, name]) =>
          act(name, () => { openAfter = id; }))),
      }));

      const menu = await Menu.new({ items });
      await menu.popup();
    } catch (error) {
      say(error);
    } finally {
      menuOpen = false;
      if (openAfter) openTool(openAfter);
      // The lists a menu was just built from are the stalest they will ever be.
      loadConnections();
      loadWifi();
    }
  }

  // ---- the volume, battery and language menus --------------------------------------
  // A native menu cannot hold a slider, so the volume is offered as the steps
  // a tray slider is nudged to anyway, and the wheel over the tile does the
  // fine work. Everything past that — choosing an output device, a power plan,
  // adding a language — is Windows' own page, opened rather than rebuilt.
  // `build` is handed a park(id) its items call instead of opening a tool
  // themselves, for the same reason: the window cannot be created while the
  // menu still holds the thread.
  async function openMenu(build) {
    if (menuOpen) return;
    menuOpen = true;
    let openAfter = "";
    try {
      const menu = await Menu.new({ items: await build((id) => { openAfter = id; }) });
      await menu.popup();
    } catch (error) {
      say(error);
    } finally {
      menuOpen = false;
      if (openAfter) openTool(openAfter);
      refreshIndicators();
      // Held back while the menu was up: the seconds may have been switched
      // on from inside it, which changes what fits on a line.
      fitClock();
    }
  }

  const settingsItem = (text, page) => act(text, () =>
    invoke("sidebar_open_settings", { page }).catch((error) => say(error)));

  /** Set the level and show it at once, so the rail does not wait for the read. */
  function setVolume(level) {
    const wanted = Math.max(0, Math.min(100, Math.round(level)));
    if (volume) volume = { ...volume, level: wanted, muted: false };
    paintTray();
    say(`Volume ${wanted}%`);
    invoke("sidebar_set_volume", { level: wanted })
      .catch((error) => say(error))
      .finally(refreshIndicators);
  }

  function toggleMute() {
    const muted = !volume?.muted;
    if (volume) volume = { ...volume, muted };
    paintTray();
    say(muted ? "Muted" : "Unmuted");
    invoke("sidebar_set_muted", { muted })
      .catch((error) => say(error))
      .finally(refreshIndicators);
  }

  const openVolumeMenu = () => openMenu(async (park) => {
    const items = [await note(volume?.device || "No playback device")];
    if (volume?.present) {
      items.push(await note(volume.muted ? `Muted at ${volume.level}%` : `${volume.level}%`));
      items.push(await PredefinedMenuItem.new({ item: "Separator" }));
      items.push(await act(volume.muted ? "Unmute" : "Mute", toggleMute));
      for (const level of [100, 75, 50, 25, 10, 0]) {
        items.push(await act(`${level === volume.level ? "• " : "   "}${level}%`, () => setVolume(level)));
      }
    }
    items.push(await PredefinedMenuItem.new({ item: "Separator" }));
    // Which device is playing is the other half of the volume, and WinT has a
    // tool for it that does more than Windows' own page: it sets all three
    // roles at once and tests the device. So it comes first.
    items.push(await act("Sound Device Switcher…", () => park("repair-swap")));
    items.push(await settingsItem("Sound settings…", "sound"));
    return items;
  });

  const openBatteryMenu = () => openMenu(async () => {
    const items = [await note(`Battery ${battery?.percent ?? 0}%`)];
    const detail = batteryDetail();
    if (detail) items.push(await note(detail));
    items.push(await PredefinedMenuItem.new({ item: "Separator" }));
    items.push(await settingsItem("Power and sleep…", "power"));
    items.push(await settingsItem("Battery saver…", "battery"));
    return items;
  });

  const openLanguageMenu = () => openMenu(async () => {
    const items = [await note("Keyboard layout")];
    items.push(await PredefinedMenuItem.new({ item: "Separator" }));
    for (const layout of layouts) {
      items.push(await act(`${layout.active ? "• " : "   "}${layout.name} (${layout.tag})`, () => {
        say(`Switching to ${layout.name}`);
        invoke("sidebar_set_layout", { id: layout.id })
          .catch((error) => say(error))
          // Windows carries the request to the foreground window, which takes
          // a moment to act on it; reading back too soon shows the old layout.
          .finally(() => setTimeout(refreshIndicators, 300));
      }));
    }
    items.push(await PredefinedMenuItem.new({ item: "Separator" }));
    items.push(await settingsItem("Language and keyboard settings…", "language"));
    return items;
  });

  // Right-clicking an icon does what right-clicking a tray icon does: the few
  // things worth doing to the program behind it. Its own tray menu is out of
  // reach — Windows keeps those callbacks to Explorer — so this is WinT's own
  // short version of it.
  trayBox.addEventListener("contextmenu", async (event) => {
    const button = event.target.closest("[data-tray-app]");
    if (!button) return;
    event.preventDefault();
    // Answered here. Left to carry on, this same click also reaches the
    // rail's menu on `document`, and two menus built at once deadlock the
    // app — one holds a lock while it is open that the other needs to be
    // built, on the very thread the open one is running on.
    event.stopPropagation();
    // Like every other menu on the rail: while it is up, the timers that
    // reread the tray stay off. paintTray() rebuilds the very row the menu is
    // anchored to, and every refresh underneath it is IPC queueing up behind a
    // native menu that holds the thread — which is what left the rail wedged.
    if (menuOpen) return;
    menuOpen = true;
    // Opening a tool creates a window, and Windows only creates one on the
    // thread the menu is running on. It waits until the menu has gone.
    let openAfter = "";
    try {
      const { trayApp: id, trayExe: exe } = button.dataset;
      const name = button.title || "this app";
      const items = [
        await act("Show it", () => invoke("sidebar_reveal", { id, exe, name })
          .catch((error) => say(error))
          .finally(refreshWindows)),
        await act("Close it", () => invoke("startup_close", { exe })
          .then(say, say)
          .finally(() => { refreshWindows(); loadTrayApps(); })),
        // Closing asks, and a tray app is the kind of program that says no —
        // ignoring the close is how it stays in the notification area. This
        // one does not ask.
        await act("Force close", () => invoke("startup_force_close", { exe })
          .then(say, say)
          .finally(() => { refreshWindows(); loadTrayApps(); })),
        await PredefinedMenuItem.new({ item: "Separator" }),
        // Where the rest of it lives: what starts it, and the switch for it.
        await act("Startup and tray…", () => { openAfter = "startup"; }),
      ];
      const menu = await Menu.new({ items: [await note(name), await PredefinedMenuItem.new({ item: "Separator" }), ...items] });
      trace(`opening the tray menu for ${name}`);
      await menu.popup();
      trace(`the tray menu for ${name} closed`);
    } catch (error) {
      say(error);
    } finally {
      menuOpen = false;
      if (openAfter) {
        trace(`opening the ${openAfter} tool from the tray menu`);
        openTool(openAfter);
      }
    }
  });

  trayBox.addEventListener("click", (event) => {
    if (event.target.closest("[data-tray-more]")) {
      trayExpanded = !trayExpanded;
      paintTray();
      return;
    }
    if (event.target.closest("[data-tray-network]")) return openNetworkMenu();
    if (event.target.closest("[data-tray-volume]")) return openVolumeMenu();
    if (event.target.closest("[data-tray-battery]")) return openBatteryMenu();
    if (event.target.closest("[data-tray-language]")) return openLanguageMenu();
    const button = event.target.closest("[data-tray-app]");
    if (!button) return;
    invoke("sidebar_reveal", { id: button.dataset.trayApp, exe: button.dataset.trayExe, name: button.dataset.trayName })
      .catch((error) => say(error))
      .finally(refreshWindows);
  });

  // Spread out, not fired together. Each of these opens process handles,
  // reads version resources or shells out, and the rail comes up while the app
  // is still building its windows — asking for all of them in one tick put
  // seconds of work in front of the first paint. The window list is what the
  // rail is mostly for, so it goes first and the rest follow it.
  //
  // The connections and the networks in range are not read here at all: the
  // menu that shows them reads them when it opens.
  // The wheel over the volume tile does what it does over the tray's own icon:
  // five points a notch, applied straight away and shown before the read comes
  // back. The writes are coalesced, so a long spin is one call per frame, not
  // one per notch.
  let wheelPending = 0;
  trayBox.addEventListener("wheel", (event) => {
    if (!event.target.closest("[data-tray-volume]") || !volume?.present) return;
    event.preventDefault();
    const level = Math.max(0, Math.min(100, (volume.level ?? 0) + (event.deltaY < 0 ? 5 : -5)));
    volume = { ...volume, level, muted: false };
    paintTray();
    if (wheelPending) return;
    wheelPending = requestAnimationFrame(() => {
      wheelPending = 0;
      setVolume(volume.level);
    });
  }, { passive: false });

  setTimeout(refreshNetwork, 400);
  setTimeout(refreshIndicators, 700);
  setTimeout(loadTrayApps, 1200);
  // A menu is a still picture of what was read before it opened; refreshing
  // underneath it costs work nobody can see.
  const idle = () => !document.hidden && !menuOpen;
  setInterval(() => { if (idle()) refreshNetwork(); }, NET_REFRESH_MS);
  // The volume and the layout change from outside this app — the keyboard's
  // own keys, Alt+Shift, another window — so they are read on the same footing
  // as the network rather than only when clicked.
  setInterval(() => { if (idle()) refreshIndicators(); }, INDICATOR_REFRESH_MS);
  setInterval(() => { if (idle()) loadTrayApps(); }, TRAY_REFRESH_MS);

  // ---- dragging the width ------------------------------------------------------
  // The grip sits on the inner edge. Re-docking moves the work area and every
  // maximized window with it, so it happens once, when the pointer is let go.
  // While dragging, a click-through shadow window shows the space the new
  // width will occupy and the grip's badge keeps the exact value readable.
  // The pointer is captured, so moves still arrive once it leaves the window.
  const grip = document.querySelector("[data-grip]");
  const badge = document.querySelector("[data-grip-badge]");
  let drag = null;
  let previewNext;
  let previewSending = false;

  // Window creation can take longer than a pointermove. Keep at most one
  // native update in flight and always follow it with the newest width.
  async function preview(width) {
    previewNext = width;
    if (previewSending) return;
    previewSending = true;
    do {
      const next = previewNext;
      previewNext = undefined;
      try { await invoke("sidebar_resize_preview", { width: next }); } catch (_) {}
    } while (previewNext !== undefined);
    previewSending = false;
  }

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
    preview(drag.want);
  });

  function endDrag() {
    if (!drag) return;
    const want = drag.want;
    drag = null;
    document.body.classList.remove("resizing");
    preview(null);
    if (want !== state.width) ask("sidebar_configure", { width: want });
  }
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);
  grip.addEventListener("lostpointercapture", endDrag);

  // The Docked Sidebar tool page can change the edge or width too.
  window.__TAURI__.event.listen("sidebar:state", (event) => { state = event.payload; paint(); });
  // WinT went to the notification area, or came back from it: the rail carries
  // it among the tray's apps while it is away, and a row that only turns up on
  // the next sweep is a row nobody trusts.
  window.__TAURI__.event.listen("sidebar:tray", () => loadTrayApps(true));
  invoke("health_note", { text: "Sidebar: the rail is up" }).catch(() => {});
  ask("sidebar_state");
  // The rail the user arranged comes back first; only then is anything placed
  // against it. Drawing the windows against an empty order and saving that
  // would lose the arrangement rather than restore it.
  loadSavedLists().then(() => {
    order = savedLists.get(ORDER_KEY).filter((key) => typeof key === "string");
    pins = savedLists.get(PINS_KEY).filter((pin) => pin?.key && pin?.target);
    dividers = savedLists.get(DIVIDERS_KEY).filter((divider) => divider?.key);
    refreshWindows();
  });
  setInterval(() => {
    if (!document.hidden && !list.hidden && !menuOpen) refreshWindows();
  }, REFRESH_MS);
})();
