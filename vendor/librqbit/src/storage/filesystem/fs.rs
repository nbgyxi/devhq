use std::{
    fs::OpenOptions,
    io::IoSlice,
    path::{Path, PathBuf},
};

use anyhow::Context;
use tracing::warn;

use crate::{
    storage::{StorageFactoryExt, filesystem::opened_file::OurFileExt},
    torrent_state::{ManagedTorrentShared, TorrentMetadata},
};

use crate::storage::{StorageFactory, TorrentStorage};

use super::opened_file::OpenedFile;

#[derive(Default, Clone, Copy)]
pub struct FilesystemStorageFactory {}

impl StorageFactory for FilesystemStorageFactory {
    type Storage = FilesystemStorage;

    fn create(
        &self,
        shared: &ManagedTorrentShared,
        _metadata: &TorrentMetadata,
    ) -> anyhow::Result<FilesystemStorage> {
        Ok(FilesystemStorage {
            output_folder: shared.options.output_folder.clone(),
            opened_files: Default::default(),
        })
    }

    fn clone_box(&self) -> crate::storage::BoxStorageFactory {
        self.boxed()
    }
}

pub struct FilesystemStorage {
    pub(crate) output_folder: PathBuf,
    pub(crate) opened_files: Vec<OpenedFile>,
}

impl FilesystemStorage {
    #[allow(dead_code)]
    pub(crate) fn take_fs(&self) -> anyhow::Result<Self> {
        Ok(Self {
            opened_files: self
                .opened_files
                .iter()
                .map(|f| f.take_clone())
                .collect::<anyhow::Result<Vec<_>>>()?,
            output_folder: self.output_folder.clone(),
        })
    }
}

/// Say everything known about a write that failed.
///
/// One file failing while every other file on the same drive is written
/// without trouble is not a drive that has stopped working, and the two were
/// indistinguishable from the message alone: a file id, an error, and nothing
/// to say whether the file was unusual. Where in the file, how big the write
/// was, how big the file is, and what Windows thinks its attributes are
/// together answer that, and they are cheap because this only runs when
/// something has already gone wrong.
fn describe_on_failure<T>(
    of: &OpenedFile,
    file_id: usize,
    offset: u64,
    len: usize,
    op: impl FnOnce() -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    match op() {
        Ok(v) => Ok(v),
        Err(e) => {
            // Attached to the error, not merely logged. The error is what the
            // window shows and what gets copied into a bug report; a log line
            // somewhere else is no use to whoever is looking at the failure.
            let detail = format!(
                "writing {len} bytes at offset {offset} (ending at {}) of file {file_id}, {}",
                offset + len as u64,
                of.describe()
            );
            warn!("{detail}: {e:#}");
            Err(e.context(detail))
        }
    }
}

/// Run a file operation, and if it fails because the handle no longer refers
/// to a working device, open the file again and run it once more.
///
/// This is what a removable drive that vanishes and comes back needs. While it
/// is away, every handle on it is dead, and the system says so with
/// "Incorrect function" - an answer that does not change no matter how many
/// times the same handle is used, so the ordinary retry higher up cannot get
/// past it. Reopening is the only move that can, and once the drive is back
/// it succeeds immediately.
///
/// Exactly one extra attempt. If the drive really is gone the reopen fails on
/// its own and the original error is what the caller sees, so nothing is
/// hidden and nothing is retried in a loop.
fn retry_through_reopen<T>(
    of: &OpenedFile,
    mut op: impl FnMut() -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    match op() {
        Ok(v) => Ok(v),
        Err(first) => {
            if !is_stale_handle(&first) {
                return Err(first);
            }
            warn!("the drive stopped answering; opening the file again and retrying");
            of.reopen_on_next_use();
            op().map_err(|_| first)
        }
    }
}

/// ERROR_INVALID_FUNCTION, which on a write means the volume would not do it
/// the way it was asked, not that the bytes or the file are wrong.
#[cfg(windows)]
fn is_invalid_function(error: &anyhow::Error) -> bool {
    error
        .chain()
        .filter_map(|e| e.downcast_ref::<std::io::Error>())
        .any(|io| io.raw_os_error() == Some(1))
}

