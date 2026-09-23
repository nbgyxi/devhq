//! The BitTorrent engine, kept out of WinT's process on purpose.
//!
//! Everything a torrent client does that can stall — DNS and tracker traffic,
//! peer sockets, bencode parsing of files nobody vouched for, SHA-1 over
//! hundreds of gigabytes, and the writes that follow — happens here, in a
//! child process that owns no window and never touches WinT's message queue.
//! WinT talks to it over a pipe and can give up on any answer, kill it and
//! start it again; the torrents survive because their state is written here,
//! not in the app.
//!
//! The protocol is JSON, one object per line.
//!
//! * app -> helper: `{"id":7,"op":"pause","arg":{"id":3}}`
//! * helper -> app: `{"id":7,"ok":true,"result":{}}`
//!   `{"id":7,"ok":false,"error":"no such torrent"}`
//! * helper -> app, unprompted: `{"event":"snapshot","data":{…}}`
//!
//! Snapshots are the only high-rate traffic, and they are **aggregates on a
//! timer** — one line every `--snapshot-ms` carrying every torrent's totals,
//! never a line per peer or per block. The writer's queue is bounded and a
//! snapshot that does not fit is dropped rather than queued, because the next
//! one is along in a moment and says the same thing, only truer. A reader that
//! stops reading therefore costs a bounded amount of memory, not an
//! ever-growing backlog.

use std::any::TypeId;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::IoSlice;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use librqbit::{
    api::{ApiTorrentListOpts, TorrentDetailsResponse, TorrentIdOrHash},
    limits::LimitsConfig,
    storage::{
        filesystem::FilesystemStorageFactory, BoxStorageFactory, StorageFactory, TorrentStorage,
    },
    AddTorrent, AddTorrentOptions, Api, ListenerOptions, ManagedTorrentShared, Session,
    SessionOptions, SessionPersistenceConfig, TorrentMetadata,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex};

/// A `.torrent` is a few hundred kilobytes of bencode at most. Anything
/// dramatically larger is not a torrent file, and is refused before a parser
/// ever sees it — the file came from the internet and is treated that way.
const MAX_TORRENT_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// One command line, likewise. Nothing legitimate approaches this.
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
/// How many lines may be waiting to be written before snapshots start being
/// dropped. Sized for a burst of replies, not for a backlog.
const WRITER_QUEUE: usize = 512;
/// The most files described in one reply. Past this the list is cut and the
/// reply says so; see `details_json` for why the cap exists at all.
const MAX_FILES_IN_REPLY: usize = 4096;
/// How many of a torrent's files are checked for still being on disk, and how
/// often that check runs. See `files_are_missing`.
const MISSING_CHECK_SAMPLE: usize = 48;
const MISSING_CHECK_EVERY: Duration = Duration::from_secs(10);
/// Ceilings the engine is started with, so one torrent cannot take the machine
/// apart. All of them are overridable from settings except the hash-check
/// limit, which exists to keep the disk usable while checking.
const MAX_CONCURRENT_INITIALIZING_PER_DRIVE: usize = 1;
const DEFAULT_PEER_LIMIT: usize = 128;
const RATE_WINDOW: Duration = Duration::from_secs(5);
const RATE_REFRESH: Duration = Duration::from_secs(1);

fn recovery_mismatches() -> &'static StdMutex<HashSet<String>> {
    static FOUND: OnceLock<StdMutex<HashSet<String>>> = OnceLock::new();
    FOUND.get_or_init(|| StdMutex::new(HashSet::new()))
}

fn authorized_checks() -> &'static StdMutex<HashSet<String>> {
    static ALLOWED: OnceLock<StdMutex<HashSet<String>>> = OnceLock::new();
    ALLOWED.get_or_init(|| StdMutex::new(HashSet::new()))
}

/// Torrents added during this helper run. Missing files are expected while
/// their initial piece scan runs: the download has not created them yet.
fn new_torrents_initializing() -> &'static StdMutex<HashSet<String>> {
    static INITIALIZING: OnceLock<StdMutex<HashSet<String>>> = OnceLock::new();
    INITIALIZING.get_or_init(|| StdMutex::new(HashSet::new()))
}

fn note_recovery_read_failure(info_hash: &str) {
    let is_new = new_torrents_initializing()
        .lock()
        .map(|hashes| hashes.contains(info_hash))
        .unwrap_or(false);
    if !is_new {
        if let Ok(mut found) = recovery_mismatches().lock() {
            found.insert(info_hash.to_owned());
        }
    }
}

/// librqbit's filesystem backend sizes every selected file to its final length
/// during initialization. Those sparse files consume little physical space on
/// Windows, but Explorer presents a 20 GB torrent as 20 GB of files before a
/// byte has arrived. Delegate all real I/O to librqbit and skip only that eager
/// sizing step; positioned writes grow each file naturally as pieces arrive.
#[derive(Default, Clone, Copy)]
struct GrowingFilesFactory;

impl StorageFactory for GrowingFilesFactory {
    type Storage = Box<dyn TorrentStorage>;

    fn create(
        &self,
        shared: &ManagedTorrentShared,
        metadata: &TorrentMetadata,
    ) -> Result<Self::Storage> {
        Ok(Box::new(GrowingFiles {
            inner: Box::new(FilesystemStorageFactory::default().create(shared, metadata)?),
            info_hash: shared.info_hash.as_string().to_ascii_lowercase(),
        }))
    }

    fn is_type_id(&self, type_id: TypeId) -> bool {
        // JSON persistence supports the filesystem backend. This wrapper is
        // exactly that backend with eager set_len() suppressed.
        type_id == TypeId::of::<FilesystemStorageFactory>()
    }

    fn clone_box(&self) -> BoxStorageFactory {
        Box::new(*self)
    }
}

struct GrowingFiles {
    inner: Box<dyn TorrentStorage>,
    info_hash: String,
}

impl TorrentStorage for GrowingFiles {
    fn init(&mut self, shared: &ManagedTorrentShared, metadata: &TorrentMetadata) -> Result<()> {
        self.inner.init(shared, metadata)
    }

