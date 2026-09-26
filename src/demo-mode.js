// Demo mode: one switch that makes any WinT window safe to photograph.
//
// The names on the screen are the problem, not the layout. Project folders,
// browser profiles named after the person who owns them and the sites they
// visit all say more about a machine than a screenshot should — so with this
// on, every one of those is replaced by a made-up but plausible stand-in while
// the app keeps working on the real thing underneath.
//
// Two things make this shared code rather than a constant in one file:
//
//  * Every tool is a webview of its own with its own `localStorage`, so the
//    switch cannot live there. It is kept by the backend (`ui-state`), read
//    once per page and followed live through an event, which is why a tool
//    open in another window changes the moment the box is ticked.
//  * Aliases are memoised per name, so one folder or profile keeps the same
//    stand-in for the whole session and across pages that see the same list.
//
// Only what is drawn changes. Every path, profile directory and hostname the
// app acts on is the real one, so nothing behaves differently with this on.

window.wintDemo = (() => {
  "use strict";
  const KEY = "demo-mode";
  const EVENT = "settings:demo-mode";
  // Looked up on use rather than at load: this file is in the <head> of every
  // page, and a page that is served before the bridge is injected would
  // otherwise capture nothing and never read the switch at all.
  const core = () => window.__TAURI__?.core;
  const events = () => window.__TAURI__?.event;

  let on = false;
  const watchers = new Set();

  const HOSTS = [
    "example.com", "acme-storefront.com", "orbit-api.dev", "northwind.io",
    "harborauth.net", "quartz-ui.org", "lantern-docs.com", "redwood-billing.com",
    "sable-scheduler.app", "atlas-gateway.io", "juniper-mobile.dev", "cobalt-analytics.com",
    "meridian-crm.net", "fernway-blog.com", "solstice-player.tv", "tidepool-sync.io",
    "granite-worker.dev", "willow-notify.app", "cinder-search.com", "beacon-status.io",
    "driftwood-shop.com", "kestrel-router.net", "opaline-editor.app", "foxglove-metrics.io",
  ];
  const PROFILES = [
    "Work", "Personal", "Side project", "Client", "Testing", "Admin",
    "Alex Morgan", "Sam Rivera", "Jordan Lee", "Riley Chen", "Casey Fox", "Quinn Patel",
  ];

  /** Memoised so a real name keeps the same stand-in for the whole session. */
  const pick = (map, pool, real) => {
    if (!map.has(real)) {
      const i = map.size;
      const base = pool[i % pool.length];
      map.set(real, i < pool.length ? base : `${base} ${Math.floor(i / pool.length) + 1}`);
    }
    return map.get(real);
  };
  const hosts = new Map();
  const profiles = new Map();

  /** A hostname, a domain pattern or a whole URL. The shape is kept — a rule
   *  written as a URL prefix still reads as one — because the shape is what
   *  the row is explaining. */
  const host = (real) => {
    if (!on || !real) return real;
    const text = String(real);
    const match = text.match(/^([a-z][a-z0-9+.-]*:\/\/)?([^/]+)(\/.*)?$/i);
    if (!match) return pick(hosts, HOSTS, text);
    const alias = pick(hosts, HOSTS, match[2].toLowerCase());
    return `${match[1] || ""}${alias}${match[3] ? "/path" : ""}`;
  };

  /** A browser profile's display name, which on a real PC is regularly the
   *  owner's full name or their email address. */
  const profile = (real) => (on && real ? pick(profiles, PROFILES, String(real)) : real);

  const announce = () => {
    for (const fn of watchers) {
      try { fn(on); } catch { /* a watcher that throws must not stop the others */ }
    }
  };

  const apply = (value) => {
    const next = value === true;
    if (next === on) return;
    on = next;
    announce();
  };

  // Read once at load. Until the answer comes back the switch reads off, which
  // is the state every page drew before this existed.
  const ready = Promise.resolve()
    .then(() => core()?.invoke("ui_state_get", { key: KEY }))
    .then((saved) => { apply(saved === true); return on; })
    .catch(() => on);

  // Followed live: the box is in the main window's settings, and the tools that
  // have to change are in windows of their own.
  Promise.resolve()
    .then(() => events()?.listen?.(EVENT, (event) => apply(event.payload?.on === true)))
    .catch(() => {});

  /** Ticking the box. Written through the backend rather than `localStorage`,
   *  so it is on disk before this resolves and every other window is told. */
  const set = async (value) => {
    apply(value === true);
    await core()?.invoke("ui_state_set", { key: KEY, value: on })?.catch(() => {});
    await events()?.emit?.(EVENT, { on })?.catch(() => {});
    return on;
  };

  return {
    ready,
    set,
    on: () => on,
    host,
    profile,
    /** Returns an unsubscribe, so a tool that is torn down stops being called. */
    onChange(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
  };
})();
