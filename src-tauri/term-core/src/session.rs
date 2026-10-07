//! Terminal sessions: the pseudoconsole, the child process and the screen,
//! keyed by id.
//!
//! Whatever draws a session is only ever a view onto it, told what changed
//! through the [`Sink`] the session was opened with. That is what makes
//! popping a terminal out of a window cheap - the new view calls [`attach`] and
//! is handed the current screen, while the shell underneath never notices it
//! changed frames - and it is what lets the same session code serve WinT and
//! the VS Code panel alike.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use serde::{Deserialize, Serialize};

use crate::conpty::{self, ConPty};
use crate::history::{self, HistoryLog};
use crate::scan::{row_text, scan_local_url, scan_port_conflict};
use crate::shell;
use crate::vt::{char_width, Cell, Grid, CONT, DEFAULT_COLOR};

/// How much history an attaching view is handed. The session keeps more than
/// this; the rest is simply older than anyone scrolls back to on open.
const ATTACH_HISTORY: usize = 1000;

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
    /// The port a program in this terminal last said it could not have, so the
    /// same complaint repainted on the screen is only acted on once.
    port_taken: Mutex<Option<u16>>,
}

fn registry() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("t{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

fn lookup(id: &str) -> Result<Arc<Session>, String> {
    registry()
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| "That terminal is gone.".to_string())
}

pub fn pid(id: &str) -> Result<u32, String> {
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
    /// Where the shell says it is now, when it says so at all — the folder a
    /// `cd` moved to, not the one the terminal opened in. Empty otherwise.
    pub cwd: String,
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
    bracketed_paste: bool,
    mouse_mode: u16,
    mouse_sgr: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Update {
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
    bracketed_paste: bool,
    mouse_mode: u16,
    mouse_sgr: bool,
    title: String,
    /// The shell's folder, so a window title can follow a `cd`.
    cwd: String,
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

impl Session {
    fn info(&self) -> TermInfo {
        let (title, cwd) = {
            let grid = self.grid.lock().unwrap();
            (grid.title.clone(), grid.cwd.clone())
        };
        TermInfo {
            id: self.id.clone(),
            project_path: self.project_path.clone(),
            project_name: self.project_name.clone(),
            title,
            cwd,
            pid: self.pid,
            // A child that has exited without the reader noticing yet still
            // reads as dead, so a stale tab cannot look live.
            alive: self.alive.load(Ordering::Relaxed) && !self.pty.lock().unwrap().exited(),
            command: self.command.clone(),
        }
    }
}

// ---- events --------------------------------------------------------------

/// Where a program in this terminal said it is serving.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Serving {
    pub id: String,
    pub url: String,
}

/// A program in this terminal saying the port it wanted was taken. `fallback`
/// is the port it settled for, when it names one.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortTaken {
    pub id: String,
    pub port: u16,
    pub fallback: Option<u16>,
}

/// Something a view has to hear about. Each is sent under the name a view
/// listens for, which [`Event::name`] gives.
pub enum Event {
    /// Rows changed, the cursor moved, history scrolled.
    Update(Update),
    /// The shell is gone; the view keeps showing what it left.
    Exit(TermInfo),
    /// A dev server said where it is.
    Serving(Serving),
    /// A program could not have the port it asked for.
    PortTaken(PortTaken),
}

impl Event {
    pub fn name(&self) -> &'static str {
        match self {
            Event::Update(_) => "term:update",
            Event::Exit(_) => "term:exit",
            Event::Serving(_) => "term:serving",
            Event::PortTaken(_) => "term:port-taken",
        }
    }
}

/// Where a session's events go. Called on the session's reader thread, so it
/// must hand the event on and return - never wait on anything a view holds.
pub type Sink = Arc<dyn Fn(Event) + Send + Sync>;

/// What the program hosting the session adds to every shell it starts, on top
/// of what the session itself always sets.
#[derive(Default)]
pub struct Launch {
    /// Extra environment for the shell.
    pub env: Vec<(String, String)>,
    /// A folder put in front of the shell's PATH.
    pub path_prefix: Option<PathBuf>,
    /// The variable the session's own id is published to the shell under, if
    /// the host has something in the shell that wants to find its way back.
    pub id_variable: Option<&'static str>,
}

