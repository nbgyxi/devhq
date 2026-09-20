// Startup and tray: what starts with Windows, and what sits in the tray.
//
// The two lists are one subject. An icon in the notification area is a program
// nobody asked for in this session, and the only way to stop it coming back is
// to find the entry that starts it — so every tray row says where it comes
// from, and offers the switch for it in place.
//
// Nothing here deletes anything. Turning an entry off writes Windows' own
// approval flag, the one Task Manager's Startup tab writes, so the entry stays
// where it is and switching it back on is one click.
//
// Rows are a grid, not a table: this tool is often popped out into a window a
// few hundred pixels wide, and a table column holding a sentence turns into
// one word per line. Every row is a fixed shape at every width — the program
// on the left, its switch on the right, and everything that varies in length
// on a line of its own underneath.
//
// The two lists are drawn only when their contents change, and the search box
// is mounted once, so typing survives a refresh.

(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name) => window.wintShell?.icon?.(name) || `<span class="ms" aria-hidden="true">${name}</span>`;
  const REFRESH_MS = 5000;

  const st = {
    entries: null,
    icons: null,
    query: "",
    history: false,
    message: "The registry and both Startup folders, read together.",
    busy: new Set(),
    /** The one row action waiting to be confirmed, as "verb:exe". Closing a
     *  program and starting its uninstaller are both things a stray click
     *  must not do, so each asks once, in place. */
    confirm: "",
    startupKey: "",
    trayKey: "",
  };
  // One icon per program, kept: reading it costs a call into the shell.
  const thumbs = new Map();
  let root = null;
  let timer = 0;

  const fileName = (path) => String(path || "").split(/[\\/]/).pop() || "";
  const matches = (text) => !st.query || String(text || "").toLowerCase().includes(st.query);
  const thumbOf = (exe) => thumbs.get(fileName(exe).toLowerCase()) || null;

  function thumb(exe) {
    const url = thumbOf(exe);
    return url
      ? `<img class="startup-icon" src="${esc(url)}" alt="">`
      : `<span class="startup-icon ms" aria-hidden="true">web_asset</span>`;
  }

  const pill = (text, kind = "") => `<span class="state-pill ${kind}">${esc(text)}</span>`;

  /** The switch, with the app's own busy spinner while the write is in flight. */
  function switchButton(id, enabled) {
    if (st.busy.has(id)) {
      return `<button class="btn spinning" disabled>${icon("progress_activity")}<span>Working</span></button>`;
    }
    return `<button class="btn" data-startup-toggle="${esc(id)}" data-startup-want="${enabled ? "off" : "on"}">${enabled ? "Turn off" : "Turn on"}</button>`;
  }

  /** Close and Uninstall, and the second click that means it.
   *  Close asks the program's windows to close, so it can still refuse or ask
   *  the user about unsaved work; Uninstall only starts the vendor's own
   *  uninstaller. Neither is offered for a program with nothing to act on. */
  function rowActions(exe, running) {
    if (!exe) return "";
    const close = `close:${exe}`;
    const remove = `uninstall:${exe}`;
    const parts = [];
    if (running) {
      parts.push(st.confirm === close
        ? `<button class="btn danger armed" data-startup-do="${esc(close)}">Close it?</button>`
        : `<button class="btn" data-startup-ask="${esc(close)}" title="Ask its windows to close">${icon("close")}</button>`);
    }
    parts.push(st.confirm === remove
      ? `<button class="btn danger armed" data-startup-do="${esc(remove)}">Uninstall it?</button>`
      : `<button class="btn" data-startup-ask="${esc(remove)}" title="Start the program's own uninstaller">${icon("delete")}</button>`);
    parts.push(`<button class="btn" data-startup-reveal="${esc(exe)}" title="Show the program in Explorer">${icon("folder_open")}</button>`);
    return parts.join("");
  }

  /** Every program in either list gets its icon read once. */
  async function loadIcons(paths) {
    await Promise.all([...new Set(paths.filter(Boolean))].map(async (exe) => {
      const key = fileName(exe).toLowerCase();
      if (!key || thumbs.has(key)) return;
      // Claim the key first, so a refresh that lands mid-read asks once.
      thumbs.set(key, null);
      const url = await invoke("startup_icon", { exe }).catch(() => null);
      if (url) thumbs.set(key, url);
    }));
  }

  // ---- the page -----------------------------------------------------------------
  function trayNote() {
    return `Windows keeps a record of every program that has ever put an icon in the tray. These are the ones running now${st.history ? ", and every other one it remembers" : ""} — each with where it is started from.`;
  }

  function shell() {
    return `
      <div class="win-controls">
        <label class="grow"><span>Search</span><input type="search" data-startup-search placeholder="a program, a command or where it starts from" value="${esc(st.query)}"></label>
        <label class="startup-check"><input type="checkbox" data-startup-history${st.history ? " checked" : ""}><span>Every icon ever recorded</span></label>
      </div>
      <div class="win-status" data-startup-status>${esc(st.message)}</div>
      <h3 class="startup-head">Starts with Windows</h3>
      <div data-startup-list></div>
      <h3 class="startup-head">Notification area</h3>
      <p class="startup-note" data-startup-note>${esc(trayNote())}</p>
      <div data-tray-list></div>`;
  }

  function entryRow(entry) {
    // The entry's own name is what Windows was told to call it, and it is
    // almost always the clearer of the two: "Logitech Download Assistant"
    // where the program behind it only says "Windows host process".
    return `<div class="startup-row${entry.enabled ? "" : " startup-off"}">
      ${thumb(entry.exe)}
      <div class="startup-name"><strong>${esc(entry.name)}</strong><small>${esc(entry.description || fileName(entry.exe))}</small></div>
      <div class="startup-actions">
        ${switchButton(entry.id, entry.enabled)}
        ${rowActions(entry.exe, entry.running)}
      </div>
      <div class="startup-meta">
        ${pill(entry.source)}
        ${entry.enabled ? "" : pill("switched off", "startup-idle-pill")}
        ${entry.running ? pill("running now", "startup-run-pill") : ""}
        ${entry.tray ? pill("in the tray", "startup-tray-pill") : ""}
        <code>${esc(entry.command)}</code>
      </div>
    </div>`;
  }

  function drawStartup() {
    const host = root.querySelector("[data-startup-list]");
    if (!host) return;
    if (!st.entries) {
      host.innerHTML = '<div class="win-empty">Reading what starts with Windows…</div>';
      return;
    }
    const rows = st.entries.filter((entry) =>
      matches(entry.name) || matches(entry.description) || matches(entry.command) || matches(entry.source));
    const key = JSON.stringify(rows.map((entry) =>
      [entry.id, entry.enabled, entry.running, st.busy.has(entry.id), !!thumbOf(entry.exe),
       st.confirm.endsWith(entry.exe) ? st.confirm : ""]));
    if (key === st.startupKey) return;
    st.startupKey = key;
    host.innerHTML = rows.length
      ? `<div class="startup-list">${rows.map(entryRow).join("")}</div>`
      : `<div class="win-empty">${st.query ? "Nothing here matches that." : "Nothing starts with Windows from the registry or the Startup folders."}</div>`;
  }

  function trayRow(item) {
    const entry = item.startupId ? st.entries?.find((row) => row.id === item.startupId) : null;
    return `<div class="startup-row${item.running ? "" : " startup-off"}">
      ${thumb(item.exe)}
      <div class="startup-name"><strong>${esc(item.name)}</strong><small>${esc(item.tooltip || fileName(item.exe))}</small></div>
      <div class="startup-actions">
        ${item.startupId && entry?.enabled !== false ? switchButton(item.startupId, true) : ""}
        ${rowActions(item.exe, item.running)}
      </div>
      <div class="startup-meta">
        ${item.running ? pill("running now", "startup-run-pill") : pill("not running", "startup-idle-pill")}
        ${item.promoted ? pill("on the taskbar") : ""}
        ${item.startupId ? pill(item.origin, "startup-tray-pill") : pill("no startup entry", "startup-idle-pill")}
        ${entry && !entry.enabled ? pill("switched off", "startup-idle-pill") : ""}
        <small>${item.startupId
          ? "Turning this off leaves it running until you close it."
          : "Nothing in Startup starts this: a service, a scheduled task, or you opened it."}</small>
      </div>
    </div>`;
  }

  function drawTray() {
    const host = root.querySelector("[data-tray-list]");
    if (!host) return;
    if (!st.icons) {
      host.innerHTML = '<div class="win-empty">Reading the notification area…</div>';
      return;
    }
    const rows = st.icons
      .filter((item) => st.history || item.running)
      .filter((item) => matches(item.name) || matches(item.exe) || matches(item.tooltip) || matches(item.origin));
    const key = JSON.stringify([st.history, rows.map((item) => [
      item.exe, item.running, item.startupId,
      item.startupId ? st.busy.has(item.startupId) : false,
      item.startupId ? st.entries?.find((row) => row.id === item.startupId)?.enabled : null,
      !!thumbOf(item.exe),
      st.confirm.endsWith(item.exe) ? st.confirm : "",
    ])]);
    if (key === st.trayKey) return;
    st.trayKey = key;
    host.innerHTML = rows.length
      ? `<div class="startup-list">${rows.map(trayRow).join("")}</div>`
      : `<div class="win-empty">${st.query ? "Nothing here matches that." : "Nothing has an icon in the notification area right now."}</div>`;
  }

  function status(message) {
    st.message = message;
    const node = root?.querySelector("[data-startup-status]");
    if (node) node.textContent = message;
  }

  /** Both lists, next time anything is drawn. */
  function invalidate() {
    st.startupKey = "";
    st.trayKey = "";
  }

  function draw() {
    if (!root?.isConnected) return;
    drawStartup();
    drawTray();
  }

  // ---- reading ------------------------------------------------------------------
  // One read at a time, and a caller that asks while one is in flight waits
  // for the next one rather than being told nothing happened — a switch that
  // has just been written needs the read that follows it, not the one before.
  let loading = null;
  function load(announce) {
    if (loading) return loading.then(() => load(announce));
    loading = (async () => {
      try {
        const [entries, icons] = await Promise.all([
          invoke("startup_entries"),
          invoke("startup_tray_icons"),
        ]);
        st.entries = entries;
        st.icons = icons;
        invalidate();
        draw();
        await loadIcons([...entries.map((entry) => entry.exe), ...icons.map((item) => item.exe)]);
        // The icons arrive after the names, so the lists are drawn again once
        // they are in rather than held back until they are.
        invalidate();
        draw();
        if (announce) {
          const off = entries.filter((entry) => !entry.enabled).length;
          status(`${entries.length} startup entries${off ? `, ${off} switched off` : ""} · ${icons.filter((item) => item.running).length} icons in the tray now, ${icons.length} recorded`);
        }
      } catch (error) {
        status(String(error));
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  // ---- switching ----------------------------------------------------------------
  async function toggle(id, enabled) {
    if (st.busy.has(id)) return;
    const entry = st.entries?.find((item) => item.id === id);
    const label = entry?.name || entry?.description || "that entry";
    st.busy.add(id);
    invalidate();
    draw();
    status(`${enabled ? "Turning on" : "Turning off"} ${label}…`);
    try {
      await invoke("startup_set_enabled", { id, enabled });
      // Shown at once, from what was just written, rather than at the speed of
      // the next read: the write has already happened by the time this runs.
      if (entry) entry.enabled = enabled;
      status(`${label} will ${enabled ? "start" : "no longer start"} with Windows.${enabled ? "" : " It is still running until you close it."}`);
    } catch (error) {
      status(String(error));
    } finally {
      st.busy.delete(id);
      invalidate();
      draw();
      load(false);
    }
  }

  /** Close or uninstall, once it has been confirmed. */
  async function run(action) {
    const [verb, exe] = [action.slice(0, action.indexOf(":")), action.slice(action.indexOf(":") + 1)];
    st.confirm = "";
    invalidate();
    draw();
    const name = fileName(exe);
    status(verb === "close" ? `Asking ${name} to close…` : `Starting the uninstaller for ${name}…`);
    try {
      status(await invoke(verb === "close" ? "startup_close" : "startup_uninstall", { exe }));
    } catch (error) {
      status(String(error));
    } finally {
      // Closing changes what is running, and an uninstall usually does too.
      load(false);
    }
  }

  function click(event) {
    const ask = event.target.closest("[data-startup-ask]");
    if (ask) {
      st.confirm = ask.dataset.startupAsk;
      invalidate();
      draw();
      // A question nobody answers is not left standing on the row.
      clearTimeout(click.timer);
      click.timer = setTimeout(() => {
        if (!st.confirm) return;
        st.confirm = "";
        invalidate();
        draw();
      }, 6000);
      return;
    }
    const go = event.target.closest("[data-startup-do]");
    if (go) return run(go.dataset.startupDo);

    const toggleButton = event.target.closest("[data-startup-toggle]");
    if (toggleButton) {
      return toggle(toggleButton.dataset.startupToggle, toggleButton.dataset.startupWant === "on");
    }
    const reveal = event.target.closest("[data-startup-reveal]");
    if (reveal) {
      return invoke("startup_reveal", { path: reveal.dataset.startupReveal })
        .catch((error) => status(String(error)));
    }
  }

  function input(event) {
    const search = event.target.closest("[data-startup-search]");
    if (search) {
      st.query = search.value.trim().toLowerCase();
      invalidate();
      return draw();
    }
    const history = event.target.closest("[data-startup-history]");
    if (history) {
      st.history = history.checked;
      const note = root.querySelector("[data-startup-note]");
      if (note) note.textContent = trayNote();
      invalidate();
      draw();
    }
  }

  function stop() {
    clearInterval(timer);
    timer = 0;
  }

  function mount(node) {
    root = node;
    root.innerHTML = shell();
    root.onclick = click;
    root.oninput = input;
    root.onchange = input;
    draw();
    load(true);
    stop();
    timer = setInterval(() => {
      if (root?.isConnected && !document.hidden) load(false);
      else if (!root?.isConnected) stop();
    }, REFRESH_MS);
  }

  window.wintStartupTray = { mount };
})();
