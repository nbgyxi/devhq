pub mod analytics;
#[cfg(windows)]
pub mod conpty;
mod cwd;
mod git;
#[cfg(windows)]
mod picker;
mod procs;
mod tech;
pub mod todo;
#[cfg(windows)]
mod term;
mod util;
#[cfg(windows)]
pub mod vt;

use procs::{ProcessSnapshot, RunningProc};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Directories that are never projects themselves and are never worth
/// descending into when looking for one.
const NOISE: &[&str] = &[
    "node_modules", "target", "dist", "build", "out", "vendor", "venv", ".venv",
    "__pycache__", "bin", "obj", "coverage", ".next", ".nuxt", ".cache", ".idea",
    ".vs", ".vscode",
];

/// Any one of these in a directory makes it a project, even without a `.git`.
const MARKERS: &[&str] = &[
    "package.json", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt",
    "Pipfile", "setup.py", "pom.xml", "build.gradle", "Gemfile", "composer.json",
    "deno.json", "Makefile", "CMakeLists.txt", "manifest.json", "Dockerfile",
    "index.html", "CLAUDE.md", ".claude", ".gitignore",
];

/// How many worker threads fan out over the discovered projects. Each project's
/// work is dominated by waiting on `git`, so oversubscribing the CPU count is
/// the point rather than a mistake.
const WORKERS: usize = 12;

/// Finished projects are shipped to the front end in batches, so a few hundred
/// of them do not become a few hundred separate IPC round trips.
const BATCH: usize = 16;
const BATCH_MS: u64 = 40;

/// Every scan gets a token, and starting one bumps the counter. Workers left
/// over from an earlier scan notice they are stale and stop, so a rescan never
/// has to wait for the run it replaces.
static SCAN_TOKEN: AtomicU64 = AtomicU64::new(0);

fn scan_is_current(token: u64) -> bool {
    SCAN_TOKEN.load(Ordering::SeqCst) == token
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Runs blocking work off the UI thread. Every command that touches the disk or
/// spawns a process goes through here, because a synchronous `#[tauri::command]`
/// runs on the main thread and freezes the window for as long as it takes.
async fn off_thread<T, F>(work: F) -> Option<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work).await.ok()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub path: String,
    /// Parent folder name when the project sits one level below the scan root,
    /// empty for a direct child.
    pub group: String,
    pub description: String,
    pub version: String,
    pub package_manager: String,
    pub scripts: Vec<[String; 2]>,
    pub dep_count: u32,
    pub dev_dep_count: u32,
    pub flags: Vec<String>,
    pub tech: Vec<tech::Tech>,
    pub git: Option<git::GitInfo>,
    /// Filled in by the process sweep, which runs beside the per-project work
    /// and arrives in its own event.
    pub running: Vec<RunningProc>,
    pub ports: Vec<u16>,
    /// The command that starts this project, empty when nothing in the folder
    /// says how to. Worked out here, once, rather than guessed in the front end.
    pub run_cmd: String,
    /// Newest mtime among the project's top-level entries, in epoch ms.
    pub touched_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub root: String,
    pub scanned_at_ms: u64,
    pub duration_ms: u64,
    pub projects: Vec<Project>,
    pub error: String,
}

