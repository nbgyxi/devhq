//! The Projects cockpit: what agents outside WinT have observed about each
//! project - a health status, a one-line summary, the next thing to do, a few
//! KPIs and a list of notes.
//!
//! WinT never writes the observations itself (beyond the user dismissing one);
//! Claude Desktop, a Grok bot or any script does. So the store is deliberately
//! the simplest thing every one of them can reach: a folder of JSON files, one
//! per project, under `%USERPROFILE%\.wint\cockpit`. Three doors lead into it
//! and all three end up in `apply`:
//!
//! - `wint mcp` - an MCP server on stdio, for Claude Desktop and anything else
//!   that speaks MCP (`cockpit_mcp.rs`).
//! - `wint cockpit ...` - the CLI, for a bot that can run a command.
//! - The files themselves, for an agent that can only write files. Reading
//!   them is lenient on purpose: a hand-written file with `"status": "warn"`
//!   and notes as plain strings still shows up.
//!
//! The folder is under the user profile and not `%LOCALAPPDATA%` because the
//! Store build is packaged, and Windows redirects a packaged app's writes under
//! AppData into the package's own folder. The app and the agents outside it
//! would then each be looking at a folder the other never writes to.
//!
//! WinT writes `index.json` beside the projects after each scan, so an agent
//! can ask which projects exist and what git says about them without scanning.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_NOTES: usize = 40;
const MAX_KPIS: usize = 8;
const MAX_SUMMARY: usize = 300;
const MAX_TEXT: usize = 800;
const MAX_SHORT: usize = 60;
/// A file bigger than this was not written by hand or by `apply`, and is not
/// worth parsing on every change in the folder.
const MAX_FILE_BYTES: u64 = 512 * 1024;

#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Kpi {
    pub label: String,
    pub value: String,
    /// `good`, `warn`, `bad`, or empty for neutral.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub tone: String,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Note {
    /// Derived from the kind and text, so the same note sent twice replaces
    /// itself instead of piling up when a bot reruns on a schedule.
    pub id: String,
    /// A short label: Risk, Next, Waiting, Branch, Promise...
    pub kind: String,
    pub text: String,
    /// Where it was seen: GitHub, Email, Sentry...
    pub source: String,
    /// Who wrote it: Claude Desktop, Grok...
    pub by: String,
    /// Epoch milliseconds.
    pub at: u64,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Observation {
    pub project: String,
    pub key: String,
    pub path: String,
    /// `healthy`, `attention`, `incident` or `unknown`.
    pub status: String,
    pub summary: String,
    pub next: String,
    pub kpis: Vec<Kpi>,
    pub notes: Vec<Note>,
    pub updated_at: u64,
    pub updated_by: String,
}

/// What WinT's last scan knew about one project.
#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexEntry {
    pub name: String,
    pub key: String,
    pub path: String,
    pub group: String,
    pub description: String,
    pub branch: String,
    pub changed: u32,
    pub ahead: u32,
    pub behind: u32,
    pub running: u32,
    pub ports: Vec<u16>,
    pub last_commit: String,
    /// Epoch seconds.
    pub last_commit_at: u64,
    pub tech: Vec<String>,
    /// Starred in WinT. Agents report on these and nothing else.
    pub favorite: bool,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Index {
    pub updated_at: u64,
    pub roots: Vec<String>,
    pub projects: Vec<IndexEntry>,
}

/// The project an update is for, once its name has been matched.
pub struct Target {
    pub key: String,
    pub name: String,
    pub path: String,
    pub favorite: bool,
}

/* ------------------------------------------------------------- locations */

pub fn dir() -> Result<PathBuf, String> {
    if let Some(over) = std::env::var_os("WINT_COCKPIT_DIR").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(over));
    }
    let home = std::env::var_os("USERPROFILE").ok_or("Windows did not provide USERPROFILE.")?;
    Ok(PathBuf::from(home).join(".wint").join("cockpit"))
}

pub fn projects_dir() -> Result<PathBuf, String> {
    Ok(dir()?.join("projects"))
}

fn index_path() -> Result<PathBuf, String> {
    Ok(dir()?.join("index.json"))
}

fn ensure_dirs() -> Result<PathBuf, String> {
    let projects = projects_dir()?;
    std::fs::create_dir_all(&projects)
        .map_err(|e| format!("Could not create {}: {e}", projects.display()))?;
    ensure_readme();
    Ok(projects)
}

/// The format, written where an agent that only browses files will find it.
const README: &str = r#"# WinT Projects cockpit

WinT reads what agents have observed about each project from this folder and
shows it in its Projects view, live.

- `index.json` - written by WinT after every scan: which projects exist, with
  their path, branch and git state. Read it; do not write it.
- Report only on projects with `"favorite": true` in index.json - the ones
  the user starred in WinT. `wint cockpit` and the MCP tools refuse the rest.
- `projects/<key>.json` - one file per project, written by agents. `<key>` is
  the project's folder name in lowercase with anything but a-z and 0-9 turned
  into `-` (index.json lists every key).

