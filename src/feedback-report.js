// Saying what is broken or what is missing, in a window of its own.
//
// One entry point, in the status bar, so it is reachable from every screen
// without each tool having to carry a button of its own. The screen the user
// was on when they pressed it is what fills in the area and the route, because
// the app already knows both and asking a person to re-state where they just
// were is how a report ends up filed under the wrong thing.
//
// This is a native sibling window rather than a card in the shell, for the
// reason `feedback_show` gives: an isolated tool is a child webview floating
// over the shell's page, so anything drawn in HTML lands behind it — and the
// tool must stay on screen while it is being described, which rules out hiding
// it to make room.
//
// There is one box to write in, not a subject line and a body. Nobody composing
// a complaint wants to compose a headline for it first, so the first line of
// what they write becomes the summary the report is filed under and the whole
// thing is the detail. A single paragraph works too: the summary is then the
// paragraph, cut at a word.
//
// The form is built once and never rebuilt. Being put away and taken out again
// is a hide and a show, not a reload, so a half-written report survives it.
//
// Nothing here knows the endpoint or the key. It hands the fields to
// `feedback_submit` and is told only whether the report arrived; the secret
// lives in `src-tauri/src/feedback.rs` and never enters a webview.
(() => {
  "use strict";
  const invoke = () => window.__TAURI__?.core?.invoke;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name) => `<span class="ms" aria-hidden="true">${name}</span>`;

  // The areas a report can be filed under. A free-text box comes back as thirty
  // spellings of the same tool, and grouping is the whole point of the field.
  // Whatever the shell detected is added to this list if it is not already in
  // it, so a new tool is never unreportable.
  const AREAS = [
    "Projects and scan", "Git", "Terminals", "Torrents", "Network and speed test",
    "Link Router", "PC Detective", "Docked Sidebar", "Startup and tray",
    "Clipboard history", "The window itself", "Something else",
  ];

  // The two things anyone has to say, in their own words rather than the
  // broker's. `kind` is what goes on the wire; the rest is what the tab says,
  // how the one box asks for it, and who ends up able to read the answer.
  const KINDS = [
    {
      kind: "bug",
      tab: "Problem",
      glyph: "bug_report",
      asks: "What went wrong? The first line becomes the summary — then as much detail as you like: what you did, what you expected, and what happened instead.",
      // Said before they write, not after they send. Which of the two they pick
      // decides who can read it, and that is not something to discover after.
      seenBy: "Private — only the developers see a problem report.",
    },
    {
      kind: "request",
      tab: "Idea",
      glyph: "lightbulb",
      asks: "What would you like WinT to do? The first line becomes the summary — then as much as you want about what you are trying to get done.",
      seenBy: "Public — an idea is posted where anyone can read it and vote on it. Keep anything private out of it.",
    },
  ];

  const MAX_TITLE = 120;

  let host = null;
  let built = false;
  let configured = null;
  let kind = "bug";
  let route = "";

  const hide = () => invoke()?.("feedback_hide").catch(() => {});
  const field = (selector) => host?.querySelector(selector);
  const value = (selector) => (field(selector)?.value || "").trim();

  const said = (text, tone) => {
    const out = field("[data-feedback-said]");
    if (!out) return;
    out.textContent = text || "";
    out.dataset.tone = tone || "";
  };

  /** One box, two fields on the wire. The first line is the summary the broker
   *  files this under; everything written is the detail. A summary longer than
   *  the broker's line is cut at a word, and the full text still goes as the
   *  description, so nothing typed is ever thrown away. */
  function split(text) {
    const whole = text.trim().replace(/\r\n/g, "\n");
    let title = whole.split("\n")[0].trim();
    if (title.length > MAX_TITLE) {
      const cut = title.slice(0, MAX_TITLE);
      const word = cut.lastIndexOf(" ");
      title = `${(word > MAX_TITLE / 2 ? cut.slice(0, word) : cut).trim()}…`;
    }
    // Sending the same sentence twice tells the reader nothing.
    return { title, description: whole === title ? null : whole };
  }

  function build() {
    host.innerHTML = `
      <div class="feedback-win-head">
        ${icon("bug_report")}<span>Tell us about it</span>
        <button type="button" data-feedback-close title="Close">${icon("close")}</button>
      </div>
      <div class="feedback-win-body">
        <div class="feedback-tabs" role="tablist" aria-label="What kind of report">
          ${KINDS.map(({ kind: name, tab, glyph }) => `
            <button class="feedback-tab" type="button" role="tab" data-feedback-kind="${name}"
                    aria-selected="${name === kind}">${icon(glyph)}${tab}</button>`).join("")}
        </div>
        <div class="feedback-fields">
          <label><span data-feedback-area-label>Where</span>
            <select data-feedback-area></select>
          </label>
          <label data-feedback-when="bug"><span>How bad</span>
            <select data-feedback-severity>
              <option value="critical">It makes WinT unusable</option>
              <option value="high">It stops me doing something</option>
              <option value="medium" selected>It gets in the way</option>
              <option value="low">It is a small thing</option>
            </select>
          </label>
        </div>
        <textarea data-feedback-text maxlength="2000" aria-label="What to report"></textarea>
        <small class="feedback-seen" data-feedback-seen></small>
        <small class="feedback-note">Nothing is attached but what is in this box, the version you are running, the screen you were on and an anonymous number that lets a reply be matched to a report — never a path, a project name or anything you typed elsewhere.</small>
      </div>
      <div class="feedback-win-foot">
        <span class="feedback-said" data-feedback-said aria-live="polite"></span>
        <button class="btn primary" type="button" data-feedback-send>${icon("send")}Send it</button>
      </div>`;

    host.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-feedback-kind]");
      if (tab) return chooseKind(tab.dataset.feedbackKind);
      if (event.target.closest("[data-feedback-close]")) return hide();
      if (event.target.closest("[data-feedback-send]")) send();
    });
    built = true;
  }

  /** Switches the tab, and with it the one field's question, who will be able to
   *  read the answer, and whether a severity is asked for at all — the broker
   *  refuses a request that carries one, so the form cannot offer it. What is
   *  already typed is kept: the same sentence is usually the right one under
   *  either heading. */
  function chooseKind(next) {
    kind = KINDS.some((entry) => entry.kind === next) ? next : "bug";
    const chosen = KINDS.find((entry) => entry.kind === kind);
    host.querySelectorAll("[data-feedback-kind]").forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab.dataset.feedbackKind === kind));
    });
    host.querySelectorAll("[data-feedback-when]").forEach((node) => {
      node.hidden = node.dataset.feedbackWhen !== kind;
    });
    const label = field("[data-feedback-area-label]");
    if (label) label.textContent = kind === "bug" ? "Where" : "About";
    const text = field("[data-feedback-text]");
    if (text) text.placeholder = chosen.asks;
    const seen = field("[data-feedback-seen]");
    if (seen) {
      seen.textContent = chosen.seenBy;
      seen.dataset.tone = kind === "request" ? "public" : "private";
    }
    said("");
  }

  /** Fills the area list, putting whatever the shell detected at the top and
   *  selecting it. The user can still change it — the detection is a good guess
   *  about where they were, not a claim about what the report is. */
  function followArea(area) {
    const select = field("[data-feedback-area]");
    if (!select) return;
    const options = AREAS.includes(area) || !area ? AREAS : [area, ...AREAS];
    select.innerHTML = options.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
    select.value = area && options.includes(area) ? area : "Something else";
  }

  /** Whether this build has a feedback service at all. Asked once, and said
   *  before anything is typed rather than after it is lost on the press. */
  function checkConfigured() {
    if (configured !== null) return applyConfigured();
    invoke()?.("feedback_configured")
      .then((ready) => {
        configured = ready === true;
        applyConfigured();
      })
      .catch(() => {});
  }

  function applyConfigured() {
    const sendButton = field("[data-feedback-send]");
    if (!sendButton) return;
    sendButton.disabled = configured === false;
    if (configured === false) {
      said("This build has no feedback service set up, so there is nowhere to send this.", "warn");
    }
  }

  async function send() {
    const written = value("[data-feedback-text]");
    if (!written) {
      said(kind === "bug" ? "Say what went wrong and it goes." : "Say what you would like and it goes.", "warn");
      return field("[data-feedback-text]")?.focus();
    }
    const { title, description } = split(written);
    const sendButton = field("[data-feedback-send]");
    sendButton.disabled = true;
    said("Sending…");
    try {
      const area = value("[data-feedback-area]");
      const receipt = await invoke()?.("feedback_submit", {
        report: {
          kind,
          title,
          description,
          severity: kind === "bug" ? value("[data-feedback-severity]") : null,
          area: kind === "bug" ? area : null,
          category: kind === "request" ? area : null,
          reporter: window.wintVisitorId?.() || null,
          page: kind === "bug" ? route || null : null,
        },
      });
      field("[data-feedback-text]").value = "";
      said(receipt?.id ? `Sent. It is on their list as ${receipt.id}.` : "Sent. Thank you.", "ok");
    } catch (error) {
      // A report that could not be sent is a disappointment, never a fault of
      // the app: nothing else about this window changes.
      said(String(error), "warn");
    } finally {
      sendButton.disabled = configured === false;
    }
  }

  window.wintFeedbackReport = {
    mount(node) {
      host = node;
    },

    /** Called once by the page, then again by `feedback_show` every time the
     *  window is brought back — with whatever the shell has worked out about the
     *  screen the user is on now. The draft is deliberately left alone: a
     *  half-written report follows the user rather than filing itself under
     *  wherever they happened to start it. */
    show(context = {}) {
      if (!host) return;
      if (!built) build();
      if (context.page) route = context.page;
      followArea(context.area || "");
      chooseKind(context.kind || kind);
      checkConfigured();
      field("[data-feedback-text]")?.focus();
    },
  };
})();
