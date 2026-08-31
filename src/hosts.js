// The hosts file: the one line on this machine that beats every DNS server.
//
// It used to be a column inside the DNS tool, where it was always half as tall
// as it needed to be — the add row and the Apply bar were the first things a
// short window cut off. It is a page of its own now: DNS links across to it and
// says when a name being looked up is answered from here, and everything that
// edits the file lives on this page, full width, with one scrolling list.
//
// Nothing is written until Apply. Every edit is staged in memory and shown as
// staged, so the file on disk never moves under anyone.
//
// Kept inside an IIFE on purpose: a classic script that declares mount/wire/
// action at the top level overwrites the same names in dns.js.

(() => {
const hosts_invoke = window.__TAURI__.core.invoke;

/** Long enough to notice, short enough that nobody waits on it. */
const HOSTS_FLASH_MS = 1800;

/** Names that only ever mean this machine or a private network. Anything else
 *  in the file is overriding a name the rest of the world also knows. */
const LOCAL_SUFFIXES = [".local", ".localhost", ".test", ".internal", ".localdomain", ".home.arpa"];

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function looksLikeAddress(value) {
  const text = String(value || "").trim();
  if (IPV4.test(text)) return text.split(".").every((part) => Number(part) <= 255);
  return text.includes(":") && /^[0-9a-f:.]+$/i.test(text);
}

const hosts = {
  /** The hosts file exactly as it is on disk, plus the edits staged on top. */
  file: null,
  loading: false,
  /** line index -> the enabled state it should have. Only differences live here. */
  toggles: new Map(),
  /** line indexes to drop from the file entirely. */
  removed: new Set(),
  /** New mappings, not yet in the file. */
  added: [],
  /** line index -> the { ip, names } it should read instead. A line being
   *  rewritten is an edit like any other: staged, shown, applied on Apply. */
  edits: new Map(),
  /** Which row is open in the editor: a line index, or `add:<n>` for one of
   *  the new lines that has not been written yet. Only ever one at a time. */
  editing: null,
  /** What is in the two editor fields right now. Read back off them before
   *  every redraw so a redraw cannot swallow what is being typed. */
  draft: { ip: "", names: "" },
  /** True on the one frame an editor opens on, so it takes focus once. */
  editorFresh: false,
  /** A whole-file replacement staged from a backup, or null. */
  restoring: null,
  applying: false,

  newIp: "127.0.0.1",
  newName: "",

  /** The line index the "Highlight it" button has just pointed at. */
  flashed: null,
  flashTimer: 0,

  message: "",
  messageTone: "",

  /** Whether the explanation of what the hosts file even is, is open. */
  explaining: false,

  host: null,
  built: false,
};

/* ------------------------------------------------------------- the shell */

function hIcon(name) {
  return window.devhqShell?.icon(name) ?? `<span class="ms" aria-hidden="true">${name}</span>`;
}

function hEsc(value) {
  return window.devhqShell?.esc(value) ?? String(value ?? "");
}

/** The hosts list is on two pages: this one, and the override banner DNS puts
 *  above its answers. Both are redrawn whenever the file changes. */
function hDirty() {
  window.devhqShell?.markDirty("hosts", "dns");
}

function hWork(key, label, detail) {
  window.devhqWork?.beginWork(key, label, detail);
}

function hDone(key) {
  window.devhqWork?.endWork(key);
}

/** Says something on the page itself for a moment, next to the button that
 *  caused it. Anything worth keeping goes in the status bar instead. */
function hSay(text, tone = "") {
  hosts.message = text;
  hosts.messageTone = tone;
  hDirty();
}

function mount(host) {
  if (!host || hosts.built) return;
  hosts.host = host;
  host.innerHTML = `
    <header class="tool-head">
      <button class="btn back tool-back" type="button" data-open-tool="overview"
              title="Back to the overview">${hIcon("arrow_back")}Back</button>
      <span class="tool-plate">${hIcon("edit_note")}</span>
      <span class="tool-title">
        <strong>Hosts file</strong>
        <small>point a name at your own machine — it beats every DNS server</small>
      </span>
      ${window.devhqMaturity?.badge("hosts") ?? ""}
      <button class="tool-popout" type="button" data-popout-tool="hosts"></button>
      <button class="tool-pin" id="tool-pin-hosts" type="button" data-pin-tool="hosts"></button>
      <button class="tool-close" type="button" data-open-tool="overview"
              title="Back to the overview">${hIcon("close")}</button>
    </header>

    <div class="dns-bar hosts-bar">
      <span class="mono dns-hosts-path" id="hosts-path"></span>
      <span class="dns-backups" id="hosts-backups"></span>
      <i class="hosts-bar-gap"></i>
      <button class="dns-what" type="button" data-hosts="what"
              title="What the hosts file is, and what it is for">${hIcon("help")}What is this?</button>
      <button class="btn" type="button" data-hosts="reload"
              title="Read the file from disk again">${hIcon("refresh")}Reload</button>
      <button class="btn" type="button" data-open-tool="dns"
              title="Resolve a name and see who answers">${hIcon("dns")}DNS</button>
    </div>

    <div class="hosts-body">
      <div class="dns-panel hosts-panel">
        <div class="dns-panel-head">${hIcon("dns")}<span class="dns-label">Mappings</span><i></i>
          <span class="dns-answer-note mono" id="hosts-count"></span></div>
        <div class="dns-panel-body" id="hosts-list"></div>
        <div class="dns-add">
          ${hIcon("add")}
          <input id="hosts-new-ip" class="mono" spellcheck="false" autocomplete="off" value="127.0.0.1" />
          <input id="hosts-new-name" class="mono" spellcheck="false" autocomplete="off" placeholder="new.myproject.local" />
          <button class="btn" type="button" data-hosts="add">Add</button>
        </div>
      </div>
    </div>

    <div class="hosts-foot">
      <div class="dns-safety" id="hosts-safety"></div>
      <div class="dns-message" id="hosts-message" hidden></div>
      <div class="dns-staged" id="hosts-staged"></div>
    </div>

    <div id="hosts-dialog"></div>
  `;

  hosts.built = true;
  wire();
}

function field(id) {
  return hosts.host?.querySelector(`#${id}`) || null;
}

function wire() {
  const newIp = field("hosts-new-ip");
  const newName = field("hosts-new-name");
  newIp.oninput = () => {
    hosts.newIp = newIp.value;
  };
  newName.oninput = () => {
    hosts.newName = newName.value;
  };
  newName.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addEntry();
    }
  };

  hosts.host.onclick = (event) => {
    // The pin and the way out mean the same thing here as in the dock.
    const pop = event.target.closest("[data-popout-tool]");
    if (pop) return window.devhqShell?.popOutTool?.(pop.dataset.popoutTool);
    const pin = event.target.closest("[data-pin-tool]");
    if (pin) return window.devhqShell?.toggleToolPin(pin.dataset.pinTool);
    const go = event.target.closest("[data-open-tool]");
    if (go) return window.devhqShell?.openTool(go.dataset.openTool);

    const act = event.target.closest("[data-hosts]");
    // The shaded backdrop closes the explainer, but interacting with the card
    // itself must not bubble up and look like a backdrop click.
    if (act?.classList.contains("dns-overlay") && event.target !== act) return;
    if (act) return action(act.dataset.hosts, act.dataset);
  };

  hosts.host.onkeydown = (event) => {
    if (event.key === "Escape" && hosts.explaining) {
      event.preventDefault();
      explain(false);
      return;
    }
    // The editor is a row, not a dialog: Enter commits it, Escape drops it.
    if (event.target.dataset?.editField) {
      if (event.key === "Enter") {
        event.preventDefault();
        saveEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelEdit();
      }
    }
  };
}

