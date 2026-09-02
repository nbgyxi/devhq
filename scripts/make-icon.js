#!/usr/bin/env node
// Draws the WinT source icon (a terminal prompt mark on a rounded gradient
// tile) straight to a PNG. Written by hand with zlib so the repo needs no image
// dependency just to regenerate one file.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SIZE = 1024;
const RADIUS = SIZE * 0.22;

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Signed distance to a rounded rectangle, used to antialias the tile edge. */
function roundedRectDist(x, y, w, h, r) {
  const dx = Math.abs(x - w / 2) - (w / 2 - r);
  const dy = Math.abs(y - h / 2) - (h / 2 - r);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ox, oy) - r;
}

/** Distance from a point to a line segment — the chevron and bar are strokes. */
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

const TOP = [0x6d, 0x8b, 0xff];
const BOTTOM = [0x3a, 0xd6, 0xc8];
const INK = [0x0b, 0x0d, 0x14];

const stroke = SIZE * 0.055;
const cx = SIZE * 0.42;
const cy = SIZE * 0.46;
const arm = SIZE * 0.15;

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let p = 0;
for (let y = 0; y < SIZE; y++) {
  raw[p++] = 0; // PNG filter: none
  for (let x = 0; x < SIZE; x++) {
    const tile = roundedRectDist(x + 0.5, y + 0.5, SIZE, SIZE, RADIUS);
    const alpha = Math.max(0, Math.min(1, 0.5 - tile));

    let [r, g, b] = mix(TOP, BOTTOM, (x / SIZE) * 0.35 + (y / SIZE) * 0.65);

    // ">" chevron
    const chevron = Math.min(
      segDist(x, y, cx - arm, cy - arm, cx + arm * 0.45, cy),
      segDist(x, y, cx + arm * 0.45, cy, cx - arm, cy + arm)
    );
    // underscore bar
    const bar = segDist(x, y, cx + arm * 0.85, cy + arm * 0.95, SIZE * 0.76, cy + arm * 0.95);
    const mark = Math.min(chevron, bar) - stroke / 2;
    const markAlpha = Math.max(0, Math.min(1, 0.5 - mark));
    if (markAlpha > 0) {
      [r, g, b] = mix([r, g, b], INK, markAlpha);
    }

    raw[p++] = r;
    raw[p++] = g;
    raw[p++] = b;
    raw[p++] = Math.round(alpha * 255);
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(__dirname, "..", "src", "wint-icon.png");
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${SIZE}x${SIZE}, ${png.length} bytes)`);
