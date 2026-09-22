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
const kindOf = (entry) => {
  if (entry.isArchive) return "archive";
  if (entry.isDir) return "folder";
  return KIND_OF.get(entry.ext) || "other";
};

const COLUMNS = [
  { id: "name", label: "Name" },
  { id: "type", label: "Type" },
  { id: "size", label: "Size" },
  { id: "modified", label: "Modified" },
  { id: "created", label: "Date created" },
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
  /** Fixed widths for the tree and the preview. The browse list fills what is
   *  left. Remembered across windows the same way bookmarks are. */
  sideWidth: 268, previewWidth: 320,
  columnWidths: { name: 320, type: 130, size: 92, modified: 148, created: 148 },
  createdColumn: false,
  /** Focused row plus the complete multi-selection. The focused file, when
   *  there is one, is what the preview pane shows. */
  selected: "", selectedPaths: new Set(), selectionAnchor: "", previewUrl: "", previewLoading: false,
  /** After Back/Up, the child folder you came from - selected and scrolled into
   *  view once the list has painted, so a resized window still lands correctly. */
  pendingFocus: "",
  /** path -> data URL, or "" for a file Windows has no thumbnail for. Kept
   *  across re-sorts and re-filters so turning preview off and on again does
   *  not ask Windows for the same pictures a second time. */
  thumbs: new Map(),
  /** The row being renamed in place: { path, draft, fresh }. */
  rename: null,
  /** Paths cut to the clipboard from this window, drawn faded until pasted. */
  cut: [],
};

const SIDE_MIN = 64;
const SIDE_MAX = 1200;
const PREVIEW_MIN = 64;
const PREVIEW_MAX = 1200;
const MAIN_MIN = 96;
const SPLIT_W = 5;
const visibleColumns = () => COLUMNS.filter((column) => column.id !== "created" || fx.createdColumn);
const columnTemplate = () => visibleColumns().map((column) => `${fx.columnWidths[column.id]}px`).join(" ");
const columnTableWidth = () => visibleColumns().reduce((width, column) => width + fx.columnWidths[column.id], 0)
  + Math.max(0, visibleColumns().length - 1) * 10 + 48;

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
const ROW_PX = 31;
const THUMB_ROW_PX = 84;
const VIRTUAL_AFTER = 1000;
const VIRTUAL_OVERSCAN = 12;

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
const typeLabel = (entry) => {
  if (entry.isArchive) return "Zip archive";
  if (entry.isDir) return "Folder";
  return entry.ext ? `${entry.ext.toUpperCase()} file` : "File";
};

/** `C:\pack.zip\docs` → archive + path inside it. A zip is the longest
 *  `*.zip` prefix; everything after is virtual. */
