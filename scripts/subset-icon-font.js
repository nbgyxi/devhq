#!/usr/bin/env node
// Cuts the Material Symbols icon font down to the glyphs WinT actually names.
//
//   npm install            # once, pulls harfbuzzjs and wawoff2
//   npm run icon-font      # rewrite src/fonts/material-symbols-rounded.woff2
//   npm run icon-font:check   # fail if that file is stale or missing a glyph
//
// Why this exists: every window — main, each pop-out, and each isolated tool
// webview — loads styles.css, and styles.css declares the icon font with
// `font-display:block`, so no icon paints until the whole file is decoded.
// Isolated tools each get their own WebView2 data directory, so they each have
// their own cache and each pay that cost on first open. The full upstream font
// is ~5.2 MB; WinT names a few hundred glyphs.
//
// Files:
//   scripts/fonts/material-symbols-rounded-full.woff2   source, never bundled
//   src/fonts/material-symbols-rounded.woff2            generated, bundled
//   src/fonts/material-symbols-rounded.glyphs.txt       generated, reviewable
//
// Picking glyphs is deliberately over-inclusive. Icon names are written in far
// too many shapes to match reliably — `icon("x")`, `icon: "x"`, a bare
// `<span class="ms">x</span>`, either arm of a ternary, a value that came from
// Rust, a name assembled in a locale file. So this does not try to understand
// the code: it takes *every* lowercase word in every source file and keeps the
// ones that happen to be real glyph names. Coincidental English words ("error",
// "search", "home") get carried along, which costs a few KB and is the right
// trade — a glyph that ships unused is invisible, a glyph that went missing is
// a bug someone has to notice.
//
// Latin letters and ASCII punctuation are kept too. They are what the `liga`
// feature consumes to produce an icon, and they mean that a name this script
// somehow missed degrades to its literal text rather than to tofu.

const fs = require("node:fs");
const path = require("node:path");
const wawoff2 = require("wawoff2");

const ROOT = path.join(__dirname, "..");
const FULL_WOFF2 = path.join(__dirname, "fonts", "material-symbols-rounded-full.woff2");
const OUT_WOFF2 = path.join(ROOT, "src", "fonts", "material-symbols-rounded.woff2");
const OUT_LIST = path.join(ROOT, "src", "fonts", "material-symbols-rounded.glyphs.txt");
const HB_SUBSET_WASM = path.join(ROOT, "node_modules", "harfbuzzjs", "dist", "harfbuzz-subset.wasm");

/** Source files that may name an icon. Fonts and rendered icons are skipped. */
const SCAN_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".html", ".css", ".json", ".rs"]);
const SCAN_SKIP = new Set([
  "node_modules", "target", ".git", "dist", "gen", ".cache", "fonts", "tool-icons", "icons",
]);

// Release notes are prose, and prose collides with glyph names — "paid",
// "toll", "task". Left in the scan, every edit to the changelog would rebuild
// the font for a word nothing draws. It is excluded on the standing condition
// that it never names an icon, which `assertStillProse` re-checks each run.
const PROSE_ONLY = ["src/changelog.js"];

function assertStillProse() {
  for (const relative of PROSE_ONLY) {
    const text = fs.readFileSync(path.join(ROOT, relative), "utf8");
    if (/\bicon\s*:/.test(text) || /class="ms"/.test(text)) {
      throw new Error(
        `${relative} now names an icon, but it is excluded from the glyph scan.\n` +
        "Drop it from PROSE_ONLY in scripts/subset-icon-font.js and re-run.",
      );
    }
  }
}

// hb_subset_flags_t. NO_LAYOUT_CLOSURE is the one that matters: every icon is a
// ligature over plain letters, so with closure on, keeping the letters drags
// all ~3900 icons back in and the subset saves nothing.
const HB_SUBSET_FLAGS_NO_HINTING = 0x0001;
const HB_SUBSET_FLAGS_GLYPH_NAMES = 0x0080;
const HB_SUBSET_FLAGS_NO_LAYOUT_CLOSURE = 0x0200;
const HB_MEMORY_MODE_READONLY = 0;

