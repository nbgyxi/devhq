//! The command histories the installed shells already keep, which is what the
//! terminal's Ctrl+R searches. History files can be large, so this is only ever
//! read on a worker thread, and only when Ctrl+R is first opened.

use std::path::PathBuf;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellHistoryEntry {
    command: String,
    shell: String,
}

/// Newest first within each shell, at most ten thousand lines from each.
pub fn read() -> Vec<ShellHistoryEntry> {
    let profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    let mut sources = Vec::new();
    if let Some(root) = appdata {
        sources.push((
            root.join("Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt"),
            "pwsh",
        ));
        sources.push((root.join("nushell/history.txt"), "nu"));
    }
    if let Some(root) = profile {
        sources.push((root.join(".bash_history"), "bash"));
    }
    let mut entries = Vec::new();
    for (path, shell) in sources {
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        entries.extend(text.lines().rev().take(10_000).filter_map(|line| {
            let command = line.trim();
            (!command.is_empty()).then(|| ShellHistoryEntry {
                command: command.to_string(),
                shell: shell.to_string(),
            })
        }));
    }
    entries
}
