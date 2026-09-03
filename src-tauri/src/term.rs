//! Terminal sessions, and the commands the front end drives them with.
//!
//! The session — pseudoconsole, child process and screen — lives here in Rust,
//! keyed by id. A webview is only ever a view onto it. That is what makes
//! popping a terminal out of the main window cheap: the new window calls
//! [`term_attach`] and is handed the current screen, while the shell underneath
//! never notices it changed frames.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::conpty::{self, ConPty};
use crate::off_thread;
use crate::vt::{char_width, Cell, Grid, CONT, DEFAULT_COLOR};

/// How much history an attaching view is handed. The session keeps more than
/// this; the rest is simply older than anyone scrolls back to on open.
const ATTACH_HISTORY: usize = 1000;

/// Shells tried in order. The first that starts wins, so a machine with
/// PowerShell 7 gets it and everything else falls back to what ships with Windows.
const SHELLS: &[&str] = &["pwsh.exe -NoLogo", "powershell.exe -NoLogo"];

fn shell_command(profile: &str) -> Result<String, String> {
    match profile {
        "pwsh" => pwsh_path(false)
            .map(|path| format!(r#""{}" -NoLogo"#, path.display()))
            .ok_or_else(|| "PowerShell 7 was not found.".into()),
        "pwsh-preview" => pwsh_path(true)
            .map(|path| format!(r#""{}" -NoLogo"#, path.display()))
            .ok_or_else(|| "PowerShell Preview was not found.".into()),
        "powershell" => Ok("powershell.exe -NoLogo".into()),
        "cmd" => Ok("cmd.exe".into()),
        "nu" => Ok(nu_path()
            .map(|path| format!(r#""{}""#, path.display()))
            .unwrap_or_else(|| "nu.exe".into())),
        "wsl" => Ok("wsl.exe --exec bash --login".into()),
        // The one profile that opens on a machine that does not have it. There
        // is no useful dead end here: the pane itself is where the CLI gets
        // installed and signed in, so a missing Claude Code opens the
        // walkthrough instead of an error dialog.
        "claude" => match claude_path() {
            Some(path) => Ok(program_command(&path)),
            None => claude_setup_command(),
        },
        "git-bash" => {
            let Some(bash) = git_bash_path() else {
                return Err(
                    "Git Bash was not found. Install Git for Windows or choose another shell."
                        .into(),
                );
            };
            Ok(format!(r#""{}" --login -i"#, bash.display()))
        }
        _ => Err("Unknown terminal shell.".into()),
    }
}

fn find_command(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
    })
}

/// The first of several names to turn up on PATH. A CLI installed by npm is a
/// `.cmd` shim beside an `.exe` that may not exist, and which of the two is
/// there is not something to guess at.
fn find_program(names: &[&str]) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
            .find(|path| path.is_file())
    })
}

/// A command line that starts `path`, whatever kind of file it is.
///
/// `CreateProcess` starts images, not scripts: a `.cmd` or `.bat` shim — which
/// is how npm puts a CLI on PATH — has to be handed to an interpreter, and an
/// `.exe` must not be, because that would leave a `cmd.exe` sitting between the
/// pane and the process whose console it actually is.
fn program_command(path: &Path) -> String {
    let script = path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));
    if script {
        format!(r#"cmd.exe /d /c ""{}"""#, path.display())
    } else {
        format!(r#""{}""#, path.display())
    }
}

/// Where a shell is looked for, in order: what the user put on PATH, what an
/// installer put in Program Files, and only then the copy WinT downloaded for
/// them. A real installation always wins - WinT's copy is the backstop for a
/// machine that has none, never a replacement for one that has.
fn pwsh_path(preview: bool) -> Option<PathBuf> {
    if !preview {
        if let Some(path) = find_command("pwsh.exe") {
            return Some(path);
        }
    }
    let folder = if preview { "7-preview" } else { "7" };
    std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .map(|root| root.join("PowerShell").join(folder).join("pwsh.exe"))
        .filter(|path| path.is_file())
        .or_else(|| crate::shells::managed_exe(if preview { "pwsh-preview" } else { "pwsh" }))
}

fn nu_path() -> Option<PathBuf> {
    find_command("nu.exe").or_else(|| crate::shells::managed_exe("nu"))
}

/// The walkthrough a Claude Code pane opens into when the CLI is not on this
/// computer yet: what it is, who it signs in as, and the one keystroke that
/// installs it. It ends by starting Claude, so a machine that had nothing is
/// looking at a signed-in chat without leaving the pane.
///
/// It installs nothing on its own. Nothing is fetched, and no browser opens,
/// until the person reading it picks a numbered option - which is why this can
/// be the *default* behaviour of opening the profile.
const CLAUDE_SETUP_PS1: &str = r##"
function Line($text, $color) {
  if ($color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text }
}

Line 'Claude Code' 'Cyan'
Line '-----------' 'DarkGray'
Line ''
Line 'This pane runs Anthropic''s Claude Code CLI, in this project''s folder.'
Line 'It is not installed on this computer yet.'
Line ''
Line 'WinT does not ship it and holds no key for it. You install the CLI and sign'
Line 'in as yourself; WinT only gives it a terminal to run in.' 'DarkGray'
Line ''

$npm = Get-Command npm -ErrorAction SilentlyContinue

Line 'How would you like to install it?' 'White'
if ($npm) {
  Line '  [1] npm install -g @anthropic-ai/claude-code'
} else {
  Line '  [1] npm - unavailable, Node.js is not installed' 'DarkGray'
}
Line '  [2] Open the install instructions in your browser'
Line '  [Enter] Not now - leave me at a PowerShell prompt'
Line ''
$choice = (Read-Host 'Choice').Trim()
Line ''

if ($choice -eq '2') {
  Start-Process 'https://docs.claude.com/en/docs/claude-code/setup'
  Line 'Opened the install page. Open a Claude Code terminal again once it is installed.' 'DarkGray'
  return
}

if ($choice -ne '1') {
  Line 'Nothing was installed. This pane is an ordinary PowerShell prompt.' 'DarkGray'
  return
}

if (-not $npm) {
  Line 'Node.js is not installed, so npm cannot run.' 'Yellow'
  Line 'Install Node.js from https://nodejs.org and open this terminal again, or pick [2].' 'DarkGray'
  return
}

Line 'Installing Claude Code. npm''s output follows.' 'White'
Line ''
npm install -g '@anthropic-ai/claude-code'
Line ''
if ($LASTEXITCODE -ne 0) {
  Line 'The install did not finish - npm''s output above says why.' 'Red'
  return
}

# npm put the shim somewhere this process has never looked. Re-reading PATH from
# the registry is what a brand new terminal would have done anyway.
$machine = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
$user = [Environment]::GetEnvironmentVariable('PATH', 'User')
$env:PATH = "$machine;$user;" + (Join-Path $env:APPDATA 'npm')

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
  Line 'Claude Code installed, but is not on PATH in this pane yet.' 'Yellow'
  Line 'Close this terminal and open a Claude Code one again.' 'DarkGray'
  return
}

Line 'Installed. Starting Claude Code - it asks you to sign in the first time.' 'Green'
Line ''
& $claude.Source
"##;

/// Writes the walkthrough out fresh and returns the command line that runs it.
///
/// Fresh every time on purpose: the script is WinT's, not the user's, and a
/// stale copy left by an older version would be the one thing here nobody
/// thinks to look at. `-NoExit` is what keeps the pane usable after the script
/// ends, however it ended.
fn claude_setup_command() -> Result<String, String> {
    let dir = crate::shells::runtime_root();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not prepare the setup script: {e}"))?;
    let script = dir.join("claude-setup.ps1");
    std::fs::write(&script, CLAUDE_SETUP_PS1)
        .map_err(|e| format!("Could not write the setup script: {e}"))?;
    Ok(format!(
        r#"powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File "{}""#,
        script.display()
    ))
}

/// Where the Claude Code CLI is looked for: PATH first, then the two places its
/// own installers put it.
///
/// Unlike every other profile here this is never something WinT provides. The
/// CLI is the user's own install, signed in as them, and WinT only starts it in
/// a pane — no key is read, stored or passed. A machine without it gets a
/// disabled entry saying so, not a download.
fn claude_path() -> Option<PathBuf> {
    find_program(&["claude.exe", "claude.cmd", "claude.bat"])
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .map(|home| home.join(".local").join("bin").join("claude.exe"))
                .filter(|path| path.is_file())
        })
        .or_else(|| {
            std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .map(|roaming| roaming.join("npm").join("claude.cmd"))
                .filter(|path| path.is_file())
        })
}

