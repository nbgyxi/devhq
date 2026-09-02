use crate::util::{run, run_lossy};
use serde::{Deserialize, Serialize};
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
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=normal",
        ],
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
    .map(|s| {
        s.lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    })
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    pub url: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub hash: String,
    pub author: String,
    pub subject: String,
    pub timestamp: i64,
    pub refs: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub mine: String,
    pub theirs: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub info: GitInfo,
    pub remotes: Vec<Remote>,
    pub history: Vec<HistoryEntry>,
    pub incoming: Vec<HistoryEntry>,
    pub conflicts: Vec<ConflictFile>,
    pub diff: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRequest {
    pub path: String,
    pub action: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub amend: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    pub output: String,
}

/// A path saved from an earlier session can point somewhere no longer
/// reachable - a disconnected network drive, an unmounted volume, a VPN-only
/// share. `Path::exists()` has no timeout of its own, and on an unreachable
/// network path can block for the OS's own connection timeout (commonly
/// ~10s on Windows for an unreachable SMB share) before it even gets to
/// report "not found". Every workspace lookup starts here, so a stale saved
/// path would silently stall the whole "Opening Git" state for that long.
/// Bounding it in its own thread lets an unreachable path fail fast instead.
fn path_reachable_within(path: &Path, timeout: std::time::Duration) -> bool {
    let path = path.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(path.exists());
    });
    rx.recv_timeout(timeout).unwrap_or(false)
}

fn repo(path: &str) -> Result<std::path::PathBuf, String> {
    let dir = std::path::PathBuf::from(path);
    if !path_reachable_within(&dir.join(".git"), std::time::Duration::from_secs(2)) {
        return Err("Not a Git repository, or its location could not be reached.".into());
    }
    Ok(dir)
}

#[tauri::command]
pub async fn git_workspace(path: String) -> Result<Workspace, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = repo(&path)?;
        let info = read(&dir).ok_or_else(|| "Could not read repository.".to_string())?;
        let remotes = run_lossy("git", &["remote", "-v"], Some(&dir))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| {
                let mut p = line.split_whitespace();
                Some(Remote {
                    name: p.next()?.into(),
                    url: p.next()?.into(),
                })
            })
            .fold(Vec::<Remote>::new(), |mut out, remote| {
                if !out
                    .iter()
                    .any(|r| r.name == remote.name && r.url == remote.url)
                {
                    out.push(remote)
                }
                out
            });
        let history = run_lossy(
            "git",
            &[
                "log",
                "-50",
                "--date-order",
                "--format=%h%x1f%an%x1f%ct%x1f%s%x1f%D",
            ],
            Some(&dir),
        )
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let p: Vec<_> = line.split('\u{1f}').collect();
            (p.len() == 5).then(|| HistoryEntry {
                hash: p[0].into(),
                author: p[1].into(),
                timestamp: p[2].parse().unwrap_or(0),
                subject: p[3].into(),
                refs: p[4].into(),
            })
        })
        .collect();
        let rebasing =
            dir.join(".git/rebase-merge").exists() || dir.join(".git/rebase-apply").exists();
        let conflicts = info
            .changed
            .iter()
            .filter(|f| f.status == "conflict")
            .take(30)
            .map(|f| {
                let ours = run_lossy("git", &["show", &format!(":2:{}", f.path)], Some(&dir))
                    .unwrap_or_default();
                let theirs = run_lossy("git", &["show", &format!(":3:{}", f.path)], Some(&dir))
                    .unwrap_or_default();
                ConflictFile {
                    path: f.path.clone(),
                    mine: if rebasing {
                        theirs.clone()
                    } else {
                        ours.clone()
                    },
                    theirs: if rebasing { ours } else { theirs },
                }
            })
            .collect();
        let incoming = run_lossy(
            "git",
            &[
                "log",
                "-12",
                "--format=%h%x1f%an%x1f%ct%x1f%s%x1f%D",
                "HEAD..@{upstream}",
            ],
            Some(&dir),
        )
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let p: Vec<_> = line.split('\u{1f}').collect();
            (p.len() == 5).then(|| HistoryEntry {
                hash: p[0].into(),
                author: p[1].into(),
                timestamp: p[2].parse().unwrap_or(0),
                subject: p[3].into(),
                refs: p[4].into(),
            })
        })
        .collect();
        let mut diff =
            run_lossy("git", &["diff", "--cached", "--no-color"], Some(&dir)).unwrap_or_default();
        diff.push_str(&run_lossy("git", &["diff", "--no-color"], Some(&dir)).unwrap_or_default());
        if diff.len() > 600_000 {
            let mut end = 600_000;
            while !diff.is_char_boundary(end) {
                end -= 1;
            }
            diff.truncate(end);
        }
        Ok(Workspace {
            info,
            remotes,
            history,
            incoming,
            conflicts,
            diff,
        })
    })
    .await
    .map_err(|_| "Could not read Git repository.".to_string())?
}

