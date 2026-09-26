//! Which apps are moving the bytes.
//!
//! The adapter's counters (`netmeter`) say how much is going down and up, but
//! not *who* is doing it, and "something is using 40 Mb/s" is the half of the
//! answer nobody can act on. Windows keeps no per-process byte counter that an
//! ordinary user process may read, so this module answers the question twice,
//! at two levels of honesty:
//!
//! * **Estimated, always available.** The socket tables say which processes
//!   hold a connection to somewhere that is not this machine, and
//!   `GetProcessIoCounters` says how many bytes each of those processes has
//!   read and written since the last look. Those bytes include files and pipes
//!   as well as sockets, so the number is not network traffic on its own — it
//!   is used only to *divide* the adapter's real total between the processes
//!   that are actually connected. The names and the order are reliable; the
//!   per-app figures are a share, and are labelled as one.
//!
//! * **Measured, on request.** TCP ESTATS counts bytes per connection inside
//!   the stack, which is the real thing — but enabling it needs administrator
//!   rights. Rather than run the whole app elevated, one `runas` prompt starts
//!   `wint-cli netusage watch`, which samples ESTATS every second and writes a
//!   small file this module reads. When those numbers are on hand they replace
//!   the estimate, per process. ESTATS is TCP only, so a process whose traffic
//!   is QUIC or plain UDP still shows as an estimate and says so.
//!
//! Nothing here runs on the main thread, and nothing here touches the network:
//! every reading is a kernel table already in memory.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How many remote endpoints are listed per app. Enough to recognise what it
/// is talking to, few enough to fit on one line.
const PEERS_SHOWN: usize = 3;
/// A helper sample older than this is stale — the helper is gone, or elevated
/// numbers stopped arriving — and the estimate is used instead.
const HELPER_FRESH: Duration = Duration::from_secs(6);
/// The elevated helper gives up on its own, so a forgotten prompt does not
/// leave a process sampling the stack for the rest of the session.
pub const HELPER_MINUTES: u64 = 30;

/// One process, and what it appears to be moving.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppUsage {
    pub pid: u32,
    /// The executable's name, as the process table spells it.
    pub name: String,
    pub down_bps: u64,
    pub up_bps: u64,
    /// How many connections to somewhere off this machine it holds.
    pub connections: u32,
    /// True when these two numbers came from ESTATS rather than from a share
    /// of the adapter total.
    pub measured: bool,
    /// True when the process holds no TCP connection at all, only UDP sockets
    /// — which ESTATS cannot see, so it can never be more than an estimate.
    pub udp_only: bool,
    /// A few of the addresses it is connected to.
    pub peers: Vec<String>,
}

/// What the panel draws.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub apps: Vec<AppUsage>,
    /// The adapter totals the shares were divided out of.
    pub total_down_bps: u64,
    pub total_up_bps: u64,
    /// False until the meter has two samples to subtract; the panel keeps the
    /// previous numbers rather than flashing zeroes.
    pub known: bool,
    /// True when at least one app's figures are measured.
    pub measured: bool,
    /// True while the elevated helper is feeding fresh samples.
    pub helper_running: bool,
    /// True when WinT itself is elevated, in which case ESTATS is read here
    /// and no helper is needed.
    pub elevated: bool,
}

/* ------------------------------------------------------------ the io sampler */

/// The previous read of one process's byte counters.
#[derive(Clone, Copy)]
struct Io {
    read: u64,
    written: u64,
}

fn previous() -> &'static Mutex<Option<(Instant, HashMap<u32, Io>)>> {
    static PREVIOUS: Mutex<Option<(Instant, HashMap<u32, Io>)>> = Mutex::new(None);
    &PREVIOUS
}

/// Forgets the last sample, so the next reading covers a fresh interval.
pub fn reset() {
    if let Ok(mut slot) = previous().lock() {
        *slot = None;
    }
}

/* ----------------------------------------------------------- the socket table */

/// One process's connections, as the socket tables describe them.
#[derive(Default)]
struct Sockets {
    tcp: u32,
    udp: u32,
    peers: Vec<String>,
}

#[cfg(windows)]
fn loopback_v4(address: u32) -> bool {
    // Stored in network order, so 127.x.x.x is the low byte.
    (address & 0xff) == 127 || address == 0
}