## Easiest: the wint command

    wint cockpit list
    wint cockpit set devhq --status attention --summary "CI red since 09:10" --next "Fix the flaky test" --by Grok
    wint cockpit note devhq Risk "Branch feat/x is 19 days old" --source GitHub --by Grok
    wint cockpit kpi devhq "Open PRs" 3 --by Grok
    wint cockpit apply devhq '{"status":"healthy","addNotes":[{"kind":"Next","text":"..."}]}'
    wint cockpit clear devhq

## MCP (Claude Desktop and other MCP clients)

    "mcpServers": { "wint": { "command": "<path to wint.exe>", "args": ["mcp"] } }

## Or write the file yourself

    {
      "project": "devhq",
      "status": "attention",
      "summary": "One line on how the project is doing.",
      "next": "The single next thing to do.",
      "kpis": [{ "label": "Open PRs", "value": "3", "tone": "warn" }],
      "notes": [{ "kind": "Risk", "text": "What you noticed.", "source": "GitHub" }],
      "updatedBy": "Grok"
    }

status is one of healthy, attention, incident, unknown. tone is good, warn or
bad.

## A summary report

`report.html` in this folder (or `wint cockpit report FILE`, or the MCP tool
set_report) is shown at the top of WinT's Projects window: a short HTML
summary across the favorite projects. Scripts do not run and nothing is
loaded from outside except https images. Style with inline styles or a
<style> block; WinT's colours are available as var(--text), var(--dim),
var(--accent), var(--red), var(--amber), var(--green), var(--bg2), var(--line). Write to a temporary file and rename it over the old one, so WinT never
reads half a file.
"#;

fn ensure_readme() {
    let Ok(root) = dir() else { return };
    let path = root.join("README.md");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(README) {
        let _ = std::fs::create_dir_all(&root);
        let _ = std::fs::write(&path, README);
    }
}

/* ------------------------------------------------------------ the values */

/// The file name a project is kept under. Mirrored by `cockpitKey` in
/// `app.js`; the two must agree or a card never finds its observations.
pub fn key(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    let mut out = String::new();
    let mut dash = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            dash = false;
        } else if !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        out = lower.bytes().take(24).map(|b| format!("{b:02x}")).collect();
    }
    if out.is_empty() {
        out = "project".into();
    }
    out.truncate(80);
    out
}

/// Whatever an agent called it, as one of the four statuses.
pub fn status(raw: &str) -> &'static str {
    match raw.trim().to_ascii_lowercase().as_str() {
        "healthy" | "ok" | "okay" | "good" | "green" | "fine" | "pass" | "passing" | "clean" => {
            "healthy"
        }
        "attention" | "warn" | "warning" | "yellow" | "amber" | "watch" | "degraded" | "stale" => {
            "attention"
        }
        "incident" | "critical" | "error" | "red" | "down" | "broken" | "failing" | "fail"
        | "outage" => "incident",
        _ => "unknown",
    }
}

fn tone(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "good" | "ok" | "green" | "up" | "positive" => "good".into(),
        "warn" | "warning" | "amber" | "yellow" | "attention" => "warn".into(),
        "bad" | "red" | "error" | "down" | "negative" | "critical" => "bad".into(),
        _ => String::new(),
    }
}

fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

