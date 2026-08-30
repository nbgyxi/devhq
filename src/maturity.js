// How finished each tool is, said on the tool itself.
//
// DevHQ grows a tool at a time, and they are not all at the same point. A
// badge in every tool's header says which stage this one is at, and clicking
// it explains what the stage means — so "it did something odd" is something
// the user was warned about rather than something they discover.
//
// This lives in a file of its own because both windows need it: the main
// window builds its tool headers from `app.js`, and a popped-out tool builds
// the same header from `tool-popout.js`. One list, read by both.

window.devhqMaturity = (() => {
  /** The stages, in order, and what each one promises. The wording is the
   *  whole point of the badge — it has to say what the user can expect, not
   *  just colour a word. */
  const STAGES = {
    alpha: {
      label: "Alpha",
      tone: "alpha",
      short: "not tested yet",
      text: "Alpha means this tool has been built but not tested. It may be wrong, it may fail, and it may not do what it says. Check anything it tells you before you act on it.",
    },
    beta: {
      label: "Beta",
      tone: "beta",
      short: "tested, may have quirks",
      text: "Beta means this tool has been tested and should work. There may still be rough edges and odd corners, but what it reports can be relied on.",
    },
  };

  /** Every tool that is further along than the default. Everything absent from
   *  here is alpha, which is where a tool starts. */
  const AHEAD = {
    // Nothing has earned beta yet.
  };

  const DEFAULT = "alpha";

  /** The stage a tool is at. Every tool has one; there is no "unknown". */
  function stageOf(id) {
    return AHEAD[id] || DEFAULT;
  }

  function info(id) {
    return STAGES[stageOf(id)] || STAGES[DEFAULT];
  }

  /** The badge for a tool's header. Returns a button, because it is one — the
   *  explanation is a click away rather than a paragraph nobody asked for. */
  function badge(id) {
    if (!id) return "";
    const stage = stageOf(id);
    const meta = STAGES[stage] || STAGES[DEFAULT];
    return `<button class="tool-maturity ${meta.tone}" type="button" data-maturity="${stage}"
      title="What ${meta.label} means">${meta.label}<span class="ms" aria-hidden="true">help</span></button>`;
  }

  /* ------------------------------------------------------------ the popover */

  let pop = null;

  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
  }

  function open(anchor, stage) {
    close();
    const meta = STAGES[stage] || STAGES[DEFAULT];
    pop = document.createElement("div");
    pop.className = "maturity-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", `What ${meta.label} means`);
    // Both stages are listed every time: the point is the comparison, and a
    // user reading about alpha wants to know what it is short of.
    pop.innerHTML = `<div class="maturity-pop-head">How finished is this?</div>
      ${Object.entries(STAGES)
        .map(
          ([key, entry]) => `<div class="maturity-pop-row${key === stage ? " on" : ""}">
            <span class="tool-maturity ${entry.tone} static">${entry.label}</span>
            <span>${entry.text}</span>
          </div>`
        )
        .join("")}
      <div class="maturity-pop-foot">Every tool starts at Alpha and moves up once it has been through its paces.</div>`;
    document.body.appendChild(pop);

    // Anchored under the badge, pulled back inside the window if it would hang
    // off the right edge.
    const box = anchor.getBoundingClientRect();
    const width = pop.offsetWidth;
    const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
    pop.style.left = `${left}px`;
    pop.style.top = `${box.bottom + 6}px`;
  }

  // One listener for the whole window, installed once. Tool headers are
  // rebuilt constantly; a listener bound to a badge would not survive that.
  document.addEventListener("click", (event) => {
    const badgeEl = event.target.closest?.("[data-maturity]");
    if (badgeEl) {
      if (badgeEl.classList.contains("static")) return;
      event.preventDefault();
      // A second click on the same badge puts it away again.
      const wasOpen = !!pop;
      close();
      if (!wasOpen) open(badgeEl, badgeEl.dataset.maturity);
      return;
    }
    if (pop && !event.target.closest?.(".maturity-pop")) close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  window.addEventListener("resize", close);

  return { badge, stageOf, info, stages: () => ({ ...STAGES }) };
})();
