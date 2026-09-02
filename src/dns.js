// The DNS tool: what a name resolves to, and whether everybody agrees about it.
//
// The hosts file is a tool of its own (`hosts.js`). DNS asks it one question —
// is there a line here that decides this name? — and says so above the answers,
// because a hosts entry beats every record below it. Everything that edits the
// file lives over there.
//
// It lives in a file of its own and builds its own DOM once, into the host the
// shell hands it. Nothing here ever replaces that subtree wholesale — the
// domain field and the interest field are mounted at `mount()` and are never
// rebuilt, so focus and caret survive every result that streams in.
//
// Everything it asks for goes to a `#[tauri::command]` that answers off the UI
// thread. A resolver that never replies costs a spinner and nothing else.

const dns_invoke = window.__TAURI__.core.invoke;

/** Long enough to notice, short enough that nobody waits on it. */
const DNS_FLASH_MS = 1800;

/** The types the Records panel can be narrowed to, in the order the backend
 *  asks for them. `ALL` is a filter, not a type. */
const DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "SRV", "CAA"];

const DNS_INTERESTS_KEY = "wint.dns.interests.v1";

function loadInterestPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(DNS_INTERESTS_KEY) || "{}");
    return {
      added: new Set(Array.isArray(saved.added) ? saved.added : []),
      hidden: new Set(Array.isArray(saved.hidden) ? saved.hidden : []),
    };
  } catch (_) {
    return { added: new Set(), hidden: new Set() };
  }
}

const interestPrefs = loadInterestPrefs();

const dns = {
  /** What is in the field. Only ever read from the input on the way out. */
  query: "",
  /** The name the results on screen belong to, which is not the field: the
   *  field can be edited without the panels underneath it going stale-silent. */
  name: "",
  lookup: null,
  looking: false,
  reversing: false,

  typeFilter: "ALL",

  resolvers: [],
  comparing: false,

  /** Domains found in the scanned projects, and whether that has been done. */
  domains: [],
  domainsLoaded: false,
  domainsLoading: false,
  addedDomains: interestPrefs.added,
  hiddenDomains: interestPrefs.hidden,
  newDomain: "",

  host: null,
  built: false,
};

/* ------------------------------------------------------------ the shell */

function dnsIcon(name) {
  return window.wintShell?.icon(name) ?? `<span class="ms" aria-hidden="true">${name}</span>`;
}

function dnsEsc(value) {
  return window.wintShell?.esc(value) ?? String(value ?? "");
}

function dnsDirty() {
  window.wintShell?.markDirty("dns");
}

function dnsWork(key, label, detail) {
  window.wintWork?.beginWork(key, label, detail);
}

function dnsDone(key) {
  window.wintWork?.endWork(key);
}

/** Says something in the tool itself for a moment. Anything worth keeping goes
 *  in the status bar instead; this is for the outcome of a click, next to the
 *  thing that was clicked. */
function dnsSay(text, tone = "") {
  dns.message = text;
  dns.messageTone = tone;
  dnsDirty();
}

