// Privacy-preserving PageRain page-view tracking. Only an anonymous identifier
// and a coarse app route are sent; project names and filesystem paths never are.
//
// Nothing is sent until the user has said yes. The answer lives in the app's
// own preferences, so both the main window and a popped-out terminal read the
// same one, and forgetting it in a reset asks the question again.
//
// The POST itself is made in Rust (`analytics_page_view`). PageRain answers a
// CORS preflight with no `Access-Control-Allow-Origin`, so a `fetch` from this
// window is refused before it reaches the network - the request has to leave
// the app outside the webview to arrive at all.
(() => {
  const prefsKey = "wint.prefs.v1";
  const visitorKey = "wint.analytics.visitor.v1";
  let visitorId;
  let lastPath = null;
  let allowed = false;

  try {
    allowed = JSON.parse(localStorage.getItem(prefsKey) || "{}").analytics === true;
  } catch {
    // No preferences to read yet: nothing is sent until the question is asked.
  }

  try {
    visitorId = localStorage.getItem(visitorKey);
    if (!visitorId) {
      visitorId = crypto.randomUUID();
      localStorage.setItem(visitorKey, visitorId);
    }
  } catch {
    // Storage can be unavailable in hardened webviews. Keep a stable ID for
    // this process in that case without making analytics affect the app.
    visitorId = crypto.randomUUID();
  }

  /** Follows the setting, whether it was just answered or just switched off. */
  window.wintAnalyticsConsent = (on) => {
    allowed = on === true;
  };

  window.wintTrackPageView = (path) => {
    // `lastPath` is left alone while switched off, so turning it on later still
    // counts the screen that is on the window right then.
    if (!allowed || !path || path === lastPath) return;
    lastPath = path;
    // Fire and forget, and never let a failed report reach the UI: analytics
    // must not be able to change what the app does.
    window.__TAURI__?.core?.invoke("analytics_page_view", { view: { visitorId, path } })
      ?.catch(() => {});
  };
})();
