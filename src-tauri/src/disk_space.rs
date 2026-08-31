use serde::Serialize;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    pub path: String,
    pub label: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpaceItem {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub is_dir: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpaceScan {
    pub path: String,
    pub bytes: u64,
    pub children: Vec<SpaceItem>,
    pub skipped: u64,
}

#[cfg(windows)]
pub fn drives() -> Result<Vec<Drive>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives,
    };
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for index in 0..26u32 {
        if mask & (1 << index) == 0 {
            continue;
        }
        let letter = (b'A' + index as u8) as char;
        let path = format!("{letter}:\\");
        let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
        let kind = unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) };
        // Win32 DRIVE_REMOVABLE (2) and DRIVE_FIXED (3). Network and optical
        // volumes are intentionally absent from a local-disk scanner.
        if kind != 2 && kind != 3 {
            continue;
        }
        let (mut available, mut total, mut free) = (0u64, 0u64, 0u64);
        if unsafe {
            GetDiskFreeSpaceExW(
                PCWSTR(wide.as_ptr()),
                Some(&mut available),
                Some(&mut total),
                Some(&mut free),
            )
        }
        .is_err()
        {
            continue;
        }
        out.push(Drive {
            path: path.clone(),
            label: format!("{letter}:"),
            total_bytes: total,
            free_bytes: free,
        });
    }
    Ok(out)
}

#[cfg(not(windows))]
pub fn drives() -> Result<Vec<Drive>, String> {
    Ok(Vec::new())
}

fn folder_size(path: &Path, skipped: &mut u64) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        *skipped += 1;
        return 0;
    };
    entries.flatten().fold(0u64, |total, entry| {
        if entry
            .file_type()
            .map(|kind| kind.is_symlink())
            .unwrap_or(true)
        {
            return total;
        }
        let Ok(meta) = entry.metadata() else {
            *skipped += 1;
            return total;
        };
        total.saturating_add(if meta.is_dir() {
            folder_size(&entry.path(), skipped)
        } else {
            meta.len()
        })
    })
}

fn folder_size_while(path: &Path, skipped: &mut u64, active: &dyn Fn() -> bool) -> u64 {
    if !active() {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        *skipped += 1;
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        if !active() {
            return total;
        }
        if entry
            .file_type()
            .map(|kind| kind.is_symlink())
            .unwrap_or(true)
        {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            *skipped += 1;
            continue;
        };
        total = total.saturating_add(if meta.is_dir() {
            folder_size_while(&entry.path(), skipped, active)
        } else {
            meta.len()
        });
    }
    total
}

pub fn scan(raw_path: String) -> Result<SpaceScan, String> {
    let path = PathBuf::from(&raw_path);
    if !path.is_dir() {
        return Err("That folder is no longer available.".into());
    }
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    let mut skipped = 0u64;
    let entries = std::fs::read_dir(&canonical).map_err(|e| e.to_string())?;
    let mut children = Vec::new();
    for entry in entries.flatten() {
        if entry
            .file_type()
            .map(|kind| kind.is_symlink())
            .unwrap_or(true)
        {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            skipped += 1;
            continue;
        };
        let is_dir = meta.is_dir();
        let bytes = if is_dir {
            folder_size(&entry.path(), &mut skipped)
        } else {
            meta.len()
        };
        children.push(SpaceItem {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            bytes,
            is_dir,
        });
    }
    children.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    let bytes = children.iter().map(|item| item.bytes).sum();
    Ok(SpaceScan {
        path: canonical.to_string_lossy().into_owned(),
        bytes,
        children,
        skipped,
    })
}

pub fn scan_stream<F, A>(
    raw_path: String,
    mut item_ready: F,
    active: A,
) -> Result<SpaceScan, String>
where
    F: FnMut(SpaceItem),
    A: Fn() -> bool + Send + Sync + 'static,
{
    let path = PathBuf::from(&raw_path);
    if !path.is_dir() {
        return Err("That folder is no longer available.".into());
    }
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    let mut skipped = 0u64;
    let entries = std::fs::read_dir(&canonical).map_err(|e| e.to_string())?;
    let jobs: VecDeque<_> = entries
        .flatten()
        .filter_map(|entry| {
            if entry
                .file_type()
                .map(|kind| kind.is_symlink())
                .unwrap_or(true)
            {
                None
            } else {
                Some(entry)
            }
        })
        .collect();
    let jobs = Arc::new(Mutex::new(jobs));
    let active = Arc::new(active);
    let (send, receive) = mpsc::channel();
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(2, 8);
    let mut handles = Vec::new();
    for _ in 0..workers {
        let jobs = Arc::clone(&jobs);
        let active = Arc::clone(&active);
        let send = send.clone();
        handles.push(std::thread::spawn(move || loop {
            if !active() {
                break;
            }
            let entry = jobs.lock().ok().and_then(|mut queue| queue.pop_front());
            let Some(entry) = entry else { break };
            let Ok(meta) = entry.metadata() else {
                let _ = send.send((None, 1));
                continue;
            };
            let is_dir = meta.is_dir();
            let mut skipped = 0;
            let bytes = if is_dir {
                folder_size_while(&entry.path(), &mut skipped, active.as_ref())
            } else {
                meta.len()
            };
            if active() {
                let item = SpaceItem {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    path: entry.path().to_string_lossy().into_owned(),
                    bytes,
                    is_dir,
                };
                let _ = send.send((Some(item), skipped));
            }
        }));
    }
    drop(send);
    let mut children = Vec::new();
    for (item, missed) in receive {
        skipped += missed;
        if let Some(item) = item {
            item_ready(item.clone());
            children.push(item);
        }
    }
    for handle in handles {
        let _ = handle.join();
    }
    if !active() {
        return Err("Scan cancelled.".into());
    }
    children.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    let bytes = children.iter().map(|item| item.bytes).sum();
    Ok(SpaceScan {
        path: canonical.to_string_lossy().into_owned(),
        bytes,
        children,
        skipped,
    })
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn enumerates_local_drives() {
        let drives = super::drives().unwrap();
        eprintln!("drives={}", serde_json::to_string(&drives).unwrap());
        assert!(!drives.is_empty());
    }
}