    fn pread_exact(&self, file_id: usize, offset: u64, buf: &mut [u8]) -> Result<()> {
        if let Err(error) = self.inner.pread_exact(file_id, offset, buf) {
            if authorized_checks()
                .lock()
                .map(|allowed| allowed.contains(&self.info_hash))
                .unwrap_or(false)
            {
                return Err(error);
            }
            buf.fill(0);
            note_recovery_read_failure(&self.info_hash);
        }
        Ok(())
    }

    fn pwrite_all(&self, file_id: usize, offset: u64, buf: &[u8]) -> Result<()> {
        self.inner.pwrite_all(file_id, offset, buf)
    }

    fn pwrite_all_vectored(
        &self,
        file_id: usize,
        offset: u64,
        bufs: [IoSlice<'_>; 2],
    ) -> Result<usize> {
        self.inner.pwrite_all_vectored(file_id, offset, bufs)
    }

    fn remove_file(&self, file_id: usize, filename: &Path) -> Result<()> {
        self.inner.remove_file(file_id, filename)
    }

    fn remove_directory_if_empty(&self, path: &Path) -> Result<()> {
        self.inner.remove_directory_if_empty(path)
    }

    fn ensure_file_length(&self, _file_id: usize, _length: u64) -> Result<()> {
        Ok(())
    }

    fn take(&self) -> Result<Box<dyn TorrentStorage>> {
        Ok(Box::new(Self {
            inner: self.inner.take()?,
            info_hash: self.info_hash.clone(),
        }))
    }
}

// ---------------------------------------------------------------------------
// Settings — owned by the helper, so a restart comes back the way it went down
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    /// Where files land unless a torrent was added with its own folder.
    download_folder: String,
    /// `None`/absent means no limit. Bytes per second.
    download_bps: Option<u32>,
    upload_bps: Option<u32>,
    /// How many torrents may be downloading at once; the rest wait their turn.
    max_active: usize,
    /// Peers per torrent.
    peer_limit: usize,
    /// Keep seeding a finished torrent, or park it.
    seed_when_finished: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            download_folder: default_download_folder(),
            download_bps: None,
            upload_bps: None,
            max_active: 4,
            peer_limit: DEFAULT_PEER_LIMIT,
            seed_when_finished: true,
        }
    }
}

fn default_download_folder() -> String {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let downloads = Path::new(&profile).join("Downloads");
        return downloads.to_string_lossy().into_owned();
    }
    ".".to_string()
}

/// Which torrents the user has asked to run, and in what order they queue.
/// librqbit remembers the torrents; it does not remember that torrent 4 is
/// third in line behind two others, so that part is kept here.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
struct Queue {
    /// Info hashes the user wants running, newest last. Info hashes rather
    /// than ids, because ids are handed out afresh on every start.
    wanted: Vec<String>,
    /// Info hashes explicitly paused by the user.
    paused: Vec<String>,
}

struct State {
    api: Api,
    session: Arc<Session>,
    state_dir: PathBuf,
    settings: Settings,
    queue: Queue,
    completed_at: HashMap<String, u64>,
    completion_candidates: HashSet<String>,
    rates: HashMap<usize, RateWindow>,
}

#[derive(Default)]
struct RateWindow {
    samples: VecDeque<(std::time::Instant, u64, u64)>,
    shown_at: Option<std::time::Instant>,
    download_bps: u64,
    upload_bps: u64,
    shown_downloaded: u64,
}

impl RateWindow {
    fn update(&mut self, now: std::time::Instant, downloaded: u64, uploaded: u64) -> (u64, u64) {
        if self
            .samples
            .back()
            .is_some_and(|(_, old_down, old_up)| downloaded < *old_down || uploaded < *old_up)
        {
            self.samples.clear();
            self.shown_at = None;
            self.download_bps = 0;
            self.upload_bps = 0;
            self.shown_downloaded = downloaded;
        }
        self.samples.push_back((now, downloaded, uploaded));
        let cutoff = now.checked_sub(RATE_WINDOW).unwrap_or(now);
        while self.samples.len() > 2 && self.samples[1].0 <= cutoff {
            self.samples.pop_front();
        }
        if self
            .shown_at
            .is_some_and(|shown| now.duration_since(shown) < RATE_REFRESH)
        {
            return (self.download_bps, self.upload_bps);
        }
        let Some(&(first_at, first_down, first_up)) = self.samples.front() else {
            return (0, 0);
        };
        let elapsed = now.duration_since(first_at).as_secs_f64();
        if elapsed >= RATE_WINDOW.as_secs_f64() {
            self.download_bps = (downloaded.saturating_sub(first_down) as f64 / elapsed) as u64;
            self.upload_bps = (uploaded.saturating_sub(first_up) as f64 / elapsed) as u64;
            self.shown_downloaded = downloaded;
            self.shown_at = Some(now);
        }
        (self.download_bps, self.upload_bps)
    }
}

#[cfg(test)]
mod rate_tests {
    use super::*;

    #[test]
    fn missing_files_are_expected_while_a_new_torrent_initializes() {
        let hash = "fresh-torrent-test".to_string();
        new_torrents_initializing()
            .lock()
            .unwrap()
            .insert(hash.clone());

        note_recovery_read_failure(&hash);

        assert!(!recovery_mismatches().lock().unwrap().contains(&hash));
        new_torrents_initializing().lock().unwrap().remove(&hash);
    }

    #[test]
    fn rate_uses_only_the_last_five_seconds() {
        let start = std::time::Instant::now();
        let mut rate = RateWindow::default();
        assert_eq!(rate.update(start, 0, 0), (0, 0));
        assert_eq!(rate.update(start + Duration::from_secs(1), 5_000, 0).0, 0);
        assert_eq!(rate.update(start + Duration::from_secs(2), 6_000, 0).0, 0);
        // The initial burst is outside the window now: the last five seconds
        // contain 5,000 bytes, so the displayed rate is 1,000 B/s.
        assert_eq!(
            rate.update(start + Duration::from_secs(6), 10_000, 0).0,
            1_000
        );
    }

