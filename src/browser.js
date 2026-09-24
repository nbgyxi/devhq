// Browser: where every link on this PC goes.
//
// WinT is registered with Windows as a browser (browser_assoc.rs) but does not
// render a page. When it is the default, every link arrives here as a command
// line and browser_rules.rs sends it on — to the browser and profile a rule
// names, or to the chooser window when nothing claims it.
//
// This page is the rules. Nothing it does touches a link that is in flight:
// the routing runs in the backend whether this page has ever been opened or
// not, and every button here reads or writes the same saved list.
//
// Two rules shape the drawing:
//
//  * Inputs are mounted once. The detail panel is rebuilt when a *different*
//    rule is selected and never while one is being edited, so a half-typed
//    pattern and the caret in it survive everything the list does.
//  * Nothing is silent. Reading Windows' associations, reading the installed
//    browsers and saving the rules each register a named line in the status
//    bar, because each of them is a disk or a registry away.

(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name) => window.wintShell?.icon?.(name) || `<span class="ms" aria-hidden="true">${name}</span>`;
  const work = (key, label, promise) => {
    window.wintWork?.beginWork(key, label);
    return promise.finally(() => window.wintWork?.endWork(key));
  };

  let host = null;
  /** What Windows thinks WinT is. Null until the first answer comes back, so
   *  the card can draw a skeleton rather than a wrong reading. */
  let assoc = null;
  /** Every browser × profile pair on this PC, flattened the same way the
   *  chooser flattens them: one row, one answerable target. */
  let targets = [];
  let targetsLoaded = false;
  let rules = { rules: [], unmatched: null, shortlist: [], askKey: "shift" };
  let rulesLoaded = false;
  /** The rule open in the detail panel, by id, or "" for the defaults pane
   *  and "new" for the rule being written. */
  let selected = "";
  /** The rule being edited, as a working copy. Saved on Save, dropped on
   *  anything else — a list that rewrote itself under a half-typed pattern
   *  would be worse than no editing at all. */
  let draft = null;
  let testUrl = "";
  let testResult = null;
  /** The active tab of every browser window, read off the screen. The source
   *  for both "add a rule for something I have open" and the suggestions,
   *  because the browsers on screen already show which sites belong in which
   *  profile — which is the whole question a rule answers. */
  let tabs = [];
  let tabsLoaded = false;
  /** Suggestions the user has ticked off, by host, so a redraw does not undo
   *  a decision they have already made about one. */
  let dismissed = new Set();

  /** The three ways a pattern can be read, each shown as the thing it
   *  actually matches rather than as a word for it. "Domain and below" needs
   *  explaining; `x.com + *.x.com` does not. */
  const SCOPES = [
    ["domain", "example.com + *.example.com", "The host and every subdomain of it"],
    ["host", "example.com only", "That exact host — mail.example.com would not match"],
    ["url", "https://example.com/… (starts with)", "Every link beginning with this text"],
  ];

  /** The same thing written against a real pattern, for a rule that has one. */
  const scopeLabel = (scope, pattern = "") => {
    const name = pattern || "example.com";
    if (scope === "url") return `${name}…`;
    if (scope === "host") return `${name} only`;
    return `${name} + *.${name}`;
  };

  const targetKey = (exe, profile) => `${exe || ""}\u0000${profile || ""}`;
  const isTarget = (a, b) => targetKey(a.exe, a.profile) === targetKey(b.exe, b.profile);

  /** Everywhere a rule may send a link.
   *
   *  A rule saved by a build that only knew one browser has no `targets` and
   *  one set of loose fields instead; reading it as a shortlist of one is
   *  what keeps the rest of this file from caring which shape it is in. */
  const ruleTargets = (rule) => {
    if (rule.targets?.length) return rule.targets;
    return rule.exe ? [{ exe: rule.exe, browser: rule.browser, profile: rule.profile, profileName: rule.profileName }] : [];
  };

  const installed = (target) => targets.some((known) => isTarget(known, target));

  const flatten = (browsers) => {
    const rows = [];
    for (const browser of browsers) {
      if (!browser.profiles?.length) {
        rows.push({ exe: browser.exe, browser: browser.name, profile: null, profileName: null });
        continue;
      }
      for (const profile of browser.profiles) {
        rows.push({
          exe: browser.exe,
          browser: browser.name,
          profile: profile.dir,
          profileName: profile.name || profile.dir,
        });
      }
    }
    return rows;
  };

  const oneName = (target) => {
    const profile = target.profileName || target.profile;
    return profile ? `${target.browser} · ${profile}` : target.browser || "No browser";
  };

  /** What a rule does, in one line. A rule with one browser opens there; a
   *  rule with several asks between them, and saying so is the difference
   *  between a list that can be read and one that has to be clicked through. */
  const targetName = (rule) => {
    const list = ruleTargets(rule);
    if (!list.length) return "No browser";
    if (list.length === 1) return oneName(list[0]);
    return `asks between ${list.map(oneName).join(", ")}`;
  };

  // ---------------------------------------------------------------- drawing

  function draw() {
    if (!host) return;
    host.innerHTML = `
      <section class="br-default" data-br-default>${defaultCard()}</section>
      <section class="br-body">
        <aside class="br-list" data-br-list>${listPane()}</aside>
        <section class="br-detail" data-br-detail>${detailPane()}</section>
      </section>`;
    bind();
  }

  /** Only the rules column, for the many changes that cannot have touched the
   *  association card or what is open in the detail panel. */
  function drawList() {
    const node = host?.querySelector("[data-br-list]");
    if (!node) return;
    node.innerHTML = listPane();
  }

  /** Rebuild the whole right-hand pane. Only for a genuine change of what it
   *  is showing — a different rule, or the defaults pane arriving in place of
   *  an editor. Where the scroll position still means something afterwards it
   *  is put back, because a pane that jumps to the top is a pane that loses
   *  the user's place for no reason they can see. */
  function drawDetail() {
    const node = host?.querySelector("[data-br-detail]");
    if (!node) return;
    const scrolled = node.querySelector(".br-form")?.scrollTop || 0;
    node.innerHTML = detailPane();
    if (scrolled) {
      const form = node.querySelector(".br-form");
      if (form) form.scrollTop = scrolled;
    }
  }

  /** Just the suggestions.
   *
   *  Agreeing with one suggestion changes one row. Redrawing the pane around
   *  it threw away both scroll positions — the pane's and the list's — and
   *  the page jumped to the top under the button that had just been pressed.
   */
  function drawSuggest() {
    const node = host?.querySelector("[data-br-suggest]");
    if (!node) return;
    const form = host.querySelector("[data-br-detail] .br-form");
    const paneScroll = form?.scrollTop || 0;
    const listScroll = node.querySelector(".br-suggest")?.scrollTop || 0;
    node.outerHTML = suggestPanel();
    if (form) form.scrollTop = paneScroll;
    const list = host.querySelector("[data-br-suggest] .br-suggest");
    if (list) list.scrollTop = listScroll;
  }

  /** Take one suggestion out of the list without rebuilding any of it. The
   *  row is gone and the count on "Add all" is one lower; nothing else about
   *  the panel has changed, so nothing else is touched. */
  function dropSuggestion(hostname) {
    const row = host?.querySelector(`[data-br-sug-host="${CSS.escape(hostname)}"]`);
    if (!row) return drawSuggest();
    const panel = row.closest("[data-br-suggest]");
    row.remove();
    const left = panel?.querySelectorAll(".br-sug").length || 0;
    // The last one going means the panel now says something different -
    // "every site open right now already has a rule" - which is a real
    // change of what it shows, so it is rebuilt.
    if (!left) return drawSuggest();
    const all = panel.querySelector("[data-br-sug-all]");
    if (all) all.innerHTML = `${icon("playlist_add")}Add all ${left}`;
  }

  function drawDefault() {
    const node = host?.querySelector("[data-br-default]");
    if (!node) return;
    node.innerHTML = defaultCard();
  }

  function defaultCard() {
    if (!assoc) {
      return `<div class="br-skeleton"><span></span><span></span></div>`;
    }
    if (!assoc.supported) {
      return `<div class="win-empty">Routing links is a Windows feature.</div>`;
    }
    const isDefault = assoc.defaultHttp && assoc.defaultHttps;
    const owner = assoc.httpsOwner || assoc.httpOwner;
    const state = isDefault
      ? ["check_circle", "ok", "WinT opens every link on this PC", `Each one goes to the browser its rule names; anything with no rule ${rules.unmatched ? `opens in ${esc(oneName(rules.unmatched))}` : "asks first"}.`]
      : assoc.registered
        ? ["pending", "warn", "WinT is offered but not chosen", owner ? `Windows still opens links with ${esc(owner)}. Only you can change that, in Default apps.` : "Windows has not been told to use WinT yet. Only you can change that, in Default apps."]
        : ["link_off", "warn", "WinT is not registered as a browser", "Register it and Windows will list WinT under Default apps → Web browser."];
    const other = assoc.otherExe
      ? `<p class="br-note">${icon("warning")}Another copy of WinT is registered: <span class="mono">${esc(assoc.otherExe)}</span>. Registering again points Windows at this one.</p>`
      : "";
    return `
      <div class="br-state ${state[1]}">${icon(state[0])}<span><strong>${state[2]}</strong><small>${state[3]}</small></span>
        <div class="br-state-actions">
          ${isDefault ? "" : `<button class="btn primary" data-br-default-choose>${icon("open_in_new")}${assoc.registered ? "Open Default apps" : "Register and choose"}</button>`}
          ${assoc.registered ? `<button class="btn" data-br-unregister>${icon("link_off")}Remove from the browser list</button>` : ""}
          <button class="btn" data-br-refresh title="Read what Windows says now">${icon("refresh")}</button>
        </div>
      </div>${other}`;
  }

  function listPane() {
    const rows = rulesLoaded
      ? rules.rules.length
        ? rules.rules
            .slice()
            .sort((a, b) => (b.uses || 0) - (a.uses || 0) || a.pattern.localeCompare(b.pattern))
            .map(ruleRow)
            .join("")
        : `<div class="win-empty">No rules yet. Every link will ask which browser to use, and each answer you tell it to remember lands here.</div>`
      : `<div class="br-skeleton"><span></span><span></span><span></span></div>`;
    return `
      <header>${icon("rule")}<strong>Rules</strong><small>${rulesLoaded ? `${rules.rules.length}` : "…"}</small>
        <button class="btn small" data-br-new${targetsLoaded && !targets.length ? " disabled" : ""}>${icon("add")}Add</button>
      </header>
      <div class="br-rows">${rows}</div>
      <footer>
        <label>${icon("travel_explore")}<input type="text" data-br-test placeholder="Try a link — https://example.com/…" value="${esc(testUrl)}" spellcheck="false" /></label>
        <div class="br-test-result" data-br-test-result>${testLine()}</div>
      </footer>`;
  }

  function testLine() {
    if (!testUrl.trim()) return `<small>Type an address to see which rule would take it.</small>`;
    if (testResult === null) return `<small>Checking…</small>`;
    if (!testResult) return `<small>${icon("help")}No rule matches — this one would ask.</small>`;
    return `<small class="match">${icon("check_circle")}${esc(testResult.pattern)} → ${esc(targetName(testResult))}</small>`;
  }

  function ruleRow(rule) {
    const list = ruleTargets(rule);
    // A rule naming a browser that has since been uninstalled still routes —
    // to the rest of its shortlist — but it is worth saying so.
    const missing = targetsLoaded ? list.filter((target) => !installed(target)).length : 0;
    const glyph = !rule.enabled ? "radio_button_unchecked" : missing ? "warning" : list.length > 1 ? "alt_route" : "check_circle";
    return `<button class="br-row${selected === rule.id ? " on" : ""}${rule.enabled ? "" : " off"}" data-br-rule="${esc(rule.id)}">
      ${icon(glyph)}
      <span><strong>${esc(scopeLabel(rule.scope, rule.pattern))}</strong><small>${esc(targetName(rule))}${missing ? ` · ${missing} not installed` : ""}</small></span>
      <em>${rule.uses ? `${rule.uses}×` : ""}</em>
    </button>`;
  }

  /** The browsers a rule may use, as a checklist.
   *
   *  A checklist and not a menu, because the answer is genuinely allowed to
   *  be more than one: some sites belong in whichever browser you happen to
   *  be thinking in, and the useful rule for those is the short list, not a
   *  guess between them. */
  function targetChecklist(chosen) {
    if (!targetsLoaded) return `<div class="br-skeleton"><span></span><span></span></div>`;
    if (!targets.length) return `<div class="win-empty">No other browser is installed on this PC.</div>`;
    const rows = targets
      .map((target) => {
        const key = targetKey(target.exe, target.profile);
        const on = chosen.some((pick) => isTarget(pick, target));
        const label = target.profileName ? `${target.browser} · ${target.profileName}` : target.browser;
        return `<label class="br-pick${on ? " on" : ""}"><input type="checkbox" data-br-target="${esc(key)}"${on ? " checked" : ""} /><span>${esc(label)}</span></label>`;
      })
      .join("");
    // A rule naming an uninstalled browser keeps it: the browser may come
    // back, and dropping it silently would change where links go.
    const gone = chosen
      .filter((pick) => !installed(pick))
      .map(
        (pick) =>
          `<label class="br-pick gone"><input type="checkbox" data-br-target="${esc(targetKey(pick.exe, pick.profile))}" checked /><span>${esc(oneName(pick))} — not installed</span></label>`,
      )
      .join("");
    return `<div class="br-picks">${rows}${gone}</div>`;
  }

  function detailPane() {
    if (draft) return editPane(draft);
    return defaultsPane();
  }

  /** Sites that are open right now and have no rule yet.
   *
   *  One per host, attributed to the profile it is actually open in — which
   *  is the answer the user would have given anyway, read off the screen
   *  instead of asked for. A host that already matches a rule is not
   *  suggested: the rule is the decision, and this must never look like it
   *  is asking to be made again. */
  function suggestions() {
    const seen = new Map();
    for (const tab of tabs) {
      if (dismissed.has(tab.host)) continue;
      // Already routed, by whatever rule claims it.
      if (rules.rules.some((rule) => coversHost(rule, tab.host))) continue;
      const found = seen.get(tab.host);
      if (found) {
        // The same site open in two profiles is a genuine shortlist: it is
        // exactly the case a rule with several browsers exists for.
        if (!found.targets.some((target) => isTarget(target, tab))) {
          found.targets.push({ exe: tab.exe, browser: tab.browser, profile: tab.profile, profileName: tab.profileName });
        }
        continue;
      }
      seen.set(tab.host, {
        host: tab.host,
        title: tab.title,
        targets: [{ exe: tab.exe, browser: tab.browser, profile: tab.profile, profileName: tab.profileName }],
      });
    }
    return [...seen.values()];
  }

  /** Whether a rule already decides where this host's links go. Deliberately
   *  simpler than the backend's matcher: a suggestion is only worth hiding
   *  when a rule plainly covers the host, and a URL-prefix rule does not. */
  function coversHost(rule, host) {
    if (!rule.enabled) return false;
    if (rule.scope === "host") return rule.pattern === host;
    if (rule.scope === "domain") return host === rule.pattern || host.endsWith(`.${rule.pattern}`);
    return false;
  }

  function editPane(rule) {
    const isNew = rule.id === "new";
    return `
      <header>${icon(isNew ? "add_circle" : "rule")}<strong>${isNew ? "New rule" : "Edit rule"}</strong>
        <button class="tool-close" data-br-cancel title="Close without saving">${icon("close")}</button>
      </header>
      <div class="br-form">
        <label>What to match
          <input type="text" data-br-pattern value="${esc(rule.pattern)}" placeholder="example.com" spellcheck="false" autocomplete="off" />
        </label>
        <label>How to match it
          <select data-br-scope>${scopeOptions(rule)}</select>
        </label>
        <div class="br-field"><span>Open it in</span>
          ${targetChecklist(ruleTargets(rule))}
        </div>
        <label class="br-check"><input type="checkbox" data-br-enabled${rule.enabled ? " checked" : ""} /><span>Use this rule</span></label>
        <p class="br-hint">${icon("info")}${esc(hintFor(rule))}</p>
        <div class="br-form-actions">
          <button class="btn primary" data-br-save>${icon("save")}${isNew ? "Add rule" : "Save"}</button>
          ${isNew ? "" : `<button class="btn danger" data-br-delete>${icon("delete")}Delete</button>`}
          <button class="btn" data-br-cancel>Cancel</button>
        </div>
      </div>`;
  }

  /** The three readings, written against whatever has been typed so far, so
   *  the difference between them is visible rather than described. */
  function scopeOptions(rule) {
    const typed = rule.pattern.trim().toLowerCase();
    return SCOPES.map(([id, sample, hint]) => {
      const label = typed ? scopeLabel(id, typed) : sample;
      return `<option value="${id}"${id === rule.scope ? " selected" : ""} title="${esc(hint)}">${esc(label)}</option>`;
    }).join("");
  }

  function hintFor(rule) {
    const pattern = rule.pattern.trim().toLowerCase() || "example.com";
    const count = ruleTargets(rule).length;
    const where = count === 0
      ? "nothing is chosen yet, so these links will ask between every browser"
      : count === 1
        ? "go straight there"
        : `put the chooser up with those ${count} on it and nothing else`;
    if (rule.scope === "url") return `Links beginning with ${pattern} ${where}. Anything else about that site still asks.`;
    if (rule.scope === "host") return `Links on ${pattern} ${where}. Its subdomains still ask.`;
    return `Links on ${pattern} and every subdomain of it ${where}.`;
  }

  function defaultsPane() {
    const unmatched = rules.unmatched;
    const shortlist = rules.shortlist || [];
    return `
      <header>${icon("help")}<strong>When nothing matches</strong></header>
      <div class="br-form">
        <label>A link no rule covers
          <select data-br-unmatched>
            <option value=""${unmatched ? "" : " selected"}>Asks which browser to use</option>
            ${targets
              .map((target) => {
                const key = targetKey(target.exe, target.profile);
                const label = target.profileName ? `${target.browser} · ${target.profileName}` : target.browser;
                return `<option value="${esc(key)}"${unmatched && key === targetKey(unmatched.exe, unmatched.profile) ? " selected" : ""}>Opens in ${esc(label)}</option>`;
              })
              .join("")}
          </select>
        </label>
        <p class="br-hint">${icon("info")}${unmatched
          ? `Anything with no rule goes straight to ${esc(oneName(unmatched))} without asking. The status bar still names where each one went, so a site that should have had a rule of its own is easy to notice.`
          : "Nothing opens until you answer. Pick a browser above instead and only the sites with rules are treated specially — everything else just opens."}</p>
        ${unmatched ? "" : `<div class="br-field"><span>Offer these in the chooser</span>
          ${shortlistChecklist(shortlist)}
        </div>
        <p class="br-hint">${icon("info")}${shortlist.length
          ? `Only these ${shortlist.length} are shown for a link with no rule. The chooser still has a way through to the rest when you need it.`
          : "Nothing is ticked, so every browser and profile on this PC is offered. Tick a few and the chooser gets shorter."}</p>`}
        <label>Hold this while clicking a link to be asked anyway
          <select data-br-askkey>
            ${[["shift", "Shift"], ["ctrl", "Ctrl"], ["alt", "Alt"], ["none", "Nothing — never override"]]
              .map(([value, label]) => `<option value="${value}"${(rules.askKey || "shift") === value ? " selected" : ""}>${esc(label)}</option>`)
              .join("")}
          </select>
        </label>
        <p class="br-hint">${icon("info")}${(rules.askKey || "shift") === "none"
          ? "Links always go where the rules send them. The only way to send one somewhere else is to change a rule first."
          : `Holding ${esc({ shift: "Shift", ctrl: "Ctrl", alt: "Alt" }[rules.askKey || "shift"])} beats every rule and every default for that one link — and the chooser then offers to settle the rule it overrode. Keep holding it until the chooser appears: WinT reads the key when the link reaches it, a moment after the click rather than during it.`}</p>
        ${suggestPanel()}
        ${targetsLoaded ? `<p class="br-note">${icon("public")}${targets.length} browser ${targets.length === 1 ? "profile" : "profiles"} found on this PC.</p>` : `<div class="br-skeleton"><span></span></div>`}
      </div>`;
  }

  /** What is open right now, offered as rules.
   *
   *  The point is the first five minutes: nobody with no rules yet has the
   *  appetite to write eight of them from memory. The browsers are already
   *  open and already sorted into profiles, so the list of sites-to-profiles
   *  writes itself and all that is left to do is agree with it. */
  function suggestPanel() {
    if (!tabsLoaded) {
      return `<div class="br-field" data-br-suggest><span>From what you have open</span><div class="br-skeleton"><span></span><span></span></div></div>`;
    }
    const found = suggestions();
    if (!found.length) {
      return `<div class="br-field" data-br-suggest><span>From what you have open</span>
        <p class="br-hint">${icon("check_circle")}${tabs.length
          ? "Every site open right now already has a rule."
          : "No browser window is showing a page. Open the sites you use in the profiles you use them in, then look again — WinT reads the address bar of each window and offers a rule per site."}</p>
        <div class="br-form-actions"><button class="btn" data-br-rescan>${icon("refresh")}Look again</button></div>
      </div>`;
    }
    return `<div class="br-field" data-br-suggest><span>From what you have open</span>
      <div class="br-suggest">
        ${found
          .map(
            (item) => `<div class="br-sug" data-br-sug-host="${esc(item.host)}">
              ${icon(item.targets.length > 1 ? "alt_route" : "public")}
              <span><strong>${esc(item.host)}</strong><small>${esc(item.targets.map(oneName).join(", "))}${item.title ? ` · ${esc(item.title)}` : ""}</small></span>
              <button class="btn small" data-br-sug-add="${esc(item.host)}" title="Add this rule">${icon("add")}</button>
              <button class="btn small" data-br-sug-skip="${esc(item.host)}" title="Not this one">${icon("close")}</button>
            </div>`,
          )
          .join("")}
      </div>
      <div class="br-form-actions">
        <button class="btn primary" data-br-sug-all>${icon("playlist_add")}Add all ${found.length}</button>
        <button class="btn" data-br-rescan>${icon("refresh")}Look again</button>
      </div>
      <p class="br-hint">${icon("info")}One rule per site, sending it to the profile it is open in now. A site open in two profiles becomes a rule that asks between those two. WinT reads each window's address bar, so this is the tab showing in each window — not every tab you have.</p>
    </div>`;
  }

  /** The same checklist as a rule's, for the browsers the chooser offers when
   *  nothing else has narrowed a link. Separate markup so a click on one can
   *  never be mistaken for a click on the other. */
  function shortlistChecklist(chosen) {
    if (!targetsLoaded) return `<div class="br-skeleton"><span></span><span></span></div>`;
    if (!targets.length) return `<div class="win-empty">No other browser is installed on this PC.</div>`;
    return `<div class="br-picks">${targets
      .map((target) => {
        const key = targetKey(target.exe, target.profile);
        const on = chosen.some((pick) => isTarget(pick, target));
        const label = target.profileName ? `${target.browser} · ${target.profileName}` : target.browser;
        return `<label class="br-pick${on ? " on" : ""}"><input type="checkbox" data-br-shortlist="${esc(key)}"${on ? " checked" : ""} /><span>${esc(label)}</span></label>`;
      })
      .join("")}</div>`;
  }

  // ---------------------------------------------------------------- actions

  /** Assigned rather than added: mounting the same node twice must not leave
   *  two listeners behind, which would save every edit twice. */
  function bind() {
    host.onclick = onClick;
    host.oninput = onInput;
    host.onchange = onChange;
  }

  function onClick(event) {
    const target = event.target;
    if (target.closest("[data-br-default-choose]")) return chooseDefault();
    if (target.closest("[data-br-unregister]")) return unregister();
    if (target.closest("[data-br-refresh]")) return loadAssoc();
    if (target.closest("[data-br-new]")) return startNew();
    if (target.closest("[data-br-cancel]")) {
      draft = null;
      selected = "";
      drawList();
      drawDetail();
      return;
    }
    if (target.closest("[data-br-save]")) return saveDraft();
    if (target.closest("[data-br-delete]")) return deleteDraft();
    if (target.closest("[data-br-rescan]")) return loadTabs();
    const add = target.closest("[data-br-sug-add]");
    if (add) return acceptSuggestion(add.dataset.brSugAdd);
    const skip = target.closest("[data-br-sug-skip]");
    if (skip) {
      dismissed.add(skip.dataset.brSugSkip);
      dropSuggestion(skip.dataset.brSugSkip);
      return;
    }
    if (target.closest("[data-br-sug-all]")) return acceptAllSuggestions();
    const row = target.closest("[data-br-rule]");
    if (row) return openRule(row.dataset.brRule);
  }

  function onInput(event) {
    if (event.target.matches("[data-br-pattern]")) {
      if (!draft) return;
      draft.pattern = event.target.value;
      const hint = host.querySelector(".br-hint");
      if (hint) hint.innerHTML = `${icon("info")}${esc(hintFor(draft))}`;
      // The three readings are written against what has been typed, so they
      // are rewritten as it is typed. Safe to replace: the caret is in the
      // pattern box, never in this select.
      const scopes = host.querySelector("[data-br-scope]");
      if (scopes && document.activeElement !== scopes) scopes.innerHTML = scopeOptions(draft);
      return;
    }
    if (event.target.matches("[data-br-test]")) {
      testUrl = event.target.value;
      queueTest();
    }
  }

  function onChange(event) {
    const node = event.target;
    if (node.matches("[data-br-scope]") && draft) {
      draft.scope = node.value;
      const hint = host.querySelector(".br-hint");
      if (hint) hint.innerHTML = `${icon("info")}${esc(hintFor(draft))}`;
      return;
    }
    if (node.matches("[data-br-target]") && draft) {
      const key = node.dataset.brTarget;
      const target = targets.find((t) => targetKey(t.exe, t.profile) === key)
        // An uninstalled browser the rule still names has no row in the pool
        // to look up, so it comes back off the draft itself.
        || draft.targets.find((t) => targetKey(t.exe, t.profile) === key);
      if (!target) return;
      draft.targets = node.checked
        ? [...draft.targets.filter((pick) => !isTarget(pick, target)), { exe: target.exe, browser: target.browser, profile: target.profile, profileName: target.profileName }]
        : draft.targets.filter((pick) => !isTarget(pick, target));
      node.closest(".br-pick")?.classList.toggle("on", node.checked);
      const hint = host.querySelector(".br-hint");
      if (hint) hint.innerHTML = `${icon("info")}${esc(hintFor(draft))}`;
      return;
    }
    if (node.matches("[data-br-shortlist]")) {
      const target = targets.find((t) => targetKey(t.exe, t.profile) === node.dataset.brShortlist);
      if (!target) return;
      const current = rules.shortlist || [];
      rules.shortlist = node.checked
        ? [...current.filter((pick) => !isTarget(pick, target)), { exe: target.exe, browser: target.browser, profile: target.profile, profileName: target.profileName }]
        : current.filter((pick) => !isTarget(pick, target));
      node.closest(".br-pick")?.classList.toggle("on", node.checked);
      save();
      // The sentence under the list counts what is ticked, so it has to be
      // redrawn - but not the list itself, which the user is still clicking.
      const hints = host.querySelectorAll("[data-br-detail] .br-hint");
      if (hints[1]) {
        hints[1].innerHTML = `${icon("info")}${esc(rules.shortlist.length
          ? `Only these ${rules.shortlist.length} are shown for a link with no rule. The chooser still has a way through to the rest when you need it.`
          : "Nothing is ticked, so every browser and profile on this PC is offered. Tick a few and the chooser gets shorter.")}`;
      }
      return;
    }
    if (node.matches("[data-br-enabled]") && draft) {
      draft.enabled = node.checked;
      return;
    }
    if (node.matches("[data-br-askkey]")) {
      rules.askKey = node.value;
      save();
      drawDetail();
      return;
    }
    if (node.matches("[data-br-unmatched]")) {
      const target = targets.find((t) => targetKey(t.exe, t.profile) === node.value);
      rules.unmatched = target
        ? { exe: target.exe, browser: target.browser, profile: target.profile, profileName: target.profileName }
        : null;
      save();
      // Choosing a browser here takes the chooser out of the picture
      // entirely, so the shortlist that feeds it stops being shown. The pane
      // has to be redrawn for that, and nothing in it is mid-edit.
      drawDetail();
    }
  }

  function startNew() {
    const first = targets[0];
    draft = {
      id: "new",
      pattern: "",
      scope: "domain",
      // One browser ticked to begin with: a rule that opens somewhere is the
      // common case, and ticking a second is what turns it into a shortlist.
      targets: first ? [{ exe: first.exe, browser: first.browser, profile: first.profile, profileName: first.profileName }] : [],
      exe: "",
      browser: "",
      profile: null,
      profileName: null,
      enabled: true,
      created: Date.now(),
      uses: 0,
    };
    selected = "new";
    drawList();
    drawDetail();
    host.querySelector("[data-br-pattern]")?.focus();
  }

  function openRule(id) {
    const rule = rules.rules.find((entry) => entry.id === id);
    if (!rule) return;
    // A copy deep enough that ticking a browser cannot change the saved rule
    // before Save is pressed.
    draft = { ...rule, targets: ruleTargets(rule).map((target) => ({ ...target })) };
    selected = id;
    drawList();
    drawDetail();
    host.querySelector("[data-br-pattern]")?.focus();
  }

  function saveDraft() {
    if (!draft) return;
    const pattern = draft.pattern.trim().toLowerCase();
    if (!pattern) {
      host.querySelector("[data-br-pattern]")?.focus();
      return;
    }
    // The loose single-browser fields are cleared on the way out: everything
    // that reads a rule reads `targets`, and leaving both would let them
    // disagree about where a link goes.
    const rule = { ...draft, pattern, exe: "", browser: "", profile: null, profileName: null };
    if (rule.id === "new") {
      rule.id = `${Date.now()}-${rules.rules.length}`;
      rules.rules.push(rule);
    } else {
      const index = rules.rules.findIndex((entry) => entry.id === rule.id);
      if (index >= 0) rules.rules[index] = rule;
    }
    draft = null;
    selected = "";
    drawList();
    drawDetail();
    save();
  }

  function deleteDraft() {
    if (!draft || draft.id === "new") return;
    rules.rules = rules.rules.filter((entry) => entry.id !== draft.id);
    draft = null;
    selected = "";
    drawList();
    drawDetail();
    save();
  }

  /** Turn one suggestion into a real rule.
   *
   *  A domain rule, because `x.com` open in a profile almost always means
   *  `*.x.com` belongs there too, and the scope can be narrowed afterwards in
   *  two clicks. The rule is not opened for editing: the whole point of a
   *  suggestion is that agreeing with it is one press. */
  function ruleFromSuggestion(item) {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pattern: item.host,
      scope: "domain",
      targets: item.targets,
      exe: "",
      browser: "",
      profile: null,
      profileName: null,
      enabled: true,
      created: Date.now(),
      uses: 0,
    };
  }

  function acceptSuggestion(hostname) {
    const item = suggestions().find((entry) => entry.host === hostname);
    if (!item) return;
    rules.rules.push(ruleFromSuggestion(item));
    drawList();
    // One row leaves the panel. The panel around it, and the pane around
    // that, are exactly as they were, so neither is redrawn and neither
    // loses where the user had scrolled to.
    dropSuggestion(hostname);
    save();
  }

  function acceptAllSuggestions() {
    const found = suggestions();
    if (!found.length) return;
    for (const item of found) rules.rules.push(ruleFromSuggestion(item));
    drawList();
    // Every row goes at once, so the panel really does become something
    // else. Only the panel, though - the pane keeps its scroll.
    drawSuggest();
    save();
  }

  function save() {
    return work("tool:browser:save", "Saving link rules", invoke("browser_rules_save", { rules }))
      .then(() => runTest())
      .catch((error) => console.error("Could not save the link rules", error));
  }

  // ------------------------------------------------------------------ loads

  function loadAssoc() {
    return work("tool:browser:assoc", "Reading Windows' default browser", invoke("browser_assoc_status"))
      .then((value) => {
        assoc = value;
        drawDefault();
        // Opening this page is the proof that routing links is something this
        // install does — the same trade the Torrents tool makes. Registering
        // only makes WinT *appear* in Default apps; it changes nothing the
        // user has already chosen.
        if (value?.supported && !value.registered && !value.otherExe) return register();
      })
      .catch((error) => console.error("Could not read the browser association", error));
  }

  function register() {
    return work("tool:browser:register", "Registering WinT as a browser", invoke("browser_assoc_register"))
      .then((value) => {
        assoc = value;
        drawDefault();
      })
      .catch((error) => console.error("Could not register WinT as a browser", error));
  }

  function unregister() {
    return work("tool:browser:unregister", "Removing WinT from the browser list", invoke("browser_assoc_unregister"))
      .then((value) => {
        assoc = value;
        drawDefault();
      })
      .catch((error) => console.error("Could not remove the browser handler", error));
  }

  function chooseDefault() {
    // Windows puts its own page up and waits for a person. The status bar says
    // where the app has gone until it comes back.
    return work("tool:browser:default", "Asking Windows about the default browser", invoke("browser_assoc_choose_default"))
      .then((value) => {
        assoc = value;
        drawDefault();
      })
      .catch((error) => console.error("Could not open Default apps", error));
  }

  function loadBrowsers() {
    return work("tool:browser:list", "Reading the browsers on this PC", invoke("browser_list"))
      .then((list) => {
        targets = flatten(Array.isArray(list) ? list : []);
        targetsLoaded = true;
        drawList();
        drawDetail();
      })
      .catch((error) => console.error("Could not read the installed browsers", error));
  }

  /** Read the address bar of every browser window. Named plainly in the
   *  status bar because it crosses into other processes and a busy browser
   *  can take a moment to answer. */
  function loadTabs() {
    tabsLoaded = false;
    // Only the suggestions are waiting on this, so only the suggestions turn
    // into a skeleton. `drawSuggest` is a no-op while a rule is being edited
    // and the panel is not on screen at all.
    drawSuggest();
    return work("tool:browser:tabs", "Reading what is open in your browsers", invoke("browser_open_tabs"))
      .then((found) => {
        tabs = Array.isArray(found) ? found : [];
        tabsLoaded = true;
        drawSuggest();
      })
      .catch((error) => {
        // Nothing to suggest from is not a failure worth a dialog: the panel
        // says there is nothing and offers to look again.
        tabs = [];
        tabsLoaded = true;
        drawSuggest();
        console.error("Could not read the open browser tabs", error);
      });
  }

  function loadRules() {
    return work("tool:browser:rules", "Reading link rules", invoke("browser_rules_load"))
      .then((value) => {
        rules = value && Array.isArray(value.rules) ? value : { rules: [], unmatched: null, shortlist: [], askKey: "shift" };
        if (!Array.isArray(rules.shortlist)) rules.shortlist = [];
        rulesLoaded = true;
        drawList();
        drawDetail();
      })
      .catch((error) => console.error("Could not read the link rules", error));
  }

  let testTimer = 0;
  function queueTest() {
    clearTimeout(testTimer);
    testResult = null;
    const node = host?.querySelector("[data-br-test-result]");
    if (node) node.innerHTML = testLine();
    testTimer = setTimeout(runTest, 200);
  }

  function runTest() {
    const url = testUrl.trim();
    if (!url) {
      testResult = null;
      const node = host?.querySelector("[data-br-test-result]");
      if (node) node.innerHTML = testLine();
      return;
    }
    return invoke("browser_rules_test", { url })
      .then((match) => {
        testResult = match || false;
        const node = host?.querySelector("[data-br-test-result]");
        if (node) node.innerHTML = testLine();
      })
      .catch(() => {});
  }

  window.wintBrowserTool = {
    mount(node) {
      host = node;
      assoc = null;
      targetsLoaded = false;
      rulesLoaded = false;
      draft = null;
      selected = "";
      tabs = [];
      tabsLoaded = false;
      dismissed = new Set();
      draw();
      // Four independent reads, all off-thread in Rust: each fills its own
      // region the moment it answers rather than waiting for the others.
      loadAssoc();
      loadBrowsers();
      loadRules();
      loadTabs();
    },
  };
})();
