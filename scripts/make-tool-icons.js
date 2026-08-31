#!/usr/bin/env node
// Builds light and dark PNGs per pop-out tool: a large Material glyph on a
// transparent canvas, coloured for the surface it sits on. Run manually after
// catalog changes:
//
//   npm install          # once, pulls @napi-rs/canvas and wawoff2
//   npm run tool-icons
//
// Writes:
//   src-tauri/icons/tools/dark/<id>.png   — taskbar (dark surfaces)
//   src-tauri/icons/tools/light/<id>.png  — kept in sync; title bar in light windows
//   src/tool-icons/dark/<id>.png          — title bar when the window is dark
//   src/tool-icons/light/<id>.png         — title bar when the window is light
//
// `dark` = bright teal glyph for dark backgrounds (Windows taskbar, dark chrome).
// `light` = dark glyph for light backgrounds (light chrome).
// If a glyph cannot be drawn, `_default.png` in that scheme is used instead.

const fs = require("node:fs");
const path = require("node:path");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const wawoff2 = require("wawoff2");

const ROOT = path.join(__dirname, "..");
const FONT_WOFF2 = path.join(ROOT, "src", "fonts", "material-symbols-rounded.woff2");
const FONT_CACHE = path.join(__dirname, ".cache", "MaterialSymbolsRounded.woff");
const OUT_TAURI = path.join(ROOT, "src-tauri", "icons", "tools");
const OUT_UI = path.join(ROOT, "src", "tool-icons");

const SIZE = 256;
const FONT_FAMILY = "Material Symbols Rounded";
const THEMES = ["dark", "light"];
const DEFAULT_GLYPH = "handyman";

/** Match DevHQ CSS: teal on dark surfaces, body text on light. */
const THEME_STYLE = {
  dark: { glyph: "#3ad6c8" },
  light: { glyph: "#1a1c24" },
};

const CORE_TOOLS = [
  { id: "ports", icon: "lan" },
  { id: "dns", icon: "dns" },
  { id: "hosts", icon: "edit_note" },
  { id: "network", icon: "network_check" },
  { id: "github", icon: "merge" },
];

function parseCatalogArray(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) return [];
  const open = src.indexOf("[", start);
  if (open < 0) return [];
  let depth = 0;
  let body = "";
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        body = src.slice(open + 1, i);
        break;
      }
    }
  }
  const tools = [];
  for (const part of body.split(/\n(?=\s{2}\{ id:)/)) {
    const idMatch = part.match(/\{\s*id:\s*"([^"]+)"/);
    const iconMatch = part.match(/\bicon:\s*"([^"]+)"/);
    if (idMatch && iconMatch) tools.push({ id: idMatch[1], icon: iconMatch[1] });
  }
  return tools;
}

function parseUtilUnshift(src) {
  const match = src.match(
    /UTIL_TOOLS\.unshift\(\{\s*id:\s*"([^"]+)"[\s\S]*?\bname:\s*"[^"]*"[\s\S]*?\bicon:\s*"([^"]+)"/
  );
  return match ? [{ id: match[1], icon: match[2] }] : [];
}

function parseWindowsCatalog(src) {
  const match = src.match(/const catalog = \[([\s\S]*?)\n\s*\];/);
  if (!match) return [];
  const tools = [];
  const lineRe = /\{\s*id:\s*"([^"]+)"[^}\n]*\bicon:\s*"([^"]+)"/g;
  let line;
  while ((line = lineRe.exec(match[1]))) {
    tools.push({ id: line[1], icon: line[2] });
  }
  return tools;
}

function parseRepairTools(src) {
  const block = src.match(/const repairTools = \[([\s\S]*?)\];/);
  if (!block) return [];
  const tools = [];
  const tupleRe = /\[\s*"([^"]+)"\s*,\s*"[^"]*"\s*,\s*"([^"]+)"/g;
  let match;
  while ((match = tupleRe.exec(block[1]))) {
    tools.push({ id: `repair-${match[1]}`, icon: match[2] });
  }
  return tools;
}

function loadTools() {
  const utilSrc = fs.readFileSync(path.join(ROOT, "src", "util-tools.js"), "utf8");
  const winSrc = fs.readFileSync(path.join(ROOT, "src", "windows-tools.js"), "utf8");
  const merged = [
    ...CORE_TOOLS,
    ...parseCatalogArray(utilSrc, "const UTIL_TOOLS = ["),
    ...parseUtilUnshift(utilSrc),
    ...parseWindowsCatalog(winSrc),
    ...parseRepairTools(winSrc),
  ];
  const seen = new Set();
  return merged.filter((tool) => {
    if (seen.has(tool.id)) return false;
    seen.add(tool.id);
    return true;
  });
}

async function ensureFont() {
  fs.mkdirSync(path.dirname(FONT_CACHE), { recursive: true });
  if (!fs.existsSync(FONT_CACHE)) {
    if (!fs.existsSync(FONT_WOFF2)) {
      throw new Error(`Material font not found: ${FONT_WOFF2}`);
    }
    const woff = await wawoff2.decompress(fs.readFileSync(FONT_WOFF2));
    fs.writeFileSync(FONT_CACHE, Buffer.from(woff));
  }
  if (!GlobalFonts.has(FONT_FAMILY)) {
    GlobalFonts.registerFromPath(FONT_CACHE, FONT_FAMILY);
  }
}