// ---- opening -------------------------------------------------------------

/// Starts a shell. `CreateProcess` plus a pseudoconsole handshake - far too
/// slow for a thread that draws anything.
pub fn open(args: OpenArgs, launch: Launch, sink: Sink) -> Result<TermInfo, String> {
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
    let history_key = args
        .history_key
        .filter(|key| history::history_paths(key).is_some());
    let mut grid = match &history_key {
        Some(key) => history::replay_history(key, cols, rows),
        None => Grid::new(cols, rows),
    };

    let id = next_id();
    let mut environment: Vec<(String, String)> = Vec::new();
    if let Some(name) = launch.id_variable {
        environment.push((name.to_string(), id.clone()));
    }
    environment.extend(launch.env);
    if let Some(prefix) = &launch.path_prefix {
        let inherited = std::env::var("PATH").unwrap_or_default();
        environment.push(("PATH".into(), format!("{};{inherited}", prefix.display())));
    }
    // Harmless to a shell that does not read them, so every session gets both
    // rather than the launch guessing which shell it is about to become.
    environment.extend(
        shell::cwd_reporting_env()
            .into_iter()
            .map(|(name, value)| (name.to_string(), value)),
    );
    let environment: Vec<(&str, String)> = environment
        .iter()
        .map(|(name, value)| (name.as_str(), value.clone()))
        .collect();
    let spawn =
        |cmd: &str| ConPty::spawn_with_env(cmd, &dir, cols as u16, rows as u16, &environment);
    let mut notice = None;
    let (pty, command) = match &args.command {
        Some(cmd) => {
            let (resolved, said) = shell::resolve_pane_command(cmd);
            notice = said;
            (spawn(&resolved)?, resolved)
        }
        None => match args.shell.as_deref().unwrap_or("auto") {
            "auto" => spawn_shell_with(&spawn)?,
            profile => {
                let shell = shell::shell_command(profile)?;
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
        port_taken: Mutex::new(None),
    });
    registry()
        .lock()
        .unwrap()
        .insert(id.clone(), session.clone());

    spawn_writer(Arc::downgrade(&session), inbox);
    spawn_reader(sink, session.clone());
    Ok(session.info())
}

/// Tries each candidate shell until one starts.
fn spawn_shell_with<F>(spawn: &F) -> Result<(ConPty, String), String>
where
    F: Fn(&str) -> Result<ConPty, String>,
{
    let mut last = String::from("No shell available.");
    for candidate in shell::SHELLS {
        let candidate = &shell::pwsh_interactive(candidate);
        match spawn(candidate) {
            Ok(pty) => return Ok((pty, (*candidate).to_string())),
            Err(e) => last = e,
        }
    }
    Err(last)
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

fn spawn_reader(sink: Sink, session: Arc<Session>) {
    let handle = session.pty.lock().unwrap().output();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        while let Some(n) = conpty::read_chunk(handle, &mut buf) {
            // Where the parser stands after this chunk is what says whether the
            // stream may later be cut here, so the bytes are kept alongside the
            // feed rather than before it.
            let (update, settled, reply, serving, taken) = {
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
                let taken = touched
                    .iter()
                    .find_map(|&y| scan_port_conflict(&row_text(grid.row(y))));
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
                        bracketed_paste: grid.bracketed_paste,
                        mouse_mode: grid.mouse_mode,
                        mouse_sgr: grid.mouse_sgr,
                        title: grid.title.clone(),
                        cwd: grid.cwd.clone(),
                    },
                    settled,
                    reply,
                    serving,
                    taken,
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
                // whole `if` - which would hold this mutex across the sink
                // below, where anything asking what this terminal serves waits
                // on it. In WinT that is the main thread, and that is the window.
                let announced = {
                    let mut served = session.served.lock().unwrap();
                    let changed = served.as_deref() != Some(url.as_str());
                    if changed {
                        *served = Some(url.clone());
                    }
                    changed
                };
                if announced {
                    sink(Event::Serving(Serving {
                        id: session.id.clone(),
                        url,
                    }));
                }
            }
            // A port a program could not have is the other line worth acting
            // on: the window offers to free it. Announced once per port, for
            // the same reason an address is - the sentence is repainted every
            // time the screen scrolls past it.
            if let Some((port, fallback)) = taken {
                let announced = {
                    let mut last = session.port_taken.lock().unwrap();
                    let changed = *last != Some(port);
                    if changed {
                        *last = Some(port);
                    }
                    changed
                };
                if announced {
                    sink(Event::PortTaken(PortTaken {
                        id: session.id.clone(),
                        port,
                        fallback,
                    }));
                }
            }
            sink(Event::Update(update));
        }
        session.alive.store(false, Ordering::Relaxed);
        sink(Event::Exit(session.info()));
    });
}

