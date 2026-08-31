//! The network watcher: what is actually on the wire, without installing a
//! driver to find out.
//!
//! Windows ships `pktmon`, a kernel packet capture that is already there on
//! every machine this app runs on. There is no Npcap to install, no reboot and
//! no third-party driver — which is the whole reason this tool exists rather
//! than asking the user to go and download one.
//!
//! `pktmon` is driven here rather than merely wrapped: filters are pushed into
//! the driver, capture runs in `real-time` mode so frames arrive as they
//! happen instead of after the fact, and the frames are parsed, kept in a ring
//! and written back out as pcapng by this module. None of that can run on the
//! UI thread, so the capture owns a thread of its own and reports what it sees
//! through events.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};

/// How many frames the ring holds. A frame costs its truncated bytes plus a
/// little text, so this is a few tens of megabytes at the default 128-byte
/// truncation — big enough to scroll back through a burst, small enough that a
/// capture left running overnight cannot eat the machine.
const RING: usize = 20_000;

/// Frames are shipped to the front end in batches. A busy link produces
/// thousands a second, and one IPC round trip each would be the end of the
/// frame rate this app is built around.
const BATCH: usize = 64;
const BATCH_MS: u64 = 120;

/// How often the owning-process map is read again. Sockets come and go; this
/// is often enough to catch a dev server restarting, cheap enough to ignore.
const OWNERS_MS: u64 = 3_000;

/* --------------------------------------------------------------- the shapes */

/// One packet processing component — a NIC, the loopback interface, a vSwitch
/// port. `pktmon` counts and filters per component, and the id is what
/// `--comp` takes.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: u32,
    pub name: String,
    /// The second line under the name: the driver, the MAC, whatever `pktmon
    /// list` had to say beyond the name itself.
    pub detail: String,
    /// `nic`, `loopback`, `vswitch` or `other` — only used to pick an icon.
    pub kind: String,
}

/// One captured frame, already decoded far enough to put in a row.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    /// Monotonic within a session, so the front end can key rows without
    /// comparing contents.
    pub id: u64,
    /// `HH:MM:SS.mmm`, as pktmon reported it.
    pub time: String,
    /// `in` or `out`, from pktmon's Rx/Tx.
    pub dir: String,
    /// What the row shows in the protocol pill: the transport, refined by port
    /// where the port says something more useful (443 → TLS, 53 → DNS).
    pub proto: String,
    /// The transport as it actually is on the wire, before that refinement.
    pub transport: String,
    pub src: String,
    pub dst: String,
    pub src_port: u16,
    pub dst_port: u16,
    /// The one-line summary at the end of the row — flags, lengths, whatever
    /// the deepest parsed layer had to say.
    pub info: String,
    /// Bytes on the wire, which is not the number of bytes we kept.
    pub len: u32,
    pub comp: u32,
    /// Best-effort owning process, from the socket table. Empty when neither
    /// port belongs to anything this machine has open — anything broadcast,
    /// forwarded, or simply not ours.
    pub process: String,
    pub pid: u32,
    /// The decoded layers, for the detail panel.
    pub layers: Vec<Layer>,
    /// Captured bytes, hex, uppercase, no separators. Empty when pktmon gave us
    /// headers but no raw packet.
    pub bytes: String,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub name: String,
    pub summary: String,
    /// `[key, value]` pairs, in the order pktmon printed them.
    pub fields: Vec<[String; 2]>,
}

/// What the tool is allowed to do on this machine, asked before anything is
/// offered. `pktmon` refuses every command without elevation, so this is the
/// difference between a tool and a wall of access-denied.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub available: bool,
    pub elevated: bool,
    pub capturing: bool,
    pub note: String,
    /// The command line of the capture that is already running, so a tool
    /// opened onto one shows what it is watching rather than an empty footer.
    pub command: String,
}

/// A capture filter, as the panel on the left holds it. `kind` is one of
/// `port`, `ip`, `proto` or `not`.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub kind: String,
    pub value: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct StartOptions {
    pub filters: Vec<Filter>,
    /// Component ids to capture on. Empty means every component.
    pub comps: Vec<u32>,
    /// Bytes kept from each frame. 0 keeps the whole thing.
    pub pkt_size: u32,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    /// The exact command line that was run, so the footer is never a
    /// reconstruction of what we think we did.
    pub command: String,
    /// Filters that were pushed into pktmon, in the order they were added.
    pub applied: Vec<String>,
    /// Filters the front end has to apply itself because pktmon cannot express
    /// them — exclusions, and the protocols that are really port numbers.
    pub display_only: Vec<String>,
}

/// Throughput and the health of the capture, once a second.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Rate {
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub frames: u64,
    /// Frames pktmon printed that this module could not make a row out of.
    /// Shown rather than swallowed: a parser that silently dropped half the
    /// capture would be worse than no capture at all.
    pub unparsed: u64,
    pub kept: usize,
    /// Bytes of captured packet currently held in the ring.
    pub held: u64,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Exported {
    pub path: String,
    pub frames: usize,
    pub bytes: u64,
    /// Whether any frame was written shorter than it was on the wire, because
    /// pktmon truncated it to the capture size.
    pub truncated: bool,
}

