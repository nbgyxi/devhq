// Notepad: plain text, one file per note, saved as you type.
//
// New notes are `.txt` files in the folder chosen under settings; every
// `.txt` there is a tab. A file opened from anywhere else is a tab too, but
// it stays where it is and is saved back to its own path - the folder is only
// where new notes go. The files are the only copy: nothing is kept in the
// webview that the next start would need.
(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name) => window.wintShell?.icon?.(name) || `<span class="ms" aria-hidden="true">${name}</span>`;
  const STATE_KEY = "notepad";
  /** Long enough that a burst of typing is one write, short enough that
   *  closing the window straight after typing rarely loses anything. */
  const SAVE_DELAY = 600;
  /** The fonts every Windows 10 and 11 PC has, monospaced first. */
  const FONTS = ["Consolas", "Cascadia Mono", "Cascadia Code", "Courier New", "Lucida Console", "Segoe UI", "Arial", "Calibri", "Cambria", "Georgia", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana"];
  const STYLES = { Regular: ["normal", 400], Light: ["normal", 300], Italic: ["italic", 400], Bold: ["normal", 700], "Bold Italic": ["italic", 700] };
  const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36];
  const DEFAULT_FORMAT = { family: "Consolas", style: "Regular", size: 11, wrap: true };
  const options = (values, chosen) => values.map((v) => `<option${String(v) === String(chosen) ? " selected" : ""}>${esc(v)}</option>`).join("");

  const st = {
    host: null,
    prefsLoaded: false,
    defaultFolder: "",
    /** Empty means the default, so the default can follow Documents. */
    chosenFolder: "",
    opened: [],
    notes: [],
    selected: "",
    loading: true,
    saving: 0,
    error: "",
    loadToken: 0,
    format: { ...DEFAULT_FORMAT },
  };
  const folder = () => st.chosenFolder || st.defaultFolder;
  const parentOf = (path) => path.replace(/[\\/][^\\/]*$/, "");
  const fileName = (path) => path.replace(/^.*[\\/]/, "");
  const samePath = (a, b) => a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
  const isExternal = (note) => !samePath(parentOf(note.path), folder());
  const current = () => st.notes.find((note) => note.path === st.selected) || null;
  const q = (selector) => st.host?.querySelector(selector);

  function title(note) {
    const line = note.text.split(/\r?\n/).map((x) => x.trim()).find(Boolean);
    if (line) return line.length > 60 ? `${line.slice(0, 60)}…` : line;
    return isExternal(note) ? fileName(note.path) : "Untitled";
  }

  function mount(node) {
    st.host = node;
    node.innerHTML = `
      <div class="np">
        <aside class="np-side">
          <div class="np-side-head">
            <button type="button" class="btn primary" data-np-new title="New note">${icon("add")}New</button>
            <button type="button" class="btn" data-np-open title="Open a text file from anywhere - it stays where it is">${icon("folder_open")}</button>
            <button type="button" class="btn" data-np-settings title="Where new notes are saved">${icon("settings")}</button>
          </div>
          <div class="np-side-label">Notes</div>
          <div class="np-tabs" data-np-tabs></div>
          <div class="np-error" data-np-status hidden></div>
        </aside>
        <section class="np-main">
          <div class="np-head" data-np-head></div>
          <div class="np-settings" data-np-panel hidden>
            <h3>Save location</h3>
            <label>New notes are saved in
              <input data-np-folder spellcheck="false">
            </label>
            <div class="np-settings-row">
              <button type="button" class="btn" data-np-browse>${icon("folder_open")}Browse…</button>
              <button type="button" class="btn" data-np-default>Use default</button>
            </div>
            <p>Notes save to this folder as you type, one .txt file each. Files you open from elsewhere stay where they are and save back there. Changing the folder leaves the notes already saved in the old one where they are.</p>
            <h3>Text formatting</h3>
            <div class="np-format">
              <label>Family<select data-np-format="family">${options(FONTS, st.format.family)}</select></label>
              <label>Style<select data-np-format="style">${options(Object.keys(STYLES), st.format.style)}</select></label>
              <label>Size<select data-np-format="size">${options(SIZES, st.format.size)}</select></label>
            </div>
            <div class="np-preview" data-np-preview>The quick brown fox jumps over the lazy dog. 0123456789</div>
            <div class="np-wrap">
              <span><strong>Word wrap</strong><small>Fit text within the window</small></span>
              <button type="button" class="home-bg-switch" role="switch" data-np-wrap><i></i></button>
            </div>
          </div>
          <textarea data-np-text spellcheck="false" placeholder="Type here. It saves by itself."></textarea>
        </section>
      </div>`;
    node.addEventListener("click", onClick);
    node.addEventListener("keydown", onKey);
    node.addEventListener("contextmenu", (event) => {
      const tab = event.target.closest("[data-np-tab]");
      if (!tab) return;
      event.preventDefault();
      openMenu(event, tab.dataset.npTab);
    });
    const text = q("[data-np-text]");
    text.addEventListener("input", onInput);
    text.addEventListener("blur", () => { const note = current(); if (note) saveNote(note); });
    q("[data-np-folder]").addEventListener("change", (event) => setFolder(event.target.value.trim()));
    for (const select of node.querySelectorAll("[data-np-format]")) {
      select.addEventListener("change", () => {
        const key = select.dataset.npFormat;
        st.format[key] = key === "size" ? Number(select.value) : select.value;
        applyFormat();
        persist();
      });
    }
    drawAll();
    load();
  }

  function unmount() {
    flushAll();
    st.host = null;
  }

  async function load() {
    const token = ++st.loadToken;
    st.loading = !st.notes.length;
    drawTabs();
    window.wintWork?.beginWork("notepad-load", "Reading notes");
    try {
      if (!st.prefsLoaded) {
        const [saved, fallback] = await Promise.all([
          invoke("ui_state_get", { key: STATE_KEY }).catch(() => null),
          invoke("notepad_default_folder").catch(() => ""),
        ]);
        st.defaultFolder = fallback;
        st.chosenFolder = saved?.folder || "";
        st.opened = Array.isArray(saved?.opened) ? saved.opened : [];
        st.selected = saved?.selected || "";
        st.format = { ...DEFAULT_FORMAT, ...(saved?.format || {}) };
        st.prefsLoaded = true;
      }
      window.wintWork?.beginWork("notepad-load", `Reading notes in ${folder()}`);
      await flushAll();
      const rows = await invoke("notepad_list", { folder: folder(), opened: st.opened });
      if (token !== st.loadToken) return;
      // Notes that only exist in memory - new and still empty - are kept.
      const unsaved = st.notes.filter((note) => !note.saved && !rows.some((row) => row.path === note.path));
      // A note typed in while the folder was being read is newer than the
      // copy just read, so the one in memory wins.
      const typing = (row) => st.notes.find((note) => note.path === row.path && note.dirty);
      st.notes = [...unsaved, ...rows.sort((a, b) => b.modified - a.modified).map((row) => typing(row) || { ...row, saved: true, dirty: false })];
      st.opened = st.opened.filter((path) => st.notes.some((note) => samePath(note.path, path)));
      st.error = "";
    } catch (error) {
      if (token !== st.loadToken) return;
      st.error = String(error);
    } finally {
      if (token === st.loadToken) {
        st.loading = false;
        window.wintWork?.endWork("notepad-load");
      }
    }
    if (!st.notes.length) st.notes.push(newNote());
    if (!current()) st.selected = st.notes[0].path;
    drawAll(true);
  }

  function newNote() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
    let path = `${folder()}\\Note ${stamp}.txt`;
    for (let n = 2; st.notes.some((note) => samePath(note.path, path)); n++) path = `${folder()}\\Note ${stamp} (${n}).txt`;
    return { path, text: "", modified: Date.now(), saved: false, dirty: false };
  }

  // ---- saving ------------------------------------------------------------

  function onInput(event) {
    const note = current();
    if (!note) return;
    note.text = event.target.value;
    note.dirty = true;
    clearTimeout(note.timer);
    note.timer = setTimeout(() => saveNote(note), SAVE_DELAY);
    const tab = q(`[data-np-tab="${CSS.escape(note.path)}"]`);
    const label = tab?.querySelector("strong");
    if (label) label.textContent = title(note);
    const peek = tab?.querySelector("small>i");
    if (peek && !isExternal(note)) peek.textContent = snippet(note);
  }

  /** Saves are chained per note, so two in flight can never land out of
   *  order and leave the older text on disk. */
  function saveNote(note) {
    clearTimeout(note.timer);
    note.timer = 0;
    note.chain = (note.chain || Promise.resolve()).then(async () => {
      if (!note.dirty) return;
      // A new note nobody has typed in yet is not worth a file.
      if (!note.saved && !note.text) { note.dirty = false; return; }
      const text = note.text;
      note.dirty = false;
      st.saving++;
      drawStatus();
      window.wintWork?.beginWork("notepad-save", `Saving ${fileName(note.path)}`);
      try {
        await invoke("notepad_save", { path: note.path, text });
        // A first save gives the header's Explorer button a file to point at.
        if (!note.saved && note === current()) { note.saved = true; drawHead(); }
        note.saved = true;
        note.modified = Date.now();
        st.error = "";
      } catch (error) {
        note.dirty = true;
        st.error = String(error);
      } finally {
        if (--st.saving === 0) window.wintWork?.endWork("notepad-save");
        drawStatus();
      }
    });
    return note.chain;
  }

  function flushAll() {
    return Promise.all(st.notes.filter((note) => note.dirty).map(saveNote));
  }
  window.addEventListener("pagehide", flushAll);

  function persist() {
    invoke("ui_state_set", { key: STATE_KEY, value: { folder: st.chosenFolder, opened: st.opened, selected: st.selected, format: st.format } }).catch(() => {});
  }

  // ---- actions -----------------------------------------------------------

  function select(path) {
    const previous = current();
    if (previous && previous.path !== path) saveNote(previous);
    st.selected = path;
    persist();
    drawAll(true);
  }

  function onClick(event) {
    const close = event.target.closest("[data-np-close]");
    if (close) return removeNote(close.dataset.npClose);
    const tab = event.target.closest("[data-np-tab]");
    if (tab) return select(tab.dataset.npTab);
    if (event.target.closest("[data-np-new]")) {
      const note = newNote();
      st.notes.unshift(note);
      select(note.path);
      q("[data-np-text]")?.focus();
      return;
    }
    const act = event.target.closest("[data-np-act]");
    if (act) { const note = current(); if (note && !act.disabled) runAction(act.dataset.npAct, note); return; }
    if (event.target.closest("[data-np-open]")) return openFiles();
    if (event.target.closest("[data-np-settings]")) {
      const panel = q("[data-np-panel]");
      panel.hidden = !panel.hidden;
      q("[data-np-settings]").classList.toggle("on", !panel.hidden);
      return;
    }
    if (event.target.closest("[data-np-wrap]")) { st.format.wrap = !st.format.wrap; applyFormat(); persist(); return; }
    if (event.target.closest("[data-np-browse]")) return browseFolder();
    if (event.target.closest("[data-np-default]")) return setFolder("");
  }

  function onKey(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key === "n") { event.preventDefault(); q("[data-np-new]")?.click(); }
    if (event.key === "o") { event.preventDefault(); openFiles(); }
    if (event.key === "s") { event.preventDefault(); const note = current(); if (note) { note.dirty = true; saveNote(note); } }
  }

  async function openFiles() {
    window.wintWork?.beginWork("notepad-pick", "Waiting for the file picker");
    let paths = [];
    try { paths = await invoke("notepad_pick"); }
    catch (error) { st.error = String(error); drawStatus(); }
    finally { window.wintWork?.endWork("notepad-pick"); }
    if (!paths.length) return;
    let last = "";
    for (const path of paths) {
      const known = st.notes.find((note) => samePath(note.path, path));
      if (known) { last = known.path; continue; }
      try {
        const row = await invoke("notepad_read", { path });
        const note = { ...row, saved: true, dirty: false };
        st.notes.unshift(note);
        if (isExternal(note) && !st.opened.some((p) => samePath(p, note.path))) st.opened.push(note.path);
        last = note.path;
      } catch (error) {
        st.error = String(error);
      }
    }
    if (last) select(last);
    else drawStatus();
  }

  async function browseFolder() {
    window.wintWork?.beginWork("notepad-pick", "Waiting for the folder picker");
    try {
      const path = await invoke("pick_folder", { start: folder() });
      if (path) await setFolder(path);
    } catch (error) {
      st.error = String(error);
      drawStatus();
    } finally {
      window.wintWork?.endWork("notepad-pick");
    }
  }

  async function setFolder(path) {
    const next = path && !samePath(path, st.defaultFolder) ? path : "";
    if (next === st.chosenFolder) { drawSettings(); return; }
    await flushAll();
    // Everything typed is on disk now, so the old folder's tabs can simply
    // go: its notes stay in it, and the new folder is read in their place.
    st.notes = [];
    st.chosenFolder = next;
    st.selected = "";
    persist();
    drawSettings();
    load();
  }

  /** The x on a tab. A note in the notes folder goes to the Recycle Bin; a
   *  file opened from elsewhere is only closed. */
  async function removeNote(path) {
    const note = st.notes.find((n) => n.path === path);
    if (!note) return;
    if (isExternal(note)) {
      // Closing keeps the file, so what was typed last must reach it first.
      await saveNote(note);
    } else if (note.saved || note.text) {
      const ask = {
        title: `Delete "${title(note)}"?`,
        message: `${fileName(note.path)} goes to the Recycle Bin, so it can still be restored from there.`,
        confirmLabel: "Delete",
        icon: "delete",
        tone: "danger",
      };
      // Without WinT's own dialog nothing is deleted, and the tab says why
      // rather than the x quietly doing nothing.
      if (!window.wintConfirm) { st.error = "Could not ask before deleting, so nothing was deleted."; drawStatus(); return; }
      const answer = await window.wintConfirm(ask);
      if (answer !== true) return;
    }
    if (note.saved && !isExternal(note)) {
      window.wintWork?.beginWork("notepad-delete", `Moving ${fileName(note.path)} to the Recycle Bin`);
      try {
        await note.chain;
        await invoke("notepad_delete", { folder: folder(), path: note.path });
      } catch (error) {
        st.error = String(error);
        drawStatus();
        return;
      } finally {
        window.wintWork?.endWork("notepad-delete");
      }
    }
    clearTimeout(note.timer);
    note.dirty = false;
    const index = st.notes.indexOf(note);
    st.notes.splice(index, 1);
    st.opened = st.opened.filter((p) => !samePath(p, note.path));
    if (!st.notes.length) st.notes.push(newNote());
    if (st.selected === note.path || !current()) select(st.notes[Math.min(index, st.notes.length - 1)].path);
    else { persist(); drawTabs(); }
  }

  // ---- right-click -------------------------------------------------------

  function closeMenu() {
    document.querySelector(".np-context")?.remove();
  }

  /** Sent through the main WinT window when this tool runs in a webview of
   *  its own, where the shell's Files hand-off cannot reach. */
  function openInWintFiles(path) {
    if (window.wintShell?.openExplorerWindow && !window.wintExternalToolChrome) return Promise.resolve(window.wintShell.openExplorerWindow(path));
    const emit = window.__TAURI__?.event?.emit;
    if (!emit) return Promise.reject(new Error("WinT Files could not be contacted."));
    return emit("files:open-window", { path });
  }

  /** Rename and the two reveals, from a tab's menu or the page's header. */
  function runAction(act, note) {
    const fail = (error) => { st.error = String(error); drawStatus(); };
    if (act === "rename") return startRename(note.path);
    if (act === "explorer") {
      window.wintWork?.beginWork("notepad-reveal", `Opening File Explorer at ${fileName(note.path)}`);
      return void invoke("open_in", { path: note.path, target: "reveal", context: null })
        .catch(fail)
        .finally(() => window.wintWork?.endWork("notepad-reveal"));
    }
    if (act === "files") return void openInWintFiles(parentOf(note.path)).catch(fail);
  }

  function openMenu(event, path) {
    closeMenu();
    const note = st.notes.find((n) => n.path === path);
    if (!note) return;
    // A new note nobody has typed in yet has no file for Explorer to point at.
    const off = note.saved ? "" : ` disabled title="Not saved yet - type something first"`;
    const menu = document.createElement("div");
    menu.className = "tr-context np-context";
    menu.innerHTML = `
      <button type="button" data-act="rename">${icon("edit")}Rename</button>
      <hr />
      <button type="button" data-act="explorer"${off}>${icon("folder_open")}Reveal in File Explorer</button>
      <button type="button" data-act="files">${icon("dock_to_right")}Reveal in WinT Files</button>`;
    document.body.appendChild(menu);
    // Placed once it is in the document, so its size is known and it stays on
    // screen when the click was near an edge.
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - box.width - 8)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - box.height - 8)}px`;
    menu.onclick = (click) => {
      const button = click.target.closest("[data-act]");
      if (!button || button.disabled) return;
      closeMenu();
      runAction(button.dataset.act, note);
    };
    setTimeout(() => {
      document.addEventListener("click", closeMenu, { once: true });
      document.addEventListener("keydown", (key) => { if (key.key === "Escape") closeMenu(); }, { once: true });
    }, 0);
  }

  /** Rename in a dialog of its own, drawn in this page rather than the
   *  shell's, so it is never left behind a tool running in its own webview.
   *  The file name is ready to edit with the extension left out of the
   *  selection; Enter renames, Escape or clicking outside leaves it. */
  function startRename(path) {
    const note = st.notes.find((n) => n.path === path);
    if (!note || document.querySelector(".np-rename-layer")) return;
    const layer = document.createElement("div");
    layer.className = "confirm-layer np-rename-layer";
    layer.innerHTML = `<form class="confirm-card np-rename-card" role="dialog" aria-modal="true" aria-labelledby="np-rename-title">
      <span class="confirm-icon">${icon("edit")}</span>
      <div class="confirm-copy">
        <h2 id="np-rename-title">Rename note</h2>
        <p>${esc(parentOf(note.path))}</p>
        <input class="np-rename" spellcheck="false" autocomplete="off" aria-label="File name">
        <small class="np-rename-hint" data-np-rename-hint>Leave out the extension to keep ${esc((fileName(note.path).match(/\.[^.]+$/) || [".txt"])[0])}.</small>
      </div>
      <div class="confirm-actions">
        <button class="btn" type="button" data-np-rename-cancel>Cancel</button>
        <button class="btn primary" type="submit" data-np-rename-ok>Rename</button>
      </div>
    </form>`;
    document.body.appendChild(layer);
    const input = layer.querySelector("input");
    const hint = layer.querySelector("[data-np-rename-hint]");
    const ok = layer.querySelector("[data-np-rename-ok]");
    const usual = hint.textContent;
    input.value = fileName(note.path);
    // Windows refuses these in a file name; saying so here beats an error after.
    const problem = () => {
      const name = input.value.trim();
      if (!name) return "Type a name.";
      if (/[<>:"/\\|?*]/.test(name)) return `A file name cannot contain < > : " / \\ | ? *`;
      return "";
    };
    const check = () => {
      const bad = problem();
      ok.disabled = !!bad;
      hint.textContent = bad || usual;
      hint.classList.toggle("bad", !!bad);
    };
    const close = (keep) => {
      layer.remove();
      if (keep) renameNote(note, input.value.trim());
      if (note === current()) q("[data-np-text]")?.focus();
    };
    input.addEventListener("input", check);
    layer.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); if (!problem()) close(true); });
    layer.querySelector("[data-np-rename-cancel]").addEventListener("click", () => close(false));
    layer.addEventListener("click", (event) => { if (event.target === layer) close(false); });
    layer.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); close(false); } });
    requestAnimationFrame(() => {
      input.focus();
      const dot = input.value.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    });
  }

  /** Runs in the note's save chain, so a save already on its way lands under
   *  the old name first and every later one goes to the new name. */
  function renameNote(note, name) {
    const old = note.path;
    if (!name || name === fileName(old)) { drawTabs(); return; }
    // Typing only a name keeps the extension the file already had.
    if (!name.includes(".")) name += (fileName(old).match(/.[^.]+$/) || [".txt"])[0];
    saveNote(note);
    note.chain = note.chain.then(async () => {
      window.wintWork?.beginWork("notepad-rename", `Renaming ${fileName(old)} to ${name}`);
      try {
        // A note nobody has typed in yet has no file to rename.
        if (!note.saved) { await invoke("notepad_save", { path: old, text: note.text }); note.saved = true; }
        const next = await invoke("notepad_rename", { path: old, name });
        note.path = next;
        if (st.selected === old) st.selected = next;
        st.opened = st.opened.map((p) => (samePath(p, old) ? next : p));
        // Only .txt files are read back from the notes folder, so a note
        // renamed to anything else is remembered the way an opened file is.
        if (!/.txt$/i.test(next) && !st.opened.some((p) => samePath(p, next))) st.opened.push(next);
        st.error = "";
        persist();
      } catch (error) {
        st.error = String(error);
      } finally {
        window.wintWork?.endWork("notepad-rename");
      }
      drawTabs();
      drawHead();
      drawStatus();
    });
  }

  // ---- drawing -----------------------------------------------------------

  function drawAll(editor) {
    drawTabs();
    if (editor) drawEditor();
    drawSettings();
    drawStatus();
    applyFormat();
  }

  function drawTabs() {
    const list = q("[data-np-tabs]");
    if (!list) return;
    if (st.loading) {
      list.innerHTML = Array.from({ length: 4 }, () => `<div class="np-tab np-tab-skeleton"><span class="sk sk-line"></span><span class="sk sk-line"></span></div>`).join("");
      return;
    }
    list.innerHTML = st.notes.map((note) => {
      const external = isExternal(note);
      const x = external ? "Close - the file stays where it is" : "Delete - the file goes to the Recycle Bin";
      return `<div class="np-tab${note.path === st.selected ? " on" : ""}" data-np-tab="${esc(note.path)}" title="${esc(note.path)}
Right-click to rename or reveal">
        <span><strong>${esc(title(note))}</strong><small>${external ? `${icon("open_in_new")}<i>${esc(parentOf(note.path))}</i>` : `<em>${esc(when(note.modified))}</em><i>${esc(snippet(note))}</i>`}</small></span>
        <button type="button" class="np-tab-x" data-np-close="${esc(note.path)}" title="${x}" aria-label="${x}">${icon("close")}</button>
      </div>`;
    }).join("");
  }

  /** "14:32" today, "Yesterday", then "3 Oct" - enough to tell notes apart. */
  function when(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    const now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((day(now) - day(d)) / 86400000);
    if (days <= 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (days === 1) return "Yesterday";
    return d.toLocaleDateString([], d.getFullYear() === now.getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
  }

  /** The line after the title, so a tab shows a little of what is in it. */
  function snippet(note) {
    const lines = note.text.slice(0, 2000).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    return lines[1] || (lines.length ? "" : "Empty");
  }

  function drawHead() {
    const head = q("[data-np-head]");
    if (!head) return;
    const note = current();
    if (!note) { head.innerHTML = ""; return; }
    // The same three as the tab's right-click menu.
    const off = note.saved ? "" : " disabled";
    const reveal = note.saved ? "Reveal in File Explorer" : "Not saved yet - type something first";
    head.innerHTML = `${icon(isExternal(note) ? "open_in_new" : "description")}<strong>${esc(fileName(note.path))}</strong><small title="${esc(parentOf(note.path))}">${esc(parentOf(note.path))}</small>
      <span class="np-head-acts">
        <button type="button" data-np-act="rename" title="Rename" aria-label="Rename">${icon("edit")}</button>
        <button type="button" data-np-act="explorer" title="${reveal}" aria-label="Reveal in File Explorer"${off}>${icon("folder_open")}</button>
        <button type="button" data-np-act="files" title="Reveal in WinT Files" aria-label="Reveal in WinT Files">${icon("dock_to_right")}</button>
      </span>`;
  }

  /** Only on a change of note: rewriting the value while typing would throw
   *  away the caret. */
  function drawEditor() {
    drawHead();
    const text = q("[data-np-text]");
    if (!text) return;
    const note = current();
    text.disabled = !note || st.loading;
    if (text.value !== (note?.text ?? "")) text.value = note?.text ?? "";
  }

  function drawSettings() {
    const input = q("[data-np-folder]");
    if (input && document.activeElement !== input) input.value = folder();
    const reset = q("[data-np-default]");
    if (reset) reset.disabled = !st.chosenFolder;
  }

  /** Progress and "saved" go to the status bar along the bottom of WinT; only
   *  a failure is shown here, because a note that did not save must not look
   *  as if it had. */
  function drawStatus() {
    const node = q("[data-np-status]");
    if (!node) return;
    node.hidden = !st.error;
    node.textContent = st.error;
  }

  function applyFormat() {
    const [fontStyle, weight] = STYLES[st.format.style] || STYLES.Regular;
    const css = `font-family:"${st.format.family}",Consolas,monospace;font-style:${fontStyle};font-weight:${weight};font-size:${st.format.size}pt`;
    const text = q("[data-np-text]");
    if (text) {
      text.style.cssText = css;
      text.wrap = st.format.wrap ? "soft" : "off";
      text.classList.toggle("nowrap", !st.format.wrap);
    }
    const preview = q("[data-np-preview]");
    if (preview) preview.style.cssText = css;
    for (const select of st.host?.querySelectorAll("[data-np-format]") || []) select.value = String(st.format[select.dataset.npFormat]);
    const wrap = q("[data-np-wrap]");
    if (wrap) {
      wrap.classList.toggle("on", st.format.wrap);
      wrap.setAttribute("aria-checked", String(st.format.wrap));
      wrap.title = st.format.wrap ? "Turn word wrap off" : "Turn word wrap on";
    }
  }

  window.wintNotepad = { mount, unmount };
})();