/// One discovered folder, sent before any of its details are known so the
/// window can draw the whole list as skeletons straight away.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stub {
    pub name: String,
    pub path: String,
    pub group: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProcPatch {
    path: String,
    running: Vec<RunningProc>,
    ports: Vec<u16>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanStart {
    token: u64,
    roots: Vec<String>,
    scanned_at_ms: u64,
    stubs: Vec<Stub>,
    error: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanBatch {
    token: u64,
    projects: Vec<Project>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanProcs {
    token: u64,
    items: Vec<ProcPatch>,
}

/// A named step of the scan, so the window can say what it is actually doing
/// rather than showing an unlabelled spinner.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanPhase {
    token: u64,
    key: String,
    label: String,
    done: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanDone {
    token: u64,
    duration_ms: u64,
    error: String,
    cancelled: bool,
}

/// Starts a scan and returns its token immediately. Nothing is scanned on the
/// caller's thread: the folder list arrives as `scan:start`, projects fill in
/// through `scan:project`, running processes through `scan:procs`, and
/// `scan:done` closes it out.
/// The version the app was built as - `tauri.conf.json`'s, which is the one
/// `package-msix.ps1 -BumpVersion` moves and the one the installer carries.
/// The status bar shows this rather than a copy kept in the front end, so the
/// number on screen cannot drift from the number that shipped.
#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageView {
    /// The anonymous id the front end keeps for this install. Never anything
    /// that could name the machine or the person at it.
    pub visitor_id: String,
    /// The screen, as a route: `/overview`, `/project`, `/settings`.
    pub path: String,
}

/// Reports one page view to PageRain. The front end owns the anonymous id and
/// the screen name; this only carries them off the UI thread and onto the
/// network, because the window's own `fetch` is refused by CORS.
///
/// Nothing waits on the answer and a failure is never surfaced: a page view
/// that does not arrive must not cost the user anything.
#[tauri::command]
async fn analytics_page_view(view: PageView) {
    off_thread(move || {
        if let Err(why) = analytics::page_view(&view.visitor_id, &view.path) {
            eprintln!("analytics: {why}");
        }
    })
    .await;
}

#[tauri::command]
fn scan(app: AppHandle, roots: Vec<String>) -> u64 {
    let token = SCAN_TOKEN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || scan_stream(&app, roots, token));
    token
}

/// Retires the running scan. Its workers see a stale token on their next step
/// and stop, and nothing further is emitted for it.
#[tauri::command]
fn scan_cancel() {
    SCAN_TOKEN.fetch_add(1, Ordering::SeqCst);
}

fn emit_scan<T: Serialize + Clone>(app: &AppHandle, token: u64, event: &str, payload: T) {
    if scan_is_current(token) {
        let _ = app.emit(event, payload);
    }
}

fn flush_batch(app: &AppHandle, token: u64, batch: &mut Vec<Project>) {
    if batch.is_empty() {
        return;
    }
    let projects = std::mem::take(batch);
    emit_scan(app, token, "scan:project", ScanBatch { token, projects });
}

fn phase(app: &AppHandle, token: u64, key: &str, label: &str, done: bool) {
    emit_scan(
        app,
        token,
        "scan:phase",
        ScanPhase { token, key: key.into(), label: label.into(), done },
    );
}

fn scan_stream(app: &AppHandle, roots: Vec<String>, token: u64) {
    let started = Instant::now();
    let now_ms = epoch_ms();
    let (present, missing): (Vec<String>, Vec<String>) =
        roots.iter().cloned().partition(|root| Path::new(root).is_dir());

    // A folder that is not there is worth saying out loud, but it only stops
    // the scan when it leaves nothing to look at.
    let error = if !missing.is_empty() {
        format!("{} does not exist.", missing.join(", "))
    } else if roots.is_empty() {
        "Add a folder to scan.".to_string()
    } else {
        String::new()
    };

    if present.is_empty() {
        emit_scan(
            app,
            token,
            "scan:start",
            ScanStart { token, roots, scanned_at_ms: now_ms, stubs: Vec::new(), error: error.clone() },
        );
        emit_scan(app, token, "scan:done", ScanDone { token, duration_ms: 0, error, cancelled: false });
        return;
    }

    phase(app, token, "discover", &format!("Listing folders in {}", present.join(", ")), false);
    let dirs = discover_roots(&present);
    if !scan_is_current(token) {
        return;
    }
    phase(app, token, "discover", &format!("Found {} folders", dirs.len()), true);
    let stubs: Vec<Stub> = dirs
        .iter()
        .map(|(path, group)| Stub {
            name: dir_name(path),
            path: path.to_string_lossy().into_owned(),
            group: group.clone(),
        })
        .collect();
    emit_scan(
        app,
        token,
        "scan:start",
        ScanStart { token, roots, scanned_at_ms: now_ms, stubs, error },
    );

    let (tx, rx) = channel::<Project>();
    std::thread::scope(|scope| {
        let dirs = &dirs;

        // Walking the process table is the slowest single step and nothing else
        // depends on it, so it runs beside the per-project work and patches the
        // cards whenever it lands.
        scope.spawn(move || {
            phase(app, token, "procs", "Scanning running processes", false);
            let snapshot = ProcessSnapshot::capture();
            if !scan_is_current(token) {
                return;
            }
            let items: Vec<ProcPatch> = dirs
                .iter()
                .filter_map(|(path, _)| {
                    let path = path.to_string_lossy().into_owned();
                    let running = snapshot.matching(&path);
                    if running.is_empty() {
                        return None;
                    }
                    let mut ports: Vec<u16> = running.iter().flat_map(|p| p.ports.clone()).collect();
                    ports.sort_unstable();
                    ports.dedup();
                    Some(ProcPatch { path, running, ports })
                })
                .collect();
            let matched = items.len();
            emit_scan(app, token, "scan:procs", ScanProcs { token, items });
            phase(
                app,
                token,
                "procs",
                &format!("{matched} projects have something running"),
                true,
            );
        });

        phase(app, token, "inspect", "Reading git status and project metadata", false);

        // Fan out across a fixed pool: each worker claims whole stripes of the
        // list so no shared queue or extra dependency is needed.
        for worker in 0..WORKERS.min(dirs.len().max(1)) {
            let tx = tx.clone();
            scope.spawn(move || {
                for (path, group) in dirs.iter().skip(worker).step_by(WORKERS) {
                    if !scan_is_current(token) {
                        return;
                    }
                    if tx.send(inspect_project(path, group)).is_err() {
                        return;
                    }
                }
            });
        }
        drop(tx);

        let mut batch: Vec<Project> = Vec::with_capacity(BATCH);
        loop {
            match rx.recv_timeout(Duration::from_millis(BATCH_MS)) {
                Ok(project) => {
                    batch.push(project);
                    if batch.len() >= BATCH {
                        flush_batch(app, token, &mut batch);
                    }
                }
                Err(RecvTimeoutError::Timeout) => flush_batch(app, token, &mut batch),
                Err(RecvTimeoutError::Disconnected) => {
                    flush_batch(app, token, &mut batch);
                    phase(app, token, "inspect", "Read every project", true);
                    break;
                }
            }
        }
    });

    emit_scan(
        app,
        token,
        "scan:done",
        ScanDone {
            token,
            duration_ms: started.elapsed().as_millis() as u64,
            error: String::new(),
            cancelled: false,
        },
    );
}

/// The scan as one blocking call, for `examples/scan_cli.rs`.
pub fn scan_root(root: String) -> ScanResult {
    let started = Instant::now();
    let now_ms = epoch_ms();
    let root_path = PathBuf::from(&root);

    if !root_path.is_dir() {
        return ScanResult {
            root,
            scanned_at_ms: now_ms,
            duration_ms: 0,
            projects: Vec::new(),
            error: "That folder does not exist.".into(),
        };
    }

    let dirs = discover(&root_path);
    let snapshot = ProcessSnapshot::capture();
    let mut projects: Vec<Project> = Vec::with_capacity(dirs.len());
    std::thread::scope(|scope| {
        let dirs = &dirs;
        let handles: Vec<_> = (0..WORKERS.min(dirs.len().max(1)))
            .map(|worker| {
                scope.spawn(move || {
                    dirs.iter()
                        .skip(worker)
                        .step_by(WORKERS)
                        .map(|(path, group)| inspect_project(path, group))
                        .collect::<Vec<Project>>()
                })
            })
            .collect();
        for handle in handles {
            if let Ok(part) = handle.join() {
                projects.extend(part);
            }
        }
    });

    for project in &mut projects {
        project.running = snapshot.matching(&project.path);
        let mut ports: Vec<u16> = project.running.iter().flat_map(|p| p.ports.clone()).collect();
        ports.sort_unstable();
        ports.dedup();
        project.ports = ports;
    }
    projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    ScanResult {
        root,
        scanned_at_ms: now_ms,
        duration_ms: started.elapsed().as_millis() as u64,
        projects,
        error: String::new(),
    }
}

fn dir_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Everything about one project that can be learned without the process table.
fn inspect_project(path: &Path, group: &str) -> Project {
    let report = tech::inspect(path);
    let path_str = path.to_string_lossy().to_string();
    let run_cmd = detect_run(path, &report);

    Project {
        name: dir_name(path),
        path: path_str,
        group: group.to_string(),
        description: report.description,
        version: report.version,
        package_manager: report.package_manager,
        scripts: report.scripts,
        dep_count: report.dep_count,
        dev_dep_count: report.dev_dep_count,
        flags: report.flags,
        tech: report.tech,
        git: git::read(path),
        running: Vec::new(),
        ports: Vec::new(),
        run_cmd,
        touched_ms: newest_child_mtime(path),
    }
}

/// Node scripts that mean "start this thing", best first.
const RUN_SCRIPTS: &[&str] = &["dev", "start", "develop", "serve", "watch"];

/// How this project is started, as a line to type at a shell.
///
/// The answer has to come from what is actually on disk - a `dev` script that
/// is really declared, a `Cargo.toml` that is really there - because the Run
/// button offers to type it for real. When nothing in the folder says how the
/// project runs, the answer is empty and the button says so rather than
/// guessing at something that would only fail in the user's face.
fn detect_run(path: &Path, report: &tech::TechReport) -> String {
    // Expo before the scripts. Its `start` script is usually `expo start`, but
    // going through the package manager loses the CLI's own argument handling,
    // and `npx` is how the Expo docs say to start one.
    if report.tech.iter().any(|t| t.name == "Expo") {
        return "npx expo start".into();
    }
    let mut script = "";
    for want in RUN_SCRIPTS {
        if report.scripts.iter().any(|s| s[0] == *want) {
            script = want;
            break;
        }
    }
    if !script.is_empty() {
        let pm = match report.package_manager.as_str() {
            "pnpm" => "pnpm",
            "yarn" => "yarn",
            "bun" => "bun",
            // No lockfile at all still means npm, which is what a bare
            // package.json is run with by default.
            _ => "npm",
        };
        // Classic yarn has no `run` in front of a user script.
        return if pm == "yarn" {
            format!("yarn {script}")
        } else {
            format!("{pm} run {script}")
        };
    }
    if path.join("Cargo.toml").exists() {
        return "cargo run".into();
    }
    if path.join("src-tauri/Cargo.toml").exists() {
        return "cargo tauri dev".into();
    }
    if path.join("go.mod").exists() {
        return "go run .".into();
    }
    if path.join("manage.py").exists() {
        return "python manage.py runserver".into();
    }
    for entry in ["main.py", "app.py"] {
        if path.join(entry).exists() {
            return format!("python {entry}");
        }
    }
    for compose in ["docker-compose.yml", "docker-compose.yaml", "compose.yml"] {
        if path.join(compose).exists() {
            return "docker compose up".into();
        }
    }
    // Only a target that is really declared - `make dev` on a Makefile without
    // one is just an error with extra steps.
    if let Ok(text) = std::fs::read_to_string(path.join("Makefile")) {
        for target in ["dev", "run", "start"] {
            if text.lines().any(|line| line.starts_with(&format!("{target}:"))) {
                return format!("make {target}");
            }
        }
    }
    String::new()
}

/// Every scan root's projects, in the order the roots were given and without
/// repeating a folder that two roots both reach.
fn discover_roots(roots: &[String]) -> Vec<(PathBuf, String)> {
    let mut found = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    for root in roots {
        for (path, group) in discover(Path::new(root)) {
            if seen.insert(path.clone()) {
                found.push((path, group));
            }
        }
    }
    found
}

/// Projects directly under `root`, plus one extra level for folders that are
/// only containers (a group directory holding several repos).
fn discover(root: &Path) -> Vec<(PathBuf, String)> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else { return found };
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_candidate_dir(&path) {
            continue;
        }
        if is_project(&path) {
            found.push((path, String::new()));
            continue;
        }
        let group = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let Ok(children) = std::fs::read_dir(&path) else { continue };
        for child in children.flatten() {
            let child = child.path();
            if is_candidate_dir(&child) && is_project(&child) {
                found.push((child, group.clone()));
            }
        }
    }
    found
}

