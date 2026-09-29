#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const ENGLISH_PATH = path.join(SRC, "locales", "en.json");
const english = JSON.parse(fs.readFileSync(ENGLISH_PATH, "utf8"));

const UI_PROPERTIES = new Set([
  "ariaLabel", "caption", "desc", "description", "detail", "empty", "error", "heading", "help",
  "hint", "label", "message", "name", "note", "placeholder", "question", "status", "subtitle",
  "summary", "text", "title", "tooltip", "warning", "what",
]);
const UI_DOM_PROPERTIES = new Set(["innerHTML", "outerHTML", "textContent", "innerText", "title", "placeholder", "ariaLabel"]);
const NON_UI_PROPERTIES = new Set([
  "class", "className", "cmd", "command", "event", "icon", "id", "key", "keywords", "kind", "method", "path",
  "route", "selector", "source", "tone", "type", "url", "value",
]);
const NON_UI_CALLS = new Set(["addEventListener", "closest", "emit", "esc", "icon", "invoke", "listen", "querySelector", "querySelectorAll"]);
const UI_CALL_ARGUMENTS = new Map([
  ["alert", [0]], ["beginWork", [1, 2]], ["confirm", [0]], ["failBoot", [0]], ["notice", [0]], ["prompt", [0]],
  ["sayPhase", [0]], ["setAnswer", [0]], ["setNotice", [0]], ["setStatus", [0]], ["showBoot", [0, 1]],
  ["showError", [0]], ["stall", [0]], ["status", [0]], ["toast", [0]], ["updateWork", [1]],
]);
const NON_COPY = /^(?:[.#\[]|--|[a-z][\w-]*:[\w-]|[a-z][\w-]*\([^)]*\)$|[\w-]+(?:\.[\w-]+)+$)/i;

function clean(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&middot;/g, "·").replace(/&rarr;/g, "→")
    .replace(/\s+/g, " ").trim();
}

function looksHuman(value) {
  const text = clean(value);
  const literalText = text.replace(/\{\{expr:\d+\}\}/g, "");
  if (!/[A-Za-z]{2}/.test(literalText)) return false;
  if (!text || text.length > 700 || !/[A-Za-zÀ-ž]{2}/.test(text)) return false;
  if (NON_COPY.test(text) || /^https?:\/\//i.test(text) || /^[A-Z]:\\/i.test(text)) return false;
  if (/^[\w.-]+@[\w.-]+$/.test(text)) return false;
  return true;
}

function propertyName(node) {
  if (!node) return "";
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return String(node.value);
  return "";
}

function calleeName(node) {
  if (!node) return "";
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") return propertyName(node.property);
  return "";
}

const found = new Map();
function add(value, file, line, reason, dynamic = false) {
  const text = clean(value);
  if (!looksHuman(text)) return;
  if (!found.has(text)) found.set(text, { text, locations: [], dynamic });
  const item = found.get(text);
  item.dynamic ||= dynamic;
  if (item.locations.length < 8) item.locations.push(`${file}:${line} (${reason})`);
}

function htmlCopy(value, file, line, reason, dynamic = false) {
  const source = String(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "");
  for (const match of source.matchAll(/\b(?:title|placeholder|aria-label)\s*=\s*["']([^"']+)["']/gi)) {
    add(match[1], file, line, `${reason} attribute`, dynamic || match[1].includes("{{expr:"));
  }
  for (const match of source.matchAll(/>([^<>]+)</g)) {
    const text = clean(match[1]);
    if (!text.includes("{{expr:")) {
      add(text, file, line, `${reason} text`, dynamic);
      continue;
    }
    // An interpolation that renders markup (commonly an icon) creates a separate
    // DOM node. Preserve the adjacent static copy as its own translation key.
    const staticText = clean(text.replace(/^(?:\{\{expr:\d+\}\})+|(?:\{\{expr:\d+\}\})+$/g, ""));
    if (staticText && !staticText.includes("{{expr:")) add(staticText, file, line, `${reason} text beside interpolation`);
    else add(text, file, line, `${reason} dynamic text`, true);
  }
}

function lineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function templateValue(node, source) {
  let value = "";
  node.quasis.forEach((quasi, index) => {
    value += quasi.value.cooked ?? quasi.value.raw;
    if (index < node.expressions.length) value += `{{expr:${index + 1}}}`;
  });
  return value;
}

function directUiContext(node, ancestors) {
  const parent = ancestors.at(-1);
  if (!parent) return "";
  if (parent.type === "Property" && parent.value === node && UI_PROPERTIES.has(propertyName(parent.key))) {
    return `property ${propertyName(parent.key)}`;
  }
  if (parent.type === "AssignmentExpression" && parent.right === node && parent.left?.type === "MemberExpression" && UI_DOM_PROPERTIES.has(propertyName(parent.left.property))) {
    return `assignment ${propertyName(parent.left.property)}`;
  }
  if (parent.type === "CallExpression") {
    const name = calleeName(parent.callee);
    const index = parent.arguments.indexOf(node);
    if (UI_CALL_ARGUMENTS.get(name)?.includes(index)) return `call ${name}`;
  }
  return "";
}

function probableCopy(node, ancestors) {
  const parent = ancestors.at(-1);
  if (parent?.type === "Property" && NON_UI_PROPERTIES.has(propertyName(parent.key))) return false;
  if (parent?.type === "CallExpression" && NON_UI_CALLS.has(calleeName(parent.callee))) return false;
  const value = node.type === "TemplateLiteral" ? templateValue(node) : node.value;
  const text = clean(value);
  if (text.includes("<") || !/\s/.test(text)) return false;
  const words = text.match(/[A-Za-zÀ-ž]{2,}/g) || [];
  return words.length >= 4 || (/^[A-ZÀ-Þ]/.test(text) && words.length >= 2) || /[.!?…]$/.test(text);
}

function walk(node, source, file, ancestors = []) {
  if (!node || typeof node !== "object") return;
  const context = directUiContext(node, ancestors);
  const line = lineAt(source, node.start || 0);
  if (node.type === "Literal" && typeof node.value === "string") {
    const isHtml = String(node.value).includes("<") && String(node.value).includes(">");
    if (isHtml) htmlCopy(node.value, file, line, context || "HTML literal");
    if (context && !isHtml) add(node.value, file, line, context);
    else if (!isHtml && probableCopy(node, ancestors)) add(node.value, file, line, "probable UI copy");
    else if (!isHtml && /^[A-ZÀ-Þ]/.test(clean(node.value)) && ancestors.some((ancestor) => (
      ancestor.type === "TemplateLiteral" && templateValue(ancestor).includes("<")
    ))) add(node.value, file, line, "HTML template option");
  } else if (node.type === "TemplateLiteral") {
    const value = templateValue(node, source);
    if (value.includes("<") && value.includes(">")) htmlCopy(value, file, line, context || "HTML template", node.expressions.length > 0);
    if (context && !value.includes("<")) add(value, file, line, context, node.expressions.length > 0);
    else if (!value.includes("<") && probableCopy(node, ancestors)) add(value, file, line, "probable UI template", node.expressions.length > 0);
  }
  const next = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (["start", "end", "loc"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => child?.type && walk(child, source, file, next));
    else if (value?.type) walk(value, source, file, next);
  }
}

for (const file of fs.readdirSync(SRC).filter((name) => name.endsWith(".js") && name !== "changelog.js")) {
  const source = fs.readFileSync(path.join(SRC, file), "utf8");
  const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true });
  walk(ast, source, file);
}

for (const file of fs.readdirSync(SRC).filter((name) => name.endsWith(".html"))) {
  const source = fs.readFileSync(path.join(SRC, file), "utf8");
  const withoutCode = source.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "");
  htmlCopy(withoutCode, file, 1, "HTML document");
}

const items = [...found.values()].sort((a, b) => a.text.localeCompare(b.text));
const missing = items.filter((item) => !(item.text in english));
const sourceFiles = fs.readdirSync(SRC).filter((name) =>
  (name.endsWith(".js") && name !== "changelog.js") || name.endsWith(".html")
).sort();
const files = sourceFiles.map((file) => {
  const candidates = items.filter((item) => item.locations.some((location) => location.startsWith(`${file}:`)));
  const missing = candidates.filter((item) => !(item.text in english));
  return { file, candidates: candidates.length, catalogued: candidates.length - missing.length, missing: missing.map((item) => item.text) };
});
const report = {
  candidates: items.length,
  catalogued: items.length - missing.length,
  filesChecked: files.length,
  files,
  missing,
};
if (process.argv.includes("--write")) {
  fs.writeFileSync(path.join(ROOT, "i18n-source-audit.json"), `${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(JSON.stringify(report, null, 2));
}
process.exitCode = missing.length ? 1 : 0;
