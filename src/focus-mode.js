// Focus mode: the page over the backend's window hider.
//
// The hiding itself is `focus_mode.rs`; the sidebar button and the shortcut
// work without this page ever being opened. What the page is for is building
// the rules: every window open now, and the ones seen lately, each with a
// one-click "hide this program" and "hide by title word".
//
// Regions are drawn separately - the hero when the state changes, the rules
// when they change, the window list when its contents do - and the inputs are
// mounted once, so typing is never lost to a redraw.

(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;
  const listen = window.__TAURI__.event.listen;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name) => window.wintShell?.icon?.(name) || `<span class="ms" aria-hidden="true">${name}</span>`;
  const REFRESH_MS = 3000;

  const st = {
    state: null,
    settings: null,
    windows: null,
    filter: "all",
    query: "",
    busy: false,
    message: "",
    heroKey: "",
    rulesKey: "",
    listKey: "",
  };
  const icons = new Map();
  let root = null;
  let timer = 0;
  let listening = false;

  const exeName = (path) => String(path || "").split(/[\\/]/).pop() || "";
  const stem = (path) => exeName(path).toLowerCase().replace(/\.exe$/, "");
  const cleanApp = (app) => app.trim().toLowerCase().replace(/\.exe$/, "");

  function rulesFor(win) {
    const apps = (st.settings?.apps || []).map(cleanApp);
    const words = (st.settings?.words || []).map((w) => w.trim().toLowerCase()).filter(Boolean);
    const title = win.title.toLowerCase();
    return {
      app: apps.includes(stem(win.exe)),
      words: words.filter((word) => title.includes(word)),
    };
  }

  const ago = (seconds) => {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
    if (s < 90) return "seen just now";
    if (s < 3600) return `seen ${Math.round(s / 60)} min ago`;
    if (s < 86400) return `seen ${Math.round(s / 3600)} h ago`;
    return `seen ${Math.round(s / 86400)} d ago`;
  };

  /* --------------------------------------------------------------- data */

  async function loadWindows() {
    const first = !st.windows;
    if (first) window.wintWork?.beginWork("focus-mode-windows", "Reading open and recent windows");
    try {
      st.windows = await invoke("focus_mode_windows");
    } catch (error) {
      st.message = String(error);
      st.windows ||= [];
    } finally {
      if (first) window.wintWork?.endWork("focus-mode-windows");
    }
    draw();
  }

  async function saveSettings(next) {
    st.settings = next;
    draw();
    try { await invoke("focus_mode_settings_set", { settings: next }); }
    catch (error) { st.message = String(error); draw(); }
  }

  function addRule(kind, value) {
    const text = String(value || "").trim();
    if (!text) return;
    const list = st.settings?.[kind] || [];
    const same = kind === "apps" ? (x) => cleanApp(x) === cleanApp(text) : (x) => x.trim().toLowerCase() === text.toLowerCase();
    if (list.some(same)) return;
    saveSettings({ ...st.settings, [kind]: [...list, text] });
  }

  function removeRule(kind, value) {
    const list = st.settings?.[kind] || [];
    saveSettings({ ...st.settings, [kind]: list.filter((x) => x !== value) });
  }

  async function toggle() {
    if (st.busy) return;
    st.busy = true;
    const hiding = !(st.state?.hidden > 0);
    window.wintWork?.beginWork("focus-mode", hiding ? "Hiding the windows Focus mode picks" : "Bringing hidden windows back");
    draw();
    try {
      st.state = await invoke("focus_mode_toggle");
      st.message = st.state.message;
    } catch (error) {
      st.message = String(error);
    } finally {
      st.busy = false;
      window.wintWork?.endWork("focus-mode");
      st.heroKey = "";
      draw();
      loadWindows();
    }
  }

  async function showOne(id) {
    window.wintWork?.beginWork("focus-mode-show", "Showing a hidden window");
    try {
      st.state = await invoke("focus_mode_show", { id });
      st.message = st.state.message;
    } catch (error) {
      st.message = String(error);
    } finally {
      window.wintWork?.endWork("focus-mode-show");
      st.heroKey = "";
      draw();
      loadWindows();
    }
  }

  function loadIcon(exe) {
    if (!exe || icons.has(exe)) return;
    icons.set(exe, null);
    invoke("focus_mode_icon", { exe }).then((url) => {
      if (!url) return;
      icons.set(exe, url);
      for (const img of root?.querySelectorAll(`img[data-fm-icon="${CSS.escape(exe)}"]`) || []) img.src = url;
    }, () => {});
  }

  /* ------------------------------------------------------------ drawing */

  function draw() {
    if (!root?.isConnected) return stop();
    drawHero();
    drawRules();
    drawList();
    const notice = root.querySelector("[data-fm-notice]");
    notice.textContent = st.message;
    notice.hidden = !st.message;
  }

  function drawHero() {
    const hero = root.querySelector("[data-fm-hero]");
    const hidden = st.state?.hidden || 0;
    const ruleCount = (st.settings?.apps?.length || 0) + (st.settings?.words?.length || 0);
    const willHide = (st.windows || []).filter((w) => w.open && !w.hidden && (rulesFor(w).app || rulesFor(w).words.length)).length;
    const strays = (st.windows || []).filter((w) => w.stray).length;
    const key = `${!!st.state}:${hidden}:${st.busy}:${ruleCount}:${willHide}:${strays}`;
    if (key === st.heroKey) return;
    st.heroKey = key;
    if (!st.state || !st.settings) {
      hero.innerHTML = `<div class="sw-skeleton">Reading Focus mode…</div>`;
      return;
    }
    root.querySelector(".awake-hero").classList.toggle("is-awake", hidden > 0);
    hero.innerHTML = `<div class="awake-orbit">${icon(hidden ? "visibility_off" : "shield_lock")}</div>
      <div class="awake-hero-copy"><small>${hidden ? "ON" : "OFF"}</small>
        <h2>${hidden ? `${hidden} window${hidden === 1 ? "" : "s"} hidden` : "Nothing hidden"}</h2>
        <p>${hidden
          ? "They are gone from the taskbar, Alt+Tab and the sidebar - not minimized, hidden. Press again, use the shortcut or the sidebar button to bring them all back. Closing WinT brings them back too."
          : ruleCount
            ? `One press hides every window your ${ruleCount} rule${ruleCount === 1 ? "" : "s"} pick${ruleCount === 1 ? "s" : ""} - ${willHide} open right now. The shortcut (Ctrl+Alt+H unless you changed it under Settings → Hotkeys) and the sidebar's Focus mode button do the same from anywhere.`
            : "Pick the programs and title words to hide from the windows below. Then one press - here, from the shortcut (Ctrl+Alt+H) or from the sidebar - hides them all."}</p></div>
      <div class="sw-hero-actions">
        <button class="btn awake-main ${hidden ? "release" : "primary"}" data-fm-toggle ${st.busy || (!hidden && !ruleCount) ? "disabled" : ""}>${icon(hidden ? "visibility" : "visibility_off")}${hidden ? `Bring ${hidden} back` : "Hide now"}</button>
        ${strays ? `<button class="btn" data-fm-strays title="Windows that match your rules but were left hidden, for example by a WinT that closed unexpectedly">${icon("warning")}${strays} left hidden</button>` : ""}
      </div>`;
  }

  function chips(kind, items, glyph) {
    return items.length
      ? items.map((item) => `<span class="fm-chip">${icon(glyph)}<span>${esc(item)}</span><button type="button" data-fm-remove="${kind}" data-value="${esc(item)}" title="Remove this rule">${icon("close")}</button></span>`).join("")
      : `<span class="fm-none">${kind === "apps" ? "No programs yet" : "No title words yet"}</span>`;
  }

  function drawRules() {
    const apps = st.settings?.apps || [];
    const words = st.settings?.words || [];
    const key = JSON.stringify([apps, words]);
    if (key === st.rulesKey || !st.settings) return;
    st.rulesKey = key;
    root.querySelector("[data-fm-chips=apps]").innerHTML = chips("apps", apps, "apps");
    root.querySelector("[data-fm-chips=words]").innerHTML = chips("words", words, "title");
  }

  function row(win) {
    const match = rulesFor(win);
    const hides = match.app || match.words.length > 0;
    const name = exeName(win.exe);
    const state = win.stray ? `<span class="fm-tag warn">${icon("warning")}Left hidden</span>`
      : win.hidden ? `<span class="fm-tag on">${icon("visibility_off")}Hidden now</span>`
      : win.open ? `<span class="fm-tag">Open</span>` : `<span class="fm-tag muted">${esc(ago(win.lastSeen))}</span>`;
    const why = hides
      ? `<span class="fm-tag hit">${icon("check")}${match.app ? `Program ${esc(name)}` : `Title has “${esc(match.words[0])}”`}</span>` : "";
    const url = icons.get(win.exe);
    loadIcon(win.exe);
    return `<div class="fm-row${hides ? " hit" : ""}${win.open ? "" : " past"}">
      <img data-fm-icon="${esc(win.exe)}" alt="" ${url ? `src="${url}"` : ""}>
      <span class="fm-row-text"><strong title="${esc(win.title)}">${esc(win.title || "(untitled)")}</strong><small>${esc(name || "unknown program")}</small></span>
      <span class="fm-tags">${state}${why}</span>
      <span class="fm-row-actions">
        ${win.hidden ? `<button class="btn primary" data-fm-show="${esc(win.id)}" title="Show this window again">${icon("visibility")}Show</button>` : ""}
        ${name ? `<button class="btn${match.app ? " on" : ""}" data-fm-app="${esc(name)}" title="${match.app ? "Stop hiding this program" : "Hide every window of this program"}">${icon("apps")}${match.app ? "Program hidden" : "Hide program"}</button>` : ""}
        <button class="btn" data-fm-word="${esc(win.title)}" title="Pick a word from this title to hide by">${icon("title")}Title word…</button>
      </span></div>`;
  }

  function drawList() {
    const list = root.querySelector("[data-fm-list]");
    const count = root.querySelector("[data-fm-count]");
    if (!st.windows) {
      if (!list.querySelector(".fm-row.skeleton")) {
        list.innerHTML = Array.from({ length: 6 }, () => `<div class="fm-row skeleton"><i></i><span class="fm-row-text"><strong>Reading open and recent windows</strong><small>window</small></span></div>`).join("");
      }
      return;
    }
    const q = st.query.trim().toLowerCase();
    const shown = st.windows.filter((w) =>
      (st.filter === "all" || (st.filter === "open" ? w.open : st.filter === "recent" ? !w.open : st.filter === "hidden" ? w.hidden : rulesFor(w).app || rulesFor(w).words.length))
      && (!q || `${w.title} ${exeName(w.exe)}`.toLowerCase().includes(q)));
    const key = JSON.stringify([st.filter, q, st.rulesKey, shown.map((w) => [w.id, w.title, w.exe, w.hidden, w.open ? 0 : Math.floor(w.lastSeen / 60)])]);
    const open = st.windows.filter((w) => w.open).length;
    count.textContent = `${open} open · ${st.windows.length - open} recent`;
    for (const button of root.querySelectorAll("[data-fm-filter]")) button.classList.toggle("on", button.dataset.fmFilter === st.filter);
    if (key === st.listKey) return;
    st.listKey = key;
    list.innerHTML = shown.length ? shown.map(row).join("")
      : `<div class="awake-empty">${q ? "No window matches that search." : st.filter === "match" ? "No window matches your rules yet." : "No windows here yet. Windows are remembered while WinT runs, so this list grows as you work."}</div>`;
  }

  /* -------------------------------------------------------------- events */

  function click(event) {
    const target = event.target.closest("button");
    if (!target || !root.contains(target)) return;
    if (target.matches("[data-fm-toggle]")) return toggle();
    if (target.matches("[data-fm-filter]")) { st.filter = target.dataset.fmFilter; st.listKey = ""; return draw(); }
    if (target.matches("[data-fm-show]")) return showOne(target.dataset.fmShow);
    if (target.matches("[data-fm-strays]")) { st.filter = "hidden"; st.listKey = ""; return draw(); }
    if (target.matches("[data-fm-remove]")) return removeRule(target.dataset.fmRemove, target.dataset.value);
    if (target.matches("[data-fm-app]")) {
      const name = target.dataset.fmApp;
      const existing = (st.settings.apps || []).find((x) => cleanApp(x) === cleanApp(name));
      return existing ? removeRule("apps", existing) : addRule("apps", name);
    }
    if (target.matches("[data-fm-word]")) {
      // The whole title is rarely the rule; it goes in the box selected, to
      // be trimmed down to the word that matters.
      const input = root.querySelector("[data-fm-input=words]");
      input.value = target.dataset.fmWord;
      input.focus();
      input.select();
      input.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    if (target.matches("[data-fm-add]")) {
      const input = root.querySelector(`[data-fm-input="${target.dataset.fmAdd}"]`);
      addRule(target.dataset.fmAdd, input.value);
      input.value = "";
    }
  }

  function keydown(event) {
    const input = event.target.closest("[data-fm-input]");
    if (!input || event.key !== "Enter") return;
    addRule(input.dataset.fmInput, input.value);
    input.value = "";
  }

  function input(event) {
    if (!event.target.matches("[data-fm-search]")) return;
    st.query = event.target.value;
    draw();
  }

  function stop() {
    clearInterval(timer);
    timer = 0;
  }

  function mount(node) {
    root = node;
    st.heroKey = st.rulesKey = st.listKey = "";
    root.innerHTML = `<div class="awake-page fm-page">
      <section class="awake-hero" data-fm-hero></section>
      <div class="win-status" data-fm-notice data-tone="" hidden></div>
      <section class="fm-rules">
        <div class="fm-rule"><h3>${icon("apps")}Programs</h3><p>Every window of these programs.</p>
          <div class="fm-chips" data-fm-chips="apps"></div>
          <div class="fm-add"><input data-fm-input="apps" placeholder="chrome.exe" spellcheck="false"><button class="btn" data-fm-add="apps">${icon("add")}Add</button></div></div>
        <div class="fm-rule"><h3>${icon("title")}Title words</h3><p>Any window whose title contains one, ignoring case.</p>
          <div class="fm-chips" data-fm-chips="words"></div>
          <div class="fm-add"><input data-fm-input="words" placeholder="YouTube" spellcheck="false"><button class="btn" data-fm-add="words">${icon("add")}Add</button></div></div>
      </section>
      <section class="fm-windows">
        <div class="fm-windows-head"><h3>Windows <small data-fm-count></small></h3>
          <div class="hotkey-filters">${[["all", "All"], ["open", "Open"], ["recent", "Recent"], ["match", "Would hide"], ["hidden", "Hidden"]].map(([id, label]) => `<button type="button" data-fm-filter="${id}">${label}</button>`).join("")}</div>
          <label class="fm-search">${icon("search")}<input data-fm-search placeholder="Search titles and programs" spellcheck="false"></label></div>
        <div class="fm-list" data-fm-list></div>
      </section></div>`;
    root.onclick = click;
    root.onkeydown = keydown;
    root.oninput = input;
    if (!listening) {
      listening = true;
      listen("focus-mode:state", (event) => { st.state = event.payload; st.message = event.payload?.message || ""; if (root?.isConnected) { draw(); loadWindows(); } });
      listen("focus-mode:settings", (event) => { st.settings = event.payload; if (root?.isConnected) draw(); });
    }
    draw();
    Promise.all([invoke("focus_mode_state"), invoke("focus_mode_settings")]).then(([state, settings]) => {
      st.state = state;
      st.settings = settings;
      draw();
    }, (error) => { st.message = String(error); draw(); });
    loadWindows();
    stop();
    timer = setInterval(() => { if (root?.isConnected && !document.hidden) loadWindows(); else if (!root?.isConnected) stop(); }, REFRESH_MS);
  }

  window.wintFocusMode = { mount };
})();
