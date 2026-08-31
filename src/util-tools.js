// Shared utility tools: encode, hash, JWT, timestamps, JSON/XML/YAML/CSV.
//
// One host page, many pin targets. Each entry in UTIL_TOOLS is a tool the
// search box and the dock can open; they all share the same input/output chrome
// so adding another transform is a catalog line, not a new page.
//
// Everything here runs in the WebView. Nothing leaves the machine.
//
// Kept inside an IIFE on purpose: a classic script that declares mount/wire/
// action/open at the top level overwrites the same names in dns.js and kills
// the shell before the window buttons are wired.

(() => {
const util_invoke = window.__TAURI__.core.invoke;
const TE = new TextEncoder(), TD = new TextDecoder();
const bytes = (s) => TE.encode(s);
/** Chunk size under typical engine argument limits for fromCharCode / apply. */
const BYTE_CHUNK = 0x8000;

function hex(buf, up) {
  const arr = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, "0");
  return up ? s.toUpperCase() : s;
}

function b64(buf) {
  const arr = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < arr.length; i += BYTE_CHUNK) {
    binary += String.fromCharCode.apply(null, arr.subarray(i, i + BYTE_CHUNK));
  }
  return btoa(binary);
}

const group = (s, n) => s.replace(new RegExp(`(.{${n}})`, "g"), "$1 ").trim();

function md5(input) {
  const b = bytes(input), n = b.length, len = ((n + 8) >> 6) + 1, x = new Array(len * 16).fill(0);
  for (let i = 0; i < n; i++) x[i >> 2] |= b[i] << ((i % 4) * 8);
  x[n >> 2] |= 0x80 << ((n % 4) * 8);
  x[len * 16 - 2] = n * 8;
  const add = (a, c) => { const l = (a & 0xFFFF) + (c & 0xFFFF); return (((a >> 16) + (c >> 16) + (l >> 16)) << 16) | (l & 0xFFFF); };
  const rl = (v, c) => (v << c) | (v >>> (32 - c));
  const cmn = (q, a, c, xx, s, t) => add(rl(add(add(a, q), add(xx, t)), s), c);
  const ff = (a, c, d, e, xx, s, t) => cmn((c & d) | (~c & e), a, c, xx, s, t);
  const gg = (a, c, d, e, xx, s, t) => cmn((c & e) | (d & ~e), a, c, xx, s, t);
  const hh = (a, c, d, e, xx, s, t) => cmn(c ^ d ^ e, a, c, xx, s, t);
  const ii = (a, c, d, e, xx, s, t) => cmn(d ^ (c | ~e), a, c, xx, s, t);
  let a = 1732584193, c = -271733879, d = -1732584194, e = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const oa = a, oc = c, od = d, oe = e;
    a = ff(a, c, d, e, x[i], 7, -680876936); e = ff(e, a, c, d, x[i + 1], 12, -389564586); d = ff(d, e, a, c, x[i + 2], 17, 606105819); c = ff(c, d, e, a, x[i + 3], 22, -1044525330);
    a = ff(a, c, d, e, x[i + 4], 7, -176418897); e = ff(e, a, c, d, x[i + 5], 12, 1200080426); d = ff(d, e, a, c, x[i + 6], 17, -1473231341); c = ff(c, d, e, a, x[i + 7], 22, -45705983);
    a = ff(a, c, d, e, x[i + 8], 7, 1770035416); e = ff(e, a, c, d, x[i + 9], 12, -1958414417); d = ff(d, e, a, c, x[i + 10], 17, -42063); c = ff(c, d, e, a, x[i + 11], 22, -1990404162);
    a = ff(a, c, d, e, x[i + 12], 7, 1804603682); e = ff(e, a, c, d, x[i + 13], 12, -40341101); d = ff(d, e, a, c, x[i + 14], 17, -1502002290); c = ff(c, d, e, a, x[i + 15], 22, 1236535329);
    a = gg(a, c, d, e, x[i + 1], 5, -165796510); e = gg(e, a, c, d, x[i + 6], 9, -1069501632); d = gg(d, e, a, c, x[i + 11], 14, 643717713); c = gg(c, d, e, a, x[i], 20, -373897302);
    a = gg(a, c, d, e, x[i + 5], 5, -701558691); e = gg(e, a, c, d, x[i + 10], 9, 38016083); d = gg(d, e, a, c, x[i + 15], 14, -660478335); c = gg(c, d, e, a, x[i + 4], 20, -405537848);
    a = gg(a, c, d, e, x[i + 9], 5, 568446438); e = gg(e, a, c, d, x[i + 14], 9, -1019803690); d = gg(d, e, a, c, x[i + 3], 14, -187363961); c = gg(c, d, e, a, x[i + 8], 20, 1163531501);
    a = gg(a, c, d, e, x[i + 13], 5, -1444681467); e = gg(e, a, c, d, x[i + 2], 9, -51403784); d = gg(d, e, a, c, x[i + 7], 14, 1735328473); c = gg(c, d, e, a, x[i + 12], 20, -1926607734);
    a = hh(a, c, d, e, x[i + 5], 4, -378558); e = hh(e, a, c, d, x[i + 8], 11, -2022574463); d = hh(d, e, a, c, x[i + 11], 16, 1839030562); c = hh(c, d, e, a, x[i + 14], 23, -35309556);
    a = hh(a, c, d, e, x[i + 1], 4, -1530992060); e = hh(e, a, c, d, x[i + 4], 11, 1272893353); d = hh(d, e, a, c, x[i + 7], 16, -155497632); c = hh(c, d, e, a, x[i + 10], 23, -1094730640);
    a = hh(a, c, d, e, x[i + 13], 4, 681279174); e = hh(e, a, c, d, x[i], 11, -358537222); d = hh(d, e, a, c, x[i + 3], 16, -722521979); c = hh(c, d, e, a, x[i + 6], 23, 76029189);
    a = hh(a, c, d, e, x[i + 9], 4, -640364487); e = hh(e, a, c, d, x[i + 12], 11, -421815835); d = hh(d, e, a, c, x[i + 15], 16, 530742520); c = hh(c, d, e, a, x[i + 2], 23, -995338651);
    a = ii(a, c, d, e, x[i], 6, -198630844); e = ii(e, a, c, d, x[i + 7], 10, 1126891415); d = ii(d, e, a, c, x[i + 14], 15, -1416354905); c = ii(c, d, e, a, x[i + 5], 21, -57434055);
    a = ii(a, c, d, e, x[i + 12], 6, 1700485571); e = ii(e, a, c, d, x[i + 3], 10, -1894986606); d = ii(d, e, a, c, x[i + 10], 15, -1051523); c = ii(c, d, e, a, x[i + 1], 21, -2054922799);
    a = ii(a, c, d, e, x[i + 8], 6, 1873313359); e = ii(e, a, c, d, x[i + 15], 10, -30611744); d = ii(d, e, a, c, x[i + 6], 15, -1560198380); c = ii(c, d, e, a, x[i + 13], 21, 1309151649);
    a = ii(a, c, d, e, x[i + 4], 6, -145523070); e = ii(e, a, c, d, x[i + 11], 10, -1120210379); d = ii(d, e, a, c, x[i + 2], 15, 718787259); c = ii(c, d, e, a, x[i + 9], 21, -343485551);
    a = add(a, oa); c = add(c, oc); d = add(d, od); e = add(e, oe);
  }
  return [a, c, d, e].map(v => [0, 8, 16, 24].map(sh => ((v >> sh) & 255).toString(16).padStart(2, "0")).join("")).join("");
}

const digest = async (algo, s) => crypto.subtle.digest(algo, bytes(s));
const b64pad = (s) => s + "=".repeat((4 - (s.length % 4)) % 4);
const fromB64Url = (s) => atob(b64pad(s.replace(/-/g, "+").replace(/_/g, "/")));
const utf8 = (bin) => TD.decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));

const ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const htmlEnc = (s, all) => s.replace(/[\s\S]/g, (ch) => ENT[ch] || (all && ch.charCodeAt(0) > 126 ? `&#${ch.codePointAt(0)};` : ch));
const htmlDec = (s) => { const d = document.createElement("textarea"); d.innerHTML = s; return d.value; };

