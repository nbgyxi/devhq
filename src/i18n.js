// Runtime localization for the no-build frontend. Catalog keys are the English
// source strings, which keeps the JSON files straightforward for translators.
// Empty/missing values fall back to English.
window.wintI18n = (() => {
  // A distinct empty object, so "not loaded yet" is tellable from "loaded and
  // it held nothing".
  const EMPTY = {};
  let english = EMPTY;
  let active = EMPTY;
  let translating = false;
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

  // An icon is a text node too: `<span class="ms">open_in_new</span>` draws a
  // picture only as long as the glyph name survives verbatim. Catalogs built by
  // reading rendered screens picked those names up as if they were UI text, so
  // translating one turns the icon into a word. Nothing inside an icon, a
  // script, a style or a code sample is ever language.
  function skipText(node) {
    const parent = node.parentElement;
    if (!parent) return true;
    if (["SCRIPT", "STYLE", "CODE", "KBD"].includes(parent.tagName)) return true;
    return !!parent.closest(".ms,[aria-hidden=true]");
  }

  function translateText(node) {
    if (skipText(node)) return;
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

  /** The English catalog is only ever a fallback for another language: with it
   *  empty, `translated` hands every source string straight back, which is
   *  exactly what English is. It is a third of a megabyte of JSON and a few
   *  thousand compiled regexes, and every window - the shell and each isolated
   *  tool webview, each with a cache of its own - used to pay for it on boot
   *  before anything was drawn. It loads on the way to a real translation now.
   */
  async function loadEnglish() {
    if (english !== EMPTY) return;
    try { english = await catalog("en"); } catch { english = {}; }
  }

  // Watching the whole document only earns its cost while something is being
  // translated. In English there is nothing to apply, so every row a tool
  // renders would walk a TreeWalker in order to change nothing.
  let observer = null;
  function observe() {
    if (observer || !document.body) return;
    observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) apply(node);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function setLanguage(code) {
    language = code === "system" ? (navigator.language || "en").toLowerCase().split("-")[0] : code;
    if (language === "en") active = english;
    else {
      await loadEnglish();
      try { active = await catalog(language); } catch { active = {}; }
    }
    rebuildPatterns();
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
    if (language !== "en") { translating = true; observe(); }
    // Going back to English still has to walk the page: `apply` is what puts
    // the remembered source text back into nodes another language rewrote.
    if (translating) apply();
  }

  async function init(code) {
    await setLanguage(code);
  }

  // An isolated tool webview is built with a WebView2 user data folder of its
  // own, so it has a `localStorage` of its own too: the shell's prefs are
  // simply not there, every tool read back "system", and each one drew itself
  // in the Windows language whatever the user had chosen. The shell stamps the
  // chosen language into the page URL when it builds one, and that wins.
  function storedLanguage() {
    try {
      const asked = new URLSearchParams(location.search).get("lang");
      if (asked) return asked;
    } catch {}
    try { return JSON.parse(localStorage.getItem("wint.prefs.v1") || "{}").language || "system"; }
    catch { return "system"; }
  }

  function refresh(element) {
    originalAttrs.delete(element);
    apply(element);
  }

  return { init, setLanguage, apply, refresh, storedLanguage, t, get language() { return language; } };
})();