function splitZipPath(path) {
  const normalized = String(path || "").replace(/\//g, "\\");
  const lower = normalized.toLowerCase();
  let from = 0;
  while (from < lower.length) {
    const idx = lower.indexOf(".zip", from);
    if (idx < 0) return null;
    const end = idx + 4;
    if (end === lower.length || lower[end] === "\\") {
      const archive = normalized.slice(0, end);
      const inner = normalized.slice(end).replace(/^\\+/, "");
      if (inner.split("\\").includes("..")) return null;
      return { archive, inner };
    }
    from = idx + 1;
  }
  return null;
}

function isZipRoot(path) {
  const parts = splitZipPath(path);
  return !!parts && !parts.inner;
}

function isInsideZip(path) {
  const parts = splitZipPath(path);
  return !!parts && !!parts.inner;
}

/** Reveal target for Windows Explorer: the archive file when the path is
 *  virtual, otherwise the path itself. */
function revealPath(path) {
  const parts = splitZipPath(path);
  return parts ? parts.archive : path;
}

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
let externalChangeTimer = 0;

function watchFolder(path) {
  invoke("explorer_watch", { path: path || "" }).catch(() => {});
}

function sameListing(a, b) {
  if (!a || !b || a.entries.length !== b.entries.length) return false;
  return a.entries.every((entry, index) => {
    const other = b.entries[index];
    return other && same(entry.path, other.path) && entry.bytes === other.bytes
      && entry.modified === other.modified && entry.created === other.created
      && entry.hidden === other.hidden && entry.readonly === other.readonly;
  });
}

async function openFolder(path, { push = true, keepFilter = false, focusPath = null, quiet = false } = {}) {
  if (path == null) return;
  if (push && fx.path !== path && !same(fx.path, path)) { fx.history.push(fx.path); fx.forward = []; }
  const token = ++listToken;
  const leaving = fx.path;
  fx.path = path; fx.loading = false; fx.error = "";
  // A filter belongs to the folder it was typed in. Carrying "png" into the
  // next folder would show an empty folder that is not empty.
  if (!keepFilter) { fx.filter = ""; fx.kinds.clear(); fx.exts.clear(); fx.typesOpen = false; }
  if (!same(leaving, path)) {
    fx.selected = ""; fx.selectedPaths.clear(); fx.selectionAnchor = "";
    fx.previewUrl = ""; previewToken += 1;
  }
  // Back / Up hand a focusPath: the child you came from. After the list paints,
  // that row is selected and scrolled into view - a pixel scroll would be wrong
  // if the window was resized while you were away.
  fx.pendingFocus = focusPath || "";
  // This PC is drawn from the drive list the tool already holds. There is no
  // folder to read, so it must not go through a listing that would blank the
  // pane and start work the status bar would then have to end.
  if (path === THIS_PC) {
    fx.listing = null;
    fx.open.add(THIS_PC);
    dirty();
    saveTransfer();
    rememberLastPath(THIS_PC);
    watchFolder(THIS_PC);
    return;
  }
  if (!quiet) {
    fx.loading = true;
    watchFolder(THIS_PC);
    dirty();
    window.wintWork?.beginWork("explorer-list", `Reading ${path}`);
  }
  let unchanged = false;
  try {
    const listing = await invoke("explorer_list", { path, dirsOnly: false, includeCreated: fx.createdColumn });
    if (token !== listToken) return;
    if (quiet && sameListing(fx.listing, listing)) { unchanged = true; return; }
    fx.listing = listing;
    const present = new Set(listing.entries.map((entry) => entry.path.toLowerCase()));
    fx.selectedPaths = new Set(selection().filter((selected) => present.has(selected.toLowerCase())));
    if (fx.selected && !present.has(fx.selected.toLowerCase())) fx.selected = selection()[0] || "";
    fx.tree.set(listing.path, { entries: listing.entries.filter((entry) => entry.isDir), error: "", loading: false });
    fx.path = listing.path;
    watchFolder(listing.path);
    rememberLastPath(listing.path);
  } catch (error) {
    if (token !== listToken) return;
    if (quiet) { unchanged = true; return; }
    fx.listing = null;
    fx.error = String(error);
  } finally {
    if (token === listToken) {
      if (unchanged) return;
      fx.loading = false;
      if (!quiet) window.wintWork?.endWork("explorer-list");
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
    const listing = await invoke("explorer_list", { path, dirsOnly: true, includeCreated: false });
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
  const child = fx.path;
  fx.forward.push(child);
  openFolder(fx.history.pop(), { push: false, focusPath: child });
}

function goForward() {
  if (!fx.forward.length) return;
  fx.history.push(fx.path);
  openFolder(fx.forward.pop(), { push: false });
}

function goUp() {
  if (fx.path === THIS_PC) return;
  const child = fx.path;
  openFolder(fx.listing?.parent ?? THIS_PC, { focusPath: child });
}

function refresh({ quiet = false } = {}) {
  if (fx.path === THIS_PC) {
    fx.roots = [];
    loadRoots();
    return;
  }
  fx.tree.delete(fx.path);
  openFolder(fx.path, { push: false, keepFilter: true, quiet });
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
    if (fx.sort === "created") return direction * (a.created - b.created) || byName(a, b);
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

/** Where Files left off. Lives next to the bookmarks file for the same reason:
 *  every window has its own browser storage, so only Rust can hand the folder
 *  back to the next open - or to a second pop-out that starts fresh. */
let lastPathTimer = 0;
function rememberLastPath(path) {
  clearTimeout(lastPathTimer);
  lastPathTimer = setTimeout(() => {
    invoke("explorer_last_path_set", { path: path || THIS_PC }).catch(() => {});
  }, 200);
}

async function restoreLastPath() {
  if (fx.path !== THIS_PC) return;
  let saved = null;
  try { saved = await invoke("explorer_last_path"); }
  catch (_) { return; }
  if (saved == null || same(saved, THIS_PC)) return;
  await openFolder(saved, { push: false });
}

function clampSide(width) {
  return Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(width)));
}
function clampPreview(width) {
  return Math.max(PREVIEW_MIN, Math.min(PREVIEW_MAX, Math.round(width)));
}

function applyLayout() {
  const body = fx.host?.querySelector(".fx-body");
  if (!body) return;
  body.style.setProperty("--fx-side", `${fx.sideWidth}px`);
  body.style.setProperty("--fx-preview", `${fx.previewWidth}px`);
}

function rememberLayout() {
  invoke("explorer_layout_set", {
    layout: { sideWidth: fx.sideWidth, previewWidth: fx.previewWidth, columnWidths: fx.columnWidths, createdColumn: fx.createdColumn },
  }).catch(() => {});
}

async function loadLayout() {
  try {
    const layout = await invoke("explorer_layout");
    if (layout?.sideWidth) fx.sideWidth = clampSide(layout.sideWidth);
    if (layout?.previewWidth) fx.previewWidth = clampPreview(layout.previewWidth);
    if (layout?.columnWidths) fx.columnWidths = { ...fx.columnWidths, ...layout.columnWidths };
    fx.createdColumn = !!layout?.createdColumn;
  } catch (_) { /* Defaults already sit on fx. */ }
  applyLayout();
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
  if (!path || path === THIS_PC || isInsideZip(path)) return;
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
  const painted = new Set([...fx.host?.querySelectorAll(".fx-row[data-fx-item]") || []].map((row) => row.dataset.fxItem));
  const wanted = (fx.listing?.entries || [])
    .filter((entry) => !entry.isDir && PREVIEW_KINDS.has(kindOf(entry)) && !fx.thumbs.has(entry.path))
    // What is on screen is useful now. Everything else continues behind it so
    // a later scroll normally finds its pictures waiting in the cache.
    .sort((a, b) => Number(painted.has(b.path)) - Number(painted.has(a.path)));
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
  if (targets.some((path) => isInsideZip(path))) {
    window.wintWork?.beginWork("explorer-delete", "Files inside a zip cannot be deleted here");
    setTimeout(() => window.wintWork?.endWork("explorer-delete"), 4000);
    return;
  }
  const what = targets.length === 1
    ? segments(targets[0]).slice(-1)[0]?.name || targets[0]
    : `${targets.length} items`;
  const folders = targets.filter((path) => (fx.listing?.entries || []).some((entry) => same(entry.path, path) && entry.isDir && !entry.isArchive));
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
    announce(targets.map(parentOf));
  } catch (error) {
    fx.error = String(error);
    dirty();
  } finally {
    window.wintWork?.endWork("explorer-delete");
  }
}

// ------------------------------------------------- rename, copy, move, drag

/** Somewhere the tool may change: a real folder, not This PC or a zip. */
const writable = (path) => !!path && path !== THIS_PC && !isInsideZip(path);
const nameOf = (path) => segments(path).slice(-1)[0]?.name || path;
const parentOf = (path) => String(path || "").replace(/\\+$/, "").replace(/\\[^\\]*$/, "") || path;

/** A short line in the status bar for an answer that needs no dialog. */
function note(message) {
  window.wintWork?.beginWork("explorer-note", message);
  setTimeout(() => window.wintWork?.endWork("explorer-note"), 4000);
}

/** Tell every Files window which folders just changed, this one included, so
 *  a move from one window to another empties the first and fills the second. */
function announce(dirs) {
  const unique = [...new Set(dirs.filter(Boolean))];
  const event = window.__TAURI__.event;
  if (event?.emit) event.emit("explorer-changed", { dirs: unique }).catch(() => changed(unique));
  else changed(unique);
}

function changed(dirs) {
  for (const dir of dirs) fx.tree.delete(dir);
  if (fx.path !== THIS_PC && dirs.some((dir) => same(dir, fx.path))) {
    openFolder(fx.path, { push: false, keepFilter: true, focusPath: fx.pendingFocus || null });
  } else dirty();
}

function startRename(path) {
  if (!writable(path) || !(fx.listing?.entries || []).some((entry) => same(entry.path, path))) return;
  const targets = selection().filter(writable);
  const batch = targets.length > 1 && targets.some((item) => same(item, path))
    ? [path, ...targets.filter((item) => !same(item, path))]
    : [path];
  const entry = (fx.listing?.entries || []).find((item) => same(item.path, path));
  const original = nameOf(path);
  const dot = entry && !entry.isDir ? original.lastIndexOf(".") : -1;
  fx.rename = { path, paths: batch, draft: batch.length > 1 && dot > 0 ? original.slice(0, dot) : original, fresh: true };
  dirty();
}

async function commitRename() {
  const rename = fx.rename;
  if (!rename) return;
  fx.rename = null;
  const draft = rename.draft.trim();
  if (!draft || (rename.paths.length === 1 && draft === nameOf(rename.path))) return void dirty();
  const batch = rename.paths.length > 1;
  window.wintWork?.beginWork("explorer-rename", batch ? `Renaming ${rename.paths.length} items` : `Renaming ${nameOf(rename.path)}`);
  try {
    const renamedPaths = batch
      ? await invoke("explorer_rename_many", { paths: rename.paths, base: draft })
      : [await invoke("explorer_rename", { path: rename.path, newName: draft })];
    const renamed = renamedPaths[0];
    const marked = fx.bookmarks.findIndex((mark) => same(mark, rename.path));
    if (marked >= 0) setBookmarks(fx.bookmarks.map((mark, index) => (index === marked ? renamed : mark)));
    fx.selectedPaths = new Set(renamedPaths);
    fx.selected = renamed;
    for (const path of rename.paths) fx.thumbs.delete(path);
    fx.pendingFocus = renamed;
    announce([...new Set(rename.paths.map(parentOf))]);
  } catch (error) {
    note(String(error));
    dirty();
  } finally {
    window.wintWork?.endWork("explorer-rename");
  }
}

async function newFolder() {
  if (!writable(fx.path)) return;
  window.wintWork?.beginWork("explorer-new-folder", "Making a new folder");
  try {
    const path = await invoke("explorer_new_folder", { dir: fx.path });
    // It lands in rename, the way a new folder does in Windows Explorer.
    fx.rename = { path, draft: nameOf(path), fresh: true };
    fx.pendingFocus = path;
    announce([fx.path]);
  } catch (error) {
    note(String(error));
  } finally {
    window.wintWork?.endWork("explorer-new-folder");
  }
}

/** Cut and copy go through the Windows clipboard, so a file copied here
 *  pastes in Windows Explorer and the other way round. */
async function toClipboard(paths, cut) {
  const targets = paths.filter(writable);
  if (!targets.length) return;
  try {
    await invoke("explorer_clipboard_set", { paths: targets, cut });
    fx.cut = cut ? targets : [];
    dirty();
    note(`${cut ? "Cut" : "Copied"} ${targets.length === 1 ? nameOf(targets[0]) : `${targets.length} items`}`);
  } catch (error) {
    note(String(error));
  }
}

async function paste(dest = fx.path) {
  if (!writable(dest)) return;
  let clip = null;
  try { clip = await invoke("explorer_clipboard_get"); } catch (error) { return note(String(error)); }
  if (!clip?.paths?.length) return note("There are no files on the clipboard");
  await transfer(clip.paths, dest, !clip.cut);
  if (clip.cut) fx.cut = [];
}

/** Explorer's rule for a plain drop: the same drive moves, another drive copies. */
const sameDrive = (a, b) => String(a).slice(0, 2).toLowerCase() === String(b).slice(0, 2).toLowerCase();

async function transfer(paths, dest, copy) {
  if (!writable(dest) || !paths.length) return;
  const what = paths.length === 1 ? nameOf(paths[0]) : `${paths.length} items`;
  window.wintWork?.beginWork("explorer-transfer", `${copy ? "Copying" : "Moving"} ${what} to ${nameOf(dest)}`);
  try {
    await invoke("explorer_transfer", { paths, dest, copy });
  } catch (error) {
    note(String(error));
  } finally {
    window.wintWork?.endWork("explorer-transfer");
    announce([dest, ...(copy ? [] : paths.map(parentOf))]);
  }
}

/** The folder under a point: a folder row, a tree node or a crumb - otherwise
 *  the folder that is open. */
function dropTarget(x, y) {
  const hit = document.elementFromPoint(x, y);
  if (!hit || !fx.host?.contains(hit)) return null;
  const row = hit.closest('[data-fx-item][data-fx-dir="true"]');
  if (row && !(fx.listing?.entries || []).some((entry) => same(entry.path, row.dataset.fxItem) && entry.isArchive)) {
    return { el: row, path: row.dataset.fxItem };
  }
  const node = hit.closest("[data-fx-open]");
  if (node && writable(asPath(node.dataset.fxOpen)) && !isZipRoot(asPath(node.dataset.fxOpen))) {
    return { el: node, path: asPath(node.dataset.fxOpen) };
  }
  return writable(fx.path) && !isZipRoot(fx.path) ? { el: null, path: fx.path } : null;
}

function paintDrop(target) {
  for (const el of fx.host?.querySelectorAll(".fx-drop") || []) el.classList.remove("fx-drop");
  if (target) (target.el || fx.host.querySelector(".fx-rows"))?.classList.add("fx-drop");
}

/** Files dropped from anywhere - another Files window, Windows Explorer, the
 *  desktop - arrive as Tauri drag-drop events with physical coordinates. */
function listenForDrops() {
  const webview = window.__TAURI__.webview?.getCurrentWebview?.();
  if (!webview?.onDragDropEvent) return;
  webview.onDragDropEvent(({ payload }) => {
    if (!fx.host?.isConnected || !fx.host.offsetParent) return;
    const scale = window.devicePixelRatio || 1;
    const at = payload.position ? dropTarget(payload.position.x / scale, payload.position.y / scale) : null;
    if (payload.type === "enter" || payload.type === "over") return paintDrop(at);
    paintDrop(null);
    if (payload.type !== "drop" || !at || !payload.paths?.length) return;
    transfer(payload.paths, at.path, !payload.paths.every((path) => sameDrive(path, at.path)));
  }).catch(() => {});
}

/** Dragging a row hands it to Windows as a real file drag once the pointer
 *  has moved a few pixels with the button held. */
let dragFrom = null;
let dragJustEnded = 0;
function watchDrag(event) {
  const row = event.target.closest("[data-fx-item]");
  if (event.button !== 0 || !row || event.target.closest(".fx-rename, button") || !writable(row.dataset.fxItem)) return;
  dragFrom = { x: event.clientX, y: event.clientY, path: row.dataset.fxItem };
}
async function maybeDrag(event) {
  if (!dragFrom) return;
  if (!(event.buttons & 1)) { dragFrom = null; return; }
  if (Math.hypot(event.clientX - dragFrom.x, event.clientY - dragFrom.y) < 6) return;
  const { path } = dragFrom;
  const paths = selection().some((item) => same(item, path)) ? selection() : [path];
  dragFrom = null;
  try {
    // Explorer often moves without saying so, so the folder is always re-read.
    await invoke("explorer_drag_out", { paths });
    announce(paths.map(parentOf));
  } catch (error) {
    note(String(error));
  } finally {
    dragJustEnded = Date.now();
  }
}

/** Selecting a file is what fills the preview pane. Folders are never
 *  selected: clicking one opens it, and a pane showing the folder you just
 *  left would be describing somewhere you are no longer standing. */
function selection() { return [...fx.selectedPaths]; }

function select(path, { add = false, range = false } = {}) {
  const shown = visible().shown;
  if (range && fx.selectionAnchor) {
    const from = shown.findIndex((entry) => same(entry.path, fx.selectionAnchor));
    const to = shown.findIndex((entry) => same(entry.path, path));
    if (from >= 0 && to >= 0) {
      if (!add) fx.selectedPaths.clear();
      for (const entry of shown.slice(Math.min(from, to), Math.max(from, to) + 1)) fx.selectedPaths.add(entry.path);
    }
  } else if (add) {
    const existing = selection().find((item) => same(item, path));
    if (existing) fx.selectedPaths.delete(existing);
    else fx.selectedPaths.add(path);
    fx.selectionAnchor = path;
  } else {
    fx.selectedPaths = new Set([path]);
    fx.selectionAnchor = path;
  }
  fx.selected = selection().find((item) => same(item, path)) || selection().slice(-1)[0] || "";
  fx.previewUrl = "";
  // Selection and preview update in place. A full render would rebuild the
  // list and jump the scroll back to the top - painful in a long zip.
  paintSelection();
  if (fx.previewPane) {
    const entry = (fx.listing?.entries || []).find((item) => same(item.path, path));
    fx.previewLoading = !!(entry && !entry.isDir && PREVIEW_KINDS.has(kindOf(entry)));
    paintPreview();
    loadPreview();
  }
}

function focusRowAt(index, { range = false, keep = false } = {}) {
  const shown = visible().shown;
  if (!shown.length) return;
  const target = shown[Math.max(0, Math.min(shown.length - 1, index))];
  select(target.path, { add: keep, range });
  const rows = fx.host?.querySelector(".fx-rows");
  if (!rows) return;
  const rowHeight = fx.thumbsOn ? THUMB_ROW_PX : ROW_PX;
  const top = shown.indexOf(target) * rowHeight;
  if (top < rows.scrollTop) rows.scrollTop = top;
  else if (top + rowHeight > rows.scrollTop + rows.clientHeight) rows.scrollTop = top + rowHeight - rows.clientHeight;
  requestAnimationFrame(() => fx.host?.querySelector(`[data-fx-item="${CSS.escape(target.path)}"]`)?.focus());
}

let previewToken = 0;

async function loadPreview() {
  const path = fx.selected;
  if (!fx.previewPane || !path) return;
  const entry = (fx.listing?.entries || []).find((item) => same(item.path, path));
  if (!entry || entry.isDir || !PREVIEW_KINDS.has(kindOf(entry))) return;
  const token = ++previewToken;
  fx.previewLoading = true;
  paintPreview();
  let url = "";
  try { url = (await invoke("explorer_thumbnail", { path, size: PREVIEW_PX })) || ""; }
  catch (_) { url = ""; }
  if (token !== previewToken) return;
  fx.previewUrl = url;
  fx.previewLoading = false;
  paintPreview();
}

function paintSelection() {
  if (!fx.host) return;
  for (const row of fx.host.querySelectorAll(".fx-row[data-fx-item]")) {
    row.classList.toggle("picked", selection().some((path) => same(row.dataset.fxItem, path)));
    row.setAttribute("aria-selected", String(selection().some((path) => same(row.dataset.fxItem, path))));
  }
}

/** Select a row by path and scroll it into view. Used when Back/Up returns to
 *  a folder: the child you had opened is the anchor, not a pixel offset. */
function applyPendingFocus() {
  if (!fx.pendingFocus || !fx.host || fx.loading) return;
  const path = fx.pendingFocus;
  const row = [...fx.host.querySelectorAll(".fx-row[data-fx-item]")]
    .find((el) => same(el.dataset.fxItem, path));
  fx.pendingFocus = "";
  if (!row) return;
  fx.selected = path;
  fx.selectedPaths = new Set([path]);
  fx.selectionAnchor = path;
  paintSelection();
  row.scrollIntoView({ block: "nearest" });
}

function paintPreview() {
  if (!fx.host || !fx.previewPane) return;
  const pane = fx.host.querySelector(".fx-preview");
  if (!pane) {
    dirty();
    return;
  }
  pane.outerHTML = renderPreviewPane();
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
        : `<div class="fx-preview-empty">${icon("broken_image")}<p>Could not make a preview of this file.</p></div>`;
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
  const glyph = entry.isArchive
    ? "folder_zip"
    : open || here ? "folder_open" : "folder";
  return `<div class="fx-node${here ? " on" : ""}${entry.hidden ? " dim" : ""}" style="--depth:${depth}">
    <button class="fx-twist${entry.hasChildren ? "" : " leaf"}" type="button" data-fx-twist="${esc(entry.path)}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} ${esc(entry.name)}" tabindex="-1">${entry.hasChildren ? icon(open ? "expand_more" : "chevron_right") : ""}</button>
    <button class="fx-node-btn" type="button" data-fx-open="${esc(entry.path)}" title="${esc(entry.path)}">${icon(glyph)}<span>${esc(entry.name)}</span></button>
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
  const canAdd = fx.path !== THIS_PC && fx.path && !isInsideZip(fx.path) && !fx.bookmarks.some((path) => same(path, fx.path));
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
    return Array.from({ length: 3 }, (_, index) => `<div class="fx-row skeleton" style="--i:${index}"><span class="fx-cell name"><i></i></span><span class="fx-cell type"><i></i></span><span class="fx-cell size"><i></i></span><span class="fx-cell modified"><i></i></span>${fx.createdColumn ? '<span class="fx-cell created"><i></i></span>' : ""}</div>`).join("");
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
      ${fx.createdColumn ? '<span class="fx-cell created"></span>' : ""}
    </div>`;
  }).join("");
}