/// The program a pane was asked to run, against what this computer has.
///
/// `wt split-pane … pwsh -NoExit -Command …` is what these lines look like
/// everywhere they are written, and the whole point of taking them here is that
/// they run on this machine unchanged. PowerShell 7 not being installed is not
/// a reason to leave the pane empty when the same line runs perfectly well in
/// Windows PowerShell - but it is a reason to say which one is running, because
/// the two are not the same shell.
///
/// Anything else is left exactly as it was written. Guessing at a substitute
/// for an arbitrary program is how a pane ends up quietly running the wrong
/// thing.
fn resolve_pane_command(command: &str) -> (String, Option<String>) {
    let trimmed = command.trim();
    let (first, rest) = trimmed
        .split_once(char::is_whitespace)
        .unwrap_or((trimmed, ""));
    // NuShell gets the same treatment for the same reason: WinT may hold the
    // only copy on the machine, and `nu` alone would not find it. `bash` is
    // deliberately not in this list - it means Git Bash to one person and WSL
    // to the next, and picking one of those is guessing.
    if first.eq_ignore_ascii_case("nu") || first.eq_ignore_ascii_case("nu.exe") {
        if find_command("nu.exe").is_some() {
            return (command.to_string(), None);
        }
        return match nu_path() {
            Some(path) => (format!("\"{}\" {rest}", path.display()), None),
            None => (command.to_string(), None),
        };
    }
    let names_pwsh = ["pwsh", "pwsh.exe"]
        .iter()
        .any(|name| first.eq_ignore_ascii_case(name));
    // On PATH is the case that needs no help at all: the line runs as written.
    if !names_pwsh || find_command("pwsh.exe").is_some() {
        return (command.to_string(), None);
    }
    // There is a PowerShell 7 here, it is just not something `CreateProcess`
    // can find by name - an install that never joined PATH, or the copy WinT
    // downloaded. Naming the file is the difference between the pane running
    // what was asked for and not opening at all.
    if let Some(path) = pwsh_path(false) {
        let managed = crate::shells::managed_exe("pwsh").is_some_and(|copy| copy == path);
        return (
            format!("\"{}\" {rest}", path.display()),
            managed.then(|| "This pane is the PowerShell 7 WinT downloaded.".to_string()),
        );
    }
    let Some(installed) = find_command("powershell.exe") else {
        return (command.to_string(), None);
    };
    (
        format!("\"{}\" {rest}", installed.display()),
        Some("PowerShell 7 is not installed, so this pane is Windows PowerShell.".into()),
    )
}

fn git_bash_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(variable) {
            candidates.push(PathBuf::from(root).join("Git").join("bin").join("bash.exe"));
        }
    }
    if let Some(root) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(root)
                .join("Programs")
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .or_else(|| crate::shells::managed_exe("git-bash"))
}

/// Something to do to the pseudoconsole. Both of these can block - a full
/// input pipe, or a `ResizePseudoConsole` waiting on the console's own pump -
/// which is why neither is ever done on the thread that draws the window.
enum Job {
    Write(Vec<u8>),
    /// The acknowledgement lets `term_resize` stay a promise the front end can
    /// repaint behind, without the wait landing on the window thread.
    Resize(usize, usize, Sender<()>),
}

struct Session {
    id: String,
    project_path: String,
    project_name: String,
    /// Keystrokes and resizes, in the order the window handed them over. The
    /// window thread only posts here; the writer thread does the blocking part.
    jobs: Sender<Job>,
    pty: Mutex<ConPty>,
    grid: Mutex<Grid>,
    alive: AtomicBool,
    pid: u32,
    command: String,
    /// The stream this terminal is kept as, if it is being kept. The reader
    /// thread appends what the shell says; the writer thread notes the resizes,
    /// which never appear in the bytes themselves.
    log: Mutex<Option<HistoryLog>>,
    /// What names this terminal's stream across runs, so it can be forgotten
    /// when the terminal is closed for good.
    history_key: Option<String>,
    /// The last loopback address this terminal printed, if any. Kept so that a
    /// workspace opened after the server started can still find out where it is,
    /// and so the same address announced on every rebuild is only acted on once.
    served: Mutex<Option<String>>,
}