fn is_candidate_dir(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return false };
    !name.starts_with('.') && !NOISE.iter().any(|n| n.eq_ignore_ascii_case(name))
}

fn is_project(path: &Path) -> bool {
    path.join(".git").exists() || MARKERS.iter().any(|m| path.join(m).exists())
}

/// Newest mtime among a project's top-level entries. Recursing would mean
/// walking `node_modules` and `target`, which costs far more than the extra
/// precision is worth.
fn newest_child_mtime(path: &Path) -> u64 {
    let mut newest = util::mtime_ms(path);
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let child = entry.path();
            let Some(name) = child.file_name().and_then(|n| n.to_str()) else { continue };
            if NOISE.iter().any(|n| n.eq_ignore_ascii_case(name)) {
                continue;
            }
            newest = newest.max(util::mtime_ms(&child));
        }
    }
    newest
}

/// A sensible starting folder: the common Windows code roots if one exists,
/// otherwise the user profile.
#[tauri::command]
async fn default_root() -> String {
    off_thread(default_root_sync).await.unwrap_or_else(|| "C:\\".to_string())
}

fn default_root_sync() -> String {
    for candidate in ["C:\\code", "C:\\dev", "C:\\src", "C:\\projects"] {
        if Path::new(candidate).is_dir() {
            return candidate.to_string();
        }
    }
    std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".to_string())
}