function mount(host) {
  if (!host || dns.built) return;
  dns.host = host;
  host.innerHTML = `
    <header class="tool-head">
      <button class="btn back tool-back" type="button" data-open-tool="overview"
              title="Back to the overview">${dnsIcon("arrow_back")}Back</button>
      <span class="tool-plate">${dnsIcon("dns")}</span>
      <span class="tool-title">
        <strong>DNS</strong>
        <small>resolve a name, compare resolvers, see who really answers</small>
      </span>
      ${window.wintMaturity?.badge("dns") ?? ""}
      <button class="tool-popout" type="button" data-popout-tool="dns"></button>
      <button class="tool-pin" id="tool-pin-dns" type="button" data-pin-tool="dns"></button>
      <button class="tool-close" type="button" data-open-tool="overview"
              title="Back to the overview">${dnsIcon("close")}</button>
    </header>

    <div class="dns-bar">
      <label class="field dns-field" for="dns-query">${dnsIcon("travel_explore")}
        <input id="dns-query" class="mono" spellcheck="false" autocomplete="off"
               placeholder="example.com, 93.184.216.34, myproject.local" />
        <kbd>Enter</kbd>
      </label>
      <button class="btn primary" type="button" data-dns="resolve">${dnsIcon("search")}<span>Resolve</span></button>
      <button class="btn" type="button" data-dns="reverse"
              title="Look the address up backwards, for the name behind it">${dnsIcon("swap_horiz")}Reverse</button>
      <button class="btn" type="button" data-dns="flush"
              title="Empty the Windows resolver cache">${dnsIcon("cleaning_services")}Flush cache</button>
      <button class="btn" type="button" data-open-tool="hosts"
              title="Edit the hosts file — the mappings this machine uses before it asks anyone">${dnsIcon("edit_note")}Hosts file</button>
    </div>

    <div class="dns-body">
      <aside class="dns-panel dns-domains">
        <div class="dns-panel-head">${dnsIcon("folder_code")}<span class="dns-label">Domains of interest</span>
          <button class="dns-mini" type="button" data-dns="domains-reload"
                  title="Read the projects again">${dnsIcon("refresh")}</button></div>
        <div class="dns-panel-body" id="dns-domain-list"></div>
        <div class="dns-interest-add">
          <input id="dns-new-domain" class="mono" spellcheck="false" autocomplete="off" placeholder="dev.yourproduct.com" />
          <button class="btn" type="button" data-dns="domain-add">Add</button>
        </div>
        <div class="dns-panel-foot">${dnsIcon("link")}Discovered and manually added domains</div>
      </aside>

      <section class="dns-main">
        <div class="dns-message" id="dns-message" hidden></div>
        <div id="dns-override"></div>
        <div id="dns-super"></div>
        <div class="dns-panel dns-records">
          <div class="dns-panel-head"><span class="dns-label">Records</span>
            <div class="seg" id="dns-types"></div>
            <i></i>
            <span class="dns-answer-note mono" id="dns-answer-note"></span>
          </div>
          <div class="dns-panel-body" id="dns-record-list"></div>
          <div class="dns-panel-foot dns-query-foot" id="dns-query-foot"></div>
        </div>

        <div class="dns-panel dns-resolvers">
          <div class="dns-panel-head">${dnsIcon("compare_arrows")}<span class="dns-label">Resolvers</span><i></i>
            <span class="dns-verdict" id="dns-verdict"></span></div>
          <div class="dns-panel-body" id="dns-resolver-list"></div>
        </div>
      </section>

    </div>
  `;

  dns.built = true;
  wire();
}

function field(id) {
  return dns.host?.querySelector(`#${id}`) || null;
}

function wire() {
  const input = field("dns-query");
  input.oninput = () => {
    dns.query = input.value;
  };
  input.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      resolve();
    }
    // Up a level, without reaching for the mouse or retyping the name.
    if (event.altKey && event.key === "ArrowUp") {
      event.preventDefault();
      upOneLevel();
    }
  };

  const newDomain = field("dns-new-domain");
  newDomain.oninput = () => {
    dns.newDomain = newDomain.value;
  };
  newDomain.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addInterest(newDomain.value);
    }
  };

  dns.host.onclick = (event) => {
    // The pin and the way out mean the same thing here as in the dock.
    const pop = event.target.closest("[data-popout-tool]");
    if (pop) return window.wintShell?.popOutTool?.(pop.dataset.popoutTool);
    const pin = event.target.closest("[data-pin-tool]");
    if (pin) return window.wintShell?.toggleToolPin(pin.dataset.pinTool);
    const go = event.target.closest("[data-open-tool]");
    if (go) return window.wintShell?.openTool(go.dataset.openTool);

    const act = event.target.closest("[data-dns]");
    if (act) return action(act.dataset.dns, act.dataset);

    const domain = event.target.closest("[data-dns-domain]");
    if (domain) return lookFor(domain.dataset.dnsDomain);

    const type = event.target.closest("[data-dns-type]");
    if (type) {
      dns.typeFilter = type.dataset.dnsType;
      return dnsDirty();
    }
  };

  dns.host.onkeydown = (event) => {
    const domain = event.target.closest("[data-dns-domain]");
    if (domain && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      lookFor(domain.dataset.dnsDomain);
    }
  };
}