fn registry() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("t{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Whether the installed proxy is already the one that would be copied over
/// it. `CopyFileW` carries the source's write time across, so the pair a copy
/// produced still matches years later.
fn same_file(source: &Path, installed: &Path) -> bool {
    let (Ok(from), Ok(to)) = (std::fs::metadata(source), std::fs::metadata(installed)) else {
        return false;
    };
    from.len() == to.len() && from.modified().ok() == to.modified().ok()
}

/// Replaces the proxy, including while a copy of it is running - which is the
/// normal case now that `wt` waits at the prompt for WinT's answer. A running
/// image cannot be written over, but Windows will happily rename one, so the
/// old file is moved aside and left for whoever is still in it.
fn install_wt_proxy(source: &Path, installed: &Path) -> Result<(), String> {
    if installed.is_file() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let aside = installed.with_file_name(format!("wt.old-{stamp}"));
        if std::fs::rename(installed, &aside).is_err() {
            // Not renameable either: overwrite it directly and let the error,
            // if there is one, be the one that is reported.
            std::fs::copy(source, installed).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    std::fs::copy(source, installed).map(|_| ()).map_err(|e| e.to_string())
}

/// The proxies moved aside by an update, once nothing is running them. Failing
/// to delete one means it is still in use, which is fine - the next terminal
/// opened tries again.
fn sweep_replaced_proxies(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with("wt.old-") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Installs a tiny `wt` compatibility command in an app-owned runtime folder.
/// Its directory is prepended only to shells hosted by WinT, so normal
/// Windows Terminal use elsewhere is unaffected.
fn wt_compat_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = crate::shells::runtime_root();
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Could not create the terminal runtime folder: {e}"))?;
    let mut candidates = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("wint-cli.exe"));
        candidates.push(resources.join("resources").join("wint-cli.exe"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(directory) = exe.parent() {
            candidates.push(directory.join("wint-cli.exe"));
            if let Some(target) = directory.parent() {
                candidates.push(target.join("debug").join("wint-cli.exe"));
                candidates.push(target.join("release").join("wint-cli.exe"));
            }
        }
    }
    let installed = root.join("wt.exe");
    let source = candidates.into_iter().find(|path| path.is_file());
    match source {
        // The copy is skipped when the proxy is already this build's. It used
        // to run on every terminal opened, which is both a needless copy of a
        // few megabytes and a fight with a `wt` that happens to be running.
        Some(source) if !same_file(&source, &installed) => {
            if let Err(error) = install_wt_proxy(&source, &installed) {
                // A proxy is already there and doing its job. Refusing to open
                // a shell because the spare copy could not be refreshed helps
                // nobody: the terminal is the point, the shim is a convenience.
                if !installed.is_file() {
                    return Err(format!("Could not install WinT's wt compatibility proxy: {error}"));
                }
            }
        }
        None if !installed.is_file() => {
            return Err("This build does not contain the WinT CLI used by terminal compatibility. Run npm run cli:build and restart WinT.".to_string());
        }
        _ => {}
    }
    let old_cmd = root.join("wt.cmd");
    if old_cmd.is_file() { let _ = std::fs::remove_file(old_cmd); }
    sweep_replaced_proxies(&root);
    Ok(root)
}

fn lookup(id: &str) -> Result<Arc<Session>, String> {
    registry()
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| "That terminal is gone.".to_string())
}

pub fn term_pid(id: &str) -> Result<u32, String> {
    Ok(lookup(id)?.pid)
}

// ---- wire types --------------------------------------------------------

/// One stretch of cells sharing a colour and attributes, which is how a row
/// reaches the front end: a handful of runs instead of hundreds of cells.
///
/// `x` and `w` are terminal columns, not characters: they are what the front
/// end pins the run to, and they are the only reason a row containing a glyph
/// of the wrong width still lines up with the row above it. `c` asks for the
/// run to be clipped to those columns, which is wanted for anything the
/// terminal font might not have and wrong for plain text, where an italic can
/// lean a pixel past its last column without hurting anyone.
#[derive(Serialize, Clone)]
struct Run {
    t: String,
    f: u32,
    b: u32,
    a: u8,
    x: usize,
    w: usize,
    c: bool,
}

#[derive(Serialize, Clone)]
struct RowUpdate {
    y: usize,
    runs: Vec<Run>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TermInfo {
    pub id: String,
    pub project_path: String,
    pub project_name: String,
    pub title: String,
    pub pid: u32,
    pub alive: bool,
    pub command: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    info: TermInfo,
    cols: usize,
    rows: usize,
    history: Vec<Vec<Run>>,
    screen: Vec<RowUpdate>,
    cx: usize,
    cy: usize,
    cursor_visible: bool,
    cursor_style: u8,
    cursor_char: char,
    alt: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Update {
    id: String,
    rows: Vec<RowUpdate>,
    scrolled: Vec<Vec<Run>>,
    /// CSI 3 J wiped the session scrollback; the view must drop its history.
    clear_history: bool,
    cx: usize,
    cy: usize,
    cursor_visible: bool,
    cursor_style: u8,
    cursor_char: char,
    alt: bool,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenArgs {
    pub project_path: String,
    pub project_name: Option<String>,
    /// A specific command to run instead of an interactive shell — an npm
    /// script, say. The session is otherwise identical.
    pub command: Option<String>,
    pub shell: Option<String>,
    pub cols: Option<usize>,
    pub rows: Option<usize>,
    /// Names this terminal's kept stream. The window mints one per terminal and
    /// remembers it, which is how a shell that is gone hands its scrollback to
    /// the one that replaces it.
    pub history_key: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellAvailability {
    profile: &'static str,
    available: bool,
    reason: Option<&'static str>,
    /// The profile opens, but into a pane that installs the thing first. Only
    /// Claude Code does this: every other profile either starts a shell that is
    /// already on the machine or is honestly unavailable.
    setup: bool,
}

/// The character under the cursor, for a block cursor to draw over.
///
/// The cursor can be sitting on the second column of a double-width glyph,
/// whose cell holds a marker rather than anything printable - a space is what
/// the block should show there.
fn cursor_char(grid: &Grid) -> char {
    let ch = grid.row(grid.cy)[grid.cx].ch;
    if ch == CONT {
        ' '
    } else {
        ch
    }
}

/// Packs a row into runs, dropping the trailing default-background blanks that
/// make up most of a typical line.
///
/// Every run carries the column it starts at and how many columns it covers,
/// because the front end pins each one to that column rather than letting the
/// browser flow them one after another. A glyph the terminal font does not
/// have is drawn from a fallback font at some other width, and in a flowed row
/// that shifts everything to its right - the table below it stops lining up.
/// Anchored runs keep the damage inside the run.
///
/// So runs also break where that damage would start: plain ASCII, which the
/// terminal font always has, is kept apart from everything else, and a
/// double-width glyph is a run of its own with exactly two columns to sit in.
fn pack(cells: &[Cell]) -> Vec<Run> {
    let end = cells
        .iter()
        .rposition(|c| c.ch != ' ' || c.bg != DEFAULT_COLOR || c.attr != 0)
        .map(|i| i + 1)
        .unwrap_or(0);
    let mut runs: Vec<Run> = Vec::new();
    // Whether the run being built can still take another character, and
    // whether that character would have to be plain to join it.
    let mut open: Option<bool> = None;
    for (x, cell) in cells[..end].iter().enumerate() {
        // The second column of a double-width glyph is not drawn; the glyph
        // in the column before it already covers this one.
        if cell.ch == CONT {
            continue;
        }
        let w = char_width(cell.ch).max(1);
        let plain = cell.ch == ' ' || cell.ch.is_ascii_graphic();
        let join = match (runs.last(), open) {
            (Some(run), Some(run_plain)) => {
                w == 1
                    && run_plain == plain
                    && run.f == cell.fg
                    && run.b == cell.bg
                    && run.a == cell.attr
                    && run.x + run.w == x
            }
            _ => false,
        };
        if join {
            let run = runs.last_mut().expect("join implies a run");
            run.t.push(cell.ch);
            run.w += 1;
        } else {
            runs.push(Run {
                t: cell.ch.to_string(),
                f: cell.fg,
                b: cell.bg,
                a: cell.attr,
                x,
                w,
                c: !plain,
            });
            // A double-width run is closed the moment it opens: it owns its
            // two columns and nothing else may share them.
            open = if w == 2 { None } else { Some(plain) };
        }
    }
    runs
}

#[cfg(test)]
mod history_tests {
    use super::*;
    use std::sync::Mutex;

    /// `WINT_TERM_LOG` is process-wide, so the tests that move it take turns.
    static ENV: Mutex<()> = Mutex::new(());

    /// A failing test must not take the rest down with it: the guard is only
    /// here to serialise them, and it carries no state worth protecting.
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        ENV.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wint-history-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn line(grid: &Grid, y: usize) -> String {
        grid.row(y)
            .iter()
            .map(|c| c.ch)
            .collect::<String>()
            .trim_end()
            .to_string()
    }

    fn back(grid: &Grid, i: usize) -> String {
        grid.scrollback[i]
            .iter()
            .map(|c| c.ch)
            .collect::<String>()
            .trim_end()
            .to_string()
    }

    /// The whole point: what a restored terminal shows is not rebuilt from a
    /// picture of the screen, it is the same bytes through the same parser. So
    /// a session fed live and a session replayed from its stream have to hold
    /// the same scrollback, colours and all.
    #[test]
    fn a_replayed_stream_is_the_session_it_came_from() {
        let _guard = serial();
        let dir = scratch("replay");
        std::env::set_var("WINT_TERM_LOG", &dir);

        // Green text, then a prompt the shell is standing on - exactly the
        // shape that used to come back grey, and one line too far down.
        let stream = b"PS C:\\code> npm test\r\n\x1b[32mPASS\x1b[0m 12 tests\r\nPS C:\\code> ";

        let mut live = Grid::new(40, 6);
        live.feed(stream);

        let mut log = HistoryLog::open("session-a", 40, 6).unwrap();
        log.append(stream, true);
        drop(log);

        let replayed = replay_history("session-a", 40, 6);

        // Everything the old shell finished saying is history now, and it is
        // the very same cells the live grid is holding.
        assert_eq!(back(&replayed, 0), line(&live, 0));
        assert_eq!(back(&replayed, 1), line(&live, 1));
        assert_eq!(
            replayed.scrollback.len(),
            2,
            "the standing prompt is not output"
        );
        assert_eq!(
            replayed.scrollback[1]
                .iter()
                .map(|c| c.fg)
                .collect::<Vec<_>>(),
            live.row(1).iter().map(|c| c.fg).collect::<Vec<_>>(),
            "the colours are not copied over, they are parsed again",
        );
        // And the screen is clear, so the replacement shell starts underneath.
        assert_eq!(line(&replayed, 0), "");
        assert_eq!((replayed.cx, replayed.cy), (0, 0));

        std::env::remove_var("WINT_TERM_LOG");
    }

    /// A stream that outgrows its cap loses its front at a mark, and what is
    /// left still parses from its first byte.
    #[test]
    fn a_trimmed_stream_still_reads_from_the_front() {
        let _guard = serial();
        let dir = scratch("trim");
        std::env::set_var("WINT_TERM_LOG", &dir);

        let mut log = HistoryLog::open("session-b", 40, 6).unwrap();
        // Past the cap, in chunks that each end on a line boundary.
        let chunk = vec![b'x'; 200 * 1024];
        for _ in 0..40 {
            log.append(&chunk, true);
            log.append(b"\r\n", true);
        }
        let kept = log.written;
        drop(log);

        let (bin, _) = history_paths("session-b").unwrap();
        let len = std::fs::metadata(&bin).unwrap().len();
        assert!(
            len <= HISTORY_COMPACT_AT,
            "{len} bytes kept, trimmed at {HISTORY_COMPACT_AT}"
        );
        assert!(len > 0);
        assert_eq!(len, kept, "the log knows how long it is after a trim");
        // Cut at a mark, so the first byte is still the start of a line.
        let replayed = replay_history("session-b", 40, 6);
        assert!(replayed
            .scrollback
            .iter()
            .all(|row| row.iter().all(|c| c.ch == 'x' || c.ch == ' ')));

        std::env::remove_var("WINT_TERM_LOG");
    }

    /// Closing a terminal is the one thing that ends its history.
    #[test]
    fn forgetting_a_terminal_drops_its_stream() {
        let _guard = serial();
        let dir = scratch("forget");
        std::env::set_var("WINT_TERM_LOG", &dir);

        let mut log = HistoryLog::open("session-c", 40, 6).unwrap();
        log.append(b"something\r\n", true);
        drop(log);
        let (bin, meta) = history_paths("session-c").unwrap();
        assert!(bin.exists() && meta.exists());

        forget_history("session-c");
        assert!(!bin.exists() && !meta.exists());
        assert_eq!(replay_history("session-c", 40, 6).scrollback.len(), 0);

        std::env::remove_var("WINT_TERM_LOG");
    }

    /// A key becomes a file name, so it is checked rather than trusted.
    #[test]
    fn a_key_cannot_leave_its_folder() {
        let _guard = serial();
        let dir = scratch("keys");
        std::env::set_var("WINT_TERM_LOG", &dir);

        assert!(history_paths("../../etc/passwd").is_none());
        assert!(history_paths("has space").is_none());
        assert!(history_paths("").is_none());
        assert!(history_paths(&"x".repeat(65)).is_none());
        assert!(history_paths("2f8a1c-4b_9").is_some());

        std::env::remove_var("WINT_TERM_LOG");
    }
}

#[cfg(test)]
mod tests {
    use super::pack;
    use crate::vt::Grid;

    fn row_runs(cols: usize, bytes: &[u8]) -> Vec<(String, usize, usize, bool)> {
        let mut grid = Grid::new(cols, 3);
        grid.feed(bytes);
        pack(grid.row(0))
            .into_iter()
            .map(|r| (r.t, r.x, r.w, r.c))
            .collect()
    }

    #[test]
    fn plain_text_is_one_run_covering_its_columns() {
        let runs = row_runs(20, b"hello");
        assert_eq!(runs, vec![("hello".into(), 0, 5, false)]);
    }

    #[test]
    fn a_glyph_the_font_may_not_have_is_split_off_and_clipped() {
        // A table's rule: text, box drawing, text. The middle stretch is the
        // one that can be drawn from a fallback font, so it gets its own run
        // and is clipped to the columns it was given.
        let runs = row_runs(20, "a──b".as_bytes());
        assert_eq!(
            runs,
            vec![
                ("a".into(), 0, 1, false),
                ("──".into(), 1, 2, true),
                ("b".into(), 3, 1, false),
            ]
        );
    }

    #[test]
    fn a_wide_glyph_is_its_own_run_of_two_columns() {
        let runs = row_runs(20, "a你好b".as_bytes());
        assert_eq!(
            runs,
            vec![
                ("a".into(), 0, 1, false),
                ("你".into(), 1, 2, true),
                ("好".into(), 3, 2, true),
                ("b".into(), 5, 1, false),
            ]
        );
    }

    #[test]
    fn columns_survive_a_colour_change_mid_row() {
        let runs = row_runs(20, b"ab[31mcd[0mef");
        let columns: Vec<(usize, usize)> = runs.iter().map(|r| (r.1, r.2)).collect();
        assert_eq!(columns, vec![(0, 2), (2, 2), (4, 2)]);
    }
}

impl Session {
    fn info(&self) -> TermInfo {
        let title = self.grid.lock().unwrap().title.clone();
        TermInfo {
            id: self.id.clone(),
            project_path: self.project_path.clone(),
            project_name: self.project_name.clone(),
            title,
            pid: self.pid,
            // A child that has exited without the reader noticing yet still
            // reads as dead, so a stale tab cannot look live.
            alive: self.alive.load(Ordering::Relaxed) && !self.pty.lock().unwrap().exited(),
            command: self.command.clone(),
        }
    }
}

// ---- commands ----------------------------------------------------------

#[tauri::command]
pub async fn term_shell_availability() -> Vec<ShellAvailability> {
    tauri::async_runtime::spawn_blocking(|| {
        let candidates = [
            (
                "pwsh",
                pwsh_path(false),
                "PowerShell 7 is not installed or is not on PATH.",
            ),
            (
                "pwsh-preview",
                pwsh_path(true),
                "PowerShell Preview is not installed.",
            ),
            (
                "powershell",
                find_command("powershell.exe"),
                "Windows PowerShell is not available.",
            ),
            (
                "cmd",
                find_command("cmd.exe"),
                "Command Prompt is not available.",
            ),
            ("git-bash", git_bash_path(), "Git Bash is not installed."),
            (
                "wsl",
                find_command("wsl.exe"),
                "Windows Subsystem for Linux is not installed.",
            ),
            (
                "nu",
                nu_path(),
                "NuShell is not installed or is not on PATH.",
            ),
        ];
        let mut found = vec![ShellAvailability {
            profile: "auto",
            available: true,
            reason: None,
            setup: false,
        }];
        found.extend(candidates.into_iter().map(|(profile, path, reason)| {
            let available = path.is_some();
            ShellAvailability {
                profile,
                available,
                reason: if available { None } else { Some(reason) },
                setup: false,
            }
        }));
        // Claude Code is never reported unavailable. A machine without it opens
        // the pane anyway and gets the setup walkthrough, because "unavailable"
        // is a dead end for the one profile where the way out is three
        // keystrokes inside the pane itself.
        let installed = claude_path().is_some();
        found.push(ShellAvailability {
            profile: "claude",
            available: true,
            reason: (!installed)
                .then_some("Not installed yet — opening it walks you through installing and signing in."),
            setup: !installed,
        });
        found
    })
    .await
    .unwrap_or_default()
}

/// Starting a shell means `CreateProcess` plus a pseudoconsole handshake, which
/// is far too slow to run on the thread that draws the window.
#[tauri::command]
pub async fn term_open(app: AppHandle, args: OpenArgs) -> Result<TermInfo, String> {
    tauri::async_runtime::spawn_blocking(move || term_open_sync(app, args))
        .await
        .unwrap_or_else(|_| Err("The shell could not be started.".into()))
}

fn term_open_sync(app: AppHandle, args: OpenArgs) -> Result<TermInfo, String> {
    let dir = PathBuf::from(&args.project_path);
    if !dir.is_dir() {
        return Err("Folder no longer exists.".into());
    }
    let cols = args.cols.unwrap_or(80).clamp(20, 500);
    let rows = args.rows.unwrap_or(24).clamp(5, 200);

    // What this terminal was, before there is a shell to say otherwise. The
    // kept stream is fed back through the parser first, so the screen and the
    // scrollback are the ones the last shell left - not a redrawing of them -
    // and the new shell starts underneath.
    let history_key = args.history_key.filter(|key| history_paths(key).is_some());
    let mut grid = match &history_key {
        Some(key) => replay_history(key, cols, rows),
        None => Grid::new(cols, rows),
    };

    let id = next_id();
    let compat = wt_compat_dir(&app)?;
    let inherited_path = std::env::var("PATH").unwrap_or_default();
    let app_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let environment = [
        ("WINT_TERM_ID", id.clone()),
        ("WINT_APP", app_exe.to_string_lossy().into_owned()),
        ("PATH", format!("{};{inherited_path}", compat.display())),
    ];
    let spawn =
        |cmd: &str| ConPty::spawn_with_env(cmd, &dir, cols as u16, rows as u16, &environment);
    let mut notice = None;
    let (pty, command) = match &args.command {
        Some(cmd) => {
            let (resolved, said) = resolve_pane_command(cmd);
            notice = said;
            (spawn(&resolved)?, resolved)
        }
        None => match args.shell.as_deref().unwrap_or("auto") {
            "auto" => spawn_shell_with(&spawn)?,
            profile => {
                let shell = shell_command(profile)?;
                (spawn(&shell)?, shell)
            }
        },
    };

    // Said in the pane itself, above the shell's first prompt, because that is
    // where whoever reads the output is looking. It is part of the terminal's
    // stream from then on and scrolls away with everything else.
    if let Some(text) = notice {
        grid.feed(format!("\u{1b}[33mWinT: {text}\u{1b}[0m\r\n").as_bytes());
    }

    let (jobs, inbox) = channel::<Job>();
    let log = history_key
        .as_deref()
        .and_then(|key| HistoryLog::open(key, cols, rows));
    let session = Arc::new(Session {
        id: id.clone(),
        jobs,
        project_path: args.project_path.clone(),
        project_name: args.project_name.unwrap_or_else(|| {
            dir.file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        }),
        pid: pty.pid(),
        pty: Mutex::new(pty),
        grid: Mutex::new(grid),
        alive: AtomicBool::new(true),
        command,
        log: Mutex::new(log),
        history_key,
        served: Mutex::new(None),
    });
    registry()
        .lock()
        .unwrap()
        .insert(id.clone(), session.clone());

    spawn_writer(Arc::downgrade(&session), inbox);
    spawn_reader(app, session.clone());
    Ok(session.info())
}

/// Tries each candidate shell until one starts.
fn spawn_shell_with<F>(spawn: &F) -> Result<(ConPty, String), String>
where
    F: Fn(&str) -> Result<ConPty, String>,
{
    let mut last = String::from("No shell available.");
    for shell in SHELLS {
        match spawn(shell) {
            Ok(pty) => return Ok((pty, (*shell).to_string())),
            Err(e) => last = e,
        }
    }
    Err(last)
}

// ---- kept history ------------------------------------------------------
//
// A terminal that comes back after a restart shows the scrollback it had, and
// it is the same scrollback rather than a copy of one: the bytes the shell
// wrote are kept, and on open they are fed back through the parser that drew
// them the first time. Nothing is rebuilt out of a picture of the screen, so
// nothing in the restored history can be subtly different from what was really
// there - the colours, the columns and the wrapping are not reproduced, they
// are simply produced again.
//
// `cargo run --example term_replay` reads the same pair of files.

/// What a trim leaves behind. The front is cut at a mark, so what is left is
/// still a stream that reads from its first byte.
const HISTORY_KEEP_BYTES: u64 = 4 * 1024 * 1024;
/// When a trim runs. Trimming rewrites the file, so it is worth doing rarely:
/// a stream is allowed half as much again before it is cut back to the size
/// above, rather than being rewritten on every chunk past the line.
const HISTORY_COMPACT_AT: u64 = HISTORY_KEEP_BYTES + HISTORY_KEEP_BYTES / 2;
/// How often a mark is laid down. Small enough that a trim loses little, large
/// enough that the sidecar stays a handful of lines.
const HISTORY_MARK_EVERY: u64 = 64 * 1024;

/// Where the streams live. `WINT_TERM_LOG` moves them, which is how a session
/// can be recorded somewhere a bug report can pick it up.
fn history_dir() -> Option<PathBuf> {
    let dir = match std::env::var_os("WINT_TERM_LOG") {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
            .join("WinT")
            .join("sessions"),
    };
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// A key names one terminal across runs. It comes from the window, so it is
/// checked rather than trusted - it becomes a file name.
fn history_paths(key: &str) -> Option<(PathBuf, PathBuf)> {
    if key.is_empty()
        || key.len() > 64
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    let dir = history_dir()?;
    Some((
        dir.join(format!("{key}.bin")),
        dir.join(format!("{key}.meta")),
    ))
}

/// The sidecar beside a stream: the size it starts at, then one line per
/// resize and one per mark, each stamped with how far into the
/// stream it sits.
struct Meta {
    cols: usize,
    rows: usize,
    resizes: Vec<(u64, usize, usize)>,
    marks: Vec<u64>,
}

fn read_meta(path: &Path) -> Meta {
    let mut meta = Meta {
        cols: 80,
        rows: 24,
        resizes: Vec::new(),
        marks: Vec::new(),
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return meta;
    };
    for (i, line) in text.lines().enumerate() {
        let mut parts = line.split_whitespace();
        match parts.next() {
            Some("resize") => {
                let at = parts.next().and_then(|v| v.parse().ok());
                let cols = parts.next().and_then(|v| v.parse().ok());
                let rows = parts.next().and_then(|v| v.parse().ok());
                if let (Some(at), Some(cols), Some(rows)) = (at, cols, rows) {
                    meta.resizes.push((at, cols, rows));
                }
            }
            Some("mark") => {
                if let Some(at) = parts.next().and_then(|v| v.parse().ok()) {
                    meta.marks.push(at);
                }
            }
            Some(first) if i == 0 => {
                if let (Ok(cols), Some(Ok(rows))) = (first.parse(), parts.next().map(str::parse)) {
                    meta.cols = cols;
                    meta.rows = rows;
                }
            }
            _ => {}
        }
    }
    meta
}

fn write_meta(path: &Path, meta: &Meta) {
    let mut out = format!("{} {}\n", meta.cols, meta.rows);
    for (at, cols, rows) in &meta.resizes {
        out.push_str(&format!("resize {at} {cols} {rows}\n"));
    }
    for at in &meta.marks {
        out.push_str(&format!("mark {at}\n"));
    }
    let _ = std::fs::write(path, out);
}

/// The size in force at a point in the stream.
fn size_at(meta: &Meta, at: u64) -> (usize, usize) {
    let mut size = (meta.cols, meta.rows);
    for &(offset, cols, rows) in &meta.resizes {
        if offset <= at {
            size = (cols, rows);
        }
    }
    size
}

/// One terminal's stream, open for appending.
struct HistoryLog {
    bin: PathBuf,
    meta_path: PathBuf,
    file: std::fs::File,
    written: u64,
    marks: Vec<u64>,
    since_mark: u64,
}

impl HistoryLog {
    /// Opens the stream for this key, trimming it first if the last run left it
    /// over the cap, and noting the size this run opens at.
    fn open(key: &str, cols: usize, rows: usize) -> Option<HistoryLog> {
        let (bin, meta_path) = history_paths(key)?;
        let mut meta = read_meta(&meta_path);
        let log = HistoryLog {
            written: std::fs::metadata(&bin).map(|m| m.len()).unwrap_or(0),
            marks: std::mem::take(&mut meta.marks),
            since_mark: 0,
            file: std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&bin)
                .ok()?,
            bin,
            meta_path,
        };
        if log.written == 0 {
            write_meta(
                &log.meta_path,
                &Meta {
                    cols,
                    rows,
                    resizes: Vec::new(),
                    marks: Vec::new(),
                },
            );
        } else {
            // The stream continues at whatever size this window is now, and a
            // resize never appears in the bytes themselves.
            meta.resizes.push((log.written, cols, rows));
            meta.marks = log.marks.clone();
            write_meta(&log.meta_path, &meta);
        }
        Some(log)
    }

    /// Appends what the pseudoconsole just said. `settled` is the parser saying
    /// it holds nothing half-read and the cursor is at the start of a line -
    /// the only kind of place a stream may later be cut.
    fn append(&mut self, bytes: &[u8], settled: bool) {
        use std::io::Write;
        if self.file.write_all(bytes).is_err() {
            return;
        }
        let _ = self.file.flush();
        self.written += bytes.len() as u64;
        self.since_mark += bytes.len() as u64;
        if settled && self.since_mark >= HISTORY_MARK_EVERY {
            self.marks.push(self.written);
            self.since_mark = 0;
            if let Ok(mut meta) = std::fs::OpenOptions::new()
                .append(true)
                .open(&self.meta_path)
            {
                let _ = writeln!(meta, "mark {}", self.written);
            }
        }
        if self.written > HISTORY_COMPACT_AT {
            self.compact();
        }
    }

    fn note_resize(&mut self, cols: usize, rows: usize) {
        use std::io::Write;
        if let Ok(mut meta) = std::fs::OpenOptions::new()
            .append(true)
            .open(&self.meta_path)
        {
            let _ = writeln!(meta, "resize {} {cols} {rows}", self.written);
        }
    }

    /// Drops the front of a stream that has outgrown the cap, cutting at a mark
    /// so what is left still parses from its first byte.
    fn compact(&mut self) {
        let mut meta = read_meta(&self.meta_path);
        let Some(&cut) = self
            .marks
            .iter()
            .find(|&&at| self.written - at <= HISTORY_KEEP_BYTES)
        else {
            return;
        };
        if cut == 0 {
            return;
        }
        let Ok(bytes) = std::fs::read(&self.bin) else {
            return;
        };
        let cut = cut.min(bytes.len() as u64);
        if std::fs::write(&self.bin, &bytes[cut as usize..]).is_err() {
            return;
        }
        let (cols, rows) = size_at(&meta, cut);
        meta.cols = cols;
        meta.rows = rows;
        meta.resizes.retain(|(at, _, _)| *at > cut);
        for entry in &mut meta.resizes {
            entry.0 -= cut;
        }
        self.marks.retain(|at| *at > cut);
        for at in &mut self.marks {
            *at -= cut;
        }
        meta.marks = self.marks.clone();
        write_meta(&self.meta_path, &meta);
        self.written -= cut;
        if let Ok(file) = std::fs::OpenOptions::new().append(true).open(&self.bin) {
            self.file = file;
        }
    }
}

/// Rebuilds a terminal from its kept stream: the bytes go through the parser
/// exactly as they did when the shell wrote them, and what they leave on screen
/// is retired into the scrollback so the replacement shell starts underneath it
/// rather than over it.
fn replay_history(key: &str, cols: usize, rows: usize) -> Grid {
    let Some((bin, meta_path)) = history_paths(key) else {
        return Grid::new(cols, rows);
    };
    let Ok(bytes) = std::fs::read(&bin) else {
        return Grid::new(cols, rows);
    };
    if bytes.is_empty() {
        return Grid::new(cols, rows);
    }
    let meta = read_meta(&meta_path);
    let mut grid = Grid::new(meta.cols, meta.rows);
    let mut at = 0usize;
    for (offset, c, r) in meta.resizes {
        let offset = (offset as usize).min(bytes.len());
        if offset > at {
            grid.feed(&bytes[at..offset]);
            at = offset;
        }
        grid.resize(c, r);
    }
    grid.feed(&bytes[at..]);
    // Everything the old shell left on screen is finished output. Its own
    // standing prompt is not: the new shell prints one for itself.
    grid.retire_screen(if grid.alt { usize::MAX } else { grid.cy });
    grid.resize(cols, rows);
    // Nobody is attached yet; the first view is handed the whole screen.
    grid.take_dirty();
    grid.take_scrolled();
    grid
}

/// Forgets a terminal's stream. Closing a terminal is the one thing that means
/// its history is over.
fn forget_history(key: &str) {
    if let Some((bin, meta)) = history_paths(key) {
        let _ = std::fs::remove_file(bin);
        let _ = std::fs::remove_file(meta);
    }
}

/// The writer thread: everything the window asks of the pseudoconsole, done in
/// the order it was asked and never on the window's own thread.
///
/// The session is held weakly on purpose. The sender lives in the session, so
/// the last thing to release the session closes the channel, `recv` fails and
/// this thread ends - holding it strongly would keep both alive forever.
fn spawn_writer(session: Weak<Session>, inbox: Receiver<Job>) {
    std::thread::spawn(move || {
        while let Ok(job) = inbox.recv() {
            let Some(session) = session.upgrade() else {
                break;
            };
            match job {
                Job::Write(bytes) => {
                    let _ = session.pty.lock().unwrap().write(&bytes);
                }
                Job::Resize(cols, rows, ack) => {
                    // Window drags can enqueue several ResizePseudoConsole
                    // calls, each of which may block on ConPTY's pump. Do not
                    // make keyboard input wait behind obsolete sizes: drain
                    // the queue, write any pending input immediately, and
                    // apply only the newest requested dimensions.
                    let mut latest = (cols, rows);
                    let mut acks = vec![ack];
                    while let Ok(next) = inbox.try_recv() {
                        match next {
                            Job::Write(bytes) => {
                                let _ = session.pty.lock().unwrap().write(&bytes);
                            }
                            Job::Resize(cols, rows, ack) => {
                                latest = (cols, rows);
                                acks.push(ack);
                            }
                        }
                    }
                    let (cols, rows) = latest;
                    if let Some(log) = session.log.lock().unwrap().as_mut() {
                        log.note_resize(cols, rows);
                    }
                    session.grid.lock().unwrap().resize(cols, rows);
                    let _ = session.pty.lock().unwrap().resize(cols as u16, rows as u16);
                    for ack in acks {
                        let _ = ack.send(());
                    }
                }
            }
        }
    });
}

/// The reader thread: block on the pseudoconsole, feed the screen, ship the
/// rows that changed. Blocking on `ReadFile` is itself the coalescing — ConPTY
/// hands us one batched repaint per flush rather than a byte at a time.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Serving {
    pub id: String,
    pub url: String,
}

/// The printable text of one screen row, with the marker that holds the second
/// half of a double-width glyph dropped.
fn row_text(cells: &[Cell]) -> String {
    cells.iter().map(|cell| cell.ch).filter(|&ch| ch != CONT).collect()
}

/// The first `http://localhost:port` or `http://127.0.0.1:port` in a line of
/// terminal text, which is how every dev server worth pointing a browser at
/// says it has started.
///
/// This reads the *screen*, not the byte stream. ConPTY does not forward what
/// the program wrote - it repaints, and it is free to break a line into
/// separate writes with cursor moves and colour changes in between, which is
/// exactly what a dev server's boxed, coloured, right-aligned banner provokes.
/// The row is where the address is reliably one contiguous run of characters,
/// and it is the same place the terminal itself finds links to underline.
///
/// Deliberately narrow. Matching any URL would have the browser panel chasing
/// documentation links and npm advisories printed during a build; matching
/// loopback with a port is the one case where the terminal is saying "there is
/// something to look at here, now".
fn scan_local_url(text: &str) -> Option<String> {
    // The earliest address in the chunk wins. A dev server that prints both a
    // local and a network address prints the local one first, which is the one
    // a browser on this machine should be pointed at.
    let mut best: Option<(usize, String)> = None;
    for host in ["http://localhost:", "http://127.0.0.1:"] {
        let mut from = 0;
        // Every index here is derived from an ASCII match, but the byte after
        // one is not necessarily a character boundary and can be past the end
        // of the string - and either would panic this thread, taking the
        // terminal's output with it.
        while from < text.len() {
            let Some(at) = text[from..].find(host) else { break };
            let start = from + at;
            let rest = &text[start + host.len()..];
            let port: String = rest.chars().take_while(char::is_ascii_digit).collect();
            from = (start + host.len() + port.len().max(1)).min(text.len());
            while from < text.len() && !text.is_char_boundary(from) {
                from += 1;
            }
            if port.is_empty() || port.len() > 5 {
                continue;
            }
            // Whatever follows the port up to whitespace is the path. A dev
            // server that prints a trailing slash means it, and one that prints
            // `/admin` means that.
            let tail: String = rest[port.len()..]
                .chars()
                .take_while(|c| !c.is_whitespace() && !matches!(c, '"' | '\'' | '\u{1b}' | ','))
                .collect();
            let found = format!("{host}{port}{tail}");
            if best.as_ref().map_or(true, |(seen, _)| start < *seen) {
                best = Some((start, found));
            }
        }
    }
    best.map(|(_, url)| url)
}

fn spawn_reader(app: AppHandle, session: Arc<Session>) {
    let handle = session.pty.lock().unwrap().output();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            let Some(n) = conpty::read_chunk(handle, &mut buf) else {
                break;
            };
            // Where the parser stands after this chunk is what says whether the
            // stream may later be cut here, so the bytes are kept alongside the
            // feed rather than before it.
            let (update, settled, reply, serving) = {
                let mut grid = session.grid.lock().unwrap();
                grid.feed(&buf[..n]);
                let settled = grid.at_ground() && grid.cx == 0 && !grid.alt;
                let reply = grid.take_reply();
                let clear_history = grid.take_clear_history();
                let scrolled = grid.take_scrolled().iter().map(|l| pack(l)).collect();
                // The rows that changed are scanned for a dev server's address
                // on the way past. They are already in hand and already the
                // right shape - one contiguous line of characters, whatever the
                // pseudoconsole did to the bytes that produced them.
                let touched = grid.take_dirty();
                let serving = touched
                    .iter()
                    .find_map(|&y| scan_local_url(&row_text(grid.row(y))));
                let rows = touched
                    .into_iter()
                    .map(|y| RowUpdate {
                        y,
                        runs: pack(grid.row(y)),
                    })
                    .collect();
                (
                    Update {
                        id: session.id.clone(),
                        rows,
                        scrolled,
                        clear_history,
                        cx: grid.cx,
                        cy: grid.cy,
                        cursor_visible: grid.cursor_visible,
                        cursor_style: grid.effective_cursor_style(),
                        cursor_char: cursor_char(&grid),
                        alt: grid.alt,
                        title: grid.title.clone(),
                    },
                    settled,
                    reply,
                    serving,
                )
            };
            if !reply.is_empty() {
                let _ = session.jobs.send(Job::Write(reply));
            }
            if let Some(log) = session.log.lock().unwrap().as_mut() {
                log.append(&buf[..n], settled);
            }
            // A dev server announcing itself is the one line of terminal output
            // the rest of the app acts on.
            if let Some(url) = serving {
                // The lock is taken and released on its own line on purpose. A
                // temporary guard in an `if` condition lives to the end of the
                // whole `if` - which would hold this mutex across the emit
                // below, where anything asking what this terminal serves waits
                // on it. That is the main thread, and that is the window.
                let announced = {
                    let mut served = session.served.lock().unwrap();
                    let changed = served.as_deref() != Some(url.as_str());
                    if changed {
                        *served = Some(url.clone());
                    }
                    changed
                };
                if announced {
                    let _ = app.emit(
                        "term:serving",
                        Serving {
                            id: session.id.clone(),
                            url,
                        },
                    );
                }
            }
            let _ = app.emit("term:update", update);
        }
        session.alive.store(false, Ordering::Relaxed);
        let _ = app.emit("term:exit", session.info());
    });
}

/// Where this terminal last said it was serving, for a view that arrived after
/// it said so. Without this, opening a workspace on a project whose dev server is
/// already running would leave the browser panel blank until the next restart.
#[tauri::command]
pub async fn term_serving(id: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        lookup(&id)
            .ok()
            .and_then(|session| session.served.lock().unwrap().clone())
    })
    .await
    .unwrap_or_default()
}