    #[test]
    fn rate_is_held_between_one_second_display_updates() {
        let start = std::time::Instant::now();
        let mut rate = RateWindow::default();
        rate.update(start, 0, 0);
        assert_eq!(
            rate.update(start + Duration::from_secs(5), 5_000, 0).0,
            1_000
        );
        assert_eq!(
            rate.update(start + Duration::from_millis(5_300), 5_900, 0)
                .0,
            1_000
        );
    }
}

impl State {
    fn settings_path(&self) -> PathBuf {
        self.state_dir.join("settings.json")
    }
    fn queue_path(&self) -> PathBuf {
        self.state_dir.join("queue.json")
    }
    fn completions_path(&self) -> PathBuf {
        self.state_dir.join("completions.json")
    }

    fn save_settings(&self) {
        let _ = std::fs::write(
            self.settings_path(),
            serde_json::to_vec_pretty(&self.settings).unwrap_or_default(),
        );
    }

    fn save_queue(&self) {
        let _ = std::fs::write(
            self.queue_path(),
            serde_json::to_vec_pretty(&self.queue).unwrap_or_default(),
        );
    }

    fn save_completions(&self) {
        let _ = std::fs::write(
            self.completions_path(),
            serde_json::to_vec_pretty(&self.completed_at).unwrap_or_default(),
        );
    }

    /// Apply the session-wide limits that can be changed while running.
    fn apply_limits(&self) {
        self.session
            .ratelimits
            .set_download_bps(self.settings.download_bps.and_then(NonZeroU32::new));
        self.session
            .ratelimits
            .set_upload_bps(self.settings.upload_bps.and_then(NonZeroU32::new));
    }
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct Request {
    id: u64,
    op: String,
    #[serde(default)]
    arg: Value,
}

/// The one place anything is written to stdout. A single task owns the handle,
/// so lines never interleave, and the queue in front of it is bounded.
#[derive(Clone)]
struct Writer {
    tx: mpsc::Sender<String>,
}

impl Writer {
    /// A reply. Worth blocking a moment for, but never forever: if the queue
    /// is full the app's own timeout is what resolves it.
    fn reply(&self, id: u64, result: Result<Value>) {
        let line = match result {
            Ok(result) => json!({ "id": id, "ok": true, "result": result }),
            Err(error) => json!({ "id": id, "ok": false, "error": format!("{error:#}") }),
        };
        let _ = self.tx.try_send(line.to_string());
    }