function action(name, data) {
  if (name === "what") return explain(true);
  if (name === "close-what") return explain(false);
  if (name === "reload") return loadHosts(true);
  if (name === "add") return addEntry();
  if (name === "toggle") return toggleLine(Number(data.line));
  if (name === "remove") return removeLine(Number(data.line));
  if (name === "undo-add") return undoAdd(Number(data.index));
  if (name === "lookup") return lookUp(data.host);
  if (name === "edit") return editLine(data.line);
  if (name === "edit-add") return editAdded(Number(data.index));
  if (name === "edit-save") return saveEdit();
  if (name === "edit-cancel") return cancelEdit();
  if (name === "discard") return discard();
  if (name === "apply") return apply();
  if (name === "restore") return restore(data.backup);
}

/** Opened from the dock, from search, or from DNS. */
function opened() {
  ensureLoaded();
  const input = field("hosts-new-name");
  if (input) input.value = hosts.newName;
  hDirty();
}

/** Hand a name over to DNS rather than resolving it here — one tool asks the
 *  questions, this one answers them locally. */
function lookUp(name) {
  window.devhqShell?.openTool("dns");
  window.devhqDns?.lookFor?.(name);
}

/* -------------------------------------------------------------- the file */

function ensureLoaded() {
  if (!hosts.file && !hosts.loading) loadHosts();
}