/** Read glyph id -> name from a version 2.0 `post` table. */
function glyphNames(ttf) {
  const tableCount = ttf.readUInt16BE(4);
  let post = null;
  for (let i = 0; i < tableCount; i++) {
    const entry = 12 + i * 16;
    if (ttf.slice(entry, entry + 4).toString("latin1") === "post") {
      post = ttf.slice(ttf.readUInt32BE(entry + 8), ttf.readUInt32BE(entry + 8) + ttf.readUInt32BE(entry + 12));
      break;
    }
  }
  if (!post) throw new Error("The source font has no post table, so glyphs cannot be named.");
  if (post.readUInt32BE(0) !== 0x00020000) throw new Error("The source font's post table is not version 2.0.");
  const count = post.readUInt16BE(32);
  const indices = [];
  for (let i = 0; i < count; i++) indices.push(post.readUInt16BE(34 + i * 2));
  const custom = [];
  for (let at = 34 + count * 2; at < post.length; ) {
    const length = post.readUInt8(at);
    custom.push(post.slice(at + 1, at + 1 + length).toString("latin1"));
    at += 1 + length;
  }
  const byName = new Map();
  indices.forEach((index, gid) => {
    const name = index >= 258 ? custom[index - 258] : null;
    if (name && /^[a-z][a-z0-9_]*$/.test(name) && !byName.has(name)) byName.set(name, gid);
  });
  return byName;
}

/** Every lowercase word anywhere in the sources that is also a glyph name. */
function namesUsedInSources(available) {
  assertStillProse();
  const excluded = new Set(PROSE_ONLY.map((relative) => path.join(ROOT, relative)));
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SCAN_SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SCAN_EXTENSIONS.has(path.extname(entry.name)) && !excluded.has(full)) files.push(full);
    }
  })(ROOT);
  const found = new Set();
  for (const file of files) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(/[a-z][a-z0-9_]+/g)) {
      if (available.has(match[0])) found.add(match[0]);
    }
  }
  return { names: [...found].sort(), fileCount: files.length };
}

async function subset(ttf, gids) {
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(HB_SUBSET_WASM), {});
  const hb = instance.exports;
  const heap = () => Buffer.from(hb.memory.buffer);

  const fontPtr = hb.malloc(ttf.length);
  heap().set(ttf, fontPtr);
  const blob = hb.hb_blob_create(fontPtr, ttf.length, HB_MEMORY_MODE_READONLY, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  const input = hb.hb_subset_input_create_or_fail();
  if (!input) throw new Error("HarfBuzz would not create a subset input.");

  const glyphSet = hb.hb_subset_input_glyph_set(input);
  for (const gid of gids) hb.hb_set_add(glyphSet, gid);
  // Printable ASCII: the ligature inputs, and the graceful fallback.
  const unicodeSet = hb.hb_subset_input_unicode_set(input);
  for (let cp = 0x20; cp <= 0x7e; cp++) hb.hb_set_add(unicodeSet, cp);
  hb.hb_subset_input_set_flags(
    input,
    HB_SUBSET_FLAGS_NO_HINTING | HB_SUBSET_FLAGS_GLYPH_NAMES | HB_SUBSET_FLAGS_NO_LAYOUT_CLOSURE,
  );

  const subsetFace = hb.hb_subset_or_fail(face, input);
  if (!subsetFace) throw new Error("HarfBuzz could not subset the font.");
  const outBlob = hb.hb_face_reference_blob(subsetFace);
  const outPtr = hb.hb_blob_get_data(outBlob, 0);
  const outLength = hb.hb_blob_get_length(outBlob);
  const out = Buffer.from(heap().slice(outPtr, outPtr + outLength));

  hb.hb_blob_destroy(outBlob);
  hb.hb_face_destroy(subsetFace);
  hb.hb_subset_input_destroy(input);
  hb.hb_face_destroy(face);
  hb.hb_blob_destroy(blob);
  hb.free(fontPtr);
  return out;
}