#[cfg(windows)]
fn loopback_v6(address: &[u8; 16]) -> bool {
    let unspecified = address.iter().all(|byte| *byte == 0);
    let local = address[..15].iter().all(|byte| *byte == 0) && address[15] == 1;
    unspecified || local
}

/// Every process holding a socket to somewhere that is not this machine.
#[cfg(windows)]
fn sockets() -> HashMap<u32, Sockets> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6TABLE_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
        MIB_UDP6TABLE_OWNER_PID, MIB_UDPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_CONNECTIONS,
        UDP_TABLE_OWNER_PID,
    };
    use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};

    let mut map: HashMap<u32, Sockets> = HashMap::new();
    let mut note = |pid: u32, tcp: bool, peer: Option<String>| {
        if pid == 0 {
            return;
        }
        let entry = map.entry(pid).or_default();
        if tcp {
            entry.tcp += 1;
        } else {
            entry.udp += 1;
        }
        if let Some(peer) = peer {
            if entry.peers.len() < PEERS_SHOWN && !entry.peers.contains(&peer) {
                entry.peers.push(peer);
            }
        }
    };

    // IPv4 TCP. `_CONNECTIONS` leaves out the listeners, which own no traffic.
    if let Some(buffer) = table(|pointer, size| unsafe {
        GetExtendedTcpTable(
            pointer,
            size,
            false,
            AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_CONNECTIONS,
            0,
        )
    }) {
        // SAFETY: the buffer was sized by the call above and holds the table
        // class that was asked for.
        let table = unsafe { &*(buffer.as_ptr() as *const MIB_TCPTABLE_OWNER_PID) };
        let rows =
            unsafe { std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize) };
        for row in rows {
            if loopback_v4(row.dwRemoteAddr) {
                continue;
            }
            let address = std::net::Ipv4Addr::from(row.dwRemoteAddr.to_le_bytes());
            note(
                row.dwOwningPid,
                true,
                Some(format!("{address}:{}", port(row.dwRemotePort))),
            );
        }
    }

    // IPv6 TCP.
    if let Some(buffer) = table(|pointer, size| unsafe {
        GetExtendedTcpTable(
            pointer,
            size,
            false,
            AF_INET6.0 as u32,
            TCP_TABLE_OWNER_PID_CONNECTIONS,
            0,
        )
    }) {
        let table = unsafe { &*(buffer.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID) };
        let rows =
            unsafe { std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize) };
        for row in rows {
            if loopback_v6(&row.ucRemoteAddr) {
                continue;
            }
            let address = std::net::Ipv6Addr::from(row.ucRemoteAddr);
            note(
                row.dwOwningPid,
                true,
                Some(format!("[{address}]:{}", port(row.dwRemotePort))),
            );
        }
    }

    // UDP. The owner table carries no remote address — a UDP socket has no
    // fixed peer — so these only say that the process is on the network. QUIC
    // lives here, which is why a busy browser can show no TCP traffic at all.
    if let Some(buffer) = table(|pointer, size| unsafe {
        GetExtendedUdpTable(
            pointer,
            size,
            false,
            AF_INET.0 as u32,
            UDP_TABLE_OWNER_PID,
            0,
        )
    }) {
        let table = unsafe { &*(buffer.as_ptr() as *const MIB_UDPTABLE_OWNER_PID) };
        let rows =
            unsafe { std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize) };
        for row in rows {
            note(row.dwOwningPid, false, None);
        }
    }
    if let Some(buffer) = table(|pointer, size| unsafe {
        GetExtendedUdpTable(
            pointer,
            size,
            false,
            AF_INET6.0 as u32,
            UDP_TABLE_OWNER_PID,
            0,
        )
    }) {
        let table = unsafe { &*(buffer.as_ptr() as *const MIB_UDP6TABLE_OWNER_PID) };
        let rows =
            unsafe { std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize) };
        for row in rows {
            note(row.dwOwningPid, false, None);
        }
    }
    map
}

/// The ports in these tables are in network order inside a 32-bit field.
#[cfg(windows)]
fn port(value: u32) -> u16 {
    u16::from_be_bytes([(value & 0xff) as u8, ((value >> 8) & 0xff) as u8])
}

