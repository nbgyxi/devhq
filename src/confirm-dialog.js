// WinT's own confirmation dialog, for the pages that are not the shell: a
// tool embedded in the shell, and a tool in a window of its own. The shell
// has its own in app.js.
//
// Every page that can host a tool must load this. A tool that asks for a
// confirmation it cannot get either does nothing or does the thing unasked,
// and the browser's own confirm box is never an acceptable stand-in.
(() => {
  "use strict";
  if (window.wintConfirm) return;
  const icon = (name) => `<span class="ms" aria-hidden="true">${name}</span>`;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  // A child WebView is a native surface above the shell's DOM. Asking the
  // shell to draw a confirmation therefore leaves its card behind this
  // WebView: the backdrop is visible around the tool, but the user has no
  // dialog to answer. Keep confirmations in the renderer that requested them.
  const confirmQueue = [];
  let confirmOpen = false;
  function showNextConfirm() {
    if (confirmOpen || !confirmQueue.length) return;
    confirmOpen = true;
    const item = confirmQueue.shift();
    const options = item.options;
    const layer = document.createElement("div");
    const tone = options.tone === "danger" ? "danger" : "accent";
    layer.className = "confirm-layer";
    layer.innerHTML = `<section class="confirm-card" role="alertdialog" aria-modal="true"
      aria-labelledby="confirm-title" aria-describedby="confirm-message">
      <span class="confirm-icon ${tone}">${icon(options.icon || "warning")}</span>
      <div class="confirm-copy"><h2 id="confirm-title">${esc(options.title || "Are you sure?")}</h2>
        <p id="confirm-message">${esc(options.message || "This action cannot be undone.")}</p></div>
      <div class="confirm-actions"><button class="btn" type="button" data-confirm="cancel">${esc(options.cancelLabel || "Cancel")}</button>
        ${options.alternateLabel ? `<button class="btn" type="button" data-confirm="alternate">${esc(options.alternateLabel)}</button>` : ""}
        <button class="btn ${tone === "danger" ? "danger" : "primary"}" type="button" data-confirm="accept">${esc(options.confirmLabel || "Continue")}</button></div>
    </section>`;
    document.body.appendChild(layer);
    let settled = false;
    const settle = (accepted) => {
      if (settled) return;
      settled = true;
      layer.remove();
      confirmOpen = false;
      item.resolve(accepted);
      showNextConfirm();
    };
    layer.addEventListener("click", (event) => {
      const action = event.target.closest("[data-confirm]")?.dataset.confirm;
      if (action) settle(action === "accept" ? true : action === "alternate" ? "alternate" : false);
      else if (event.target === layer) settle(false);
    });
    layer.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        settle(false);
      }
    });
    requestAnimationFrame(() => layer.querySelector('[data-confirm="cancel"]')?.focus());
  }
  window.wintConfirm = (options = {}) => new Promise((resolve) => {
    confirmQueue.push({ options, resolve });
    showNextConfirm();
  });
})();