/* -------------------------------------------------------------- the session */

struct Session {
    child: Option<Child>,
    ring: Vec<Frame>,
    next_id: u64,
    held: u64,
    unparsed: u64,
    bytes_in: u64,
    bytes_out: u64,
    command: String,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            child: None,
            ring: Vec::new(),
            next_id: 1,
            held: 0,
            unparsed: 0,
            bytes_in: 0,
            bytes_out: 0,
            command: String::new(),
        }
    }
}

fn session() -> &'static Mutex<Session> {
    static SESSION: OnceLock<Mutex<Session>> = OnceLock::new();
    SESSION.get_or_init(|| Mutex::new(Session::default()))
}

/// Set while a capture thread should keep going. Stopping clears it, and the
/// reader notices on its next line rather than being killed mid-frame.
static RUNNING: AtomicBool = AtomicBool::new(false);

/// Bumped by every start. A reader left over from a session that has already
/// been replaced sees a stale token and retires quietly, exactly as the folder
/// scan's workers do.
static TOKEN: AtomicU64 = AtomicU64::new(0);

pub fn is_capturing() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

/* ----------------------------------------------------------- running pktmon */

fn pktmon() -> Command {
    let mut cmd = Command::new("pktmon.exe");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Runs a pktmon subcommand to completion and hands back everything it said.
/// pktmon reports refusals on stdout with a zero exit code, so the text is
/// what matters here, not the status.
fn pktmon_say(args: &[&str]) -> Result<String, String> {
    let out = pktmon()
        .args(args)
        .output()
        .map_err(|e| format!("Could not run pktmon: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    if text.contains("Access is denied") {
        return Err(ACCESS_DENIED.into());
    }
    Ok(text)
}

const ACCESS_DENIED: &str =
    "pktmon needs administrator rights. Restart DevHQ as an administrator to capture.";

fn pktmon_exists() -> bool {
    if PathBuf::from(r"C:\Windows\System32\pktmon.exe").exists() {
        return true;
    }
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join("pktmon.exe").exists()))
        .unwrap_or(false)
}

/// Whether pktmon is on this machine at all, and whether it will talk to us.
/// Asked once when the tool is opened, so the page can say what is wrong before
/// the user presses a button that was never going to work.
pub fn capability() -> Capability {
    if !cfg!(windows) {
        return Capability {
            note: "Packet capture is a Windows feature — pktmon is not available here.".into(),
            ..Capability::default()
        };
    }
    if !pktmon_exists() {
        return Capability {
            elevated: crate::dns::is_elevated(),
            note: "pktmon.exe was not found. It ships with Windows 10 1809 and later.".into(),
            ..Capability::default()
        };
    }
    match pktmon_say(&["status"]) {
        Ok(_) => Capability {
            available: true,
            elevated: true,
            capturing: is_capturing(),
            note: String::new(),
            command: command_line(),
        },
        Err(note) => Capability {
            available: true,
            elevated: crate::dns::is_elevated(),
            note,
            ..Capability::default()
        },
    }
}

/* --------------------------------------------------------------- components */

/// Every packet processing component pktmon can see. Parsed from `pktmon list`,
/// whose columns are the id, the name, and a driver/MAC tail that varies by
/// component type — so the id and the name are taken positionally and the rest
/// is kept verbatim as the second line rather than guessed at.
pub fn components() -> Result<Vec<Component>, String> {
    let text = pktmon_say(&["list"])?;
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Rows start with the component id. Anything else is a heading, a rule
        // or the "Packet Processing Components" banner.
        let Some((id_text, rest)) = trimmed.split_once(char::is_whitespace) else {
            continue;
        };
        let Ok(id) = id_text.trim().parse::<u32>() else {
            continue;
        };
        let rest = rest.trim();
        // pktmon pads its columns, so two or more spaces is the column break
        // between the name and whatever follows it.
        let (name, detail) = match rest.find("  ") {
            Some(at) => (rest[..at].trim(), rest[at..].trim()),
            None => (rest, ""),
        };
        out.push(Component {
            id,
            name: name.to_string(),
            detail: detail.to_string(),
            kind: component_kind(name).to_string(),
        });
    }
    Ok(out)
}

fn component_kind(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.contains("loopback") {
        "loopback"
    } else if lower.contains("vethernet") || lower.contains("switch") {
        "vswitch"
    } else if lower.contains("miniport")
        || lower.contains("nic")
        || lower.contains("ethernet")
        || lower.contains("wi-fi")
        || lower.contains("wireless")
    {
        "nic"
    } else {
        "other"
    }
}

/* ------------------------------------------------------------------ filters */