function loadHosts(again = false) {
  if (hosts.loading) return;
  hosts.loading = true;
  if (again) hSay("");
  hDirty();
  hWork("hosts-read", "Reading the hosts file");
  hosts_invoke("dns_hosts_read")
    .then((file) => {
      hosts.file = file;
      // Anything staged was staged against a file that no longer exists.
      clearEdits();
      if (file.error) hSay(file.error, "bad");
    })
    .catch((error) => hSay(String(error), "bad"))
    .finally(() => {
      hosts.loading = false;
      hDone("hosts-read");
      hDirty();
    });
}

function clearEdits() {
  hosts.toggles.clear();
  hosts.removed.clear();
  hosts.edits.clear();
  hosts.added = [];
  hosts.restoring = null;
  hosts.editing = null;
}

function hostLines() {
  return (hosts.file?.lines || []).filter((line) => line.kind === "entry");
}

/** What a line says once everything staged is taken into account — which is
 *  what every other part of this page, and DNS, has to reason about. */
function effective(line) {
  return hosts.edits.get(line.index) || { ip: line.ip, names: line.names };
}

/** Whether a line is on once everything staged is taken into account. */
function lineEnabled(line) {
  return hosts.toggles.has(line.index) ? hosts.toggles.get(line.index) : line.enabled;
}

function toggleLine(index) {
  const line = hostLines().find((candidate) => candidate.index === index);
  if (!line) return;
  const next = !lineEnabled(line);
  if (next === line.enabled) hosts.toggles.delete(index);
  else hosts.toggles.set(index, next);
  hDirty();
}

function removeLine(index) {
  if (hosts.removed.has(index)) hosts.removed.delete(index);
  else hosts.removed.add(index);
  hDirty();
}

function undoAdd(index) {
  hosts.added.splice(index, 1);
  hDirty();
}

/* ------------------------------------------------------------- editing */

/** Opens the editor on one row. The row is replaced by its own two fields;
 *  nothing is staged until Save, and Escape puts the row back untouched. */
function editLine(key) {
  const line = hostLines().find((candidate) => String(candidate.index) === String(key));
  if (!line) return;
  const now = effective(line);
  hosts.editing = line.index;
  hosts.draft = { ip: now.ip, names: now.names.join(" ") };
  hosts.editorFresh = true;
  hDirty();
}

function editAdded(index) {
  const entry = hosts.added[index];
  if (!entry) return;
  hosts.editing = `add:${index}`;
  hosts.draft = { ip: entry.ip, names: entry.names.join(" ") };
  hosts.editorFresh = true;
  hDirty();
}

function cancelEdit() {
  hosts.editing = null;
  hDirty();
}

/** Reads the editor fields back into the draft. Called before every redraw,
 *  because the list is rebuilt wholesale and would otherwise throw away what
 *  has been typed but not saved. */
function stashDraft() {
  if (hosts.editing === null) return;
  const ip = hosts.host?.querySelector('[data-edit-field="ip"]');
  const names = hosts.host?.querySelector('[data-edit-field="names"]');
  if (ip) hosts.draft.ip = ip.value;
  if (names) hosts.draft.names = names.value;
}