/// The native folder picker, opened from the folder editor and from the first
/// run. Returns the chosen folder, or `None` when the dialog was dismissed.
/// The dialog runs off the UI thread, so the window keeps drawing while it is
/// on screen.
#[cfg(windows)]
#[tauri::command]
async fn pick_folder(app: AppHandle, start: Option<String>) -> Result<Option<String>, String> {
    // The handle travels as an integer because `HWND` is not `Send`; the picker
    // thread only ever uses it to own the dialog.
    let owner = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|hwnd| hwnd.0 as isize)
        .unwrap_or(0);
    off_thread(move || picker::pick_folder(owner, start))
        .await
        .unwrap_or_else(|| Err("Could not open the folder picker.".into()))
}

/// Off Windows there is no picker to show, so the typed path is all there is.
#[cfg(not(windows))]
#[tauri::command]
async fn pick_folder(_start: Option<String>) -> Result<Option<String>, String> {
    Err("Choosing a folder is only available on Windows - type the path instead.".into())
}

/// Opens a project in Explorer, VS Code or a terminal. `target` is validated
/// against a fixed set so the front end can never name an arbitrary program.
#[tauri::command]
async fn open_in(path: String, target: String) -> Result<(), String> {
    off_thread(move || open_in_sync(path, target))
        .await
        .unwrap_or_else(|| Err("Could not start that program.".into()))
}