/// Turns one of the tool's filters into the `pktmon filter add` arguments for
/// it. Some come back as `None`: a pktmon filter says what to *keep*, so there
/// is no way to phrase "everything but mDNS" as one, and TLS or HTTP are port
/// numbers rather than transports. Those are applied by the front end over
/// what arrives, and the tool says so rather than pretending they went to the
/// driver.
fn filter_args(filter: &Filter) -> Option<Vec<String>> {
    let value = filter.value.trim();
    if value.is_empty() {
        return None;
    }
    match filter.kind.as_str() {
        "port" => {
            let port: u16 = value.parse().ok()?;
            Some(vec!["-p".into(), port.to_string()])
        }
        "ip" => {
            // A bare address and CIDR are both taken by pktmon as they are; a
            // value that is neither is not worth sending.
            let head = value.split('/').next().unwrap_or(value);
            head.parse::<std::net::IpAddr>().ok()?;
            Some(vec!["-i".into(), value.to_string()])
        }
        "proto" => match value.to_ascii_uppercase().as_str() {
            "TCP" => Some(vec!["-t".into(), "TCP".into()]),
            "UDP" => Some(vec!["-t".into(), "UDP".into()]),
            "ICMP" => Some(vec!["-t".into(), "ICMP".into()]),
            "ICMPV6" => Some(vec!["-t".into(), "ICMPv6".into()]),
            _ => None,
        },
        _ => None,
    }
}

fn clear_filters() {
    let _ = pktmon_say(&["filter", "remove"]);
}

/* ------------------------------------------------------------ owning process */

/// port -> (pid, process name) for every socket this machine has open, both
/// listening and established. Frames are attributed by looking up whichever of
/// their two ports we recognise.
fn owner_map() -> HashMap<u16, (u32, String)> {
    let mut names: HashMap<u32, String> = HashMap::new();
    if let Some(text) = crate::util::run_lossy("tasklist", &["/fo", "csv", "/nh"], None) {
        for line in text.lines() {
            // "name.exe","1234","Console","1","12,345 K"
            let mut cells = line.split("\",\"");
            let (Some(name), Some(pid)) = (cells.next(), cells.next()) else {
                continue;
            };
            if let Ok(pid) = pid.trim_matches('"').trim().parse::<u32>() {
                names.insert(pid, name.trim_matches('"').to_string());
            }
        }
    }
    let mut map = HashMap::new();
    let Some(text) = crate::util::run_lossy("netstat", &["-ano"], None) else {
        return map;
    };
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 4 {
            continue;
        }
        let protocol = fields[0].to_ascii_uppercase();
        if protocol != "TCP" && protocol != "UDP" {
            continue;
        }
        let Ok(pid) = fields[fields.len() - 1].parse::<u32>() else {
            continue;
        };
        let Some((_, port_text)) = fields[1].rsplit_once(':') else {
            continue;
        };
        let Ok(port) = port_text.parse::<u16>() else {
            continue;
        };
        let name = names.get(&pid).cloned().unwrap_or_default();
        // First writer wins: a listening socket names the port better than an
        // ephemeral connection that happens to share the number.
        map.entry(port).or_insert((pid, name));
    }
    map
}

/* -------------------------------------------------------------- the parser */

