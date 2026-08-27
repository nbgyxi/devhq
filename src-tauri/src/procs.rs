use crate::cwd;
use crate::util::{norm, run_lossy};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunningProc {
    pub pid: u32,
    pub name: String,
    pub cmd: String,
    pub cwd: String,
    pub ports: Vec<u16>,
    /// How the process was tied to the project: "cwd", "path" or "child".
    pub via: String,
}

/// One snapshot of the machine's processes and listening sockets, taken once per
/// scan and then matched against every project. Enumerating per project would
/// mean a `Get-CimInstance` sweep per folder.
pub struct ProcessSnapshot {
    procs: Vec<RawProc>,
    ports: HashMap<u32, Vec<u16>>,
    /// pid -> its direct children, for propagating a match down the tree.
    children: HashMap<u32, Vec<u32>>,
}

struct RawProc {
    pid: u32,
    parent: u32,
    name: String,
    cmd: String,
    cwd: String,
    /// Command line + image path, normalised once so matching is a substring test.
    haystack: String,
}

/// Shells, terminals, editors and VCS tools. A terminal sitting in a folder is
/// not the project running — but its children may be, so these are dropped only
/// after match propagation, and never when the process holds a listening port.
const NOISE_NAMES: &[&str] = &[
    "explorer.exe", "code.exe", "cursor.exe", "devenv.exe", "svchost.exe",
    "conhost.exe", "WindowsTerminal.exe", "OpenConsole.exe", "cmd.exe",
    "powershell.exe", "pwsh.exe", "bash.exe", "sh.exe", "zsh.exe", "git.exe",
    "ssh.exe", "claude.exe", "devhq.exe", "scan_cli.exe",
    // Git-for-Windows ports of the usual shell utilities, which appear whenever
    // a terminal in the folder runs a pipeline.
    "grep.exe", "sed.exe", "awk.exe", "find.exe", "head.exe", "tail.exe",
    "ls.exe", "cat.exe", "tr.exe", "xargs.exe", "sort.exe", "wc.exe",
];

/// Command-line fragments belonging to tools that merely run *in* a project —
/// coding agents and editor extensions — rather than being the project itself.
const NOISE_CMD: &[&str] = &[
    "cursor-agent", "\\.vscode\\extensions\\", "claude-code", "\\.cursor\\extensions\\",
    "language-server", "typescript\\lib\\tsserver",
];

impl ProcessSnapshot {
    pub fn capture() -> Self {
        let procs = list_processes();
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for p in &procs {
            children.entry(p.parent).or_default().push(p.pid);
        }
        ProcessSnapshot {
            procs,
            ports: listening_ports(),
            children,
        }
    }

    /// Processes belonging to `project_path`, by working directory, by a path
    /// reference on the command line, or by descending from one that matched.
    ///
    /// The trailing separator matters: without it `c:\code\showdown` would also
    /// claim every process belonging to `c:\code\showdown-tv`.
    pub fn matching(&self, project_path: &str) -> Vec<RunningProc> {
        let base = norm(project_path);
        let inside = format!("{base}\\");

        let mut how: HashMap<u32, &'static str> = HashMap::new();
        for p in &self.procs {
            let in_cwd = {
                let c = norm(&p.cwd);
                c == base || c.starts_with(&inside)
            };
            if in_cwd {
                how.insert(p.pid, "cwd");
            } else if p.haystack.contains(&inside) {
                how.insert(p.pid, "path");
            }
        }

        // A matched process's children inherit the match: `npm run dev` spawns
        // the node process that actually holds the port, and a worker's command
        // line rarely names the project.
        let mut queue: Vec<u32> = how.keys().copied().collect();
        let mut seen: HashSet<u32> = queue.iter().copied().collect();
        while let Some(pid) = queue.pop() {
            let Some(kids) = self.children.get(&pid) else { continue };
            for &kid in kids {
                if seen.insert(kid) {
                    how.entry(kid).or_insert("child");
                    queue.push(kid);
                }
            }
        }

        let mut out: Vec<RunningProc> = self
            .procs
            .iter()
            .filter_map(|p| {
                let via = how.get(&p.pid)?;
                let ports = self.ports.get(&p.pid).cloned().unwrap_or_default();
                if ports.is_empty() && is_noise(p) {
                    return None;
                }
                Some(RunningProc {
                    pid: p.pid,
                    name: p.name.clone(),
                    cmd: p.cmd.clone(),
                    cwd: p.cwd.clone(),
                    ports,
                    via: (*via).to_string(),
                })
            })
            .collect();
        // Processes holding a port first — those are the dev servers worth seeing.
        out.sort_by(|a, b| b.ports.len().cmp(&a.ports.len()).then(a.pid.cmp(&b.pid)));
        out
    }
}

fn is_noise(p: &RawProc) -> bool {
    NOISE_NAMES.iter().any(|n| n.eq_ignore_ascii_case(&p.name))
        || NOISE_CMD.iter().any(|f| p.haystack.contains(f))
}

fn list_processes() -> Vec<RawProc> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress";
    let out = match run_lossy(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", script],
        None,
    ) {
        Some(s) => s,
        None => return Vec::new(),
    };
    let parsed: serde_json::Value = match serde_json::from_str(out.trim()) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let items = match parsed {
        serde_json::Value::Array(a) => a,
        other => vec![other],
    };
    items
        .into_iter()
        .filter_map(|v| {
            let pid = v.get("ProcessId")?.as_u64()? as u32;
            let parent = v.get("ParentProcessId").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            let name = v.get("Name").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let cmd = v.get("CommandLine").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let exe = v.get("ExecutablePath").and_then(|x| x.as_str()).unwrap_or("");
            let haystack = norm(&format!("{cmd} {exe}"));
            let cwd = cwd::of(pid).unwrap_or_default();
            Some(RawProc { pid, parent, name, cmd, cwd, haystack })
        })
        .collect()
}

fn listening_ports() -> HashMap<u32, Vec<u16>> {
    let mut map: HashMap<u32, Vec<u16>> = HashMap::new();
    if !cfg!(windows) {
        return map;
    }
    let out = match run_lossy("netstat", &["-ano", "-p", "TCP"], None) {
        Some(s) => s,
        None => return map,
    };
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        // TCP  <local>  <remote>  LISTENING  <pid>
        if f.len() < 5 || !f[0].eq_ignore_ascii_case("tcp") || f[3] != "LISTENING" {
            continue;
        }
        let port: u16 = match f[1].rsplit(':').next().and_then(|p| p.parse().ok()) {
            Some(p) => p,
            None => continue,
        };
        let pid: u32 = match f[4].parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let entry = map.entry(pid).or_default();
        if !entry.contains(&port) {
            entry.push(port);
        }
    }
    for ports in map.values_mut() {
        ports.sort_unstable();
    }
    map
}