fn text_of(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

/// The first of `names` that is present, as text.
fn field(value: &Value, names: &[&str]) -> String {
    names
        .iter()
        .find_map(|name| value.get(*name).filter(|v| !v.is_null()))
        .map(text_of)
        .unwrap_or_default()
}

/// A timestamp an agent wrote: milliseconds, or seconds if small enough to be.
fn millis(value: Option<&Value>) -> u64 {
    let Some(value) = value else { return 0 };
    let number = value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
        .unwrap_or(0.0);
    if number <= 0.0 {
        0
    } else if number < 100_000_000_000.0 {
        (number * 1000.0) as u64
    } else {
        number as u64
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// FNV-1a: stable across runs and processes, which is all an id needs.
fn note_id(kind: &str, text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in kind.trim().to_lowercase().bytes().chain([0]).chain(text.trim().bytes()) {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("n{:012x}", hash & 0xffff_ffff_ffff)
}

fn kpis_from(value: &Value) -> Vec<Kpi> {
    let mut out = Vec::new();
    match value {
        Value::Array(items) => {
            for item in items {
                let label = clip(&field(item, &["label", "name", "key"]), MAX_SHORT);
                if label.is_empty() {
                    continue;
                }
                out.push(Kpi {
                    label,
                    value: clip(&field(item, &["value", "v"]), MAX_SHORT),
                    tone: tone(&field(item, &["tone", "status", "color"])),
                });
            }
        }
        // `{"MRR": "€1,180", "Users": 214}` is how a person would write it.
        Value::Object(map) => {
            for (label, value) in map {
                out.push(Kpi {
                    label: clip(label, MAX_SHORT),
                    value: clip(&text_of(value), MAX_SHORT),
                    tone: String::new(),
                });
            }
        }
        _ => {}
    }
    out.truncate(MAX_KPIS);
    out
}

/// One note, from an object or from a bare string.
fn note_from(item: &Value, by: &str, at: u64) -> Option<Note> {
    let (kind, text, source, who, when, id) = match item {
        Value::String(text) => ("Note".to_string(), text.clone(), String::new(), String::new(), 0, String::new()),
        Value::Object(_) => (
            field(item, &["kind", "type", "label", "tag"]),
            field(item, &["text", "note", "message", "body"]),
            field(item, &["source", "src", "from"]),
            field(item, &["by", "agent", "author"]),
            millis(item.get("at").or(item.get("time")).or(item.get("updatedAt"))),
            field(item, &["id"]),
        ),
        _ => return None,
    };
    let text = clip(&text, MAX_TEXT);
    if text.is_empty() {
        return None;
    }
    let kind = {
        let k = clip(&kind, MAX_SHORT);
        if k.is_empty() { "Note".to_string() } else { k }
    };
    Some(Note {
        id: if id.trim().is_empty() { note_id(&kind, &text) } else { clip(&id, MAX_SHORT) },
        kind,
        text,
        source: clip(&source, MAX_SHORT),
        by: if who.trim().is_empty() { by.to_string() } else { clip(&who, MAX_SHORT) },
        at: if when > 0 { when } else { at },
    })
}

fn notes_from(value: &Value, by: &str, at: u64) -> Vec<Note> {
    match value {
        Value::Array(items) => items.iter().filter_map(|item| note_from(item, by, at)).collect(),
        Value::Null => Vec::new(),
        single => note_from(single, by, at).into_iter().collect(),
    }
}

/// A project file, however it was written. `mtime` stands in for any time the
/// file does not say.
pub fn observation_from(value: &Value, file_key: &str, mtime: u64) -> Observation {
    let updated_at = {
        let at = millis(value.get("updatedAt").or(value.get("updated_at")));
        if at > 0 { at } else { mtime }
    };
    let updated_by = clip(&field(value, &["updatedBy", "updated_by", "agent", "by"]), MAX_SHORT);
    let mut notes = value
        .get("notes")
        .map(|n| notes_from(n, &updated_by, updated_at))
        .unwrap_or_default();
    dedupe(&mut notes);
    let project = field(value, &["project", "name"]);
    Observation {
        project: if project.trim().is_empty() { file_key.to_string() } else { clip(&project, 120) },
        key: file_key.to_string(),
        path: field(value, &["path"]),
        status: status(&field(value, &["status", "health", "state"])).to_string(),
        summary: clip(&field(value, &["summary", "short", "headline"]), MAX_SUMMARY),
        next: clip(&field(value, &["next", "nextAction", "next_action"]), MAX_SUMMARY),
        kpis: value.get("kpis").or(value.get("metrics")).map(kpis_from).unwrap_or_default(),
        notes,
        updated_at,
        updated_by,
    }
}

/// Newest first, one per id, and no more than the cap.
fn dedupe(notes: &mut Vec<Note>) {
    notes.sort_by_key(|n| std::cmp::Reverse(n.at));
    let mut seen = std::collections::HashSet::new();
    notes.retain(|note| seen.insert(note.id.clone()));
    notes.truncate(MAX_NOTES);
}

/* --------------------------------------------------------------- reading */

fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_file(path: &Path, file_key: &str) -> Option<Observation> {
    let size = std::fs::metadata(path).ok()?.len();
    if size == 0 || size > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    // A BOM is what PowerShell's Out-File leaves at the front.
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    let value: Value = serde_json::from_slice(bytes).ok()?;
    Some(observation_from(&value, file_key, mtime_ms(path)))
}

/// Every project that has observations, in no particular order.
pub fn read_all() -> Vec<Observation> {
    let Ok(folder) = projects_dir() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&folder) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        // Temporary files mid-rename start with a dot.
        if stem.starts_with('.') {
            continue;
        }
        if let Some(observation) = read_file(&path, &key(stem)) {
            out.push(observation);
        }
    }
    out
}

pub fn read(file_key: &str) -> Option<Observation> {
    let path = projects_dir().ok()?.join(format!("{file_key}.json"));
    read_file(&path, file_key)
}

pub fn read_index() -> Option<Index> {
    let bytes = std::fs::read(index_path().ok()?).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/* --------------------------------------------------------------- writing */

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let temp = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&temp, bytes)
        .and_then(|_| std::fs::rename(&temp, path))
        .map_err(|e| {
            let _ = std::fs::remove_file(&temp);
            format!("Could not write {}: {e}", path.display())
        })
}

/// Two agents updating the same project at once would otherwise each read the
/// file, add their note, and write - and one note would be lost.
fn with_lock<T>(file_key: &str, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let folder = ensure_dirs()?;
    let lock = folder.join(format!(".{file_key}.lock"));
    let give_up = Instant::now() + Duration::from_secs(5);
    loop {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&lock) {
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // A writer that died holding it must not lock the project for good.
                let age = std::fs::metadata(&lock)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .unwrap_or_default();
                if age > Duration::from_secs(10) {
                    let _ = std::fs::remove_file(&lock);
                    continue;
                }
                if Instant::now() >= give_up {
                    return Err(format!("{file_key} is being updated by someone else. Try again."));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(format!("Could not lock {}: {e}", lock.display())),
        }
    }
    let result = work();
    let _ = std::fs::remove_file(&lock);
    result
}

/// Which project `project` means: a name, a key or a path. Once WinT has
/// written an index, a name it has never seen is refused - a typo would
/// otherwise quietly create a project that no card ever shows.
pub fn resolve(project: &str) -> Result<Target, String> {
    let wanted = project.trim();
    if wanted.is_empty() {
        return Err("Say which project: its name, as `list_projects` or `wint cockpit list` shows it.".into());
    }
    let looks_like_path = wanted.contains('\\') || wanted.contains('/');
    let name_part = if looks_like_path {
        Path::new(wanted)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| wanted.to_string())
    } else {
        wanted.to_string()
    };
    let wanted_key = key(&name_part);
    let same_path = |a: &str, b: &str| {
        let norm = |s: &str| s.trim().trim_end_matches(['\\', '/']).replace('/', "\\").to_lowercase();
        !a.is_empty() && norm(a) == norm(b)
    };
    match read_index().filter(|index| !index.projects.is_empty()) {
        Some(index) => {
            let found = index
                .projects
                .iter()
                .find(|p| same_path(&p.path, wanted))
                .or_else(|| index.projects.iter().find(|p| p.name.eq_ignore_ascii_case(wanted)))
                .or_else(|| index.projects.iter().find(|p| key(&p.name) == wanted_key));
            match found {
                Some(p) => Ok(Target {
                    key: key(&p.name),
                    name: p.name.clone(),
                    path: p.path.clone(),
                    favorite: p.favorite,
                }),
                None => {
                    let mut names: Vec<&str> = index.projects.iter().map(|p| p.name.as_str()).collect();
                    names.sort_unstable_by_key(|n| n.to_lowercase());
                    let shown = names.iter().take(40).copied().collect::<Vec<_>>().join(", ");
                    Err(format!("WinT knows no project called \"{wanted}\". Known projects: {shown}."))
                }
            }
        }
        None => Ok(Target {
            key: wanted_key,
            name: name_part,
            path: if looks_like_path { wanted.to_string() } else { String::new() },
            favorite: false,
        }),
    }
}