function saveEdit() {
  if (hosts.editing === null) return;
  stashDraft();
  const ip = hosts.draft.ip.trim();
  const names = hosts.draft.names.trim().split(/s+/).filter(Boolean);
  if (!looksLikeAddress(ip)) return hSay(`${ip || "That"} is not an address.`, "warn");
  if (!names.length) return hSay("A line needs at least one name.", "warn");

  const key = hosts.editing;
  if (String(key).startsWith("add:")) {
    const index = Number(String(key).slice(4));
    if (hosts.added[index]) hosts.added[index] = { ip, names };
  } else {
    const line = hostLines().find((candidate) => candidate.index === Number(key));
    if (!line) return;
    // An edit that puts the line back the way it was on disk is not an edit.
    const same = ip === line.ip && names.join(" ") === line.names.join(" ");
    if (same) hosts.edits.delete(line.index);
    else hosts.edits.set(line.index, { ip, names });
  }
  hosts.editing = null;
  hSay("Line staged. Nothing on disk has moved yet.", "");
  hDirty();
}

function addEntry() {
  const ip = (hosts.newIp || "127.0.0.1").trim();
  const name = (hosts.newName || "").trim();
  if (!name) return hSay("A new line needs a name to point somewhere.", "warn");
  if (!looksLikeAddress(ip)) return hSay(`${ip} is not an address.`, "warn");
  hosts.added.push({ ip, names: [name] });
  hosts.newName = "";
  const input = field("hosts-new-name");
  if (input) input.value = "";
  input?.focus();
  hDirty();
}

function highlight(index) {
  hosts.flashed = index;
  clearTimeout(hosts.flashTimer);
  hosts.flashTimer = setTimeout(() => {
    hosts.flashed = null;
    hDirty();
  }, HOSTS_FLASH_MS);
  hDirty();
  setTimeout(() => {
    hosts.host?.querySelector(`[data-host-line="${index}"]`)?.scrollIntoView({ block: "center" });
  }, 0);
}

/** One line written back the way the file writes it. Only lines that have
 *  actually been edited go through here; everything else keeps the bytes it
 *  arrived with, so applying one change never reformats the whole file. */
function lineText(ip, names, comment, enabled) {
  const body = `${ip}\t${names.join(" ")}${comment ? `\t# ${comment}` : ""}`;
  return enabled ? body : `# ${body}`;
}

function editCount() {
  if (hosts.restoring) return 1;
  let count = hosts.removed.size + hosts.added.length + hosts.edits.size;
  for (const [index, enabled] of hosts.toggles) {
    const line = hostLines().find((candidate) => candidate.index === index);
    if (line && line.enabled !== enabled) count += 1;
  }
  return count;
}

/** The whole file as it would be on disk once everything staged is applied. */
function stagedText() {
  if (!hosts.file) return "";
  if (hosts.restoring) return hosts.restoring.text;
  const eol = hosts.file.text.includes("\r\n") ? "\r\n" : "\n";
  const out = [];
  for (const line of hosts.file.lines) {
    if (hosts.removed.has(line.index)) continue;
    if (line.kind === "entry" && (hosts.toggles.has(line.index) || hosts.edits.has(line.index))) {
      const now = effective(line);
      out.push(lineText(now.ip, now.names, line.comment, lineEnabled(line)));
    } else {
      out.push(line.raw);
    }
  }
  // A file that does not end in a newline would otherwise glue the first added
  // line onto its last one.
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  for (const entry of hosts.added) out.push(lineText(entry.ip, entry.names, "added by DevHQ", true));
  return out.join(eol) + eol;
}

function discard() {
  clearEdits();
  hSay("Staged changes dropped. The file on disk was never touched.", "");
  hDirty();
}