function action(name, data) {
  if (name === "resolve") return resolve();
  if (name === "reverse") return reverse();
  if (name === "flush") return flush();
  if (name === "domains-reload") return loadDomains(true);
  if (name === "domain-add") return addInterest(dns.newDomain);
  if (name === "domain-remove") return removeInterest(data.host);
  if (name === "domain-toggle") return toggleInterest(data.host);
  if (name === "lookup") return lookFor(data.host);
  // Both of these leave for the Hosts file tool, which owns every edit.
  if (name === "show-host-line") return window.wintHosts?.reveal(Number(data.line));
  if (name === "pin-local") return window.wintHosts?.pinLocal(dns.name);
}

/** Opened from the dock, from search, or from a shortcut. Everything the tool
 *  needs is asked for here, in parallel, and drawn as it lands. */
function opened() {
  if (!dns.domainsLoaded) loadDomains();
  // The hosts file decides some of these names, so it is read even though it
  // is edited elsewhere — the override banner is the whole reason.
  window.wintHosts?.ensureLoaded();
  const input = field("dns-query");
  if (input) {
    input.value = dns.query;
    // The field is the first thing anyone reaches for.
    setTimeout(() => input.focus(), 0);
  }
  dnsDirty();
}

/* ------------------------------------------------------------- looking up */