function fitGlyphSize(ctx, glyph, maxW, maxH) {
  let fontSize = maxH;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let attempt = 0; attempt < 24; attempt++) {
    ctx.font = `${fontSize}px "${FONT_FAMILY}"`;
    const width = ctx.measureText(glyph).width;
    if (width <= maxW && fontSize <= maxH) return fontSize;
    fontSize *= 0.94;
  }
  return fontSize;
}

function drawGlyph(ctx, glyph, themeName) {
  ctx.clearRect(0, 0, SIZE, SIZE);
  const maxW = SIZE * 0.94;
  const maxH = SIZE * 0.94;
  const fontSize = fitGlyphSize(ctx, glyph, maxW, maxH);
  ctx.fillStyle = THEME_STYLE[themeName].glyph;
  ctx.font = `${fontSize}px "${FONT_FAMILY}"`;
  const drawn = ctx.measureText(glyph);
  if (!Number.isFinite(drawn.width) || drawn.width < 1) {
    throw new Error(`glyph "${glyph}" did not measure`);
  }
  ctx.fillText(glyph, SIZE / 2, SIZE / 2);
}

async function renderGlyph(glyph, themeName) {
  const canvas = createCanvas(SIZE, SIZE);
  drawGlyph(canvas.getContext("2d"), glyph, themeName);
  return canvas.toBuffer("image/png");
}

function writeIcon(themeName, fileName, png) {
  for (const root of [OUT_TAURI, OUT_UI]) {
    fs.writeFileSync(path.join(root, themeName, fileName), png);
  }
  // Jump List links use IShellLinkW, whose icon location expects an ICO (or a
  // resource inside an EXE/DLL). Modern ICO files may contain PNG payloads, so
  // keep the exact same rendered artwork without another raster conversion.
  if (themeName === "dark") {
    const header = Buffer.alloc(22);
    header.writeUInt16LE(0, 0);       // reserved
    header.writeUInt16LE(1, 2);       // icon
    header.writeUInt16LE(1, 4);       // one image
    header.writeUInt8(0, 6);          // 256 px
    header.writeUInt8(0, 7);          // 256 px
    header.writeUInt8(0, 8);          // no palette
    header.writeUInt8(0, 9);
    header.writeUInt16LE(1, 10);      // color planes
    header.writeUInt16LE(32, 12);     // bits per pixel
    header.writeUInt32LE(png.length, 14);
    header.writeUInt32LE(22, 18);
    fs.writeFileSync(
      path.join(OUT_TAURI, themeName, fileName.replace(/\.png$/, ".ico")),
      Buffer.concat([header, png])
    );
  }
}

function copyDefault(id, themeName) {
  for (const root of [OUT_TAURI, OUT_UI]) {
    fs.copyFileSync(
      path.join(root, themeName, "_default.png"),
      path.join(root, themeName, `${id}.png`)
    );
  }
  if (themeName === "dark") {
    fs.copyFileSync(
      path.join(OUT_TAURI, themeName, "_default.ico"),
      path.join(OUT_TAURI, themeName, `${id}.ico`)
    );
  }
}

function pruneStaleIcons(validIds) {
  for (const root of [OUT_TAURI, OUT_UI]) {
    if (!fs.existsSync(root)) continue;
    for (const themeName of THEMES) {
      const dir = path.join(root, themeName);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".png") && !name.endsWith(".ico")) continue;
        const id = name.slice(0, -4);
        if (id === "_default") continue;
        if (!validIds.has(id)) fs.unlinkSync(path.join(dir, name));
      }
    }
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith(".png")) continue;
      fs.unlinkSync(path.join(root, name));
    }
  }
}

async function main() {
  await ensureFont();
  const tools = loadTools();
  if (!tools.length) throw new Error("No tools found in catalog sources.");

  for (const themeName of THEMES) {
    fs.mkdirSync(path.join(OUT_TAURI, themeName), { recursive: true });
    fs.mkdirSync(path.join(OUT_UI, themeName), { recursive: true });
    writeIcon(themeName, "_default.png", await renderGlyph(DEFAULT_GLYPH, themeName));
  }
  pruneStaleIcons(new Set(tools.map((tool) => tool.id)));

  let composed = 0;
  let fallback = 0;

  for (const tool of tools) {
    for (const themeName of THEMES) {
      try {
        writeIcon(themeName, `${tool.id}.png`, await renderGlyph(tool.icon, themeName));
        composed++;
      } catch (error) {
        copyDefault(tool.id, themeName);
        fallback++;
        console.warn(`  ${tool.id} [${themeName}] -> _default (${error.message})`);
      }
    }
    console.log(`  ${tool.id} (${tool.icon})`);
  }

  console.log("");
  console.log(
    `Wrote ${tools.length * THEMES.length} tool icons (${composed} composed, ${fallback} fallback).`
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
