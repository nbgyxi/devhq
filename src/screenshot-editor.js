// The screenshot editor: crop, arrows, circles, highlights and text over a
// shot taken with the Screenshot shortcut, then Copy or Save.
//
// Everything is kept in the picture's own pixels - the crop is a window onto
// the full shot and every mark is placed in full-shot coordinates - so a crop
// never moves a mark, and undoing a crop brings back what was cut away.
//
// Every mark stays an object after it is drawn: it can be selected, moved,
// resized and deleted, and a text can be typed into again and restyled.
(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;
  const win = window.__TAURI__.window.getCurrentWindow();
  const id = Number(new URLSearchParams(location.search).get("id"));
  const $ = (selector) => document.querySelector(selector);
  const canvas = $("#canvas");
  const ctx = canvas.getContext("2d");
  const wrap = $("#wrap");
  const stage = $("#stage");
  const statusLine = $("#status");
  const measure = document.createElement("canvas").getContext("2d");

  const COLORS = ["#ff3b30", "#ffd60a", "#30d158", "#0a84ff", "#ffffff", "#111111"];
  const STROKE = [3, 5, 8];
  const TEXT = [18, 28, 42];
  const FONTS = [
    ["Segoe UI", '"Segoe UI Variable", "Segoe UI", sans-serif'],
    ["Arial", "Arial, sans-serif"],
    ["Calibri", "Calibri, sans-serif"],
    ["Georgia", "Georgia, serif"],
    ["Consolas", "Consolas, monospace"],
    ["Comic Sans MS", '"Comic Sans MS", cursive'],
    ["Impact", "Impact, sans-serif"],
  ];
  const KEYS = { v: "select", c: "crop", a: "arrow", o: "ellipse", e: "ellipse", h: "highlight", t: "text" };
  const CURSORS = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", p1: "crosshair", p2: "crosshair" };

  // Marks are sized for the screen they will be looked at on: a shot from a
  // 150% display has half again as many pixels for the same thing.
  const ratio = () => window.devicePixelRatio || 1;
  const px = (value) => value * ratio();

  let image = null;
  let doc = { crop: { x: 0, y: 0, w: 0, h: 0 }, shapes: [] };
  let history = [];
  let at = -1;
  let tool = "arrow";
  // "fit" shows the whole picture; "full" shows it at its real size and
  // scrolls whatever does not fit, for working on detail in a large shot.
  let view = "fit";
  // Highlighting in red is never what anyone wants, so the marker keeps a
  // colour of its own.
  const colors = { stroke: COLORS[0], highlight: COLORS[1] };
  let size = 1;
  // What the next new text starts with, and what the text bar changes when
  // no text is selected.
  const textStyle = { font: "Segoe UI", size: px(TEXT[1]), bg: "", pad: px(6), border: 0, shadow: true };
  let selectedId = null;
  let nextId = 1;
  let draft = null;
  let drag = null;
  let entry = null;
  let busy = false;

  const colorKey = () => (tool === "highlight" ? "highlight" : "stroke");
  const selected = () => doc.shapes.find((shape) => shape.id === selectedId) || null;
  const family = (name) => (FONTS.find(([font]) => font === name) || FONTS[0])[1];
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function setStatus(text, kind = "") {
    statusLine.className = `shot-status${kind ? ` ${kind}` : ""}`;
    statusLine.textContent = text;
  }

  /* ------------------------------------------------------------ history */

  function commit() {
    history = history.slice(0, at + 1);
    history.push(JSON.stringify(doc));
    at = history.length - 1;
    syncButtons();
  }
  function step(delta) {
    const next = at + delta;
    if (next < 0 || next >= history.length) return;
    cancelEntry();
    drag = null;
    at = next;
    doc = JSON.parse(history[at]);
    if (!selected()) selectedId = null;
    syncButtons();
    fit();
  }

  /* ------------------------------------------------------------- shapes */

  /** The box a text is drawn in: its lines, plus padding all round. */
  function textBox(shape) {
    measure.font = `600 ${shape.size}px ${family(shape.font)}`;
    const lines = shape.text.split("\n");
    const lineHeight = shape.size * 1.25;
    const width = Math.max(...lines.map((line) => measure.measureText(line).width), shape.size * 0.3);
    return { x: shape.x, y: shape.y, w: width + shape.pad * 2, h: lines.length * lineHeight + shape.pad * 2, lines, lineHeight };
  }

  /** The rectangle an item occupies, for its selection frame and hit test. */
  function bounds(shape) {
    if (shape.type === "arrow") {
      const x = Math.min(shape.x1, shape.x2);
      const y = Math.min(shape.y1, shape.y2);
      return { x, y, w: Math.abs(shape.x2 - shape.x1), h: Math.abs(shape.y2 - shape.y1) };
    }
    if (shape.type === "text") return textBox(shape);
    return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
  }

  /** The grips an item can be resized by. */
  function handles(shape) {
    if (shape.type === "arrow") return [{ name: "p1", x: shape.x1, y: shape.y1 }, { name: "p2", x: shape.x2, y: shape.y2 }];
    const b = bounds(shape);
    const corners = [
      { name: "nw", x: b.x, y: b.y }, { name: "ne", x: b.x + b.w, y: b.y },
      { name: "sw", x: b.x, y: b.y + b.h }, { name: "se", x: b.x + b.w, y: b.y + b.h },
    ];
    // A text is resized by scaling it, which only makes sense from a corner.
    if (shape.type === "text") return corners;
    return [
      ...corners,
      { name: "n", x: b.x + b.w / 2, y: b.y }, { name: "s", x: b.x + b.w / 2, y: b.y + b.h },
      { name: "w", x: b.x, y: b.y + b.h / 2 }, { name: "e", x: b.x + b.w, y: b.y + b.h / 2 },
    ];
  }

  /** Picture pixels per CSS pixel, so grips and hit slop stay the same size on screen. */
  function slop(cssPixels) {
    const width = canvas.getBoundingClientRect().width || 1;
    return (cssPixels * doc.crop.w) / width;
  }

  function hitHandle(shape, p) {
    const reach = slop(7);
    return handles(shape).find((h) => Math.abs(h.x - p.x) <= reach && Math.abs(h.y - p.y) <= reach) || null;
  }

  function hitShape(shape, p) {
    const reach = slop(5);
    if (shape.type === "arrow") {
      const { x1, y1, x2, y2 } = shape;
      const lengthSq = (x2 - x1) ** 2 + (y2 - y1) ** 2 || 1;
      const t = Math.max(0, Math.min(1, ((p.x - x1) * (x2 - x1) + (p.y - y1) * (y2 - y1)) / lengthSq));
      return Math.hypot(p.x - (x1 + t * (x2 - x1)), p.y - (y1 + t * (y2 - y1))) <= shape.width / 2 + reach;
    }
    const b = bounds(shape);
    if (shape.type === "ellipse") {
      const rx = b.w / 2 + reach;
      const ry = b.h / 2 + reach;
      return ((p.x - (b.x + b.w / 2)) / rx) ** 2 + ((p.y - (b.y + b.h / 2)) / ry) ** 2 <= 1;
    }
    return p.x >= b.x - reach && p.x <= b.x + b.w + reach && p.y >= b.y - reach && p.y <= b.y + b.h + reach;
  }

  /** The topmost item under a point. */
  function shapeAt(p) {
    for (let index = doc.shapes.length - 1; index >= 0; index -= 1) {
      const shape = doc.shapes[index];
      if (shape.id !== entry?.editing && hitShape(shape, p)) return shape;
    }
    return null;
  }

  function select(shapeId) {
    selectedId = shapeId;
    const shape = selected();
    if (shape) {
      // The toolbar shows what the selection is, so the next change is made
      // knowingly - and the next new item of that kind starts the same.
      if (shape.type === "arrow" || shape.type === "ellipse") {
        colors.stroke = shape.color;
        const preset = STROKE.map(px).findIndex((width) => Math.abs(width - shape.width) < 0.5);
        if (preset >= 0) size = preset;
      } else if (shape.type === "highlight") {
        colors.highlight = shape.color;
      } else if (shape.type === "text") {
        colors.stroke = shape.color;
        Object.assign(textStyle, pickStyle(shape));
      }
    }
    syncButtons();
    render();
  }

  function removeSelected() {
    if (!selected()) return;
    doc.shapes = doc.shapes.filter((shape) => shape.id !== selectedId);
    selectedId = null;
    commit();
    render();
  }

  function nudge(dx, dy) {
    const shape = selected();
    if (!shape) return;
    moveShape(shape, clone(shape), dx, dy);
    commit();
    render();
  }

  function moveShape(shape, from, dx, dy) {
    if (shape.type === "arrow") {
      Object.assign(shape, { x1: from.x1 + dx, y1: from.y1 + dy, x2: from.x2 + dx, y2: from.y2 + dy });
    } else {
      Object.assign(shape, { x: from.x + dx, y: from.y + dy });
    }
  }

  function resizeShape(shape, from, handle, p) {
    if (shape.type === "arrow") {
      if (handle === "p1") Object.assign(shape, { x1: p.x, y1: p.y });
      else Object.assign(shape, { x2: p.x, y2: p.y });
      return;
    }
    if (shape.type === "text") {
      // Scaled about the opposite corner: size, padding and border together.
      const b = textBox(from);
      const anchorX = handle.includes("w") ? b.x + b.w : b.x;
      const anchorY = handle.includes("n") ? b.y + b.h : b.y;
      const sx = Math.abs(p.x - anchorX) / b.w;
      const sy = Math.abs(p.y - anchorY) / b.h;
      const k = Math.max(4 / from.size, (sx + sy) / 2);
      Object.assign(shape, {
        size: from.size * k, pad: from.pad * k, border: from.border * k,
        x: handle.includes("w") ? anchorX - b.w * k : anchorX,
        y: handle.includes("n") ? anchorY - b.h * k : anchorY,
      });
      return;
    }
    let left = from.x;
    let top = from.y;
    let right = from.x + from.w;
    let bottom = from.y + from.h;
    if (handle.includes("w")) left = p.x;
    if (handle.includes("e")) right = p.x;
    if (handle.includes("n")) top = p.y;
    if (handle.includes("s")) bottom = p.y;
    Object.assign(shape, {
      x: Math.min(left, right), y: Math.min(top, bottom),
      w: Math.max(2, Math.abs(right - left)), h: Math.max(2, Math.abs(bottom - top)),
    });
  }

  /* ---------------------------------------------------------- toolbar */

  const pickStyle = (from) => ({ font: from.font, size: from.size, bg: from.bg, pad: from.pad, border: from.border, shadow: from.shadow });

  /** What the text bar is showing and changing right now. */
  function textTarget() {
    if (entry) return entry;
    const shape = selected();
    return shape?.type === "text" ? shape : null;
  }

  function syncButtons() {
    const shape = selected();
    const current = entry?.color || shape?.color || colors[colorKey()];
    for (const button of document.querySelectorAll("[data-tool]")) button.classList.toggle("on", button.dataset.tool === tool);
    for (const button of document.querySelectorAll("#colors [data-color]")) button.classList.toggle("on", button.dataset.color === current);
    for (const button of document.querySelectorAll("[data-size]")) button.classList.toggle("on", Number(button.dataset.size) === size);
    for (const button of document.querySelectorAll("[data-view]")) {
      button.classList.toggle("on", button.dataset.view === view);
      button.setAttribute("aria-selected", String(button.dataset.view === view));
    }
    $("#undo").disabled = at <= 0;
    $("#redo").disabled = at >= history.length - 1;
    $("#delete").disabled = !shape;
    $("#size").textContent = image ? `${doc.crop.w} × ${doc.crop.h}` : "";
    syncTextbar();
  }

  function syncTextbar() {
    const target = textTarget();
    const bar = $("#textbar");
    bar.hidden = !(target || tool === "text");
    if (bar.hidden) return;
    const style = target || textStyle;
    const r = ratio();
    $("#t-font").value = style.font;
    // Only rewritten when it differs, so a number being typed is not
    // reformatted under the caret.
    const sizeValue = String(Math.round(style.size / r));
    if (document.activeElement !== $("#t-size") && $("#t-size").value !== sizeValue) $("#t-size").value = sizeValue;
    const padValue = String(Math.round(style.pad / r));
    if (document.activeElement !== $("#t-pad") && $("#t-pad").value !== padValue) $("#t-pad").value = padValue;
    for (const button of document.querySelectorAll("#t-bg [data-bg]")) button.classList.toggle("on", button.dataset.bg === (style.bg || ""));
    const border = Math.round(style.border / r);
    for (const button of document.querySelectorAll("[data-border]")) button.classList.toggle("on", Number(button.dataset.border) === border);
    $("#t-shadow").checked = Boolean(style.shadow);
  }

  function setTool(next) {
    commitEntry();
    tool = next;
    syncButtons();
    render();
  }

  $("#colors").innerHTML = COLORS.map((color) => `<button type="button" data-color="${color}" title="${color}"><i style="--c:${color}"></i></button>`).join("");
  $("#t-bg").innerHTML = `<button type="button" data-bg="" title="No background"><i class="none"></i></button>${COLORS.map((color) => `<button type="button" data-bg="${color}" title="${color}"><i style="--c:${color}"></i></button>`).join("")}`;
  $("#t-font").innerHTML = FONTS.map(([name, stack]) => `<option value="${name}" style="font-family:${stack.replace(/"/g, "&quot;")}">${name}</option>`).join("");

  $("#tools").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tool]");
    if (button) setTool(button.dataset.tool);
  });
  $("#colors").addEventListener("click", (event) => {
    const button = event.target.closest("[data-color]");
    if (!button) return;
    const color = button.dataset.color;
    const shape = selected();
    if (entry) {
      entry.color = color;
      colors.stroke = color;
      styleEntry();
    } else if (shape) {
      shape.color = color;
      colors[shape.type === "highlight" ? "highlight" : "stroke"] = color;
      commit();
      render();
    } else {
      colors[colorKey()] = color;
    }
    syncButtons();
  });
  $("#sizes").addEventListener("click", (event) => {
    const button = event.target.closest("[data-size]");
    if (!button) return;
    size = Number(button.dataset.size);
    const shape = selected();
    if (entry) {
      entry.size = px(TEXT[size]);
      textStyle.size = entry.size;
      styleEntry();
    } else if (shape?.type === "arrow" || shape?.type === "ellipse") {
      shape.width = px(STROKE[size]);
      commit();
      render();
    } else if (shape?.type === "text") {
      shape.size = px(TEXT[size]);
      textStyle.size = shape.size;
      commit();
      render();
    } else {
      textStyle.size = px(TEXT[size]);
    }
    syncButtons();
  });

  /** Changes the text being typed or selected, and the style new text starts
   *  with. `final` adds an undo step; a number still being typed does not. */
  function applyText(patch, final = true) {
    Object.assign(textStyle, patch);
    const target = textTarget();
    if (target) Object.assign(target, patch);
    if (entry) styleEntry();
    else if (target && final) commit();
    render();
    syncButtons();
  }
  $("#t-font").addEventListener("change", (event) => applyText({ font: event.target.value }));
  const numberInput = (input, key, min, max) => {
    const read = () => {
      const value = Number(input.value);
      return Number.isFinite(value) ? px(Math.max(min, Math.min(max, value))) : null;
    };
    input.addEventListener("input", () => { const value = read(); if (value != null) applyText({ [key]: value }, false); });
    input.addEventListener("change", () => { const value = read(); if (value != null) applyText({ [key]: value }); });
  };
  numberInput($("#t-size"), "size", 6, 300);
  numberInput($("#t-pad"), "pad", 0, 100);
  $("#t-bg").addEventListener("click", (event) => {
    const button = event.target.closest("[data-bg]");
    if (button) applyText({ bg: button.dataset.bg });
  });
  $("#t-border").addEventListener("click", (event) => {
    const button = event.target.closest("[data-border]");
    if (button) applyText({ border: px(Number(button.dataset.border)) });
  });
  $("#t-shadow").addEventListener("change", (event) => applyText({ shadow: event.target.checked }));

  // While text is being typed, a button must not take focus from it: a colour
  // or a size picked then is meant for that text. Fields such as the font
  // list do take focus; the text is then committed, selected, and the field
  // changes it all the same.
  for (const bar of [$(".shot-tools"), $("#textbar")]) {
    bar.addEventListener("mousedown", (event) => { if (entry && event.target.closest("button")) event.preventDefault(); });
  }
  function setView(next) {
    if (next === view) return;
    view = next;
    fit();
  }
  $("#view").addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (button) setView(button.dataset.view);
  });
  $("#undo").addEventListener("click", () => step(-1));
  $("#redo").addEventListener("click", () => step(1));
  $("#delete").addEventListener("click", () => removeSelected());

  /* ------------------------------------------------------------ drawing */

  function drawText(g, shape) {
    const b = textBox(shape);
    const radius = Math.min(shape.size * 0.2, b.h / 2);
    if (shape.shadow) {
      g.shadowColor = "rgba(0,0,0,.5)";
      g.shadowBlur = Math.max(2, shape.size * 0.3);
      g.shadowOffsetY = Math.max(1, shape.size * 0.06);
    }
    if (shape.bg) {
      g.fillStyle = shape.bg;
      g.beginPath();
      g.roundRect(b.x, b.y, b.w, b.h, radius);
      g.fill();
      // The box carries the shadow; the text on it does not need one too.
      g.shadowColor = "transparent";
    }
    if (shape.border > 0) {
      const inset = shape.border / 2;
      g.save();
      g.shadowColor = shape.bg ? "transparent" : g.shadowColor;
      g.strokeStyle = shape.color;
      g.lineWidth = shape.border;
      g.beginPath();
      g.roundRect(b.x + inset, b.y + inset, b.w - shape.border, b.h - shape.border, Math.max(0, radius - inset));
      g.stroke();
      g.restore();
    }
    g.font = `600 ${shape.size}px ${family(shape.font)}`;
    g.textBaseline = "middle";
    g.fillStyle = shape.color;
    b.lines.forEach((line, index) => {
      g.fillText(line, b.x + shape.pad, b.y + shape.pad + (index + 0.5) * b.lineHeight);
    });
  }

  function drawShape(g, shape) {
    g.save();
    g.lineCap = "round";
    g.lineJoin = "round";
    if (shape.type === "arrow") {
      const { x1, y1, x2, y2, width } = shape;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.max(width * 3.6, 12);
      const spread = Math.PI / 7;
      const backX = x2 - Math.cos(angle) * head * 0.8;
      const backY = y2 - Math.sin(angle) * head * 0.8;
      g.strokeStyle = g.fillStyle = shape.color;
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(backX, backY);
      g.stroke();
      g.beginPath();
      g.moveTo(x2, y2);
      g.lineTo(x2 - Math.cos(angle - spread) * head, y2 - Math.sin(angle - spread) * head);
      g.lineTo(x2 - Math.cos(angle + spread) * head, y2 - Math.sin(angle + spread) * head);
      g.closePath();
      g.fill();
    } else if (shape.type === "ellipse") {
      g.strokeStyle = shape.color;
      g.lineWidth = shape.width;
      g.beginPath();
      g.ellipse(shape.x + shape.w / 2, shape.y + shape.h / 2, Math.abs(shape.w / 2), Math.abs(shape.h / 2), 0, 0, Math.PI * 2);
      g.stroke();
    } else if (shape.type === "highlight") {
      // Multiply, like a real marker: text under it stays as dark as it was.
      g.globalCompositeOperation = "multiply";
      g.globalAlpha = 0.5;
      g.fillStyle = shape.color;
      g.fillRect(shape.x, shape.y, shape.w, shape.h);
    } else if (shape.type === "text") {
      drawText(g, shape);
    }
    g.restore();
  }

  /** Draws the current crop of the picture with every mark onto `g`, `scale`
   *  canvas pixels to one picture pixel. A text being typed into is left out:
   *  the box over it is showing it. */
  function paint(g, scale, extra) {
    const { crop } = doc;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, g.canvas.width, g.canvas.height);
    g.imageSmoothingQuality = "high";
    g.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, g.canvas.width, g.canvas.height);
    g.setTransform(scale, 0, 0, scale, -crop.x * scale, -crop.y * scale);
    for (const shape of doc.shapes) if (shape.id !== entry?.editing) drawShape(g, shape);
    if (extra) extra(g);
  }

  function drawSelection(g, shape, scale) {
    const line = ratio() / scale;
    g.save();
    g.strokeStyle = "#6d8bff";
    g.lineWidth = line * 1.5;
    if (shape.type !== "arrow") {
      const b = bounds(shape);
      const gap = line * 3;
      g.setLineDash([line * 5, line * 3]);
      g.strokeRect(b.x - gap, b.y - gap, b.w + gap * 2, b.h + gap * 2);
      g.setLineDash([]);
    }
    const half = line * 4.5;
    for (const h of handles(shape)) {
      g.fillStyle = "#fff";
      g.fillRect(h.x - half, h.y - half, half * 2, half * 2);
      g.strokeRect(h.x - half, h.y - half, half * 2, half * 2);
    }
    g.restore();
  }

  function render() {
    if (!image) return;
    const scale = canvas.width / doc.crop.w;
    paint(ctx, scale, (g) => {
      const shape = selected();
      if (shape && shape.id !== entry?.editing) drawSelection(g, shape, scale);
      if (!draft) return;
      if (draft.type === "crop") {
        // Everything outside the box being dragged goes dark.
        const r = rectOf(draft);
        g.save();
        g.fillStyle = "rgba(0,0,0,.55)";
        g.beginPath();
        g.rect(doc.crop.x, doc.crop.y, doc.crop.w, doc.crop.h);
        g.rect(r.x, r.y, r.w, r.h);
        g.fill("evenodd");
        g.strokeStyle = "#fff";
        g.lineWidth = 1 / scale;
        g.setLineDash([6 / scale, 4 / scale]);
        g.strokeRect(r.x, r.y, r.w, r.h);
        g.restore();
      } else {
        drawShape(g, draft);
      }
    });
  }

  /** Sizes the canvas for the view: fit shows the whole crop - at its real
   *  size when it fits, smaller when not - and full shows it at its real
   *  size always, one picture pixel to one screen pixel, leaving whatever
   *  does not fit to scroll. */
  function fit() {
    if (!image) return;
    const r = ratio();
    const room = stage.getBoundingClientRect();
    const availW = Math.max(40, room.width - 32);
    const availH = Math.max(40, room.height - 32);
    // The shot is in physical pixels, so its real size in CSS pixels is
    // divided by the display's scale.
    const naturalW = doc.crop.w / r;
    const naturalH = doc.crop.h / r;
    const full = view === "full";
    stage.classList.toggle("full", full);
    const k = full ? 1 : Math.min(1, availW / naturalW, availH / naturalH);
    const cssW = Math.max(1, Math.round(naturalW * k));
    const cssH = Math.max(1, Math.round(naturalH * k));
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.max(1, Math.round(cssW * r));
    canvas.height = Math.max(1, Math.round(cssH * r));
    if (entry) placeEntry();
    syncButtons();
    render();
  }
  new ResizeObserver(() => fit()).observe(stage);

  /* ------------------------------------------------------------- input */

  function toImage(event) {
    const r = canvas.getBoundingClientRect();
    return {
      x: doc.crop.x + ((event.clientX - r.left) / r.width) * doc.crop.w,
      y: doc.crop.y + ((event.clientY - r.top) / r.height) * doc.crop.h,
    };
  }
  function rectOf(d) {
    let w = d.x2 - d.x1;
    let h = d.y2 - d.y1;
    if (d.square) {
      const side = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * side;
      h = Math.sign(h || 1) * side;
    }
    return { x: Math.min(d.x1, d.x1 + w), y: Math.min(d.y1, d.y1 + h), w: Math.abs(w), h: Math.abs(h) };
  }

  function startDrag(event, shape, mode, handle, p) {
    canvas.setPointerCapture(event.pointerId);
    drag = { id: shape.id, mode, handle, start: p, from: clone(shape), moved: false };
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (!image || event.button !== 0) return;
    const p = toImage(event);
    if (entry) {
      commitEntry();
      if (tool === "text") return;
    }
    // The selection answers first, whatever the tool: its grips and its body
    // are always there to be dragged.
    const current = selected();
    if (current) {
      const handle = hitHandle(current, p);
      if (handle) return startDrag(event, current, "resize", handle.name, p);
      if (hitShape(current, p)) return startDrag(event, current, "move", null, p);
    }
    // Select and Text pick up whatever is under the pointer; the drawing
    // tools draw, so that an arrow can start on top of a highlight.
    if (tool === "select" || tool === "text") {
      const hit = shapeAt(p);
      if (hit) {
        select(hit.id);
        return startDrag(event, hit, "move", null, p);
      }
    }
    select(null);
    if (tool === "select") return;
    if (tool === "text") {
      event.preventDefault();
      openEntry(p);
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    draft = { type: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, square: event.shiftKey };
  });

  canvas.addEventListener("pointermove", (event) => {
    const p = toImage(event);
    if (drag) {
      const shape = doc.shapes.find((item) => item.id === drag.id);
      if (!shape) { drag = null; return; }
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) < slop(2)) return;
      drag.moved = true;
      if (drag.mode === "move") moveShape(shape, drag.from, dx, dy);
      else resizeShape(shape, drag.from, drag.handle, p);
      render();
      return;
    }
    if (draft) {
      draft.x2 = Math.max(doc.crop.x, Math.min(doc.crop.x + doc.crop.w, p.x));
      draft.y2 = Math.max(doc.crop.y, Math.min(doc.crop.y + doc.crop.h, p.y));
      draft.square = event.shiftKey;
      shapeDraft();
      render();
      return;
    }
    canvas.style.cursor = cursorAt(p);
  });

  function cursorAt(p) {
    const current = selected();
    if (current) {
      const handle = hitHandle(current, p);
      if (handle) return CURSORS[handle.name];
      if (hitShape(current, p)) return "move";
    }
    if ((tool === "select" || tool === "text") && shapeAt(p)) return "move";
    if (tool === "select") return "default";
    if (tool === "text") return "text";
    return "crosshair";
  }

  function endPointer() {
    if (drag) {
      const moved = drag.moved;
      drag = null;
      if (moved) commit();
      render();
      return;
    }
    finishDraft();
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", () => {
    if (drag) {
      const shape = doc.shapes.find((item) => item.id === drag.id);
      if (shape) Object.assign(shape, drag.from);
      drag = null;
    }
    draft = null;
    render();
  });
  canvas.addEventListener("dblclick", (event) => {
    const hit = shapeAt(toImage(event));
    if (hit?.type === "text") openEntry({ x: hit.x, y: hit.y }, hit);
  });

  /** Fills in the shape the draft stands for, so drawing it is drawing the result. */
  function shapeDraft() {
    const d = draft;
    const width = px(STROKE[size]);
    const color = colors[colorKey()];
    if (d.type === "arrow") Object.assign(d, { width, color });
    else if (d.type === "ellipse") Object.assign(d, rectOf(d), { width, color });
    else if (d.type === "highlight") Object.assign(d, rectOf(d), { color });
  }

  /** A new item comes out selected, so it can be nudged or resized at once. */
  function add(shape) {
    const item = { id: `s${nextId++}`, ...shape };
    doc.shapes.push(item);
    selectedId = item.id;
    commit();
    return item;
  }

  function finishDraft() {
    if (!draft) return;
    const d = draft;
    draft = null;
    const r = rectOf({ ...d, square: d.type === "ellipse" && d.square });
    const length = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
    if (d.type === "crop") {
      if (r.w >= 8 && r.h >= 8) {
        doc.crop = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
        commit();
        fit();
        setStatus(`Cropped to ${doc.crop.w} × ${doc.crop.h} - Ctrl+Z puts it back`);
        return;
      }
    } else if (d.type === "arrow" && length >= 6) {
      add({ type: "arrow", x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, width: d.width, color: d.color });
    } else if ((d.type === "ellipse" || d.type === "highlight") && r.w >= 4 && r.h >= 4) {
      add({ type: d.type, ...r, width: d.width, color: d.color });
    }
    render();
  }

  /* -------------------------------------------------------------- text */

  /** A box to type into, styled like the text it will become. `shape` is a
   *  text being edited again; without it a new one is started at `p`. */
  function openEntry(p, shape = null) {
    commitEntry();
    const box = document.createElement("textarea");
    box.className = "shot-text-entry";
    box.rows = 1;
    box.spellcheck = false;
    const style = shape ? pickStyle(shape) : { ...textStyle };
    // A new text is placed with its first line where the click was.
    const x = shape ? shape.x : p.x - style.pad;
    const y = shape ? shape.y : p.y - style.pad - style.size * 0.625;
    entry = { box, editing: shape?.id || null, x, y, color: shape?.color || colors.stroke, ...style };
    box.value = shape?.text || "";
    if (shape) selectedId = shape.id;
    wrap.appendChild(box);
    placeEntry();
    box.addEventListener("input", () => grow());
    box.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); cancelEntry(); }
      else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); commitEntry(); }
    });
    box.addEventListener("blur", () => commitEntry());
    syncButtons();
    render();
    setTimeout(() => { box.focus(); box.select(); }, 0);
  }
  function scaleCss() {
    return canvas.getBoundingClientRect().width / doc.crop.w;
  }
  function styleEntry() {
    if (!entry) return;
    const k = scaleCss();
    const s = entry.box.style;
    s.color = entry.color;
    s.fontFamily = family(entry.font);
    s.fontSize = `${entry.size * k}px`;
    s.padding = `${entry.pad * k}px`;
    s.background = entry.bg || "transparent";
    s.borderWidth = `${entry.border * k}px`;
    s.borderColor = entry.color;
    s.borderRadius = `${entry.size * 0.2 * k}px`;
    s.boxShadow = entry.shadow && entry.bg ? `0 ${entry.size * 0.06 * k}px ${entry.size * 0.3 * k}px rgba(0,0,0,.5)` : "none";
    s.textShadow = entry.shadow && !entry.bg ? `0 ${entry.size * 0.06 * k}px ${entry.size * 0.3 * k}px rgba(0,0,0,.5)` : "none";
    grow();
  }
  function placeEntry() {
    if (!entry) return;
    const k = scaleCss();
    entry.box.style.left = `${(entry.x - doc.crop.x) * k}px`;
    entry.box.style.top = `${(entry.y - doc.crop.y) * k}px`;
    styleEntry();
  }
  function grow() {
    const box = entry?.box;
    if (!box) return;
    const pad = entry.pad * scaleCss();
    box.style.width = "0";
    box.style.height = "0";
    box.style.width = `${Math.max(20, box.scrollWidth - pad * 2 + 4)}px`;
    box.style.height = `${box.scrollHeight - pad * 2}px`;
  }
  function commitEntry() {
    if (!entry) return;
    const { box, editing, x, y, color } = entry;
    const style = pickStyle(entry);
    entry = null;
    const text = box.value.replace(/\s+$/, "");
    box.remove();
    if (editing) {
      const shape = doc.shapes.find((item) => item.id === editing);
      if (shape && !text) {
        doc.shapes = doc.shapes.filter((item) => item.id !== editing);
        selectedId = null;
        commit();
      } else if (shape && (shape.text !== text || JSON.stringify(pickStyle(shape)) !== JSON.stringify(style) || shape.color !== color)) {
        Object.assign(shape, { text, color, ...style });
        commit();
      }
    } else if (text) {
      add({ type: "text", x, y, text, color, ...style });
    }
    syncButtons();
    render();
  }
  function cancelEntry() {
    if (!entry) return;
    entry.box.remove();
    entry = null;
    syncButtons();
    render();
  }

  /* --------------------------------------------------------- copy, save */

  /** The edited picture at full resolution, as PNG bytes. */
  async function exportPng() {
    commitEntry();
    const out = document.createElement("canvas");
    out.width = doc.crop.w;
    out.height = doc.crop.h;
    paint(out.getContext("2d"), 1);
    const blob = await new Promise((resolve) => out.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The picture could not be encoded.");
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function copy() {
    if (!image || busy) return;
    busy = true;
    setStatus("Copying to the clipboard", "busy");
    try {
      await invoke("screenshot_copy", await exportPng());
      setStatus(`Copied to the clipboard - ${doc.crop.w} × ${doc.crop.h}`);
    } catch (error) {
      setStatus(`Could not copy: ${error}`, "error");
    } finally {
      busy = false;
    }
  }

  async function save() {
    if (!image || busy) return;
    busy = true;
    setStatus("Saving to Pictures\\Screenshots", "busy");
    try {
      const path = await invoke("screenshot_save", await exportPng());
      statusLine.className = "shot-status";
      statusLine.textContent = `Saved ${path} `;
      const link = document.createElement("a");
      link.textContent = "Show in folder";
      link.addEventListener("click", () => {
        setStatus("Opening Explorer", "busy");
        invoke("screenshot_reveal", { path })
          .then(() => setStatus(`Saved ${path}`))
          .catch((error) => setStatus(String(error), "error"));
      });
      statusLine.appendChild(link);
    } catch (error) {
      setStatus(`Could not save: ${error}`, "error");
    } finally {
      busy = false;
    }
  }
  $("#copy").addEventListener("click", copy);
  $("#save").addEventListener("click", save);

  /* ------------------------------------------------------------ window */

  $("#close").addEventListener("click", () => win.close());
  $("#min").addEventListener("click", () => win.minimize().catch(() => {}));
  $("#max").addEventListener("click", () => win.toggleMaximize().catch(() => {}));
  const head = document.querySelector("[data-drag-region]");
  head.addEventListener("pointerdown", (event) => {
    if (event.button === 0 && !event.target.closest("button")) win.startDragging().catch(() => {});
  });
  head.addEventListener("dblclick", (event) => {
    if (!event.target.closest("button")) win.toggleMaximize().catch(() => {});
  });

  document.addEventListener("keydown", (event) => {
    if (event.target.closest?.("textarea, input, select")) return;
    const key = event.key.toLowerCase();
    if (event.ctrlKey && !event.altKey) {
      if (key === "z" && !event.shiftKey) step(-1);
      else if (key === "y" || (key === "z" && event.shiftKey)) step(1);
      else if (key === "c") copy();
      else if (key === "s") save();
      else if (key === "w") win.close();
      else return;
      event.preventDefault();
      return;
    }
    if (event.altKey || event.metaKey) return;
    if (event.key === "Escape") {
      if (draft) { draft = null; render(); }
      else if (selected()) select(null);
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selected()) {
      event.preventDefault();
      removeSelected();
      return;
    }
    if (event.key === "Enter" && selected()?.type === "text") {
      event.preventDefault();
      const shape = selected();
      openEntry({ x: shape.x, y: shape.y }, shape);
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[event.key] && selected()) {
      event.preventDefault();
      // One screen pixel at a time, ten with Shift.
      const stepSize = slop(event.shiftKey ? 10 : 1);
      nudge(arrows[event.key][0] * stepSize, arrows[event.key][1] * stepSize);
      return;
    }
    if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey) {
      event.preventDefault();
      setView(view === "fit" ? "full" : "fit");
      return;
    }
    if (KEYS[key]) { setTool(KEYS[key]); event.preventDefault(); }
  });

  /* -------------------------------------------------------------- load */

  async function load() {
    syncButtons();
    setStatus("Loading the screenshot", "busy");
    try {
      const bytes = await invoke("screenshot_image", { id });
      image = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      doc = { crop: { x: 0, y: 0, w: image.width, h: image.height }, shapes: [] };
      history = [];
      at = -1;
      commit();
      $("#loading").hidden = true;
      fit();
      setStatus("Select (V), Crop (C), Arrow (A), Circle (O), Highlight (H), Text (T) - click an item to move, resize or delete it - then Copy (Ctrl+C) or Save (Ctrl+S)");
    } catch (error) {
      $("#loading").textContent = "The screenshot could not be loaded.";
      setStatus(`Could not load the screenshot: ${error}`, "error");
    }
  }
  load();
})();
