// The DNS tool: what a name resolves to, whether every resolver agrees, and
// what your own hosts file is saying behind their backs.
//
// The queries are spoken on the wire here rather than shelled out to
// `nslookup`. Parsing another program's localised output would cost us the
// TTLs, the response code and the timing, and every lookup would pay for a
// process launch — three things this tool is entirely about.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::time::{Duration, Instant};

/* ------------------------------------------------------------ record types */

/// The types the tool asks for, in the order the UI lists them. `PTR` is not
/// here: it is only ever reached through a reverse lookup, never asked for by
/// name alongside the rest.
pub const QUERY_TYPES: &[(&str, u16)] = &[
    ("A", 1),
    ("AAAA", 28),
    ("CNAME", 5),
    ("MX", 15),
    ("TXT", 16),
    ("NS", 2),
    ("SOA", 6),
    ("SRV", 33),
    ("CAA", 257),
];

fn type_code(name: &str) -> Option<u16> {
    let upper = name.to_ascii_uppercase();
    if upper == "PTR" {
        return Some(12);
    }
    QUERY_TYPES
        .iter()
        .find(|(n, _)| *n == upper)
        .map(|(_, c)| *c)
}

fn type_name(code: u16) -> String {
    match code {
        1 => "A".into(),
        2 => "NS".into(),
        5 => "CNAME".into(),
        6 => "SOA".into(),
        12 => "PTR".into(),
        15 => "MX".into(),
        16 => "TXT".into(),
        28 => "AAAA".into(),
        33 => "SRV".into(),
        257 => "CAA".into(),
        other => format!("TYPE{other}"),
    }
}

/// The public resolvers the comparison panel puts beside whatever Windows is
/// configured to use. Four is enough to tell "the world agrees" from "your
/// machine is looking at something nobody else can see".
const PUBLIC_RESOLVERS: &[(&str, &str)] = &[
    ("Cloudflare", "1.1.1.1"),
    ("Google", "8.8.8.8"),
    ("Quad9", "9.9.9.9"),
    ("OpenDNS", "208.67.222.222"),
];

/* ------------------------------------------------------------- the wire */

fn encode_name(name: &str, out: &mut Vec<u8>) -> Result<(), String> {
    for label in name.trim_end_matches('.').split('.') {
        if label.is_empty() {
            return Err("Empty label in the name".into());
        }
        if label.len() > 63 {
            return Err(format!("Label longer than 63 characters: {label}"));
        }
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
    Ok(())
}

fn build_query(id: u16, name: &str, qtype: u16) -> Result<Vec<u8>, String> {
    let mut msg = Vec::with_capacity(64);
    msg.extend_from_slice(&id.to_be_bytes());
    // Recursion desired, nothing else.
    msg.extend_from_slice(&0x0100u16.to_be_bytes());
    msg.extend_from_slice(&1u16.to_be_bytes()); // one question
    msg.extend_from_slice(&[0, 0, 0, 0, 0, 0]); // no answer/authority/extra
    encode_name(name, &mut msg)?;
    msg.extend_from_slice(&qtype.to_be_bytes());
    msg.extend_from_slice(&1u16.to_be_bytes()); // class IN
    Ok(msg)
}

fn be16(buf: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*buf.get(at)?, *buf.get(at + 1)?]))
}

fn be32(buf: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes([
        *buf.get(at)?,
        *buf.get(at + 1)?,
        *buf.get(at + 2)?,
        *buf.get(at + 3)?,
    ]))
}

/// Reads a name at `at`, following compression pointers. Returns the name and
/// the offset just past it in the *message* — a pointer ends the name, so that
/// is two bytes on from where the pointer started, not from where it led.
fn read_name(buf: &[u8], at: usize) -> Option<(String, usize)> {
    let mut labels: Vec<String> = Vec::new();
    let mut pos = at;
    let mut end: Option<usize> = None;
    // A malformed message can point in a circle; every hop is counted so a
    // reply can never spin us.
    let mut hops = 0;
    loop {
        let len = *buf.get(pos)? as usize;
        if len & 0xC0 == 0xC0 {
            let target = ((len & 0x3F) << 8) | *buf.get(pos + 1)? as usize;
            end.get_or_insert(pos + 2);
            hops += 1;
            if hops > 64 || target >= buf.len() {
                return None;
            }
            pos = target;
            continue;
        }
        if len == 0 {
            end.get_or_insert(pos + 1);
            break;
        }
        if len > 63 {
            return None;
        }
        let bytes = buf.get(pos + 1..pos + 1 + len)?;
        labels.push(String::from_utf8_lossy(bytes).into_owned());
        pos += 1 + len;
    }
    Some((labels.join("."), end?))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub rtype: String,
    pub name: String,
    pub value: String,
    pub ttl: u32,
    /// A short human hint about the value — "spf", "Vercel". Empty when there
    /// is nothing worth saying.
    pub note: String,
}