fn open_in_sync(path: String, target: String) -> Result<(), String> {
    if !Path::new(&path).is_dir() {
        return Err("Folder no longer exists.".into());
    }
    let ok = match target.as_str() {
        "explorer" => util::run_lossy("explorer", &[&path], None).is_some(),
        "vscode" => util::run_lossy("cmd", &["/c", "code", &path], None).is_some(),
        "terminal" => util::run_lossy(
            "cmd",
            &["/c", "start", "cmd", "/K", &format!("cd /d \"{path}\"")],
            None,
        )
        .is_some(),
        other => return Err(format!("Unknown target: {other}")),
    };
    if ok {
        Ok(())
    } else {
        Err(format!("Could not open with {target}."))
    }
}

/// A patch big enough to be worth reading and small enough to hand a webview
/// in one piece. Past this the front end says so rather than pretending the
/// part it got is all there was.
const MAX_DIFF_BYTES: usize = 400 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    /// The unified patch, staged and unstaged together.
    pub text: String,
    pub truncated: bool,
    pub files: u32,
}

/// The working tree's actual patch - what changed, not just how much.
#[tauri::command]
async fn git_diff(path: String) -> Result<Diff, String> {
    off_thread(move || git_diff_sync(path))
        .await
        .unwrap_or_else(|| Err("Could not read the diff.".into()))
}