/// Everything a fresh view needs to draw the session as it stands.
#[tauri::command]
pub async fn term_attach(id: String) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || term_attach_sync(id))
        .await
        .unwrap_or_else(|_| Err("The terminal snapshot could not be read.".into()))
}

fn term_attach_sync(id: String) -> Result<Snapshot, String> {
    let session = lookup(&id)?;
    // Taken before the grid is locked: `info` reads the title out of the grid
    // itself, and a std mutex is not reentrant.
    let info = session.info();
    let grid = session.grid.lock().unwrap();
    let history: Vec<Vec<Run>> = grid
        .scrollback
        .iter()
        .skip(grid.scrollback.len().saturating_sub(ATTACH_HISTORY))
        .map(|l| pack(l))
        .collect();
    let screen = (0..grid.rows)
        .map(|y| RowUpdate {
            y,
            runs: pack(grid.row(y)),
        })
        .collect();
    Ok(Snapshot {
        info,
        cols: grid.cols,
        rows: grid.rows,
        history,
        screen,
        cx: grid.cx,
        cy: grid.cy,
        cursor_visible: grid.cursor_visible,
        cursor_style: grid.effective_cursor_style(),
        cursor_char: cursor_char(&grid),
        alt: grid.alt,
    })
}

/// A keystroke, posted to the session's queue.
///
/// This one stays synchronous, and that is the point: the window thread is what
/// defines the order keystrokes were typed in, and handing them to a thread
/// pool would let two of them reach the shell the wrong way round. All it does
/// here is post to a queue - no lock the pseudoconsole holds, no write that can
/// block on a full pipe.
#[tauri::command]
pub fn term_write(id: String, data: String) -> Result<(), String> {
    let session = lookup(&id)?;
    if !session.alive.load(Ordering::Relaxed) {
        return Ok(());
    }
    session
        .jobs
        .send(Job::Write(data.into_bytes()))
        .map_err(|_| "That terminal is gone.".to_string())
}