struct Response {
    rcode: u8,
    truncated: bool,
    answers: Vec<Record>,
}

fn rcode_text(code: u8) -> &'static str {
    match code {
        0 => "NOERROR",
        1 => "FORMERR",
        2 => "SERVFAIL",
        3 => "NXDOMAIN",
        4 => "NOTIMP",
        5 => "REFUSED",
        _ => "UNKNOWN",
    }
}

fn parse_response(buf: &[u8], want_id: u16) -> Result<Response, String> {
    if buf.len() < 12 {
        return Err("Reply was too short to be a DNS message".into());
    }
    if be16(buf, 0) != Some(want_id) {
        return Err("Reply did not match the question that was asked".into());
    }
    let flags = be16(buf, 2).unwrap_or(0);
    let rcode = (flags & 0x000F) as u8;
    let truncated = flags & 0x0200 != 0;
    let qd = be16(buf, 4).unwrap_or(0);
    let an = be16(buf, 6).unwrap_or(0);

    let mut pos = 12;
    for _ in 0..qd {
        let (_, next) = read_name(buf, pos).ok_or("Malformed question section")?;
        pos = next + 4;
    }

    let mut answers = Vec::new();
    for _ in 0..an {
        let (name, next) = read_name(buf, pos).ok_or("Malformed answer section")?;
        pos = next;
        let rtype = be16(buf, pos).ok_or("Truncated answer")?;
        let ttl = be32(buf, pos + 4).ok_or("Truncated answer")?;
        let rdlen = be16(buf, pos + 8).ok_or("Truncated answer")? as usize;
        let rdata_at = pos + 10;
        let rdata = buf
            .get(rdata_at..rdata_at + rdlen)
            .ok_or("Answer claimed more data than it carried")?;
        let value = read_rdata(buf, rdata_at, rdata, rtype);
        let rtype_name = type_name(rtype);
        let note = note_for(&rtype_name, &value);
        answers.push(Record {
            rtype: rtype_name,
            name,
            value,
            ttl,
            note,
        });
        pos = rdata_at + rdlen;
    }
    Ok(Response {
        rcode,
        truncated,
        answers,
    })
}

/// A name out of the message, written the way a zone file would: the root is
/// a lone dot rather than the empty string it is on the wire.
fn name_at(msg: &[u8], at: usize) -> String {
    match read_name(msg, at) {
        Some((name, _)) if name.is_empty() => ".".into(),
        Some((name, _)) => name,
        None => String::new(),
    }
}

fn read_rdata(msg: &[u8], at: usize, rdata: &[u8], rtype: u16) -> String {
    match rtype {
        1 if rdata.len() == 4 => Ipv4Addr::new(rdata[0], rdata[1], rdata[2], rdata[3]).to_string(),
        28 if rdata.len() == 16 => {
            let mut octets = [0u8; 16];
            octets.copy_from_slice(rdata);
            Ipv6Addr::from(octets).to_string()
        }
        2 | 5 | 12 => name_at(msg, at),
        15 => {
            let pref = be16(rdata, 0).unwrap_or(0);
            let host = name_at(msg, at + 2);
            format!("{pref} {host}")
        }
        16 => {
            // A TXT record is a sequence of length-prefixed chunks; a long
            // value arrives split at 255 bytes and means nothing until joined.
            let mut out = String::new();
            let mut i = 0;
            while i < rdata.len() {
                let len = rdata[i] as usize;
                let end = (i + 1 + len).min(rdata.len());
                out.push_str(&String::from_utf8_lossy(&rdata[i + 1..end]));
                i = end;
            }
            out
        }
        6 => {
            let Some((mname, after)) = read_name(msg, at) else {
                return String::new();
            };
            let Some((rname, after)) = read_name(msg, after) else {
                return mname;
            };
            let nums: Vec<String> = (0..5)
                .map(|i| be32(msg, after + i * 4).unwrap_or(0).to_string())
                .collect();
            format!("{mname} {rname} {}", nums.join(" "))
        }
        33 => {
            let prio = be16(rdata, 0).unwrap_or(0);
            let weight = be16(rdata, 2).unwrap_or(0);
            let port = be16(rdata, 4).unwrap_or(0);
            let target = name_at(msg, at + 6);
            format!("{prio} {weight} {port} {target}")
        }
        257 => {
            let flags = rdata.first().copied().unwrap_or(0);
            let taglen = rdata.get(1).copied().unwrap_or(0) as usize;
            let tag = String::from_utf8_lossy(rdata.get(2..2 + taglen).unwrap_or(&[])).into_owned();
            let value =
                String::from_utf8_lossy(rdata.get(2 + taglen..).unwrap_or(&[])).into_owned();
            format!("{flags} {tag} \"{value}\"")
        }
        _ => rdata
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .join(""),
    }
}