/// Changes one project's observations. `update` takes any of:
///
/// - `status`, `summary`, `next` - replace; an empty string clears.
/// - `kpis` - replaces all KPIs (array of `{label, value, tone}` or a map).
/// - `notes` - replaces all notes.
/// - `addNotes` (or `addNote`, `note`) - one note or a list; a note with the
///   same kind and text as an existing one replaces it.
/// - `removeNotes` - note ids to drop. `clearNotes: true` drops all of them.
/// - `agent` (or `by`) - who is writing; otherwise `default_agent`.
pub fn apply(project: &str, update: &Value, default_agent: &str) -> Result<Observation, String> {
    let Value::Object(changes) = update else {
        return Err("The update must be a JSON object.".into());
    };
    let pick = |names: &[&str]| names.iter().find_map(|n| changes.get(*n));
    let target = resolve(project)?;
    let agent = {
        let named = clip(&field(update, &["agent", "by", "updatedBy"]), MAX_SHORT);
        if named.is_empty() { default_agent.to_string() } else { named }
    };

    let status_change = match pick(&["status", "health"]) {
        Some(raw) => {
            let raw = text_of(raw);
            let normal = status(&raw);
            if normal == "unknown" && !raw.trim().is_empty() && !raw.trim().eq_ignore_ascii_case("unknown") {
                return Err(format!(
                    "\"{raw}\" is not a status. Use healthy, attention, incident or unknown."
                ));
            }
            Some(normal.to_string())
        }
        None => None,
    };
    let summary = pick(&["summary", "short"]).map(|v| clip(&text_of(v), MAX_SUMMARY));
    let next = pick(&["next", "nextAction", "next_action"]).map(|v| clip(&text_of(v), MAX_SUMMARY));
    let kpis = pick(&["kpis", "metrics"]).map(kpis_from);
    let now = now_ms();
    let set_notes = pick(&["notes"]).map(|v| notes_from(v, &agent, now));
    let add_notes = pick(&["addNotes", "add_notes", "addNote", "add_note", "note"])
        .map(|v| notes_from(v, &agent, now))
        .unwrap_or_default();
    let remove: Vec<String> = match pick(&["removeNotes", "remove_notes", "removeNote", "remove_note"]) {
        Some(Value::Array(ids)) => ids.iter().map(text_of).collect(),
        Some(single) => vec![text_of(single)],
        None => Vec::new(),
    };
    let clear = pick(&["clearNotes", "clear_notes"]).and_then(Value::as_bool).unwrap_or(false);
    if status_change.is_none() && summary.is_none() && next.is_none() && kpis.is_none()
        && set_notes.is_none() && add_notes.is_empty() && remove.is_empty() && !clear
    {
        return Err("Nothing to change. Give a status, summary, next, kpis or notes.".into());
    }
    if pick(&["addNotes", "add_notes", "addNote", "add_note", "note"]).is_some() && add_notes.is_empty() {
        return Err("A note needs some text.".into());
    }
    let only_removal = status_change.is_none() && summary.is_none() && next.is_none()
        && kpis.is_none() && set_notes.is_none() && add_notes.is_empty() && !clear;

    with_lock(&target.key, || {
        let folder = projects_dir()?;
        let path = folder.join(format!("{}.json", target.key));
        let mut obs = read_file(&path, &target.key).unwrap_or_else(|| Observation {
            status: "unknown".into(),
            ..Default::default()
        });
        obs.project = target.name.clone();
        obs.key = target.key.clone();
        if !target.path.is_empty() {
            obs.path = target.path.clone();
        }
        if let Some(s) = status_change.clone() {
            obs.status = s;
        }
        if let Some(s) = summary.clone() {
            obs.summary = s;
        }
        if let Some(s) = next.clone() {
            obs.next = s;
        }
        if let Some(k) = kpis.clone() {
            obs.kpis = k;
        }
        if clear {
            obs.notes.clear();
        }
        if let Some(n) = set_notes.clone() {
            obs.notes = n;
        }
        obs.notes.retain(|n| !remove.contains(&n.id));
        // New ones first, so `dedupe` keeps them over an older copy.
        let mut notes = add_notes.clone();
        notes.append(&mut obs.notes);
        obs.notes = notes;
        dedupe(&mut obs.notes);
        // Dismissing a note is not a report: the card still says who last
        // reported and when.
        if !only_removal || obs.updated_at == 0 {
            obs.updated_at = now;
            obs.updated_by = agent.clone();
        }
        let bytes = serde_json::to_vec_pretty(&obs).map_err(|e| e.to_string())?;
        write_atomic(&path, &bytes)?;
        Ok(obs)
    })
}