/// pktmon prints one header line per frame and indents the decoded layers
/// underneath it. The reader accumulates those lines and hands the whole block
/// here once the next header — or the end of the stream — arrives.
///
/// Every field is optional on purpose. pktmon's output varies with the flags,
/// the Windows build and the protocol, and a frame that only yielded a
/// direction and a transport is still worth a row; a parser that insisted on
/// the full shape would show nothing at all on the first build that moved a
/// column.
fn parse_block(lines: &[String]) -> Option<Frame> {
    let head = lines.first()?;
    if !head.contains("PktGroupId") && !head.contains("Direction") {
        return None;
    }
    let mut frame = Frame::default();

    // The time is the first token, when it looks like a clock.
    if let Some(first) = head.split_whitespace().next() {
        if first.contains(':') {
            // pktmon prints seven fractional digits; the row wants three.
            frame.time = match first.split_once('.') {
                Some((clock, frac)) => format!("{clock}.{}", &frac[..frac.len().min(3)]),
                None => first.to_string(),
            };
        }
    }
    frame.dir = if head.contains("Direction Rx") || head.contains("Direction: Rx") {
        "in".into()
    } else {
        "out".into()
    };
    frame.comp = field_after(head, "Component")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    // The header of a real-time frame carries no total length, so the length
    // is taken from the outermost layer that reports one — the IP header's,
    // where there is one, rather than the transport's payload length.
    frame.len = field_after(head, "Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let mut hex = String::new();
    for line in &lines[1..] {
        let body = line.trim();
        if body.is_empty() {
            continue;
        }
        // A run of hex byte pairs is the raw packet, not a decoded layer.
        if is_hex_dump(body) {
            hex.push_str(&hex_bytes(body));
            continue;
        }
        let Some((label, rest)) = body.split_once(':') else {
            continue;
        };
        let (label, rest) = (label.trim(), rest.trim());
        if frame.len == 0 {
            if let Some(len) = field_after(rest, "Length").and_then(|v| v.parse().ok()) {
                frame.len = len;
            }
        }
        match label {
            "MAC" => {
                let (a, b) = arrow_pair(rest);
                let ether = after_comma(rest);
                frame.layers.push(Layer {
                    name: "Ethernet II".into(),
                    summary: ether.clone(),
                    fields: vec![
                        ["Source".into(), a],
                        ["Destination".into(), b],
                        ["EtherType".into(), ether],
                    ],
                });
            }
            "IPv4" | "IPv6" => {
                let (a, b) = arrow_pair(rest);
                frame.src = a.clone();
                frame.dst = b.clone();
                frame.transport = field_after(rest, "Next Protocol").unwrap_or_default();
                frame.layers.push(Layer {
                    name: label.into(),
                    summary: format!("{a} → {b}"),
                    fields: vec![
                        ["Source".into(), a],
                        ["Destination".into(), b],
                        ["Next protocol".into(), frame.transport.clone()],
                    ],
                });
            }
            "TCP" | "UDP" => {
                let (a, b) = arrow_pair(rest);
                frame.src_port = a.parse().unwrap_or(0);
                frame.dst_port = b.parse().unwrap_or(0);
                if frame.transport.is_empty() {
                    frame.transport = label.into();
                }
                let tail = after_comma(rest);
                if !tail.is_empty() {
                    frame.info = tail.clone();
                }
                frame.layers.push(Layer {
                    name: label.into(),
                    summary: tail.clone(),
                    fields: vec![
                        ["Source port".into(), a],
                        ["Dest port".into(), b],
                        ["Detail".into(), tail],
                    ],
                });
            }
            "ICMP" | "ICMPv6" | "ARP" => {
                frame.transport = label.into();
                frame.info = rest.to_string();
                frame.layers.push(Layer {
                    name: label.into(),
                    summary: rest.to_string(),
                    fields: vec![["Detail".into(), rest.to_string()]],
                });
            }
            _ => {}
        }
    }

    // Nothing said how long it was, so what we kept is all we can claim.
    if frame.len == 0 {
        frame.len = (hex.len() / 2) as u32;
    }
    frame.bytes = hex;
    frame.proto = display_proto(&frame);
    if frame.proto.is_empty() {
        // Nothing at all was recognised. Counted as unparsed rather than shown
        // as an empty row.
        return None;
    }
    Some(frame)
}

/// The pill on the row. The transport is the truth, but "TCP to 443" is worth
/// saying as TLS: it is what the row is actually about.
fn display_proto(frame: &Frame) -> String {
    let ports = [frame.src_port, frame.dst_port];
    let has = |p: u16| ports.contains(&p);
    match frame.transport.to_ascii_uppercase().as_str() {
        "TCP" => {
            if has(443) || has(8443) {
                "TLS".into()
            } else if has(80) || has(8080) || has(8000) || has(3000) || has(5173) {
                "HTTP".into()
            } else if has(53) {
                "DNS".into()
            } else {
                "TCP".into()
            }
        }
        "UDP" => {
            if has(5353) {
                "mDNS".into()
            } else if has(53) {
                "DNS".into()
            } else if has(443) {
                "QUIC".into()
            } else {
                "UDP".into()
            }
        }
        "" => String::new(),
        other => other.to_string(),
    }
}

/// `a > b` or `a -> b`, which pktmon uses for both address and port pairs.
fn arrow_pair(text: &str) -> (String, String) {
    let head = text.split(',').next().unwrap_or(text);
    let pair = head.split_once("->").or_else(|| head.split_once('>'));
    match pair {
        Some((a, b)) => (a.trim().to_string(), b.trim().to_string()),
        None => (head.trim().to_string(), String::new()),
    }
}

/// Everything after the first comma, which is where pktmon puts the part of a
/// layer that is not the pair — the ethertype, the length, the flags.
fn after_comma(text: &str) -> String {
    text.split_once(',')
        .map(|(_, rest)| rest.trim().to_string())
        .unwrap_or_default()
}

/// The token after `label`, with a `:` between the two tolerated and the value
/// ended by a comma, a bracket or a space. `Component 15,` gives `15`.
fn field_after(text: &str, label: &str) -> Option<String> {
    let at = text.find(label)?;
    let rest = text[at + label.len()..].trim_start();
    let rest = rest.strip_prefix(':').unwrap_or(rest).trim_start();
    let end = rest
        .find(|c: char| c == ',' || c == '(' || c.is_whitespace())
        .unwrap_or(rest.len());
    let value = rest[..end].trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// A hex dump row: mostly two-character hex groups. The leading offset and the
/// trailing ASCII gutter are both tolerated, and dropped by `hex_bytes`.
fn is_hex_dump(line: &str) -> bool {
    let body = line.split("  ").next().unwrap_or(line);
    let groups: Vec<&str> = body.split_whitespace().collect();
    if groups.len() < 4 {
        return false;
    }
    let hexish = groups.iter().filter(|g| is_hex_pair(g)).count();
    // A decoded line has a label and punctuation in it; a dump is very nearly
    // all pairs. Three quarters tells the two apart without being brittle
    // about an offset column at the front.
    hexish * 4 >= groups.len() * 3
}

fn is_hex_pair(group: &str) -> bool {
    group.len() == 2 && group.bytes().all(|b| b.is_ascii_hexdigit())
}

fn hex_bytes(line: &str) -> String {
    let body = line.split("  ").next().unwrap_or(line);
    body.split_whitespace()
        .filter(|g| is_hex_pair(g))
        .map(|g| g.to_ascii_uppercase())
        .collect()
}

/* ---------------------------------------------------------- start and stop */

/// Starts a capture. Filters go in first — pktmon applies them in the driver,
/// so a filtered session costs nothing for the frames it drops — then pktmon is
/// spawned in real-time mode and a thread reads its output.
///
/// Returns as soon as the child is up. Everything after that arrives as
/// `net:frames`, `net:rate` and `net:ended` events.
pub fn start(app: AppHandle, options: StartOptions) -> Result<Started, String> {
    if is_capturing() {
        return Err("A capture is already running.".into());
    }
    // A session left behind by a crash would refuse this one.
    let _ = pktmon_say(&["stop"]);
    clear_filters();

    let mut applied = Vec::new();
    let mut display_only = Vec::new();
    for filter in &options.filters {
        match filter_args(filter) {
            Some(args) => {
                let name = format!("devhq-{}-{}", filter.kind, applied.len());
                let mut call: Vec<&str> = vec!["filter", "add", name.as_str()];
                call.extend(args.iter().map(String::as_str));
                if let Err(err) = pktmon_say(&call) {
                    clear_filters();
                    return Err(err);
                }
                applied.push(format!("{} {}", filter.kind, filter.value));
            }
            None => display_only.push(format!("{} {}", filter.kind, filter.value)),
        }
    }

    let mut args: Vec<String> = vec![
        "start".into(),
        "--capture".into(),
        "--pkt-size".into(),
        options.pkt_size.to_string(),
        // 0x1F keeps the raw packet (0x010) along with the summaries. Without
        // the raw packet there is nothing to put in the byte view and nothing
        // a pcapng could hold.
        "--flags".into(),
        "0x1F".into(),
        "--log-mode".into(),
        "real-time".into(),
    ];
    if !options.comps.is_empty() {
        args.push("--comp".into());
        args.extend(options.comps.iter().map(|c| c.to_string()));
    }
    let command = format!("pktmon {}", args.join(" "));

    let mut child = pktmon()
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start pktmon: {e}"))?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        clear_filters();
        return Err("pktmon produced no output to read.".into());
    };

    let token = TOKEN.fetch_add(1, Ordering::SeqCst) + 1;
    RUNNING.store(true, Ordering::SeqCst);
    {
        let mut session = session().lock().unwrap();
        session.child = Some(child);
        session.command = command.clone();
        session.unparsed = 0;
        session.bytes_in = 0;
        session.bytes_out = 0;
    }

    std::thread::spawn(move || read_frames(app, token, stdout));

    Ok(Started {
        command,
        applied,
        display_only,
    })
}

/// The reader thread. It owns the pipe for the life of the session and does
/// every expensive thing a frame needs — parsing, attribution, the ring — so
/// the UI thread only ever sees a finished batch.
fn read_frames(app: AppHandle, token: u64, stdout: std::process::ChildStdout) {
    let mut reader = BufReader::new(stdout);
    let mut block: Vec<String> = Vec::new();
    let mut batch: Vec<Frame> = Vec::new();
    let mut owners = owner_map();
    let mut owners_read = Instant::now();
    let mut flushed = Instant::now();
    let mut rated = Instant::now();
    let mut line = String::new();

    let current =
        |token: u64| TOKEN.load(Ordering::SeqCst) == token && RUNNING.load(Ordering::SeqCst);

    while current(token) {
        line.clear();
        // A pipe carrying packet dumps is not guaranteed to be UTF-8; a lossy
        // read would be nicer, but a line that will not decode is rare enough
        // that dropping it beats stopping the capture.
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => continue,
        }
        let is_head = line.contains("PktGroupId") || line.contains("Direction ");
        if is_head && !block.is_empty() {
            finish_block(&mut block, &owners, &mut batch);
        }
        if is_head || !block.is_empty() {
            block.push(line.trim_end().to_string());
        }

        if owners_read.elapsed() >= Duration::from_millis(OWNERS_MS) {
            owners = owner_map();
            owners_read = Instant::now();
        }
        if batch.len() >= BATCH || flushed.elapsed() >= Duration::from_millis(BATCH_MS) {
            flush(&app, token, &mut batch);
            flushed = Instant::now();
        }
        if rated.elapsed() >= Duration::from_secs(1) {
            emit_rate(&app);
            rated = Instant::now();
        }
    }

    if !block.is_empty() {
        finish_block(&mut block, &owners, &mut batch);
    }
    flush(&app, token, &mut batch);
    emit_rate(&app);
    if current(token) {
        // pktmon ended on its own — the driver was unloaded, or the session was
        // stopped from outside. The tool must not go on claiming to capture.
        RUNNING.store(false, Ordering::SeqCst);
        let _ = app.emit("net:ended", "pktmon stopped on its own.");
    }
}