/// Well-known homes for a name, so a CNAME reads as "Vercel" rather than as a
/// string nobody recognises at a glance.
const HOSTS_OF_NOTE: &[(&str, &str)] = &[
    ("vercel-dns.com", "Vercel"),
    ("vercel.app", "Vercel"),
    ("github.io", "GitHub Pages"),
    ("netlify.app", "Netlify"),
    ("pages.dev", "Cloudflare Pages"),
    ("workers.dev", "Cloudflare Workers"),
    ("cloudfront.net", "CloudFront"),
    ("azurewebsites.net", "Azure App Service"),
    ("herokudns.com", "Heroku"),
    ("herokuapp.com", "Heroku"),
    ("fastly.net", "Fastly"),
    ("amazonaws.com", "AWS"),
    ("googlehosted.com", "Google"),
    ("aspmx.l.google.com", "Google Workspace"),
    ("protection.outlook.com", "Microsoft 365"),
    ("shopify.com", "Shopify"),
];

fn note_for(rtype: &str, value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    if rtype == "TXT" {
        if lower.starts_with("v=spf1") {
            return "spf".into();
        }
        if lower.starts_with("v=dmarc1") {
            return "dmarc".into();
        }
        if lower.contains("domainkey") || lower.starts_with("v=dkim1") {
            return "dkim".into();
        }
        if lower.contains("-site-verification") || lower.contains("-domain-verification") {
            return "verification".into();
        }
        return String::new();
    }
    for (suffix, label) in HOSTS_OF_NOTE {
        if lower.contains(suffix) {
            return (*label).to_string();
        }
    }
    String::new()
}

/* ------------------------------------------------------------- asking */

fn ask(server: IpAddr, name: &str, qtype: u16, timeout: Duration) -> Result<Response, String> {
    // The id is only ever checked against the reply on this one socket, so the
    // clock is a good enough source of one.
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u16)
        .unwrap_or(0)
        | 1;
    let msg = build_query(id, name, qtype)?;
    let bind: SocketAddr = if server.is_ipv6() {
        "[::]:0".parse().unwrap()
    } else {
        "0.0.0.0:0".parse().unwrap()
    };
    let socket = UdpSocket::bind(bind).map_err(|e| format!("Could not open a socket: {e}"))?;
    socket.set_read_timeout(Some(timeout)).ok();
    socket
        .send_to(&msg, SocketAddr::new(server, 53))
        .map_err(|e| format!("Could not reach {server}: {e}"))?;
    let mut buf = [0u8; 4096];
    let (len, _) = socket
        .recv_from(&mut buf)
        .map_err(|_| format!("{server} did not answer within {}ms", timeout.as_millis()))?;
    let parsed = parse_response(&buf[..len], id)?;
    if parsed.truncated {
        // Too big for a datagram — the same question over TCP gets all of it.
        return ask_tcp(server, &msg, id, timeout);
    }
    Ok(parsed)
}

