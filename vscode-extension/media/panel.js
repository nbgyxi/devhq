// The panel: a strip of tabs, and one WinT `TermView` per tab.
//
// The extension owns which terminals exist and reopens them after a reload;
// this page only draws them. Each tab is a session in `wint-term-host.exe`,
// and the view attached to it is the same class WinT's dock uses.

(() => {
  const invoke = window.__TAURI__.core.invoke;
  const tabsEl = document.getElementById("tabs");
  const viewsEl = document.getElementById("views");
  const noticeEl = document.getElementById("notice");

  const SHELL_NAMES = {
    auto: "Default shell",
    pwsh: "PowerShell 7",
    "pwsh-preview": "PowerShell Preview",
    powershell: "Windows PowerShell",
    cmd: "Command Prompt",
    "git-bash": "Git Bash",
    wsl: "WSL",
    nu: "NuShell",
    claude: "Claude Code",
  };

  /** Session id -> { id, shell, cwd, view, host }, in tab order. */
  const terms = new Map();
  let active = null;
  let booting = false;

  // ---- which keys belong to VS Code ----------------------------------------

  let passKeys = [];

  function parseKey(spec) {
    const parts = String(spec).split("+").map((part) => part.trim()).filter(Boolean);
    const key = (parts.pop() || "").toUpperCase();
    const mods = new Set(parts.map((part) => part.toLowerCase()));
    return { key, ctrl: mods.has("ctrl"), shift: mods.has("shift"), alt: mods.has("alt") };
  }

  /** The key's name as a keybinding spells it, by position where the layout
   *  would otherwise disagree - Shift+` is `~` on a US keyboard. */
  function keyNames(e) {
    const names = new Set([e.key.length === 1 ? e.key.toUpperCase() : e.key.toUpperCase()]);
    if (/^Key[A-Z]$/.test(e.code)) names.add(e.code.slice(3));
    else if (/^Digit\d$/.test(e.code)) names.add(e.code.slice(5));
    else if (e.code === "Backquote") names.add("`");
    return names;
  }

  /** Read by `terminal.js` before it handles any key: true leaves the key to
   *  VS Code, the way its own terminal leaves Ctrl+P and F1 alone. */
  window.wintTerminalPassesKey = (e) => {
    if (!passKeys.length) return false;
    const names = keyNames(e);
    return passKeys.some((k) =>
      k.ctrl === e.ctrlKey && k.shift === e.shiftKey && k.alt === e.altKey && names.has(k.key));
  };

  function applySettings(settings) {
    passKeys = (settings.keysForVSCode || []).map(parseKey);
    // `terminal.js` reads this switch from WinT's own preferences key.
    try {
      const prefs = JSON.parse(localStorage.getItem("wint.terminals.v1") || "{}");
      prefs.enhancedHistorySearch = settings.enhancedHistorySearch !== false;
      localStorage.setItem("wint.terminals.v1", JSON.stringify(prefs));
    } catch {}
  }

  // ---- light or dark, as VS Code is ----------------------------------------

  function followTheme() {
    const light = document.body.classList.contains("vscode-light")
      || document.body.classList.contains("vscode-high-contrast-light");
    document.documentElement.dataset.theme = light ? "light" : "dark";
  }
  new MutationObserver(followTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  followTheme();

  // ---- tabs ------------------------------------------------------------------

  function icon(name) {
    return `<span class="ms" aria-hidden="true">${name}</span>`;
  }

  function esc(text) {
    return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  function folderName(path) {
    const parts = String(path || "").split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || path || "";
  }

  function tabLabel(term) {
    const where = folderName(term.view?.cwd || term.cwd);
    const shell = term.shell && term.shell !== "auto" ? SHELL_NAMES[term.shell] || term.shell : "";
    return shell ? `${where} · ${shell}` : where || "Terminal";
  }

  function renderTabs() {
    const tabs = [...terms.values()].map((term) => `
      <button class="tab${term.id === active ? " on" : ""}${term.view?.exited ? " exited" : ""}" role="tab"
        aria-selected="${term.id === active}" data-tab="${esc(term.id)}" title="${esc(term.view?.cwd || term.cwd || "")}">
        ${icon("terminal")}<span class="tab-name">${esc(tabLabel(term))}</span>
        <span class="tab-close" data-close="${esc(term.id)}" title="Close this terminal" aria-label="Close this terminal">${icon("close")}</span>
      </button>`).join("");
    tabsEl.innerHTML = `${tabs}
      <button class="tab-tool" data-new title="New WinT terminal" aria-label="New WinT terminal">${icon("add")}</button>
      <button class="tab-tool" data-shells title="Choose a shell" aria-label="Choose a shell">${icon("expand_more")}</button>`;
  }

  function setActive(id, focus = true) {
    active = id;
    for (const term of terms.values()) term.host.classList.toggle("on", term.id === id);
    renderTabs();
    const term = terms.get(id);
    if (!term) return;
    invoke("panel_activate", { id }).catch(() => {});
    // A hidden view could not measure itself; now it can.
    requestAnimationFrame(() => {
      term.view.fit();
      if (focus) term.view.focus();
    });
  }

  function showNotice(text, button) {
    noticeEl.hidden = false;
    noticeEl.innerHTML = `<div>${esc(text)}</div>${button ? `<div><button type="button" data-notice>${esc(button)}</button></div>` : ""}`;
  }

  function hideNotice() {
    noticeEl.hidden = true;
    noticeEl.innerHTML = "";
  }

  async function mount(tab) {
    const host = document.createElement("div");
    host.className = "term-host";
    viewsEl.appendChild(host);
    const view = new TermView(host, tab.id);
    const term = { id: tab.id, shell: tab.shell, cwd: tab.cwd, view, host };
    terms.set(tab.id, term);
    view.onTitle = () => renderTabs();
    view.onCwd = () => renderTabs();
    view.onExit = () => renderTabs();
    try {
      await view.attach();
    } catch {
      view.markExited();
    }
    return term;
  }

  function unmount(id) {
    const term = terms.get(id);
    if (!term) return;
    term.view.dispose();
    term.host.remove();
    terms.delete(id);
  }

  /** A first guess at the size, so the shell starts at roughly the right
   *  width; the view sends the exact one once it has measured a cell. */
  function roughSize() {
    const box = viewsEl.getBoundingClientRect();
    return {
      cols: Math.max(20, Math.floor((box.width - 16) / 7.6)),
      rows: Math.max(5, Math.floor((box.height - 12) / 17)),
    };
  }

  async function boot() {
    if (booting) return;
    booting = true;
    for (const id of [...terms.keys()]) unmount(id);
    showNotice("Starting the terminal…");
    try {
      const state = await invoke("panel_boot", roughSize());
      applySettings(state.settings || {});
      if (state.error) {
        showNotice(`The terminal could not start: ${state.error}`, "Try again");
        return;
      }
      hideNotice();
      for (const tab of state.tabs) await mount(tab);
      const first = state.active && terms.has(state.active) ? state.active : state.tabs[0]?.id;
      if (first) setActive(first, false);
      else showEmpty();
    } catch (error) {
      showNotice(`The terminal could not start: ${error.message || error}`, "Try again");
    } finally {
      booting = false;
      renderTabs();
    }
  }

  function showEmpty() {
    renderTabs();
    showNotice("No terminals open.", "New terminal");
  }

  async function newTerminal(shell) {
    try {
      const tab = await invoke("panel_new", { shell, ...roughSize() });
      hideNotice();
      await mount(tab);
      setActive(tab.id);
    } catch (error) {
      showNotice(`The terminal could not start: ${error.message || error}`, "Try again");
    }
  }

  async function closeTerminal(id) {
    const order = [...terms.keys()];
    const at = order.indexOf(id);
    unmount(id);
    await invoke("panel_close", { id }).catch(() => {});
    if (!terms.size) {
      active = null;
      showEmpty();
      return;
    }
    if (active === id) setActive(order[at + 1] || order[at - 1]);
    else renderTabs();
  }

  // ---- the shell menu --------------------------------------------------------

  let menu = null;

  function closeMenu() {
    menu?.remove();
    menu = null;
  }

  async function openShellMenu(anchor) {
    closeMenu();
    const box = anchor.getBoundingClientRect();
    menu = document.createElement("div");
    menu.id = "shell-menu";
    menu.setAttribute("role", "menu");
    menu.style.top = `${box.bottom + 2}px`;
    menu.style.left = `${Math.max(4, Math.min(box.left, window.innerWidth - 200))}px`;
    menu.innerHTML = `<button disabled>Looking for shells…</button>`;
    document.body.appendChild(menu);
    let shells = [];
    try { shells = await invoke("panel_shells"); } catch {}
    if (!menu) return;
    menu.innerHTML = shells.map((shell) => `
      <button type="button" role="menuitem" data-shell="${esc(shell.profile)}" ${shell.available ? "" : "disabled"}
        title="${esc(shell.reason || "")}">
        <span>${esc(SHELL_NAMES[shell.profile] || shell.profile)}</span>${shell.setup ? "<small>set up</small>" : ""}
      </button>`).join("") || `<button disabled>No shells found</button>`;
  }

  // ---- wiring ----------------------------------------------------------------

  tabsEl.addEventListener("mousedown", (e) => {
    // Middle-click closes, as it does on VS Code's own tabs.
    const tab = e.target.closest("[data-tab]");
    if (tab && e.button === 1) {
      e.preventDefault();
      closeTerminal(tab.dataset.tab);
    }
  });

  tabsEl.addEventListener("click", (e) => {
    const close = e.target.closest("[data-close]");
    if (close) {
      e.stopPropagation();
      closeTerminal(close.dataset.close);
      return;
    }
    if (e.target.closest("[data-new]")) return void newTerminal();
    const shells = e.target.closest("[data-shells]");
    if (shells) return void (menu ? closeMenu() : openShellMenu(shells));
    const tab = e.target.closest("[data-tab]");
    if (tab) setActive(tab.dataset.tab);
  });

  document.addEventListener("click", (e) => {
    const choice = e.target.closest("#shell-menu [data-shell]");
    if (choice) {
      const shell = choice.dataset.shell;
      closeMenu();
      newTerminal(shell);
      return;
    }
    if (menu && !e.target.closest("#shell-menu, [data-shells]")) closeMenu();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu) closeMenu();
  });

  noticeEl.addEventListener("click", (e) => {
    if (!e.target.closest("[data-notice]")) return;
    if (terms.size || booting) return;
    // "Try again" after a failed start and "New terminal" on an empty panel
    // both come down to the same boot: it opens one when there are none.
    boot();
  });

  window.addEventListener("wint-panel", (e) => {
    const message = e.detail;
    if (message.type === "command" && message.name === "new") newTerminal();
    else if (message.type === "settings") applySettings(message.settings || {});
    else if (message.type === "host-stopped") {
      for (const term of terms.values()) term.view.markExited();
      renderTabs();
      showNotice("The terminal host stopped. Its terminals have ended.", "Reopen terminals");
      for (const id of [...terms.keys()]) unmount(id);
    }
  });

  // One observer for the whole panel: only the tab on show has a size to fit.
  new ResizeObserver(() => terms.get(active)?.view.fit()).observe(viewsEl);

  boot();
})();