/// ERROR_IO_DEVICE: the drive answered the write with a fault of its own.
///
/// External USB disks do this under a torrent's load — many small writes at
/// scattered offsets across a lot of open files is close to the worst case for
/// a bridge chip, and one of them stalling long enough to be reset surfaces
/// here. It is not the bytes, the file or the handle: the same write to the
/// same place succeeds a moment later, once the device has finished picking
/// itself up. So it is worth waiting out rather than failing a torrent that is
/// otherwise downloading perfectly well.
#[cfg(windows)]
fn is_device_io_error(error: &anyhow::Error) -> bool {
    error
        .chain()
        .filter_map(|e| e.downcast_ref::<std::io::Error>())
        .any(|io| io.raw_os_error() == Some(1117))
}

/// How long to keep trying a write the device faulted on, and how long to wait
/// between attempts. A USB disk that has been reset is back within a couple of
/// seconds or is not coming back at all, and the waiting happens on librqbit's
/// blocking write path, so the whole budget stays short enough that a genuinely
/// dead drive still reports itself as one promptly.
#[cfg(windows)]
const DEVICE_RETRY_BACKOFF: &[u64] = &[50, 200, 500, 1000, 2000];

/// Run a write, and sit out a device fault rather than failing on it.
#[cfg(windows)]
fn retry_through_device_fault<T>(mut op: impl FnMut() -> anyhow::Result<T>) -> anyhow::Result<T> {
    let mut last = match op() {
        Ok(v) => return Ok(v),
        Err(e) => e,
    };
    for wait_ms in DEVICE_RETRY_BACKOFF {
        if !is_device_io_error(&last) {
            return Err(last);
        }
        warn!(
            wait_ms,
            "the drive faulted on a write; waiting and trying it again"
        );
        std::thread::sleep(std::time::Duration::from_millis(*wait_ms));
        match op() {
            Ok(v) => return Ok(v),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// Whether an error says the handle is dead rather than the operation wrong.
#[cfg(windows)]
fn is_stale_handle(error: &anyhow::Error) -> bool {
    // ERROR_INVALID_HANDLE, ERROR_DEVICE_NOT_CONNECTED, ERROR_NOT_READY,
    // ERROR_FILE_INVALID (the volume was dismounted).
    //
    // ERROR_INVALID_FUNCTION is deliberately absent. It looked like a dead
    // handle and is not: reopening the file changes nothing, and the reopen
    // itself can take half a minute on the file it happens to. It is handled
    // where it belongs, as a write the volume would not do that way.
    const STALE: &[i32] = &[6, 1167, 21, 1006];
    error
        .chain()
        .filter_map(|e| e.downcast_ref::<std::io::Error>())
        .any(|io| io.raw_os_error().is_some_and(|c| STALE.contains(&c)))
}

#[cfg(not(windows))]
fn is_stale_handle(error: &anyhow::Error) -> bool {
    // EBADF, ENXIO, ENODEV.
    const STALE: &[i32] = &[9, 6, 19];
    error
        .chain()
        .filter_map(|e| e.downcast_ref::<std::io::Error>())
        .any(|io| io.raw_os_error().is_some_and(|c| STALE.contains(&c)))
}

impl TorrentStorage for FilesystemStorage {
    fn pread_exact(&self, file_id: usize, offset: u64, buf: &mut [u8]) -> anyhow::Result<()> {
        let of = self.opened_files.get(file_id).context("no such file")?;
        retry_through_reopen(of, || of.lock_read()?.pread_exact(offset, buf))
    }

    fn pwrite_all(&self, file_id: usize, offset: u64, buf: &[u8]) -> anyhow::Result<()> {
        let of = self.opened_files.get(file_id).context("no such file")?;
        describe_on_failure(of, file_id, offset, buf.len(), || {
            retry_through_reopen(of, || {
                #[cfg(windows)]
                {
                    match retry_through_device_fault(|| {
                        of.try_mark_sparse()?.pwrite_all(offset, buf)
                    }) {
                        Ok(()) => Ok(()),
                        // "Incorrect function" for a write that is inside the
                        // file, on a drive that is otherwise working, is the
                        // volume refusing the positional write rather than
                        // refusing the write. Seeking to the same place and
                        // writing there is worth one try before the torrent is
                        // given up on; it is slower and takes an exclusive
                        // lock, so it stays on the failure path only.
                        Err(e) if is_invalid_function(&e) => {
                            warn!(
                                file_id,
                                offset, "a positional write was refused; seeking to it instead"
                            );
                            retry_through_device_fault(|| of.pwrite_all_seeking(offset, buf))
                        }
                        Err(e) => Err(e),
                    }
                }
                #[cfg(not(windows))]
                return of.lock_read()?.pwrite_all(offset, buf);
            })
        })
    }

    fn pwrite_all_vectored(
        &self,
        file_id: usize,
        offset: u64,
        bufs: [IoSlice<'_>; 2],
    ) -> anyhow::Result<usize> {
        let of = self.opened_files.get(file_id).context("no such file")?;
        retry_through_reopen(of, || {
            #[cfg(windows)]
            return retry_through_device_fault(|| {
                of.try_mark_sparse()?.pwrite_all_vectored(offset, bufs)
            });
            #[cfg(not(windows))]
            return of.lock_read()?.pwrite_all_vectored(offset, bufs);
        })
    }

    fn remove_file(&self, _file_id: usize, filename: &Path) -> anyhow::Result<()> {
        Ok(std::fs::remove_file(self.output_folder.join(filename))?)
    }

    fn ensure_file_length(&self, file_id: usize, len: u64) -> anyhow::Result<()> {
        let f = &self.opened_files.get(file_id).context("no such file")?;
        #[cfg(windows)]
        f.try_mark_sparse()?;
        Ok(f.lock_read()?.set_len(len)?)
    }

    fn take(&self) -> anyhow::Result<Box<dyn TorrentStorage>> {
        Ok(Box::new(Self {
            opened_files: self
                .opened_files
                .iter()
                .map(|f| f.take_clone())
                .collect::<anyhow::Result<Vec<_>>>()?,
            output_folder: self.output_folder.clone(),
        }))
    }

    fn remove_directory_if_empty(&self, path: &Path) -> anyhow::Result<()> {
        let path = self.output_folder.join(path);
        if !path.is_dir() {
            anyhow::bail!("cannot remove dir: {path:?} is not a directory")
        }
        if std::fs::read_dir(&path)?.count() == 0 {
            std::fs::remove_dir(&path).with_context(|| format!("error removing {path:?}"))
        } else {
            warn!("did not remove {path:?} as it was not empty");
            Ok(())
        }
    }

    fn init(
        &mut self,
        shared: &ManagedTorrentShared,
        metadata: &TorrentMetadata,
    ) -> anyhow::Result<()> {
        let mut files = Vec::<OpenedFile>::new();
        for file_details in metadata.file_infos.iter() {
            let mut full_path = self.output_folder.clone();
            let relative_path = &file_details.relative_filename;
            full_path.push(relative_path);

            if file_details.attrs.padding {
                files.push(OpenedFile::new_dummy());
                continue;
            };
            // Overwriting is allowed, so there is nothing to check about what
            // is already on disk, and therefore no reason to open anything
            // yet. Each file opens itself the first time it is read or
            // written. Adding a torrent of several thousand files is then
            // immediate rather than minutes of opening handles nothing has
            // asked for - see `OpenedFile::new_lazy`.
            if shared.options.allow_overwrite {
                files.push(OpenedFile::new_lazy(full_path));
                continue;
            }
            std::fs::create_dir_all(full_path.parent().context("bug: no parent")?)?;
            let f = {
                // create_new does not seem to work with read(true), so calling this twice.
                OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&full_path)
                    .with_context(|| {
                        format!(
                            "error creating a new file (because allow_overwrite = false) {:?}",
                            full_path
                        )
                    })?;
                OpenOptions::new().read(true).write(true).open(&full_path)?
            };
            files.push(OpenedFile::new(full_path.clone(), f));
        }

        self.opened_files = files;
        Ok(())
    }
}
