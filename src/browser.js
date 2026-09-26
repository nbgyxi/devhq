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

  /** Demo mode (`demo-mode.js`): with it on, the sites a rule names and the
   *  browser profiles it sends them to are drawn as stand-ins, because on a
   *  real PC a profile is usually named after its owner and the rules are a
   *  list of the places they go. Nothing this page saves or routes changes:
   *  the aliases are applied where a string is drawn and nowhere else, and the
   *  rule being edited shows its real pattern — what is typed there is what is
   *  written to the rule. */
  const demoHost = (value) => window.wintDemo?.host(value) ?? value;
  const demoProfile = (value) => window.wintDemo?.profile(value) ?? value;

  let host = null;
  /** What Windows thinks WinT is. Null until the first answer comes back, so
   *  the card can draw a skeleton rather than a wrong reading. */
  let assoc = null;
  /** Every browser × profile pair on this PC, flattened the same way the
   *  chooser flattens them: one row, one answerable target. */
  let targets = [];
  let targetsLoaded = false;
  /** Everything installed, hidden or not. Only the settings list uses this:
   *  it is where a hidden browser is ticked back on, so it is the one place
   *  that has to be able to see one. */
  let allTargets = [];
  let allTargetsLoaded = false;
  let rules = { rules: [], unmatched: null, unmatchedTargets: [], hidden: [], askKey: "shift" };
  let rulesLoaded = false;
  /** The rule open in the detail panel, by id, or "" for the defaults pane
   *  and "new" for the rule being written. */
  let selected = "defaults";
  /** The rule being edited, as a working copy. Saved on Save, dropped on
   *  anything else — a list that rewrote itself under a half-typed pattern
   *  would be worse than no editing at all. */
  let draft = null;
  let testUrl = "";
  let testResult = null;
  /** What the browsers say they are for: the tab in front in each window, the
   *  tabs each Chromium profile has open, and the sites each profile has
   *  actually been used for. The source for the suggestions, because this is
   *  already the answer to which sites belong in which profile. */
  let tabs = [];
  let tabsLoaded = false;
  /** Suggestions the user has ticked off, by host, so a redraw does not undo
   *  a decision they have already made about one. */
  let dismissed = new Set();
  /** Which page is on screen: the rules, or the settings that decide what the
   *  rules can even name. Two pages rather than one, because what browsers
   *  exist as far as WinT is concerned is not a property of any one rule. */
  let view = "rules";

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

  // The separator is a pipe, which Windows allows in neither a path nor a
  // folder name, so it cannot appear in either half. It used to be a NUL, and
  // these keys are written into HTML attributes - where the parser replaces a
  // NUL with U+FFFD, so the key read back out never matched the one written
  // and every per-profile tick and target pick silently did nothing.
  const targetKey = (exe, profile) => `${(exe || "").toLowerCase()}|${profile || ""}`;
  const isTarget = (a, b) => targetKey(a.exe, a.profile) === targetKey(b.exe, b.profile);
  const sameExe = (a, b) => (a.exe || "").toLowerCase() === (b.exe || "").toLowerCase();

  /** Everywhere a rule may send a link.
   *
   *  A rule saved by a build that only knew one browser has no `targets` and
   *  one set of loose fields instead; reading it as a shortlist of one is
   *  what keeps the rest of this file from caring which shape it is in. */
  const ruleTargets = (rule) => {
    if (rule.targets?.length) return rule.targets;
    return rule.exe ? [{ exe: rule.exe, browser: rule.browser, profile: rule.profile, profileName: rule.profileName }] : [];
  };

  /** The browser profile WinT may actually use for something it has seen.
   *
   *  Only ever a profile ticked in Settings, so a suggestion can never point
   *  at one the user has said they never want links opened in.
   *
   *  The exact match is the normal case. The looser one covers a real gap:
   *  either side can legitimately have no profile - a browser whose profiles
   *  could not be enumerated is listed once with none, and a window whose
   *  AppUserModelID could not be read gives a tab with none. Refusing those
   *  meant every tab of such a browser was dropped and the panel found
   *  nothing at all. It is allowed only where it cannot be ambiguous:
   *  exactly one profile of that browser is ticked.
   */
  function targetFor(seen) {
    const exact = targets.find((known) => isTarget(known, seen));
    if (exact) return exact;
    const ofBrowser = targets.filter((known) => sameExe(known, seen));
    if (ofBrowser.length === 1 && (!ofBrowser[0].profile || !seen.profile)) return ofBrowser[0];
    return null;
  }

  const installed = (target) => Boolean(targetFor(target));

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
    const profile = demoProfile(target.profileName || target.profile);
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
      <nav class="br-tabs" data-br-tabs>${viewTabs()}</nav>
      <div class="br-alert" data-br-alert>${assocBanner()}</div>
      <div class="br-viewport" data-br-body>${viewBody()}</div>`;
    drawnView = view;
    bind();
  }

  /** Three places, named. Rules is the list of decisions already made.
   *  Suggestions is the ones worth making, read off what the browsers are
   *  doing, with the box for trying a link against the lot. Settings is
   *  everything true of the whole machine rather than of one site — whether
   *  Windows hands links to WinT at all, and which browsers it may use. */
  function viewTabs() {
    return [
      ["rules", "rule", "Rules", rulesLoaded ? String(rules.rules.length) : ""],
      ["suggest", "lightbulb", "Suggestions", tabsLoaded ? (suggestions().length ? String(suggestions().length) : "") : "…"],
      ["settings", "tune", "Settings", hiddenCount() ? `${hiddenCount()} hidden` : ""],
    ]
      .map(
        ([id, glyph, label, note]) =>
          `<button type="button" class="br-tab${view === id ? " on" : ""}" data-br-view="${id}">${icon(glyph)}${esc(label)}${note ? `<em>${esc(note)}</em>` : ""}</button>`,
      )
      .join("");
  }

  function viewBody() {
    if (view === "settings") return settingsPage();
    if (view === "suggest") return suggestPage();
    return `
      <section class="br-body">
        <aside class="br-list" data-br-list>${listPane()}</aside>
        <section class="br-detail" data-br-detail>${detailPane()}</section>
      </section>`;
  }

  /** Which of the two pages is currently drawn, so a redraw of the same
   *  page can be told apart from a move to the other one. */
  let drawnView = "";

  /** Swap which of the two is on screen. The tabs are redrawn with it because
   *  each carries a count that the other page can change. */
  function drawBody() {
    const node = host?.querySelector("[data-br-body]");
    // Redrawing the page the user is already on must not move them: the
    // scroll position is the place they were reading. Arriving on the
    // other page starts at the top, as arriving anywhere does. Settings
    // is one scrolling column, which is the page this can happen to.
    const scrolled = drawnView === view ? node?.querySelector(".br-settings")?.scrollTop || 0 : 0;
    if (node) node.innerHTML = viewBody();
    drawnView = view;
    if (scrolled) {
      const page = node?.querySelector(".br-settings");
      if (page) page.scrollTop = scrolled;
    }
    const nav = host?.querySelector("[data-br-tabs]");
    if (nav) nav.innerHTML = viewTabs();
  }

  function drawAlert() {
    const node = host?.querySelector("[data-br-alert]");
    if (node) node.innerHTML = assocBanner();
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
    // The count on the tab is the one part of this that is visible from
    // the other pages, so it is written whether or not this page is up.
    const nav = host?.querySelector("[data-br-tabs]");
    if (nav) nav.innerHTML = viewTabs();
    const node = host?.querySelector("[data-br-suggest]");
    if (!node) return;
    const page = host.querySelector("[data-br-suggest-page]");
    const pageScroll = page?.scrollTop || 0;
    const listScroll = node.querySelector(".br-suggest")?.scrollTop || 0;
    node.outerHTML = suggestPanel();
    if (page) page.scrollTop = pageScroll;
    const list = host.querySelector("[data-br-suggest] .br-suggest");
    if (list) list.scrollTop = listScroll;
  }

  /** One suggestion, in place. Ticking a profile on a row must not move
   *  the forty rows under it. */
  function drawSuggestion(hostname) {
    const row = host?.querySelector(`[data-br-sug-host="${CSS.escape(hostname)}"]`);
    const item = suggestions().find((entry) => entry.host === hostname);
    if (!row || !item) return drawSuggest();
    row.outerHTML = suggestionRow(item);
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

  /** What Windows says has changed. The banner above both pages carries it,
   *  and so does the Settings page when that is what is on screen. */
  /** Redraw whichever page is actually on screen. The loads do not know or
   *  care which one that is, so they come through here rather than naming
   *  regions that may not exist. */
  function redraw() {
    if (view === "settings") return drawSettings();
    if (view === "suggest") return drawSuggest();
    drawList();
    drawDetail();
  }

  /** The parts of Settings a tick can change, and nothing else.
   *
   *  Rebuilding the whole page put it back at the top, which on a PC with
   *  twenty profiles means the row just ticked scrolls out of sight — the
   *  one thing the user was looking at. The checklist is the same height
   *  before and after, so replacing only it leaves the scroll alone. */
  function drawSettings() {
    const picks = host?.querySelector("[data-br-picks]");
    if (picks) picks.innerHTML = visibleChecklist();
    const count = host?.querySelector("[data-br-inuse]");
    if (count) count.textContent = inUseCount();
    const nav = host?.querySelector("[data-br-tabs]");
    if (nav) nav.innerHTML = viewTabs();
  }

  function drawAssoc() {
    drawAlert();
    if (view === "settings") drawBody();
  }

  /** The one line about Windows that belongs above both pages: WinT is not
   *  actually getting the links yet. Nothing when it is — a banner that is
   *  always there stops being read, and the full controls live in Settings. */
  function assocBanner() {
    if (!assoc || !assoc.supported) return "";
    if (assoc.defaultHttp && assoc.defaultHttps) return "";
    const what = assoc.registered
      ? "Windows is not sending links to WinT yet, so none of these rules are being used."
      : "WinT is not registered as a browser yet, so Windows cannot send it links.";
    return `<div class="br-state warn">${icon("warning")}<span><strong>${what}</strong></span>
      <div class="br-state-actions"><button class="btn small" data-br-view="settings">${icon("tune")}Fix in Settings</button></div>
    </div>`;
  }

  /** Whether Windows hands links to WinT at all — the "always open with WinT"
   *  question, and the buttons that go as far towards it as Windows allows. */
  function assocSection() {
    if (!assoc) return `<div class="br-skeleton"><span></span><span></span></div>`;
    if (!assoc.supported) return `<div class="win-empty">Routing links is a Windows feature.</div>`;
    const isDefault = assoc.defaultHttp && assoc.defaultHttps;
    const owner = assoc.httpsOwner || assoc.httpOwner;
    const state = isDefault
      ? ["check_circle", "ok", "Windows opens every link with WinT", `Each one goes to the browser its rule names; anything with no rule ${catchAll().length === 1 ? `opens in ${esc(oneName(catchAll()[0]))}` : "asks first"}.`]
      : assoc.registered
        ? ["pending", "warn", "WinT is offered but not chosen", owner ? `Windows still opens links with ${esc(owner)}. Only you can change that, on Windows' own Default apps page.` : "Windows has not been told to use WinT yet. Only you can change that, on Windows' own Default apps page."]
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
      </div>${other}
      <p class="br-hint">${icon("info")}Windows signs the choice of default browser itself, so no app can set it — not even one you have just installed. The button opens the page where you make the choice, with WinT named on it.</p>`;
  }

  /** Settings: everything true of this PC rather than of one site.
   *
   *  A page of its own, not a panel inside a rule. Which browsers exist as far
   *  as WinT is concerned is the first thing anybody needs to set and the
   *  thing that changes every other list in the tool, so it is not something
   *  to go looking for behind a row.
   */
  function settingsPage() {
    const key = rules.askKey || "shift";
    return `<div class="br-settings">
      <section class="br-card">
        <header>${icon("link")}<strong>Always open links with WinT</strong></header>
        ${assocSection()}
      </section>

      <section class="br-card">
        <header>${icon("public")}<strong>Browsers and profiles</strong>
          <small data-br-inuse>${inUseCount()}</small>
        </header>
        <p class="br-hint">${icon("info")}Untick anything you would never open a link in. A browser or profile that is unticked is offered nowhere — not in the chooser, not when writing a rule, not in the suggestions. Nothing is uninstalled, and a rule that already names one still opens it.</p>
        <div data-br-picks>${visibleChecklist()}</div>
      </section>

      <section class="br-card">
        <header>${icon("keyboard")}<strong>Override</strong></header>
        <label>Hold this while clicking a link to be asked anyway
          <select data-br-askkey>
            ${[["shift", "Shift"], ["ctrl", "Ctrl"], ["alt", "Alt"], ["none", "Nothing — never override"]]
              .map(([value, label]) => `<option value="${value}"${key === value ? " selected" : ""}>${esc(label)}</option>`)
              .join("")}
          </select>
        </label>
        <p class="br-hint">${icon("info")}${key === "none"
          ? "Links always go where the rules send them. The only way to send one somewhere else is to change a rule first."
          : `Holding ${esc({ shift: "Shift", ctrl: "Ctrl", alt: "Alt" }[key])} beats every rule and the catch-all for that one link — and the chooser then offers to settle the rule it overrode. Keep holding it until the chooser appears: WinT reads the key when the link reaches it, a moment after the click rather than during it.`}</p>
      </section>
    </div>`;
  }

  /** Profiles ticked off a suggestion, by host. A suggestion reads four
   *  profiles off the machine and three of them are right: this is where
   *  that correction lives, before the rule exists and after. */
  const tweaks = new Map();
  /** Rules made from this page, by host. The row stays where it is once it
   *  has been added — the rule is new and is exactly the thing most likely
   *  to want a profile taken off it, so the place it was made is the place
   *  to do that. */
  const added = new Map();

  /** The profiles a suggestion would use, or does use now that it is a
   *  rule: what was read off the machine, minus whatever was unticked. */
  function chosenFor(item) {
    const trimmed = tweaks.get(item.host);
    if (!trimmed) return item.targets;
    return item.targets.filter((target) => trimmed.some((pick) => isTarget(pick, target)));
  }

  /** Sites worth a rule, and one box for checking any link against the
   *  rules as they stand.
   *
   *  A page rather than a panel inside the catch-all rule, which is where
   *  both used to live. Neither is *about* that rule: one is a list of
   *  rules that do not exist yet, and the other answers "where would this
   *  go?", which is a question about all of them. */
  function suggestPage() {
    return `<div class="br-page" data-br-suggest-page>
      <section class="br-card">
        ${suggestPanel()}
      </section>
      <section class="br-card">
        <header>${icon("travel_explore")}<strong>Try a link</strong></header>
        <label class="br-try"><input type="text" data-br-test placeholder="https://example.com/…" value="${esc(testUrl)}" spellcheck="false" autocomplete="off" /></label>
        <div class="br-test-result" data-br-test-result>${testLine()}</div>
      </section>
    </div>`;
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
      <div class="br-rows">${catchAllRow()}${rows}</div>`;
  }

  /** The catch-all, sitting at the top of the list as a rule of its own.
   *
   *  It *is* a rule — the one every link falls through to — so it belongs
   *  where the rules are and not behind an empty selection. Being able to
   *  select it is also what makes the settings reachable again after a rule
   *  has been opened, rather than only by cancelling out of one.
   *
   *  Pinned rather than sorted in: it is the last rule consulted, so a list
   *  that moved it around by use count would be hiding the one row that
   *  always applies. */
  function catchAllRow() {
    const where = catchAllWhere();
    const settings = [
      hiddenCount() ? `${hiddenCount()} browser hidden` : "",
      (rules.askKey || "shift") !== "none" ? `${{ shift: "Shift", ctrl: "Ctrl", alt: "Alt" }[rules.askKey || "shift"]} to override` : "",
    ].filter(Boolean);
    return `<button class="br-row br-row-catchall${selected === "defaults" ? " on" : ""}" data-br-rule="defaults">
      ${icon(catchAll().length === 1 ? "arrow_forward" : catchAll().length ? "alt_route" : "help")}
      <span><strong>Everything else</strong><small>${esc(where)}${settings.length ? ` · ${esc(settings.join(" · "))}` : ""}</small></span>
      <em>${icon("tune")}</em>
    </button>`;
  }

  function testLine() {
    if (!testUrl.trim()) return `<small>Type an address to see which rule would take it.</small>`;
    if (testResult === null) return `<small>Checking…</small>`;
    if (!testResult) return `<small>${icon("help")}No rule matches — this one would ask.</small>`;
    return `<small class="match">${icon("check_circle")}${esc(demoHost(testResult.pattern))} → ${esc(targetName(testResult))}</small>`;
  }

  function ruleRow(rule) {
    const list = ruleTargets(rule);
    // A rule naming a browser that has since been uninstalled still routes —
    // to the rest of its shortlist — but it is worth saying so.
    const missing = targetsLoaded ? list.filter((target) => !installed(target)).length : 0;
    const glyph = !rule.enabled ? "radio_button_unchecked" : missing ? "warning" : list.length > 1 ? "alt_route" : "check_circle";
    return `<button class="br-row${selected === rule.id ? " on" : ""}${rule.enabled ? "" : " off"}" data-br-rule="${esc(rule.id)}">
      ${icon(glyph)}
      <span><strong>${esc(scopeLabel(rule.scope, demoHost(rule.pattern)))}</strong><small>${esc(targetName(rule))}${missing ? ` · ${missing} not installed` : ""}</small></span>
      <em>${rule.uses ? `${rule.uses}×` : ""}</em>
    </button>`;
  }

  /** The browsers a rule may use, as a checklist.
   *
   *  A checklist and not a menu, because the answer is genuinely allowed to
   *  be more than one: some sites belong in whichever browser you happen to
   *  be thinking in, and the useful rule for those is the short list, not a
   *  guess between them. */
  function targetChecklist(chosen, attr = "data-br-target") {
    if (!targetsLoaded) return `<div class="br-skeleton"><span></span><span></span></div>`;
    if (!targets.length) return `<div class="win-empty">No other browser is installed on this PC.</div>`;
    const rows = targets
      .map((target) => {
        const key = targetKey(target.exe, target.profile);
        const on = chosen.some((pick) => isTarget(pick, target));
        const label = target.profileName ? `${target.browser} · ${demoProfile(target.profileName)}` : target.browser;
        return `<label class="br-pick${on ? " on" : ""}"><input type="checkbox" ${attr}="${esc(key)}"${on ? " checked" : ""} /><span>${esc(label)}</span></label>`;
      })
      .join("");
    // A rule naming an uninstalled browser keeps it: the browser may come
    // back, and dropping it silently would change where links go.
    const gone = chosen
      .filter((pick) => !installed(pick))
      .map(
        (pick) =>
          `<label class="br-pick gone"><input type="checkbox" ${attr}="${esc(targetKey(pick.exe, pick.profile))}" checked /><span>${esc(oneName(pick))} — not installed</span></label>`,
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
      // Open in a browser the user has said WinT may not use. Suggesting a
      // rule pointing there would be suggesting the one thing they ruled out.
      if (!installed(tab)) continue;
      // Already routed, by whatever rule claims it — unless that rule was
      // made here, in which case the row stays so it can still be trimmed.
      if (!added.has(tab.host) && rules.rules.some((rule) => coversHost(rule, tab.host))) continue;
      const found = seen.get(tab.host);
      if (found) {
        found.open = found.open || Boolean(tab.open);
        found.visits = Math.max(found.visits, tab.visits || 0);
        if (!found.title) found.title = tab.title;
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
        open: Boolean(tab.open),
        visits: tab.visits || 0,
        targets: [{ exe: tab.exe, browser: tab.browser, profile: tab.profile, profileName: tab.profileName }],
      });
    }
    // Open now first, then by how much the profile actually uses the site.
    // A suggestion worth agreeing with without thinking should be at the top.
    return [...seen.values()].sort(
      (a, b) => Number(b.open) - Number(a.open) || b.visits - a.visits || a.host.localeCompare(b.host),
    );
  }

  /** One site, and the profiles it is used in.
   *
   *  The profiles are ticks rather than a sentence, because a suggestion
   *  read off four profiles is a guess at four, and three of them being
   *  right is the normal case. Untick one before adding and the rule is
   *  made without it; untick one after and the rule it became loses it,
   *  saved as the tick lands. */
  function suggestionRow(item) {
    const chosen = chosenFor(item);
    const isAdded = added.has(item.host);
    const picks = item.targets.length > 1
      ? `<div class="br-sug-picks">${item.targets
          .map((target) => {
            const on = chosen.some((pick) => isTarget(pick, target));
            return `<label class="br-sug-pick${on ? " on" : ""}"><input type="checkbox" data-br-sug-pick="${esc(targetKey(target.exe, target.profile))}"${on ? " checked" : ""} /><span>${esc(oneName(target))}</span></label>`;
          })
          .join("")}</div>`
      : "";
    const where = item.targets.length > 1
      ? `${chosen.length} of ${item.targets.length} profiles`
      : targetsSummary(item.targets);
    return `<div class="br-sug${isAdded ? " added" : ""}" data-br-sug-host="${esc(item.host)}">
      <div class="br-sug-top">
        ${icon(isAdded ? "check_circle" : item.targets.length > 1 ? "alt_route" : "public")}
        <span><strong>${esc(demoHost(item.host))}</strong><small>${esc(where)} · ${esc(isAdded ? "added — adjust it here" : why(item))}</small></span>
        ${isAdded
          ? `<button class="btn small" data-br-sug-open="${esc(item.host)}" title="Open this rule">${icon("rule")}</button>`
          : `<button class="btn small" data-br-sug-add="${esc(item.host)}" title="Add this rule"${chosen.length ? "" : " disabled"}>${icon("add")}</button>`}
        <button class="btn small" data-br-sug-skip="${esc(item.host)}" title="${isAdded ? "Remove this rule again" : "Not this one"}">${icon(isAdded ? "undo" : "close")}</button>
      </div>
      ${picks}
    </div>`;
  }

  /** Where a suggestion would send links, in as few words as say it.
   *
   *  Grouped by browser, because a site used in four profiles of the same
   *  browser was repeating that browser's name four times and pushing the
   *  profiles - the part that differs - off the end of the line. */
  function targetsSummary(list) {
    const byBrowser = new Map();
    for (const target of list) {
      if (!byBrowser.has(target.browser)) byBrowser.set(target.browser, []);
      const profile = demoProfile(target.profileName || target.profile);
      if (profile) byBrowser.get(target.browser).push(profile);
    }
    return [...byBrowser.entries()]
      .map(([browser, profiles]) => (profiles.length ? `${browser}: ${profiles.join(", ")}` : browser))
      .join(" · ");
  }

  /** Why a site is being suggested, in the fewest words that are true.
   *
   *  "Open now" is the strongest reason and the easiest to check — the tab is
   *  right there. A visit count is weaker but often more useful: a site used
   *  forty times in one profile belongs to that profile whether or not it
   *  happens to be open this minute. */
  function why(item) {
    if (item.open && item.visits) return `open now · ${item.visits} visits`;
    if (item.open) return "open now";
    if (item.visits) return `${item.visits} visits`;
    return "seen in this profile";
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
      <header>${icon(isNew ? "add_circle" : "rule")}<strong>${isNew ? "New rule" : "Rule"}</strong>
        <button class="tool-close" data-br-cancel title="Close">${icon("close")}</button>
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
        <p class="br-hint" data-br-hint>${icon("info")}${esc(hintFor(rule))}</p>
        <div class="br-form-actions">
          <button class="btn danger" data-br-delete>${icon("delete")}Delete</button>
          <button class="btn" data-br-cancel>${icon("check")}Done</button>
        </div>
        <p class="br-hint br-saved">${icon("cloud_done")}Saved as you type. There is nothing to press.</p>
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

  /** The "Everything else" rule's own pane. Routing only: where a link with
   *  no rule goes, and the sites open right now that could have one. What
   *  browsers exist and whether Windows uses WinT at all are settings, not
   *  this rule, and live on the Settings page. */
  function defaultsPane() {
    return `
      <header>${icon("help")}<strong>Everything else</strong><small>links no rule above matches</small></header>
      <div class="br-form">
        <div class="br-field"><span>Open it in</span>
          ${targetChecklist(catchAll(), "data-br-catchall")}
        </div>
        <p class="br-hint" data-br-hint>${icon("info")}${esc(catchAllHint())}</p>
      </div>`;
  }

  /** The catch-all in as few words as say it, for its row in the list. */
  function catchAllWhere() {
    const list = catchAll();
    if (!list.length) return "Asks which browser to use";
    if (list.length === 1) return `Opens in ${oneName(list[0])}`;
    return `Asks between ${list.length} browsers`;
  }

  /** And the sentence under its checklist, which is the same sentence a
   *  rule gets - ticking none, one or several means the same thing here as
   *  it does there. */
  function catchAllHint() {
    const list = catchAll();
    if (!list.length) {
      return "Nothing opens until you answer. Tick one browser and every link nobody has thought about just opens there; tick a few and the chooser offers those and nothing else.";
    }
    if (list.length === 1) {
      return `Anything with no rule goes straight to ${oneName(list[0])} without asking. The status bar still names where each one went, so a site that should have had a rule of its own is easy to notice.`;
    }
    return `Anything with no rule puts the chooser up with those ${list.length} on it and nothing else.`;
  }

  /** The line in the card header: how much of this PC is in play. */
  function inUseCount() {
    return allTargetsLoaded ? `${targets.length} of ${allTargets.length} in use` : "…";
  }

  /** Where a link no rule matches goes. Empty means it asks. */
  const catchAll = () => (Array.isArray(rules.unmatchedTargets) ? rules.unmatchedTargets : []);

  /** How many browser profiles the user has taken out of circulation. */
  function hiddenCount() {
    return (rules.hidden || []).length;
  }

  /** Every browser and profile this PC has, ticked when WinT may use it.
   *
   *  Drawn from the unfiltered list on purpose: this is the one place a
   *  hidden browser has to still appear, because it is where it gets ticked
   *  back on. Everywhere else works from the filtered list and never sees it. */
  function visibleChecklist() {
    if (!allTargetsLoaded) return `<div class="br-skeleton"><span></span><span></span><span></span></div>`;
    if (!allTargets.length) return `<div class="win-empty">No other browser is installed on this PC.</div>`;
    const hidden = rules.hidden || [];
    const isHidden = (target) => hidden.some((gone) => isTarget(gone, target) || (gone.exe === target.exe && !gone.profile && !target.profile));
    // Grouped by browser, so "I never want Firefox" is one heading with its
    // profiles under it rather than four rows to find among twelve.
    const groups = new Map();
    for (const target of allTargets) {
      if (!groups.has(target.exe)) groups.set(target.exe, { browser: target.browser, exe: target.exe, rows: [] });
      groups.get(target.exe).rows.push(target);
    }
    return `<div class="br-picks">${[...groups.values()]
      .map((group) => {
        const all = group.rows.every((target) => !isHidden(target));
        const none = group.rows.every(isHidden);
        const named = group.rows.length > 1 || group.rows[0].profileName;
        return `<label class="br-pick br-pick-head${all ? " on" : ""}">
            <input type="checkbox" data-br-browser="${esc(group.exe)}"${all ? " checked" : ""}${!all && !none ? " data-mixed" : ""} />
            <span>${esc(group.browser)}</span>
          </label>
          ${named
            ? group.rows
                .map((target) => {
                  const tkey = targetKey(target.exe, target.profile);
                  const on = !isHidden(target);
                  return `<label class="br-pick br-pick-child${on ? " on" : ""}"><input type="checkbox" data-br-visible="${esc(tkey)}"${on ? " checked" : ""} /><span>${esc(demoProfile(target.profileName || target.profile) || "Default profile")}</span></label>`;
                })
                .join("")
            : ""}`;
      })
      .join("")}</div>`;
  }

  /** What is open right now, offered as rules.
   *
   *  The point is the first five minutes: nobody with no rules yet has the
   *  appetite to write eight of them from memory. The browsers are already
   *  open and already sorted into profiles, so the list of sites-to-profiles
   *  writes itself and all that is left to do is agree with it. */
  /** How many sites were seen only in profiles that are not ticked in
   *  Settings. They are deliberately not suggested — a rule may only point
   *  at a profile WinT is allowed to use — but a panel that finds nothing
   *  has to say whether that is because there is nothing or because of a
   *  setting. */
  function skippedByProfile() {
    const hosts = new Set();
    for (const tab of tabs) {
      if (dismissed.has(tab.host) || targetFor(tab)) continue;
      if (rules.rules.some((rule) => coversHost(rule, tab.host))) continue;
      hosts.add(tab.host);
    }
    return hosts.size;
  }

  function suggestPanel() {
    if (!tabsLoaded) {
      return `<div class="br-field" data-br-suggest><span>Sites worth a rule</span><div class="br-skeleton"><span></span><span></span></div></div>`;
    }
    const found = suggestions();
    if (!found.length) {
      const skipped = skippedByProfile();
      return `<div class="br-field" data-br-suggest><span>Sites worth a rule</span>
        <p class="br-hint">${icon(skipped ? "tune" : "check_circle")}${skipped
          ? `${skipped} ${skipped === 1 ? "site is" : "sites are"} only used in browser profiles that are not ticked in Settings, so there is nothing here to suggest a rule for. Tick the profiles you do open links in and they will appear.`
          : tabs.length
            ? "Every site WinT can see already has a rule."
            : "Nothing to go on yet. WinT looks at what each browser has open and at what each profile has actually been used for, and offers a rule per site."}</p>
        <div class="br-form-actions">
          ${skipped ? `<button class="btn primary" data-br-view="settings">${icon("tune")}Choose profiles</button>` : ""}
          <button class="btn" data-br-rescan>${icon("refresh")}Look again</button>
        </div>
      </div>`;
    }
    return `<div class="br-field" data-br-suggest><span>Sites worth a rule</span>
      <div class="br-suggest">
        ${found.map(suggestionRow).join("")}
      </div>
      <div class="br-form-actions">
        ${found.filter((item) => !added.has(item.host)).length ? `<button class="btn primary" data-br-sug-all>${icon("playlist_add")}Add all ${found.filter((item) => !added.has(item.host)).length}</button>` : ""}
        <button class="btn" data-br-rescan>${icon("refresh")}Look again</button>
      </div>
      ${skippedByProfile() ? `<p class="br-hint">${icon("tune")}${skippedByProfile()} more ${skippedByProfile() === 1 ? "site is" : "sites are"} only used in profiles that are not ticked in Settings, so they are not offered here.</p>` : ""}
      <p class="br-hint">${icon("info")}One rule per site, sending it to the profile that site belongs to. Read from three places: the address bar of each window, the tabs each Chromium profile has open, and what each profile has actually visited over the last two months. A site used in two profiles becomes a rule that asks between those two.</p>
    </div>`;
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
    const tab = target.closest("[data-br-view]");
    if (tab) {
      view = tab.dataset.brView;
      drawBody();
      return;
    }
    if (target.closest("[data-br-default-choose]")) return chooseDefault();
    if (target.closest("[data-br-unregister]")) return unregister();
    if (target.closest("[data-br-refresh]")) return loadAssoc();
    if (target.closest("[data-br-new]")) return startNew();
    if (target.closest("[data-br-cancel]")) {
      // Nothing to discard - it is all saved already - but a write may
      // still be waiting out its beat, and the pane is going away.
      commitDraft();
      flushSave();
      draft = null;
      selected = "defaults";
      drawList();
      drawDetail();
      return;
    }
    if (target.closest("[data-br-delete]")) return deleteDraft();
    if (target.closest("[data-br-rescan]")) return loadTabs();
    const add = target.closest("[data-br-sug-add]");
    if (add) return acceptSuggestion(add.dataset.brSugAdd);
    const skip = target.closest("[data-br-sug-skip]");
    if (skip) {
      const hostname = skip.dataset.brSugSkip;
      // On a rule made here the same button is an undo: the rule goes and
      // the row is a suggestion again, rather than the site being written
      // off as one WinT should stop mentioning.
      if (added.has(hostname)) return undoSuggestion(hostname);
      dismissed.add(hostname);
      dropSuggestion(hostname);
      return;
    }
    // The rule this row became, opened where rules are edited.
    const open = target.closest("[data-br-sug-open]");
    if (open) {
      const id = added.get(open.dataset.brSugOpen);
      if (!id) return;
      view = "rules";
      drawBody();
      openRule(id);
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
      const hint = host.querySelector("[data-br-hint]");
      if (hint) hint.innerHTML = `${icon("info")}${esc(hintFor(draft))}`;
      commitDraft();
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
    if (node.matches("[data-br-sug-pick]")) {
      const row = node.closest("[data-br-sug-host]");
      if (!row) return;
      tweakSuggestion(row.dataset.brSugHost, node.dataset.brSugPick, node.checked);
      return;
    }
    if (node.matches("[data-br-scope]") && draft) {
      draft.scope = node.value;
      const hint = host.querySelector("[data-br-hint]");
      if (hint) hint.innerHTML = `${icon("info")}${esc(hintFor(draft))}`;
      commitDraft();
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
      const hint = host.querySelector("[data-br-hint]");
      if (hint) hint.innerHTML = `${icon("info")}${esc(hintFor(draft))}`;
      commitDraft();
      return;
    }
    // Untick a profile: WinT stops offering it anywhere. Ticking it back on
    // takes it off the hidden list again — nothing is ever deleted, because
    // the browser is still installed and this is only about what is offered.
    if (node.matches("[data-br-visible]")) {
      const target = allTargets.find((t) => targetKey(t.exe, t.profile) === node.dataset.brVisible);
      if (!target) return;
      // The row follows the tick now rather than when the save comes back,
      // so the click lands in the frame it was made in.
      node.closest(".br-pick")?.classList.toggle("on", node.checked);
      setVisible([target], node.checked);
      return;
    }
    // The heading: the whole browser, every profile of it at once. This is
    // the "I never want Firefox" button.
    if (node.matches("[data-br-browser]")) {
      const exe = node.dataset.brBrowser;
      node.closest(".br-pick")?.classList.toggle("on", node.checked);
      setVisible(allTargets.filter((t) => t.exe === exe), node.checked);
      return;
    }
    if (node.matches("[data-br-enabled]") && draft) {
      draft.enabled = node.checked;
      commitDraft();
      return;
    }
    if (node.matches("[data-br-askkey]")) {
      rules.askKey = node.value;
      save();
      // The sentence under the control says what the key now does, so the
      // card it lives on is redrawn. It lives on the Settings page, which
      // is the page this can only have been clicked on.
      drawBody();
      return;
    }
    if (node.matches("[data-br-catchall]")) {
      const key = node.dataset.brCatchall;
      const target = targets.find((t) => targetKey(t.exe, t.profile) === key)
        || catchAll().find((t) => targetKey(t.exe, t.profile) === key);
      if (!target) return;
      rules.unmatchedTargets = node.checked
        ? [...catchAll().filter((pick) => !isTarget(pick, target)), { exe: target.exe, browser: target.browser, profile: target.profile, profileName: target.profileName }]
        : catchAll().filter((pick) => !isTarget(pick, target));
      node.closest(".br-pick")?.classList.toggle("on", node.checked);
      const hint = host.querySelector("[data-br-hint]");
      if (hint) hint.innerHTML = `${icon("info")}${esc(catchAllHint())}`;
      // Its line in the list says where links go, so that much is redrawn.
      // The pane is not: the checkbox just clicked is in it.
      drawList();
      save();
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
    commitDraft();
    flushSave();
    // The catch-all is a row in the same list but not a rule in the saved
    // list, so it has no draft and nothing to edit — selecting it is what
    // puts the settings back in the pane.
    if (id === "defaults") {
      draft = null;
      selected = "defaults";
      drawList();
      drawDetail();
      return;
    }
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

  /** Put what is being edited into the saved rules, and save them.
   *
   *  There is no Save button: a rule is a sentence about where links go,
   *  and a sentence half-written into a form that is then closed is a
   *  setting the user believes they made. So every keystroke and every tick
   *  lands in the real list, and the writing to disk is debounced behind it.
   *
   *  A new rule with nothing to match yet is the one thing not committed:
   *  it would be a rule matching everything, which is what the catch-all
   *  already is. It joins the list the moment there is a pattern, and its
   *  draft turns into an edit of that rule from then on. */
  function commitDraft() {
    if (!draft) return;
    const pattern = draft.pattern.trim().toLowerCase();
    if (!pattern) return;
    // The loose single-browser fields are cleared on the way out: everything
    // that reads a rule reads `targets`, and leaving both would let them
    // disagree about where a link goes.
    const rule = { ...draft, pattern, exe: "", browser: "", profile: null, profileName: null };
    if (rule.id === "new") {
      rule.id = `${Date.now()}-${rules.rules.length}`;
      draft.id = rule.id;
      selected = rule.id;
      rules.rules.push(rule);
    } else {
      const index = rules.rules.findIndex((entry) => entry.id === rule.id);
      if (index >= 0) rules.rules[index] = rule;
      else rules.rules.push(rule);
    }
    drawList();
    saveSoon();
  }

  /** Writing to disk trails the typing by a beat. The rules in memory are
   *  already right; this only decides how often they reach the file. */
  let saveTimer = 0;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      save();
    }, 400);
  }

  /** Write now rather than in a moment, for the moments there may not be
   *  another one - closing a rule, or opening a different one. */
  function flushSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    save();
  }

  function deleteDraft() {
    if (!draft) return;
    // A new rule with nothing typed was never in the list; there is
    // nothing to remove and nothing to write.
    const existed = draft.id !== "new";
    rules.rules = rules.rules.filter((entry) => entry.id !== draft.id);
    draft = null;
    selected = "defaults";
    drawList();
    drawDetail();
    if (existed) save();
  }

  /** Turn one suggestion into a real rule.
   *
   *  A domain rule, because `x.com` open in a profile almost always means
   *  `*.x.com` belongs there too, and the scope can be narrowed afterwards in
   *  two clicks. The rule is not opened for editing: the whole point of a
   *  suggestion is that agreeing with it is one press. */
  function ruleFromSuggestion(item, chosen = item.targets) {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pattern: item.host,
      scope: "domain",
      targets: chosen.map((target) => ({ ...target })),
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
    if (!item || added.has(hostname)) return;
    const rule = ruleFromSuggestion(item, chosenFor(item));
    added.set(hostname, rule.id);
    rules.rules.push(rule);
    drawList();
    // The row stays, now saying it has been added, so the profiles on it
    // are still there to take off. Only that row is redrawn: the rest of
    // the page, and where the user had scrolled to on it, is unchanged.
    drawSuggestion(hostname);
    save();
  }

  /** Take a rule made here back off again. The row goes back to being a
   *  suggestion — the site is still worth a rule, this one was just not it. */
  function undoSuggestion(hostname) {
    const id = added.get(hostname);
    if (!id) return;
    added.delete(hostname);
    rules.rules = rules.rules.filter((rule) => rule.id !== id);
    drawList();
    drawSuggestion(hostname);
    save();
  }

  /** Untick a profile on a suggestion. Before it is a rule that changes
   *  what would be made; after, it changes the rule itself, there and then. */
  function tweakSuggestion(hostname, key, on) {
    const item = suggestions().find((entry) => entry.host === hostname);
    if (!item) return;
    const chosen = chosenFor(item);
    const target = item.targets.find((pick) => targetKey(pick.exe, pick.profile) === key);
    if (!target) return;
    tweaks.set(
      hostname,
      on
        ? [...chosen.filter((pick) => !isTarget(pick, target)), target]
        : chosen.filter((pick) => !isTarget(pick, target)),
    );
    const id = added.get(hostname);
    if (id) {
      const rule = rules.rules.find((entry) => entry.id === id);
      if (rule) rule.targets = chosenFor(item).map((pick) => ({ ...pick }));
      drawList();
      saveSoon();
    }
    drawSuggestion(hostname);
  }

  function acceptAllSuggestions() {
    const found = suggestions().filter((item) => !added.has(item.host) && chosenFor(item).length);
    if (!found.length) return;
    for (const item of found) {
      const rule = ruleFromSuggestion(item, chosenFor(item));
      added.set(item.host, rule.id);
      rules.rules.push(rule);
    }
    drawList();
    // Every row changes at once, so the panel really does become something
    // else. Only the panel, though - the page keeps its scroll.
    drawSuggest();
    save();
  }

  /** Show or hide a set of browser profiles.
   *
   *  Hiding changes what every other list in the tool contains, so this is
   *  one of the few places that really does redraw the pane — and the browser
   *  list is reloaded, because `browser_list` does the filtering in Rust and
   *  is the only thing the rest of the page trusts about what exists.
   */
  function setVisible(list, visible) {
    if (!list.length) return;
    const hidden = rules.hidden || [];
    const gone = (target) => hidden.some((entry) => isTarget(entry, target));
    rules.hidden = visible
      ? hidden.filter((entry) => !list.some((target) => isTarget(entry, target)))
      : [
          ...hidden,
          ...list
            .filter((target) => !gone(target))
            .map((target) => ({ exe: target.exe, browser: target.browser, profile: target.profile, profileName: target.profileName })),
        ];
    // A browser that is no longer offered cannot stay the place unmatched
    // links go, or the setting would name something the user just said they
    // never want.
    rules.unmatchedTargets = catchAll().filter(
      (pick) => !(rules.hidden || []).some((entry) => isTarget(entry, pick)),
    );
    save().then(loadBrowsers);
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
        drawAssoc();
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
        drawAssoc();
      })
      .catch((error) => console.error("Could not register WinT as a browser", error));
  }

  function unregister() {
    return work("tool:browser:unregister", "Removing WinT from the browser list", invoke("browser_assoc_unregister"))
      .then((value) => {
        assoc = value;
        drawAssoc();
      })
      .catch((error) => console.error("Could not remove the browser handler", error));
  }

  function chooseDefault() {
    // Windows puts its own page up and waits for a person. The status bar says
    // where the app has gone until it comes back.
    return work("tool:browser:default", "Asking Windows about the default browser", invoke("browser_assoc_choose_default"))
      .then((value) => {
        assoc = value;
        drawAssoc();
      })
      .catch((error) => console.error("Could not open Default apps", error));
  }

  /** Two readings of the same machine: what WinT may offer, and everything
   *  that is really there. The first is what the whole tool works from; the
   *  second exists only so the settings list can show a hidden browser in
   *  order to let it be ticked back on. */
  function loadBrowsers() {
    return work(
      "tool:browser:list",
      "Reading the browsers on this PC",
      Promise.all([invoke("browser_list"), invoke("browser_list_all")]),
    )
      .then(([visible, all]) => {
        targets = flatten(Array.isArray(visible) ? visible : []);
        targetsLoaded = true;
        allTargets = flatten(Array.isArray(all) ? all : []);
        allTargetsLoaded = true;
        redraw();
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
        rules = value && Array.isArray(value.rules) ? value : { rules: [], unmatched: null, unmatchedTargets: [], hidden: [], askKey: "shift" };
        // "Everything else" saved by a version that only knew one browser
        // reads as a shortlist of one, so nothing below has two shapes to
        // think about. Rust does the same on its side.
        if (!Array.isArray(rules.unmatchedTargets)) rules.unmatchedTargets = [];
        if (!rules.unmatchedTargets.length && rules.unmatched) rules.unmatchedTargets = [rules.unmatched];
        rules.unmatched = null;
        if (!Array.isArray(rules.hidden)) rules.hidden = [];
        rulesLoaded = true;
        redraw();
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

  /** Dropped when the page is mounted again, so a tool opened and closed a
   *  dozen times does not leave a dozen redraws behind. */
  let stopFollowingDemo = null;

  window.wintBrowserTool = {
    mount(node) {
      host = node;
      assoc = null;
      targetsLoaded = false;
      allTargets = [];
      allTargetsLoaded = false;
      rulesLoaded = false;
      draft = null;
      selected = "defaults";
      tabs = [];
      tabsLoaded = false;
      dismissed = new Set();
      draw();
      // Ticking demo mode in Settings redraws this page wherever it is open.
      stopFollowingDemo?.();
      stopFollowingDemo = window.wintDemo?.onChange(() => { if (host?.isConnected) redraw(); }) || null;
      // Four independent reads, all off-thread in Rust: each fills its own
      // region the moment it answers rather than waiting for the others.
      loadAssoc();
      loadBrowsers();
      loadRules();
      loadTabs();
    },
  };
})();