/// Resizes go through the same queue as the keystrokes, so a shell is never
/// told about a size in a different order than the window applied it. The
/// promise still resolves only once the grid really is that size - which is
/// what the front end repaints against - but the wait is on a pool thread.
#[tauri::command]
pub async fn term_resize(id: String, cols: usize, rows: usize) -> Result<(), String> {
    let session = lookup(&id)?;
    let cols = cols.clamp(20, 500);
    let rows = rows.clamp(5, 200);
    let (ack, done) = channel();
    session
        .jobs
        .send(Job::Resize(cols, rows, ack))
        .map_err(|_| "That terminal is gone.".to_string())?;
    let _ = tauri::async_runtime::spawn_blocking(move || done.recv()).await;
    Ok(())
}

/// Tearing a pseudoconsole down blocks until the console's own pump lets go, so
/// this never runs on the window thread. `term_close_snapshot` already calls
/// the inner form from a pool thread; the command is the direct route.
#[tauri::command]
pub async fn term_close(id: String) -> Result<(), String> {
    off_thread(move || term_close_now(id)).await;
    Ok(())
}

pub fn term_close_now(id: String) -> Result<(), String> {
    if let Some(session) = registry().lock().unwrap().remove(&id) {
        session.alive.store(false, Ordering::Relaxed);
        // Closing a terminal is the one thing that means its history is over.
        // Quitting is not: that is what the streams are kept for.
        *session.log.lock().unwrap() = None;
        if let Some(key) = &session.history_key {
            forget_history(key);
        }
        session.pty.lock().unwrap().close();
    }
    Ok(())
}

