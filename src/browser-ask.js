(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;
  const { listen } = window.__TAURI__.event;
  const win = window.__TAURI__.window.getCurrentWindow();

  const targetsHost = document.getElementById("targets");
  const scopesHost = document.getElementById("scopes");
  const hostLine = document.getElementById("ask-host");
  const urlLine = document.getElementById("ask-url");
  const queueChip = document.getElementById("ask-queue");

  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

  /** Links waiting for an answer, oldest first. A second link that arrives
   *  while this window is up joins the queue rather than replacing what the
   *  user is currently reading.
   *
   *  Each entry carries its own shortlist: a link no rule claimed may go to
   *  any browser on this PC, while one whose rule names three browsers may
   *  only go to those three. Which it is was decided when the link arrived,
   *  so this window never works it out a second time. */
  let queue = [];
  /** Every browser × profile pair on this PC, flattened: one row, one answer.
   *  The pool a shortlist is drawn from, and the whole list when there is no
   *  shortlist. */
  let allTargets = [];
  /** What is actually on screen for the link being answered. */
  let targets = [];
  let selected = 0;
  /** What to write down for a link no rule claimed, or "" for just this once.
   *  Remembered between links, because somebody who routes by domain once
   *  usually means to keep doing it. */
  let scope = "domain";
  /** The same answer for a link a shortlist rule already covers, where the
   *  only question is whether to settle that rule. Deliberately not
   *  remembered and deliberately not the same variable: "always" for a
   *  shortlist means something quite different from "always" for a new site,
   *  and one must never silently become the other. */
  let ruleScope = "";
  const activeScope = () => (current()?.ruleId ? ruleScope : scope);
  let browsersLoaded = false;

  const LAST_KEY = "wint.browser-ask.last";
  const SCOPE_KEY = "wint.browser-ask.scope";

  const current = () => queue[0] || null;
  const currentUrl = () => queue[0]?.url || "";

  /** The rows to offer for the link at the front of the queue.
   *
   *  A shortlist is matched back against the browsers actually installed, so
   *  a rule naming a browser that has since been uninstalled quietly offers
   *  the rest rather than a row that cannot open anything. If nothing on the
   *  shortlist survives, the question widens to every browser — better a
   *  bigger question than none. */
  const targetsFor = (link) => {
    if (!link?.choices?.length) return allTargets;
    const shortlist = link.choices
      .map((choice) => allTargets.find((target) => target.exe === choice.exe && (target.profile || "") === (choice.profile || "")))
      .filter(Boolean);
    return shortlist.length ? shortlist : allTargets;
  };

  /** Set when the user has asked to see past a shortlist for this one link.
   *  Per link, never remembered: a shortlist that quietly stopped applying
   *  after it was overridden once would be no shortlist at all. */
  let widened = false;

  const retarget = () => {
    widened = false;
    targets = targetsFor(current());
    selected = 0;
    restoreSelection();
  };

  const hostOf = (url) => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  };

  /** `example.com` out of `mail.example.com` — what a "and its subdomains"
   *  rule should actually be written against. Two labels is the honest guess
   *  a chooser can make without a public-suffix list, and the exact host is
   *  always there as the neighbouring choice. */
  const registrable = (host) => {
    const parts = host.split(".").filter(Boolean);
    if (parts.length <= 2) return host;
    // co.uk, com.au and friends: the last two are both suffix, so keep three.
    const shortSecond = parts[parts.length - 2].length <= 3;
    return parts.slice(shortSecond ? -3 : -2).join(".");
  };

  /** What an "address starts with" rule would actually be written as: the
   *  link without its query, which is what the backend stores. Shortened in
   *  the middle rather than at the end, because the end of a path is the part
   *  that says what the rule is for. */
  const urlPrefix = (url) => {
    const trimmed = String(url || "").split(/[?#]/)[0];
    if (trimmed.length <= 42) return trimmed;
    return `${trimmed.slice(0, 26)}…${trimmed.slice(-14)}`;
  };

  const drawHeader = () => {
    const link = current();
    const url = currentUrl();
    const host = hostOf(url);
    hostLine.textContent = host || "Opening a link";
    // A shortlisted link is not an unknown one: say which rule narrowed it,
    // so the window reads as "your rule left this open" rather than "WinT has
    // never seen this site".
    urlLine.textContent = link?.rulePattern && !widened
      ? `${link.rulePattern} → ${targets.length} browsers · ${url}`
      : url;
    urlLine.title = url || "";
    // Offered only while something is actually being held back, so it is
    // never a button that does nothing.
    const all = document.getElementById("all");
    if (all) all.hidden = widened || targets.length >= allTargets.length;
    if (queue.length > 1) {
      queueChip.hidden = false;
      queueChip.textContent = `1 of ${queue.length}`;
    } else {
      queueChip.hidden = true;
    }
  };

  const drawScopes = () => {
    const link = current();
    const host = hostOf(currentUrl());
    const domain = registrable(host);
    // A link that came through a shortlist has a rule already. The useful
    // answer there is not a fourth way to write a new rule, it is whether to
    // settle the one that exists.
    const choices = link?.ruleId
      ? [
          ["", "Just this once", "The rule keeps offering these browsers"],
          ["only", `Always, for ${link.rulePattern || "this rule"}`, "Narrow this rule to the browser you pick"],
        ]
      // Written as the thing each one matches. "This host" has to be worked
      // out; `x.com only` next to `x.com + *.x.com` can simply be read.
      : [
          ["domain", domain ? `${domain} + *.${domain}` : "This site and below", domain ? `Every link on ${domain} and on any subdomain of it` : ""],
          ["host", host ? `${host} only` : "This host only", host ? `Links on ${host} itself — a subdomain would still ask` : ""],
          ["url", `${urlPrefix(url) || "This address"}…`, "Only links beginning with that address"],
          ["", "Just this once", "Nothing is written down"],
        ];
    const chosen = activeScope();
    scopesHost.innerHTML = choices
      .map(
        ([value, label, hint]) =>
          `<button type="button" role="radio" aria-checked="${value === chosen}" class="${value === chosen ? "on" : ""}" data-scope="${esc(value)}" title="${esc(hint)}">${esc(label)}</button>`,
      )
      .join("");
  };

  const drawTargets = () => {
    if (!browsersLoaded) return;
    if (!targets.length) {
      targetsHost.innerHTML = `<div class="ask-empty">No other browser is installed on this PC, so there is nowhere to send this link.</div>`;
      return;
    }
    selected = Math.min(Math.max(selected, 0), targets.length - 1);
    targetsHost.innerHTML = targets
      .map((target, index) => {
        const art = target.icon
          ? `<img src="${esc(target.icon)}" alt="">`
          : `<span class="ms">public</span>`;
        const profile = target.profileName || target.profile || "";
        return `<button type="button" role="option" aria-selected="${index === selected}" class="ask-target${index === selected ? " on" : ""}" data-index="${index}">${art}<span><strong>${esc(target.browser)}</strong><small>${esc(profile || "Whichever profile it opens with")}</small></span><em>${index < 9 ? index + 1 : ""}</em></button>`;
      })
      .join("");
    targetsHost.querySelector(".ask-target.on")?.scrollIntoView({ block: "nearest" });
  };

  /** Flatten the browsers into one row per answerable choice. A browser with
   *  no profiles is one row; a browser with three profiles is three, because
   *  "Chrome" on its own is not an answer to which profile. */
  const flatten = (browsers) => {
    const rows = [];
    for (const browser of browsers) {
      if (!browser.profiles?.length) {
        rows.push({ exe: browser.exe, browser: browser.name, profile: null, profileName: null, icon: browser.icon });
        continue;
      }
      for (const profile of browser.profiles) {
        rows.push({
          exe: browser.exe,
          browser: browser.name,
          profile: profile.dir,
          profileName: profile.name || profile.dir,
          icon: browser.icon,
        });
      }
    }
    return rows;
  };

  const rememberSelection = () => {
    const target = targets[selected];
    if (!target) return;
    try {
      localStorage.setItem(LAST_KEY, `${target.exe}\u0000${target.profile || ""}`);
    } catch { /* a forgotten last choice costs one keypress */ }
  };

  const restoreSelection = () => {
    let last = "";
    try {
      last = localStorage.getItem(LAST_KEY) || "";
    } catch { /* nothing remembered */ }
    if (!last) return;
    const [exe, profile] = last.split("\u0000");
    const index = targets.findIndex((target) => target.exe === exe && (target.profile || "") === profile);
    if (index >= 0) selected = index;
  };

  const loadBrowsers = async () => {
    const list = await invoke("browser_list").catch(() => []);
    allTargets = flatten(Array.isArray(list) ? list : []);
    browsersLoaded = true;
    retarget();
    drawHeader();
    drawTargets();
    // The icons are a second call on purpose: entering the shell's apartment
    // is the slow part, and the list must not wait for a picture.
    const exes = [...new Set(allTargets.map((target) => target.exe))];
    if (!exes.length) return;
    const icons = await invoke("browser_icons", { exes }).catch(() => []);
    const byExe = new Map(exes.map((exe, index) => [exe, icons[index] || null]));
    // The shortlist holds the same objects as the pool, so setting the icon
    // once is enough for both.
    for (const target of allTargets) target.icon = byExe.get(target.exe) || null;
    drawTargets();
  };

  /** Done with the link at the front of the queue, one way or another. */
  const advance = () => {
    queue.shift();
    if (!queue.length) {
      invoke("browser_ask_hide").catch(() => win.hide().catch(() => {}));
      return;
    }
    // The next link may be shortlisted where this one was not, so what is on
    // offer and what can be remembered are both worked out again.
    ruleScope = "";
    retarget();
    drawHeader();
    drawScopes();
    drawTargets();
  };

  /** Close without opening this link.
   *
   *  A real answer, not a dismissal: nothing is written down, nothing is
   *  opened, and the link is gone rather than queued to be asked about again.
   *  The next link in the queue, if there is one, is still worth asking
   *  about, so the window stays up for it. */
  const cancel = () => {
    if (!queue.length) {
      invoke("browser_ask_hide").catch(() => win.hide().catch(() => {}));
      return;
    }
    advance();
  };

  const choose = async (index = selected) => {
    const target = targets[index];
    const link = current();
    if (!target || !link) return;
    selected = index;
    rememberSelection();
    const remember = activeScope() || null;
    // Taken off the queue first: whatever happens to the browser, this link
    // has been answered, and the window must not ask about it again.
    advance();
    await invoke("browser_open_url", {
      url: link.url,
      target: {
        exe: target.exe,
        browser: target.browser,
        profile: target.profile,
        profileName: target.profileName,
      },
      remember,
      ruleId: link.ruleId || null,
    }).catch((error) => {
      console.error("Could not open that link", error);
    });
  };

  /** Take whatever the backend is holding. Draining rather than reading is
   *  what stops a link being asked about twice, so this is the only way a URL
   *  ever enters the queue - the arrival event is a nudge to come and look,
   *  not the link itself. */
  const take = async () => {
    const wasEmpty = !queue.length;
    const pending = await invoke("browser_pending_urls").catch(() => []);
    if (Array.isArray(pending)) {
      for (const link of pending) {
        if (link?.url && !queue.some((queued) => queued.url === link.url)) queue.push(link);
      }
    }
    if (!queue.length) return;
    if (wasEmpty) retarget();
    drawHeader();
    // A link that arrived behind one already being answered only changes the
    // count in the header. Redrawing the rest would move the row under the
    // user's hand and reset a scope they had just picked.
    if (wasEmpty) {
      drawScopes();
      drawTargets();
    }
  };

  targetsHost.addEventListener("click", (event) => {
    const button = event.target.closest("[data-index]");
    if (button) choose(Number(button.dataset.index));
  });
  scopesHost.addEventListener("click", (event) => {
    const button = event.target.closest("[data-scope]");
    if (!button) return;
    if (current()?.ruleId) {
      ruleScope = button.dataset.scope;
    } else {
      scope = button.dataset.scope;
      try {
        localStorage.setItem(SCOPE_KEY, scope);
      } catch { /* the default is fine */ }
    }
    drawScopes();
  });
  document.getElementById("manage").addEventListener("click", () => {
    invoke("open_tool_window", { id: "browser" }).catch(() => {});
  });
  // Widen a link that a shortlist narrowed. The shortlist is there to keep
  // the usual question short, not to put a browser out of reach.
  document.getElementById("all").addEventListener("click", () => {
    widened = true;
    targets = allTargets;
    selected = 0;
    restoreSelection();
    drawHeader();
    drawTargets();
  });
  document.getElementById("cancel").addEventListener("click", () => cancel());
  document.getElementById("close").addEventListener("click", () => cancel());
  document.getElementById("drag").addEventListener("mousedown", () => {
    win.startDragging().catch(() => {});
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      selected = (selected + 1) % Math.max(targets.length, 1);
      drawTargets();
      return;
    }
    if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
      event.preventDefault();
      selected = (selected - 1 + Math.max(targets.length, 1)) % Math.max(targets.length, 1);
      drawTargets();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose();
      return;
    }
    if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      if (index < targets.length) {
        event.preventDefault();
        choose(index);
      }
    }
  });

  listen("browser-ask:url", () => take());

  try {
    const saved = localStorage.getItem(SCOPE_KEY);
    if (["domain", "host", "url", ""].includes(saved)) scope = saved;
  } catch { /* the default is fine */ }

  drawScopes();
  loadBrowsers();
  take();
})();