function renderRows(shown, scrollTop = 0, viewport = 700) {
  if (fx.path === THIS_PC) return driveRows();
  if (fx.loading) {
    return Array.from({ length: 10 }, (_, index) => `<div class="fx-row skeleton" style="--i:${index}"><span class="fx-cell name"><i></i></span><span class="fx-cell type"><i></i></span><span class="fx-cell size"><i></i></span><span class="fx-cell modified"><i></i></span>${fx.createdColumn ? '<span class="fx-cell created"><i></i></span>' : ""}</div>`).join("");
  }
  if (fx.error) {
    return `<div class="fx-empty">${icon("lock")}<strong>${esc(fx.error)}</strong><p>Pick another folder on the left, or hand this one to Windows Explorer.</p><button class="btn" type="button" data-fx-reveal="${esc(revealPath(fx.path))}">${icon("folder_open")}Open in Windows Explorer</button></div>`;
  }
  if (!fx.path) {
    return `<div class="fx-empty">${icon("folder_open")}<strong>Pick a folder on the left</strong><p>Files shows one folder at a time, with a filter that already knows every type it holds.</p></div>`;
  }
  if (!shown.length) {
    const filtered = fx.filter || fx.kinds.size || fx.exts.size;
    return `<div class="fx-empty">${icon(filtered ? "filter_alt_off" : "folder_open")}<strong>${filtered ? "Nothing here matches the filter" : "This folder is empty"}</strong>${filtered ? `<button class="btn" type="button" data-fx-clear>${icon("close")}Clear the filter</button>` : ""}</div>`;
  }
  const rowHeight = fx.thumbsOn ? THUMB_ROW_PX : ROW_PX;
  const virtual = shown.length > VIRTUAL_AFTER;
  const count = virtual ? Math.ceil(viewport / rowHeight) + VIRTUAL_OVERSCAN * 2 : shown.length;
  const start = virtual
    ? Math.min(Math.max(0, Math.floor(scrollTop / rowHeight) - VIRTUAL_OVERSCAN), Math.max(0, shown.length - count))
    : 0;
  const end = Math.min(shown.length, start + count);
  const rows = shown.slice(start, end).map((entry, offset) => {
    const kind = kindOf(entry);
    const thumb = fx.thumbs.get(entry.path);
    const slot = fx.thumbsOn && !entry.isDir && PREVIEW_KINDS.has(kind)
      ? `<span class="fx-thumb${thumb ? " has-image" : ""}"${thumb ? ` style="background-image:url('${thumb}')"` : ""}>${thumb ? "" : icon(kindById(kind).icon)}</span>`
      : icon(entry.isArchive ? "folder_zip" : entry.isDir ? "folder" : kindById(kind).icon);
    const canDelete = !isInsideZip(fx.path);
    const renaming = same(fx.rename?.path, entry.path);
    const name = renaming
      ? `<input class="fx-rename" type="text" spellcheck="false" aria-label="New name for ${esc(entry.name)}">`
      : `<strong>${esc(entry.name)}</strong>`;
    const picked = selection().some((path) => same(path, entry.path));
    return `<div class="fx-row${entry.isDir ? " dir" : ""}${entry.hidden || fx.cut.some((path) => same(path, entry.path)) ? " dim" : ""}${picked ? " picked" : ""}${canDelete ? " has-del" : ""}" tabindex="${same(fx.selected, entry.path) ? "0" : "-1"}" role="row" aria-selected="${picked}" data-fx-index="${start + offset}" data-fx-item="${esc(entry.path)}" data-fx-dir="${entry.isDir}" title="${esc(entry.path)}">
    <span class="fx-cell name">${slot}${name}</span>
    <span class="fx-cell type">${esc(typeLabel(entry))}</span>
    <span class="fx-cell size">${entry.isDir && !entry.isArchive ? "" : bytes(entry.bytes)}</span>
    <span class="fx-cell modified">${esc(when(entry.modified))}</span>
    ${fx.createdColumn ? `<span class="fx-cell created">${esc(when(entry.created))}</span>` : ""}
    ${canDelete ? `<button class="fx-row-del" type="button" data-fx-delete="${esc(entry.path)}" title="Delete ${esc(entry.name)}" aria-label="Delete ${esc(entry.name)}">${icon("delete")}</button>` : ""}
  </div>`;
  }).join("");
  if (!virtual) return rows;
  return `<div class="fx-virtual-space" style="height:${start * rowHeight}px"></div>${rows}<div class="fx-virtual-space" style="height:${(shown.length - end) * rowHeight}px"></div>`;
}