// ---- what a view asks of a session ---------------------------------------

/// Where this terminal last said it was serving, for a view that arrived after
/// it said so.
pub fn serving(id: &str) -> Option<String> {
    lookup(id)
        .ok()
        .and_then(|session| session.served.lock().unwrap().clone())
}

/// What one session is and where it stands.
pub fn info(id: &str) -> Result<TermInfo, String> {
    Ok(lookup(id)?.info())
}

/// Everything a fresh view needs to draw the session as it stands.
pub fn attach(id: &str) -> Result<Snapshot, String> {
    let session = lookup(id)?;
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
        bracketed_paste: grid.bracketed_paste,
        mouse_mode: grid.mouse_mode,
        mouse_sgr: grid.mouse_sgr,
    })
}

/// A keystroke, posted to the session's queue. Never blocks: no lock the
/// pseudoconsole holds, no write that can wait on a full pipe. Whoever calls
/// it defines the order keystrokes reach the shell in, so it must be called in
/// the order they were typed.
pub fn write(id: &str, data: Vec<u8>) -> Result<(), String> {
    let session = lookup(id)?;
    if !session.alive.load(Ordering::Relaxed) {
        return Ok(());
    }
    session
        .jobs
        .send(Job::Write(data))
        .map_err(|_| "That terminal is gone.".to_string())
}

/// Resizes go through the same queue as the keystrokes, so a shell is never
/// told about a size in a different order than the view applied it. The
/// receiver hears once the grid really is that size - which is what a view
/// repaints against. Waiting on it blocks, so it is not done on a thread that
/// draws anything.
pub fn resize(id: &str, cols: usize, rows: usize) -> Result<Receiver<()>, String> {
    let session = lookup(id)?;
    let cols = cols.clamp(20, 500);
    let rows = rows.clamp(5, 200);
    let (ack, done) = channel();
    session
        .jobs
        .send(Job::Resize(cols, rows, ack))
        .map_err(|_| "That terminal is gone.".to_string())?;
    Ok(done)
}

/// Ends a session for good. Tearing a pseudoconsole down blocks until the
/// console's own pump lets go, so this is never called on a thread that draws.
pub fn close(id: &str) {
    if let Some(session) = registry().lock().unwrap().remove(id) {
        session.alive.store(false, Ordering::Relaxed);
        // Closing a terminal is the one thing that means its history is over.
        // Quitting is not: that is what the streams are kept for.
        *session.log.lock().unwrap() = None;
        if let Some(key) = &session.history_key {
            history::forget_history(key);
        }
        session.pty.lock().unwrap().close();
    }
}

/// Every session, oldest first. Every `info` reads a title out of a grid the
/// reader thread is writing to, so this waits on those locks.
pub fn list() -> Vec<TermInfo> {
    let sessions: Vec<Arc<Session>> = registry().lock().unwrap().values().cloned().collect();
    let mut out: Vec<TermInfo> = sessions.iter().map(|s| s.info()).collect();
    // `t9` before `t10`: the ids are a counter, so order by its number.
    out.sort_by_key(|info| info.id[1..].parse::<u64>().unwrap_or(u64::MAX));
    out
}

/// Kills every session. Called as the host exits so no orphaned shell outlives
/// it.
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
