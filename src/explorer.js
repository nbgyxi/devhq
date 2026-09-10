(() => {
const invoke = window.__TAURI__.core.invoke;
const icon = (name) => window.wintShell?.icon(name) || `<span class="ms">${name}</span>`;
const esc = (value) => window.wintShell?.esc(value) || String(value ?? "");
const dirty = () => window.wintShell?.markDirty("explorer");

/** Every extension the type filter knows, grouped the way a person looks for
 *  files: by what they would open it with, not by the byte layout. Anything
 *  unlisted lands in "Other", which stays a real bucket with a real count
 *  rather than a silent remainder. */
const KINDS = [
  { id: "folder", name: "Folders", icon: "folder", ext: "" },
  { id: "image", name: "Images", icon: "image", ext: "png jpg jpeg gif webp svg bmp ico avif heic heif tif tiff psd ai" },
  { id: "video", name: "Video", icon: "movie", ext: "mp4 mkv mov avi webm wmv m4v mpg mpeg flv" },
  { id: "audio", name: "Audio", icon: "music_note", ext: "mp3 wav flac ogg m4a aac wma aiff opus mid" },
  { id: "document", name: "Documents", icon: "description", ext: "pdf doc docx odt rtf txt md markdown epub tex" },
  { id: "sheet", name: "Sheets", icon: "table", ext: "xls xlsx xlsm ods csv tsv" },
  { id: "slides", name: "Slides", icon: "slideshow", ext: "ppt pptx odp key" },
  { id: "code", name: "Code", icon: "code", ext: "js mjs cjs ts tsx jsx vue svelte rs go py rb php java kt swift c h cc cpp hpp cs sql html htm css scss sass less json yaml yml toml xml ini cfg conf env sh bash ps1 psm1 bat cmd lua pl dart gradle" },
  { id: "archive", name: "Archives", icon: "folder_zip", ext: "zip 7z rar tar gz tgz bz2 xz zst cab iso" },
  { id: "program", name: "Programs", icon: "terminal", ext: "exe msi msix appx dll sys com scr lnk" },
  { id: "data", name: "Data", icon: "database", ext: "db sqlite sqlite3 mdb log dat bin pack idx lock" },
  { id: "font", name: "Fonts", icon: "font_download", ext: "ttf otf woff woff2 eot" },
  { id: "other", name: "Other", icon: "draft", ext: "" },
];
const KIND_OF = new Map();
for (const kind of KINDS) {
  for (const ext of kind.ext.split(" ").filter(Boolean)) KIND_OF.set(ext, kind.id);
}
const kindById = (id) => KINDS.find((kind) => kind.id === id) || KINDS[KINDS.length - 1];
const kindOf = (entry) => (entry.isDir ? "folder" : KIND_OF.get(entry.ext) || "other");

const COLUMNS = [
  { id: "name", label: "Name" },
  { id: "type", label: "Type" },
  { id: "size", label: "Size" },
  { id: "modified", label: "Modified" },
];

/** "This PC" is a place, not a path: it is the drive list, and there is no
 *  folder behind it. The empty string carries that everywhere `fx.path` goes;
 *  the markup needs a non-empty stand-in because an empty data attribute
 *  cannot be told apart from a missing one. */
const THIS_PC = "";
const THIS_PC_KEY = "@this-pc";
const asPath = (value) => (value === THIS_PC_KEY ? THIS_PC : value);

const fx = {
  host: null, roots: [], loadingRoots: false, rootsError: "", bookmarks: [],
  /** path -> { entries, error, loading } for every branch the tree has read. */
  tree: new Map(),
  open: new Set(),
  path: "", listing: null, loading: false, error: "",
  history: [], forward: [],
  filter: "", kinds: new Set(), exts: new Set(),
  sort: "name", desc: false, showHidden: false, typesOpen: false,
  thumbsOn: false, previewPane: false,
  /** The row the preview pane is showing. Only files are ever selected: a
   *  folder click opens it, which is the whole point of the list. */
  selected: "", previewUrl: "", previewLoading: false,
  /** path -> data URL, or "" for a file Windows has no thumbnail for. Kept
   *  across re-sorts and re-filters so turning preview off and on again does
   *  not ask Windows for the same pictures a second time. */
  thumbs: new Map(),
};

/** Which kinds get a picture. Windows will thumbnail far more than this, but a
 *  preview row is for seeing which photo is which - a generic first-page
 *  render of a document says less than the type icon it would replace. */
const PREVIEW_KINDS = new Set(["image"]);
/** Asked for at twice the size it is drawn, so the row thumbnail stays sharp
 *  on a high-DPI screen. Windows serves both out of the same cache. */
const THUMB_PX = 128;
const THUMB_DRAWN = 64;
/** The side pane draws big, so it asks Windows for a big one. Still a
 *  thumbnail rather than the file itself: a 40 megapixel photograph does not
 *  need to cross the bridge to be looked at in a 500 pixel panel. */
const PREVIEW_PX = 1024;

const TRANSFER_KEY = "wint.explorer.popout.v1";
let popoutHandoff = false;
window.addEventListener("storage", (event) => {
  if (event.key === TRANSFER_KEY && event.newValue === null) popoutHandoff = false;
});
function saveTransfer() {
  if (!popoutHandoff) return;
  try { localStorage.setItem(TRANSFER_KEY, JSON.stringify({ savedAt: Date.now(), state: exportState() })); }
  catch (_) { /* The pop-out can still open at the same folder without it. */ }
}

const bytes = (n) => {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** i;
  return `${value.toFixed(i && value < 10 ? 1 : 0)} ${units[i]}`;
};
const when = (ms) => {
  if (!ms) return "—";
  const date = new Date(ms);
  const today = new Date();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return `Today ${time}`;
  const sameYear = date.getFullYear() === today.getFullYear();
  const day = date.toLocaleDateString([], { day: "2-digit", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
  return `${day} ${time}`;
};
const typeLabel = (entry) => (entry.isDir ? "Folder" : entry.ext ? `${entry.ext.toUpperCase()} file` : "File");

/** The path split into the pieces the breadcrumb can navigate to. Every piece
 *  is a real path, so clicking one is the same action as clicking a folder. */
const segments = (path) => {
  const parts = String(path || "").split(/[\\/]+/).filter(Boolean);
  const crumbs = [];
  let walked = "";
  for (const part of parts) {
    walked = walked ? `${walked}\\${part}` : (/^[A-Za-z]:$/.test(part) ? `${part}\\` : `\\${part}`);
    crumbs.push({ name: part, path: walked });
  }
  return crumbs;
};
const same = (a, b) => String(a || "").toLowerCase().replace(/\\+$/, "") === String(b || "").toLowerCase().replace(/\\+$/, "");

// ------------------------------------------------------------------- data

async function loadRoots() {
  if (fx.roots.length || fx.loadingRoots) return;
  fx.loadingRoots = true; fx.rootsError = ""; dirty();
  window.wintWork?.beginWork("explorer-roots", "Reading drives and folders");
  try {
    fx.roots = await invoke("explorer_roots");
    if (!fx.roots.length) fx.rootsError = "No drives or user folders were found.";
  } catch (error) { fx.rootsError = String(error); }
  fx.loadingRoots = false;
  window.wintWork?.endWork("explorer-roots");
  dirty();
}

/** Every listing takes its own token, so a slow folder that finishes after the
 *  user has already clicked elsewhere cannot paint its contents over the
 *  folder now on screen. */
let listToken = 0;

async function openFolder(path, { push = true, keepFilter = false } = {}) {
  if (path == null) return;
  if (push && fx.path !== path && !same(fx.path, path)) { fx.history.push(fx.path); fx.forward = []; }
  const token = ++listToken;
  fx.path = path; fx.loading = false; fx.error = "";
  // A filter belongs to the folder it was typed in. Carrying "png" into the
  // next folder would show an empty folder that is not empty.
  if (!keepFilter) { fx.filter = ""; fx.kinds.clear(); fx.exts.clear(); fx.typesOpen = false; }
  if (!same(fx.path, path)) { fx.selected = ""; fx.previewUrl = ""; previewToken += 1; }
  // This PC is drawn from the drive list the tool already holds. There is no
  // folder to read, so it must not go through a listing that would blank the
  // pane and start work the status bar would then have to end.
  if (path === THIS_PC) {
    fx.listing = null;
    fx.open.add(THIS_PC);
    dirty();
    saveTransfer();
    return;
  }
  fx.loading = true;
  dirty();
  window.wintWork?.beginWork("explorer-list", `Reading ${path}`);
  try {
    const listing = await invoke("explorer_list", { path, dirsOnly: false });
    if (token !== listToken) return;
    fx.listing = listing;
    fx.tree.set(listing.path, { entries: listing.entries.filter((entry) => entry.isDir), error: "", loading: false });
    fx.path = listing.path;
  } catch (error) {
    if (token !== listToken) return;
    fx.listing = null;
    fx.error = String(error);
  } finally {
    if (token === listToken) {
      fx.loading = false;
      window.wintWork?.endWork("explorer-list");
      revealInTree(fx.path);
      dirty();
      saveTransfer();
      loadThumbs();
    }
  }
}

/** Opens every ancestor of a folder in the tree. The tree and the list are two
 *  views of one place, and they must never disagree about where the user is. */
function revealInTree(path) {
  fx.open.add(THIS_PC);
  for (const crumb of segments(path)) {
    if (same(crumb.path, path)) break;
    if (!fx.open.has(crumb.path)) { fx.open.add(crumb.path); loadBranch(crumb.path); }
  }
  const root = fx.roots.find((entry) => same(entry.path, path));
  if (root && !fx.open.has(root.path)) { fx.open.add(root.path); loadBranch(root.path); }
}

async function loadBranch(path) {
  // A branch is read once. Already loading counts as read: expanding a folder
  // twice while its first read is in flight must not start a second one.
  const known = fx.tree.get(path);
  if (known && !known.error) return;
  fx.tree.set(path, { entries: known?.entries || [], error: "", loading: true });
  dirty();
  try {
    const listing = await invoke("explorer_list", { path, dirsOnly: true });
    fx.tree.set(path, { entries: listing.entries, error: "", loading: false });
  } catch (error) {
    fx.tree.set(path, { entries: [], error: String(error), loading: false });
  }
  dirty();
}

function toggleBranch(path) {
  if (fx.open.has(path)) fx.open.delete(path);
  else { fx.open.add(path); loadBranch(path); }
  dirty();
}

function goBack() {
  if (!fx.history.length) return;
  fx.forward.push(fx.path);
  openFolder(fx.history.pop(), { push: false });
}

function goForward() {
  if (!fx.forward.length) return;
  fx.history.push(fx.path);
  openFolder(fx.forward.pop(), { push: false });
}

function goUp() {
  if (fx.path === THIS_PC) return;
  openFolder(fx.listing?.parent ?? THIS_PC);
}

function refresh() {
  if (fx.path === THIS_PC) {
    fx.roots = [];
    loadRoots();
    return;
  }
  fx.tree.delete(fx.path);
  openFolder(fx.path, { push: false, keepFilter: true });
}

// -------------------------------------------------------------- filtering

/** The counts behind the type chips, taken over everything the folder holds
 *  minus the name filter. Counting them after the chips were applied would
 *  make every unselected chip read "0" the moment one chip is on, which turns
 *  the row from a map of the folder into a map of the selection. */
function facets(entries) {
  const kinds = new Map();
  const exts = new Map();
  for (const entry of entries) {
    const kind = kindOf(entry);
    kinds.set(kind, (kinds.get(kind) || 0) + 1);
    if (!entry.isDir) {
      const ext = entry.ext || "—";
      exts.set(ext, (exts.get(ext) || 0) + 1);
    }
  }
  return { kinds, exts };
}

function visible() {
  const all = (fx.listing?.entries || []).filter((entry) => fx.showHidden || !entry.hidden);
  const needle = fx.filter.trim().toLowerCase();
  const named = needle ? all.filter((entry) => entry.name.toLowerCase().includes(needle)) : all;
  const typed = named.filter((entry) => {
    if (fx.kinds.size && !fx.kinds.has(kindOf(entry))) return false;
    if (fx.exts.size && (entry.isDir || !fx.exts.has(entry.ext || "—"))) return false;
    return true;
  });
  const direction = fx.desc ? -1 : 1;
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const shown = [...typed].sort((a, b) => {
    // Folders lead every order. Sorting them in among the files by size or
    // date is sorting them by a number a folder does not have.
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (fx.sort === "size") return direction * (a.bytes - b.bytes) || byName(a, b);
    if (fx.sort === "modified") return direction * (a.modified - b.modified) || byName(a, b);
    if (fx.sort === "type") return direction * (a.ext || "").localeCompare(b.ext || "") || byName(a, b);
    return direction * byName(a, b);
  });
  return { named, shown, total: all.length };
}

async function loadBookmarks() {
  try { fx.bookmarks = await invoke("explorer_bookmarks"); }
  catch (_) { fx.bookmarks = []; }
  dirty();
}

/** Bookmarks live in a file the Rust side owns. Browser storage would not do:
 *  the embedded tool, each pop-out and the main window are separate WebView2
 *  environments, so a list kept there would be a different list in each. */
async function setBookmarks(paths) {
  const before = fx.bookmarks;
  fx.bookmarks = paths;
  dirty();
  try { fx.bookmarks = await invoke("explorer_bookmarks_set", { paths }); }
  catch (error) {
    fx.bookmarks = before;
    window.wintWork?.beginWork("explorer-bookmark", "Bookmarks could not be saved", String(error));
    setTimeout(() => window.wintWork?.endWork("explorer-bookmark"), 4000);
  }
  dirty();
}

function toggleBookmark(path) {
  if (!path || path === THIS_PC) return;
  const has = fx.bookmarks.some((mark) => same(mark, path));
  setBookmarks(has ? fx.bookmarks.filter((mark) => !same(mark, path)) : [...fx.bookmarks, path]);
}

/** Thumbnails arrive one folder at a time and are painted straight into their
 *  row. They deliberately do not go through the normal render: a folder of 200
 *  photographs would otherwise rebuild the whole tool 200 times, and the rule
 *  here is that nothing repaints a region it did not change. */
let thumbToken = 0;

async function loadThumbs() {
  if (!fx.thumbsOn || fx.path === THIS_PC) return;
  const token = ++thumbToken;
  if (fx.thumbs.size > 600) fx.thumbs.clear();
  const wanted = (fx.listing?.entries || [])
    .filter((entry) => !entry.isDir && PREVIEW_KINDS.has(kindOf(entry)) && !fx.thumbs.has(entry.path));
  if (!wanted.length) return;
  window.wintWork?.beginWork("explorer-thumbs", "Reading previews", `0 / ${wanted.length}`);
  let done = 0;
  // Four at a time: enough to keep the shell busy, few enough that a folder of
  // raw photographs cannot flood the bridge with megabytes of data URLs.
  const workers = Array.from({ length: Math.min(4, wanted.length) }, async () => {
    while (token === thumbToken) {
      const entry = wanted.shift();
      if (!entry) return;
      let url = "";
      try { url = (await invoke("explorer_thumbnail", { path: entry.path, size: THUMB_PX })) || ""; }
      catch (_) { url = ""; }
      if (token !== thumbToken) return;
      fx.thumbs.set(entry.path, url);
      paintThumb(entry.path, url);
      done += 1;
      window.wintWork?.updateWork("explorer-thumbs", `${done} / ${done + wanted.length}`);
    }
  });
  await Promise.all(workers);
  if (token === thumbToken) window.wintWork?.endWork("explorer-thumbs");
}

function paintThumb(path, url) {
  if (!url || !fx.host) return;
  const slot = fx.host.querySelector(`.fx-row[data-fx-item="${CSS.escape(path)}"] .fx-thumb`);
  if (!slot) return;
  slot.style.backgroundImage = `url("${url}")`;
  slot.classList.add("has-image");
  // The type icon was only ever a stand-in for the picture. Leaving it behind
  // would print a folder-ish glyph across the middle of the photograph.
  slot.replaceChildren();
}

/** Delete asks first, and the question carries both answers: the Recycle Bin
 *  is the accept button because it is the one that can be undone, and deleting
 *  for good is the deliberate second choice. */
async function askDelete(paths) {
  const targets = paths.filter(Boolean);
  if (!targets.length) return;
  const what = targets.length === 1
    ? segments(targets[0]).slice(-1)[0]?.name || targets[0]
    : `${targets.length} items`;
  const folders = targets.filter((path) => (fx.listing?.entries || []).some((entry) => same(entry.path, path) && entry.isDir));
  const answer = await (window.wintConfirm
    ? window.wintConfirm({
        title: `Delete ${what}?`,
        message: folders.length
          ? `${what} ${targets.length === 1 ? "is a folder, so everything inside it goes too" : "includes folders, so everything inside them goes too"}. The Recycle Bin can be undone; deleting for good cannot.`
          : "The Recycle Bin can be undone from Windows. Deleting for good cannot.",
        confirmLabel: "Move to Recycle Bin",
        alternateLabel: "Delete for good",
        cancelLabel: "Cancel",
        icon: "delete",
        tone: "danger",
      })
    : Promise.resolve(window.confirm(`Move ${what} to the Recycle Bin?`)));
  if (!answer) return;
  const recycle = answer !== "alternate";
  window.wintWork?.beginWork("explorer-delete", recycle ? `Moving ${what} to the Recycle Bin` : `Deleting ${what}`);
  try {
    await invoke("explorer_delete", { paths: targets, recycle });
    // A bookmark pointing at a folder that has just gone is a dead row, so it
    // leaves with the folder rather than waiting to fail on the next click.
    const orphaned = fx.bookmarks.filter((mark) => targets.some((path) => same(path, mark)));
    if (orphaned.length) setBookmarks(fx.bookmarks.filter((mark) => !orphaned.includes(mark)));
    for (const path of targets) { fx.thumbs.delete(path); fx.tree.delete(path); fx.open.delete(path); }
    refresh();
  } catch (error) {
    fx.error = String(error);
    dirty();
  } finally {
    window.wintWork?.endWork("explorer-delete");
  }
}

/** Selecting a file is what fills the preview pane. Folders are never
 *  selected: clicking one opens it, and a pane showing the folder you just
 *  left would be describing somewhere you are no longer standing. */
function select(path) {
  if (fx.selected === path) return;
  fx.selected = path;
  fx.previewUrl = "";
  dirty();
  loadPreview();
}

let previewToken = 0;

async function loadPreview() {
  const path = fx.selected;
  if (!fx.previewPane || !path) return;
  const entry = (fx.listing?.entries || []).find((item) => same(item.path, path));
  if (!entry || entry.isDir || !PREVIEW_KINDS.has(kindOf(entry))) return;
  const token = ++previewToken;
  fx.previewLoading = true;
  dirty();
  let url = "";
  try { url = (await invoke("explorer_thumbnail", { path, size: PREVIEW_PX })) || ""; }
  catch (_) { url = ""; }
  if (token !== previewToken) return;
  fx.previewUrl = url;
  fx.previewLoading = false;
  dirty();
}

function togglePreviewPane() {
  fx.previewPane = !fx.previewPane;
  dirty();
  if (fx.previewPane) loadPreview();
  else { previewToken += 1; fx.previewUrl = ""; }
}

function renderPreviewPane() {
  const entry = (fx.listing?.entries || []).find((item) => same(item.path, fx.selected));
  if (!entry) {
    return `<aside class="fx-preview" aria-label="Preview"><div class="fx-preview-empty">${icon("imagesmode")}<p>Pick a picture in the list to see it here.</p></div></aside>`;
  }
  const showable = !entry.isDir && PREVIEW_KINDS.has(kindOf(entry));
  const body = !showable
    ? `<div class="fx-preview-empty">${icon(kindById(kindOf(entry)).icon)}<p>There is no picture to show for this one.</p></div>`
    : fx.previewUrl
      ? `<img class="fx-preview-image" src="${fx.previewUrl}" alt="${esc(entry.name)}">`
      : fx.previewLoading
        ? `<div class="fx-preview-empty loading">${icon("progress_activity")}<p>Reading the picture…</p></div>`
        : `<div class="fx-preview-empty">${icon("broken_image")}<p>Windows has no preview for this file.</p></div>`;
  return `<aside class="fx-preview" aria-label="Preview">
    <div class="fx-preview-stage">${body}</div>
    <footer class="fx-preview-meta">
      <strong title="${esc(entry.name)}">${esc(entry.name)}</strong>
      <span>${esc(typeLabel(entry))} · ${bytes(entry.bytes)}</span>
      <span>${esc(when(entry.modified))}</span>
    </footer>
  </aside>`;
}

function toggleThumbs() {
  fx.thumbsOn = !fx.thumbsOn;
  dirty();
  if (fx.thumbsOn) loadThumbs();
  else {
    // Stop whatever is still in flight: its rows are gone from the page, and
    // its results would only pile up unseen.
    thumbToken += 1;
    window.wintWork?.endWork("explorer-thumbs");
  }
}

function toggleKind(id) {
  if (fx.kinds.has(id)) fx.kinds.delete(id); else fx.kinds.add(id);
  dirty();
}

function toggleExt(ext) {
  if (fx.exts.has(ext)) fx.exts.delete(ext); else fx.exts.add(ext);
  dirty();
}

function clearFilters() {
  fx.kinds.clear();
  fx.exts.clear();
  fx.filter = "";
  dirty();
}

function sortBy(column) {
  if (fx.sort === column) fx.desc = !fx.desc;
  else { fx.sort = column; fx.desc = column === "size" || column === "modified"; }
  dirty();
}

// ----------------------------------------------------------------- render

function branchRows(path, depth) {
  if (!fx.open.has(path)) return "";
  const branch = fx.tree.get(path);
  if (!branch || (branch.loading && !branch.entries.length)) {
    // A branch still being read draws named skeletons rather than nothing, so
    // it is obvious the arrow worked and the folders are on their way.
    return `<div class="fx-note" style="--depth:${depth}">${icon("progress_activity")}Reading folders…</div>`;
  }
  if (branch.error) return `<div class="fx-note bad" style="--depth:${depth}">${icon("lock")}${esc(branch.error)}</div>`;
  const rows = branch.entries.filter((entry) => fx.showHidden || !entry.hidden);
  if (!rows.length) return `<div class="fx-note" style="--depth:${depth}">No folders in here</div>`;
  return rows.map((entry) => nodeRow(entry, depth)).join("");
}

function nodeRow(entry, depth) {
  const open = fx.open.has(entry.path);
  const here = same(fx.path, entry.path);
  return `<div class="fx-node${here ? " on" : ""}${entry.hidden ? " dim" : ""}" style="--depth:${depth}">
    <button class="fx-twist${entry.hasChildren ? "" : " leaf"}" type="button" data-fx-twist="${esc(entry.path)}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} ${esc(entry.name)}" tabindex="-1">${entry.hasChildren ? icon(open ? "expand_more" : "chevron_right") : ""}</button>
    <button class="fx-node-btn" type="button" data-fx-open="${esc(entry.path)}" title="${esc(entry.path)}">${icon(open || here ? "folder_open" : "folder")}<span>${esc(entry.name)}</span></button>
  </div>${branchRows(entry.path, depth + 1)}`;
}

function driveRow(root) {
  const open = fx.open.has(root.path);
  const here = same(fx.path, root.path);
  const used = root.totalBytes ? ((root.totalBytes - root.freeBytes) / root.totalBytes) * 100 : 0;
  return `<div class="fx-node${here ? " on" : ""}" style="--depth:1">
    <button class="fx-twist" type="button" data-fx-twist="${esc(root.path)}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} ${esc(root.label)}" tabindex="-1">${icon(open ? "expand_more" : "chevron_right")}</button>
    <button class="fx-node-btn" type="button" data-fx-open="${esc(root.path)}" title="${esc(root.path)}">${icon(root.icon)}<span>${esc(root.label)}</span>${root.totalBytes ? `<i class="fx-gauge" title="${bytes(root.freeBytes)} free of ${bytes(root.totalBytes)}"><em style="width:${used.toFixed(1)}%"></em></i>` : ""}</button>
  </div>${branchRows(root.path, 2)}`;
}

function renderTree() {
  if (fx.loadingRoots && !fx.roots.length) return `<div class="fx-note" style="--depth:0">${icon("progress_activity")}Reading drives…</div>`;
  const open = fx.open.has(THIS_PC);
  const here = fx.path === THIS_PC;
  const drives = fx.loadingRoots && !fx.roots.length
    ? `<div class="fx-note" style="--depth:1">${icon("progress_activity")}Reading drives…</div>`
    : fx.roots.length
      ? fx.roots.map(driveRow).join("")
      : `<div class="fx-note bad" style="--depth:1">${esc(fx.rootsError || "No drives were found.")}</div>`;
  return `<div class="fx-node${here ? " on" : ""}" style="--depth:0">
      <button class="fx-twist" type="button" data-fx-twist="${THIS_PC_KEY}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} This PC" tabindex="-1">${icon(open ? "expand_more" : "chevron_right")}</button>
      <button class="fx-node-btn" type="button" data-fx-open="${THIS_PC_KEY}" title="Every drive on this machine">${icon("computer")}<span>This PC</span></button>
    </div>${open ? drives : ""}`;
}

/** Bookmarks sit in their own section under the tree rather than among the
 *  drives: they are shortcuts to somewhere already in the tree, and mixing the
 *  two would put the same folder on screen twice with no way to tell which
 *  one you are looking at. */
function renderBookmarks() {
  const rows = fx.bookmarks.map((path) => {
    const here = same(fx.path, path);
    const name = segments(path).slice(-1)[0]?.name || path;
    return `<div class="fx-node${here ? " on" : ""}" style="--depth:0">
      <button class="fx-node-btn" type="button" data-fx-open="${esc(path)}" data-fx-bookmarked="1" title="${esc(path)}">${icon("folder_special")}<span>${esc(name)}</span></button>
      <button class="fx-unpin" type="button" data-fx-unbookmark="${esc(path)}" title="Remove ${esc(name)} from bookmarks" aria-label="Remove ${esc(name)} from bookmarks">${icon("close")}</button>
    </div>`;
  }).join("");
  const canAdd = fx.path !== THIS_PC && fx.path && !fx.bookmarks.some((path) => same(path, fx.path));
  return `<div class="fx-marks">
    <div class="fx-tree-label">Bookmarks<button class="fx-mark-add" type="button" data-fx-bookmark title="Bookmark this folder" ${canAdd ? "" : "disabled"}>${icon("add")}</button></div>
    ${rows || `<p class="fx-marks-none">Open a folder and press + to keep it here.</p>`}
  </div>`;
}

function renderChips(counts) {
  const chips = KINDS.filter((kind) => counts.kinds.get(kind.id)).map((kind) => {
    const on = fx.kinds.has(kind.id);
    return `<button class="fx-chip${on ? " on" : ""}" type="button" data-fx-kind="${kind.id}" aria-pressed="${on}">${icon(kind.icon)}${kind.name}<b>${counts.kinds.get(kind.id)}</b></button>`;
  }).join("");
  return chips || `<span class="fx-chip-none">Nothing to filter — this folder is empty.</span>`;
}

function renderTypes(counts) {
  const rows = [...counts.exts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([ext, count]) => {
      const on = fx.exts.has(ext);
      const kind = kindById(KIND_OF.get(ext) || "other");
      return `<button class="fx-type${on ? " on" : ""}" type="button" data-fx-ext="${esc(ext)}" aria-pressed="${on}">
        <span class="fx-tick">${on ? icon("check") : ""}</span>${icon(kind.icon)}<strong>${ext === "—" ? "No extension" : `.${esc(ext)}`}</strong><b>${count}</b></button>`;
    }).join("");
  return `<div class="fx-types" role="group" aria-label="Filter by file extension">
    <header>Every extension in this folder<button class="fx-type-clear" type="button" data-fx-clear-ext ${fx.exts.size ? "" : "disabled"}>Clear</button></header>
    <div class="fx-type-list">${rows || `<p class="fx-type-empty">This folder holds no files, only folders.</p>`}</div>
  </div>`;
}

function driveRows() {
  if (fx.loadingRoots && !fx.roots.length) {
    return Array.from({ length: 3 }, (_, index) => `<div class="fx-row skeleton" style="--i:${index}"><span class="fx-cell name"><i></i></span><span class="fx-cell type"><i></i></span><span class="fx-cell size"><i></i></span><span class="fx-cell modified"><i></i></span></div>`).join("");
  }
  if (!fx.roots.length) {
    return `<div class="fx-empty">${icon("hard_drive")}<strong>${esc(fx.rootsError || "No drives were found.")}</strong><button class="btn" type="button" data-fx-refresh>${icon("refresh")}Look again</button></div>`;
  }
  return fx.roots.map((root) => {
    const used = root.totalBytes ? ((root.totalBytes - root.freeBytes) / root.totalBytes) * 100 : 0;
    // A drive is worth showing as a bar: "743 GB" says nothing on its own,
    // while a bar three quarters full is the reason you opened this at all.
    return `<div class="fx-row dir drive" tabindex="0" role="row" data-fx-item="${esc(root.path)}" data-fx-dir="true" title="${esc(root.path)}">
      <span class="fx-cell name">${icon("hard_drive")}<strong>${esc(root.label)}</strong><i class="fx-gauge wide${used > 90 ? " full" : ""}"><em style="width:${used.toFixed(1)}%"></em></i></span>
      <span class="fx-cell type">Local disk</span>
      <span class="fx-cell size">${bytes(root.totalBytes)}</span>
      <span class="fx-cell modified">${bytes(root.freeBytes)} free</span>
    </div>`;
  }).join("");
}

function renderRows(shown) {
  if (fx.path === THIS_PC) return driveRows();
  if (fx.loading) {
    return Array.from({ length: 10 }, (_, index) => `<div class="fx-row skeleton" style="--i:${index}"><span class="fx-cell name"><i></i></span><span class="fx-cell type"><i></i></span><span class="fx-cell size"><i></i></span><span class="fx-cell modified"><i></i></span></div>`).join("");
  }
  if (fx.error) {
    return `<div class="fx-empty">${icon("lock")}<strong>${esc(fx.error)}</strong><p>Pick another folder on the left, or hand this one to Windows Explorer.</p><button class="btn" type="button" data-fx-reveal="${esc(fx.path)}">${icon("folder_open")}Open in Windows Explorer</button></div>`;
  }
  if (!fx.path) {
    return `<div class="fx-empty">${icon("folder_open")}<strong>Pick a folder on the left</strong><p>Files shows one folder at a time, with a filter that already knows every type it holds.</p></div>`;
  }
  if (!shown.length) {
    const filtered = fx.filter || fx.kinds.size || fx.exts.size;
    return `<div class="fx-empty">${icon(filtered ? "filter_alt_off" : "folder_open")}<strong>${filtered ? "Nothing here matches the filter" : "This folder is empty"}</strong>${filtered ? `<button class="btn" type="button" data-fx-clear>${icon("close")}Clear the filter</button>` : ""}</div>`;
  }
  return shown.map((entry) => {
    const kind = kindOf(entry);
    const thumb = fx.thumbs.get(entry.path);
    const slot = fx.thumbsOn && !entry.isDir && PREVIEW_KINDS.has(kind)
      ? `<span class="fx-thumb${thumb ? " has-image" : ""}"${thumb ? ` style="background-image:url('${thumb}')"` : ""}>${thumb ? "" : icon(kindById(kind).icon)}</span>`
      : icon(entry.isDir ? "folder" : kindById(kind).icon);
    return `<div class="fx-row${entry.isDir ? " dir" : ""}${entry.hidden ? " dim" : ""}${same(fx.selected, entry.path) ? " picked" : ""}" tabindex="0" role="row" data-fx-item="${esc(entry.path)}" data-fx-dir="${entry.isDir}" title="${esc(entry.path)}">
    <span class="fx-cell name">${slot}<strong>${esc(entry.name)}</strong>${entry.readonly ? `<em class="fx-tag" title="Read-only">${icon("lock")}</em>` : ""}</span>
    <span class="fx-cell type">${esc(typeLabel(entry))}</span>
    <span class="fx-cell size">${entry.isDir ? "" : bytes(entry.bytes)}</span>
    <span class="fx-cell modified">${esc(when(entry.modified))}</span>
  </div>`;
  }).join("");
}

function render() {
  if (!fx.host) return;
  const live = fx.host.querySelector(".fx-search input");
  const typing = live === document.activeElement;
  const caret = typing ? live.selectionStart ?? fx.filter.length : 0;
  const { named, shown, total } = visible();
  const counts = facets(named);
  const crumbs = [{ name: "This PC", path: THIS_PC_KEY }, ...segments(fx.path)]
    .map((crumb) => `<button class="fx-crumb${crumb.path === THIS_PC_KEY && fx.path === THIS_PC ? " on" : ""}" type="button" data-fx-open="${esc(crumb.path)}">${esc(crumb.name)}</button>`)
    .join(`<span class="fx-crumb-sep">${icon("chevron_right")}</span>`);
  const filtering = fx.filter || fx.kinds.size || fx.exts.size;
  fx.host.innerHTML = `<header class="tool-head"><button class="btn back tool-back" type="button" data-open-tool="overview">${icon("arrow_back")}Back</button><span class="tool-plate">${icon("folder_open")}</span><span class="tool-title"><strong>Files</strong><small>browse a folder and filter it by type in one click</small></span><button class="tool-popout" type="button" data-popout-tool="explorer"></button><button class="tool-pin" type="button" data-pin-tool="explorer"></button><button class="tool-close" type="button" data-open-tool="overview">${icon("close")}</button></header>
  <div class="fx-body${fx.previewPane ? " with-preview" : ""}">
    <aside class="fx-side">
      <div class="fx-tree" aria-label="Folders">${renderTree()}</div>
      ${renderBookmarks()}
    </aside>
    <section class="fx-main">
      <div class="fx-bar">
        <button class="fx-nav" type="button" data-fx-back title="Back" aria-label="Back" ${fx.history.length ? "" : "disabled"}>${icon("arrow_back")}</button>
        <button class="fx-nav" type="button" data-fx-forward title="Forward" aria-label="Forward" ${fx.forward.length ? "" : "disabled"}>${icon("arrow_forward")}</button>
        <button class="fx-nav" type="button" data-fx-up title="Up one folder" aria-label="Up one folder" ${fx.path === THIS_PC ? "disabled" : ""}>${icon("arrow_upward")}</button>
        <button class="fx-nav" type="button" data-fx-refresh title="${fx.path === THIS_PC ? "Read the drives again" : "Read this folder again"}" aria-label="Refresh">${icon("refresh")}</button>
        <nav class="fx-crumbs" aria-label="Path">${crumbs || `<span class="fx-crumb-none">No folder open</span>`}</nav>
        <label class="fx-search">${icon("search")}<input type="text" placeholder="Filter by name" aria-label="Filter by name"></label>
        <button class="fx-nav${fx.thumbsOn ? " on" : ""}" type="button" data-fx-thumbs aria-pressed="${fx.thumbsOn}" title="${fx.thumbsOn ? "Back to plain rows" : "Show a picture on every image row"}" aria-label="Thumbnails">${icon("photo_library")}</button>
        <button class="fx-nav${fx.previewPane ? " on" : ""}" type="button" data-fx-preview aria-pressed="${fx.previewPane}" title="${fx.previewPane ? "Close the preview panel" : "Open a preview panel beside the list"}" aria-label="Preview panel">${icon("preview")}</button>
        <button class="fx-nav${fx.showHidden ? " on" : ""}" type="button" data-fx-hidden aria-pressed="${fx.showHidden}" title="${fx.showHidden ? "Hide hidden and system items" : "Show hidden and system items"}" aria-label="Hidden items">${icon(fx.showHidden ? "visibility" : "visibility_off")}</button>
      </div>
      ${fx.path === THIS_PC ? "" : `<div class="fx-chips">${renderChips(counts)}
        <button class="fx-chip more${fx.typesOpen ? " on" : ""}${fx.exts.size ? " picked" : ""}" type="button" data-fx-types aria-expanded="${fx.typesOpen}">${icon("filter_alt")}${fx.exts.size ? `${fx.exts.size} extension${fx.exts.size === 1 ? "" : "s"}` : "By extension"}${icon(fx.typesOpen ? "expand_less" : "expand_more")}</button>
        ${filtering ? `<button class="fx-chip clear" type="button" data-fx-clear>${icon("close")}Clear</button>` : ""}
      </div>`}
      ${fx.typesOpen && fx.path !== THIS_PC ? renderTypes(counts) : ""}
      <div class="fx-list${fx.thumbsOn ? " preview" : ""}">
        <div class="fx-row head${fx.path === THIS_PC ? " static" : ""}">${COLUMNS.map((column) => `<button class="fx-cell ${column.id} sort${fx.sort === column.id ? " on" : ""}" type="button" data-fx-sort="${column.id}">${column.label}${fx.sort === column.id ? icon(fx.desc ? "arrow_downward" : "arrow_upward") : ""}</button>`).join("")}</div>
        <div class="fx-rows">${renderRows(shown)}</div>
      </div>
      <footer class="fx-foot">
        <span>${fx.path === THIS_PC
          ? `${fx.roots.length} drive${fx.roots.length === 1 ? "" : "s"}`
          : fx.loading ? `${icon("progress_activity")}Reading this folder…`
          : `${shown.length}${shown.length === total ? "" : ` of ${total}`} item${shown.length === 1 ? "" : "s"}`}</span>
        ${fx.listing?.skipped ? `<span title="Windows would not report these">${icon("warning")}${fx.listing.skipped} could not be read</span>` : ""}
        <span class="fx-foot-hint">${icon("mouse")}Double-click to open · right-click for more</span>
      </footer>
    </section>
    ${fx.previewPane ? renderPreviewPane() : ""}
  </div>`;
  const pin = fx.host.querySelector('.tool-pin[data-pin-tool="explorer"]');
  const pop = fx.host.querySelector('.tool-popout[data-popout-tool="explorer"]');
  if (pin) {
    const on = !!window.wintShell?.isToolPinned?.("explorer");
    pin.classList.toggle("on", on);
    pin.setAttribute("aria-pressed", String(on));
    pin.innerHTML = `${icon("push_pin")}${on ? "Pinned" : "Pin to dock"}`;
  }
  if (pop) {
    const out = !!window.wintShell?.isToolPopped?.("explorer");
    pop.classList.toggle("on", out);
    pop.innerHTML = `${icon("open_in_new")}${out ? "Show window" : "Pop out"}`;
  }
  // The whole toolbar is rebuilt on every paint, so the name filter's value,
  // focus and caret have to be put back or typing into it would lose a letter
  // and jump to the end on every keystroke.
  const search = fx.host.querySelector(".fx-search input");
  if (search) {
    search.value = fx.filter;
    if (typing) { search.focus(); search.setSelectionRange(caret, caret); }
  }
}

// ----------------------------------------------------------------- wiring

function activate(path, isDir) {
  if (isDir) openFolder(path);
  // `explorer <file>` is what a double-click in Windows does: it hands the
  // file to whatever program owns its type, without this app deciding.
  else invoke("open_in", { path, target: "explorer" }).catch(() => {});
}

function closeContext() { document.querySelector(".fx-context")?.remove(); }

function mount(host) {
  fx.host = host;
  host.addEventListener("click", (event) => {
    const pop = event.target.closest("[data-popout-tool]");
    const pin = event.target.closest("[data-pin-tool]");
    const go = event.target.closest("[data-open-tool]");
    if (pop) return window.wintShell?.popOutTool?.(pop.dataset.popoutTool);
    if (pin) return window.wintShell?.toggleToolPin?.(pin.dataset.pinTool);
    if (go) return window.wintShell?.openTool?.(go.dataset.openTool);
    const twist = event.target.closest("[data-fx-twist]");
    if (twist) return toggleBranch(asPath(twist.dataset.fxTwist));
    const unmark = event.target.closest("[data-fx-unbookmark]");
    if (unmark) return toggleBookmark(unmark.dataset.fxUnbookmark);
    if (event.target.closest("[data-fx-bookmark]")) return toggleBookmark(fx.path);
    const open = event.target.closest("[data-fx-open]");
    if (open) return void openFolder(asPath(open.dataset.fxOpen));
    const kind = event.target.closest("[data-fx-kind]");
    if (kind) return toggleKind(kind.dataset.fxKind);
    const ext = event.target.closest("[data-fx-ext]");
    if (ext) return toggleExt(ext.dataset.fxExt);
    const sort = event.target.closest("[data-fx-sort]");
    if (sort) return sortBy(sort.dataset.fxSort);
    const reveal = event.target.closest("[data-fx-reveal]");
    if (reveal) return void invoke("open_in", { path: reveal.dataset.fxReveal, target: "explorer" }).catch(() => {});
    if (event.target.closest("[data-fx-back]")) return goBack();
    if (event.target.closest("[data-fx-forward]")) return goForward();
    if (event.target.closest("[data-fx-up]")) return goUp();
    if (event.target.closest("[data-fx-refresh]")) return refresh();
    if (event.target.closest("[data-fx-clear-ext]")) { fx.exts.clear(); return dirty(); }
    if (event.target.closest("[data-fx-clear]")) return clearFilters();
    if (event.target.closest("[data-fx-types]")) { fx.typesOpen = !fx.typesOpen; return dirty(); }
    if (event.target.closest("[data-fx-hidden]")) { fx.showHidden = !fx.showHidden; return dirty(); }
    if (event.target.closest("[data-fx-thumbs]")) return toggleThumbs();
    if (event.target.closest("[data-fx-preview]")) return togglePreviewPane();
    // One click opens a folder - that is the whole job of this tool. Files
    // wait for the second click, because opening a program by accident is a
    // worse mistake than an extra click.
    const row = event.target.closest("[data-fx-item]");
    if (row) {
      if (row.dataset.fxDir === "true") openFolder(row.dataset.fxItem);
      else select(row.dataset.fxItem);
    }
  });
  host.addEventListener("dblclick", (event) => {
    const row = event.target.closest("[data-fx-item]");
    if (row) activate(row.dataset.fxItem, row.dataset.fxDir === "true");
  });
  host.addEventListener("keydown", (event) => {
    const row = event.target.closest("[data-fx-item]");
    if (row && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      activate(row.dataset.fxItem, row.dataset.fxDir === "true");
      return;
    }
    if (row && event.key === "Delete") {
      event.preventDefault();
      askDelete([row.dataset.fxItem]);
      return;
    }
    if (event.key === "Escape" && event.target.closest(".fx-search") && fx.filter) {
      fx.filter = "";
      dirty();
    }
  });
  host.addEventListener("input", (event) => {
    if (!event.target.closest(".fx-search")) return;
    fx.filter = event.target.value;
    dirty();
  });
  // The mouse's fourth and fifth buttons are Back and Forward everywhere else
  // in Windows, and in a file browser they mean the previous folder. The
  // webview would otherwise try to walk its own page history, which in a
  // one-page tool does nothing at all - so every phase is swallowed and only
  // the release acts, the way a click works.
  for (const type of ["mousedown", "mouseup", "auxclick"]) {
    host.addEventListener(type, (event) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (type !== "mouseup") return;
      if (event.button === 3) goBack();
      else goForward();
    });
  }
  host.addEventListener("contextmenu", (event) => {
    const target = event.target.closest("[data-fx-item], [data-fx-open]");
    if (!target) return;
    event.preventDefault();
    const path = asPath(target.dataset.fxItem || target.dataset.fxOpen);
    if (path === THIS_PC) return;
    const isDir = target.dataset.fxDir !== "false";
    const marked = fx.bookmarks.some((mark) => same(mark, path));
    closeContext();
    const menu = document.createElement("div");
    menu.className = "fx-context";
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    menu.innerHTML = `<button type="button" data-do="open">${icon(isDir ? "folder_open" : "open_in_new")}${isDir ? "Open folder" : "Open file"}</button>
      <button type="button" data-do="reveal">${icon("frame_inspect")}Show in Windows Explorer</button>
      <button type="button" data-do="terminal">${icon("terminal")}Open a shell here</button>
      <button type="button" data-do="copy">${icon("content_copy")}Copy path</button>
      ${isDir ? `<button type="button" data-do="bookmark">${icon(marked ? "bookmark_remove" : "bookmark_add")}${marked ? "Remove from bookmarks" : "Add to bookmarks"}</button>` : ""}
      <button type="button" class="danger" data-do="delete">${icon("delete")}Delete…</button>`;
    menu.addEventListener("click", (click) => {
      const action = click.target.closest("[data-do]")?.dataset.do;
      menu.remove();
      if (action === "open") activate(path, isDir);
      else if (action === "reveal") invoke("open_in", { path, target: "reveal" }).catch(() => {});
      else if (action === "terminal") invoke("open_in", { path: isDir ? path : fx.path, target: "terminal" }).catch(() => {});
      else if (action === "copy") navigator.clipboard?.writeText(path).catch(() => {});
      else if (action === "bookmark") toggleBookmark(path);
      else if (action === "delete") askDelete([path]);
    });
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener("click", closeContext, { once: true }), 0);
  });
  render();
}

async function opened() {
  fx.open.add(THIS_PC);
  // The drive list is the first thing on screen, so it is fetched first and
  // the bookmarks fill in beside it rather than holding it up.
  const drives = loadRoots();
  loadBookmarks();
  await drives;
  // A folder listed before the tool was handed to another window is stale by
  // definition - files move while a window is closed - so re-read it.
  if (fx.path !== THIS_PC && !fx.loading) openFolder(fx.path, { push: false, keepFilter: true });
  else dirty();
}

function preparePopout() {
  popoutHandoff = true;
  saveTransfer();
}

function exportState() {
  return {
    roots: fx.roots, bookmarks: fx.bookmarks, path: fx.path, listing: fx.listing, error: fx.error,
    open: [...fx.open], history: fx.history, forward: fx.forward,
    filter: fx.filter, kinds: [...fx.kinds], exts: [...fx.exts],
    sort: fx.sort, desc: fx.desc, showHidden: fx.showHidden, typesOpen: fx.typesOpen,
    thumbsOn: fx.thumbsOn, previewPane: fx.previewPane,
  };
}

/** `loading` is deliberately not carried across: it describes a listing running
 *  in a webview that is gone, whose result can never arrive, and restoring it
 *  true would show skeletons nothing will ever replace. `opened` re-reads the
 *  folder instead. */
function importState(state) {
  if (!state) return;
  fx.roots = state.roots || [];
  fx.bookmarks = state.bookmarks || [];
  fx.path = state.path || THIS_PC;
  fx.listing = state.listing || null;
  fx.error = state.error || "";
  fx.open = new Set(state.open || []);
  fx.history = state.history || [];
  fx.forward = state.forward || [];
  fx.filter = state.filter || "";
  fx.kinds = new Set(state.kinds || []);
  fx.exts = new Set(state.exts || []);
  fx.sort = state.sort || "name";
  fx.desc = !!state.desc;
  fx.showHidden = !!state.showHidden;
  fx.typesOpen = !!state.typesOpen;
  fx.thumbsOn = !!state.thumbsOn;
  fx.previewPane = !!state.previewPane;
  fx.loading = false;
  if (fx.listing) fx.tree.set(fx.path, { entries: fx.listing.entries.filter((entry) => entry.isDir), error: "", loading: false });
  if (fx.host) render();
}

try {
  const transfer = JSON.parse(localStorage.getItem(TRANSFER_KEY) || "null");
  if (transfer && Date.now() - transfer.savedAt < 30000) {
    importState(transfer.state);
    localStorage.removeItem(TRANSFER_KEY);
  }
} catch (_) { /* An empty explorer is a safe start when storage is unavailable. */ }

window.wintExplorer = { mount, render, opened, preparePopout, exportState, importState };
})();