    /// An unprompted line. Dropped without ceremony when the queue is full —
    /// snapshots and heartbeats are only ever the latest truth, and the next
    /// one is a few hundred milliseconds away.
    fn event(&self, name: &str, data: Value) -> bool {
        self.tx
            .try_send(json!({ "event": name, "data": data }).to_string())
            .is_ok()
    }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/// One torrent, flattened to exactly what a row in the list needs. Built here
/// rather than forwarding the engine's own structs, so the shape the front end
/// reads is this repo's and does not move when the engine is upgraded.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    id: usize,
    info_hash: String,
    name: String,
    output_folder: String,
    /// `initializing` (hash-checking), `live`, `paused`, `error`, or `queued`
    /// — the last being this helper's own, for a torrent waiting its turn.
    state: &'static str,
    error: Option<String>,
    total_bytes: u64,
    progress_bytes: u64,
    uploaded_bytes: u64,
    finished: bool,
    /// Unix time in milliseconds. Absent for torrents completed before WinT
    /// began recording this field.
    completed_at: Option<u64>,
    download_bps: u64,
    upload_bps: u64,
    peers: u32,
    peers_queued: u32,
    /// Seconds, when the engine can estimate one.
    eta_seconds: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    torrents: Vec<Row>,
    download_bps: u64,
    upload_bps: u64,
    peers: u32,
    uptime_seconds: u64,
    settings: Settings,
}

fn build_snapshot(
    state: &mut State,
    queued: &HashSet<usize>,
    missing: &HashSet<usize>,
) -> Snapshot {
    let list = state
        .api
        .api_torrent_list_ext(ApiTorrentListOpts { with_stats: true });
    let mut torrents = Vec::with_capacity(list.torrents.len());
    let mut live_ids = HashSet::with_capacity(list.torrents.len());
    let mut completions_changed = false;
    let now = std::time::Instant::now();
    for t in list.torrents {
        let id = t.id.unwrap_or(0);
        live_ids.insert(id);
        let stats = match &t.stats {
            Some(stats) => stats,
            None => continue,
        };
        let live = stats.live.as_ref();
        if stats.finished && !state.completed_at.contains_key(&t.info_hash) {
            let newly_completed = state.completion_candidates.remove(&t.info_hash);
            let completed_at = if newly_completed {
                Some(std::time::SystemTime::now())
            } else {
                // Before WinT recorded completion dates, the final write to
                // librqbit's piece map is the closest durable timestamp.
                std::fs::metadata(state.state_dir.join(format!("{}.bitv", t.info_hash)))
                    .and_then(|metadata| metadata.modified())
                    .ok()
            };
            if let Some(completed_at) = completed_at {
                let completed_at = completed_at
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or(0);
                state.completed_at.insert(t.info_hash.clone(), completed_at);
                completions_changed = true;
            }
        }
        if !matches!(
            &stats.state,
            librqbit::TorrentStatsState::Initializing { .. }
        ) {
            if let Ok(mut hashes) = new_torrents_initializing().lock() {
                hashes.remove(&t.info_hash);
            }
        }
        let rate = state.rates.entry(id).or_default();
        let (download_bps, upload_bps) = if matches!(stats.state, librqbit::TorrentStatsState::Live)
        {
            rate.update(now, stats.progress_bytes, stats.uploaded_bytes)
        } else {
            // `progress_bytes` also advances while existing files are hashed.
            // That is disk read progress, not network download traffic.
            *rate = RateWindow::default();
            (0, 0)
        };
        let eta_seconds = (download_bps > 0)
            .then(|| stats.total_bytes.saturating_sub(rate.shown_downloaded) / download_bps);
        // Files gone from disk outranks everything the engine would say: a
        // torrent happily "seeding" nothing is the misleading case this is
        // here to prevent.
        let mismatched = recovery_mismatches()
            .lock()
            .map(|found| found.contains(&t.info_hash))
            .unwrap_or(false);
        let state_word = if mismatched {
            "needs-check"
        } else if missing.contains(&id) {
            "missing"
        } else {
            match &stats.state {
                librqbit::TorrentStatsState::Initializing { queued: true, .. } => "check-queued",
                librqbit::TorrentStatsState::Initializing { .. } => "initializing",
                librqbit::TorrentStatsState::Live => "live",
                librqbit::TorrentStatsState::Error => "error",
                // A torrent the user wants but that is behind the active limit is
                // "queued", not "paused" — the difference is whose decision it was.
                librqbit::TorrentStatsState::Paused if queued.contains(&id) => "queued",
                librqbit::TorrentStatsState::Paused => "paused",
            }
        };
        torrents.push(Row {
            id,
            info_hash: t.info_hash.clone(),
            name: t.name.clone().unwrap_or_else(|| t.info_hash.clone()),
            output_folder: t.output_folder.clone(),
            state: state_word,
            error: stats.error.clone(),
            total_bytes: stats.total_bytes,
            progress_bytes: stats.progress_bytes,
            uploaded_bytes: stats.uploaded_bytes,
            finished: stats.finished,
            completed_at: state.completed_at.get(&t.info_hash).copied(),
            download_bps,
            upload_bps,
            peers: live.map(|l| l.snapshot.peer_stats.live).unwrap_or(0),
            peers_queued: live.map(|l| l.snapshot.peer_stats.queued).unwrap_or(0),
            // Worked out here rather than taken from the engine, whose own
            // estimate is a display string with no number behind it.
            eta_seconds,
        });
    }
    if completions_changed {
        state.save_completions();
    }
    state.rates.retain(|id, _| live_ids.contains(id));
    let session = state.api.api_session_stats();
    Snapshot {
        download_bps: torrents.iter().map(|torrent| torrent.download_bps).sum(),
        upload_bps: torrents.iter().map(|torrent| torrent.upload_bps).sum(),
        torrents,
        peers: session.peers.live,
        uptime_seconds: session.uptime_seconds,
        settings: state.settings.clone(),
    }
}

// ---------------------------------------------------------------------------
// The queue: who runs, who waits
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Where a torrent's files actually are
// ---------------------------------------------------------------------------

/// The real, absolute paths of the files a torrent has been told to fetch.
///
/// `output_folder` on its own is the *session's* download folder — very often
/// the user's whole Downloads directory — so it is never what a torrent's
/// files may be deleted through. The per-file `components` are the path below
/// it, and joining the two is the only thing that names this torrent's files
/// and nothing else.
fn torrent_paths(api: &Api, id: TorrentIdOrHash) -> Result<(PathBuf, Vec<PathBuf>)> {
    let details = api.api_torrent_details(id)?;
    let root = PathBuf::from(&details.output_folder);
    let files = details
        .files
        .as_ref()
        .context("that torrent's file list is not known yet")?
        .iter()
        .filter(|file| file.included)
        .map(|file| {
            // Components come from a torrent file, which came from a stranger.
            // Anything that could climb out of the output folder is dropped,
            // so a crafted torrent cannot name a path elsewhere on the disk.
            let mut path = root.clone();
            for part in &file.components {
                if part.is_empty() || part == "." || part == ".." || part.contains(['/', '\\']) {
                    continue;
                }
                path.push(part);
            }
            path
        })
        .filter(|path| path != &root)
        .collect();
    Ok((root, files))
}

/// The folder that holds this torrent and nothing else, when there is one.
///
/// `None` for a single-file torrent sitting loose in the download folder, and
/// deliberately `None` rather than the download folder itself — removing a
/// torrent must never be able to take the whole Downloads directory with it.
fn torrent_root(output_folder: &Path, base: &Path, files: &[PathBuf]) -> Option<PathBuf> {
    // A torrent added by this app is given a folder of its own, and that
    // folder is its output folder. Two guards before it can be deleted: it
    // must not be the download folder everything shares, and it must have a
    // parent — so a bare drive root can never be the answer.
    if output_folder != base
        && output_folder.parent().is_some()
        && !files.is_empty()
        && files.iter().all(|file| file.starts_with(output_folder))
    {
        return Some(output_folder.to_path_buf());
    }

    // Older torrents, added before that was so, sit in a folder the engine
    // made inside the download folder — or loose in it, which is the `None`
    // case, because the download folder itself is never the answer.
    let first = files.first()?;
    let own = first.parent()?;
    if own == output_folder {
        return None;
    }
    // Only when every file really is under it.
    let candidate = {
        let mut walk = own;
        while let Some(parent) = walk.parent() {
            if parent == output_folder {
                break;
            }
            walk = parent;
        }
        walk.to_path_buf()
    };
    if candidate == output_folder || !candidate.starts_with(output_folder) {
        return None;
    }
    files
        .iter()
        .all(|file| file.starts_with(&candidate))
        .then_some(candidate)
}

/// Whether a finished torrent's files are still on disk.
///
/// Checked on a sample rather than in full: a torrent may hold a hundred
/// thousand files, and stat-ing all of them on a timer would be its own
/// problem. Someone deleting a download removes the folder or the file, not
/// every tenth file, so a sample answers the real question at a fixed cost.
fn files_are_missing(files: &[PathBuf]) -> bool {
    if files.is_empty() {
        return false;
    }
    let step = (files.len() / MISSING_CHECK_SAMPLE).max(1);
    files
        .iter()
        .step_by(step)
        .take(MISSING_CHECK_SAMPLE)
        .any(|path| !path.exists())
}

/// Decide which torrents should be live and move the ones that disagree.
///
/// Returns the ids that are paused only because they are waiting their turn,
/// so a snapshot can say "queued" rather than "paused" about them.
async fn reconcile(state: &State, missing: &HashSet<usize>) -> HashSet<usize> {
    let list = state
        .api
        .api_torrent_list_ext(ApiTorrentListOpts { with_stats: true });
    let paused_by_user: HashSet<&str> = state.queue.paused.iter().map(String::as_str).collect();

    // Order by the queue the user built; anything not in it goes to the back.
    let order: HashMap<&str, usize> = state
        .queue
        .wanted
        .iter()
        .enumerate()
        .map(|(i, h)| (h.as_str(), i))
        .collect();
    let mut items: Vec<_> = list
        .torrents
        .iter()
        .filter_map(|t| {
            let stats = t.stats.as_ref()?;
            Some((t.id?, t.info_hash.as_str(), stats))
        })
        .collect();
    items.sort_by_key(|(_, hash, _)| order.get(hash).copied().unwrap_or(usize::MAX));

    let mut slots = state.settings.max_active;
    let mut queued = HashSet::new();

    for (id, hash, stats) in items {
        let is_paused = matches!(stats.state, librqbit::TorrentStatsState::Paused);
        let errored = matches!(stats.state, librqbit::TorrentStatsState::Error);
        if errored {
            continue;
        }

        let mismatched = recovery_mismatches()
            .lock()
            .map(|found| found.contains(hash))
            .unwrap_or(false);
        let should_run = if mismatched {
            false
        } else if missing.contains(&id) {
            // Nothing to serve and nothing to resume: seeding a torrent whose
            // files have been deleted only advertises data that is not there.
            false
        } else if paused_by_user.contains(hash) {
            false
        } else if stats.finished {
            // A finished torrent seeds without taking a download slot.
            state.settings.seed_when_finished
        } else if slots > 0 {
            slots -= 1;
            true
        } else {
            queued.insert(id);
            false
        };

        if should_run && is_paused {
            let _ = state
                .api
                .api_torrent_action_start(TorrentIdOrHash::Id(id))
                .await;
        } else if !should_run && !is_paused {
            let _ = state
                .api
                .api_torrent_action_pause(TorrentIdOrHash::Id(id))
                .await;
        }
    }
    queued
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn torrent_id(arg: &Value) -> Result<TorrentIdOrHash> {
    if let Some(id) = arg.get("id").and_then(Value::as_u64) {
        return Ok(TorrentIdOrHash::Id(id as usize));
    }
    if let Some(hash) = arg.get("infoHash").and_then(Value::as_str) {
        return TorrentIdOrHash::parse(hash).context("not a usable torrent id");
    }
    bail!("no torrent id given")
}

/// A folder name for a torrent, safe to put on a Windows disk.
///
/// The name comes out of a torrent file, so it is a stranger's string: it may
/// hold separators, `..`, control characters, a reserved device name, or be
/// hundreds of characters long. Everything questionable is replaced rather
/// than rejected, because a torrent with an awkward name should still
/// download — into a folder whose name cannot escape where it was put.
fn folder_name_for(name: Option<&str>) -> String {
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let raw = name.unwrap_or("").trim();
    let mut cleaned: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    // Windows quietly drops a trailing dot or space, which would leave the
    // folder under a different name than the one recorded here.
    while cleaned.ends_with('.') || cleaned.ends_with(' ') {
        cleaned.pop();
    }
    // Long names are cut on a character boundary, leaving room for the file
    // names that go inside.
    if cleaned.chars().count() > 120 {
        cleaned = cleaned.chars().take(120).collect();
        while cleaned.ends_with('.') || cleaned.ends_with(' ') {
            cleaned.pop();
        }
    }
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." || RESERVED.contains(&stem.as_str())
    {
        // Nothing usable in the name: the torrent still needs somewhere to go.
        return format!(
            "torrent-{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
    }
    cleaned
}

/// Read a `.torrent` from disk, refusing anything that is the wrong shape
/// before a parser is handed it.
fn read_torrent_file(path: &str) -> Result<Vec<u8>> {
    let meta = std::fs::metadata(path).with_context(|| format!("cannot read {path}"))?;
    if !meta.is_file() {
        bail!("{path} is not a file");
    }
    if meta.len() > MAX_TORRENT_FILE_BYTES {
        bail!(
            "{path} is {} bytes — too large to be a torrent file",
            meta.len()
        );
    }
    if meta.len() == 0 {
        bail!("{path} is empty");
    }
    std::fs::read(path).with_context(|| format!("cannot read {path}"))
}

/// One torrent's description, with the file list cut to something a webview
/// can parse inside a frame.
///
/// A torrent may hold a hundred thousand files, and the whole list in one
/// reply would be tens of megabytes of JSON. Whoever receives it has to parse
/// that on the thread that draws, so the page would stop reacting for as long
/// as it took — which is exactly what must never happen. The list is therefore
/// capped here, at the source, and the reply says how many there really are so
/// the page can be honest about what it is showing.
///
/// `components` is deliberately not sent: it is the path split into parts,
/// which nothing displays, and it roughly doubles the size of the list.
fn details_json(details: &TorrentDetailsResponse) -> Value {
    let total = details.files.as_ref().map(Vec::len).unwrap_or(0);
    json!({
        "id": details.id,
        "infoHash": details.info_hash,
        "name": details.name,
        "outputFolder": details.output_folder,
        "totalPieces": details.total_pieces,
        "fileCount": total,
        "filesTruncated": total > MAX_FILES_IN_REPLY,
        "files": details.files.as_ref().map(|files| files.iter().take(MAX_FILES_IN_REPLY).map(|f| json!({
            "name": f.name,
            "length": f.length,
            "included": f.included,
        })).collect::<Vec<_>>()),
    })
}

async fn handle(state: &Mutex<State>, op: &str, arg: Value) -> Result<Value> {
    match op {
        // Who am I, and is anything already running? The app's first call.
        "hello" => {
            let state = state.lock().await;
            Ok(json!({
                "engine": librqbit::client_name_and_version(),
                "pid": std::process::id(),
                "listenPort": state.session.listen_addr().map(|a| a.port()),
                "settings": state.settings,
            }))
        }

        // Add from a magnet/http URL or from a local .torrent file.
        "add" => {
            let mut state = state.lock().await;
            let paused = arg.get("paused").and_then(Value::as_bool).unwrap_or(false);
            let folder = arg
                .get("outputFolder")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| state.settings.download_folder.clone());
            let only_files = arg.get("onlyFiles").and_then(Value::as_array).map(|a| {
                a.iter()
                    .filter_map(Value::as_u64)
                    .map(|v| v as usize)
                    .collect::<Vec<_>>()
            });

            let source = if let Some(url) = arg.get("url").and_then(Value::as_str) {
                let url = url.trim();
                if !librqbit::SUPPORTED_SCHEMES
                    .iter()
                    .any(|s| url.starts_with(s))
                {
                    bail!("that is not a magnet link or a torrent URL");
                }
                AddTorrent::from_url(url.to_owned())
            } else if let Some(path) = arg.get("path").and_then(Value::as_str) {
                AddTorrent::from_bytes(read_torrent_file(path)?)
            } else {
                bail!("nothing to add");
            };

            // Read the metadata before starting anything, so the torrent's
            // name is known and it can be given a folder of its own.
            //
            // The engine only makes a sub-folder by itself for multi-file
            // torrents, and not at all once an output folder is named — which
            // would tip every download straight into the chosen drive. So the
            // name is looked up first and the folder is built here. The probe
            // hands back the torrent bytes it fetched, and the real add reuses
            // them, so a magnet's metadata is pulled over the network once.
            let probe = state
                .session
                .add_torrent(
                    source,
                    Some(AddTorrentOptions {
                        list_only: true,
                        ..Default::default()
                    }),
                )
                .await
                .context("error reading the torrent")?;

            let (torrent_name, torrent_bytes, info_hash) = match probe {
                librqbit::AddTorrentResponse::ListOnly(listing) => (
                    listing.info.name().map(|name| name.to_string()),
                    listing.torrent_bytes,
                    listing.info_hash.as_string().to_ascii_lowercase(),
                ),
                // Already in the list: say so and leave it where it is.
                librqbit::AddTorrentResponse::AlreadyManaged(id, handle) => {
                    return Ok(json!({
                        "id": id,
                        "alreadyAdded": true,
                        "outputFolder": handle.shared().info_hash.as_string(),
                        "details": { "infoHash": handle.shared().info_hash.as_string(),
                                     "name": handle.name() },
                    }));
                }
                librqbit::AddTorrentResponse::Added(id, handle) => {
                    return Ok(json!({
                        "id": id,
                        "details": { "infoHash": handle.shared().info_hash.as_string(),
                                     "name": handle.name() },
                    }));
                }
            };

            let folder = PathBuf::from(&folder)
                .join(folder_name_for(torrent_name.as_deref()))
                .to_string_lossy()
                .into_owned();

            let opts = AddTorrentOptions {
                paused,
                output_folder: Some(folder),
                only_files,
                overwrite: true,
                peer_limit: Some(state.settings.peer_limit),
                ..Default::default()
            };

            if let Ok(mut hashes) = new_torrents_initializing().lock() {
                hashes.insert(info_hash.clone());
            }
            let added = state
                .api
                .api_add_torrent(AddTorrent::from_bytes(torrent_bytes), Some(opts))
                .await;
            if added.is_err() {
                if let Ok(mut hashes) = new_torrents_initializing().lock() {
                    hashes.remove(&info_hash);
                }
            }
            let added = added?;
            let hash = added.details.info_hash.clone();
            if added.id.is_some() {
                state.completion_candidates.insert(hash.clone());
                if !state.queue.wanted.contains(&hash) {
                    state.queue.wanted.push(hash.clone());
                }
                if paused {
                    if !state.queue.paused.contains(&hash) {
                        state.queue.paused.push(hash.clone());
                    }
                } else {
                    state.queue.paused.retain(|h| *h != hash);
                }
                state.save_queue();
            }
            Ok(json!({
                "id": added.id,
                "outputFolder": added.output_folder,
                "details": details_json(&added.details),
            }))
        }

        "pause" | "start" => {
            let mut state = state.lock().await;
            let id = torrent_id(&arg)?;
            let handle = state.api.mgr_handle(id)?;
            let hash = handle.shared().info_hash.as_string();
            if op == "pause" {
                if !state.queue.paused.contains(&hash) {
                    state.queue.paused.push(hash);
                }
                state.api.api_torrent_action_pause(id).await?;
            } else {
                state.queue.paused.retain(|h| *h != hash);
                if !state.queue.wanted.contains(&hash) {
                    state.queue.wanted.push(hash);
                }
            }
            state.save_queue();
            // `reconcile` on the next tick decides whether a started torrent
            // runs now or waits, so the active limit is honoured either way.
            Ok(json!({}))
        }

        // Take it off the list. `deleteFiles` says whether what was downloaded
        // goes with it.
        "remove" => {
            let mut state = state.lock().await;
            let id = torrent_id(&arg)?;
            let hash = state
                .api
                .mgr_handle(id)
                .map(|h| h.shared().info_hash.as_string())
                .ok();
            if arg
                .get("deleteFiles")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                state.api.api_torrent_action_delete(id).await?;
            } else {
                state.api.api_torrent_action_forget(id).await?;
            }
            if let Some(hash) = hash {
                state.queue.wanted.retain(|h| *h != hash);
                state.queue.paused.retain(|h| *h != hash);
                state.completion_candidates.remove(&hash);
                if state.completed_at.remove(&hash).is_some() {
                    state.save_completions();
                }
                state.save_queue();
            }
            Ok(json!({}))
        }

        // Which files to fetch. This is what "priority" means in a torrent:
        // a file is either wanted or it is not.
        // Which files to fetch, as a change rather than a whole new set.
        //
        // A delta, because the page may only be holding the first few thousand
        // files of a very long torrent (see `details_json`). Sending a full
        // list built from a truncated view would silently drop every file
        // past the cut from the selection. Starting from the engine's own answer and applying the
        // one thing the user actually clicked cannot do that.
        "only_files" => {
            let state = state.lock().await;
            let id = torrent_id(&arg)?;
            let details = state.api.api_torrent_details(id)?;
            let files = details
                .files
                .as_ref()
                .context("that torrent's file list is not known yet")?;

            let indices = |key: &str| -> Vec<usize> {
                arg.get(key)
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_u64)
                            .map(|v| v as usize)
                            .filter(|i| *i < files.len())
                            .collect()
                    })
                    .unwrap_or_default()
            };