fn git_diff_sync(path: String) -> Result<Diff, String> {
    let dir = PathBuf::from(&path);
    if !dir.join(".git").exists() {
        return Err("Not a git repository.".into());
    }
    // Two calls rather than one against `HEAD`, so a repository with nothing
    // committed yet still shows its staged work instead of failing on a
    // revision that does not exist.
    let unstaged = util::run_lossy("git", &["diff", "--no-color"], Some(&dir)).unwrap_or_default();
    let staged =
        util::run_lossy("git", &["diff", "--cached", "--no-color"], Some(&dir)).unwrap_or_default();

    let mut text = String::new();
    if !staged.trim().is_empty() {
        text.push_str(staged.trim_end());
        text.push('\n');
    }
    text.push_str(&unstaged);
    let files = text.lines().filter(|l| l.starts_with("diff --git ")).count() as u32;

    let truncated = text.len() > MAX_DIFF_BYTES;
    if truncated {
        // Cut on a character boundary, or the webview is handed invalid UTF-8.
        let mut end = MAX_DIFF_BYTES;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    Ok(Diff { text, truncated, files })
}

/// What `git pull` did: whether it worked, the line worth showing for it, and
/// the project re-read afterwards so the card stops claiming it is behind.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub ok: bool,
    pub summary: String,
    pub project: Option<Project>,
}

/// `git pull` in one project's folder.
#[tauri::command]
async fn git_pull(path: String, group: String) -> Result<PullResult, String> {
    off_thread(move || git_pull_sync(path, group))
        .await
        .unwrap_or_else(|| Err("Could not run git pull.".into()))
}

