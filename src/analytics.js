// Privacy-preserving PageRain page-view tracking. Only an anonymous identifier
// and a coarse app route are sent; project names and filesystem paths never are.
(() => {
  const endpoint = "https://pagerain.net/api/analytics/apps/de44f8ee-4897-410f-85a9-66ff62e246b5/events";
  const visitorKey = "devhq.analytics.visitor.v1";
  let visitorId;
  let lastPath = null;

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

  window.devhqTrackPageView = (path) => {
    if (!path || path === lastPath) return;
    lastPath = path;
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorId, path }),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }).catch(() => {});
  };
})();
