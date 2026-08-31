//! The `TODO` / `FIXME` notes left in a project's own source.
//!
//! This is a plain walk rather than `git grep`, because plenty of the folders
//! DevHQ lists are not repositories and the ones that are should not answer a
//! different question from the ones that are not.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// The words worth surfacing, in the order they are reported when a line has
/// more than one.
const MARKERS: &[&str] = &["FIXME", "TODO", "HACK", "XXX"];

/// Only files that are plausibly hand-written source. Anything else is either
/// generated, binary, or a lockfile nobody left a note in.
const EXTS: &[&str] = &[
    "rs", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "go", "java", "kt", "kts", "rb", "php",
    "cs", "c", "h", "cpp", "hpp", "cc", "m", "swift", "css", "scss", "sass", "less", "html", "vue",
    "svelte", "astro", "sql", "sh", "bash", "ps1", "psm1", "yml", "yaml", "toml", "md",
];

/// Folders never worth descending into. Deliberately its own list: the scanner
/// skips `bin` and `obj` because they are never *projects*, which says nothing
/// about whether a note could be left in one.
const SKIP: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "venv",
    ".venv",
    "__pycache__",
    "coverage",
    ".next",
    ".nuxt",
    ".cache",
    ".git",
    ".svelte-kit",
    "Pods",
    "DerivedData",
];

/// Ceilings, so one enormous checkout cannot turn the detail view into a
/// several-second stall. Each is reported when it bites rather than silently
/// truncating - a count that is quietly wrong is worse than no count.
const MAX_FILES: usize = 4000;
const MAX_HITS: usize = 400;
const MAX_FILE_BYTES: u64 = 512 * 1024;
/// Past this a "line" is minified output, not something anyone commented.
const MAX_LINE_LEN: usize = 400;
const MAX_TEXT_LEN: usize = 160;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    /// `TODO`, `FIXME`, `HACK` or `XXX`.
    pub kind: String,
    /// The note itself, without the marker and trimmed.
    pub text: String,
    /// Relative to the project, with forward slashes.
    pub file: String,
    pub line: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TodoReport {
    pub items: Vec<Todo>,
    /// True when a ceiling was hit, so the front end can say "showing the
    /// first 400" instead of presenting a partial count as the whole truth.
    pub truncated: bool,
}

/// Every note in a project, depth first and in a stable order.
pub fn scan(root: &Path) -> TodoReport {
    let mut items = Vec::new();
    let mut files = 0usize;
    let mut truncated = false;
    walk(root, root, &mut items, &mut files, &mut truncated);
    items.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
    TodoReport { items, truncated }
}

fn walk(root: &Path, dir: &Path, items: &mut Vec<Todo>, files: &mut usize, truncated: &mut bool) {
    if *truncated {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            if name.starts_with('.') || SKIP.iter().any(|s| s.eq_ignore_ascii_case(name)) {
                continue;
            }
            dirs.push(path);
        } else if kind.is_file() && wanted(&path) {
            if *files >= MAX_FILES || items.len() >= MAX_HITS {
                *truncated = true;
                return;
            }
            *files += 1;
            read_file(root, &path, items, truncated);
            if *truncated {
                return;
            }
        }
    }
    for child in dirs {
        walk(root, &child, items, files, truncated);
        if *truncated {
            return;
        }
    }
}

fn wanted(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    if !EXTS.iter().any(|e| e.eq_ignore_ascii_case(ext)) {
        return false;
    }
    std::fs::metadata(path)
        .map(|m| m.len() <= MAX_FILE_BYTES)
        .unwrap_or(false)
}

fn read_file(root: &Path, path: &Path, items: &mut Vec<Todo>, truncated: &mut bool) {
    // Anything that is not UTF-8 was never a source file worth reading.
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let file = relative(root, path);
    for (index, line) in text.lines().enumerate() {
        if line.len() > MAX_LINE_LEN {
            continue;
        }
        let Some((kind, note)) = find_marker(line) else {
            continue;
        };
        if items.len() >= MAX_HITS {
            *truncated = true;
            return;
        }
        items.push(Todo {
            kind: kind.to_string(),
            text: clip(note),
            file: file.clone(),
            line: index as u32 + 1,
        });
    }
}