fn ask_tcp(server: IpAddr, msg: &[u8], id: u16, timeout: Duration) -> Result<Response, String> {
    let mut stream = TcpStream::connect_timeout(&SocketAddr::new(server, 53), timeout)
        .map_err(|e| format!("Could not reach {server} over TCP: {e}"))?;
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(timeout)).ok();
    let mut framed = Vec::with_capacity(msg.len() + 2);
    framed.extend_from_slice(&(msg.len() as u16).to_be_bytes());
    framed.extend_from_slice(msg);
    stream
        .write_all(&framed)
        .map_err(|e| format!("TCP write failed: {e}"))?;
    let mut len_buf = [0u8; 2];
    stream
        .read_exact(&mut len_buf)
        .map_err(|e| format!("TCP read failed: {e}"))?;
    let len = u16::from_be_bytes(len_buf) as usize;
    let mut body = vec![0u8; len];
    stream
        .read_exact(&mut body)
        .map_err(|e| format!("TCP read failed: {e}"))?;
    parse_response(&body, id)
}

/* -------------------------------------------------- what Windows is using */

/// The resolvers this machine is configured to use, straight from the IP
/// helper — `ipconfig` says the same thing but says it in the user's language.
#[cfg(windows)]
pub fn system_resolvers() -> Vec<String> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetNetworkParams, FIXED_INFO_W2KSP1, IP_ADDR_STRING,
    };
    let mut out: Vec<String> = Vec::new();
    unsafe {
        let mut len: u32 = 0;
        // The first call only sizes the buffer; it is expected to "fail".
        let _ = GetNetworkParams(None, &mut len);
        if len == 0 {
            return out;
        }
        let mut buf = vec![0u8; len as usize];
        let info = buf.as_mut_ptr() as *mut FIXED_INFO_W2KSP1;
        if GetNetworkParams(Some(info), &mut len).0 != 0 {
            return out;
        }
        let mut node: *const IP_ADDR_STRING = &(*info).DnsServerList;
        while !node.is_null() {
            let text: String = (*node)
                .IpAddress
                .String
                .iter()
                .take_while(|c| **c != 0)
                .map(|c| *c as u8 as char)
                .collect();
            if !text.is_empty() && text != "0.0.0.0" && !out.contains(&text) {
                out.push(text);
            }
            node = (*node).Next;
        }
    }
    out
}

#[cfg(not(windows))]
pub fn system_resolvers() -> Vec<String> {
    Vec::new()
}

fn first_system_resolver() -> Option<IpAddr> {
    system_resolvers().iter().find_map(|s| s.parse().ok())
}

/* ---------------------------------------------------------- the lookups */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lookup {
    pub name: String,
    pub server: String,
    pub server_label: String,
    pub ms: u64,
    pub rcode: String,
    pub records: Vec<Record>,
    pub error: String,
}

fn resolver_for(server: &str) -> Result<(IpAddr, String), String> {
    if server.is_empty() || server == "system" {
        let ip =
            first_system_resolver().ok_or("Windows has no DNS server configured on any adapter")?;
        return Ok((ip, "System".into()));
    }
    let ip: IpAddr = server
        .parse()
        .map_err(|_| format!("{server} is not an IP address"))?;
    let label = PUBLIC_RESOLVERS
        .iter()
        .find(|(_, addr)| *addr == server)
        .map(|(name, _)| (*name).to_string())
        .unwrap_or_else(|| server.to_string());
    Ok((ip, label))
}

