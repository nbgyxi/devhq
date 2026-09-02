/** Lightweight smoke for util-tools catalog (no DOM / WebCrypto-only paths). */
const fs = require("fs");
const vm = require("vm");
const src = fs.readFileSync("src/util-tools.js", "utf8");

const sandbox = {
  console,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  BigInt,
  Number,
  String,
  Array,
  Object,
  Math,
  Date,
  JSON,
  RegExp,
  Error,
  Set,
  Map,
  Promise,
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  crypto: {
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    getRandomValues: (arr) => {
      for (let i = 0; i < arr.length; i++) arr[i] = (i * 17 + 3) & 255;
      return arr;
    },
    subtle: {
      digest: async () => new Uint8Array(32).fill(7).buffer,
      importKey: async () => ({}),
      sign: async () => new Uint8Array(32).fill(9).buffer,
    },
  },
  document: {
    createElement: () => {
      const el = { value: "", get innerHTML() { return this._h || ""; }, set innerHTML(v) { this._h = v; this.value = v.replace(/<[^>]+>/g, ""); } };
      return el;
    },
  },
  DOMParser: class {
    parseFromString(src, type) {
      if (type === "application/xml" && /parsererror|<<<|bad/.test(src)) {
        return { querySelector: (s) => (s === "parsererror" ? { textContent: "bad xml" } : null), documentElement: null };
      }
      if (type === "application/xml") {
        const el = {
          tagName: "root",
          attributes: [],
          children: [],
          textContent: "ok",
          querySelectorAll: () => [],
        };
        return {
          querySelector: () => null,
          documentElement: el,
        };
      }
      const body = { children: { length: 0 }, textContent: "", childNodes: [], querySelectorAll: () => [] };
      return { body, head: body, querySelector: () => null };
    }
  },
  navigator: { clipboard: { readText: async () => "", writeText: async () => {} } },
  window: {},
  requestAnimationFrame: (fn) => fn(),
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;

vm.runInNewContext(src, sandbox, { filename: "util-tools.js" });
const api = sandbox.window.wintUtilTools;
if (!api) throw new Error("wintUtilTools missing");
const catalog = api.catalog();
const ids = catalog.map((t) => t.id);
console.log("tools:", ids.length, ids.join(", "));
if (ids.includes("panic")) throw new Error("panic should be excluded");
const expected = ["any","base64","url","html","hex","binary","sha256","sha512","md5","hmac","jwt","uuid","guid","unix","filetime","json","xml","yaml","markup","csv"];
for (const id of expected) {
  if (!ids.includes(id)) throw new Error("missing " + id);
}
if (ids.length !== expected.length) throw new Error("count " + ids.length);

async function check(id, input, mode, flags, key) {
  const tool = api.byId(id);
  const res = await tool.run(input, mode || (tool.modes && tool.modes[0]) || "", flags || {}, key || "", 0);
  if (res.error) throw new Error(id + ": " + res.error);
  return res;
}

(async () => {
  const b64 = await check("base64", "hi", "Encode", {});
  if (b64.text !== "aGk=") throw new Error("base64 encode got " + b64.text);
  const dec = await check("base64", "aGk=", "Decode", {});
  if (dec.text !== "hi") throw new Error("base64 decode got " + dec.text);

  const jwt = await check(
    "jwt",
    "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.x"
  );
  if (!jwt.blocks || jwt.blocks.length < 3) throw new Error("jwt blocks");

  const json = await check("json", '{"a":1,}', "Format", {});
  if (!json.blocks && !json.text) throw new Error("json repair/format");

  const unix = await check("unix", "1756345600");
  if (!unix.rows || unix.rows.length < 5) throw new Error("unix rows");

  const guid = await check("guid", "8f14e45f-ceea-467a-9c3d-6b1f2a77e0d4");
  if (!guid.rows.find((r) => r.k === "Canonical")) throw new Error("guid");

  console.log("smoke ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