function apply() {
  if (!hosts.file || hosts.applying || !editCount()) return;
  const text = stagedText();
  const baseText = hosts.file.text;
  hosts.applying = true;
  hDirty();
  hWork(
    "hosts-apply",
    "Writing the hosts file",
    hosts.file.writable ? "" : "Windows will ask for administrator rights"
  );
  hosts_invoke("dns_hosts_write", { request: { baseText, text } })
    .then((result) => {
      hosts.file = result.file;
      if (result.ok) {
        clearEdits();
        hSay(
          `Hosts file written${result.elevated ? " as administrator" : ""} and the resolver cache flushed. A copy was kept.`,
          "good"
        );
        // Whatever DNS has on screen was answered before this file changed.
        window.devhqDns?.recheck?.();
      } else {
        hSay(result.error, "bad");
      }
    })
    .catch((error) => hSay(String(error), "bad"))
    .finally(() => {
      hosts.applying = false;
      hDone("hosts-apply");
      hDirty();
    });
}

/** A backup is staged, not applied: it lands in the same staged bar as any
 *  other edit, so it can be looked at and dropped before it is written. */
function restore(id) {
  hWork("hosts-restore", "Reading the backup");
  hosts_invoke("dns_hosts_backup", { id })
    .then((text) => {
      clearEdits();
      hosts.restoring = { id, text };
      hSay("Backup staged. Apply to write it back, Discard to drop it.", "");
    })
    .catch((error) => hSay(String(error), "bad"))
    .finally(() => {
      hDone("hosts-restore");
      hDirty();
    });
}

/* ------------------------------------------------ what it means, and why */

function isLocalName(name) {
  const lower = name.toLowerCase();
  return (
    lower === "localhost" ||
    !lower.includes(".") ||
    LOCAL_SUFFIXES.some((suffix) => lower.endsWith(suffix))
  );
}

/** Enabled mappings that point a name the rest of the world also knows at an
 *  address of your own. Not wrong — it is what the file is for — but it is the
 *  thing that is forgotten and then wastes an afternoon. */
function overrideWarnings() {
  const warnings = new Map();
  const seen = new Map();
  for (const line of hostLines()) {
    if (hosts.removed.has(line.index) || !lineEnabled(line)) continue;
    for (const name of effective(line).names) {
      if (!isLocalName(name)) {
        warnings.set(line.index, { icon: "public_off", text: `Overrides the real ${name}` });
      }
      const first = seen.get(name);
      if (first !== undefined && first !== line.index) {
        warnings.set(line.index, { icon: "content_copy", text: `${name} is already mapped above — this line never wins` });
      } else if (first === undefined) {
        seen.set(name, line.index);
      }
    }
  }
  return warnings;
}

/** The staged hosts entries that decide a name. DNS asks this to say, above
 *  its answers, that this machine is not going to use any of them. */
function overridesFor(name) {
  if (!name) return [];
  return hostLines()
    .filter(
      (line) =>
        lineEnabled(line) && !hosts.removed.has(line.index) && effective(line).names.includes(name)
    )
    .map((line) => ({ index: line.index, ...effective(line) }));
}

/** Every mapping, for the DNS list of names worth looking up. */
function entries() {
  return hostLines().map((line) => ({
    index: line.index,
    ...effective(line),
    enabled: lineEnabled(line),
  }));
}

/** DNS sends the user here to look at one line. */
function reveal(index) {
  window.devhqShell?.openTool("hosts");
  ensureLoaded();
  highlight(Number(index));
}

/** DNS sends the user here to map a name it could not resolve. The line is
 *  staged, not written — Apply is still the only thing that touches disk. */
function pinLocal(name) {
  const clean = String(name || "").trim();
  window.devhqShell?.openTool("hosts");
  ensureLoaded();
  if (!clean) return;
  hosts.added.push({ ip: "127.0.0.1", names: [clean] });
  hSay(`${clean} staged as 127.0.0.1. Apply to write it.`, "good");
  hDirty();
}

function explain(open) {
  hosts.explaining = open;
  hDirty();
  requestAnimationFrame(() => {
    if (open) field("hosts-dialog")?.querySelector("[data-hosts='close-what']")?.focus();
    else hosts.host?.querySelector("[data-hosts='what']")?.focus();
  });
}

/* --------------------------------------------------------------- drawing */