/* -------------------------------------------------------- the report
 *
 * One summary across the projects, in HTML, shown above the cards. An agent
 * sets it with `set_report` / `wint cockpit report`, or simply writes
 * `report.html` into the cockpit folder. WinT shows it in a sandboxed frame
 * with scripts off, so the HTML can be rich but can never act. */

const MAX_REPORT_BYTES: usize = 300 * 1024;

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Report {
    pub title: String,
    pub html: String,
    pub updated_at: u64,
    pub updated_by: String,
}

fn report_json() -> Result<PathBuf, String> {
    Ok(dir()?.join("report.json"))
}

fn report_html() -> Result<PathBuf, String> {
    Ok(dir()?.join("report.html"))
}

/// The newest report, from `report.json` or a hand-written `report.html`.
pub fn read_report() -> Option<Report> {
    let from_json = report_json().ok().and_then(|path| {
        let bytes = std::fs::read(&path).ok()?;
        let mut report: Report = serde_json::from_slice(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes)).ok()?;
        if report.updated_at == 0 {
            report.updated_at = mtime_ms(&path);
        }
        Some(report)
    });
    let from_html = report_html().ok().and_then(|path| {
        let size = std::fs::metadata(&path).ok()?.len();
        if size == 0 || size as usize > MAX_REPORT_BYTES {
            return None;
        }
        let html = std::fs::read_to_string(&path).ok()?;
        let title = html
            .find("<title>")
            .and_then(|at| html[at + 7..].find("</title>").map(|end| html[at + 7..at + 7 + end].trim().to_string()))
            .unwrap_or_default();
        Some(Report { title, html, updated_at: mtime_ms(&path), updated_by: String::new() })
    });
    let report = match (from_json, from_html) {
        (Some(a), Some(b)) => Some(if b.updated_at > a.updated_at { b } else { a }),
        (a, b) => a.or(b),
    }?;
    (!report.html.trim().is_empty()).then_some(report)
}

pub fn set_report(html: &str, title: &str, agent: &str) -> Result<Report, String> {
    let html = html.trim_start_matches('\u{feff}').trim();
    if html.is_empty() {
        return Err("The report has no HTML in it.".into());
    }
    if html.len() > MAX_REPORT_BYTES {
        return Err(format!("The report is {} KB; keep it under {} KB.", html.len() / 1024, MAX_REPORT_BYTES / 1024));
    }
    ensure_dirs()?;
    let report = Report {
        title: clip(title, 120),
        html: html.to_string(),
        updated_at: now_ms(),
        updated_by: clip(agent, MAX_SHORT),
    };
    let bytes = serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?;
    write_atomic(&report_json()?, &bytes)?;
    // A hand-written one would otherwise win whenever it is newer.
    let _ = std::fs::remove_file(report_html()?);
    Ok(report)
}

pub fn clear_report() -> Result<bool, String> {
    let mut had = false;
    for path in [report_json()?, report_html()?] {
        match std::fs::remove_file(&path) {
            Ok(()) => had = true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Could not remove {}: {e}", path.display())),
        }
    }
    Ok(had)
}

/// Agents - over MCP or the CLI - report on the projects starred in WinT
/// and nothing else. WinT itself (dismissing a note) is not held to this.
pub fn check_favorite(project: &str) -> Result<(), String> {
    let target = resolve(project)?;
    if target.favorite {
        return Ok(());
    }
    if read_index().is_none() {
        return Err("WinT has not shared its project list yet. Open Projects in WinT, star the projects you want reports on, and try again.".into());
    }
    Err(format!(
        "{} is not a favorite in WinT, so it gets no reports. Only update the projects list_projects returns. (The user can star it in WinT to include it.)",
        target.name
    ))
}

pub fn apply_as_agent(project: &str, update: &Value, agent: &str) -> Result<Observation, String> {
    check_favorite(project)?;
    apply(project, update, agent)
}