/// Parses one accumulated block, attributes it and files it in the ring.
fn finish_block(
    block: &mut Vec<String>,
    owners: &HashMap<u16, (u32, String)>,
    batch: &mut Vec<Frame>,
) {
    let parsed = parse_block(block);
    block.clear();
    let mut session = session().lock().unwrap();
    let Some(mut frame) = parsed else {
        session.unparsed += 1;
        return;
    };
    frame.id = session.next_id;
    session.next_id += 1;
    // The local end is whichever port we recognise. A frame between two
    // machines that are both not us attributes to nothing, which is correct.
    for port in [frame.src_port, frame.dst_port] {
        if port == 0 {
            continue;
        }
        if let Some((pid, name)) = owners.get(&port) {
            frame.pid = *pid;
            frame.process = name.clone();
            break;
        }
    }
    if frame.dir == "in" {
        session.bytes_in += frame.len as u64;
    } else {
        session.bytes_out += frame.len as u64;
    }
    session.held += (frame.bytes.len() / 2) as u64;
    if session.ring.len() >= RING {
        let dropped = session.ring.remove(0);
        session.held = session
            .held
            .saturating_sub((dropped.bytes.len() / 2) as u64);
    }
    session.ring.push(frame.clone());
    batch.push(frame);
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FrameBatch {
    token: u64,
    frames: Vec<Frame>,
}

fn flush(app: &AppHandle, token: u64, batch: &mut Vec<Frame>) {
    if batch.is_empty() {
        return;
    }
    let frames = std::mem::take(batch);
    let _ = app.emit("net:frames", FrameBatch { token, frames });
}

fn emit_rate(app: &AppHandle) {
    let _ = app.emit("net:rate", rate());
}

/// Stops the capture and takes the filters back out. Leaving filters installed
/// would quietly change what any other pktmon session on this machine sees.
pub fn stop() -> Result<String, String> {
    RUNNING.store(false, Ordering::SeqCst);
    TOKEN.fetch_add(1, Ordering::SeqCst);
    {
        let mut session = session().lock().unwrap();
        if let Some(mut child) = session.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    let _ = pktmon_say(&["stop"]);
    clear_filters();
    let kept = session().lock().unwrap().ring.len();
    Ok(format!("{kept} frames held"))
}

/// Empties the ring without touching the capture. What has already been shown
/// goes; what arrives next still arrives.
pub fn clear() {
    let mut session = session().lock().unwrap();
    session.ring.clear();
    session.held = 0;
    session.bytes_in = 0;
    session.bytes_out = 0;
    session.unparsed = 0;
}

/// The most recent frames in the ring. Used when the tool is opened onto a
/// capture that was already running, so the page is never blank over a session
/// that has been collecting for an hour.
pub fn backlog(limit: usize) -> Vec<Frame> {
    let session = session().lock().unwrap();
    let start = session.ring.len().saturating_sub(limit);
    session.ring[start..].to_vec()
}

pub fn rate() -> Rate {
    let session = session().lock().unwrap();
    Rate {
        bytes_in: session.bytes_in,
        bytes_out: session.bytes_out,
        frames: session.next_id.saturating_sub(1),
        unparsed: session.unparsed,
        kept: session.ring.len(),
        held: session.held,
    }
}

pub fn command_line() -> String {
    session().lock().unwrap().command.clone()
}

/* ----------------------------------------------------------------- pcapng */

/// Where captures go, unless the caller names somewhere else.
pub fn capture_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("DevHQ")
        .join("captures")
}

/// Every pcapng block is length-prefixed and length-suffixed, and padded to a
/// multiple of four.
fn block(out: &mut Vec<u8>, kind: u32, body: &[u8]) {
    let pad = (4 - body.len() % 4) % 4;
    let total = (12 + body.len() + pad) as u32;
    out.extend_from_slice(&kind.to_le_bytes());
    out.extend_from_slice(&total.to_le_bytes());
    out.extend_from_slice(body);
    out.extend(std::iter::repeat(0u8).take(pad));
    out.extend_from_slice(&total.to_le_bytes());
}

fn option(out: &mut Vec<u8>, code: u16, value: &[u8]) {
    out.extend_from_slice(&code.to_le_bytes());
    out.extend_from_slice(&(value.len() as u16).to_le_bytes());
    out.extend_from_slice(value);
    out.extend(std::iter::repeat(0u8).take((4 - value.len() % 4) % 4));
}

fn end_options(out: &mut Vec<u8>) {
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
}

/// Writes the ring out as pcapng — the format Wireshark opens without being
/// told anything about it. Written here rather than handed to `pktmon
/// etl2pcap` because a real-time session has no .etl to convert: these are the
/// bytes exactly as they were captured, and nothing is invented on the way out.
pub fn export(path: Option<String>) -> Result<Exported, String> {
    let frames = session().lock().unwrap().ring.clone();
    let with_bytes: Vec<&Frame> = frames.iter().filter(|f| !f.bytes.is_empty()).collect();
    if with_bytes.is_empty() {
        return Err(if frames.is_empty() {
            "There are no captured frames to export yet.".into()
        } else {
            "None of the captured frames carry raw bytes, so there is nothing for a pcapng to \
             hold. Capture with a packet size above 0 and try again."
                .to_string()
        });
    }

    let target = match path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => {
            let dir = capture_dir();
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            dir.join(format!("devhq-{stamp}.pcapng"))
        }
    };

    let mut out: Vec<u8> = Vec::with_capacity(with_bytes.len() * 160);

    // Section header: little endian, version 1.0, section length unknown.
    let mut shb = Vec::new();
    shb.extend_from_slice(&0x1A2B_3C4Du32.to_le_bytes());
    shb.extend_from_slice(&1u16.to_le_bytes());
    shb.extend_from_slice(&0u16.to_le_bytes());
    shb.extend_from_slice(&(-1i64).to_le_bytes());
    option(&mut shb, 4, b"DevHQ network watcher"); // shb_userappl
    end_options(&mut shb);
    block(&mut out, 0x0A0D_0D0A, &shb);

    // One interface, Ethernet, microsecond resolution (the pcapng default).
    let mut idb = Vec::new();
    idb.extend_from_slice(&1u16.to_le_bytes()); // LINKTYPE_ETHERNET
    idb.extend_from_slice(&0u16.to_le_bytes());
    idb.extend_from_slice(&0u32.to_le_bytes()); // no snap length declared
    option(&mut idb, 2, b"pktmon"); // if_name
    end_options(&mut idb);
    block(&mut out, 0x0000_0001, &idb);

    let mut written = 0usize;
    let mut truncated = false;
    // pktmon's real-time clock is a time of day with no date on it. The frames
    // are stamped in order from now, so the ordering and the deltas hold even
    // though the absolute stamp is this machine's clock at export.
    let base = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0);
    for (index, frame) in with_bytes.iter().enumerate() {
        let bytes = decode_hex(&frame.bytes);
        if bytes.is_empty() {
            continue;
        }
        let original = frame.len.max(bytes.len() as u32);
        if (bytes.len() as u32) < original {
            truncated = true;
        }
        let stamp = base + index as u64;
        let mut epb = Vec::new();
        epb.extend_from_slice(&0u32.to_le_bytes()); // interface 0
        epb.extend_from_slice(&((stamp >> 32) as u32).to_le_bytes());
        epb.extend_from_slice(&((stamp & 0xFFFF_FFFF) as u32).to_le_bytes());
        epb.extend_from_slice(&(bytes.len() as u32).to_le_bytes()); // captured
        epb.extend_from_slice(&original.to_le_bytes()); // on the wire
        epb.extend_from_slice(&bytes);
        epb.extend(std::iter::repeat(0u8).take((4 - bytes.len() % 4) % 4));
        end_options(&mut epb);
        block(&mut out, 0x0000_0006, &epb);
        written += 1;
    }

    std::fs::File::create(&target)
        .and_then(|mut file| file.write_all(&out))
        .map_err(|e| format!("Could not write {}: {e}", target.display()))?;

    Ok(Exported {
        path: target.to_string_lossy().into_owned(),
        frames: written,
        bytes: out.len() as u64,
        truncated,
    })
}

