//! A terminal that comes back after a restart shows the scrollback it had, and
//! it is the same scrollback rather than a copy of one: the bytes the shell
//! wrote are kept, and on open they are fed back through the parser that drew
//! them the first time. Nothing is rebuilt out of a picture of the screen, so
//! nothing in the restored history can be subtly different from what was really
//! there - the colours, the columns and the wrapping are not reproduced, they
//! are simply produced again.
//!
//! `cargo run --example term_replay` reads the same pair of files.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::vt::Grid;

/// What a trim leaves behind. The front is cut at a mark, so what is left is
/// still a stream that reads from its first byte.
const HISTORY_KEEP_BYTES: u64 = 4 * 1024 * 1024;
/// When a trim runs. Trimming rewrites the file, so it is worth doing rarely:
/// a stream is allowed half as much again before it is cut back to the size
/// above, rather than being rewritten on every chunk past the line.
pub(crate) const HISTORY_COMPACT_AT: u64 = HISTORY_KEEP_BYTES + HISTORY_KEEP_BYTES / 2;
/// How often a mark is laid down. Small enough that a trim loses little, large
/// enough that the sidecar stays a handful of lines.
const HISTORY_MARK_EVERY: u64 = 64 * 1024;

/// The folder under `%LOCALAPPDATA%\WinT` this program keeps its streams in,
/// when it is not WinT's own `sessions`.
static FOLDER: OnceLock<PathBuf> = OnceLock::new();

/// Gives this program a stream folder of its own. Each host prunes every
/// stream it does not know about, so two hosts sharing one folder would delete
/// each other's terminals.
pub fn set_folder(name: impl Into<PathBuf>) {
    let _ = FOLDER.set(name.into());
}

/// Where the streams live. `WINT_TERM_LOG` moves them, which is how a session
/// can be recorded somewhere a bug report can pick it up.
pub fn history_dir() -> Option<PathBuf> {
    let dir = match std::env::var_os("WINT_TERM_LOG") {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
            .join("WinT")
            .join(FOLDER.get().map_or(Path::new("sessions"), PathBuf::as_path)),
    };
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// A key names one terminal across runs. It comes from the window, so it is
/// checked rather than trusted - it becomes a file name.
pub fn history_paths(key: &str) -> Option<(PathBuf, PathBuf)> {
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
pub(crate) struct HistoryLog {
    bin: PathBuf,
    meta_path: PathBuf,
    file: std::fs::File,
    pub(crate) written: u64,
    marks: Vec<u64>,
    since_mark: u64,
}

impl HistoryLog {
    /// Opens the stream for this key, trimming it first if the last run left it
    /// over the cap, and noting the size this run opens at.
    pub(crate) fn open(key: &str, cols: usize, rows: usize) -> Option<HistoryLog> {
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
    pub(crate) fn append(&mut self, bytes: &[u8], settled: bool) {
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

    pub(crate) fn note_resize(&mut self, cols: usize, rows: usize) {
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
pub fn replay_history(key: &str, cols: usize, rows: usize) -> Grid {
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
pub(crate) fn forget_history(key: &str) {
    if let Some((bin, meta)) = history_paths(key) {
        let _ = std::fs::remove_file(bin);
        let _ = std::fs::remove_file(meta);
    }
}

/// Drops the streams of terminals nobody is going to open again - a terminal
/// closed while nothing was running, or one lost to a crash. `keys` are the
/// ones still wanted; everything else in the folder goes.
pub fn prune(keys: &[String]) {
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
}

#[cfg(test)]
mod tests {
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
