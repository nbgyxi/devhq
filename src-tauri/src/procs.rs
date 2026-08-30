use crate::cwd;
use crate::util::{norm, run_lossy};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::time::Duration;

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
    exe: String,
    /// Command line + image path, normalised once so matching is a substring test.
    haystack: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    pub process: String,
    pub executable_path: String,
}

pub fn descendants(root_pid: u32) -> Vec<ProcessIdentity> {
    let processes = list_processes();
    let mut wanted = HashSet::from([root_pid]);
    loop {
        let before = wanted.len();
        for process in &processes {
            if wanted.contains(&process.parent) {
                wanted.insert(process.pid);
            }
        }
        if wanted.len() == before {
            break;
        }
    }
    processes
        .into_iter()
        .filter(|process| process.pid != root_pid && wanted.contains(&process.pid))
        .map(|process| ProcessIdentity {
            pid: process.pid,
            process: process.name,
            executable_path: process.exe,
        })
        .collect()
}

pub fn survivors(expected: Vec<ProcessIdentity>) -> Vec<ProcessIdentity> {
    let current = list_processes();
    expected
        .into_iter()
        .filter(|expected| {
            current.iter().any(|process| {
                process.pid == expected.pid
                    && process.name.eq_ignore_ascii_case(&expected.process)
                    && process.exe.eq_ignore_ascii_case(&expected.executable_path)
            })
        })
        .collect()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PortBinding {
    pub port: u16,
    pub protocol: String,
    pub address: String,
    pub browser_url: Option<String>,
    pub http_status: Option<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEntry {
    pub pid: u32,
    pub parent_pid: u32,
    pub process: String,
    pub executable_path: String,
    pub cwd: String,
    pub command_line: String,
    pub ports: Vec<PortBinding>,
}

/// Every process on the machine, enriched with all of its TCP listeners and
/// UDP bindings. Kept separate from project matching: the explorer must also
/// show tools, databases and services outside scanned folders.
pub fn port_list() -> Vec<ProcessEntry> {
    let processes = list_processes();
    let endpoints = listening_endpoints();
    let local_ports: HashSet<u16> = endpoints
        .iter()
        .filter(|(protocol, address, _, _)| protocol == "TCP" && is_local_address(address))
        .map(|(_, _, port, _)| *port)
        .collect();
    // Probes run together so closed/non-HTTP ports cost one short timeout, not
    // one timeout each. A port is browser-capable only after an HTTP status
    // line comes back; merely listening on localhost is not enough.
    let probes: HashMap<u16, Option<(String, u16)>> = local_ports
        .into_iter()
        .map(|port| std::thread::spawn(move || (port, probe_browser_url(port))))
        .collect::<Vec<_>>()
        .into_iter()
        .filter_map(|thread| thread.join().ok())
        .collect();
    let mut ports: HashMap<u32, Vec<PortBinding>> = HashMap::new();
    for (protocol, address, port, pid) in endpoints {
        let bindings = ports.entry(pid).or_default();
        if !bindings
            .iter()
            .any(|binding| binding.port == port && binding.protocol == protocol)
        {
            let probe = probes.get(&port).and_then(|result| result.as_ref());
            bindings.push(PortBinding {
                browser_url: probe.map(|(url, _)| url.clone()),
                http_status: probe.map(|(_, status)| *status),
                port,
                protocol,
                address,
            });
        }
    }
    for bindings in ports.values_mut() {
        bindings.sort_by(|a, b| a.port.cmp(&b.port).then(a.protocol.cmp(&b.protocol)));
    }
    let mut out: Vec<_> = processes
        .into_iter()
        .map(|process| ProcessEntry {
            ports: ports.remove(&process.pid).unwrap_or_default(),
            pid: process.pid,
            parent_pid: process.parent,
            process: process.name,
            executable_path: process.exe,
            cwd: process.cwd,
            command_line: process.cmd,
        })
        .collect();
    // A protected process may own a socket even when CIM withheld its details.
    out.extend(ports.into_iter().map(|(pid, ports)| ProcessEntry {
        pid,
        parent_pid: 0,
        process: String::new(),
        executable_path: String::new(),
        cwd: String::new(),
        command_line: String::new(),
        ports,
    }));
    out.sort_by(|a, b| {
        a.process
            .to_lowercase()
            .cmp(&b.process.to_lowercase())
            .then(a.pid.cmp(&b.pid))
    });
    out
}

fn is_local_address(address: &str) -> bool {
    matches!(
        address.to_ascii_lowercase().as_str(),
        "0.0.0.0" | "::" | "127.0.0.1" | "::1" | "localhost" | "*"
    )
}

fn probe_browser_url(port: u16) -> Option<(String, u16)> {
    let timeout = Duration::from_millis(220);
    let addresses = [
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port),
    ];
    for address in addresses {
        let Ok(mut stream) = TcpStream::connect_timeout(&address, timeout) else {
            continue;
        };
        let _ = stream.set_read_timeout(Some(timeout));
        let _ = stream.set_write_timeout(Some(timeout));
        if stream
            .write_all(b"HEAD / HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .is_err()
        {
            continue;
        }
        let mut response = [0u8; 64];
        let Some(read) = stream.read(&mut response).ok().filter(|read| *read >= 12) else {
            continue;
        };
        let first_line = String::from_utf8_lossy(&response[..read]);
        let mut fields = first_line.split_whitespace();
        let (Some(version), Some(status)) = (fields.next(), fields.next()) else {
            continue;
        };
        if version.starts_with("HTTP/") {
            if let Ok(status) = status.parse::<u16>() {
                return Some((format!("http://localhost:{port}"), status));
            }
        }
    }
    None
}

pub fn kill(pid: u32, expected_executable: &str, expected_process: &str) -> Result<(), String> {
    if pid <= 4 || pid == std::process::id() {
        return Err("DevHQ will not terminate this protected process.".into());
    }
    let processes = list_processes();
    let current = processes
        .iter()
        .find(|process| process.pid == pid)
        .ok_or_else(|| "That process is no longer running.".to_string())?;
    let same_executable =
        expected_executable.is_empty() || current.exe.eq_ignore_ascii_case(expected_executable);
    let same_name =
        expected_process.is_empty() || current.name.eq_ignore_ascii_case(expected_process);
    if !same_executable || !same_name {
        return Err(
            "The PID now belongs to a different process. Refresh before trying again.".into(),
        );
    }
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        let handle = OpenProcess(PROCESS_TERMINATE, false, pid)
            .map_err(|e| format!("Could not open process {pid}: {e}"))?;
        let result = TerminateProcess(handle, 1)
            .map_err(|e| format!("Could not terminate process {pid}: {e}"));
        let _ = CloseHandle(handle);
        result
    }
    #[cfg(not(windows))]
    {
        let _ = (pid, expected_executable, expected_process);
        Err("Process termination is only available on Windows.".into())
    }
}

/// Shells, terminals, editors and VCS tools. A terminal sitting in a folder is
/// not the project running — but its children may be, so these are dropped only
/// after match propagation, and never when the process holds a listening port.
const NOISE_NAMES: &[&str] = &[
    "explorer.exe",
    "code.exe",
    "cursor.exe",
    "devenv.exe",
    "svchost.exe",
    "conhost.exe",
    "WindowsTerminal.exe",
    "OpenConsole.exe",
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "bash.exe",
    "sh.exe",
    "zsh.exe",
    "git.exe",
    "ssh.exe",
    "claude.exe",
    "devhq.exe",
    "scan_cli.exe",
    // Git-for-Windows ports of the usual shell utilities, which appear whenever
    // a terminal in the folder runs a pipeline.
    "grep.exe",
    "sed.exe",
    "awk.exe",
    "find.exe",
    "head.exe",
    "tail.exe",
    "ls.exe",
    "cat.exe",
    "tr.exe",
    "xargs.exe",
    "sort.exe",
    "wc.exe",
];

/// Command-line fragments belonging to tools that merely run *in* a project —
/// coding agents and editor extensions — rather than being the project itself.
const NOISE_CMD: &[&str] = &[
    "cursor-agent",
    "\\.vscode\\extensions\\",
    "claude-code",
    "\\.cursor\\extensions\\",
    "language-server",
    "typescript\\lib\\tsserver",
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
            let Some(kids) = self.children.get(&pid) else {
                continue;
            };
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
            let parent = v
                .get("ParentProcessId")
                .and_then(|x| x.as_u64())
                .unwrap_or(0) as u32;
            let name = v
                .get("Name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let cmd = v
                .get("CommandLine")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let exe = v
                .get("ExecutablePath")
                .and_then(|x| x.as_str())
                .unwrap_or("");
            let haystack = norm(&format!("{cmd} {exe}"));
            let cwd = cwd::of(pid).unwrap_or_default();
            Some(RawProc {
                pid,
                parent,
                name,
                cmd,
                cwd,
                exe: exe.to_string(),
                haystack,
            })
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

fn listening_endpoints() -> Vec<(String, String, u16, u32)> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let Some(out) = run_lossy("netstat", &["-ano"], None) else {
        return Vec::new();
    };
    let mut endpoints = Vec::new();
    for line in out.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 4 {
            continue;
        }
        let protocol = fields[0].to_ascii_uppercase();
        let (local, pid_text) = if protocol == "TCP"
            && fields.len() >= 5
            && fields[3].eq_ignore_ascii_case("LISTENING")
        {
            (fields[1], fields[4])
        } else if protocol == "UDP" && fields.len() >= 4 {
            (fields[1], fields[3])
        } else {
            continue;
        };
        let Some((address, port_text)) = local.rsplit_once(':') else {
            continue;
        };
        let (Ok(port), Ok(pid)) = (port_text.parse::<u16>(), pid_text.parse::<u32>()) else {
            continue;
        };
        endpoints.push((
            protocol,
            address.trim_matches(['[', ']']).to_string(),
            port,
            pid,
        ));
    }
    endpoints
}

/// One cheap reading of a process's cost. Deliberately native and per-PID:
/// the explorer refreshes these every couple of seconds, which a `Get-CimInstance`
/// sweep could never carry. `cpu_seconds` is the running total of user + kernel
/// time — the caller turns two readings into a percentage.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcSample {
    pub pid: u32,
    pub cpu_seconds: f64,
    pub memory_bytes: u64,
    pub uptime_seconds: f64,
}

