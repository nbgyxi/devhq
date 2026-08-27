// Runtime localization for the no-build frontend. Catalog keys are the English
// source strings, which keeps the JSON files straightforward for translators.
// Empty/missing values fall back to English.
window.devhqI18n = (() => {
  let english = {};
  let active = {};
  let language = "en";
  const originalText = new WeakMap();
  const originalAttrs = new WeakMap();
  const attrs = ["title", "placeholder", "aria-label"];

  async function catalog(code) {
    const response = await fetch(`locales/${code}.json`);
    if (!response.ok) throw new Error(`Could not load locale ${code}`);
    return response.json();
  }

  function translated(source) {
    return active[source] || english[source] || source;
  }

  function translateText(node) {
    if (!originalText.has(node)) originalText.set(node, node.nodeValue);
    const source = originalText.get(node);
    const value = source.trim();
    if (!value) return;
    const next = translated(value);
    node.nodeValue = source.replace(value, next);
  }

  function translateElement(element) {
    let saved = originalAttrs.get(element);
    if (!saved) {
      saved = {};
      for (const attr of attrs) if (element.hasAttribute(attr)) saved[attr] = element.getAttribute(attr);
      originalAttrs.set(element, saved);
    }
    for (const [attr, source] of Object.entries(saved)) element.setAttribute(attr, translated(source));
  }

  function apply(root = document.body) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) translateText(root);
    if (root.nodeType === Node.ELEMENT_NODE) translateElement(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (walker.currentNode.nodeType === Node.TEXT_NODE) translateText(walker.currentNode);
      else translateElement(walker.currentNode);
    }
  }

  async function setLanguage(code) {
    language = code === "system" ? (navigator.language || "en").toLowerCase().split("-")[0] : code;
    try { active = language === "en" ? english : await catalog(language); }
    catch { active = {}; }
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
    apply();
  }

  async function init(code) {
    try { english = await catalog("en"); } catch { english = {}; }
    await setLanguage(code);
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) apply(node);
    }).observe(document.body, { childList: true, subtree: true });
  }

  function storedLanguage() {
    try { return JSON.parse(localStorage.getItem("devhq.prefs.v1") || "{}").language || "system"; }
    catch { return "system"; }
  }

  function refresh(element) {
    originalAttrs.delete(element);
    apply(element);
  }

  return { init, setLanguage, apply, refresh, storedLanguage, get language() { return language; } };
})();