/** Every name must still collapse to one glyph, and never to the same one. */
async function verifyShaping(ttf, names) {
  const hb = await import("harfbuzzjs");
  const font = new hb.Font(new hb.Face(new hb.Blob(new Uint8Array(ttf))));
  const broken = [];
  const seen = new Map();
  for (const name of names) {
    const buffer = new hb.Buffer();
    buffer.addText(name);
    buffer.guessSegmentProperties();
    hb.shape(font, buffer);
    const glyphs = buffer.getGlyphInfos();
    if (glyphs.length !== 1) {
      broken.push(`${name}: the ligature did not form (${glyphs.length} glyphs out)`);
    } else if (glyphs[0].codepoint === 0) {
      broken.push(`${name}: shaped to .notdef`);
    } else if (seen.has(glyphs[0].codepoint)) {
      broken.push(`${name}: shares a glyph with ${seen.get(glyphs[0].codepoint)}`);
    } else {
      seen.set(glyphs[0].codepoint, name);
    }
  }
  return broken;
}

/** The check that actually matters: does each name still draw the same icon?
 * Rendering both fonts and comparing pixels catches a glyph that survived but
 * came out as the wrong outline, which shaping alone cannot tell you. */
function verifyRendering(fullTtf, subsetTtf, names) {
  const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
  GlobalFonts.register(fullTtf, "WinTIconsFull");
  GlobalFonts.register(subsetTtf, "WinTIconsSubset");
  const size = 48;
  const draw = (family, name) => {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.font = `${size - 8}px "${family}"`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.fillText(name, 2, size / 2);
    return ctx.getImageData(0, 0, size, size).data;
  };
  const broken = [];
  for (const name of names) {
    const before = Buffer.from(draw("WinTIconsFull", name));
    const after = Buffer.from(draw("WinTIconsSubset", name));
    if (before.every((byte) => byte === 0)) {
      broken.push(`${name}: draws nothing even in the full font`);
    } else if (!before.equals(after)) {
      broken.push(`${name}: draws differently than in the full font`);
    }
  }
  return broken;
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  if (!fs.existsSync(FULL_WOFF2)) {
    throw new Error(`The source font is missing: ${path.relative(ROOT, FULL_WOFF2)}`);
  }
  const fullTtf = Buffer.from(await wawoff2.decompress(fs.readFileSync(FULL_WOFF2)));
  const available = glyphNames(fullTtf);
  const { names, fileCount } = namesUsedInSources(available);
  console.log(`Scanned ${fileCount} source files; ${names.length} of ${available.size} glyph names are referenced.`);

  if (checkOnly) {
    const listed = fs.existsSync(OUT_LIST)
      ? new Set(fs.readFileSync(OUT_LIST, "utf8").split(/\r?\n/).filter(Boolean).filter((line) => !line.startsWith("#")))
      : new Set();
    const missing = names.filter((name) => !listed.has(name));
    if (missing.length) {
      console.error(`The bundled icon font is missing ${missing.length} glyph(s): ${missing.join(", ")}`);
      console.error("Run `npm run icon-font` and commit src/fonts/.");
      process.exitCode = 1;
      return;
    }
    console.log("The bundled icon font covers every referenced glyph.");
    return;
  }

  const subsetTtf = await subset(fullTtf, names.map((name) => available.get(name)));
  const broken = [
    ...(await verifyShaping(subsetTtf, names)),
    ...verifyRendering(fullTtf, subsetTtf, names),
  ];
  if (broken.length) {
    throw new Error(`${broken.length} glyph(s) did not survive subsetting:\n  ${broken.slice(0, 40).join("\n  ")}`);
  }
  const woff2 = Buffer.from(await wawoff2.compress(subsetTtf));

  fs.mkdirSync(path.dirname(OUT_WOFF2), { recursive: true });
  fs.writeFileSync(OUT_WOFF2, woff2);
  fs.writeFileSync(
    OUT_LIST,
    `# Generated by scripts/subset-icon-font.js - do not edit.\n# ${names.length} glyphs kept from Material Symbols Rounded.\n${names.join("\n")}\n`,
  );

  const before = fs.statSync(FULL_WOFF2).size;
  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
  console.log(`Verified all ${names.length} glyphs shape and draw identically to the full font.`);
  console.log(`Wrote ${path.relative(ROOT, OUT_WOFF2)}: ${kb(before)} -> ${kb(woff2.length)} (${(before / woff2.length).toFixed(1)}x smaller).`);
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
});