/** True while a paint replaces the DOM, so the rename box being swapped out
 *  is not mistaken for the user clicking away from it. */
let painting = false;
let virtualFrame = 0;

function paintVirtualRows(rows) {
  if (!rows || fx.path === THIS_PC || fx.loading || fx.rename || visible().shown.length <= VIRTUAL_AFTER) return;
  cancelAnimationFrame(virtualFrame);
  virtualFrame = requestAnimationFrame(() => {
    const body = rows.querySelector(".fx-row-body");
    if (!body) return;
    body.innerHTML = renderRows(visible().shown, rows.scrollTop, rows.clientHeight);
    paintSelection();
    loadThumbs();
  });
}

function render() {
  if (!fx.host) return;
  const live = fx.host.querySelector(".fx-search input");
  const typing = live === document.activeElement;
  const caret = typing ? live.selectionStart ?? fx.filter.length : 0;
  const liveRename = fx.host.querySelector(".fx-rename");
  const renameSel = liveRename === document.activeElement ? [liveRename.selectionStart, liveRename.selectionEnd] : null;
  painting = true;
  // Keep the list and tree where the user left them across a rebuild.
  const oldRows = fx.host.querySelector(".fx-rows");
  const rowsScroll = oldRows?.scrollTop ?? 0;
  const rowsViewport = oldRows?.clientHeight || 700;
  const treeScroll = fx.host.querySelector(".fx-tree")?.scrollTop ?? 0;
  const marksScroll = fx.host.querySelector(".fx-marks")?.scrollTop ?? 0;
  const { named, shown, total } = visible();
  const counts = facets(named);
  const filtering = fx.filter || fx.kinds.size || fx.exts.size;
  fx.host.innerHTML = `<header class="tool-head"><button class="btn back tool-back" type="button" data-open-tool="overview">${icon("arrow_back")}Back</button><span class="tool-plate">${icon("folder_open")}</span><span class="tool-title"><strong>Files</strong><small>browse a folder and filter it by type in one click</small></span><button class="tool-popout" type="button" data-popout-tool="explorer"></button><button class="tool-pin" type="button" data-pin-tool="explorer"></button><button class="tool-close" type="button" data-open-tool="overview">${icon("close")}</button></header>
  <div class="fx-body${fx.previewPane ? " with-preview" : ""}">
    <aside class="fx-side">
      <div class="fx-tree" aria-label="Folders">${renderTree()}</div>
      ${renderBookmarks()}
    </aside>
    <div class="fx-split" data-fx-split="side" role="separator" aria-orientation="vertical" aria-label="Resize the folder tree" title="Drag to resize the folder tree"></div>
    <section class="fx-main">
      <div class="fx-bar">
        <button class="fx-nav" type="button" data-fx-back title="Back" aria-label="Back" ${fx.history.length ? "" : "disabled"}>${icon("arrow_back")}</button>
        <button class="fx-nav" type="button" data-fx-forward title="Forward" aria-label="Forward" ${fx.forward.length ? "" : "disabled"}>${icon("arrow_forward")}</button>
        <button class="fx-nav" type="button" data-fx-up title="Up one folder" aria-label="Up one folder" ${fx.path === THIS_PC ? "disabled" : ""}>${icon("arrow_upward")}</button>
        <button class="fx-nav" type="button" data-fx-refresh title="${fx.path === THIS_PC ? "Read the drives again" : "Read this folder again"}" aria-label="Refresh">${icon("refresh")}</button>
        <button class="fx-nav" type="button" data-fx-new-window title="Open this folder in a new window" aria-label="New window">${icon("tab_duplicate")}</button>
        <label class="fx-address" title="Type or paste a folder path">${icon("folder")}<input type="text" value="${esc(fx.path)}" placeholder="This PC" aria-label="Folder path" spellcheck="false"></label>
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
      <div class="fx-list${fx.thumbsOn ? " preview" : ""}" style="--fx-columns:${columnTemplate()};--fx-table-width:${columnTableWidth()}px">
        <div class="fx-rows" role="grid" aria-multiselectable="true">
          <div class="fx-row head${fx.path === THIS_PC ? " static" : ""}" role="row">${visibleColumns().map((column) => `<button class="fx-cell ${column.id} sort${fx.sort === column.id ? " on" : ""}" type="button" data-fx-sort="${column.id}">${column.label}${fx.sort === column.id ? icon(fx.desc ? "arrow_downward" : "arrow_upward") : ""}<i class="fx-col-grip" data-fx-column-resize="${column.id}" aria-hidden="true"></i></button>`).join("")}</div>
          <div class="fx-row-body" role="rowgroup">${renderRows(shown, rowsScroll, rowsViewport)}</div>
        </div>
      </div>
      <footer class="fx-foot">
        <span>${fx.path === THIS_PC
          ? `${fx.roots.length} drive${fx.roots.length === 1 ? "" : "s"}`
          : fx.loading ? `${icon("progress_activity")}Reading this folder…`
          : `${shown.length}${shown.length === total ? "" : ` of ${total}`} item${shown.length === 1 ? "" : "s"}${selection().length > 1 ? ` · ${selection().length} selected` : ""}`}</span>
        ${fx.listing?.skipped ? `<span title="Windows would not report these">${icon("warning")}${fx.listing.skipped} could not be read</span>` : ""}
        <span class="fx-foot-hint">${icon("mouse")}${isInsideZip(fx.path) ? "Inside a zip · read-only" : "Double-click to open · right-click for more"}</span>
      </footer>
    </section>
    ${fx.previewPane ? `<div class="fx-split" data-fx-split="preview" role="separator" aria-orientation="vertical" aria-label="Resize the preview" title="Drag to resize the preview"></div>${renderPreviewPane()}` : ""}
  </div>`;
  applyLayout();
  const pin = fx.host.querySelector('.tool-pin[data-pin-tool="explorer"]');
  const pop = fx.host.querySelector('.tool-popout[data-popout-tool="explorer"]');
  if (pin) {
    const on = !!window.wintShell?.isToolPinned?.("explorer");
    pin.classList.toggle("on", on);
    pin.setAttribute("aria-pressed", String(on));
    pin.innerHTML = `${icon("push_pin")}${on ? "Pinned" : "Pin to dock"}`;
  }
  if (pop) {
    // Files may have several windows open at once. Pop out always means a new
    // one - never "show the one you already have".
    pop.classList.remove("on");
    pop.innerHTML = `${icon("open_in_new")}Pop out`;
    pop.title = "Open Files in a new window";
  }
  // The whole toolbar is rebuilt on every paint, so the name filter's value,
  // focus and caret have to be put back or typing into it would lose a letter
  // and jump to the end on every keystroke.
  const search = fx.host.querySelector(".fx-search input");
  if (search) {
    search.value = fx.filter;
    if (typing) { search.focus(); search.setSelectionRange(caret, caret); }
  }
  const renameBox = fx.host.querySelector(".fx-rename");
  if (renameBox && fx.rename) {
    renameBox.value = fx.rename.draft;
    renameBox.focus();
    if (fx.rename.fresh) {
      // Like Explorer: the name is selected, the extension is left alone.
      const dot = fx.rename.draft.lastIndexOf(".");
      const isDir = (fx.listing?.entries || []).some((entry) => same(entry.path, fx.rename.path) && entry.isDir);
      renameBox.setSelectionRange(0, dot > 0 && !isDir ? dot : fx.rename.draft.length);
      fx.rename.fresh = false;
    } else if (renameSel) renameBox.setSelectionRange(renameSel[0], renameSel[1]);
  }
  painting = false;
  const rows = fx.host.querySelector(".fx-rows");
  if (rows) rows.scrollTop = rowsScroll;
  const tree = fx.host.querySelector(".fx-tree");
  if (tree) tree.scrollTop = treeScroll;
  const marks = fx.host.querySelector(".fx-marks");
  if (marks) marks.scrollTop = marksScroll;
  applyPendingFocus();
}