/// Drops the streams of terminals nobody is going to open again - a terminal
/// closed while the app was not running, or one lost to a crash. The window
/// sends the keys it still knows about as it restores them.
#[tauri::command]
pub async fn term_prune_history(keys: Vec<String>) {
    off_thread(move || {
        let Some(dir) = history_dir() else { return };
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let keep = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .is_some_and(|stem| keys.iter().any(|key| key == stem));
            if !keep
                && matches!(
                    path.extension().and_then(|e| e.to_str()),
                    Some("bin") | Some("meta")
                )
            {
                let _ = std::fs::remove_file(path);
            }
        }
    })
    .await;
}

/// Sessions for one project, or every session when `project_path` is omitted.
/// Every `info` reads a title out of a grid the reader thread is writing to,
/// so the list waits on those locks - off the window thread it goes.
#[tauri::command]
pub async fn term_list(project_path: Option<String>) -> Vec<TermInfo> {
    off_thread(move || term_list_now(project_path))
        .await
        .unwrap_or_default()
}

fn term_list_now(project_path: Option<String>) -> Vec<TermInfo> {
    let sessions: Vec<Arc<Session>> = registry().lock().unwrap().values().cloned().collect();
    let mut out: Vec<TermInfo> = sessions
        .iter()
        .filter(|s| match &project_path {
            Some(p) => crate::util::norm(&s.project_path) == crate::util::norm(p),
            None => true,
        })
        .map(|s| s.info())
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Opens a session in its own window. The session is untouched — this only
/// creates a second view, so a build keeps running while it moves.
/// Building a webview has to pump the event loop, so it cannot run on the
/// thread that owns it: from a synchronous command the window appears but its
/// webview never loads, leaving a black frame — and the front end never gets
/// its reply either. Hence `async` plus [`off_thread`].
#[tauri::command]
pub async fn term_popout(
    app: AppHandle,
    id: String,
    x: Option<f64>,
    y: Option<f64>,
    position: Option<String>,
    dimensions: Option<String>,
    maximized: Option<bool>,
    fullscreen: Option<bool>,
    focus: Option<bool>,
) -> Result<(), String> {
    let session = lookup(&id)?;
    let label = format!("term-{id}");
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }
    let title = Path::new(session.project_path.trim_end_matches(['\\', '/']))
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| session.project_name.clone());
    off_thread(move || {
        let mut builder = WebviewWindowBuilder::new(
            &app,
            &label,
            WebviewUrl::App(format!("terminal.html?id={id}").into()),
        )
        .title(title)
        .inner_size(900.0, 600.0)
        .min_inner_size(400.0, 200.0)
        .decorations(false)
        .background_color(tauri::webview::Color(12, 13, 17, 255));
        let pair = |value: Option<String>| {
            value.and_then(|value| {
                let (a, b) = value.split_once(',')?;
                Some((a.trim().parse::<f64>().ok()?, b.trim().parse::<f64>().ok()?))
            })
        };
        if let Some((cols, rows)) = pair(dimensions) {
            builder = builder.inner_size((cols * 9.0).max(400.0), (rows * 18.0).max(200.0));
        }
        if let Some((px, py)) = pair(position) {
            builder = builder.position(px, py);
        } else if let (Some(x), Some(y)) = (x, y) {
            builder = builder.position(x, y);
        }
        builder
            .build()
            .and_then(|window| {
                if maximized.unwrap_or(false) {
                    window.maximize()?;
                }
                if fullscreen.unwrap_or(false) {
                    window.set_fullscreen(true)?;
                }
                if focus.unwrap_or(true) {
                    window.set_focus()?;
                }
                Ok(())
            })
            .map_err(|e| format!("Could not open the window: {e}"))
    })
    .await
    .unwrap_or_else(|| Err("Could not open the window.".to_string()))
}