            let mut wanted: HashSet<usize> = files
                .iter()
                .enumerate()
                .filter(|(_, file)| file.included)
                .map(|(index, _)| index)
                .collect();
            for index in indices("include") {
                wanted.insert(index);
            }
            for index in indices("exclude") {
                wanted.remove(&index);
            }
            if wanted.is_empty() {
                bail!("at least one file has to stay selected");
            }
            // The engine will not change the selection of a torrent it is
            // still hash-checking. That is a normal thing to run into — the
            // check starts the moment a torrent is added — so it is worth
            // saying in words rather than passing the engine's own phrasing on.
            state
                .api
                .api_torrent_action_update_only_files(id, &wanted)
                .await
                .map_err(|error| {
                    if error.to_string().contains("initializing") {
                        anyhow::anyhow!(
                            "this torrent is still being checked; \
                             choose which files to fetch once the check has finished"
                        )
                    } else {
                        anyhow::Error::from(error)
                    }
                })?;
            Ok(json!({ "included": wanted.len(), "total": files.len() }))
        }

        // The file list and per-file progress — asked for only when a torrent
        // is selected, never streamed, because it is the long part.
        "details" => {
            let state = state.lock().await;
            let id = torrent_id(&arg)?;
            let details = state.api.api_torrent_details(id)?;
            let stats = state.api.api_stats_v1(id).ok();
            Ok(json!({
                "details": details_json(&details),
                "fileProgress": stats.as_ref().map(|s| s.file_progress.clone()),
            }))
        }

        // Where this torrent's files really are, so the app can hand them to
        // the Recycle Bin or to Explorer.
        //
        // `root` is the folder that holds this torrent and nothing else, and
        // is absent when there is no such folder — a single-file torrent sits
        // loose in the download folder, and the download folder is never
        // something a "remove this torrent" can be allowed to delete.
        "paths" => {
            let state = state.lock().await;
            let id = torrent_id(&arg)?;
            let (output_folder, files) = torrent_paths(&state.api, id)?;
            let base = PathBuf::from(&state.settings.download_folder);
            let root = torrent_root(&output_folder, &base, &files);
            Ok(json!({
                "outputFolder": output_folder.to_string_lossy(),
                "root": root.as_ref().map(|p| p.to_string_lossy()),
                "rootExists": root.as_ref().map(|p| p.exists()),
                "files": files.iter().take(MAX_FILES_IN_REPLY)
                    .map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>(),
                "fileCount": files.len(),
            }))
        }

        // One file's absolute path, for opening it.
        //
        // Asked for one file at a time rather than sent with the list: a path
        // per file would roughly double a list that is already capped for
        // being too big to parse, and this is only ever wanted for the single
        // file somebody just double-clicked.
        "file_path" => {
            let state = state.lock().await;
            let id = torrent_id(&arg)?;
            let index = arg
                .get("index")
                .and_then(Value::as_u64)
                .context("no file was named")? as usize;
            let details = state.api.api_torrent_details(id)?;
            let files = details
                .files
                .as_ref()
                .context("that torrent's file list is not known yet")?;
            let file = files.get(index).context("no such file in this torrent")?;
            let mut path = PathBuf::from(&details.output_folder);
            for part in &file.components {
                if part.is_empty() || part == "." || part == ".." || part.contains(['/', '\\']) {
                    continue;
                }
                path.push(part);
            }
            Ok(json!({
                "path": path.to_string_lossy(),
                "exists": path.exists(),
                "name": file.name,
            }))
        }

        // Per-peer detail, on demand and for one torrent at a time. Deliberately
        // never part of a snapshot.
        "peers" => {
            let state = state.lock().await;
            let id = torrent_id(&arg)?;
            let peers = state.api.api_peer_stats(id, Default::default())?;
            Ok(serde_json::to_value(peers)?)
        }

        // Change anything in settings; absent keys are left alone.
        "settings" => {
            let mut state = state.lock().await;
            if let Some(folder) = arg.get("downloadFolder").and_then(Value::as_str) {
                if !folder.trim().is_empty() {
                    std::fs::create_dir_all(folder)
                        .with_context(|| format!("cannot use {folder} as a download folder"))?;
                    state.settings.download_folder = folder.to_owned();
                }
            }
            if let Some(v) = arg.get("downloadBps") {
                state.settings.download_bps = v.as_u64().map(|v| v.min(u32::MAX as u64) as u32);
            }
            if let Some(v) = arg.get("uploadBps") {
                state.settings.upload_bps = v.as_u64().map(|v| v.min(u32::MAX as u64) as u32);
            }
            if let Some(v) = arg.get("maxActive").and_then(Value::as_u64) {
                state.settings.max_active = (v as usize).clamp(1, 32);
            }
            if let Some(v) = arg.get("peerLimit").and_then(Value::as_u64) {
                state.settings.peer_limit = (v as usize).clamp(4, 512);
            }
            if let Some(v) = arg.get("seedWhenFinished").and_then(Value::as_bool) {
                state.settings.seed_when_finished = v;
            }
            state.apply_limits();
            state.save_settings();
            Ok(serde_json::to_value(&state.settings)?)
        }

        // Answered without touching the session, so it stays true even while
        // the engine is busy: this is what the app's heartbeat leans on.
        "ping" => Ok(json!({ "pid": std::process::id() })),

        other => bail!("unknown command {other}"),
    }
}