function lookFor(name) {
  dns.query = name;
  const input = field("dns-query");
  if (input) input.value = name;
  resolve();
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function looksLikeAddress(value) {
  return IPV4.test(value) || (value.includes(":") && /^[0-9a-f:]+$/i.test(value));
}

/** Second-level labels that registries sell under rather than register
 *  themselves: `co.uk`, `com.au`, `co.jp`. Nobody can look one of these up and
 *  learn anything, so the walk up stops below them. This is a heuristic, not
 *  the public suffix list — it is only deciding which chip to draw. */
const REGISTRY_LABELS = new Set([
  "co", "com", "net", "org", "ac", "edu", "gov", "mil", "ltd", "plc", "me",
  "sch", "or", "ne", "in", "gr", "nom", "info", "biz",
]);

/** Whether a name is a public suffix — a level names are sold under, not a
 *  domain anybody owns. Bare TLDs are always one. */
function isPublicSuffix(name) {
  const labels = name.split(".");
  if (labels.length <= 1) return true;
  return labels.length === 2 && labels[1].length === 2 && REGISTRY_LABELS.has(labels[0]);
}

/** Every domain above this one that somebody actually owns, nearest first:
 *  `api.login.broker` gives `login.broker` and stops. The walk ends at the
 *  registrable name — `broker`, `com` and `co.uk` are levels the registry
 *  sells under, and offering them would be offering a dead end.
 *
 *  RFC 8499 calls a domain that contains another its *superdomain* — the exact
 *  inverse of subdomain, and precisely what taking a label off the front of a
 *  name gives you. "Parent" is a delegation word: the parent of a name is the
 *  zone that delegates it, which is only sometimes the label above and cannot
 *  be known without asking. "Apex" is wrong too — that is the top of a zone,
 *  and `b.example.com` has a name above it that is nobody's apex. */
function superdomains(name) {
  let text = String(name || "").trim();
  while (text.endsWith(".")) text = text.slice(0, -1);
  const labels = text.split(".").filter(Boolean);
  const out = [];
  for (let at = 1; at < labels.length; at += 1) {
    const above = labels.slice(at).join(".");
    if (isPublicSuffix(above)) break;
    out.push(above);
  }
  return out;
}

/** The name the tool is on, or failing that whatever has been typed. An
 *  address has no labels to walk up, so it has no superdomains. */
function currentName() {
  const name = dns.name || (dns.query || "").trim();
  return looksLikeAddress(name) ? "" : name;
}

function upOneLevel() {
  const up = superdomains(currentName())[0];
  if (!up) return dnsSay("There is nothing above this name to look up.", "warn");
  lookFor(up);
}

function resolve() {
  const name = (dns.query || "").trim().replace(/^[a-z]+:\/\//i, "").split("/")[0];
  if (!name) return dnsSay("Type a name or an address to look up.", "warn");
  // An address typed into the field can only mean one question.
  if (looksLikeAddress(name)) return reverse();

  dns.name = name;
  dns.looking = true;
  dns.lookup = null;
  dns.message = "";
  dnsDirty();
  dnsWork("dns-lookup", `Resolving ${name}`, "every record type at once");
  dns_invoke("dns_lookup", { name, server: "", types: [] })
    .then((result) => {
      // A slower lookup for a name nobody is asking about any more must not
      // land on top of the one they are.
      if (dns.name !== name) return;
      dns.lookup = result;
      if (result.error) dnsSay(result.error, "bad");
    })
    .catch((error) => dnsSay(String(error), "bad"))
    .finally(() => {
      if (dns.name === name) dns.looking = false;
      dnsDone("dns-lookup");
      dnsDirty();
    });

  compare(name);
}

function compare(name) {
  dns.comparing = true;
  dns.resolvers = [];
  dnsWork("dns-compare", `Asking every resolver about ${name}`, "system, Cloudflare, Google, Quad9, OpenDNS");
  dns_invoke("dns_compare", { name, rtype: "A" })
    .then((answers) => {
      if (dns.name !== name) return;
      dns.resolvers = answers;
    })
    .catch(() => {})
    .finally(() => {
      if (dns.name === name) dns.comparing = false;
      dnsDone("dns-compare");
      dnsDirty();
    });
}

/** The name behind an address. Takes the address from the field when there is
 *  one there, and otherwise from the first A record on screen. */
function reverse() {
  const typed = (dns.query || "").trim();
  const fallback = (dns.lookup?.records || []).find((record) => record.rtype === "A")?.value;
  const address = looksLikeAddress(typed) ? typed : fallback;
  if (!address) return dnsSay("Reverse needs an address — type one, or resolve a name first.", "warn");

  dns.name = address;
  dns.reversing = true;
  dns.lookup = null;
  dns.resolvers = [];
  dns.message = "";
  dnsDirty();
  dnsWork("dns-reverse", `Looking up the name behind ${address}`);
  dns_invoke("dns_reverse", { address })
    .then((result) => {
      if (dns.name !== address) return;
      dns.lookup = result;
      if (result.error) dnsSay(result.error, "bad");
      else if (!result.records.length) dnsSay(`Nothing claims ${address}. It has no PTR record.`, "warn");
    })
    .catch((error) => dnsSay(String(error), "bad"))
    .finally(() => {
      if (dns.name === address) dns.reversing = false;
      dnsDone("dns-reverse");
      dnsDirty();
    });
}

function flush() {
  dnsWork("dns-flush", "Flushing the Windows resolver cache");
  dns_invoke("dns_flush")
    .then((error) => {
      if (error) return dnsSay(error, "bad");
      dnsSay("Resolver cache emptied. The next lookup asks the network again.", "good");
      if (dns.name) resolve();
    })
    .catch((error) => dnsSay(String(error), "bad"))
    .finally(() => dnsDone("dns-flush"));
}

/* --------------------------------------------- the names worth looking up */

function interestName(value) {
  let name = String(value || "").trim().replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0];
  if (name.split(":").length === 2) name = name.split(":")[0];
  name = name.toLowerCase().replace(/\.+$/, "");
  if (!name || looksLikeAddress(name) || name.length > 253 || !/^[a-z0-9_.-]+$/i.test(name)) return "";
  return name;
}

function saveInterestPrefs() {
  try {
    localStorage.setItem(
      DNS_INTERESTS_KEY,
      JSON.stringify({ added: [...dns.addedDomains], hidden: [...dns.hiddenDomains] })
    );
  } catch (_) {
    // Storage can be disabled; the controls still work for this session.
  }
}

function addInterest(value) {
  const name = interestName(value);
  if (!name) return dnsSay("Enter a domain name to add to the list.", "warn");
  dns.addedDomains.add(name);
  dns.hiddenDomains.delete(name);
  dns.newDomain = "";
  const input = field("dns-new-domain");
  if (input) input.value = "";
  saveInterestPrefs();
  dnsSay(`${name} added to domains of interest.`, "good");
  dnsDirty();
  input?.focus();
}

function removeInterest(value) {
  const name = interestName(value);
  if (!name) return;
  dns.addedDomains.delete(name);
  dns.hiddenDomains.add(name);
  saveInterestPrefs();
  dnsSay(`${name} hidden. It will stay filtered out when projects are rescanned.`, "good");
  dnsDirty();
}

function toggleInterest(value) {
  const name = interestName(value);
  if (!name) return;
  if (domainList().some((row) => row.host === name)) removeInterest(name);
  else addInterest(name);
}

function loadDomains(again = false) {
  const projects = window.wintShell?.projects() || [];
  if (!projects.length) {
    dns.domainsLoaded = true;
    return dnsDirty();
  }
  if (dns.domainsLoading) return;
  dns.domainsLoading = true;
  if (again) dns.domains = [];
  dnsDirty();
  dnsWork("dns-domains", "Reading the names your projects use", `${projects.length} projects`);
  dns_invoke("dns_project_domains", {
    paths: projects.map((project) => project.path),
    names: projects.map((project) => project.name),
  })
    .then((rows) => {
      dns.domains = rows;
      dns.domainsLoaded = true;
    })
    .catch((error) => dnsSay(String(error), "bad"))
    .finally(() => {
      dns.domainsLoading = false;
      dnsDone("dns-domains");
      dnsDirty();
    });
}

/** After the hosts file is written, whatever is on screen was answered
 *  before it changed. The Hosts tool calls this so the answers catch up. */
function recheck() {
  if (dns.name && !looksLikeAddress(dns.name)) resolve();
  else dnsDirty();
}

/* --------------------------------------------------------------- drawing */

function render() {
  if (!dns.built) return;
  renderDomains();
  renderOverride();
  renderSuperdomains();
  renderTypes();
  renderRecords();
  renderResolvers();
  renderMessage();
}

/** The outcome of the last click, said above the answers it belongs to. */
function renderMessage() {
  const message = field("dns-message");
  message.hidden = !dns.message;
  message.className = `dns-message ${dns.messageTone}`;
  message.textContent = dns.message;
}

function skeletonRows(count, className = "dns-sk-row") {
  return Array.from({ length: count })
    .map(() => `<div class="${className}"><span class="sk sk-line"></span></div>`)
    .join("");
}

/* ---- the names worth looking up */

/** Every name the tool knows about: what the projects talk to, and what the
 *  hosts file already has an opinion about. */
/** One row per name, in one flat list. The same host turning up in four
 *  projects is still one name to look up, so it gets one row: the first place
 *  it was found names it, and the rest are counted rather than repeated. */
function domainList() {
  const found = new Map();
  const push = (host, where) => {
    host = interestName(host);
    if (!host || dns.hiddenDomains.has(host)) return;
    const existing = found.get(host);
    if (existing) {
      if (!existing.where.includes(where)) existing.where.push(where);
      return;
    }
    found.set(host, { host, where: [where] });
  };
  for (const row of dns.domains) push(row.host, `${row.project} · ${row.note}`);
  for (const host of dns.addedDomains) push(host, "Added by you");
  for (const line of window.wintHosts?.entries() || []) {
    for (const name of line.names) {
      push(name, `hosts · ${line.enabled ? "on" : "off"} · ${line.ip}`);
    }
  }
  // Alphabetical: with no groups to navigate by, the only way to find a name
  // in a long list is to know where it will be.
  return [...found.values()].sort((a, b) => a.host.localeCompare(b.host));
}

function renderDomains() {
  const host = field("dns-domain-list");
  const rows = domainList();
  if (!rows.length) {
    host.innerHTML = dns.domainsLoading
      ? skeletonRows(5)
      : `<div class="dns-empty">Nothing found yet. Scan a folder of projects, or just type a name above.</div>`;
    return;
  }
  host.innerHTML = rows
    .map((row) => {
      const on = row.host === dns.name;
      const extra = row.where.length - 1;
      const note = extra ? `${row.where[0]} +${extra} more` : row.where[0];
      return `<div class="dns-domain${on ? " on" : ""}" role="button" tabindex="0"
        data-dns-domain="${dnsEsc(row.host)}"
        title="Look ${dnsEsc(row.host)} up — found in ${dnsEsc(row.where.join(", "))}">
        <i class="dot ${on ? "blue" : "grey"}"></i>
        <span><strong class="mono">${dnsEsc(row.host)}</strong><small>${dnsEsc(note)}</small></span>
        <button type="button" class="dns-domain-remove" data-dns="domain-remove" data-host="${dnsEsc(row.host)}"
          title="Remove and hide ${dnsEsc(row.host)}">${dnsIcon("close")}</button>
      </div>`;
    })
    .join("");
}

/* ---- what your own machine is saying instead */

/** The hosts file deciding the name being looked at is the single most
 *  misleading thing DNS can do to a developer, so it is said first, above the
 *  answers, rather than left to be noticed. The line itself is edited in the
 *  Hosts file tool, which this points at. */
function renderOverride() {
  const host = field("dns-override");
  const overrides = window.wintHosts?.overridesFor(dns.name) || [];
  if (!overrides.length) {
    host.innerHTML = "";
    return;
  }
  const line = overrides[0];
  host.innerHTML = `<div class="dns-override">${dnsIcon("edit_note")}
    <span>Your hosts file sends <b class="mono">${dnsEsc(dns.name)}</b> to
      <b class="mono">${dnsEsc(line.ip)}</b>. That is what this machine will use, whatever the records below say.</span>
    <i></i>
    <button type="button" class="dns-mini-btn" data-dns="show-host-line" data-line="${line.index}"
      title="Open the Hosts file tool at this line">${dnsIcon("edit_note")}Show the line</button>
  </div>`;
}

/** The way up the tree, one chip per level. The first is the name one label
 *  above whatever is on screen, and is the one anybody actually wants: it is
 *  where the NS records that delegate the name being looked at will be. */
function renderSuperdomains() {
  const host = field("dns-super");
  const levels = superdomains(currentName());
  if (!levels.length) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `<div class="dns-super">${dnsIcon("arrow_upward")}
    <span class="dns-label">Superdomains</span>
    ${levels
      .map(
        (level, at) => `<button type="button" class="dns-crumb" data-dns-domain="${dnsEsc(level)}"
          title="Look ${dnsEsc(level)} up${at ? "" : " — Alt+Up"}">${dnsEsc(level)}</button>`
      )
      .join(`<i class="dns-crumb-sep">${dnsIcon("chevron_right")}</i>`)}
  </div>`;
}

/* ---- the records */

function renderTypes() {
  const host = field("dns-types");
  const records = dns.lookup?.records || [];
  const counts = new Map();
  for (const record of records) counts.set(record.rtype, (counts.get(record.rtype) || 0) + 1);
  const chips = [["ALL", records.length], ...DNS_TYPES.map((type) => [type, counts.get(type) || 0])];
  host.innerHTML = chips
    .map(([type, count]) => {
      const on = dns.typeFilter === type;
      return `<button type="button" class="${on ? "on" : ""}${count ? "" : " empty"}"
        data-dns-type="${type}" aria-pressed="${on}"
        title="${count ? `${count} ${type} record${count === 1 ? "" : "s"}` : `No ${type} records`}"
        >${type}${count ? `<span>${count}</span>` : ""}</button>`;
    })
    .join("");
}

function shownRecords() {
  const records = dns.lookup?.records || [];
  return dns.typeFilter === "ALL"
    ? records
    : records.filter((record) => record.rtype === dns.typeFilter);
}

function ttlText(seconds) {
  if (seconds >= 86400) return `${Math.round(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

function renderRecords() {
  const host = field("dns-record-list");
  const note = field("dns-answer-note");
  const foot = field("dns-query-foot");
  const busy = dns.looking || dns.reversing;

  if (busy) {
    host.innerHTML = skeletonRows(6, "dns-sk-record");
    note.textContent = "asking…";
    foot.innerHTML = `<span class="mono">${dnsEsc(dns.name)}</span><i></i><span class="mono dim">waiting</span>`;
    return;
  }
  if (!dns.lookup) {
    host.innerHTML = `<div class="dns-empty dns-empty-big">${dnsIcon("travel_explore")}
      <strong>Nothing looked up yet</strong>
      <span>Type a name and press Enter, or pick one from the list on the left.</span></div>`;
    note.textContent = "";
    foot.innerHTML = `<span class="dim">Ready</span>`;
    return;
  }

  const records = shownRecords();
  const nx = dns.lookup.rcode === "NXDOMAIN";
  if (!records.length) {
    host.innerHTML = nx
      ? `<div class="dns-empty dns-empty-big bad">${dnsIcon("block")}
          <strong>NXDOMAIN</strong>
          <span class="mono">${dnsEsc(dns.lookup.name)} does not exist as far as ${dnsEsc(dns.lookup.serverLabel)} is concerned</span>
          <button type="button" class="btn" data-dns="pin-local">${dnsIcon("edit_note")}Pin it to 127.0.0.1 in hosts</button>
        </div>`
      : `<div class="dns-empty dns-empty-big">${dnsIcon("search_off")}
          <strong>No ${dns.typeFilter === "ALL" ? "" : `${dns.typeFilter} `}records</strong>
          <span>${dnsEsc(dns.lookup.error || `${dns.lookup.name} answered, but with nothing of that kind.`)}</span></div>`;
  } else {
    const asked = (dns.lookup.name || "").replace(/\.$/, "").toLowerCase();
    host.innerHTML = records
      .map(
        (record) => `<div class="dns-record">
          <span class="dns-rtype mono t-${record.rtype.toLowerCase()}">${dnsEsc(record.rtype)}</span>
          <span class="dns-rvalue mono">
            ${
              record.name
                ? `<span class="dns-rname${
                    record.name.replace(/\.$/, "").toLowerCase() === asked ? "" : " off"
                  }">${dnsEsc(record.name)}</span>`
                : ""
            }
            <span class="dns-rdata">${dnsEsc(record.value)}</span>
          </span>
          <span class="dns-rmeta">
            <span class="mono">TTL ${ttlText(record.ttl)}</span>
            ${record.note ? `<small>${dnsEsc(record.note)}</small>` : ""}
          </span>
          ${
            record.rtype === "A" || record.rtype === "AAAA" || record.rtype === "CNAME"
              ? `<button type="button" class="dns-row-btn" data-dns="lookup" data-host="${dnsEsc(record.value)}"
                   title="Look ${dnsEsc(record.value)} up">${dnsIcon("travel_explore")}</button>`
              : `<span class="dns-row-btn-slot"></span>`
          }
        </div>`
      )
      .join("");
  }

  const total = (dns.lookup.records || []).length;
  const lookedUpName = interestName(dns.lookup.name);
  const isInteresting = lookedUpName && domainList().some((row) => row.host === lookedUpName);
  note.textContent = total
    ? `${total} answer${total === 1 ? "" : "s"}${dns.typeFilter === "ALL" ? "" : ` · ${records.length} shown`}`
    : dns.lookup.rcode || "";
  foot.innerHTML = `<span class="mono">${dnsEsc(dns.lookup.name)} · ${dnsEsc(dns.lookup.serverLabel)} (${dnsEsc(
    dns.lookup.server
  )})</span><i></i>${lookedUpName ? `<button type="button" class="dns-mini-btn" data-dns="domain-toggle"
    data-host="${dnsEsc(lookedUpName)}">${dnsIcon(isInteresting ? "remove" : "add")}${
    isInteresting ? "Remove from interests" : "Add to interests"
  }</button>` : ""}<span class="mono ${dns.lookup.error ? "bad" : "good"}">${
    dns.lookup.error ? dnsEsc(dns.lookup.error) : `${dns.lookup.rcode} in ${dns.lookup.ms}ms`
  }</span>`;
}

/* ---- who agrees */

function renderResolvers() {
  const host = field("dns-resolver-list");
  const verdict = field("dns-verdict");

  if (dns.comparing) {
    host.innerHTML = skeletonRows(5, "dns-sk-resolver");
    verdict.textContent = "asking…";
    verdict.className = "dns-verdict";
    return;
  }
  if (!dns.resolvers.length) {
    host.innerHTML = `<div class="dns-empty">Resolve a name to see whether every resolver agrees about it.</div>`;
    verdict.textContent = "";
    verdict.className = "dns-verdict";
    return;
  }

  const answered = dns.resolvers.filter((row) => !row.error && row.answers.length);
  // Two resolvers handing back different edge addresses for the same site is
  // round-robin doing its job, not a disagreement. What matters is whether
  // they overlap at all: a resolver sharing nothing with the rest is the one
  // looking at something nobody else can see.
  const tally = new Map();
  for (const row of answered) {
    for (const value of row.answers) tally.set(value, (tally.get(value) || 0) + 1);
  }
  const majority = new Set(
    [...tally.entries()]
      .filter(([, count]) => count === Math.max(...tally.values()))
      .map(([value]) => value)
  );
  const agrees = (row) => row.answers.some((value) => majority.has(value));
  const odd = answered.filter((row) => !agrees(row));

  host.innerHTML = dns.resolvers
    .map((row) => {
      const alone = Boolean(row.answers.length) && !agrees(row);
      const tone = row.error ? "red" : !row.answers.length ? "grey" : alone ? "amber" : "green";
      const answer = row.error
        ? row.error
        : row.answers.length
        ? row.answers.join(", ")
        : row.rcode || "no answer";
      return `<div class="dns-resolver${alone ? " odd" : ""}">
        <i class="dot ${tone}"></i>
        <span class="dns-resolver-name"><strong>${dnsEsc(row.name)}</strong><small class="mono">${dnsEsc(row.ip)}</small></span>
        <span class="dns-resolver-answer mono ${row.error ? "bad" : ""}">${dnsEsc(answer)}</span>
        <span class="dns-resolver-ms mono">${row.ms}ms</span>
      </div>`;
    })
    .join("");

  if (!answered.length) {
    verdict.textContent = "no answers";
    verdict.className = "dns-verdict bad";
  } else if (!odd.length) {
    verdict.textContent = "all agree";
    verdict.className = "dns-verdict good";
  } else {
    verdict.textContent = `${odd.length} disagree${odd.length === 1 ? "s" : ""}`;
    verdict.className = "dns-verdict warn";
  }
}

function exportState() {
  return { query:dns.host?.querySelector?.("#dns-name")?.value ?? dns.query, name:dns.name, lookup:dns.lookup,
    looking:dns.looking, reversing:dns.reversing, typeFilter:dns.typeFilter, resolvers:dns.resolvers,
    comparing:dns.comparing, domains:dns.domains, domainsLoaded:dns.domainsLoaded,
    newDomain:dns.host?.querySelector?.("#dns-interest")?.value ?? dns.newDomain };
}
function importState(state) { if (!state) return; Object.assign(dns, state, { host:dns.host, built:dns.built }); if(dns.host) render(); }
window.wintDns = { mount, render, opened, lookFor, recheck, exportState, importState };