/// A small native drag image used once a dock tab leaves the main webview.
/// Unlike an HTML element it can remain visible over the Windows desktop.
#[tauri::command]
pub async fn term_drag_preview(
    app: AppHandle,
    action: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    off_thread(move || {
        const LABEL: &str = "term-drag-preview";
        if action == "close" {
            if let Some(window) = app.get_webview_window(LABEL) {
                let _ = window.destroy();
            }
            return Ok(());
        }
        if let Some(window) = app.get_webview_window(LABEL) {
            return window
                .set_position(LogicalPosition::new(x, y))
                .map_err(|e| e.to_string());
        }
        if action == "move" {
            return Ok(());
        }
        WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("terminal-drag.html".into()))
            .inner_size(245.0, 38.0)
            .position(x, y)
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .shadow(true)
            .build()
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|| Err("Could not show the terminal drag preview.".to_string()))
}

/// Closes the popped-out window for a session, used when it docks back in.
///
/// `destroy` rather than `close`: closing only *asks*, and the window answers a
/// close request by announcing a dock - which lands right back here. The panel
/// already holds the session by this point, so the window is simply gone.
#[tauri::command]
pub async fn term_dock(app: AppHandle, id: String) -> Result<(), String> {
    off_thread(move || {
        if let Some(win) = app.get_webview_window(&format!("term-{id}")) {
            let _ = win.destroy();
        }
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
        }
    })
    .await;
    Ok(())
}