fn decode_hex(text: &str) -> Vec<u8> {
    text.as_bytes()
        .chunks(2)
        .filter(|pair| pair.len() == 2)
        .filter_map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect()
}

/* --------------------------------------------------------------- teardown */

/// Called when the window goes away. A pktmon session outliving the app would
/// keep filtering this machine's traffic with nothing left to show for it.
pub fn shutdown() {
    if is_capturing() {
        let _ = stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_of(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|l| l.to_string()).collect()
    }

    #[test]
    fn parses_a_udp_frame() {
        let frame = parse_block(&block_of(&[
            "02:23:36.5990000 PktGroupId 3162, PktNumber 1, Appearance 1, Direction Tx, Type Ethernet, Component 15, Edge 1(Miniport Nbl-Tx)",
            "  MAC: 00:15:5d:6c:6d:6f > 00:15:5d:6c:6d:70, EtherType: IPv4",
            "  IPv4: 172.30.176.1 > 172.30.191.255, Next Protocol: UDP",
            "  UDP: 137 > 137, Length: 58",
        ]))
        .expect("a frame");
        assert_eq!(frame.time, "02:23:36.599");
        assert_eq!(frame.dir, "out");
        assert_eq!(frame.comp, 15);
        assert_eq!(frame.src, "172.30.176.1");
        assert_eq!(frame.dst, "172.30.191.255");
        assert_eq!(frame.src_port, 137);
        assert_eq!(frame.dst_port, 137);
        assert_eq!(frame.transport, "UDP");
        assert_eq!(frame.proto, "UDP");
        // No layer but UDP reported a length, so that is the one used.
        assert_eq!(frame.len, 58);
        assert_eq!(frame.layers.len(), 3);
    }

    #[test]
    fn refines_the_protocol_by_port() {
        let frame = parse_block(&block_of(&[
            "10:42:07.1180000 PktGroupId 1, Direction Rx, Component 14",
            "  IPv4: 76.76.21.21 > 192.168.1.24, Next Protocol: TCP",
            "  TCP: 443 > 54120, Flags: ACK",
        ]))
        .expect("a frame");
        assert_eq!(frame.dir, "in");
        assert_eq!(frame.proto, "TLS");
        assert_eq!(frame.transport, "TCP");
        assert_eq!(frame.info, "Flags: ACK");
    }

    #[test]
    fn keeps_the_raw_bytes() {
        let frame = parse_block(&block_of(&[
            "10:42:07.1180000 PktGroupId 1, Direction Tx, Component 1",
            "  IPv4: 127.0.0.1 > 127.0.0.1, Next Protocol: TCP",
            "  TCP: 3000 > 54121, Flags: PSH ACK",
            "  45 00 00 3c 1c 46 40 00 40 06 b1 e6   E..<.F@.@...",
        ]))
        .expect("a frame");
        assert_eq!(frame.bytes, "4500003C1C46400040 06B1E6".replace(' ', ""));
        assert_eq!(decode_hex(&frame.bytes).len(), 12);
        assert_eq!(frame.proto, "HTTP");
    }

    #[test]
    fn an_unrecognised_block_is_not_a_frame() {
        assert!(parse_block(&block_of(&["Packet Monitor started."])).is_none());
        assert!(parse_block(&block_of(&[
            "10:42:07.1180000 PktGroupId 1, Direction Tx, Component 1",
            "  Something nobody has ever printed",
        ]))
        .is_none());
    }

    #[test]
    fn hex_rows_are_told_from_decoded_ones() {
        assert!(is_hex_dump("45 00 00 3c 1c 46 40 00"));
        assert!(!is_hex_dump("IPv4: 172.30.176.1 > 172.30.191.255"));
        assert!(!is_hex_dump("TCP: 137 > 137, Length: 58"));
        assert!(!is_hex_dump("MAC: 00:15:5d:6c:6d:6f > 00:15:5d:6c:6d:70"));
    }

    #[test]
    fn only_the_filters_pktmon_understands_reach_it() {
        let f = |kind: &str, value: &str| Filter {
            kind: kind.into(),
            value: value.into(),
        };
        assert_eq!(
            filter_args(&f("port", "3000")),
            Some(vec!["-p".to_string(), "3000".to_string()])
        );
        assert_eq!(
            filter_args(&f("ip", "10.0.0.9")),
            Some(vec!["-i".to_string(), "10.0.0.9".to_string()])
        );
        assert_eq!(
            filter_args(&f("proto", "tcp")),
            Some(vec!["-t".to_string(), "TCP".to_string()])
        );
        // TLS is a port, not a transport, and an exclusion is not something a
        // capture filter can say at all.
        assert!(filter_args(&f("proto", "tls")).is_none());
        assert!(filter_args(&f("not", "mdns")).is_none());
        assert!(filter_args(&f("ip", "not-an-ip")).is_none());
        assert!(filter_args(&f("port", "99999")).is_none());
    }

    #[test]
    fn a_pcapng_is_well_formed() {
        let mut out = Vec::new();
        block(&mut out, 0x0000_0006, &[1, 2, 3]);
        // 12 bytes of frame plus 3 of body, padded to 4.
        assert_eq!(out.len(), 16);
        assert_eq!(u32::from_le_bytes(out[4..8].try_into().unwrap()), 16);
        assert_eq!(u32::from_le_bytes(out[12..16].try_into().unwrap()), 16);
    }

    #[test]
    fn an_export_with_nothing_captured_says_so() {
        clear();
        assert!(export(None).is_err());
    }

    #[test]
    fn component_rows_are_told_from_headings() {
        assert_eq!(component_kind("Loopback Pseudo-Interface"), "loopback");
        assert_eq!(component_kind("vEthernet (WSL)"), "vswitch");
        assert_eq!(component_kind("Intel(R) Wi-Fi 6E AX211"), "nic");
        assert_eq!(component_kind("Something else entirely"), "other");
    }
}