// ----------------------------------------------------------------- wiring

function activate(path, isDir) {
  if (isDir) {
    openFolder(path);
    return;
  }
  // Files inside a zip are unpacked to a temp path first - Windows cannot
  // open a member of an archive by path alone.
  const open = async () => {
    let real = path;
    if (isInsideZip(path)) {
      window.wintWork?.beginWork("explorer-open", `Unpacking ${segments(path).slice(-1)[0]?.name || path}`);
      try { real = await invoke("explorer_materialize", { path }); }
      catch (error) {
        fx.error = String(error);
        dirty();
        return;
      } finally {
        window.wintWork?.endWork("explorer-open");
      }
    }
    invoke("open_in", { path: real, target: "explorer" }).catch(() => {});
  };
  void open();
}

function mintInstance() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Open another Files window at this folder. Keeps the current window where
 *  it is - Pop out moves; this duplicates. */
async function openInNewWindow(folderPath) {
  const path = folderPath == null ? fx.path : folderPath;
  if (window.wintShell?.openExplorerWindow && !window.wintExternalToolChrome) {
    return window.wintShell.openExplorerWindow(path);
  }
  const instance = mintInstance();
  const seed = {
    ...(exportState() || {}),
    path: path || "",
    listing: null,
    error: "",
    history: [],
    forward: [],
    filter: "",
    kinds: [],
    exts: [],
    typesOpen: false,
  };
  const key = `explorer-window:${instance}`;
  window.wintWork?.beginWork(key, "Opening Files in a new window");
  try {
    await invoke("tool_bridge_state_put", { id: `explorer:${instance}`, state: seed });
    await invoke("tool_popout", {
      id: "explorer",
      title: "Files",
      theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
      x: null,
      y: null,
      instance,
    });
    await window.__TAURI__.event.emit("tool:spawned", { id: "explorer", instance }).catch(() => {});
  } catch (error) {
    window.wintWork?.beginWork("explorer-window-fail", "Could not open another Files window", String(error));
    setTimeout(() => window.wintWork?.endWork("explorer-window-fail"), 4000);
  } finally {
    window.wintWork?.endWork(key);
  }
}

