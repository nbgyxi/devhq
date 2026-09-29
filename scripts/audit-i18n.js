#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { buildCatalog } = require("./e2e/catalog");
const { stubSource } = require("./e2e/tauri-stub");
const { serveDir } = require("./e2e/static-server");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const english = JSON.parse(fs.readFileSync(path.join(SRC, "locales", "en.json"), "utf8"));

function isVolatileOutput(text) {
  return /^[-+]?\d[\d.,/]*$/.test(text)
    || /^0x[0-9a-f]+$/i.test(text)
    || /^[0-9a-f]{8,}$/i.test(text)
    || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(text)
    || /^\d{4}-\d\d-\d\dT/.test(text)
    || /^\d{4}-W\d\d$/.test(text)
    || /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d/.test(text)
    || /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d/.test(text);
}

async function stringsOn(page) {
  return page.evaluate(() => {
    const found = [];
    const add = (value) => {
      const clean = String(value || "").replace(/\s+/g, " ").trim();
      if (clean) found.push(clean);
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || ["SCRIPT", "STYLE", "CODE", "KBD"].includes(parent.tagName) || parent.closest(".ms,[aria-hidden=true]")) continue;
      add(node.nodeValue);
    }
    for (const element of document.querySelectorAll("[title],[placeholder],[aria-label]")) {
      for (const attr of ["title", "placeholder", "aria-label"]) add(element.getAttribute(attr));
    }
    return found;
  });
}

async function untranslatedOn(page, catalog) {
  return page.evaluate((translations) => {
    const leaks = [];
    const check = (value, where) => {
      const text = String(value || "").replace(/\s+/g, " ").trim();
      if (text && translations[text] && translations[text] !== text) leaks.push({ text, where });
    };
    const host = document.getElementById("settings-host");
    if (!host) return [{ text: "Settings host did not mount", where: "document" }];
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (!parent || ["SCRIPT", "STYLE", "CODE", "KBD"].includes(parent.tagName) || parent.closest(".ms,[aria-hidden=true]")) continue;
      check(walker.currentNode.nodeValue, parent.tagName.toLowerCase());
    }
    for (const element of host.querySelectorAll("[title],[placeholder],[aria-label]")) {
      for (const attr of ["title", "placeholder", "aria-label"]) check(element.getAttribute(attr), attr);
    }
    return leaks.slice(0, 200);
  }, catalog);
}

(async () => {
  const site = await serveDir(SRC);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(stubSource());
  const found = new Map();
  const runtimeProblems = [];
  try {
    for (const entry of buildCatalog().filter((entry) => entry.id !== "overview" && entry.id !== "settings")) {
      const url = `${site.url}/tool.html?id=${encodeURIComponent(entry.id)}&name=${encodeURIComponent(entry.label)}&theme=dark`;
      await page.goto(url, { waitUntil: "load" });
      await page.waitForTimeout(350);
      for (const text of await stringsOn(page)) {
        if (!found.has(text)) found.set(text, new Set());
        found.get(text).add(entry.id);
      }
    }
    for (const code of ["ar", "bn", "es", "fr", "hi", "id", "pt", "ru", "zh"]) {
      const result = await page.evaluate(async (language) => {
        await window.wintI18n.setLanguage(language);
        const source = "3 windows hidden by Focus mode will be shown again";
        return { source, translated: window.wintI18n.t(source) };
      }, code);
      if (result.translated === result.source || /\{\{expr:\d+\}\}/.test(result.translated) || !result.translated.includes("3")) {
        runtimeProblems.push({ code, ...result });
      }
    }
    const settingsPage = await browser.newPage();
    await settingsPage.addInitScript(stubSource());
    await settingsPage.addInitScript(() => {
      localStorage.setItem("wint.prefs.v1", JSON.stringify({ language: "ar", analytics: false, roots: ["C:\\code"], activeView: "settings" }));
    });
    await settingsPage.goto(`${site.url}/index.html`, { waitUntil: "load" });
    await settingsPage.waitForSelector("#settings-host:not([hidden])", { timeout: 10000 });
    await settingsPage.waitForTimeout(1000);
    const arabic = JSON.parse(fs.readFileSync(path.join(SRC, "locales", "ar.json"), "utf8"));
    runtimeProblems.push(...(await untranslatedOn(settingsPage, arabic)).map((problem) => ({ code: "ar-settings", ...problem })));
    await settingsPage.close();
  } finally {
    await browser.close();
    await site.close();
  }
  const translatable = [...found].filter(([text]) => !isVolatileOutput(text));
  const missing = translatable
    .filter(([text]) => !(text in english))
    .map(([text, tools]) => ({ text, tools: [...tools] }))
    .sort((a, b) => a.text.localeCompare(b.text));
  const localeProblems = [];
  for (const file of fs.readdirSync(path.join(SRC, "locales")).filter((name) => name.endsWith(".json"))) {
    const catalog = JSON.parse(fs.readFileSync(path.join(SRC, "locales", file), "utf8"));
    const absent = Object.keys(english).filter((key) => !catalog[key]);
    const extra = Object.keys(catalog).filter((key) => !(key in english));
    if (absent.length || extra.length) localeProblems.push({ file, absent, extra });
  }
  const report = { rendered: found.size, translatable: translatable.length, catalogued: translatable.length - missing.length, missing, localeProblems, runtimeProblems };
  if (process.argv.includes("--write")) {
    fs.writeFileSync(path.join(ROOT, "i18n-audit-output.json"), `${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  process.exitCode = missing.length || localeProblems.length || runtimeProblems.length ? 1 : 0;
})().catch((error) => { console.error(error); process.exit(2); });
