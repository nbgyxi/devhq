(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;
  const { emit, listen } = window.__TAURI__.event;
  const win = window.__TAURI__.window.getCurrentWindow();
  const clips = document.getElementById("clips");
  let rows = [];
  let selected = 0;
  let loaded = false;
  let hasFocused = false;
  let blurTimer = 0;
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch],
    );
  const glyph = (kind) =>
    kind === "links"
      ? "link"
      : kind === "code"
        ? "code"
        : kind === "images"
          ? "image"
          : "notes";
  const draw = () => {
    selected = Math.min(selected, Math.max(0, rows.length - 1));
    clips.innerHTML = rows.length
      ? rows
          .map(
            (row, index) =>
              `<button class="clip${index === selected ? " on" : ""}" data-index="${index}" role="option" aria-selected="${index === selected}">${row.kind === "images" ? `<img src="${esc(row.dataUrl)}" alt="">` : `<span class="ms">${glyph(row.kind)}</span>`}<span><strong>${esc(row.kind === "images" ? `${row.width} × ${row.height} image` : row.text.replace(/\s+/g, " ").slice(0, 180))}</strong><small>${row.kind} · ${row.kind === "images" ? `${Math.round((row.size || 0) / 1024)} KB` : `${row.text.length} characters`}${row.pinned ? " · pinned" : ""}</small></span><time>${esc(new Date(row.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</time></button>`,
          )
          .join("")
      : `<div class="empty">Copy something to start your local history.</div>`;
    clips.querySelector(".clip.on")?.scrollIntoView({ block: "nearest" });
  };
  const refresh = async (cycle) => {
    const next = await invoke("clipboard_history").catch(() => []);
    rows = Array.isArray(next) ? next : [];
    if (cycle && loaded && rows.length) selected = (selected + 1) % rows.length;
    else selected = 0;
    loaded = true;
    draw();
  };
  const close = () => {
    clearTimeout(blurTimer);
    blurTimer = 0;
    hasFocused = false;
    win.hide().catch(() => {});
  };
  const choose = async (index = selected, paste = false) => {
    const row = rows[index];
    if (!row) return;
    try {
      if (row.kind === "images") {
        const response = await fetch(row.dataUrl);
        const blob = await response.blob();
        await navigator.clipboard.write([
          new ClipboardItem({ [blob.type]: blob }),
        ]);
      } else await navigator.clipboard.writeText(row.text);
      if (paste) await invoke("clipboard_picker_paste");
      else close();
    } catch {
      /* Keep the picker open when Windows denies clipboard access. */
    }
  };
  const bindingFromEvent = (event) => {
    if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return "";
    const parts = [];
    if (event.ctrlKey) parts.push("Ctrl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
    if (event.metaKey) parts.push("Meta");
    const names = {
      " ": "Space",
      Escape: "Esc",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
    };
    parts.push(
      names[event.key] ||
        (event.key.length === 1 ? event.key.toUpperCase() : event.key),
    );
    return parts.join("+");
  };
  listen("clipboard-picker:activate", (event) =>
    refresh(Boolean(event.payload?.cycle)),
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length)
        selected =
          (selected + (event.key === "ArrowDown" ? 1 : -1) + rows.length) %
          rows.length;
      draw();
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(selected, true);
    } else if (
      bindingFromEvent(event) ===
      (window.wintClipboardBinding || "Ctrl+Shift+V")
    ) {
      event.preventDefault();
      if (rows.length) selected = (selected + 1) % rows.length;
      draw();
    }
  });
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    },
    true,
  );
  clips.addEventListener("click", (event) => {
    const row = event.target.closest("[data-index]");
    if (row) choose(Number(row.dataset.index), true);
  });
  document.getElementById("drag").addEventListener("pointerdown", (event) => {
    if (event.button === 0) win.startDragging().catch(() => {});
  });
  document.getElementById("full").addEventListener("click", () => {
    emit("clipboard-picker:open-full", {}).catch(() => {});
    close();
  });
  win.onFocusChanged(({ payload }) => {
    if (payload) {
      clearTimeout(blurTimer);
      blurTimer = 0;
      hasFocused = true;
    } else if (hasFocused) {
      clearTimeout(blurTimer);
      blurTimer = setTimeout(async () => {
        blurTimer = 0;
        const nativeFocused = await win.isFocused().catch(() => false);
        if (!nativeFocused && !document.hasFocus()) close();
      }, 180);
    }
  });
  window.addEventListener("focus", () => {
    clearTimeout(blurTimer);
    blurTimer = 0;
    hasFocused = true;
  });
  refresh(false);
})();