function toYaml(v, ind) {
  const pad = "  ".repeat(ind);
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? v.map(i => `\n${pad}- ${toYaml(i, ind + 1).replace(/^\n+/, "")}`).join("") : "[]";
  if (typeof v === "object") {
    const ks = Object.keys(v);
    if (!ks.length) return "{}";
    return ks.map(k => { const c = toYaml(v[k], ind + 1); return `\n${pad}${k}:${c.startsWith("\n") ? c : " " + c}`; }).join("");
  }
  if (typeof v === "string" && (v === "" || /^[\s]|[\s]$|[:#{}\[\],&*?|>'"%@`]|^(true|false|null|\d)/i.test(v)) ) return JSON.stringify(v);
  return String(v);
}
const scalar = (t) => {
  t = t.trim();
  if (!t.length) return "";
  if (/^".*"$|^'.*'$/s.test(t)) return t.slice(1, -1);
  if (t === "true" || t === "false") return t === "true";
  if (t === "null" || t === "~") return null;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return Number(t);
  return t;
};
function fromYaml(src) {
  const lines = src.split(/\r?\n/).map(l => l.replace(/\t/g, "  ")).filter(l => l.trim() && !/^\s*#/.test(l));
  let i = 0;
  const indentOf = (l) => l.match(/^ */)[0].length;
  function parse(ind) {
    if (i >= lines.length) return null;
    if (lines[i].trim().startsWith("- ") || lines[i].trim() === "-") {
      const arr = [];
      while (i < lines.length && indentOf(lines[i]) === ind && lines[i].trim().startsWith("-")) {
        const rest = lines[i].trim().slice(1).trim(); i++;
        if (!rest) arr.push(i < lines.length && indentOf(lines[i]) > ind ? parse(indentOf(lines[i])) : null);
        else if (/^[\w".'-]+\s*:(\s|$)/.test(rest)) { lines.splice(i, 0, " ".repeat(ind + 2) + rest); arr.push(parse(ind + 2)); }
        else arr.push(scalar(rest));
      }
      return arr;
    }
    const obj = {};
    while (i < lines.length && indentOf(lines[i]) === ind) {
      const m = lines[i].trim().match(/^("[^"]*"|'[^']*'|[^:]+):\s*(.*)$/);
      if (!m) throw new Error(`Line ${i + 1}: expected "key: value"`);
      const key = String(scalar(m[1])); i++;
      if (m[2] === "" || m[2] === "|" || m[2] === ">") obj[key] = (i < lines.length && indentOf(lines[i]) > ind) ? parse(indentOf(lines[i])) : (m[2] ? "" : null);
      else obj[key] = scalar(m[2]);
    }
    return obj;
  }
  return parse(indentOf(lines[0] || ""));
}

function parseCsv(src) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"' && src[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (ch !== "\r") cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.length > 1 || r[0] !== "");
}
const csvCell = (v) => { const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function xmlToObj(node) {
  const out = {};
  for (const a of node.attributes || []) out["@" + a.name] = a.value;
  const kids = [...node.children];
  if (!kids.length) { const t = (node.textContent || "").trim(); if (!Object.keys(out).length) return t === "" ? null : scalar(t); if (t) out["#text"] = t; return out; }
  for (const k of kids) { const v = xmlToObj(k); if (k.tagName in out) { if (!Array.isArray(out[k.tagName])) out[k.tagName] = [out[k.tagName]]; out[k.tagName].push(v); } else out[k.tagName] = v; }
  return out;
}
function objToXml(v, tag, ind) {
  const pad = "  ".repeat(ind);
  if (Array.isArray(v)) return v.map(i => objToXml(i, tag, ind)).join("\n");
  if (v && typeof v === "object") {
    const attrs = Object.keys(v).filter(k => k.startsWith("@")).map(k => ` ${k.slice(1)}="${String(v[k]).replace(/"/g, "&quot;")}"`).join("");
    const kids = Object.keys(v).filter(k => !k.startsWith("@") && k !== "#text");
    const text = v["#text"] ? String(v["#text"]) : "";
    if (!kids.length) return `${pad}<${tag}${attrs}>${htmlEnc(text)}</${tag}>`;
    return `${pad}<${tag}${attrs}>\n${kids.map(k => objToXml(v[k], k, ind + 1)).join("\n")}\n${pad}</${tag}>`;
  }
  return `${pad}<${tag}>${htmlEnc(v === null || v === undefined ? "" : String(v))}</${tag}>`;
}

function repairJson(src) {
  const fixes = [];
  let s = src.replace(/^\uFEFF/, "").trim();
  const fix = (re, rep, msg) => { if (re.test(s)) { re.lastIndex = 0; s = s.replace(re, rep); fixes.push(msg); } re.lastIndex = 0; };
  fix(/^[a-zA-Z_$][\w$]*\s*=\s*/, "", "Dropped a leading assignment");
  fix(/;\s*$/, "", "Dropped a trailing semicolon");
  fix(/\/\*[\s\S]*?\*\//g, "", "Stripped /* block comments */");
  fix(/(^|[^:"'\\])\/\/[^\n]*/g, "$1", "Stripped // line comments");
  fix(/[\u201c\u201d]/g, '"', "Straightened curly double quotes");
  fix(/[\u2018\u2019]/g, "'", "Straightened curly single quotes");
  fix(/'([^'\\\n]*)'(\s*[:,\}\]]|\s*$)/g, '"$1"$2', "Converted single-quoted strings to double");
  fix(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, '$1"$2"$3', "Quoted bare object keys");
  fix(/\bTrue\b/g, "true", "Python True → true");
  fix(/\bFalse\b/g, "false", "Python False → false");
  fix(/\b(None|undefined|NaN|Infinity)\b/g, "null", "Non-JSON literals → null");
  fix(/,(\s*[}\]])/g, "$1", "Removed trailing commas");
  fix(/}(\s*){/g, "},$1{", "Inserted missing commas between objects");
  const open = (s.match(/[{\[]/g) || []).length, close = (s.match(/[}\]]/g) || []).length;
  if (open > close) {
    const stack = [];
    for (const ch of s) { if (ch === "{" || ch === "[") stack.push(ch); else if (ch === "}" || ch === "]") stack.pop(); }
    s += stack.reverse().map(c => (c === "{" ? "}" : "]")).join("");
    fixes.push(`Closed ${open - close} unterminated bracket${open - close === 1 ? "" : "s"}`);
  }
  try { return { value: JSON.parse(s), text: s, fixes }; }
  catch (e) { return { fixes, error: e.message }; }
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
function serializeDom(node, ind) {
  const pad = "  ".repeat(ind);
  if (node.nodeType === 3) { const t = node.textContent.replace(/\s+/g, " ").trim(); return t ? pad + t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : ""; }
  if (node.nodeType === 8) return `${pad}<!--${node.textContent.trim()}-->`;
  if (node.nodeType !== 1) return "";
  const tag = node.tagName.toLowerCase();
  const attrs = [...node.attributes].map(a => ` ${a.name}="${a.value.replace(/"/g, "&quot;")}"`).join("");
  if (VOID.has(tag)) return `${pad}<${tag}${attrs} />`;
  const kids = [...node.childNodes].map(k => serializeDom(k, ind + 1)).filter(Boolean);
  if (!kids.length) return `${pad}<${tag}${attrs}></${tag}>`;
  if (kids.length === 1 && node.childNodes.length === 1 && node.firstChild.nodeType === 3) return `${pad}<${tag}${attrs}>${kids[0].trim()}</${tag}>`;
  return `${pad}<${tag}${attrs}>\n${kids.join("\n")}\n${pad}</${tag}>`;
}
function tidyMarkup(src) {
  const issues = [];
  if (/&(?![a-z#0-9]+;)/i.test(src)) issues.push("Bare & escaped to &amp;");
  if (/<[A-Z][A-Za-z0-9]*[\s>]/.test(src)) issues.push("Tag names lowercased");
  if (/<[a-z][^>]*?\s[\w-]+=[^"'\s>]+[\s>]/i.test(src)) issues.push("Quoted unquoted attribute values");
  const opens = [...src.matchAll(/<([a-z][\w-]*)\b[^>]*?(\/?)>/gi)].filter(m => !m[2] && !VOID.has(m[1].toLowerCase())).map(m => m[1].toLowerCase());
  const closes = [...src.matchAll(/<\/([a-z][\w-]*)\s*>/gi)].map(m => m[1].toLowerCase());
  const missing = {};
  for (const o of opens) missing[o] = (missing[o] || 0) + 1;
  for (const c of closes) if (missing[c]) missing[c]--;
  const unclosed = Object.entries(missing).filter(([, n]) => n > 0);
  for (const [tag, n] of unclosed) issues.push(`Closed ${n} unterminated <${tag}>`);
  if (/<\/([a-z][\w-]*)\s*>/i.test(src) && closes.some(c => !opens.includes(c))) issues.push("Dropped stray closing tags");
  const doc = new DOMParser().parseFromString(src, "text/html");
  const root = doc.body.children.length || doc.body.textContent.trim() ? doc.body : doc.head;
  const text = [...root.childNodes].map(n => serializeDom(n, 0)).filter(Boolean).join("\n");
  return { text, issues, nodes: root.querySelectorAll("*").length };
}

const tsType = (v, name, seen) => {
  const t = (val, ind) => {
    const p = "  ".repeat(ind);
    if (val === null) return "null";
    if (Array.isArray(val)) return val.length ? `${t(val[0], ind)}[]` : "unknown[]";
    if (typeof val === "object") return `{\n${Object.keys(val).map(k => `${p}  ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${t(val[k], ind + 1)};`).join("\n")}\n${p}}`;
    return typeof val;
  };
  return `type ${name} = ${t(v, 0)};`;
};

const EPOCH_DIFF = 11644473600000n;
const uuidv4 = () => crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); });
function uuidv7() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 255n);
  b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const dateRows = (d) => {
  const ms = d.getTime(), ft = BigInt(ms) * 10000n + EPOCH_DIFF * 10000n;
  const rel = (() => { const s = (Date.now() - ms) / 1000, a = Math.abs(s), u = a < 60 ? [s, "second"] : a < 3600 ? [s / 60, "minute"] : a < 86400 ? [s / 3600, "hour"] : a < 2592000 ? [s / 86400, "day"] : a < 31536000 ? [s / 2592000, "month"] : [s / 31536000, "year"];
    const n = Math.round(u[0]); return n === 0 ? "just now" : n > 0 ? `${n} ${u[1]}${Math.abs(n) === 1 ? "" : "s"} ago` : `in ${-n} ${u[1]}${Math.abs(n) === 1 ? "" : "s"}`; })();
  return [
    { k: "ISO 8601 (UTC)", v: d.toISOString(), tone: "color:#3ad6c8" },
    { k: "Local time", v: d.toLocaleString(undefined, { dateStyle: "full", timeStyle: "medium" }) },
    { k: "Relative", v: rel, tone: "color:#f2b544" },
    { k: "Unix seconds", v: String(Math.floor(ms / 1000)) },
    { k: "Unix milliseconds", v: String(ms) },
    { k: "Windows FILETIME", v: ft.toString() },
    { k: "FILETIME (hex)", v: "0x" + ft.toString(16).toUpperCase().padStart(16, "0") },
    { k: ".NET ticks", v: (BigInt(ms) * 10000n + 621355968000000000n).toString() },
    { k: "Excel serial", v: (ms / 86400000 + 25569).toFixed(6) },
    { k: "RFC 2822", v: d.toUTCString() },
    { k: "Day of year", v: String(Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000)) },
    { k: "Week (ISO)", v: (() => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7)).padStart(2, "0")}`; })() },
  ];
};

const UTIL_TOOLS = [
  { id: "base64", cat: "Encode & decode", name: "Base64", icon: "swap_horiz", tag: "RFC 4648", hint: "text ⇄ base64, URL-safe too",
    keywords: "base64 encode decode b64 url-safe rfc4648",
    desc: "Round-trips UTF-8 text through base64. URL-safe swaps +/ for -_ and drops padding.",
    modes: ["Encode", "Decode"], flags: [{ id: "url", label: "URL-safe" }],
    run: (i, m, f) => { if (!i) return { text: "" };
      if (m === "Encode") { let s = b64(bytes(i)); if (f.url) s = s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); return { text: s }; }
      return { text: utf8(f.url ? fromB64Url(i.trim()) : atob(b64pad(i.trim().replace(/\s+/g, "")))) }; } },
  { id: "url", cat: "Encode & decode", name: "URL encode / decode", icon: "link", tag: "percent", hint: "component or whole URL",
    keywords: "url encode decode percent uri component querystring",
    desc: "encodeURIComponent for values, encodeURI for whole URLs. Decoding shows the query broken apart.",
    modes: ["Encode", "Decode"], flags: [{ id: "whole", label: "Whole URL" }],
    run: (i, m, f) => { if (!i) return { text: "" };
      if (m === "Encode") return { text: f.whole ? encodeURI(i) : encodeURIComponent(i) };
      const dec = decodeURIComponent(i.replace(/\+/g, " "));
      try { const u = new URL(dec); const rows = [{ k: "Decoded", v: dec, tone: "color:#3ad6c8" }, { k: "Origin", v: u.origin }, { k: "Path", v: u.pathname }];
        u.searchParams.forEach((v, k) => rows.push({ k: "?" + k, v })); if (u.hash) rows.push({ k: "#hash", v: u.hash }); return { rows }; }
      catch (e) { return { text: dec }; } } },
  { id: "html", cat: "Encode & decode", name: "HTML entities", icon: "code_blocks", tag: "entities", hint: "escape and unescape < > &",
    keywords: "html entities escape unescape amp lt gt",
    desc: "Escapes the five XML-significant characters; the aggressive flag also numerics everything above ASCII.",
    modes: ["Encode", "Decode"], flags: [{ id: "all", label: "Non-ASCII too" }],
    run: (i, m, f) => ({ text: i ? (m === "Encode" ? htmlEnc(i, f.all) : htmlDec(i)) : "" }) },
  { id: "hex", cat: "Encode & decode", name: "Hex", icon: "tag", tag: "base 16", hint: "text ⇄ hex bytes",
    keywords: "hex hexadecimal bytes dump",
    desc: "UTF-8 bytes as hexadecimal. Grouping inserts a space every byte for the hexdump look.",
    modes: ["To hex", "From hex"], flags: [{ id: "space", label: "Spaced" }, { id: "upper", label: "Uppercase" }],
    run: (i, m, f) => { if (!i) return { text: "" };
      if (m === "To hex") { let s = hex(bytes(i), f.upper); return { text: f.space ? group(s, 2) : s }; }
      const clean = i.replace(/0x/gi, "").replace(/[\s,]/g, "");
      if (clean.length % 2) throw new Error("Odd number of hex digits — a byte is missing.");
      if (/[^0-9a-f]/i.test(clean)) throw new Error("Not hexadecimal: " + clean.match(/[^0-9a-f]/i)[0]);
      return { text: TD.decode(Uint8Array.from(clean.match(/../g) || [], (h) => parseInt(h, 16))) }; } },
  { id: "binary", cat: "Encode & decode", name: "Binary", icon: "memory", tag: "base 2", hint: "text ⇄ 01000100",
    keywords: "binary bits bytes 01",
    desc: "Eight bits per UTF-8 byte. Decoding tolerates any whitespace grouping.",
    modes: ["To binary", "From binary"], flags: [{ id: "space", label: "Spaced" }],
    run: (i, m, f) => { if (!i) return { text: "" };
      if (m === "To binary") {
        const arr = bytes(i);
        const parts = new Array(arr.length);
        for (let n = 0; n < arr.length; n++) parts[n] = arr[n].toString(2).padStart(8, "0");
        return { text: f.space ? parts.join(" ") : parts.join("") };
      }
      const clean = i.replace(/[^01]/g, "");
      if (clean.length % 8) throw new Error(`${clean.length} bits is not a whole number of bytes.`);
      return { text: TD.decode(Uint8Array.from(clean.match(/.{8}/g) || [], (b) => parseInt(b, 2))) }; } },

  { id: "sha256", cat: "Hash & sign", name: "SHA-256", icon: "fingerprint", tag: "WebCrypto", hint: "256-bit digest of the input",
    keywords: "sha256 sha-256 hash digest checksum webcrypto",
    desc: "Digest of the raw UTF-8 bytes, exactly what sha256sum would print for the same content.",
    modes: ["Hex", "Base64"], flags: [{ id: "upper", label: "Uppercase" }],
    run: async (i, m, f) => { const d = await digest("SHA-256", i); return { rows: [{ k: m === "Hex" ? "SHA-256" : "SHA-256 (b64)", v: m === "Hex" ? hex(d, f.upper) : b64(d), tone: "color:#3ad6c8" }, { k: "Length", v: `${i.length} chars · ${bytes(i).length} bytes in` }] }; } },
  { id: "sha512", cat: "Hash & sign", name: "SHA-512", icon: "fingerprint", tag: "WebCrypto", hint: "512-bit digest, plus SHA-384",
    keywords: "sha512 sha384 sha1 hash digest checksum",
    desc: "The wide SHA-2. SHA-384 is the same construction truncated, shown alongside for convenience.",
    modes: ["Hex", "Base64"], flags: [{ id: "upper", label: "Uppercase" }],
    run: async (i, m, f) => { const [a, b] = await Promise.all([digest("SHA-512", i), digest("SHA-384", i)]);
      const out = (d) => m === "Hex" ? hex(d, f.upper) : b64(d);
      return { rows: [{ k: "SHA-512", v: out(a), tone: "color:#3ad6c8" }, { k: "SHA-384", v: out(b) }, { k: "SHA-1 (legacy)", v: hex(await digest("SHA-1", i), f.upper), tone: "color:#f2b544" }] }; } },
  { id: "md5", cat: "Hash & sign", name: "MD5", icon: "fingerprint", tag: "broken, still needed", hint: "for checksums, never for secrets",
    keywords: "md5 hash checksum digest",
    desc: "Collision-broken since 2004 — fine for cache keys and file checksums, wrong for anything security-shaped.",
    modes: ["Hex", "Base64"], flags: [{ id: "upper", label: "Uppercase" }],
    run: (i, m, f) => { const h = md5(i);
      const v = m === "Hex" ? (f.upper ? h.toUpperCase() : h) : b64(Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16))));
      return { rows: [{ k: "MD5", v, tone: "color:#3ad6c8" }, { k: "Short (8)", v: h.slice(0, 8) }, { k: "Warning", v: "Do not use for passwords, signatures, or dedupe of untrusted files.", tone: "color:#f2b544" }] }; } },
  { id: "hmac", cat: "Hash & sign", name: "HMAC", icon: "key", tag: "keyed", hint: "sign a payload with a shared key",
    keywords: "hmac signature keyed hash webhook secret",
    desc: "Keyed hash over the input. Same construction webhooks use to prove a request came from the sender.",
    modes: ["SHA-256", "SHA-512", "SHA-1"], flags: [{ id: "upper", label: "Uppercase" }],
    keyField: "signing key",
    run: async (i, m, f, key) => { if (!key) return { error: "Enter a signing key in the field above." };
      const k = await crypto.subtle.importKey("raw", bytes(key), { name: "HMAC", hash: m }, false, ["sign"]);
      const sig = await crypto.subtle.sign("HMAC", k, bytes(i));
      return { rows: [{ k: `HMAC-${m}`, v: hex(sig, f.upper), tone: "color:#3ad6c8" }, { k: "Base64", v: b64(sig) }, { k: "Header form", v: `X-Signature: ${m.toLowerCase().replace("-", "")}=${hex(sig)}` }] }; } },

  { id: "jwt", cat: "Identity & tokens", name: "JWT decode", icon: "badge", tag: "RFC 7519", hint: "header, claims, expiry check",
    keywords: "jwt json web token decode claims header payload expiry",
    desc: "Splits and decodes the token, pretty-prints both JSON parts and resolves the time claims. No signature verification — that needs the key.",
    run: (i) => { const t = i.trim(); if (!t) return { blocks: [] };
      const p = t.split("."); if (p.length !== 3) throw new Error(`A JWT has 3 dot-separated parts — this has ${p.length}.`);
      let head, body;
      try { head = JSON.parse(utf8(fromB64Url(p[0]))); } catch (e) { throw new Error("Header is not valid base64url JSON."); }
      try { body = JSON.parse(utf8(fromB64Url(p[1]))); } catch (e) { throw new Error("Payload is not valid base64url JSON."); }
      const now = Date.now() / 1000;
      const when = (v) => new Date(v * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";
      const times = ["iat", "nbf", "exp", "auth_time"].filter(k => typeof body[k] === "number").map(k => `${k}  ${when(body[k])}`).join("\n");
      const expired = typeof body.exp === "number" && body.exp < now;
      return { blocks: [
        { title: "Header", note: `alg ${head.alg || "?"}`, text: JSON.stringify(head, null, 2), headStyle: "background:rgba(242,84,91,.12);color:#f2545b", bodyStyle: "color:#f2a3a7" },
        { title: "Payload", note: `${Object.keys(body).length} claims`, text: JSON.stringify(body, null, 2), headStyle: "background:rgba(180,139,255,.12);color:#b48bff", bodyStyle: "color:#d7c8ff" },
        { title: "Signature", note: `${p[2].length} chars · not verified`, text: p[2], headStyle: "background:rgba(58,214,200,.12);color:#3ad6c8", bodyStyle: "color:#8fd9d2" },
        { title: "Time claims", note: expired ? "EXPIRED" : "within validity", text: times || "no time claims", headStyle: expired ? "background:rgba(242,84,91,.14);color:#f2545b" : "background:rgba(63,202,127,.12);color:#3fca7f", bodyStyle: "color:#9aa1b4" },
      ] }; } },
  { id: "uuid", cat: "Identity & tokens", name: "UUID generator", icon: "casino", tag: "v4 / v7", hint: "fresh identifiers on demand",
    keywords: "uuid guid v4 v7 generate random",
    desc: "v4 is pure random. v7 puts a millisecond timestamp in the high bits so ids sort chronologically — much kinder to database indexes. Type how many you want in the input.",
    modes: ["v4", "v7", "Nil / Max"], placeholder: "how many — e.g. 100",
    action: { label: "Regenerate", icon: "refresh" }, flags: [{ id: "upper", label: "Uppercase" }],
    run: (i, m, f) => {
      if (m === "Nil / Max") return { rows: [{ k: "Nil UUID", v: "00000000-0000-0000-0000-000000000000" }, { k: "Max UUID", v: "ffffffff-ffff-ffff-ffff-ffffffffffff" }, { k: "Namespace DNS", v: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" }, { k: "Namespace URL", v: "6ba7b811-9dad-11d1-80b4-00c04fd430c8" }] };
      const raw = i.trim();
      let n = 1;
      if (raw) {
        if (!/^\d{1,5}$/.test(raw)) throw new Error("Type how many UUIDs to make — a whole number, up to 10000.");
        n = Number(raw);
        if (n < 1 || n > 10000) throw new Error("Ask for between 1 and 10000 UUIDs.");
      }
      const gen = m === "v7" ? uuidv7 : uuidv4;
      const list = Array.from({ length: n }, () => {
        const u = gen();
        return f.upper ? u.toUpperCase() : u;
      });
      return { text: list.join("\n") };
    } },
  { id: "guid", cat: "Identity & tokens", name: "GUID formats", icon: "transform", tag: "every dialect", hint: "braces, C#, byte array, base64",
    keywords: "guid uuid formats csharp sql braced urn",
    desc: "One UUID, spelled the eleven different ways Windows, .NET, SQL Server and the web each insist on.",
    run: (i) => { const s = i.trim().replace(/^urn:uuid:/i, "").replace(/[{}()]/g, "").replace(/-/g, "");
      if (!i.trim()) return { rows: [] };
      if (!/^[0-9a-f]{32}$/i.test(s)) throw new Error("Need 32 hex digits — got " + s.length + ".");
      const l = s.toLowerCase(), d = `${l.slice(0, 8)}-${l.slice(8, 12)}-${l.slice(12, 16)}-${l.slice(16, 20)}-${l.slice(20)}`;
      const by = l.match(/../g).map(h => parseInt(h, 16));
      const le = [by[3], by[2], by[1], by[0], by[5], by[4], by[7], by[6], ...by.slice(8)];
      const ver = parseInt(l[12], 16);
      return { rows: [
        { k: "Canonical", v: d, tone: "color:#3ad6c8" },
        { k: "Uppercase", v: d.toUpperCase() },
        { k: "Registry / braced", v: `{${d.toUpperCase()}}` },
        { k: "No hyphens", v: l },
        { k: "URN", v: "urn:uuid:" + d },
        { k: "C# literal", v: `new Guid("${d}")` },
        { k: "C# byte[] (LE)", v: "{ " + le.map(b => "0x" + b.toString(16).padStart(2, "0").toUpperCase()).join(", ") + " }" },
        { k: "SQL Server", v: `CAST('${d.toUpperCase()}' AS uniqueidentifier)` },
        { k: "Base64", v: b64(by) },
        { k: "Base64 (LE bytes)", v: b64(le) },
        { k: "Version", v: `v${ver}${ver === 4 ? " — random" : ver === 7 ? " — time-ordered" : ver === 1 ? " — time + MAC" : ""}`, tone: "color:#f2b544" },
        ...(ver === 7 ? [{ k: "Embedded time", v: new Date(parseInt(l.slice(0, 12), 16)).toISOString(), tone: "color:#b48bff" }] : []),
      ] }; } },

  { id: "unix", cat: "Time", name: "Unix timestamp", icon: "schedule", tag: "epoch", hint: "seconds, millis or a date string",
    keywords: "unix timestamp epoch seconds millis date time",
    desc: "Paste a number in any epoch unit or a human date; every other representation falls out. Empty means now.",
    action: { label: "Now", icon: "bolt" },
    run: (i) => { const t = i.trim(); let d;
      if (!t) d = new Date();
      else if (/^-?\d{1,19}$/.test(t)) { const n = Number(t); d = new Date(t.length <= 11 ? n * 1000 : t.length <= 14 ? n : t.length <= 17 ? n / 1000 : n / 1e6); }
      else { d = new Date(t); }
      if (isNaN(d.getTime())) throw new Error(`"${t}" is not a timestamp or a date this machine understands.`);
      const unit = !t ? "now" : /^-?\d{1,11}$/.test(t) ? "read as seconds" : /^-?\d{12,14}$/.test(t) ? "read as milliseconds" : /^-?\d+$/.test(t) ? "read as microseconds" : "parsed as a date string";
      return { rows: [{ k: "Interpreted", v: unit, tone: "color:#6b7285" }, ...dateRows(d)] }; } },
  { id: "filetime", cat: "Time", name: "Windows FILETIME", icon: "hourglass", tag: "1601 epoch", hint: "100ns ticks since 1601-01-01",
    keywords: "windows filetime ticks 1601 epoch ntfs",
    desc: "The unit every Win32 API and event log speaks: 100-nanosecond intervals since 1 January 1601 UTC. Decimal or 0x hex both work.",
    run: (i) => { const t = i.trim().replace(/[\s,]/g, ""); if (!t) return { rows: dateRows(new Date()) };
      let ticks;
      if (/^0x[0-9a-f]+$/i.test(t)) ticks = BigInt(t);
      else if (/^\d+$/.test(t)) ticks = BigInt(t);
      else { const d = new Date(t); if (isNaN(d.getTime())) throw new Error("Give me a FILETIME number, 0x hex, or a date to convert into one."); ticks = BigInt(d.getTime()) * 10000n + EPOCH_DIFF * 10000n; }
      const ms = Number(ticks / 10000n - EPOCH_DIFF);
      const d = new Date(ms);
      if (isNaN(d.getTime())) throw new Error("That tick count lands outside representable time.");
      const hi = ticks >> 32n, lo = ticks & 0xffffffffn;
      return { rows: [{ k: "FILETIME", v: ticks.toString(), tone: "color:#3ad6c8" }, { k: "dwHighDateTime", v: `0x${hi.toString(16).toUpperCase().padStart(8, "0")}  (${hi})` }, { k: "dwLowDateTime", v: `0x${lo.toString(16).toUpperCase().padStart(8, "0")}  (${lo})` }, ...dateRows(d)] }; } },

  { id: "json", cat: "Data formats", name: "JSON", icon: "data_object", tag: "parse & shape", hint: "format, minify, sort, typify",
    keywords: "json format minify pretty typescript type sort keys repair",
    desc: "Strict parse with a readable error position, then reprint it however you need — including as a TypeScript type.",
    modes: ["Format", "Minify", "Sort keys", "→ TS type"], flags: [{ id: "tabs", label: "Tabs" }],
    run: (i, m, f) => { if (!i.trim()) return { text: "" };
      let v, repaired = null;
      try { v = JSON.parse(i); } catch (e) {
        const r = repairJson(i);
        if (r.error) { const p = /position (\d+)/.exec(e.message); const at = p ? Number(p[1]) : -1;
          throw new Error(`${e.message}${at >= 0 ? `\n\n…${i.slice(Math.max(0, at - 30), at)}⟪here⟫${i.slice(at, at + 30)}…` : ""}\n\nI tried to repair it (${r.fixes.join("; ") || "nothing obvious to fix"}) and it still would not parse: ${r.error}`); }
        v = r.value; repaired = r.fixes;
      }
      const ind = f.tabs ? "\t" : 2;
      if (repaired) {
        const body = m === "Minify" ? JSON.stringify(v) : m === "→ TS type" ? tsType(v, "Root") : JSON.stringify(v, null, ind);
        return { blocks: [
          { title: "Repaired", note: `${repaired.length} fix${repaired.length === 1 ? "" : "es"}`, text: repaired.map(x => "· " + x).join("\n") || "· reparsed leniently", headStyle: "background:rgba(242,181,68,.14);color:#f2b544", bodyStyle: "color:#e8d3a8" },
          { title: m === "Format" ? "Valid JSON" : m, note: "now parses cleanly", text: body, headStyle: "background:rgba(63,202,127,.12);color:#3fca7f", bodyStyle: "color:#e8eaf0" },
        ] };
      }
      if (m === "Minify") return { text: JSON.stringify(v) };
      if (m === "→ TS type") return { text: tsType(v, "Root") };
      if (m === "Sort keys") { const sort = (x) => Array.isArray(x) ? x.map(sort) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sort(x[k])])) : x; return { text: JSON.stringify(sort(v), null, ind) }; }
      return { text: JSON.stringify(v, null, ind) }; } },
  { id: "xml", cat: "Data formats", name: "XML ⇄ JSON", icon: "code", tag: "DOM parse", hint: "attributes become @keys",
    keywords: "xml json convert attributes",
    desc: "Attributes map to @-prefixed keys, repeated elements collapse into arrays, text nodes become #text when they share space with children.",
    modes: ["XML → JSON", "JSON → XML"],
    run: (i, m) => { if (!i.trim()) return { text: "" };
      if (m === "XML → JSON") { const doc = new DOMParser().parseFromString(i, "application/xml");
        const err = doc.querySelector("parsererror"); if (err) throw new Error(err.textContent.replace(/\s+/g, " ").trim().slice(0, 220));
        return { text: JSON.stringify({ [doc.documentElement.tagName]: xmlToObj(doc.documentElement) }, null, 2) }; }
      const v = JSON.parse(i); const ks = Object.keys(v);
      const root = ks.length === 1 ? ks[0] : "root", body = ks.length === 1 ? v[ks[0]] : v;
      return { text: '<?xml version="1.0" encoding="UTF-8"?>\n' + objToXml(body, root, 0) }; } },
  { id: "yaml", cat: "Data formats", name: "YAML ⇄ JSON", icon: "list_alt", tag: "common subset", hint: "for the docker-compose moments",
    keywords: "yaml yml json docker compose kubernetes",
    desc: "Maps, sequences and scalars — enough for compose files, CI configs and k8s manifests. Anchors and multi-doc streams are not handled.",
    modes: ["YAML → JSON", "JSON → YAML"],
    run: (i, m) => { if (!i.trim()) return { text: "" };
      if (m === "YAML → JSON") return { text: JSON.stringify(fromYaml(i), null, 2) };
      return { text: toYaml(JSON.parse(i), 0).replace(/^\n/, "") }; } },
  { id: "markup", cat: "Data formats", name: "HTML repair", icon: "healing", tag: "tolerant", hint: "fixes the tag soup, then tidies it",
    keywords: "html repair tidy minify fix tags soup",
    desc: "Broken markup is the normal case. This parses it the way a browser would — closing what you left open, re-nesting what you got wrong — and prints back something well-formed.",
    modes: ["Tidy & fix", "Minify", "→ JSON"],
    run: (i, m) => { if (!i.trim()) return { text: "" };
      const r = tidyMarkup(i);
      if (m === "→ JSON") { const doc = new DOMParser().parseFromString(r.text, "text/html");
        return { text: JSON.stringify([...doc.body.children].map(el => xmlToObj(el)), null, 2) }; }
      const body = m === "Minify" ? r.text.replace(/>\s+</g, "><").replace(/\n\s*/g, " ").trim() : r.text;
      return { blocks: [
        { title: r.issues.length ? "Repaired" : "Already well-formed", note: `${r.nodes} elements`, text: r.issues.length ? r.issues.map(x => "· " + x).join("\n") : "· nothing needed fixing", headStyle: r.issues.length ? "background:rgba(242,181,68,.14);color:#f2b544" : "background:rgba(63,202,127,.12);color:#3fca7f", bodyStyle: "color:#e8d3a8" },
        { title: m === "Minify" ? "Minified" : "Well-formed", note: "browser-equivalent parse", text: body, headStyle: "background:rgba(109,139,255,.14);color:#6d8bff", bodyStyle: "color:#e8eaf0" },
      ] }; } },
  { id: "csv", cat: "Data formats", name: "CSV ⇄ JSON", icon: "table", tag: "RFC 4180", hint: "quoted fields handled properly",
    keywords: "csv tsv table json spreadsheet",
    desc: "Quoted commas, escaped quotes and embedded newlines all survive. Row-objects out, header union in.",
    modes: ["CSV → JSON", "JSON → CSV", "CSV → table"], flags: [{ id: "raw", label: "No header row" }],
    run: (i, m, f) => { if (!i.trim()) return { text: "" };
      if (m === "JSON → CSV") { const v = JSON.parse(i); const arr = Array.isArray(v) ? v : [v];
        const cols = [...new Set(arr.flatMap(r => Object.keys(r || {})))];
        return { text: [cols.join(","), ...arr.map(r => cols.map(c => csvCell(r ? r[c] : "")).join(","))].join("\n") }; }
      const rows = parseCsv(i.trim()); if (!rows.length) throw new Error("No rows found.");
      if (m === "CSV → table") return { rows: (f.raw ? rows : rows.slice(1)).map((r, n) => ({ k: f.raw ? `row ${n + 1}` : `${rows[0][0]} ${r[0]}`, v: r.join("  │  ") })) };
      if (f.raw) return { text: JSON.stringify(rows, null, 2) };
      const head = rows[0];
      return { text: JSON.stringify(rows.slice(1).map(r => Object.fromEntries(head.map((h, n) => [h, scalar(r[n] ?? "")]))), null, 2) }; } },
];

UTIL_TOOLS.unshift({
  id: "any", cat: "Start here", name: "Anything", icon: "content_paste_search", tag: "paste and see", hint: "paste it, I work out what it is",
    keywords: "anything paste detect sniff identify auto jwt guid timestamp json html xml base64",
  desc: "The catch-all. Drop in whatever you found in a log, a header or a database column — this works out what it is and runs the right tool on it.",
  run: async (i) => {
    const t = (i || "").trim();
    if (!t) return { rows: [
      { k: "Paste a…", v: "and this happens", tone: "color:#6b7285" },
      { k: "JWT", v: "header, claims and expiry, split apart", tone: "color:#b48bff" },
      { k: "GUID", v: "every dialect — braced, C#, byte array, base64", tone: "color:#b48bff" },
      { k: "10-digit number", v: "read as a Unix timestamp", tone: "color:#b48bff" },
      { k: "18-digit number", v: "read as a Windows FILETIME", tone: "color:#b48bff" },
      { k: "{ … } or [ … ]", v: "parsed — and repaired first if it is broken", tone: "color:#b48bff" },
      { k: "Half-broken HTML", v: "unclosed tags closed, mis-nesting fixed, tidied", tone: "color:#b48bff" },
      { k: "<xml …>", v: "converted to JSON", tone: "color:#b48bff" },
      { k: "base64-ish blob", v: "decoded back to text", tone: "color:#b48bff" },
      { k: "ones and zeroes", v: "decoded back to text", tone: "color:#b48bff" },
    ] };
    const hit = sniff(t);
    if (!hit) return { rows: [
      { k: "Verdict", v: "No format recognised — treating it as plain text.", tone: "color:#f2b544" },
      { k: "Length", v: `${t.length} chars · ${bytes(t).length} bytes` },
      { k: "SHA-256", v: hex(await digest("SHA-256", t)) },
      { k: "MD5", v: md5(t) },
      { k: "Base64", v: b64(bytes(t)) },
      { k: "Hex", v: hex(bytes(t)) },
    ] };
    const target = UTIL_TOOLS.find(x => x.id === hit[0]);
    const res = await target.run(t, target.modes ? target.modes[target.id === "base64" ? 1 : 0] : "", {}, "");
    if (res && res.text !== undefined) return { blocks: [{ title: `Read as ${target.name}`, note: hit[2], text: res.text || "(empty)", headStyle: "background:rgba(180,139,255,.12);color:#b48bff", bodyStyle: "color:#e8eaf0" }] };
    return res;
  },
});

function sniff(text) {
  const t = (text || "").trim();
  if (!t) return null;
  if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(t) && t.length > 40) return ["jwt", "That is a JWT — three base64url segments.", "Decode it"];
  if (/^[\{\[]/.test(t) || /^[\w"']+\s*:\s*[\{\["\d]/.test(t)) {
    try { JSON.parse(t); return ["json", "Valid JSON — format, sort or turn it into a TypeScript type.", "Open JSON"]; }
    catch (e) { const r = repairJson(t); return r.error ? ["json", "JSON-shaped but badly broken — I will show you exactly where.", "Show me why"] : ["json", `Broken JSON — ${r.fixes.length} thing${r.fixes.length === 1 ? "" : "s"} I can fix automatically.`, "Repair it"]; } }
  if (/^<\?xml/i.test(t) || /^<[a-z][\w:-]*[\s\/>]/i.test(t)) {
    const doc = new DOMParser().parseFromString(t, "application/xml");
    if (!doc.querySelector("parsererror")) return ["xml", "Well-formed XML — convert it to JSON?", "Convert"];
    return ["markup", "Markup, but not well-formed — unclosed or mis-nested tags. I can repair it.", "Fix it"];
  }
  if (/<\/?[a-z][\w-]*[\s>]/i.test(t) && (t.match(/</g) || []).length > 1) return ["markup", "There is HTML in here, and it needs tidying.", "Fix it"];
  if (/^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i.test(t)) return ["guid", "A GUID — see it in every dialect.", "Expand"];
  if (/^\d{16,18}$/.test(t)) return ["filetime", "18-ish digits — that is a Windows FILETIME.", "Convert"];
  if (/^\d{9,13}$/.test(t)) return ["unix", "That number is a Unix timestamp.", "Convert"];
  if (/^[A-Za-z0-9+/]{16,}={0,2}$/.test(t)) return ["base64", "Reads like base64 — decode it?", "Decode"];
  if (/^[01\s]{16,}$/.test(t)) return ["binary", "Nothing but ones and zeroes.", "Decode"];
  return null;
}


/* ------------------------------------------------------------ host state */

const util = {
  toolId: "any",
  inputs: Object.create(null),
  modes: Object.create(null),
  flags: Object.create(null),
  keys: Object.create(null),
  seed: 0,
  result: { text: "" },
  token: 0,
  chromeDirty: true,
  host: null,
  built: false,
};

function utilIcon(name) {
  return window.devhqShell?.icon(name) ?? `<span class="ms" aria-hidden="true">${name}</span>`;
}

function utilEsc(value) {
  return window.devhqShell?.esc(value) ?? String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function utilDirty() {
  window.devhqShell?.markDirty("tools");
}

function utilById(id) {
  return UTIL_TOOLS.find((tool) => tool.id === id) || null;
}

function utilCur() {
  return utilById(util.toolId) || UTIL_TOOLS[0];
}

function utilMode(tool) {
  return util.modes[tool.id] || (tool.modes ? tool.modes[0] : "");
}

function utilFlags(tool) {
  return util.flags[tool.id] || {};
}

function utilInput(tool) {
  return util.inputs[tool.id] ?? "";
}

function utilOutString(res) {
  if (!res) return "";
  if (res.text !== undefined) return res.text;
  if (res.rows) return res.rows.map((r) => `${r.k}: ${r.v}`).join("\n");
  if (res.blocks) return res.blocks.map((b) => `# ${b.title}\n${b.text}`).join("\n\n");
  return "";
}

/** Past this, painting the output into the DOM locks the window. Offer a file
 *  download instead of trying to show it. */
const OUTPUT_SHOW_MAX = 1_000_000;

function formatCharCount(n) {
  return n.toLocaleString() + " chars";
}

async function downloadOutputFile(text, tool) {
  const defaultName = `devhq-${tool?.id || "output"}.txt`;
  window.devhqWork?.beginWork("tools-save", "Saving output…");
  try {
    const path = await util_invoke("save_text_file", { text, defaultName });
    if (!path) {
      window.devhqWork?.endWork("tools-save");
      return;
    }
    const base = String(path).split(/[\\/]/).pop() || defaultName;
    window.devhqWork?.beginWork("tools-save", `Saved ${base}`);
    setTimeout(() => window.devhqWork?.endWork("tools-save"), 2000);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err || "Could not save");
    window.devhqWork?.beginWork("tools-save", msg);
    setTimeout(() => window.devhqWork?.endWork("tools-save"), 2400);
  }
}

function renderHeavyOutput(box, stats, out, tool) {
  stats.textContent = `${formatCharCount(out.length)} · too large to show`;
  box.innerHTML = `<div class="tools-heavy">
    <span class="ms" aria-hidden="true">draft</span>
    <div class="tools-heavy-copy">
      <strong>${utilEsc(formatCharCount(out.length))} of output</strong>
      <span>Too large to show in the window without locking it up. Download it as a text file instead.</span>
    </div>
    <button type="button" class="btn primary" data-tools="download">${utilIcon("download")}Download .txt</button>
  </div>`;
}

/* ------------------------------------------------------------ compute */

async function utilCompute() {
  const tool = utilCur();
  const token = ++util.token;
  let res;
  try {
    res = await tool.run(
      utilInput(tool),
      utilMode(tool),
      utilFlags(tool),
      util.keys[tool.id] || "",
      util.seed
    );
  } catch (err) {
    res = { error: err && err.message ? err.message : String(err) };
  }
  if (token !== util.token) return;
  util.result = res || { text: "" };
  utilDirty();
}

function utilSetInput(value, { recompute = true } = {}) {
  util.inputs[util.toolId] = value;
  const area = util.host?.querySelector("#tools-input");
  if (area && area.value !== value) area.value = value;
  if (recompute) utilCompute();
  else utilDirty();
}

/* ------------------------------------------------------------ mount */

function mount(host) {
  if (!host || util.built) return;
  util.host = host;
  host.classList.add("tools-page");
  host.innerHTML = `
    <header class="tool-head">
      <button class="btn back tool-back" type="button" data-open-tool="overview"
              title="Back to the overview">${utilIcon("arrow_back")}Back</button>
      <span class="tool-plate" id="tools-plate">${utilIcon("content_paste_search")}</span>
      <span class="tool-title">
        <strong id="tools-name">Anything</strong>
        <small id="tools-hint">paste it, I work out what it is</small>
      </span>
      <span class="tools-tag mono" id="tools-tag"></span>
      <span id="tools-maturity"></span>
      <button class="tool-popout" id="tool-popout-util" type="button" data-popout-tool="any"></button>
      <button class="tool-pin" id="tool-pin-util" type="button" data-pin-tool="any"></button>
      <button class="tool-close" type="button" data-open-tool="overview"
              title="Back to the overview">${utilIcon("close")}</button>
    </header>

    <div class="tools-toolbar">
      <div class="seg tools-modes" id="tools-modes" hidden></div>
      <div class="tools-flags" id="tools-flags"></div>
      <label class="tools-key" id="tools-key-wrap" hidden>${utilIcon("key")}
        <input id="tools-key" class="mono" spellcheck="false" autocomplete="off" placeholder="signing key" />
      </label>
      <i></i>
      <button class="btn primary tools-action" id="tools-action" type="button" data-tools="action" hidden></button>
    </div>

    <div class="tools-body">
      <section class="tools-panel tools-input-panel" id="tools-input-panel">
        <div class="tools-panel-head">
          <span class="tools-label">Input</span>
          <span class="mono tools-stats" id="tools-input-stats"></span>
          <i></i>
          <button class="tools-mini" type="button" data-tools="paste"
                  title="Paste from clipboard">${utilIcon("content_paste")}Paste</button>
          <button class="tools-mini" type="button" data-tools="clear"
                  title="Clear the input">${utilIcon("backspace")}Clear</button>
        </div>
        <textarea id="tools-input" class="mono" spellcheck="false"
                  placeholder="paste here"></textarea>
      </section>

      <div class="tools-hint-bar" id="tools-hint-bar" hidden></div>

      <section class="tools-panel tools-output-panel">
        <div class="tools-panel-head">
          <span class="tools-label">Output</span>
          <span class="mono tools-stats" id="tools-out-stats"></span>
          <i></i>
          <button class="tools-mini" type="button" data-tools="swap"
                  title="Send the output back into the input">${utilIcon("swap_vert")}Send to input</button>
          <button class="tools-mini" type="button" data-tools="copy"
                  title="Copy the output">${utilIcon("content_copy")}Copy</button>
        </div>
        <div class="tools-output" id="tools-output"></div>
      </section>
    </div>
  `;

  util.built = true;
  wire();
}

function wire() {
  const area = util.host.querySelector("#tools-input");
  area.oninput = () => {
    util.inputs[util.toolId] = area.value;
    utilCompute();
  };

  util.host.onclick = (event) => {
    const pop = event.target.closest("[data-popout-tool]");
    if (pop) return window.devhqShell?.popOutTool?.(pop.dataset.popoutTool);
    const pin = event.target.closest("[data-pin-tool]");
    if (pin) return window.devhqShell?.toggleToolPin(pin.dataset.pinTool);
    const go = event.target.closest("[data-open-tool]");
    if (go) return window.devhqShell?.openTool(go.dataset.openTool);

    const act = event.target.closest("[data-tools]");
    if (act) return action(act.dataset.tools, act);

    const copyRow = event.target.closest("[data-tools-copy-row]");
    if (copyRow) return copyPiece(util.result?.rows?.[Number(copyRow.dataset.toolsCopyRow)]?.v, copyRow);
    const copyBlock = event.target.closest("[data-tools-copy-block]");
    if (copyBlock) return copyPiece(util.result?.blocks?.[Number(copyBlock.dataset.toolsCopyBlock)]?.text, copyBlock);

    const mode = event.target.closest("[data-tools-mode]");
    if (mode) {
      util.modes[util.toolId] = mode.dataset.toolsMode;
      util.chromeDirty = true;
      utilCompute();
      return;
    }
    const flag = event.target.closest("[data-tools-flag]");
    if (flag) {
      const flags = { ...utilFlags(utilCur()) };
      flags[flag.dataset.toolsFlag] = !flags[flag.dataset.toolsFlag];
      util.flags[util.toolId] = flags;
      util.chromeDirty = true;
      utilCompute();
    }
  };

  const key = util.host.querySelector("#tools-key");
  key.oninput = () => {
    util.keys[util.toolId] = key.value;
    utilCompute();
  };
}

async function copyPiece(text, button) {
  if (text === undefined || text === null || text === "") return;
  try {
    await window.devhqCopy.copy(String(text), button);
  } catch {
    window.devhqWork?.beginWork("tools-copy", "Could not copy");
    setTimeout(() => window.devhqWork?.endWork("tools-copy"), 1600);
  }
}

async function action(name) {
  const tool = utilCur();
  if (name === "paste") {
    try {
      utilSetInput(await navigator.clipboard.readText());
    } catch {
      window.devhqWork?.beginWork("tools-paste", "Clipboard is not readable");
      setTimeout(() => window.devhqWork?.endWork("tools-paste"), 1600);
    }
    return;
  }
  if (name === "clear") {
    utilSetInput("");
    return;
  }
  if (name === "copy") {
    const out = utilOutString(util.result);
    if (!out || util.result.error) return;
    if (out.length > OUTPUT_SHOW_MAX) return downloadOutputFile(out, tool);
    return copyPiece(out);
  }
  if (name === "download") {
    const out = utilOutString(util.result);
    if (!out || util.result.error) return;
    return downloadOutputFile(out, tool);
  }
  if (name === "swap") {
    const out = utilOutString(util.result);
    if (!out || util.result.error) return;
    if (out.length > OUTPUT_SHOW_MAX) return;
    utilSetInput(out);
    return;
  }
  if (name === "action") {
    if (tool.id === "unix") utilSetInput("");
    else {
      util.seed += 1;
      utilCompute();
    }
    return;
  }
  if (name === "sniff-go") {
    const hit = sniff(utilInput(tool));
    if (!hit) return;
    const target = hit[0];
    util.inputs[target] = utilInput(tool);
    window.devhqShell?.openTool?.(target);
  }
}

/* ------------------------------------------------------------ open / render */

function open(id, input) {
  const tool = utilById(id);
  if (!tool) return;
  if (typeof input === "string" && input) util.inputs[id] = input;
  util.toolId = id;
  const area = util.host?.querySelector("#tools-input");
  if (area) {
    const next = utilInput(tool);
    if (area.value !== next) area.value = next;
  }
  util.chromeDirty = true;
  utilCompute();
  utilDirty();
}

function opened() {
  open(util.toolId || "any");
  const area = util.host?.querySelector("#tools-input");
  if (area && !utilCur().noInput) {
    requestAnimationFrame(() => {
      area.focus();
      area.select();
    });
  }
}

function renderToolbar(tool) {
  const mode = utilMode(tool);
  const flags = utilFlags(tool);
  const modesEl = util.host.querySelector("#tools-modes");
  const flagsEl = util.host.querySelector("#tools-flags");
  const keyWrap = util.host.querySelector("#tools-key-wrap");
  const key = util.host.querySelector("#tools-key");
  const actionBtn = util.host.querySelector("#tools-action");

  if (tool.modes?.length) {
    modesEl.hidden = false;
    modesEl.innerHTML = tool.modes
      .map((label) => `<button type="button" class="${mode === label ? "on" : ""}" data-tools-mode="${utilEsc(label)}">${utilEsc(label)}</button>`)
      .join("");
  } else {
    modesEl.hidden = true;
    modesEl.innerHTML = "";
  }

  flagsEl.innerHTML = (tool.flags || [])
    .map((f) => `<button type="button" class="tools-flag${flags[f.id] ? " on" : ""}" data-tools-flag="${utilEsc(f.id)}">${utilIcon(flags[f.id] ? "check_box" : "check_box_outline_blank")}${utilEsc(f.label)}</button>`)
    .join("");

  if (tool.keyField) {
    keyWrap.hidden = false;
    key.placeholder = tool.keyField;
    if (document.activeElement !== key) key.value = util.keys[tool.id] || "";
  } else {
    keyWrap.hidden = true;
  }

  if (tool.action) {
    actionBtn.hidden = false;
    actionBtn.innerHTML = `${utilIcon(tool.action.icon)}${utilEsc(tool.action.label)}`;
  } else {
    actionBtn.hidden = true;
  }
}

function renderHint(tool) {
  const bar = util.host.querySelector("#tools-hint-bar");
  // Detection is Anything's job only — other tools already know what they are.
  if (tool.id !== "any") {
    bar.hidden = true;
    bar.innerHTML = "";
    return;
  }
  const input = utilInput(tool).trim();
  const hit = input ? sniff(input) : null;
  if (!hit) {
    bar.hidden = true;
    bar.innerHTML = "";
    return;
  }
  const target = utilById(hit[0]);
  bar.hidden = false;
  bar.className = "tools-hint-bar suggest";
  bar.innerHTML = `${utilIcon("neurology")}<span class="tools-hint-label">Detected</span><span class="tools-hint-text">${utilEsc(hit[1])}</span><i></i><button type="button" class="tools-hint-go" data-tools="sniff-go">${utilIcon("arrow_forward")}${utilEsc(`Open ${target?.name || hit[0]}`)}</button>`;
}

function renderOutput(tool) {
  const box = util.host.querySelector("#tools-output");
  const stats = util.host.querySelector("#tools-out-stats");
  const panel = util.host.querySelector(".tools-output-panel");
  const swap = util.host.querySelector("[data-tools=\"swap\"]");
  const copy = util.host.querySelector("[data-tools=\"copy\"]");
  const res = util.result || {};
  const out = utilOutString(res);
  const heavy = !res.error && out.length > OUTPUT_SHOW_MAX;
  panel.classList.toggle("is-error", !!res.error);
  if (swap) {
    swap.hidden = heavy;
    swap.disabled = heavy || !out || !!res.error;
  }
  if (copy) {
    copy.title = heavy ? "Download as a text file" : "Copy the output";
    copy.innerHTML = heavy
      ? `${utilIcon("download")}Download`
      : `${utilIcon("content_copy")}Copy`;
  }
  if (res.error) {
    stats.textContent = "failed";
    box.innerHTML = `<div class="tools-error">${utilIcon("error")}<span class="mono">${utilEsc(res.error)}</span></div>`;
    return;
  }
  if (heavy) {
    renderHeavyOutput(box, stats, out, tool);
    return;
  }
  if (res.rows) {
    stats.textContent = `${res.rows.length} row${res.rows.length === 1 ? "" : "s"}`;
    box.innerHTML = res.rows.map((r, index) => `
      <div class="tools-row">
        <div class="tools-row-k">${utilEsc(r.k)}</div>
        <div class="tools-row-v">
          <span class="mono tools-row-text"${r.tone ? ` style="${utilEsc(r.tone)}"` : ""}>${utilEsc(r.v)}</span>
          <button type="button" class="tools-cell-copy" data-tools-copy-row="${index}"
                  title="Copy ${utilEsc(r.k)}">${utilIcon("content_copy")}</button>
        </div>
      </div>`).join("") || `<div class="tools-empty">Nothing to show yet.</div>`;
    return;
  }
  if (res.blocks) {
    stats.textContent = `${res.blocks.length} part${res.blocks.length === 1 ? "" : "s"}`;
    box.innerHTML = res.blocks.map((b, index) => `
      <div class="tools-block">
        <div class="tools-block-head"${b.headStyle ? ` style="${utilEsc(b.headStyle)}"` : ""}>
          <span>${utilEsc(b.title)}</span>
          <span class="mono">${utilEsc(b.note || "")}</span>
          <button type="button" class="tools-cell-copy" data-tools-copy-block="${index}"
                  title="Copy ${utilEsc(b.title)}">${utilIcon("content_copy")}</button>
        </div>
        <pre class="mono tools-block-body"${b.bodyStyle ? ` style="${utilEsc(b.bodyStyle)}"` : ""}>${utilEsc(b.text || "")}</pre>
      </div>`).join("") || `<div class="tools-empty">Nothing to show yet.</div>`;
    return;
  }
  stats.textContent = out ? formatCharCount(out.length) : "empty";
  box.innerHTML = out
    ? `<pre class="mono tools-text">${utilEsc(out)}</pre>`
    : `<div class="tools-empty">Paste something above.</div>`;
}

function render() {
  if (!util.built || !util.host) return;
  const tool = utilCur();
  const plate = util.host.querySelector("#tools-plate");
  plate.innerHTML = utilIcon(tool.icon);
  util.host.querySelector("#tools-name").textContent = tool.name;
  util.host.querySelector("#tools-hint").textContent = tool.hint;
  util.host.querySelector("#tools-tag").textContent = tool.tag || "";
  // Every util tool shares this one header, so the badge is restamped with the
  // name rather than being part of the markup that is built once.
  const maturity = util.host.querySelector("#tools-maturity");
  if (maturity) maturity.innerHTML = window.devhqMaturity?.badge(tool.id) ?? "";
  const pin = util.host.querySelector("#tool-pin-util");
  pin.dataset.pinTool = tool.id;
  const pop = util.host.querySelector("#tool-popout-util");
  if (pop) pop.dataset.popoutTool = tool.id;

  const inputPanel = util.host.querySelector("#tools-input-panel");
  inputPanel.hidden = !!tool.noInput;
  const area = util.host.querySelector("#tools-input");
  if (!tool.noInput) {
    area.placeholder = tool.placeholder || "paste here";
    const value = utilInput(tool);
    if (document.activeElement !== area && area.value !== value) area.value = value;
    const bytesIn = bytes(value).length;
    util.host.querySelector("#tools-input-stats").textContent =
      `${value.length} chars · ${bytesIn} bytes`;
  }

  if (util.chromeDirty) {
    renderToolbar(tool);
    util.chromeDirty = false;
  }
  renderHint(tool);
  renderOutput(tool);
}

/** Catalog metadata the shell turns into TOOLS / pin entries. */
function catalog() {
  return UTIL_TOOLS.map((tool) => ({
    id: tool.id,
    name: tool.name,
    icon: tool.icon,
    hint: tool.hint,
    keywords: tool.keywords || `${tool.tag || ""} ${tool.cat || ""}`,
  }));
}

window.devhqUtilTools = {
  mount,
  render,
  opened,
  open,
  catalog,
  byId: utilById,
  setInput(id, input) { if (utilById(id) && typeof input === "string") { util.inputs[id] = input; if (util.toolId === id) open(id); } },
  exportState() { return { toolId:util.toolId, inputs:util.inputs, modes:util.modes, flags:util.flags, keys:util.keys, seed:util.seed, result:util.result, chromeDirty:util.chromeDirty }; },
  importState(state) { if(!state)return;Object.assign(util,state,{host:util.host,built:util.built,token:util.token+1});if(util.host)render(); },
};


})();