pub fn clear_as_agent(project: &str) -> Result<bool, String> {
    check_favorite(project)?;
    clear(project)
}

/// Drops a project's observations entirely. True when there were any.
pub fn clear(project: &str) -> Result<bool, String> {
    let target = resolve(project)?;
    with_lock(&target.key, || {
        let path = projects_dir()?.join(format!("{}.json", target.key));
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(format!("Could not remove {}: {e}", path.display())),
        }
    })
}

/// WinT's record of which projects exist, for agents to read.
pub fn write_index(roots: Vec<String>, mut projects: Vec<IndexEntry>) -> Result<(), String> {
    ensure_dirs()?;
    for p in &mut projects {
        p.key = key(&p.name);
    }
    projects.sort_by_key(|p| p.name.to_lowercase());
    let index = Index { updated_at: now_ms(), roots, projects };
    let bytes = serde_json::to_vec_pretty(&index).map_err(|e| e.to_string())?;
    write_atomic(&index_path()?, &bytes)
}

/* ------------------------------------------------------ the agent's view */

/// One project as `scan_root` reports it, in the index's shape.
fn entry_from_scan(project: &Value) -> IndexEntry {
    let git = project.get("git").cloned().unwrap_or(Value::Null);
    let num = |v: &Value, k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0) as u32;
    let name = field(project, &["name"]);
    IndexEntry {
        key: key(&name),
        name,
        path: field(project, &["path"]),
        group: field(project, &["group"]),
        description: field(project, &["description"]),
        branch: field(&git, &["branch"]),
        changed: num(&git, "changedTotal"),
        ahead: num(&git, "ahead"),
        behind: num(&git, "behind"),
        running: project.get("running").and_then(Value::as_array).map_or(0, |r| r.len() as u32),
        ports: Vec::new(),
        last_commit: git.get("lastCommit").map(|c| field(c, &["subject"])).unwrap_or_default(),
        last_commit_at: git
            .get("lastCommit")
            .and_then(|c| c.get("timestamp"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        tech: project
            .get("tech")
            .and_then(Value::as_array)
            .map(|t| t.iter().map(|x| field(x, &["name"])).filter(|n| !n.is_empty()).collect())
            .unwrap_or_default(),
        // Stars live in WinT; a scan made without it knows of none.
        favorite: false,
    }
}

/// The projects WinT knows of. From its last scan when there is one, and
/// otherwise from a scan of the default code folder, done here and now.
fn known_projects() -> (Vec<IndexEntry>, String) {
    if let Some(index) = read_index().filter(|i| !i.projects.is_empty()) {
        return (index.projects, format!("WinT's last scan of {}", index.roots.join(", ")));
    }
    let root = crate::default_root_sync();
    let scanned = serde_json::to_value(crate::scan_root(root.clone())).unwrap_or(Value::Null);
    let projects = scanned
        .get("projects")
        .and_then(Value::as_array)
        .map(|list| list.iter().map(entry_from_scan).collect())
        .unwrap_or_default();
    (projects, format!("a scan of {root} just now (WinT has not published its own list yet)"))
}

fn status_rank(status: &str) -> u8 {
    match status {
        "incident" => 0,
        "attention" => 1,
        "healthy" => 2,
        _ => 3,
    }
}

/// The favorite projects with what git says and what has been observed,
/// worst first. `only` keeps one status.
pub fn overview(only: Option<&str>) -> Value {
    let (projects, source) = known_projects();
    let observed: std::collections::HashMap<String, Observation> =
        read_all().into_iter().map(|o| (o.key.clone(), o)).collect();
    let others = projects.iter().filter(|p| !p.favorite).count();
    let mut rows: Vec<(u8, String, Value)> = Vec::new();
    for p in projects.iter().filter(|p| p.favorite) {
        let k = key(&p.name);
        let obs = observed.get(&k);
        let st = obs.map(|o| o.status.as_str()).unwrap_or("unknown");
        if only.is_some_and(|want| status(want) != st) {
            continue;
        }
        let mut row = serde_json::to_value(p).unwrap_or(Value::Null);
        if let Value::Object(map) = &mut row {
            map.insert("key".into(), json!(k));
            map.insert("status".into(), json!(st));
            if let Some(o) = obs {
                map.insert("summary".into(), json!(o.summary));
                map.insert("next".into(), json!(o.next));
                map.insert("noteCount".into(), json!(o.notes.len()));
                map.insert("updatedAt".into(), json!(o.updated_at));
                map.insert("updatedBy".into(), json!(o.updated_by));
            }
        }
        rows.push((status_rank(st), p.name.to_lowercase(), row));
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let scope = if rows.is_empty() && only.is_none() {
        "No project is starred as a favorite in WinT, so there is nothing to report on. Ask the user to star the projects they want reports on in WinT's Projects view.".to_string()
    } else {
        format!("Only the projects starred as favorites in WinT are listed, and only those may be updated. {others} other projects are left alone.")
    };
    json!({
        "scope": scope,
        "source": source,
        "folder": dir().map(|d| d.display().to_string()).unwrap_or_default(),
        "projects": rows.into_iter().map(|r| r.2).collect::<Vec<_>>(),
    })
}

/// One project: what WinT's scan knows and everything observed about it.
pub fn project(project: &str) -> Result<Value, String> {
    let target = resolve(project)?;
    let scan = read_index()
        .and_then(|i| i.projects.into_iter().find(|p| key(&p.name) == target.key))
        .map(|p| serde_json::to_value(p).unwrap_or(Value::Null))
        .unwrap_or(Value::Null);
    let observed = read(&target.key)
        .map(|o| serde_json::to_value(o).unwrap_or(Value::Null))
        .unwrap_or_else(|| json!({ "status": "unknown", "notes": [] }));
    let mut out = Map::new();
    out.insert("project".into(), json!(target.name));
    out.insert("key".into(), json!(target.key));
    out.insert("scan".into(), scan);
    out.insert("observations".into(), observed);
    Ok(Value::Object(out))
}

/* ------------------------------------------ Claude Desktop, in one click
 *
 * Asking somebody to find a JSON file, paste a block into it without
 * breaking it, and get a path with doubled backslashes right is asking too
 * much. WinT edits Claude Desktop's config itself.
 *
 * Two things make that less simple than writing a file:
 *
 * - Claude Desktop from claude.ai is itself a packaged app, so its config
 *   usually lives in `%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\
 *   Claude` and not in `%APPDATA%\Claude`. Both are looked for, and every
 *   config found is updated.
 * - The Store build of WinT is packaged too. Windows lets it change a file
 *   that already exists under AppData, but a file it *creates* there is
 *   quietly redirected into WinT's own package where Claude never looks. So
 *   the config is always rewritten in place - never written beside and
 *   renamed over - and a packaged WinT never creates one. */

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeDesktop {
    /// A Claude Desktop settings folder exists for this user.
    pub installed: bool,
    /// Some config already starts this `wint mcp`.
    pub connected: bool,
    pub configs: Vec<String>,
    pub message: String,
}

const CLAUDE_CONFIG: &str = "claude_desktop_config.json";

/// Every folder a Claude Desktop may read its config from, live ones only.
///
/// Three generations of Claude Desktop keep it in three places:
/// - `%LOCALAPPDATA%\Claude-Data\claude_<id>` - current packaged builds,
///   which moved their data out of the package so it survives a reinstall.
///   They leave a `.user-data-left…` marker in the old folder, and that old
///   folder is no longer read: writing there connects nothing.
/// - `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude` - older
///   packaged builds, where Windows put their AppData.
/// - `%APPDATA%\Claude` - the classic installer.
fn claude_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        if let Ok(entries) = std::fs::read_dir(local.join("Claude-Data")) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if name.starts_with("claude") && entry.path().is_dir() {
                    out.push(entry.path());
                }
            }
        }
        if let Ok(entries) = std::fs::read_dir(local.join("Packages")) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                // The package is the proof Claude is installed; its Claude
                // folder only appears once it has saved a setting.
                if !(name.starts_with("claude_") || name.starts_with("anthropic"))
                    || !entry.path().join("LocalCache").is_dir()
                {
                    continue;
                }
                let dir = entry.path().join("LocalCache").join("Roaming").join("Claude");
                let moved_out = std::fs::read_dir(&dir).is_ok_and(|files| {
                    files.flatten().any(|f| f.file_name().to_string_lossy().starts_with(".user-data-left"))
                });
                // A package whose data now lives in Claude-Data has that
                // folder listed already.
                let in_claude_data = out.iter().any(|d| {
                    d.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(&name))
                });
                if !moved_out && !in_claude_data {
                    out.push(dir);
                }
            }
        }
    }
    if let Some(roaming) = std::env::var_os("APPDATA") {
        let dir = PathBuf::from(roaming).join("Claude");
        if dir.is_dir() {
            out.push(dir);
        }
    }
    out
}