/// The first marker on a line, and whatever follows it.
///
/// Uppercase only and on a word boundary, which is the whole convention: the
/// word "todo" in a sentence is prose, `TODO:` is a note to somebody.
fn find_marker(line: &str) -> Option<(&'static str, &str)> {
    let bytes = line.as_bytes();
    let mut best: Option<(usize, &'static str)> = None;
    for marker in MARKERS {
        let mut from = 0;
        while let Some(offset) = line[from..].find(marker) {
            let at = from + offset;
            let end = at + marker.len();
            let before_ok = at == 0 || !is_word_byte(bytes[at - 1]);
            let after_ok = end >= bytes.len() || !is_word_byte(bytes[end]);
            if before_ok && after_ok && best.map(|(b, _)| at < b).unwrap_or(true) {
                best = Some((at, marker));
                break;
            }
            from = end;
        }
    }
    let (at, marker) = best?;
    let rest = line[at + marker.len()..].trim_start();
    Some((marker, rest.trim_start_matches([':', '-', ')']).trim()))
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn clip(text: &str) -> String {
    if text.chars().count() <= MAX_TEXT_LEN {
        return text.to_string();
    }
    let cut: String = text.chars().take(MAX_TEXT_LEN).collect();
    format!("{}...", cut.trim_end())
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// How many lines of context are read either side of a note.
const EXCERPT_RADIUS: u32 = 8;
/// A single line of an excerpt is clipped at this, for the same reason the
/// notes themselves are: a minified line is not context, it is a wall.
const MAX_EXCERPT_LINE: usize = 400;

/// The lines around one note, with enough around them to read what it is about.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Excerpt {
    /// Relative to the project, with forward slashes - as the note reports it.
    pub file: String,
    /// The line the note is on, 1-based.
    pub line: u32,
    /// The line number `lines[0]` holds, 1-based, so the front end can number
    /// the block without knowing how the window was clipped.
    pub start: u32,
    pub lines: Vec<String>,
}

/// Reads the lines around `line` of `file`, which is interpreted relative to
/// `root` and must stay inside it.
pub fn excerpt(root: &Path, file: &str, line: u32) -> Result<Excerpt, String> {
    let target = resolve(root, file)?;

    // The same ceiling the sweep itself uses. A file too big to have been
    // searched cannot have produced the note being asked about.
    let size = std::fs::metadata(&target)
        .map_err(|_| "File no longer exists.".to_string())?
        .len();
    if size > MAX_FILE_BYTES {
        return Err("File is too large to show.".into());
    }
    let text = std::fs::read_to_string(&target).map_err(|_| "File is not text.".to_string())?;

    let all: Vec<&str> = text.lines().collect();
    if all.is_empty() {
        return Err("File is empty.".into());
    }
    let line = line.max(1);
    // Saturating, so a note on line 1 does not wrap round to the end of the file.
    let start = line.saturating_sub(EXCERPT_RADIUS).max(1);
    let end = (line + EXCERPT_RADIUS).min(all.len() as u32);
    if start > all.len() as u32 {
        return Err("File no longer has that line.".into());
    }

    let lines = all[start as usize - 1..end as usize]
        .iter()
        .map(|l| clip_line(l))
        .collect();
    Ok(Excerpt {
        file: file.to_string(),
        line,
        start,
        lines,
    })
}

/// Joins `file` onto `root` and refuses anything that leaves the project.
///
/// The path arrives from the front end, so `..` and absolute paths have to be
/// turned away here rather than trusted because the notes list produced them.
fn resolve(root: &Path, file: &str) -> Result<PathBuf, String> {
    let relative = Path::new(file);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("That file is outside the project.".into());
    }
    let joined = root.join(relative);
    let (Ok(base), Ok(target)) = (root.canonicalize(), joined.canonicalize()) else {
        return Err("File no longer exists.".into());
    };
    if !target.starts_with(&base) {
        return Err("That file is outside the project.".into());
    }
    Ok(target)
}

/// Tabs become spaces so the block lines up under a proportional-free font
/// without the front end having to guess a tab width.
fn clip_line(line: &str) -> String {
    let expanded = line.replace('\t', "    ");
    if expanded.chars().count() <= MAX_EXCERPT_LINE {
        return expanded;
    }
    expanded.chars().take(MAX_EXCERPT_LINE).collect()
}
