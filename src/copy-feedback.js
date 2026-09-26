(() => {
  "use strict";
  const states = new WeakMap();

  function feedback(button, ok = true, label = ok ? "Copied" : "Copy failed") {
    if (!button) return;
    let state = states.get(button);
    if (!state) {
      const icon = button.querySelector(".ms");
      state = { icon, glyph: icon?.textContent || "", title: button.title, timer: 0 };
      states.set(button, state);
    }
    clearTimeout(state.timer);
    button.classList.toggle("copy-confirmed", ok);
    button.classList.toggle("copy-failed", !ok);
    if (state.icon) state.icon.textContent = ok ? "check" : "error";
    button.title = label;
    state.timer = setTimeout(() => {
      if (state.icon) state.icon.textContent = state.glyph;
      button.title = state.title;
      button.classList.remove("copy-confirmed", "copy-failed");
      states.delete(button);
    }, 1300);
  }

  /** The clipboard, the old way.
   *
   *  `navigator.clipboard` is not always there to be used: it needs a secure
   *  context, and it refuses outright — NotAllowedError — whenever the
   *  document does not have focus, which is the normal state of affairs for a
   *  webview hosted inside another window. Falling back to a hidden textarea
   *  and `execCommand` is deprecated and still works everywhere, and a copy
   *  button that silently does nothing is worse than a deprecation. */
  function copyTheOldWay(text) {
    const pad = document.createElement("textarea");
    pad.value = text;
    // Off-screen rather than hidden: a field that cannot be focused cannot be
    // selected, and a selection is what execCommand copies.
    pad.setAttribute("readonly", "");
    pad.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0";
    document.body.appendChild(pad);
    try {
      pad.select();
      pad.setSelectionRange(0, pad.value.length);
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      pad.remove();
    }
  }

  async function copy(text, button, label = "Copied") {
    const value = String(text ?? "");
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("no clipboard api");
      }
      await navigator.clipboard.writeText(value);
      feedback(button, true, label);
      return true;
    } catch (error) {
      if (copyTheOldWay(value)) {
        feedback(button, true, label);
        return true;
      }
      // Last resort, and the only one that cannot be refused: WinT itself
      // owns the window, so it can put text on the Windows clipboard when
      // the page is not allowed to. Worth the round trip precisely because
      // the alternative is a button that does nothing.
      try {
        await window.__TAURI__.core.invoke("clipboard_copy_text", { text: value });
        feedback(button, true, label);
        return true;
      } catch {
        feedback(button, false);
        throw error;
      }
    }
  }

  window.wintCopy = { copy, feedback };
})();
