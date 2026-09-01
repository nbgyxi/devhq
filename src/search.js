(() => {
  "use strict";
  const { emit, listen } = window.__TAURI__.event;
  const win = window.__TAURI__.window.getCurrentWindow();
  const prepared = new URLSearchParams(location.search).get("prepared") === "1";
  const query = document.getElementById("query");
  const results = document.getElementById("results");
  const drag = document.getElementById("search-drag");
  const copyDebug = document.getElementById("copy-debug");
  let rows = [];
  let selected = 0;
  let hasFocused = false;
  let blurTimer = 0;
  const activationSnapshots = [];

  const snapshotFocus = async (phase) => {
    activationSnapshots.push({
      phase,
      at: new Date().toISOString(),
      nativeFocused: await win.isFocused().catch((error) => `error: ${error}`),
      documentHasFocus: document.hasFocus(),
      activeElement: document.activeElement?.id || document.activeElement?.tagName || null,
      visibility: document.visibilityState,
    });
    if (activationSnapshots.length > 12) activationSnapshots.splice(0, activationSnapshots.length - 12);
  };

  const focusQuery = () => {
    query.focus({ preventScroll: true });
    query.setSelectionRange(query.value.length, query.value.length);
  };
  const activate = async () => {
    activationSnapshots.length = 0;
    void snapshotFocus("before-show");
    await win.show().catch(() => {});
    await win.setFocus().catch(() => {});
    focusQuery();
    void snapshotFocus("after-set-focus");
    requestAnimationFrame(focusQuery);
    setTimeout(() => { focusQuery(); void snapshotFocus("after-40ms"); }, 40);
    setTimeout(() => { focusQuery(); void snapshotFocus("after-120ms"); }, 120);
  };

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
  const draw = () => {
    selected = Math.min(selected, Math.max(0, rows.length - 1));
    results.innerHTML = rows.length ? rows.map((row, index) => `
      <div class="global-search-item">
        <button class="global-search-row kind-${esc(row.kind.toLowerCase())}${index === selected ? " on" : ""}" data-index="${index}" role="option" aria-selected="${index === selected}">
          <span class="ms">${esc(row.icon || "chevron_right")}</span><strong>${esc(row.label)}</strong><small>${esc(row.detail)}</small><span></span>
        </button>
        ${row.pinnable ? `<button class="global-search-pin${row.pinned ? " on" : ""}" data-pin="${esc(row.toolId)}" title="${row.pinned ? "Unpin" : "Pin"}"><span class="ms">${row.pinned ? "push_pin" : "add"}</span></button>` : ""}
      </div>`).join("") : `<div class="global-search-empty">No matching tools, projects or commands</div>`;
    results.querySelector(".global-search-row.on")?.scrollIntoView({ block: "nearest" });
  };
  const close = () => {
    clearTimeout(blurTimer);
    blurTimer = 0;
    hasFocused = false;
    win.hide().catch(() => {});
  };
  const execute = (index = selected) => {
    if (!rows[index]) return;
    emit("search:execute", { index }).catch(() => {});
    close();
  };

  listen("search:results", (event) => {
    const payload = event.payload || {};
    rows = Array.isArray(payload.rows) ? payload.rows : [];
    document.documentElement.dataset.theme = payload.theme === "light" ? "light" : "dark";
    const replaceQuery = typeof payload.query === "string" && query.value !== payload.query;
    if (replaceQuery) query.value = payload.query;
    selected = 0;
    draw();
    focusQuery();
    if (replaceQuery) query.setSelectionRange(query.value.length, query.value.length);
  });
  listen("search:activate", activate);
  query.addEventListener("input", () => emit("search:query", { query: query.value }).catch(() => {}));
  query.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length) selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      draw();
    } else if (event.key === "Enter") { event.preventDefault(); execute(); }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }, true);
  results.addEventListener("click", (event) => {
    const pin = event.target.closest("[data-pin]");
    if (pin) return void emit("search:pin", { id: pin.dataset.pin, query: query.value }).catch(() => {});
    const row = event.target.closest("[data-index]");
    if (row) execute(Number(row.dataset.index));
  });
  drag.addEventListener("pointerdown", (event) => {
    if (event.button === 0) win.startDragging().catch(() => {});
  });
  copyDebug.addEventListener("click", async () => {
    const [nativeFocused, position, size] = await Promise.all([
      win.isFocused().catch((error) => `error: ${error}`),
      win.outerPosition().catch((error) => ({ error: String(error) })),
      win.innerSize().catch((error) => ({ error: String(error) })),
    ]);
    const info = {
      capturedAt: new Date().toISOString(),
      windowLabel: win.label,
      nativeFocused,
      documentHasFocus: document.hasFocus(),
      activeElement: document.activeElement?.id || document.activeElement?.tagName || null,
      visibility: document.visibilityState,
      queryFocused: document.activeElement === query,
      activationSnapshots,
      position,
      size,
      userAgent: navigator.userAgent,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(info, null, 2));
      copyDebug.textContent = "Copied";
    } catch (error) {
      copyDebug.textContent = `Copy failed: ${error}`;
    }
    setTimeout(() => { copyDebug.textContent = "Copy debug info"; }, 1800);
  });
  win.onFocusChanged(({ payload }) => {
    if (payload) {
      clearTimeout(blurTimer);
      blurTimer = 0;
      hasFocused = true;
      focusQuery();
    } else if (hasFocused) {
      clearTimeout(blurTimer);
      blurTimer = setTimeout(async () => {
        blurTimer = 0;
        const nativeFocused = await win.isFocused().catch(() => false);
        if (!nativeFocused && !document.hasFocus()) close();
      }, 180);
    }
  });
  window.addEventListener("focus", focusQuery);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) activate(); });
  if (!prepared) {
    emit("search:ready", {}).catch(() => {});
    activate();
  }
})();