fn git_pull_sync(path: String, group: String) -> Result<PullResult, String> {
    let dir = PathBuf::from(&path);
    if !dir.join(".git").exists() {
        return Err("Not a git repository.".into());
    }

    let mut cmd = std::process::Command::new("git");
    cmd.arg("pull").current_dir(&dir);
    // Nothing here may sit waiting for a human: no editor for a merge message,
    // no credential or host-key prompt. A pull that would need one fails and
    // says so instead of hanging a window that must never block.
    cmd.env("GIT_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd.output().map_err(|_| "Could not start git.".to_string())?;
    let ok = out.status.success();
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let summary = pull_summary(&stdout, &stderr, ok);

    // Only a pull that worked can have changed anything worth re-reading.
    let project = ok.then(|| inspect_project(&dir, &group));
    Ok(PullResult { ok, summary, project })
}

/// The one line of git's output worth putting in the status bar.
fn pull_summary(stdout: &str, stderr: &str, ok: bool) -> String {
    if ok && stdout.contains("Already up to date") {
        return "Already up to date".to_string();
    }
    let pick = |text: &str| {
        text.lines()
            .map(str::trim)
            .find(|line| {
                !line.is_empty()
                    && !line.starts_with("From ")
                    && !line.starts_with("remote:")
                    && !line.starts_with("Receiving")
                    && !line.starts_with("Resolving")
                    && !line.starts_with("Unpacking")
                    && !line.starts_with("Counting")
                    && !line.starts_with("Compressing")
                    && !line.starts_with("hint:")
                    && !line.starts_with("warning:")
            })
            .map(str::to_string)
    };
    let line = if ok {
        pick(stdout).or_else(|| pick(stderr))
    } else {
        pick(stderr).or_else(|| pick(stdout))
    };
    line.unwrap_or_else(|| if ok { "Pulled".into() } else { "git pull failed".into() })
}

/// Every `TODO` / `FIXME` left in a project's own source.
#[tauri::command]
async fn todos(path: String) -> Result<todo::TodoReport, String> {
    off_thread(move || {
        let dir = PathBuf::from(&path);
        if !dir.is_dir() {
            return Err("Folder no longer exists.".into());
        }
        Ok(todo::scan(&dir))
    })
    .await
    .unwrap_or_else(|| Err("Could not read the project.".into()))
}

/// The source around one TODO, so a note can be read in the code it was left in.
#[tauri::command]
async fn todo_excerpt(path: String, file: String, line: u32) -> Result<todo::Excerpt, String> {
    off_thread(move || {
        let dir = PathBuf::from(&path);
        if !dir.is_dir() {
            return Err("Folder no longer exists.".into());
        }
        todo::excerpt(&dir, &file, line)
    })
    .await
    .unwrap_or_else(|| Err("Could not read the file.".into()))
}

#[tauri::command]
async fn port_list() -> Vec<procs::ProcessEntry> {
    off_thread(procs::port_list).await.unwrap_or_default()
}

#[tauri::command]
async fn port_kill(pid: u32, expected_executable: String, expected_process: String) -> Result<(), String> {
    off_thread(move || procs::kill(pid, &expected_executable, &expected_process))
        .await
        .unwrap_or_else(|| Err("Could not terminate the process.".into()))
}

#[tauri::command]
async fn term_close_snapshot(id: String) -> Result<Vec<procs::ProcessIdentity>, String> {
    off_thread(move || {
        let descendants = procs::descendants(term::term_pid(&id)?);
        term::term_close(id)?;
        Ok(descendants)
    }).await.unwrap_or_else(|| Err("Could not close the terminal.".into()))
}

#[tauri::command]
async fn process_survivors(expected: Vec<procs::ProcessIdentity>) -> Vec<procs::ProcessIdentity> {
    off_thread(move || procs::survivors(expected)).await.unwrap_or_default()
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    #[cfg(windows)]
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            scan,
            app_version,
            analytics_page_view,
            scan_cancel,
            default_root,
            pick_folder,
            open_in,
            git_diff,
            git_pull,
            todos,
            todo_excerpt,
            port_list,
            port_kill,
            term_close_snapshot,
            process_survivors,
            term::term_shell_availability,
            term::term_open,
            term::term_attach,
            term::term_write,
            term::term_resize,
            term::term_close,
            term::term_list,
            term::term_popout,
            term::term_drag_preview,
            term::term_dock
        ])
        .on_window_event(|window, event| {
            // The main window going away means the app is going away, so every
            // shell goes with it — a popped-out terminal must never outlive it.
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == "main" {
                // Destroy bypasses each pop-out's close-to-dock handler; there
                // is no main window left to receive that handoff.
                for (label, child) in window.app_handle().webview_windows() {
                    if label.starts_with("term-") {
                        let _ = child.destroy();
                    }
                }
                term::shutdown();
            }
        });

    #[cfg(not(windows))]
    let builder =
        builder.invoke_handler(tauri::generate_handler![
            scan,
            app_version,
            analytics_page_view,
            scan_cancel,
            default_root,
            pick_folder,
            open_in,
            git_diff,
            git_pull,
            todos,
            todo_excerpt
        ]);

    builder.run(tauri::generate_context!()).expect("error while running DevHQ");
}
