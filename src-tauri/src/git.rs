use crate::util::{run, run_lossy};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub author: String,
    pub subject: String,
    /// Unix-epoch seconds, so the UI can render "3 days ago" against its own clock.
    pub timestamp: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub status: String,
    pub path: String,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub branch: String,
    pub upstream: String,
    pub remote: String,
    pub ahead: u32,
    pub behind: u32,
    pub staged: u32,
    pub modified: u32,
    pub untracked: u32,
    pub conflicted: u32,
    pub dirty: bool,
    /// Capped at [`MAX_CHANGED_FILES`]; `changedTotal` carries the true count.
    pub changed: Vec<ChangedFile>,
    pub changed_total: u32,
    pub stashes: u32,
    pub branches: Vec<String>,
    pub last_commit: Option<Commit>,
    pub commits_30d: u32,
}

const MAX_CHANGED_FILES: usize = 200;

pub fn read(path: &Path) -> Option<GitInfo> {
    if !path.join(".git").exists() {
        return None;
    }
    let mut info = GitInfo::default();

    // porcelain v2 gives branch, upstream, ahead/behind and the file list in a
    // single invocation — cheaper than one git call per fact.
    let status = run(
        "git",
        &["status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
        Some(path),
    )
    .unwrap_or_default();

    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            info.branch = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            info.upstream = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for token in rest.split_whitespace() {
                let n: u32 = token[1..].parse().unwrap_or(0);
                match token.as_bytes().first() {
                    Some(b'+') => info.ahead = n,
                    Some(b'-') => info.behind = n,
                    _ => {}
                }
            }
        } else if let Some(entry) = parse_status_entry(line) {
            match entry.status.as_str() {
                "untracked" => info.untracked += 1,
                "conflict" => info.conflicted += 1,
                s => {
                    // XY field: X is the staged column, Y the worktree column.
                    let bytes = s.as_bytes();
                    if bytes.first() != Some(&b'.') {
                        info.staged += 1;
                    }
                    if bytes.get(1) != Some(&b'.') {
                        info.modified += 1;
                    }
                }
            }
            info.changed_total += 1;
            if info.changed.len() < MAX_CHANGED_FILES {
                info.changed.push(entry);
            }
        }
    }

    info.dirty = info.changed_total > 0;

    if let Some(out) = run(
        "git",
        &["log", "-1", "--format=%H%x1f%an%x1f%ct%x1f%s"],
        Some(path),
    ) {
        let parts: Vec<&str> = out.trim().split('\u{1f}').collect();
        if parts.len() == 4 {
            info.last_commit = Some(Commit {
                hash: parts[0].chars().take(8).collect(),
                author: parts[1].to_string(),
                timestamp: parts[2].parse().unwrap_or(0),
                subject: parts[3].to_string(),
            });
        }
    }

    info.remote = run("git", &["remote", "get-url", "origin"], Some(path))
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    info.stashes = run_lossy("git", &["stash", "list"], Some(path))
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count() as u32)
        .unwrap_or(0);

    info.branches = run(
        "git",
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        Some(path),
    )
    .map(|s| s.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
    .unwrap_or_default();

    info.commits_30d = run_lossy(
        "git",
        &["rev-list", "--count", "--since=30.days", "HEAD"],
        Some(path),
    )
    .and_then(|s| s.trim().parse().ok())
    .unwrap_or(0);

    Some(info)
}

/// Turns one porcelain-v2 line into a changed-file entry. Returns `None` for the
/// header lines and anything unrecognised.
fn parse_status_entry(line: &str) -> Option<ChangedFile> {
    let mut fields = line.split(' ');
    match fields.next()? {
        // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        "1" => {
            let xy = fields.next()?.to_string();
            let path = line.splitn(9, ' ').nth(8)?.to_string();
            Some(ChangedFile { status: xy, path })
        }
        // 2 <XY> ... <path>\t<origPath>  (rename/copy)
        "2" => {
            let xy = fields.next()?.to_string();
            let tail = line.splitn(10, ' ').nth(9)?;
            let path = tail.split('\t').next()?.to_string();
            Some(ChangedFile { status: xy, path })
        }
        "u" => Some(ChangedFile {
            status: "conflict".into(),
            path: line.splitn(11, ' ').nth(10)?.to_string(),
        }),
        "?" => Some(ChangedFile {
            status: "untracked".into(),
            path: line[2..].to_string(),
        }),
        _ => None,
    }
}
