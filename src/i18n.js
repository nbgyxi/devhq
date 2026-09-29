// Runtime localization for the no-build frontend. Catalog keys are the English
// source strings, which keeps the JSON files straightforward for translators.
// Empty/missing values fall back to English.
window.wintI18n = (() => {
  let english = {};
  let active = {};
  let language = "en";
  let patterns = [];
  const originalText = new WeakMap();
  const originalAttrs = new WeakMap();
  const attrs = ["title", "placeholder", "aria-label"];

  async function catalog(code) {
    const response = await fetch(`locales/${code}.json`);
    if (!response.ok) throw new Error(`Could not load locale ${code}`);
    return response.json();
  }

  function rebuildPatterns() {
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    patterns = Object.keys(english)
      .filter((key) => /\{\{expr:\d+\}\}/.test(key) && (key.match(/[A-Za-zÀ-ž]/g) || []).length >= 4)
      .map((key) => {
        const numbers = [];
        const pieces = key.split(/\{\{expr:(\d+)\}\}/g);
        let source = "^";
        for (let index = 0; index < pieces.length; index++) {
          if (index % 2) {
            numbers.push(pieces[index]);
            source += "([\\s\\S]*?)";
          } else source += escape(pieces[index]);
        }
        return { key, numbers, regex: new RegExp(`${source}$`), weight: key.replace(/\{\{expr:\d+\}\}/g, "").length };
      })
      .sort((a, b) => b.weight - a.weight);
  }

  function translated(source) {
    const exact = active[source] || english[source];
    if (exact) return exact;
    for (const pattern of patterns) {
      const match = pattern.regex.exec(source);
      if (!match) continue;
      const values = {};
      pattern.numbers.forEach((number, index) => { values[number] = match[index + 1]; });
      const template = active[pattern.key] || english[pattern.key] || pattern.key;
      return template.replace(/\{\{expr:(\d+)\}\}/g, (placeholder, number) => values[number] ?? placeholder);
    }
    return source;
  }

  function t(source, values = {}) {
    return translated(source).replace(/\{(\w+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
    ));
  }

  function translateText(node) {
    if (!originalText.has(node)) originalText.set(node, node.nodeValue);
    const source = originalText.get(node);
    const value = source.trim();
    if (!value) return;
    const isEnglishOption = node.parentElement?.tagName === "OPTION" && node.parentElement.value === "en";
    const next = isEnglishOption && language !== "en"
      ? `English — ${translated("English")}`
      : translated(value);
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
    rebuildPatterns();
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
    try { return JSON.parse(localStorage.getItem("wint.prefs.v1") || "{}").language || "system"; }
    catch { return "system"; }
  }

  function refresh(element) {
    originalAttrs.delete(element);
    apply(element);
  }

  return { init, setLanguage, apply, refresh, storedLanguage, t, get language() { return language; } };
})();