fn read_claude_config(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let text = text.trim_start_matches('\u{feff}').trim();
    if text.is_empty() {
        return Ok(json!({}));
    }
    match serde_json::from_str::<Value>(text) {
        Ok(value) if value.is_object() => Ok(value),
        _ => Err(format!(
            "{} is not valid JSON, so WinT left it alone. Fix or empty it in Claude Desktop (Settings → Developer → Edit Config) and try again.",
            path.display()
        )),
    }
}

fn starts_us(config: &Value, cli: &Path) -> bool {
    let Some(entry) = config.pointer("/mcpServers/wint") else { return false };
    let command = entry.get("command").and_then(Value::as_str).unwrap_or("");
    let has_mcp = entry
        .get("args")
        .and_then(Value::as_array)
        .is_some_and(|a| a.iter().any(|v| v.as_str() == Some("mcp")));
    has_mcp && command.eq_ignore_ascii_case(&cli.display().to_string())
}

/// Whether Claude Desktop is there, and whether it already starts `cli`.
pub fn claude_status(cli: &Path) -> ClaudeDesktop {
    let dirs = claude_dirs();
    let configs: Vec<PathBuf> = dirs.iter().map(|d| d.join(CLAUDE_CONFIG)).filter(|p| p.is_file()).collect();
    let connected = cli.is_file()
        && configs.iter().any(|p| read_claude_config(p).is_ok_and(|c| starts_us(&c, cli)));
    ClaudeDesktop {
        installed: !dirs.is_empty(),
        connected,
        configs: configs.iter().map(|p| p.display().to_string()).collect(),
        message: if dirs.is_empty() {
            "Claude Desktop is not installed for this Windows user.".into()
        } else if connected {
            "Claude Desktop is connected.".into()
        } else {
            "Claude Desktop is installed but not connected yet.".into()
        },
    }
}