#[tauri::command]
pub async fn git_action(request: ActionRequest) -> Result<ActionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = repo(&request.path)?;
        if request.action == "keep_mine" || request.action == "keep_theirs" {
            if request.value.is_empty() {
                return Err("A conflicted file is required.".into());
            }
            let rebasing =
                dir.join(".git/rebase-merge").exists() || dir.join(".git/rebase-apply").exists();
            let mine = request.action == "keep_mine";
            let flag = if mine ^ rebasing {
                "--ours"
            } else {
                "--theirs"
            };
            let chosen = git_command(&dir, &["checkout", flag, "--", &request.value])?;
            if !chosen.ok {
                return Ok(chosen);
            }
            return git_command(&dir, &["add", "--", &request.value]);
        }
        if request.action == "create_branch_from" {
            let (name, source) = request
                .value
                .split_once('\n')
                .ok_or_else(|| "A folder name and source are required.".to_string())?;
            if name.trim().is_empty() {
                return Err("A folder name is required.".into());
            }
            return if source.trim().is_empty() {
                git_command(&dir, &["switch", "--orphan", name])
            } else {
                git_command(&dir, &["switch", "-c", name, source])
            };
        }
        let mut args: Vec<&str> = match request.action.as_str() {
            "fetch" => vec!["fetch", "--all", "--prune"],
            "pull" => vec!["pull"],
            "push" => vec!["push"],
            "stage_all" => vec!["add", "-A"],
            "stage" => vec!["add", "--", &request.value],
            "unstage" => vec!["reset", "HEAD", "--", &request.value],
            "discard" => vec!["restore", "--worktree", "--", &request.value],
            "discard_all" => vec!["restore", "--worktree", "."],
            "checkout" => vec!["checkout", &request.value],
            "create_branch" => vec!["checkout", "-b", &request.value],
            "delete_branch" => vec!["branch", "-D", &request.value],
            "show_commit" => vec![
                "show",
                "--format=fuller",
                "--stat",
                "--patch",
                &request.value,
            ],
            "restore" => vec!["reset", "--hard", &request.value],
            "stash" => vec!["stash", "push", "-u", "-m", "DevHQ stash"],
            "commit" if !request.value.trim().is_empty() => {
                if request.amend {
                    vec!["commit", "--amend", "-m", &request.value]
                } else {
                    vec!["commit", "-m", &request.value]
                }
            }
            _ => return Err("Unsupported Git action.".into()),
        };
        git_command(&dir, &args.drain(..).collect::<Vec<_>>())
    })
    .await
    .map_err(|_| "Git action stopped unexpectedly.".to_string())?
}

fn git_command(dir: &Path, args: &[&str]) -> Result<ActionResult, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args)
        .current_dir(&dir)
        .env("GIT_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd
        .output()
        .map_err(|_| "Could not start Git.".to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let output = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    Ok(ActionResult {
        ok: out.status.success(),
        output: if output.is_empty() {
            if out.status.success() {
                "Done"
            } else {
                "Git failed"
            }
            .into()
        } else {
            output.into()
        },
    })
}
