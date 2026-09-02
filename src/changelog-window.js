(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;
  const win = window.__TAURI__.window.getCurrentWindow();
  const releases = document.getElementById("releases");
  const versionLabel = document.getElementById("current-version");
  let hasFocused = false;
  let blurTimer = 0;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char]);
  const text = (value) => esc(value).replace(/`([^`]+)`/g, "<code>$1</code>");
  const kinds = { new: "New", better: "Improved", fix: "Fixed" };
  const date = (iso) => {
    const value = new Date(`${iso}T00:00:00`);
    return Number.isNaN(value.getTime()) ? iso : value.toLocaleDateString(undefined, { day:"numeric", month:"short", year:"numeric" });
  };
  const close = () => {
    clearTimeout(blurTimer);
    blurTimer = 0;
    hasFocused = false;
    win.hide().catch(() => {});
  };
  const closeAfterBlur = () => {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(async () => {
      blurTimer = 0;
      // Both checks, the way Search does it. A freshly foregrounded undecorated
      // WebView2 window can report isFocused() false while its document really
      // does have focus - trusting the native answer alone hides the window
      // again in the same breath it was opened, which reads as never opening.
      const nativeFocused = await win.isFocused().catch(() => false);
      if (!nativeFocused && !document.hasFocus()) close();
    }, 180);
  };
  const activate = async () => {
    hasFocused = false;
    await win.show().catch(() => {});
    await win.setFocus().catch(() => {});
  };
  const releaseBody = (release, appVersion, currentChecksum) => {
    const checksum = release.version === appVersion && currentChecksum ? currentChecksum : (release.buildChecksum || "");
    const build = checksum ? `<p class="release-build">Version ${esc(release.version)} was built with checksum <code>${esc(checksum)}</code></p>` : "";
    const changes = release.changes.map(([kind, value]) => `<li class="chg ${esc(kind)}"><span class="chg-kind">${esc(kinds[kind] || kind)}</span><span class="chg-text">${text(value)}</span></li>`).join("");
    return `<section class="release"><div class="release-head"><span class="release-ver">${esc(release.version)}</span><span class="release-title">${esc(release.title)}</span><time class="release-date" datetime="${esc(release.date)}">${esc(date(release.date))}</time></div>${build}<ul class="release-changes">${changes}</ul></section>`;
  };
  async function render() {
    const log = window.devhqChangelog;
    if (!log) return;
    const appVersion = String(await invoke("app_version").catch(() => log.current));
    let currentChecksum = "";
    if (await invoke("app_is_official_build").catch(() => false)) {
      currentChecksum = String(await invoke("app_build_checksum").catch(() => ""));
    }
    versionLabel.textContent = `DevHQ ${appVersion}`;
    const groups = new Map();
    for (const release of log.releases) {
      const [major, minor] = release.version.split(".");
      const key = `${major}.${minor}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(release);
    }
    releases.innerHTML = [...groups].map(([version, entries]) => {
      const base = entries.find((release) => release.version.endsWith(".0"));
      const patches = entries.filter((release) => release !== base);
      const representative = base || entries[entries.length - 1];
      const patchLabel = `${patches.length} patch${patches.length === 1 ? "" : "es"}`;
      return `<details class="release-group"><summary class="release-group-head"><span class="ms">chevron_right</span><span class="release-ver">${esc(version)}</span><span class="release-title">${esc(representative.title)}</span><time class="release-date" datetime="${esc(entries[0].date)}">${esc(date(entries[0].date))}</time><small>${esc(patchLabel)}</small></summary><div class="release-group-body">${base ? releaseBody(base, appVersion, currentChecksum) : ""}${patches.length ? `<h3>Patch releases</h3>${patches.map((release) => releaseBody(release, appVersion, currentChecksum)).join("")}` : ""}</div></details>`;
    }).join("");
    releases.scrollTop = 0;
  }
  document.getElementById("close").addEventListener("click", close);
  document.querySelector("[data-drag-region]").addEventListener("pointerdown", (event) => {
    if (event.button === 0 && !event.target.closest("button")) win.startDragging().catch(() => {});
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
  window.addEventListener("focus", () => { releases.scrollTop = 0; });
  // The same safety net Search carries: if the window is on screen but was
  // never brought forward, ask for the foreground again rather than sit there.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) activate(); });
  win.onFocusChanged(({ payload }) => {
    if (payload) {
      clearTimeout(blurTimer);
      blurTimer = 0;
      hasFocused = true;
      return;
    }
    if (hasFocused) closeAfterBlur();
  });
  render();
  activate();
})();