/// The two-call dance every `GetExtended*Table` wants: ask for the size, then
/// ask again with a buffer that big. Retried a few times because the table can
/// grow between the two calls.
#[cfg(windows)]
fn table(mut call: impl FnMut(Option<*mut core::ffi::c_void>, *mut u32) -> u32) -> Option<Vec<u8>> {
    use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    let mut size = 0u32;
    for _ in 0..4 {
        let error = call(None, &mut size);
        if error != ERROR_INSUFFICIENT_BUFFER.0 && error != NO_ERROR.0 {
            return None;
        }
        if size == 0 {
            return None;
        }
        let mut buffer = vec![0u8; size as usize];
        let error = call(Some(buffer.as_mut_ptr() as *mut _), &mut size);
        if error == NO_ERROR.0 {
            return Some(buffer);
        }
        if error != ERROR_INSUFFICIENT_BUFFER.0 {
            return None;
        }
    }
    None
}

#[cfg(not(windows))]
fn sockets() -> HashMap<u32, Sockets> {
    HashMap::new()
}

/* ------------------------------------------------------------- process names */

/// pid -> executable name, for the pids that matter. One ToolHelp snapshot.
#[cfg(windows)]
fn names(wanted: &HashMap<u32, Sockets>) -> HashMap<u32, String> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut map = HashMap::new();
    // SAFETY: the snapshot handle is closed on every path out, and the entry
    // is sized as the API requires before the first call.
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return map;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                if wanted.contains_key(&entry.th32ProcessID) {
                    let end = entry
                        .szExeFile
                        .iter()
                        .position(|c| *c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    map.insert(
                        entry.th32ProcessID,
                        String::from_utf16_lossy(&entry.szExeFile[..end]),
                    );
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snapshot);
    }
    map
}

#[cfg(not(windows))]
fn names(_wanted: &HashMap<u32, Sockets>) -> HashMap<u32, String> {
    HashMap::new()
}

/// One process's read and written totals. `None` when the process is gone or
/// its token is out of reach — a system service an ordinary user may not query
/// simply carries no weight, rather than breaking the whole reading.
#[cfg(windows)]
fn io_counters(pid: u32) -> Option<Io> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetProcessIoCounters, OpenProcess, IO_COUNTERS, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: the handle is closed before returning, and the counters struct is
    // fully initialised.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut counters = IO_COUNTERS::default();
        let ok = GetProcessIoCounters(handle, &mut counters).is_ok();
        let _ = CloseHandle(handle);
        ok.then_some(Io {
            read: counters.ReadTransferCount,
            written: counters.WriteTransferCount,
        })
    }
}

#[cfg(not(windows))]
fn io_counters(_pid: u32) -> Option<Io> {
    None
}

/* -------------------------------------------------------------- the estimate */