function skeletonRows(count, className = "dns-sk-host") {
  return Array.from({ length: count })
    .map(() => `<div class="${className}"><span class="sk sk-line"></span></div>`)
    .join("");
}

function render() {
  if (!hosts.built) return;
  renderBar();
  renderList();
  renderFoot();
  renderDialog();
}

function renderBar() {
  const path = field("hosts-path");
  const backups = field("hosts-backups");

  path.textContent = hosts.file?.path || "C:\\Windows\\System32\\drivers\\etc\\hosts";
  path.title = path.textContent;

  const saved = hosts.file?.backups || [];
  backups.innerHTML = saved.length
    ? `<span class="dns-backup-count" title="${saved.length} copies kept in your app data">${hIcon("history")}${
        saved.length
      } backup${saved.length === 1 ? "" : "s"}</span>
       <button type="button" class="dns-mini-btn" data-hosts="restore" data-backup="${hEsc(saved[0].id)}"
         title="Stage the newest copy, taken ${new Date(saved[0].savedMs).toLocaleString()}">Restore</button>`
    : `<span class="dns-backup-count dim">${hIcon("history")}no backups yet</span>`;
}

/** The two fields that replace a row while it is being edited. */
function editorRow(key, extra = "") {
  return `<div class="dns-host-row editing${extra}" data-host-line="${hEsc(key)}">
    <div class="dns-host-edit">
      ${hIcon("edit")}
      <input class="mono" data-edit-field="ip" spellcheck="false" autocomplete="off"
             value="${hEsc(hosts.draft.ip)}" aria-label="Address" />
      <input class="mono" data-edit-field="names" spellcheck="false" autocomplete="off"
             value="${hEsc(hosts.draft.names)}" aria-label="Names, separated by spaces"
             placeholder="name.example.com another.name" />
      <button type="button" class="btn primary" data-hosts="edit-save"
              title="Stage this line — Enter">Save</button>
      <button type="button" class="btn" data-hosts="edit-cancel"
              title="Leave the line as it was — Escape">Cancel</button>
    </div>
    <span class="dns-host-warn edit">${hIcon("info")}Address first, then one or more names. Nothing is written until Apply.</span>
  </div>`;
}