function closeContext() { document.querySelector(".fx-context")?.remove(); }

function openColumnMenu(event) {
  event.preventDefault();
  closeContext();
  const menu = document.createElement("div");
  menu.className = "fx-context fx-column-menu";
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  menu.innerHTML = `<button type="button" data-fx-created>${icon(fx.createdColumn ? "check_box" : "check_box_outline_blank")}Date created</button>`;
  menu.addEventListener("click", () => {
    fx.createdColumn = !fx.createdColumn;
    if (!fx.createdColumn && fx.sort === "created") { fx.sort = "name"; fx.desc = false; }
    rememberLayout();
    menu.remove();
    if (fx.path === THIS_PC) dirty();
    else openFolder(fx.path, { push: false, keepFilter: true });
  });
  document.body.appendChild(menu);
  const box = menu.getBoundingClientRect();
  if (box.bottom > innerHeight) menu.style.top = `${Math.max(4, innerHeight - box.height - 4)}px`;
  if (box.right > innerWidth) menu.style.left = `${Math.max(4, innerWidth - box.width - 4)}px`;
  setTimeout(() => document.addEventListener("click", closeContext, { once: true }), 0);
}

function mount(host) {
  fx.host = host;
  host.addEventListener("click", (event) => {
    if (event.target.closest("[data-fx-column-resize]")) return;
    if (event.target.closest(".fx-rename")) return;
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
    if (event.target.closest("[data-fx-new-window]")) return void openInNewWindow(fx.path);
    if (event.target.closest("[data-fx-clear-ext]")) { fx.exts.clear(); return dirty(); }
    if (event.target.closest("[data-fx-clear]")) return clearFilters();
    if (event.target.closest("[data-fx-types]")) { fx.typesOpen = !fx.typesOpen; return dirty(); }
    if (event.target.closest("[data-fx-hidden]")) { fx.showHidden = !fx.showHidden; return dirty(); }
    if (event.target.closest("[data-fx-thumbs]")) return toggleThumbs();
    if (event.target.closest("[data-fx-preview]")) return togglePreviewPane();
    const del = event.target.closest("[data-fx-delete]");
    if (del) {
      event.preventDefault();
      return askDelete([del.dataset.fxDelete]);
    }
    // One click opens a folder - that is the whole job of this tool. Files
    // wait for the second click, because opening a program by accident is a
    // worse mistake than an extra click.
    const row = event.target.closest("[data-fx-item]");
    // The release that ends a drag is not a click on the row it started on.
    if (row && Date.now() - dragJustEnded > 400) {
      if (event.ctrlKey || event.shiftKey) select(row.dataset.fxItem, { add: event.ctrlKey, range: event.shiftKey });
      else if (row.dataset.fxDir === "true") openFolder(row.dataset.fxItem);
      else select(row.dataset.fxItem);
    }
  });
  host.addEventListener("dblclick", (event) => {
    const column = event.target.closest("[data-fx-column-resize]")?.dataset.fxColumnResize;
    if (column) {
      event.preventDefault(); event.stopPropagation();
      fx.columnWidths[column] = { name: 320, type: 130, size: 92, modified: 148, created: 148 }[column];
      rememberLayout(); dirty();
      return;
    }
    if (event.target.closest("[data-fx-delete], .fx-rename")) return;
    const row = event.target.closest("[data-fx-item]");
    if (row) activate(row.dataset.fxItem, row.dataset.fxDir === "true");
  });
  host.addEventListener("keydown", (event) => {
    if (event.target.closest(".fx-rename")) {
      if (event.key === "Enter") { event.preventDefault(); commitRename(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); fx.rename = null; dirty(); }
      return;
    }
    if (event.target.closest(".fx-address")) {
      if (event.key === "Enter") {
        event.preventDefault();
        const path = event.target.value.trim();
        openFolder(path || THIS_PC);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.target.value = fx.path;
        event.target.blur();
      }
      return;
    }
    const row = event.target.closest("[data-fx-item]");
    const typingText = !!event.target.closest("input, textarea");
    const key = event.key.toLowerCase();
    const current = row?.dataset.fxItem || fx.selected;
    const targets = selection().length && selection().some((path) => same(path, current)) ? selection() : (current ? [current] : []);
    if (event.key === "F2" && current) {
      event.preventDefault();
      return startRename(current);
    }
    if (event.ctrlKey && !event.altKey && key === "l") {
      event.preventDefault();
      const address = fx.host.querySelector(".fx-address input");
      address?.focus(); address?.select();
      return;
    }
    if (event.ctrlKey && !event.altKey && !typingText) {
      if ((key === "c" || key === "x") && current && !event.shiftKey) {
        event.preventDefault();
        return void toClipboard(targets, key === "x");
      }
      if (key === "v" && !event.shiftKey) {
        event.preventDefault();
        return void paste();
      }
      if (key === "a" && !event.shiftKey) {
        event.preventDefault();
        const shown = visible().shown;
        fx.selectedPaths = new Set(shown.map((entry) => entry.path));
        fx.selected = shown[0]?.path || "";
        fx.selectionAnchor = fx.selected;
        paintSelection();
        return;
      }
      if (key === "n" && event.shiftKey) {
        event.preventDefault();
        return void newFolder();
      }
    }
    if (row && event.key === "Enter") {
      event.preventDefault();
      activate(row.dataset.fxItem, row.dataset.fxDir === "true");
      return;
    }
    if (row && event.key === " ") {
      event.preventDefault();
      select(row.dataset.fxItem, { add: event.ctrlKey, range: event.shiftKey });
      return;
    }
    if (row && ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(event.key)) {
      event.preventDefault();
      const shown = visible().shown;
      const at = shown.findIndex((entry) => same(entry.path, current));
      const page = Math.max(1, Math.floor((fx.host.querySelector(".fx-rows")?.clientHeight || 300) / (fx.thumbsOn ? THUMB_ROW_PX : ROW_PX)));
      const next = event.key === "Home" ? 0
        : event.key === "End" ? shown.length - 1
        : event.key === "PageDown" ? at + page
        : event.key === "PageUp" ? at - page
        : event.key === "ArrowDown" ? at + 1 : at - 1;
      focusRowAt(next, { range: event.shiftKey, keep: event.ctrlKey });
      return;
    }
    if (row && event.key === "Delete") {
      event.preventDefault();
      askDelete(targets);
      return;
    }
    if (event.key === "Escape" && event.target.closest(".fx-search") && fx.filter) {
      fx.filter = "";
      dirty();
    }
  });
  host.addEventListener("input", (event) => {
    if (event.target.closest(".fx-rename")) { if (fx.rename) fx.rename.draft = event.target.value; return; }
    if (!event.target.closest(".fx-search")) return;
    fx.filter = event.target.value;
    dirty();
  });
  host.addEventListener("scroll", (event) => {
    if (event.target.classList?.contains("fx-rows")) paintVirtualRows(event.target);
  }, true);
  // Clicking away from the rename box keeps the new name, as in Explorer.
  host.addEventListener("focusout", (event) => {
    if (!painting && event.target.closest(".fx-rename")) commitRename();
  });
  host.addEventListener("pointerdown", watchDrag);
  host.addEventListener("pointermove", maybeDrag);
  host.addEventListener("pointerup", () => { dragFrom = null; });
  // Drag the splitters. Widths are applied as CSS variables so the list can
  // reflow without a full re-render fighting the pointer.
  host.addEventListener("pointerdown", (event) => {
    const column = event.target.closest("[data-fx-column-resize]")?.dataset.fxColumnResize;
    if (column && event.button === 0) {
      event.preventDefault(); event.stopPropagation();
      const startX = event.clientX;
      const startWidth = fx.host.querySelector(`.fx-row.head .fx-cell.${column}`)?.getBoundingClientRect().width || fx.columnWidths[column];
      const onMove = (move) => {
        fx.columnWidths[column] = Math.max(64, Math.min(800, Math.round(startWidth + move.clientX - startX)));
        const list = fx.host.querySelector(".fx-list");
        list?.style.setProperty("--fx-columns", columnTemplate());
        list?.style.setProperty("--fx-table-width", `${columnTableWidth()}px`);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        rememberLayout();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      return;
    }
    const grip = event.target.closest("[data-fx-split]");
    if (!grip || event.button !== 0) return;
    const body = host.querySelector(".fx-body");
    if (!body) return;
    event.preventDefault();
    const which = grip.dataset.fxSplit;
    const startX = event.clientX;
    const startSide = fx.sideWidth;
    const startPreview = fx.previewWidth;
    const rect = body.getBoundingClientRect();
    grip.classList.add("active");
    body.classList.add("resizing");
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (move) => {
      const previewExtra = fx.previewPane ? fx.previewWidth + SPLIT_W : 0;
      if (which === "side") {
        const max = Math.max(SIDE_MIN, Math.floor(rect.width - previewExtra - SPLIT_W - MAIN_MIN));
        fx.sideWidth = clampSide(Math.min(max, startSide + (move.clientX - startX)));
      } else {
        const max = Math.max(PREVIEW_MIN, Math.floor(rect.width - fx.sideWidth - SPLIT_W - (fx.previewPane ? SPLIT_W : 0) - MAIN_MIN));
        fx.previewWidth = clampPreview(Math.min(max, startPreview - (move.clientX - startX)));
      }
      applyLayout();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      grip.classList.remove("active");
      body.classList.remove("resizing");
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      rememberLayout();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
  // The mouse's fourth and fifth buttons are Back and Forward everywhere else
  // in Windows, and in a file browser they mean the previous folder. The
  // webview would otherwise try to walk its own page history, which in a
  // one-page tool does nothing at all - so every phase is swallowed and only
  // the release acts, the way a click works.
  for (const type of ["mousedown", "mouseup", "auxclick"]) {
    host.addEventListener(type, (event) => {
      if (event.button !== 3 && event.button !== 4) return;
      // With no folder to go back to, leave Back unclaimed so the shell
      // returns to wherever Files was opened from.
      if (event.button === 3 && !fx.history.length) return;
      event.preventDefault();
      if (type !== "mouseup") return;
      if (event.button === 3) goBack();
      else goForward();
    });
  }
  host.addEventListener("contextmenu", (event) => {
    if (event.target.closest(".fx-row.head")) return openColumnMenu(event);
    const target = event.target.closest("[data-fx-item], [data-fx-open]");
    const blank = !target && !!event.target.closest(".fx-rows") && writable(fx.path) && !isZipRoot(fx.path);
    if (!target && !blank) return;
    event.preventDefault();
    const path = target ? asPath(target.dataset.fxItem || target.dataset.fxOpen) : fx.path;
    if (path === THIS_PC) return;
    const isDir = !target || target.dataset.fxDir !== "false";
    const nested = isInsideZip(path);
    const inList = !!target?.dataset.fxItem && writable(path);
    if (inList && !selection().some((item) => same(item, path))) select(path);
    const contextPaths = inList ? selection() : [path];
    const marked = fx.bookmarks.some((mark) => same(mark, path));
    closeContext();
    const menu = document.createElement("div");
    menu.className = "fx-context";
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    const item = (action, glyph, label, key = "", danger = false) =>
      `<button type="button"${danger ? ' class="danger"' : ""} data-do="${action}">${icon(glyph)}${label}${key ? `<kbd>${key}</kbd>` : ""}</button>`;
    // Inside a zip the archive is read-only: no delete, no shell, no bookmark.
    // Reveal always points at a real path Windows can show.
    menu.innerHTML = blank
      ? [
          item("new-folder", "create_new_folder", "New folder", "Ctrl+Shift+N"),
          item("paste", "content_paste", "Paste", "Ctrl+V"),
          "<hr>",
          item("terminal", "terminal", "Open a shell here"),
          item("reveal", "frame_inspect", "Show in Windows Explorer"),
          item("refresh", "refresh", "Refresh"),
        ].join("")
      : [
          item("open", isDir ? "folder_open" : "open_in_new", isDir ? "Open folder" : "Open file"),
          isDir ? item("new-window", "tab_duplicate", "Open in new window") : "",
          inList ? "<hr>" + item("cut", "content_cut", "Cut", "Ctrl+X") + item("copy-item", "content_copy", "Copy", "Ctrl+C") : "",
          isDir && writable(path) && !isZipRoot(path) ? item("paste", "content_paste", "Paste into folder") : "",
          inList ? item("rename", "edit", "Rename", "F2") : "",
          "<hr>",
          item("copy", "link", "Copy path"),
          item("reveal", "frame_inspect", nested ? "Show archive in Windows Explorer" : "Show in Windows Explorer"),
          nested ? "" : item("terminal", "terminal", "Open a shell here"),
          isDir && !nested ? item("bookmark", marked ? "bookmark_remove" : "bookmark_add", marked ? "Remove from bookmarks" : "Add to bookmarks") : "",
          writable(path) && !isZipRoot(path) ? "<hr>" + item("delete", "delete", "Delete…", inList ? "Del" : "", true) : "",
        ].join("");
    menu.addEventListener("click", (click) => {
      const action = click.target.closest("[data-do]")?.dataset.do;
      if (!action) return;
      menu.remove();
      if (action === "open") activate(path, isDir);
      else if (action === "new-window") void openInNewWindow(path);
      else if (action === "reveal") invoke("open_in", { path: revealPath(path), target: blank ? "explorer" : "reveal" }).catch(() => {});
      else if (action === "terminal") {
        const shellAt = isZipRoot(path)
          ? path.replace(/\\[^\\]+$/i, "") || path
          : (isDir ? path : fx.path);
        invoke("open_in", { path: isInsideZip(shellAt) ? revealPath(shellAt) : shellAt, target: "terminal" }).catch(() => {});
      }
      else if (action === "copy") navigator.clipboard?.writeText(path).catch(() => {});
      else if (action === "cut" || action === "copy-item") void toClipboard(contextPaths, action === "cut");
      else if (action === "paste") void paste(path);
      else if (action === "rename") startRename(path);
      else if (action === "new-folder") void newFolder();
      else if (action === "refresh") refresh();
      else if (action === "bookmark") toggleBookmark(path);
      else if (action === "delete") askDelete(contextPaths);
    });
    document.body.appendChild(menu);
    // Keep the menu on screen near the bottom and right edges.
    const box = menu.getBoundingClientRect();
    if (box.bottom > innerHeight) menu.style.top = `${Math.max(4, innerHeight - box.height - 4)}px`;
    if (box.right > innerWidth) menu.style.left = `${Math.max(4, innerWidth - box.width - 4)}px`;
    setTimeout(() => document.addEventListener("click", closeContext, { once: true }), 0);
  });
  listenForDrops();
  window.__TAURI__.event?.listen?.("explorer-changed", ({ payload }) => changed(payload?.dirs || []))?.catch?.(() => {});
  window.__TAURI__.event?.listen?.("explorer-external-change", ({ payload }) => {
    if (!same(payload, fx.path)) return;
    clearTimeout(externalChangeTimer);
    externalChangeTimer = setTimeout(() => refresh({ quiet: true }), 750);
  })?.catch?.(() => {});
  window.addEventListener("beforeunload", () => watchFolder(THIS_PC), { once: true });
  render();
}

async function opened() {
  fx.open.add(THIS_PC);
  // The drive list is the first thing on screen, so it is fetched first and
  // the bookmarks fill in beside it rather than holding it up.
  const drives = loadRoots();
  loadBookmarks();
  const layout = loadLayout();
  await Promise.all([drives, layout]);
  // A folder listed before the tool was handed to another window is stale by
  // definition - files move while a window is closed - so re-read it.
  if (fx.path !== THIS_PC && !fx.loading) openFolder(fx.path, { push: false, keepFilter: true });
  // A fresh window (no handoff) opens on This PC; put it back where Files was
  // last, if that folder is still there.
  else if (fx.path === THIS_PC) await restoreLastPath();
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
    sideWidth: fx.sideWidth, previewWidth: fx.previewWidth,
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
  if (state.sideWidth) fx.sideWidth = clampSide(state.sideWidth);
  if (state.previewWidth) fx.previewWidth = clampPreview(state.previewWidth);
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

window.wintExplorer = { mount, render, opened, preparePopout, exportState, importState, openInNewWindow };
})();