/// Reads everything and divides the adapter's total between the processes that
/// are actually connected. Blocking; never called from the main thread.
pub fn report() -> UsageReport {
    let (total_down, total_up, known) = crate::netmeter::latest();
    let sockets = sockets();
    let names = names(&sockets);
    let helper = helper_sample();
    let elevated = crate::dns::is_elevated();
    // When WinT is already elevated there is no reason to ask for a helper: the
    // stack's own counters are readable from here.
    let exact = if elevated {
        estats::sample()
    } else {
        helper
            .as_ref()
            .map(|sample| sample.apps.clone())
            .unwrap_or_default()
    };

    // The weights: how many bytes each connected process moved since the last
    // look. Disk and pipes are in there too, which is why this only ever
    // decides proportions and never becomes a figure of its own.
    let now = Instant::now();
    let mut current: HashMap<u32, Io> = HashMap::new();
    let mut weights: HashMap<u32, (f64, f64)> = HashMap::new();
    let mut slot = previous().lock().ok();
    let before = slot.as_ref().and_then(|slot| slot.as_ref());
    let seconds = before
        .map(|(at, _)| now.duration_since(*at).as_secs_f64())
        .unwrap_or(0.0);
    let usable = (0.05..=30.0).contains(&seconds);
    for pid in sockets.keys() {
        let Some(io) = io_counters(*pid) else { continue };
        if let Some((_, table)) = before {
            if let Some(was) = table.get(pid) {
                if usable {
                    weights.insert(
                        *pid,
                        (
                            io.read.saturating_sub(was.read) as f64 / seconds,
                            io.written.saturating_sub(was.written) as f64 / seconds,
                        ),
                    );
                }
            }
        }
        current.insert(*pid, io);
    }
    if let Some(slot) = slot.as_mut() {
        **slot = Some((now, current));
    }
    drop(slot);

    // Processes whose bytes are measured are taken out of the share: their
    // traffic is known, and counting it twice would flatter everyone else.
    let measured: HashMap<u32, (u64, u64)> = exact
        .iter()
        .map(|app| (app.pid, (app.down_bps, app.up_bps)))
        .collect();
    let claimed_down: u64 = measured.values().map(|(down, _)| *down).sum();
    let claimed_up: u64 = measured.values().map(|(_, up)| *up).sum();
    let share_down = total_down.saturating_sub(claimed_down) as f64;
    let share_up = total_up.saturating_sub(claimed_up) as f64;
    let weight_down: f64 = weights
        .iter()
        .filter(|(pid, _)| !measured.contains_key(pid))
        .map(|(_, (read, _))| *read)
        .sum();
    let weight_up: f64 = weights
        .iter()
        .filter(|(pid, _)| !measured.contains_key(pid))
        .map(|(_, (_, written))| *written)
        .sum();

    let mut apps: Vec<AppUsage> = sockets
        .iter()
        .map(|(pid, socket)| {
            let weight = weights.get(pid).copied().unwrap_or((0.0, 0.0));
            let known_bytes = measured.get(pid).copied();
            let (down, up) = match known_bytes {
                Some(bytes) => bytes,
                None => (
                    if weight_down > 0.0 {
                        (share_down * (weight.0 / weight_down)) as u64
                    } else {
                        0
                    },
                    if weight_up > 0.0 {
                        (share_up * (weight.1 / weight_up)) as u64
                    } else {
                        0
                    },
                ),
            };
            AppUsage {
                pid: *pid,
                name: names
                    .get(pid)
                    .cloned()
                    .unwrap_or_else(|| format!("PID {pid}")),
                down_bps: down,
                up_bps: up,
                connections: socket.tcp + socket.udp,
                measured: known_bytes.is_some(),
                udp_only: socket.tcp == 0,
                peers: socket.peers.clone(),
            }
        })
        .collect();
    // Busiest first, and a tie broken by name so the list does not shuffle
    // itself under the cursor every half second.
    apps.sort_by(|a, b| {
        (b.down_bps + b.up_bps)
            .cmp(&(a.down_bps + a.up_bps))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    UsageReport {
        measured: apps.iter().any(|app| app.measured),
        apps,
        total_down_bps: total_down,
        total_up_bps: total_up,
        known: known && usable,
        helper_running: helper.is_some(),
        elevated,
    }
}

/* ----------------------------------------------------- the elevated companion */

/// What the helper writes, once a second.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct HelperSample {
    /// Unix milliseconds, so staleness survives the helper being killed.
    pub at_ms: u64,
    pub apps: Vec<AppUsage>,
}

fn runtime_dir() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    let dir = PathBuf::from(local).join("WinT").join("runtime");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Where the helper puts its samples. Beside WinT's other runtime state rather
/// than in the temp folder, so a helper left behind by a crash is findable.
pub fn sample_path() -> Option<PathBuf> {
    Some(runtime_dir()?.join("netusage.json"))
}

/// The file that asks the helper to stop.
pub fn stop_path() -> Option<PathBuf> {
    Some(runtime_dir()?.join("netusage.stop"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

/// The helper's newest sample, if there is one and it is recent.
fn helper_sample() -> Option<HelperSample> {
    let bytes = std::fs::read(sample_path()?).ok()?;
    let sample: HelperSample = serde_json::from_slice(&bytes).ok()?;
    let age = now_ms().saturating_sub(sample.at_ms);
    (age <= HELPER_FRESH.as_millis() as u64).then_some(sample)
}

/// The loop the elevated helper runs. It lives here rather than in the CLI so
/// that the sampling and the file format are written down once.
pub fn watch(minutes: u64) -> Result<(), String> {
    let sample_path = sample_path().ok_or("The runtime folder is unavailable.")?;
    let stop_path = stop_path().ok_or("The runtime folder is unavailable.")?;
    let _ = std::fs::remove_file(&stop_path);
    let temporary = sample_path.with_extension("json.tmp");
    let until = Instant::now() + Duration::from_secs(minutes.clamp(1, 240) * 60);
    // The first sample only primes the per-connection totals: a rate needs two.
    estats::sample();
    while Instant::now() < until {
        std::thread::sleep(Duration::from_secs(1));
        if stop_path.exists() {
            let _ = std::fs::remove_file(&stop_path);
            break;
        }
        let sample = HelperSample {
            at_ms: now_ms(),
            apps: estats::sample(),
        };
        let Ok(bytes) = serde_json::to_vec(&sample) else {
            continue;
        };
        // Written aside and renamed, so a reader never sees half a file.
        if std::fs::write(&temporary, &bytes).is_ok() {
            let _ = std::fs::rename(&temporary, &sample_path);
        }
    }
    let _ = std::fs::remove_file(&sample_path);
    Ok(())
}

/* ------------------------------------------------------------------ commands */

/// One reading of who is using the line.
#[tauri::command]
pub async fn net_app_usage() -> UsageReport {
    crate::off_thread(report).await.unwrap_or_default()
}

/// Starts a fresh interval, so the first reading after the panel opens is not
/// an average over however long nothing was looking.
#[tauri::command]
pub async fn net_app_usage_reset() {
    let _ = crate::off_thread(reset).await;
}

/// Asks for the measured numbers: one `runas` prompt, one small elevated
/// process, and no elevation for WinT itself.
#[tauri::command]
pub async fn net_app_usage_measure(app: tauri::AppHandle) -> Result<String, String> {
    if crate::dns::is_elevated() {
        return Ok(
            "WinT is already an administrator, so the per-app numbers are measured directly."
                .into(),
        );
    }
    if helper_sample().is_some() {
        return Ok("Measured numbers are already arriving.".into());
    }
    crate::off_thread(move || start_helper(&app))
        .await
        .unwrap_or_else(|| Err("The helper could not be started.".into()))
}

/// Stops the helper, whether or not this session started it.
#[tauri::command]
pub async fn net_app_usage_measure_stop() {
    let _ = crate::off_thread(|| {
        if let Some(path) = stop_path() {
            let _ = std::fs::write(path, b"stop");
        }
    })
    .await;
}

#[cfg(windows)]
fn start_helper(app: &tauri::AppHandle) -> Result<String, String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let cli = crate::cli_registration::bundled_cli(app)?;
    let parameters = HSTRING::from(format!("netusage watch {HELPER_MINUTES}"));
    let file = HSTRING::from(cli.as_os_str());
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        lpVerb: w!("runas"),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(parameters.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    // SAFETY: every pointer is to a live local that outlives the call.
    let started = unsafe { ShellExecuteExW(&mut info) };
    if started.is_err() {
        // A dismissed prompt is the usual reason, and it is not worth a red
        // message — the estimate is still on screen.
        return Err("The prompt was dismissed, so the estimate is still what you see.".into());
    }
    Ok(format!(
        "Measuring per-app TCP traffic for the next {HELPER_MINUTES} minutes."
    ))
}

#[cfg(not(windows))]
fn start_helper(_app: &tauri::AppHandle) -> Result<String, String> {
    Err("Only available on Windows.".into())
}

/* --------------------------------------------------------------------- estats */

/// TCP ESTATS: the bytes the stack itself counted, per connection, summed per
/// process. Enabling collection needs administrator rights, so every call here
/// comes back empty in an ordinary process — which is exactly why the helper
/// exists.
mod estats {
    use super::AppUsage;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::Instant;

    /// Per connection, the totals at the last sample. Keyed by the four-tuple
    /// and the owner, because a pid can hold thousands of connections and the
    /// stack counts each one separately.
    type Totals = HashMap<(u32, u32, u32, u32, u32), (u64, u64)>;

    fn last() -> &'static Mutex<Option<(Instant, Totals)>> {
        static LAST: Mutex<Option<(Instant, Totals)>> = Mutex::new(None);
        &LAST
    }

    #[cfg(windows)]
    pub fn sample() -> Vec<AppUsage> {
        use windows::Win32::NetworkManagement::IpHelper::{
            GetExtendedTcpTable, GetPerTcpConnectionEStats, SetPerTcpConnectionEStats,
            TcpConnectionEstatsData, MIB_TCPROW_LH, MIB_TCPTABLE_OWNER_PID, TCP_ESTATS_DATA_ROD_v0,
            TCP_ESTATS_DATA_RW_v0, TCP_TABLE_OWNER_PID_CONNECTIONS,
        };
        use windows::Win32::Networking::WinSock::AF_INET;

        let Some(buffer) = super::table(|pointer, size| unsafe {
            GetExtendedTcpTable(
                pointer,
                size,
                false,
                AF_INET.0 as u32,
                TCP_TABLE_OWNER_PID_CONNECTIONS,
                0,
            )
        }) else {
            return Vec::new();
        };
        // SAFETY: as in `sockets` — the buffer holds the table that was asked
        // for, sized by the call itself.
        let table = unsafe { &*(buffer.as_ptr() as *const MIB_TCPTABLE_OWNER_PID) };
        let rows =
            unsafe { std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize) };

        let now = Instant::now();
        let mut totals: Totals = HashMap::new();
        let mut per_pid: HashMap<u32, (u64, u64)> = HashMap::new();
        for row in rows {
            let key = (
                row.dwLocalAddr,
                row.dwLocalPort,
                row.dwRemoteAddr,
                row.dwRemotePort,
                row.dwOwningPid,
            );
            let mut plain = MIB_TCPROW_LH {
                dwLocalAddr: row.dwLocalAddr,
                dwLocalPort: row.dwLocalPort,
                dwRemoteAddr: row.dwRemoteAddr,
                dwRemotePort: row.dwRemotePort,
                ..Default::default()
            };
            plain.Anonymous.dwState = row.dwState;
            // Collection is switched on per connection and stays on for that
            // connection's life; asking again for one already counting is free.
            let enable = TCP_ESTATS_DATA_RW_v0 {
                EnableCollection: true,
            };
            // SAFETY: both calls are handed a live row and byte windows over
            // live structures of exactly the version they are told to expect.
            unsafe {
                let enable = std::slice::from_raw_parts(
                    &enable as *const _ as *const u8,
                    std::mem::size_of::<TCP_ESTATS_DATA_RW_v0>(),
                );
                SetPerTcpConnectionEStats(&plain, TcpConnectionEstatsData, enable, 0, 0);
                let mut data = TCP_ESTATS_DATA_ROD_v0::default();
                let read = std::slice::from_raw_parts_mut(
                    &mut data as *mut _ as *mut u8,
                    std::mem::size_of::<TCP_ESTATS_DATA_ROD_v0>(),
                );
                let error = GetPerTcpConnectionEStats(
                    &plain,
                    TcpConnectionEstatsData,
                    None,
                    0,
                    None,
                    0,
                    Some(read),
                    0,
                );
                if error != 0 {
                    continue;
                }
                totals.insert(key, (data.DataBytesIn, data.DataBytesOut));
            }
        }

        let Ok(mut slot) = last().lock() else {
            return Vec::new();
        };
        let rates = match slot.as_ref() {
            Some((at, before)) => {
                let seconds = now.duration_since(*at).as_secs_f64();
                if (0.2..=30.0).contains(&seconds) {
                    for (key, (down, up)) in &totals {
                        // A connection seen for the first time contributes
                        // nothing: its totals are its whole life, not this
                        // second's.
                        let Some((was_down, was_up)) = before.get(key) else {
                            continue;
                        };
                        let entry = per_pid.entry(key.4).or_insert((0, 0));
                        entry.0 += ((down.saturating_sub(*was_down)) as f64 / seconds) as u64;
                        entry.1 += ((up.saturating_sub(*was_up)) as f64 / seconds) as u64;
                    }
                    true
                } else {
                    false
                }
            }
            None => false,
        };
        *slot = Some((now, totals));
        if !rates {
            return Vec::new();
        }
        per_pid
            .into_iter()
            .map(|(pid, (down, up))| AppUsage {
                pid,
                down_bps: down,
                up_bps: up,
                measured: true,
                ..Default::default()
            })
            .collect()
    }

    #[cfg(not(windows))]
    pub fn sample() -> Vec<AppUsage> {
        Vec::new()
    }
}