function renderList() {
  const list = field("hosts-list");
  const count = field("hosts-count");

  // The list is rebuilt wholesale, so an open editor has to survive the
  // rebuild: what has been typed is read back first, and the caret is put back
  // afterwards. Otherwise any redraw underneath swallows the edit.
  const focused = document.activeElement;
  const keepFocus =
    hosts.editing !== null && focused?.dataset?.editField
      ? {
          field: focused.dataset.editField,
          start: focused.selectionStart,
          end: focused.selectionEnd,
        }
      : null;
  stashDraft();

  if (hosts.loading && !hosts.file) {
    list.innerHTML = skeletonRows(8);
    count.textContent = "reading…";
    return;
  }

  const lines = hostLines();
  const warnings = overrideWarnings();
  const rows = lines
    .map((line) => {
      if (hosts.editing === line.index) return editorRow(line.index);
      const on = lineEnabled(line);
      const gone = hosts.removed.has(line.index);
      const now = effective(line);
      const changed = on !== line.enabled || gone || hosts.edits.has(line.index);
      const warn = !gone && on ? warnings.get(line.index) : null;
      const names = now.names.join(" ");
      return `<div class="dns-host-row${on ? "" : " off"}${gone ? " gone" : ""}${
        changed ? " changed" : ""
      }${hosts.flashed === line.index ? " flash" : ""}" data-host-line="${line.index}">
        <div class="dns-host-main">
          <button type="button" class="dns-switch${on && !gone ? " on" : ""}" data-hosts="toggle" data-line="${line.index}"
            role="switch" aria-checked="${on && !gone}"
            title="${on ? "Comment this line out" : "Switch this line back on"}"><i></i></button>
          <button type="button" class="dns-host-open" data-hosts="edit" data-line="${line.index}"
            title="Edit this line">
            <span class="mono dns-host-ip">${hEsc(now.ip)}</span>
            <span class="mono dns-host-name" title="${hEsc(names)}">${hEsc(names)}</span>
          </button>
          <button type="button" class="dns-row-btn" data-hosts="edit" data-line="${line.index}"
            title="Edit this line">${hIcon("edit")}</button>
          <button type="button" class="dns-row-btn" data-hosts="lookup" data-host="${hEsc(now.names[0])}"
            title="Look ${hEsc(now.names[0])} up in DNS">${hIcon("travel_explore")}</button>
          <button type="button" class="dns-row-btn" data-hosts="remove" data-line="${line.index}"
            title="${gone ? "Keep this line after all" : "Delete this line"}">${hIcon(gone ? "undo" : "delete")}</button>
        </div>
        ${warn ? `<span class="dns-host-warn">${hIcon(warn.icon)}${hEsc(warn.text)}</span>` : ""}
      </div>`;
    })
    .join("");

  const additions = hosts.added
    .map((entry, index) => {
      if (hosts.editing === `add:${index}`) return editorRow(`add:${index}`, " added");
      return `<div class="dns-host-row added">
        <div class="dns-host-main">
          <span class="dns-switch on static"><i></i></span>
          <button type="button" class="dns-host-open" data-hosts="edit-add" data-index="${index}"
            title="Edit this line">
            <span class="mono dns-host-ip">${hEsc(entry.ip)}</span>
            <span class="mono dns-host-name">${hEsc(entry.names.join(" "))}</span>
          </button>
          <button type="button" class="dns-row-btn" data-hosts="edit-add" data-index="${index}"
            title="Edit this line">${hIcon("edit")}</button>
          <span class="dns-row-btn-slot"></span>
          <button type="button" class="dns-row-btn" data-hosts="undo-add" data-index="${index}"
            title="Drop this new line">${hIcon("close")}</button>
        </div>
        <span class="dns-host-warn new">${hIcon("add")}New — not written yet</span>
      </div>`;
    })
    .join("");

  list.innerHTML =
    rows || additions
      ? `${rows}${additions}`
      : `<div class="dns-empty">${hEsc(hosts.file?.error || "The hosts file has no mappings in it.")}</div>`;

  if (keepFocus) {
    const back = list.querySelector(`[data-edit-field="${keepFocus.field}"]`);
    if (back) {
      back.focus();
      try {
        back.setSelectionRange(keepFocus.start, keepFocus.end);
      } catch (_) {
        // Some inputs refuse a selection range; the value is what matters.
      }
    }
  } else if (hosts.editing !== null && hosts.editorFresh) {
    // Only on the frame the editor opened on — a later redraw must not pull
    // focus back out of whatever the user has moved on to.
    hosts.editorFresh = false;
    list.querySelector(`[data-edit-field="names"]`)?.focus();
  }

  const shown = lines.length + hosts.added.length;
  count.textContent = shown ? `${shown} line${shown === 1 ? "" : "s"}` : "";
}

function renderFoot() {
  const safety = field("hosts-safety");
  const staged = field("hosts-staged");

  // What the file means for this machine, said plainly, under the list.
  const active = hostLines().filter((line) => lineEnabled(line) && !hosts.removed.has(line.index));
  const overriding = active.filter((line) => effective(line).names.some((name) => !isLocalName(name)));
  // Writable outright, or writable because DevHQ happens to be elevated.
  const writable = hosts.file?.writable || hosts.file?.elevated;
  safety.innerHTML = `${hIcon(overriding.length ? "warning" : "verified_user")}
    <span class="dns-safety-text">
      <strong>${active.length} mapping${active.length === 1 ? "" : "s"} in force${
    overriding.length ? `, ${overriding.length} overriding a real domain` : ""
  }</strong>
      <small class="mono">${
        writable
          ? "This file is writable — changes are applied directly"
          : "Windows will ask for administrator rights to write this file"
      }</small>
    </span>`;
  safety.className = `dns-safety${overriding.length ? " warn" : ""}`;

  const count = editCount();
  const label = hosts.restoring
    ? `Restore of the copy taken ${new Date(Number(hosts.restoring.id.replace(/\D/g, ""))).toLocaleString()}`
    : count
    ? `${count} staged change${count === 1 ? "" : "s"} — nothing on disk has moved yet`
    : "Nothing staged. Toggle a line or add one.";
  staged.innerHTML = `${hIcon(count ? "pending_actions" : "check_circle")}
    <span class="dns-staged-text">${hEsc(label)}</span>
    <button type="button" class="btn" data-hosts="discard" ${count ? "" : "disabled"}>Discard</button>
    <button type="button" class="btn primary" data-hosts="apply" ${count && !hosts.applying ? "" : "disabled"}>${hIcon(
    "shield_person"
  )}${hosts.applying ? "Applying…" : "Apply"}</button>`;
  staged.className = `dns-staged${count ? " on" : ""}`;

  // The outcome of the last click, said next to the button that caused it.
  const message = field("hosts-message");
  message.hidden = !hosts.message;
  message.className = `dns-message ${hosts.messageTone}`;
  message.textContent = hosts.message;
}

