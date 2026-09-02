#!/usr/bin/env node
// Centers app-icon.png on a square transparent canvas so Tauri's icon
// generator accepts it, then refreshes src/wint-icon.png for the UI.

const fs = require("node:fs");
const path = require("node:path");
const { createCanvas, loadImage } = require("@napi-rs/canvas");

const ROOT = path.join(__dirname, "..");
const SOURCE = path.join(ROOT, "app-icon.png");
const UI_ICON = path.join(ROOT, "src", "wint-icon.png");
const UI_SIZE = 512;

async function main() {
  if (!fs.existsSync(SOURCE)) {
    throw new Error(`Source icon not found: ${SOURCE}`);
  }
  const img = await loadImage(SOURCE);
  const size = Math.max(img.width, img.height);

  const square = createCanvas(size, size);
  const ctx = square.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(img, (size - img.width) / 2, (size - img.height) / 2);
  fs.writeFileSync(SOURCE, square.toBuffer("image/png"));

  const ui = createCanvas(UI_SIZE, UI_SIZE);
  ui.getContext("2d").drawImage(square, 0, 0, UI_SIZE, UI_SIZE);
  fs.writeFileSync(UI_ICON, ui.toBuffer("image/png"));

  console.log(`Normalized app-icon.png to ${size}x${size}, wrote src/wint-icon.png at ${UI_SIZE}px.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