// ---------------------------------------------------------------------------

#[derive(Default)]
struct Args {
    state_dir: Option<PathBuf>,
    download_folder: Option<String>,
    snapshot_ms: u64,
}

fn parse_args() -> Args {
    let mut args = Args {
        snapshot_ms: 300,
        ..Default::default()
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--state-dir" => args.state_dir = it.next().map(PathBuf::from),
            "--download-folder" => args.download_folder = it.next(),
            "--snapshot-ms" => {
                args.snapshot_ms = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(300)
                    .clamp(250, 2000);
            }
            _ => {}
        }
    }
    args
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<()> {
    let args = parse_args();
    let state_dir = args
        .state_dir
        .unwrap_or_else(|| std::env::temp_dir().join("wint-torrent"));
    std::fs::create_dir_all(&state_dir).context("cannot create the torrent state folder")?;
    if let Ok(entries) = std::fs::read_dir(&state_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(hash) = name.strip_prefix("recheck-") {
                if let Ok(mut allowed) = authorized_checks().lock() {
                    allowed.insert(hash.to_ascii_lowercase());
                }
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    let mut settings: Settings = std::fs::read(state_dir.join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    if let Some(folder) = args.download_folder {
        if !folder.trim().is_empty() {
            settings.download_folder = folder;
        }
    }
    let queue: Queue = std::fs::read(state_dir.join("queue.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let completed_at: HashMap<String, u64> = std::fs::read(state_dir.join("completions.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let _ = std::fs::create_dir_all(&settings.download_folder);

    // The writer task owns stdout. Everything else hands it lines.
    let (tx, mut rx) = mpsc::channel::<String>(WRITER_QUEUE);
    let writer = Writer { tx };
    tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        while let Some(line) = rx.recv().await {
            if out.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if out.write_all(b"\n").await.is_err() {
                break;
            }
            let _ = out.flush().await;
        }
    });

    let session = Session::new_with_opts(
        PathBuf::from(&settings.download_folder),
        SessionOptions {
            // The point of the whole arrangement: the torrents live here, in a
            // file this process owns, so the app can kill and restart it
            // without anything being lost.
            persistence: Some(SessionPersistenceConfig::Json {
                folder: Some(state_dir.clone()),
            }),
            fastresume: true,
            // The saved piece map is the normal source of truth on restart.
            // Removing it through "Check files" still forces a full hash pass.
            trust_fastresume: true,
            // Let files grow with downloaded pieces. The stock backend calls
            // set_len() for the torrent's full logical size up front.
            default_storage_factory: Some(Box::new(GrowingFilesFactory)),
            // Hash-checking is the disk-heaviest thing the engine does. The
            // patched engine applies this limit independently to each drive.
            concurrent_init_limit: Some(MAX_CONCURRENT_INITIALIZING_PER_DRIVE),
            peer_limit: Some(settings.peer_limit),
            ratelimits: LimitsConfig {
                download_bps: settings.download_bps.and_then(NonZeroU32::new),
                upload_bps: settings.upload_bps.and_then(NonZeroU32::new),
            },
            listen: Some(ListenerOptions::default()),
            ..Default::default()
        },
    )
    .await
    .context("cannot start the torrent engine")?;

    let api = Api::new(session.clone(), None);
    let state = Arc::new(Mutex::new(State {
        api,
        session,
        state_dir,
        settings,
        queue,
        completed_at,
        completion_candidates: HashSet::new(),
        rates: HashMap::new(),
    }));

    {
        let state = state.lock().await;
        state.apply_limits();
    }
    writer.event(
        "ready",
        json!({
            "engine": librqbit::client_name_and_version(),
            "pid": std::process::id(),
        }),
    );

    // The snapshot/queue loop. One timer drives both: the aggregate line the
    // UI draws from, and the decision about who runs and who waits.
    {
        let state = state.clone();
        let writer = writer.clone();
        let period = Duration::from_millis(args.snapshot_ms);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(period);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut queued = HashSet::new();
            let mut missing: HashSet<usize> = HashSet::new();
            let mut since_reconcile = 0u32;
            // A reconcile every ~2s; a snapshot every tick.
            let reconcile_every = (2000 / args.snapshot_ms).max(1) as u32;
            let mut last_missing_check = std::time::Instant::now() - MISSING_CHECK_EVERY;
            loop {
                tick.tick().await;
                let mut guard = state.lock().await;
                let snapshot = build_snapshot(&mut guard, &queued, &missing);
                drop(guard);
                if let Ok(data) = serde_json::to_value(&snapshot) {
                    writer.event("snapshot", data);
                }

                // Are the files still there? Only finished torrents are worth
                // asking about — an unfinished one is expected to be partly
                // absent — and only every so often, because it touches disk.
                if last_missing_check.elapsed() >= MISSING_CHECK_EVERY {
                    last_missing_check = std::time::Instant::now();
                    let guard = state.lock().await;
                    let finished: Vec<usize> = guard
                        .api
                        .api_torrent_list_ext(ApiTorrentListOpts { with_stats: true })
                        .torrents
                        .iter()
                        .filter(|t| t.stats.as_ref().is_some_and(|s| s.finished))
                        .filter_map(|t| t.id)
                        .collect();
                    let mut found = HashSet::new();
                    for id in finished {
                        if let Ok((_, files)) = torrent_paths(&guard.api, TorrentIdOrHash::Id(id)) {
                            if files_are_missing(&files) {
                                found.insert(id);
                            }
                        }
                    }
                    missing = found;
                }

                since_reconcile += 1;
                if since_reconcile >= reconcile_every {
                    since_reconcile = 0;
                    let guard = state.lock().await;
                    queued = reconcile(&guard, &missing).await;
                }
            }
        });
    }

    // The heartbeat is separate from the snapshot on purpose: it is answered
    // without the session lock, so it keeps arriving even while the engine is
    // deep in a hash check, and the app can tell "busy" from "wedged".
    {
        let writer = writer.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            loop {
                tick.tick().await;
                if !writer.event("heartbeat", json!({ "pid": std::process::id() })) {
                    // The queue is full, which means the app is not reading.
                    // Nothing to do about it here; the app's own watchdog is
                    // what acts on the silence.
                }
            }
        });
    }

    // Commands. Each runs on its own task, so one slow command — adding a
    // magnet, which waits on the DHT — never holds up the next.
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            // stdin closed: WinT is gone, and so is the reason to be running.
            Ok(None) | Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        if line.len() > MAX_REQUEST_BYTES {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(_) => continue,
        };
        if request.op == "shutdown" {
            writer.reply(request.id, Ok(json!({})));
            tokio::time::sleep(Duration::from_millis(50)).await;
            break;
        }
        let state = state.clone();
        let writer = writer.clone();
        tokio::spawn(async move {
            let result = handle(&state, &request.op, request.arg).await;
            writer.reply(request.id, result);
        });
    }

    let session = { state.lock().await.session.clone() };
    session.stop().await;
    Ok(())
}