/// Adds `"wint": { "command": cli, "args": ["mcp"] }` to every Claude Desktop
/// config, leaving everything else in them as it was. The old file is kept in
/// the cockpit's `backups` folder first.
pub fn connect_claude(cli: &Path) -> Result<ClaudeDesktop, String> {
    if !cli.is_file() {
        return Err(format!("The wint command is not at {}. Install it first.", cli.display()));
    }
    let dirs = claude_dirs();
    if dirs.is_empty() {
        return Err("Claude Desktop does not seem to be installed for this Windows user. Install it from claude.ai/download, open it once, then try again.".into());
    }
    let packaged = crate::shells::is_packaged();
    let mut written = 0;
    for dir in &dirs {
        let path = dir.join(CLAUDE_CONFIG);
        let existed = path.is_file();
        if !existed && packaged {
            continue;
        }
        if !existed {
            std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
        }
        let mut config = if existed { read_claude_config(&path)? } else { json!({}) };
        if starts_us(&config, cli) {
            written += 1;
            continue;
        }
        if existed {
            let backups = dir_backups()?;
            let original = std::fs::read(&path).unwrap_or_default();
            let _ = std::fs::write(backups.join(format!("claude_desktop_config-{}.json", now_ms())), original);
        }
        let Value::Object(root) = &mut config else { unreachable!() };
        let servers = root.entry("mcpServers").or_insert_with(|| json!({}));
        if !servers.is_object() {
            *servers = json!({});
        }
        servers["wint"] = json!({ "command": cli.display().to_string(), "args": ["mcp"] });
        let bytes = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
        // In place, never a rename: see the note above.
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .and_then(|mut file| std::io::Write::write_all(&mut file, &bytes))
            .map_err(|e| format!("Could not update {}: {e}", path.display()))?;
        written += 1;
    }
    if written == 0 {
        return Err("Claude Desktop has not made its settings file yet. In Claude Desktop open Settings → Developer → Edit Config once, close it, then click Connect again.".into());
    }
    Ok(claude_status(cli))
}

fn dir_backups() -> Result<PathBuf, String> {
    let backups = dir()?.join("backups");
    std::fs::create_dir_all(&backups).map_err(|e| format!("Could not create {}: {e}", backups.display()))?;
    Ok(backups)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_wint_counts_as_connected() {
        let cli = Path::new(r"C:\Users\x\AppData\Local\WinT\bin\wint.exe");
        let yes = json!({"mcpServers":{"wint":{"command":r"c:\users\x\appdata\local\wint\bin\wint.exe","args":["mcp"]}}});
        let elsewhere = json!({"mcpServers":{"wint":{"command":r"D:\old\wint.exe","args":["mcp"]}}});
        assert!(starts_us(&yes, cli));
        assert!(!starts_us(&elsewhere, cli));
        assert!(!starts_us(&json!({}), cli));
    }

    #[test]
    fn keys_are_file_safe_and_match_the_front_end() {
        assert_eq!(key("devhq"), "devhq");
        assert_eq!(key("  My App (v2) "), "my-app-v2");
        assert_eq!(key("--x--"), "x");
        assert_eq!(key("Ünïcode"), "n-code");
        assert_eq!(key("日本"), "e697a5e69cac");
    }

    #[test]
    fn statuses_accept_what_people_write() {
        assert_eq!(status("Warning"), "attention");
        assert_eq!(status("down"), "incident");
        assert_eq!(status("ok"), "healthy");
        assert_eq!(status("whatever"), "unknown");
    }

    #[test]
    fn a_hand_written_file_is_read_leniently() {
        let value: Value = serde_json::from_str(
            r#"{"status":"warn","summary":"CI red","kpis":{"PRs":3},
                "notes":["plain text", {"type":"Risk","message":"old branch","src":"GitHub"}],
                "agent":"Grok","updatedAt":1700000000}"#,
        )
        .unwrap();
        let o = observation_from(&value, "devhq", 5);
        assert_eq!(o.status, "attention");
        assert_eq!(o.kpis, vec![Kpi { label: "PRs".into(), value: "3".into(), tone: String::new() }]);
        assert_eq!(o.notes.len(), 2);
        assert!(o.notes.iter().any(|n| n.kind == "Risk" && n.source == "GitHub" && n.by == "Grok"));
        assert_eq!(o.updated_at, 1_700_000_000_000);
    }

    #[test]
    fn the_same_note_twice_is_one_note() {
        let mut notes = vec![
            note_from(&json!({"kind":"Risk","text":"x"}), "a", 1).unwrap(),
            note_from(&json!({"kind":"risk","text":"x "}), "b", 2).unwrap(),
        ];
        dedupe(&mut notes);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].by, "b");
    }
}
