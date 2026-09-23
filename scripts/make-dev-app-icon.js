#!/usr/bin/env node
// Derive the development icon from the release artwork. The amber badge is
// deliberately simple so it remains legible in the 16/32 px Windows variants.

const fs = require("node:fs");
const path = require("node:path");
const { createCanvas, loadImage } = require("@napi-rs/canvas");

const ROOT = path.join(__dirname, "..");
const SOURCE = path.join(ROOT, "app-icon.png");
const OUTPUT = path.join(ROOT, "dev-app-icon.png");
const UI_OUTPUT = path.join(ROOT, "src", "wint-dev-icon.png");

async function main() {
  const source = await loadImage(SOURCE);
  const size = Math.max(source.width, source.height);
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, (size - source.width) / 2, (size - source.height) / 2);

  const radius = size * 0.19;
  const x = size * 0.79;
  const y = size * 0.79;
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, .55)";
  ctx.shadowBlur = size * 0.035;
  ctx.shadowOffsetY = size * 0.018;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = "#f59e0b";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = size * 0.018;
  ctx.strokeStyle = "#fff7df";
  ctx.stroke();

  ctx.fillStyle = "#17120a";
  ctx.font = `900 ${Math.round(size * 0.25)}px Arial`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("D", x, y + size * 0.012);
  ctx.restore();

  const png = canvas.toBuffer("image/png");
  fs.writeFileSync(OUTPUT, png);

  const ui = createCanvas(512, 512);
  ui.getContext("2d").drawImage(canvas, 0, 0, 512, 512);
  fs.writeFileSync(UI_OUTPUT, ui.toBuffer("image/png"));
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)} and ${path.relative(ROOT, UI_OUTPUT)}.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
