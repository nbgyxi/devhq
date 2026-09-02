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

  async function copy(text, button, label = "Copied") {
    try {
      await navigator.clipboard.writeText(String(text ?? ""));
      feedback(button, true, label);
      return true;
    } catch (error) {
      feedback(button, false);
      throw error;
    }
  }

  window.wintCopy = { copy, feedback };
})();