/// Samples the given PIDs. A process that has exited, or that refuses to be
/// opened, is simply absent from the answer — the caller reads that as "gone".
#[cfg(windows)]
pub fn sample(pids: Vec<u32>) -> Vec<ProcSample> {
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let ticks = |time: FILETIME| ((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64;
    // A FILETIME counts 100-nanosecond units from 1601, so "now" has to be moved
    // onto the same epoch before a creation time can be subtracted from it.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs_f64() + 11_644_473_600.0)
        .unwrap_or(0.0);

    pids.into_iter()
        .filter_map(|pid| unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let (mut created, mut exited, mut kernel, mut user) = (
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
            );
            let timed =
                GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user).is_ok();
            let mut memory = PROCESS_MEMORY_COUNTERS::default();
            let sized = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            let measured = GetProcessMemoryInfo(handle, &mut memory, sized).is_ok();
            let _ = CloseHandle(handle);
            if !timed {
                return None;
            }
            let started = ticks(created) as f64 / 1e7;
            Some(ProcSample {
                pid,
                cpu_seconds: (ticks(kernel) + ticks(user)) as f64 / 1e7,
                memory_bytes: if measured {
                    memory.WorkingSetSize as u64
                } else {
                    0
                },
                uptime_seconds: (now - started).max(0.0),
            })
        })
        .collect()
}

#[cfg(not(windows))]
pub fn sample(pids: Vec<u32>) -> Vec<ProcSample> {
    let _ = pids;
    Vec::new()
}

/// Kills a process and everything below it, the descendants first so that a
/// supervisor cannot notice a worker die and restart it on the way down. The
/// root is verified exactly as a single kill is, and each descendant is checked
/// against the name and image it was just enumerated with, so a PID recycled
/// between the sweep and the kill is left alone.
pub fn kill_tree(
    pid: u32,
    expected_executable: &str,
    expected_process: &str,
) -> Result<(), String> {
    for child in descendants(pid) {
        let _ = kill(child.pid, &child.executable_path, &child.process);
    }
    kill(pid, expected_executable, expected_process)
}