/// Every record type at once. They are independent questions, so they go out
/// on their own sockets in parallel and the whole lookup costs one round trip
/// rather than nine.
pub fn lookup(name: &str, server: &str, types: &[String]) -> Lookup {
    let name = name.trim().trim_end_matches('.').to_string();
    let (ip, label) = match resolver_for(server) {
        Ok(pair) => pair,
        Err(error) => {
            return Lookup {
                name,
                server: server.into(),
                server_label: String::new(),
                ms: 0,
                rcode: String::new(),
                records: Vec::new(),
                error,
            }
        }
    };
    let wanted: Vec<u16> = if types.is_empty() {
        QUERY_TYPES.iter().map(|(_, code)| *code).collect()
    } else {
        types.iter().filter_map(|t| type_code(t)).collect()
    };

    let started = Instant::now();
    let results: Vec<Result<Response, String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = wanted
            .iter()
            .map(|code| {
                let name = name.clone();
                let code = *code;
                scope.spawn(move || ask(ip, &name, code, Duration::from_millis(2500)))
            })
            .collect();
        handles
            .into_iter()
            .map(|h| {
                h.join()
                    .unwrap_or_else(|_| Err("The lookup did not finish".into()))
            })
            .collect()
    });

    let mut records: Vec<Record> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    // NXDOMAIN is the whole name's answer, not one type's, so it only counts
    // when nothing came back at all.
    let mut nxdomain = false;
    let mut any_ok = false;
    for result in results {
        match result {
            Ok(response) => {
                any_ok = true;
                if response.rcode == 3 {
                    nxdomain = true;
                } else if response.rcode != 0 && response.answers.is_empty() {
                    let text = rcode_text(response.rcode).to_string();
                    if !errors.contains(&text) {
                        errors.push(text);
                    }
                }
                records.extend(response.answers);
            }
            Err(error) => {
                if !errors.contains(&error) {
                    errors.push(error);
                }
            }
        }
    }
    records.sort_by(|a, b| {
        let rank = |r: &Record| {
            QUERY_TYPES
                .iter()
                .position(|(n, _)| *n == r.rtype)
                .unwrap_or(99)
        };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.value.cmp(&b.value))
    });
    // Asking for A and for CNAME both bring back the CNAME that was followed,
    // so the same answer can arrive twice. One row per distinct answer is what
    // a reader wants.
    records.dedup_by(|a, b| a.rtype == b.rtype && a.value == b.value && a.name == b.name);

    let rcode = if !records.is_empty() {
        "NOERROR".into()
    } else if nxdomain {
        "NXDOMAIN".into()
    } else if any_ok {
        "NOERROR".into()
    } else {
        String::new()
    };

    Lookup {
        name,
        server: ip.to_string(),
        server_label: label,
        ms: started.elapsed().as_millis() as u64,
        rcode,
        records,
        error: if any_ok {
            String::new()
        } else {
            errors.join(" · ")
        },
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolverAnswer {
    pub name: String,
    pub ip: String,
    pub answers: Vec<String>,
    pub ms: u64,
    pub rcode: String,
    pub error: String,
}

/// The same question put to the machine's own resolver and to four public ones
/// at the same time. Disagreement is the point: it is what tells a stale cache
/// or a hosts-file override from a change that has actually landed.
pub fn compare(name: &str, rtype: &str) -> Vec<ResolverAnswer> {
    let name = name.trim().trim_end_matches('.').to_string();
    let code = type_code(rtype).unwrap_or(1);
    let mut targets: Vec<(String, String)> = Vec::new();
    if let Some(ip) = first_system_resolver() {
        targets.push(("System".into(), ip.to_string()));
    }
    for (label, addr) in PUBLIC_RESOLVERS {
        if targets.iter().any(|(_, ip)| ip == addr) {
            continue;
        }
        targets.push(((*label).to_string(), (*addr).to_string()));
    }

    std::thread::scope(|scope| {
        let handles: Vec<_> = targets
            .iter()
            .map(|(label, addr)| {
                let name = name.clone();
                let label = label.clone();
                let addr = addr.clone();
                scope.spawn(move || {
                    let Ok(ip) = addr.parse::<IpAddr>() else {
                        return ResolverAnswer {
                            name: label,
                            ip: addr,
                            answers: Vec::new(),
                            ms: 0,
                            rcode: String::new(),
                            error: "Not an IP address".into(),
                        };
                    };
                    let started = Instant::now();
                    match ask(ip, &name, code, Duration::from_millis(2000)) {
                        Ok(response) => {
                            let mut answers: Vec<String> =
                                response.answers.iter().map(|r| r.value.clone()).collect();
                            answers.sort();
                            ResolverAnswer {
                                name: label,
                                ip: addr,
                                answers,
                                ms: started.elapsed().as_millis() as u64,
                                rcode: rcode_text(response.rcode).into(),
                                error: String::new(),
                            }
                        }
                        Err(error) => ResolverAnswer {
                            name: label,
                            ip: addr,
                            answers: Vec::new(),
                            ms: started.elapsed().as_millis() as u64,
                            rcode: String::new(),
                            error,
                        },
                    }
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
}

/// The name behind an address. Written out as the `.arpa` question the wire
/// actually carries, so the caller only has to hand over an IP.
pub fn reverse(address: &str) -> Lookup {
    let trimmed = address.trim();
    let query = match trimmed.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => {
            let o = v4.octets();
            format!("{}.{}.{}.{}.in-addr.arpa", o[3], o[2], o[1], o[0])
        }
        Ok(IpAddr::V6(v6)) => {
            let mut nibbles: Vec<String> = Vec::with_capacity(32);
            for byte in v6.octets().iter().rev() {
                nibbles.push(format!("{:x}", byte & 0x0F));
                nibbles.push(format!("{:x}", byte >> 4));
            }
            format!("{}.ip6.arpa", nibbles.join("."))
        }
        Err(_) => {
            return Lookup {
                name: trimmed.into(),
                server: String::new(),
                server_label: String::new(),
                ms: 0,
                rcode: String::new(),
                records: Vec::new(),
                error: format!("{trimmed} is not an IP address"),
            }
        }
    };
    let mut result = lookup(&query, "", &["PTR".to_string()]);
    result.name = query;
    result
}

/* --------------------------------------------------------- the hosts file */

pub fn hosts_path() -> PathBuf {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    PathBuf::from(root).join("System32\\drivers\\etc\\hosts")
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HostLine {
    /// Zero-based index into the file, which is how an edit names the line it
    /// means. Nothing else about a line is unique — the same mapping is
    /// allowed to appear twice.
    pub index: usize,
    /// "entry" for a mapping the file can switch on and off, "comment" for a
    /// line that is only prose, "blank" for an empty one.
    pub kind: String,
    pub enabled: bool,
    pub ip: String,
    pub names: Vec<String>,
    pub comment: String,
    pub raw: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostsFile {
    pub path: String,
    pub text: String,
    pub lines: Vec<HostLine>,
    pub writable: bool,
    pub elevated: bool,
    pub backups: Vec<Backup>,
    pub error: String,
}

fn parse_host_line(index: usize, raw: &str) -> HostLine {
    let mut line = HostLine {
        index,
        kind: "comment".into(),
        enabled: false,
        ip: String::new(),
        names: Vec::new(),
        comment: String::new(),
        raw: raw.to_string(),
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        line.kind = "blank".into();
        return line;
    }
    // A commented-out mapping is still a mapping — it is exactly what the
    // switch in the UI turns off — so a leading `#` does not make a line prose.
    let (body, enabled) = match trimmed.strip_prefix('#') {
        Some(rest) => (rest.trim_start(), false),
        None => (trimmed, true),
    };
    let (body, comment) = match body.split_once('#') {
        Some((head, tail)) => (head.trim_end(), tail.trim().to_string()),
        None => (body, String::new()),
    };
    let mut parts = body.split_whitespace();
    let Some(first) = parts.next() else {
        return line;
    };
    let names: Vec<String> = parts.map(|s| s.to_string()).collect();
    if first.parse::<IpAddr>().is_err() || names.is_empty() {
        line.comment = trimmed.trim_start_matches('#').trim().to_string();
        return line;
    }
    line.kind = "entry".into();
    line.enabled = enabled;
    line.ip = first.to_string();
    line.names = names;
    line.comment = comment;
    line
}

pub fn hosts_read() -> HostsFile {
    let path = hosts_path();
    let (text, error) = match std::fs::read(&path) {
        Ok(bytes) => (String::from_utf8_lossy(&bytes).into_owned(), String::new()),
        Err(e) => (
            String::new(),
            format!("Could not read {}: {e}", path.display()),
        ),
    };
    let lines = text
        .split('\n')
        .map(|l| l.trim_end_matches('\r'))
        .enumerate()
        .map(|(index, raw)| parse_host_line(index, raw))
        .collect();
    HostsFile {
        path: path.display().to_string(),
        writable: is_writable(&path),
        elevated: is_elevated(),
        backups: backups(),
        text,
        lines,
        error,
    }
}

/// Whether the file can be written without asking Windows for a lift. Opening
/// for append and closing it again changes nothing on disk.
fn is_writable(path: &std::path::Path) -> bool {
    std::fs::OpenOptions::new().append(true).open(path).is_ok()
}

/* --------------------------------------------------------------- backups */

fn backup_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("DevHQ\\hosts-backups")
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub id: String,
    pub saved_ms: u64,
    pub bytes: u64,
}

/// Every copy this tool has taken, newest first. Kept beside the app's own
/// data rather than beside the hosts file, so taking one never needs elevation.
pub fn backups() -> Vec<Backup> {
    let mut out: Vec<Backup> = std::fs::read_dir(backup_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("hosts-") || !name.ends_with(".bak") {
                return None;
            }
            let meta = entry.metadata().ok()?;
            Some(Backup {
                id: name,
                saved_ms: crate::util::mtime_ms(&entry.path()),
                bytes: meta.len(),
            })
        })
        .collect();
    out.sort_by_key(|backup| std::cmp::Reverse(backup.saved_ms));
    out
}

const KEEP_BACKUPS: usize = 20;

fn save_backup(text: &str) -> Option<String> {
    let dir = backup_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    let name = format!("hosts-{stamp}.bak");
    std::fs::write(dir.join(&name), text).ok()?;
    // Keep the folder from growing forever.
    let mut existing = backups();
    while existing.len() > KEEP_BACKUPS {
        if let Some(old) = existing.pop() {
            let _ = std::fs::remove_file(dir.join(old.id));
        }
    }
    Some(name)
}

pub fn backup_text(id: &str) -> Result<String, String> {
    // The id comes from the front end, so it must not be able to name a path.
    if id.contains(['\\', '/', ':']) || id.contains("..") {
        return Err("That is not a backup this app made".into());
    }
    std::fs::read_to_string(backup_dir().join(id))
        .map_err(|e| format!("Could not read the backup: {e}"))
}

/* ------------------------------------------------------- writing it back */

#[cfg(windows)]
pub fn is_elevated() -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token = Default::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut size = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
}

#[cfg(not(windows))]
pub fn is_elevated() -> bool {
    false
}

/// Copies `from` over `to` as an administrator. Used only when the plain write
/// was refused: DevHQ itself never runs elevated, so the one action that needs
/// it asks for it, once, and hands the work to a `cmd` that exits immediately.
#[cfg(windows)]
fn elevated_copy(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{WaitForSingleObject, INFINITE};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let params = HSTRING::from(format!(
        "/c copy /y \"{}\" \"{}\"",
        from.display(),
        to.display()
    ));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: w!("runas"),
        lpFile: w!("cmd.exe"),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    unsafe {
        ShellExecuteExW(&mut info)
            .map_err(|_| "The administrator prompt was dismissed".to_string())?;
        if info.hProcess.is_invalid() {
            return Err("Windows did not start the elevated copy".into());
        }
        WaitForSingleObject(info.hProcess, INFINITE);
        let _ = CloseHandle(info.hProcess);
    }
    Ok(())
}

#[cfg(not(windows))]
fn elevated_copy(_from: &std::path::Path, _to: &std::path::Path) -> Result<(), String> {
    Err("Only Windows hosts files can be written".into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostsWrite {
    /// The text the front end started from. The write is refused if the file
    /// has moved on since — something else edited it, and silently throwing
    /// that away is the one thing this tool must never do.
    pub base_text: String,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostsWriteResult {
    pub ok: bool,
    /// Whether Windows had to be asked for administrator rights to land it.
    pub elevated: bool,
    pub backup: String,
    pub error: String,
    pub file: HostsFile,
}

pub fn hosts_write(request: HostsWrite) -> HostsWriteResult {
    let path = hosts_path();
    let current = std::fs::read(&path)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    if current != request.base_text {
        return HostsWriteResult {
            ok: false,
            elevated: false,
            backup: String::new(),
            error: "The hosts file changed on disk since it was read. Reload it and try again."
                .into(),
            file: hosts_read(),
        };
    }

    let backup = save_backup(&current).unwrap_or_default();
    let mut used_elevation = false;
    let mut error = String::new();

    if let Err(direct) = std::fs::write(&path, &request.text) {
        used_elevation = true;
        let temp = std::env::temp_dir().join("devhq-hosts.tmp");
        if let Err(e) = std::fs::write(&temp, &request.text) {
            error = format!("Could not stage the new hosts file: {e}");
        } else if let Err(e) = elevated_copy(&temp, &path) {
            error = format!("{e} (writing it directly failed with: {direct})");
        }
        let _ = std::fs::remove_file(&temp);
    }

    let file = hosts_read();
    if error.is_empty() && file.text != request.text {
        error = "The hosts file did not change — the elevated copy was refused.".into();
    }
    if error.is_empty() {
        // Windows caches what the hosts file used to say, so a change that is
        // not flushed is a change that has not happened yet.
        flush_cache();
    }
    HostsWriteResult {
        ok: error.is_empty(),
        elevated: used_elevation,
        backup,
        error,
        file,
    }
}

pub fn flush_cache() -> String {
    match crate::util::run_lossy("ipconfig", &["/flushdns"], None) {
        Some(_) => String::new(),
        None => "Could not run ipconfig /flushdns".into(),
    }
}

/* ---------------------------------------------- names your projects use */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDomain {
    pub project: String,
    pub path: String,
    pub host: String,
    /// Where it was found — the file, and the setting inside it.
    pub note: String,
}

/// Files worth opening when looking for the names a project talks to. Anything
/// bigger than a config file is skipped: this runs over every project in the
/// scan and has to stay cheap enough to do when the tool opens.
const ENV_FILES: &[&str] = &[
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.production",
    ".env.example",
    "docker-compose.yml",
    "docker-compose.yaml",
];

const MAX_CONFIG_BYTES: u64 = 96 * 1024;

/// Pulls a hostname out of a value that may be a URL, a `host:port` pair or
/// just a name. Returns nothing for values that are plainly not names.
fn host_from_value(value: &str) -> Option<String> {
    let mut rest = value
        .trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '`');
    if let Some(at) = rest.find("://") {
        rest = &rest[at + 3..];
    }
    // Credentials, then path, query and fragment.
    if let Some(at) = rest.rfind('@') {
        rest = &rest[at + 1..];
    }
    rest = rest.split(['/', '?', '#', ',', ' ', '\\']).next()?;
    // A port is not part of the name, but `[::1]` has colons of its own.
    let host = if rest.starts_with('[') {
        rest.split(']').next()?.trim_start_matches('[')
    } else {
        rest.split(':').next()?
    };
    let host = host.trim_end_matches('.');
    if host.is_empty() || host.len() > 253 {
        return None;
    }
    if host.parse::<IpAddr>().is_ok() {
        return Some(host.to_string());
    }
    if !host.contains('.') && host != "localhost" {
        return None;
    }
    // `${VAR}` and friends must not survive as names.
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return None;
    }
    if host.starts_with('-') || host.ends_with('-') || host.starts_with('.') {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

/// Settings that plausibly name somewhere, so a version string or a secret
/// never turns into a row.
const HOSTISH_KEYS: &[&str] = &[
    "URL", "URI", "HOST", "DOMAIN", "ENDPOINT", "ORIGIN", "SERVER", "API",
];

fn scan_config(text: &str, file: &str, found: &mut Vec<(String, String)>) {
    for line in text.lines() {
        let line = line.trim().trim_start_matches("- ").trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=').or_else(|| line.split_once(':')) else {
            continue;
        };
        let key = key.trim().trim_start_matches("export ").trim();
        let upper = key.to_ascii_uppercase();
        if !HOSTISH_KEYS.iter().any(|needle| upper.contains(needle)) {
            continue;
        }
        let Some(host) = host_from_value(value) else {
            continue;
        };
        if found.iter().any(|(existing, _)| *existing == host) {
            continue;
        }
        found.push((host, format!("{file} · {key}")));
    }
}

/// The names each scanned project talks to, from its git remote and its
/// config files. `names` lines up with `paths`; a missing one falls back to the
/// folder's own name.
pub fn project_domains(paths: Vec<String>, names: Vec<String>) -> Vec<ProjectDomain> {
    let mut out = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        let dir = std::path::Path::new(path);
        let project = names
            .get(index)
            .cloned()
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| {
                dir.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            });
        let mut found: Vec<(String, String)> = Vec::new();

        // The remote is the one name a repository always has, and the one most
        // worth being able to check.
        if let Some(remote) =
            crate::util::run("git", &["config", "--get", "remote.origin.url"], Some(dir))
        {
            if let Some(host) = host_from_value(remote.trim().trim_start_matches("git@")) {
                found.push((host, "git · origin".into()));
            }
        }

        for file in ENV_FILES {
            let candidate = dir.join(file);
            let Ok(meta) = std::fs::metadata(&candidate) else {
                continue;
            };
            if !meta.is_file() || meta.len() > MAX_CONFIG_BYTES {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&candidate) else {
                continue;
            };
            scan_config(&text, file, &mut found);
        }

        for (host, note) in found {
            out.push(ProjectDomain {
                project: project.clone(),
                path: path.clone(),
                host,
                note,
            });
        }
    }
    out
}