/// Kills every session. Called as the app exits so no orphaned shell outlives
/// the window that owned it.
pub fn shutdown() {
    let sessions: Vec<_> = registry()
        .lock()
        .unwrap()
        .drain()
        .map(|(_, session)| session)
        .collect();
    for session in &sessions {
        session.alive.store(false, Ordering::Relaxed);
        session.pty.lock().unwrap().terminate_child();
    }
    std::thread::spawn(move || {
        for session in sessions {
            session.pty.lock().unwrap().close();
        }
    });
}


#[cfg(test)]
mod serving_tests {
    use super::{row_text, scan_local_url};
    use crate::vt::Grid;

    /// The address as the screen holds it, which is the only place it is
    /// reliably one piece: this is a dev server's banner as it arrives -
    /// coloured, underlined, and with the line split by the pseudoconsole
    /// between the label and the address.
    fn screen_line(stream: &[u8]) -> String {
        let mut grid = Grid::new(80, 4);
        grid.feed(stream);
        (0..grid.rows)
            .map(|y| row_text(grid.row(y)))
            .find(|line| line.contains("http"))
            .unwrap_or_default()
    }

    #[test]
    fn finds_the_address_a_dev_server_prints() {
        let line = screen_line(
            b"  \x1b[32m-\x1b[0m \x1b[1mLocal\x1b[0m:    \x1b[36m\x1b[4mhttp://localhost:41823/\x1b[0m\r\n",
        );
        assert_eq!(
            scan_local_url(&line).as_deref(),
            Some("http://localhost:41823/")
        );
    }

    /// The case the byte stream could not handle: the pseudoconsole repaints a
    /// line in pieces, moving the cursor between them. On the screen it is one
    /// line either way.
    #[test]
    fn finds_one_the_pseudoconsole_painted_in_pieces() {
        let line = screen_line(b"  - Local:\r\n\x1b[1A\x1b[13Ghttp://localhost:5173/\r\n");
        assert_eq!(
            scan_local_url(&line).as_deref(),
            Some("http://localhost:5173/")
        );
    }

    #[test]
    fn finds_loopback_by_number_too() {
        assert_eq!(
            scan_local_url("  Listening on http://127.0.0.1:8080/admin now").as_deref(),
            Some("http://127.0.0.1:8080/admin")
        );
    }

    /// A row is space-padded to the full width, so the address must not eat the
    /// padding after it.
    #[test]
    fn stops_at_the_padding_a_row_carries() {
        let line = screen_line(b"http://localhost:3000/\r\n");
        assert_eq!(line.len(), 80);
        assert_eq!(scan_local_url(&line).as_deref(), Some("http://localhost:3000/"));
    }

    #[test]
    fn ignores_what_is_not_a_local_server() {
        assert_eq!(scan_local_url("see http://localhost/docs"), None);
        assert_eq!(scan_local_url("read https://docs.example.com/x"), None);
        assert_eq!(scan_local_url("open http://localhost:"), None);
    }

    /// The row is arbitrary text, so the scan must not assume where a character
    /// begins or that anything follows the port.
    #[test]
    fn survives_odd_bytes_after_the_port() {
        assert_eq!(scan_local_url("http://localhost:\u{2713}"), None);
        assert_eq!(
            scan_local_url("http://localhost:8080/\u{2713}").as_deref(),
            Some("http://localhost:8080/\u{2713}")
        );
    }
}