/** The hosts file is not DNS at all, and the reason the two tools sit next to
 *  each other is exactly the thing that has to be explained: this one wins. */
function renderDialog() {
  const host = field("hosts-dialog");
  if (!hosts.explaining) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `<div class="dns-overlay" data-hosts="close-what">
    <div class="dns-dialog" role="dialog" aria-modal="true" aria-label="What the hosts file is">
      <header>${hIcon("edit_note")}<h3>What the hosts file is</h3>
        <button type="button" data-hosts="close-what" title="Close">${hIcon("close")}</button></header>
      <p>A plain text file on this machine that maps names to addresses. Windows reads it
        <b>before it asks any DNS server</b>, so a line in here beats every record the DNS
        tool can show you — including the real, public answer for a name you do not own.</p>
      <p>That is what makes it useful. Point a name your product actually uses at your own
        machine, and your development environment can be reached under that name rather than
        under <code>localhost</code>:</p>
      <pre class="mono">127.0.0.1    dev.yourproduct.com</pre>
      <p>Which is how you get cookies scoped to the right domain, OAuth redirect URLs that
        match, and TLS certificates that are not shouting at you — all against a name that
        looks like production. Your dev server has to be willing to answer to that name too;
        most frameworks need the host allow-listed before they will.</p>
      <ul>
        <li>${hIcon("computer")}<span>It only affects <b>this machine</b>. Nobody else on the
          network, and no other device, sees any of it.</span></li>
        <li>${hIcon("shield_person")}<span>It lives in Windows, so writing it needs
          administrator rights. DevHQ takes a copy first and asks only when it must.</span></li>
        <li>${hIcon("lan")}<span>It maps names to <b>addresses only</b> — never to a port.
          <code>dev.yourproduct.com</code> still reaches your server on whatever port it is
          listening on.</span></li>
        <li>${hIcon("cleaning_services")}<span>Windows caches the old answer, so a change is
          not in force until the cache is flushed. Applying here does that for you.</span></li>
      </ul>
      <footer><button class="btn primary" type="button" data-hosts="close-what">Got it</button></footer>
    </div>
  </div>`;
}

window.devhqHosts = {
  mount,
  render,
  opened,
  ensureLoaded,
  entries,
  overridesFor,
  reveal,
  pinLocal,
  exportState() { return { file:hosts.file, loading:hosts.loading, toggles:[...hosts.toggles], removed:[...hosts.removed], added:hosts.added, edits:[...hosts.edits], editing:hosts.editing, draft:hosts.draft, restoring:hosts.restoring, applying:hosts.applying, newIp:hosts.newIp, newName:hosts.newName, flashed:hosts.flashed, message:hosts.message, messageTone:hosts.messageTone, explaining:hosts.explaining }; },
  importState(state) { if(!state)return;Object.assign(hosts,state,{toggles:new Map(state.toggles||[]),removed:new Set(state.removed||[]),edits:new Map(state.edits||[]),host:hosts.host,built:hosts.built,flashTimer:0});if(hosts.host)render(); },
};

})();
