use std::{
    fs::File,
    io::IoSlice,
    ops::{Deref, DerefMut},
    path::PathBuf,
};

use anyhow::Context;
use parking_lot::{RwLock, RwLockReadGuard, RwLockWriteGuard};

use crate::Error;

pub trait OurFileExt {
    fn pwrite_all_vectored(&self, offset: u64, bufs: [IoSlice<'_>; 2]) -> anyhow::Result<usize>;
    fn pread_exact(&self, offset: u64, buf: &mut [u8]) -> anyhow::Result<()>;
    fn pwrite_all(&self, offset: u64, buf: &[u8]) -> anyhow::Result<()>;
}

impl OurFileExt for File {
    #[cfg(unix)]
    fn pwrite_all_vectored(&self, offset: u64, bufs: [IoSlice<'_>; 2]) -> anyhow::Result<usize> {
        nix::sys::uio::pwritev(self, &bufs, offset.try_into()?).context("error calling pwritev")
    }

    #[cfg(not(unix))]
    fn pwrite_all_vectored(&self, offset: u64, bufs: [IoSlice<'_>; 2]) -> anyhow::Result<usize> {
        match (bufs[0].len(), bufs[1].len()) {
            (len, 0) if len > 0 => {
                self.pwrite_all(offset, &bufs[0])?;
                Ok(len)
            }
            (0, len) if len > 0 => {
                self.pwrite_all(offset, &bufs[1])?;
                Ok(len)
            }
            (0, 0) => Ok(0),
            (l0, l1) => {
                // concatenate the buffers in memory so that we issue one write call instead of 2
                // assumes the message is <= CHUNK_SIZE
                use librqbit_core::constants::CHUNK_SIZE;
                let mut buf = [0u8; CHUNK_SIZE as usize];

                buf.get_mut(..l0)
                    .context("buf too small")?
                    .copy_from_slice(&bufs[0]);
                buf.get_mut(l0..l0 + l1)
                    .context("buf too small")?
                    .copy_from_slice(&bufs[1]);
                self.pwrite_all(offset, &buf[..l0 + l1])?;
                Ok(l0 + l1)
            }
        }
    }

    #[cfg(unix)]
    fn pread_exact(&self, offset: u64, buf: &mut [u8]) -> anyhow::Result<()> {
        use std::os::unix::fs::FileExt;

        Ok(self.read_exact_at(buf, offset)?)
    }

    #[cfg(windows)]
    fn pread_exact(&self, mut offset: u64, mut buf: &mut [u8]) -> anyhow::Result<()> {
        use std::os::windows::fs::FileExt;
        while !buf.is_empty() {
            let n = self.seek_read(buf, offset)?;
            if n == 0 {
                return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "eof").into());
            }
            offset += n as u64;
            buf = &mut buf[n..];
        }
        Ok(())
    }

    #[cfg(not(any(windows, unix)))]
    fn pread_exact(&self, offset: u64, buf: &mut [u8]) -> anyhow::Result<()> {
        anyhow::bail!("pread_exact not implemented for your platform")
    }

    #[cfg(unix)]
    fn pwrite_all(&self, offset: u64, buf: &[u8]) -> anyhow::Result<()> {
        use std::os::unix::fs::FileExt;
        Ok(self.write_all_at(buf, offset)?)
    }

    #[cfg(windows)]
    fn pwrite_all(&self, offset: u64, buf: &[u8]) -> anyhow::Result<()> {
        use std::os::windows::fs::FileExt;

        let mut remaining = buf.len();
        let mut buf = buf;
        let mut offset = offset;
        while remaining > 0 {
            let written = self.seek_write(&buf[..remaining], offset)?;
            remaining -= written;
            offset += written as u64;
            buf = &buf[written..];
        }
        Ok(())
    }

    #[cfg(not(any(windows, unix)))]
    fn pwrite_all(&self, offset: u64, buf: &[u8]) -> anyhow::Result<()> {
        anyhow::bail!("pwrite_all not implemented for your platform")
    }
}

#[derive(Default, Debug)]
struct OpenedFileLocked {
    #[allow(unused)]
    path: PathBuf,
    fd: Option<File>,
    /// The file exists as far as the torrent is concerned, but has not been
    /// opened yet: it is opened the first time a piece of it is read or
    /// written. A padding placeholder has neither this nor a handle.
    unopened: bool,
    #[cfg(windows)]
    tried_marking_sparse: bool,
}

impl Deref for OpenedFileLocked {
    type Target = Option<File>;

    fn deref(&self) -> &Self::Target {
        &self.fd
    }
}

impl DerefMut for OpenedFileLocked {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.fd
    }
}

#[derive(Debug)]
pub(crate) struct OpenedFile {
    file: RwLock<OpenedFileLocked>,
}

impl OpenedFile {
    pub fn new(path: PathBuf, f: File) -> Self {
        Self {
            file: RwLock::new(OpenedFileLocked {
                path,
                fd: Some(f),
                unopened: false,
                #[cfg(windows)]
                tried_marking_sparse: false,
            }),
        }
    }

    /// A file that will be opened the first time it is used.
    ///
    /// Opening every file of a torrent up front is what adding one used to
    /// cost, and on a large torrent on a slow disk that is not a small cost:
    /// a torrent of 7,685 files on an external USB drive took a minute and a
    /// half of nothing but opening files, before a single byte was read. Most
    /// of those handles are never used at all - a torrent that is complete and
    /// seeding touches a file only when a peer asks for a piece of it.
    pub fn new_lazy(path: PathBuf) -> Self {
        Self {
            file: RwLock::new(OpenedFileLocked {
                path,
                fd: None,
                unopened: true,
                #[cfg(windows)]
                tried_marking_sparse: false,
            }),
        }
    }

    /// Opens the file if it has not been opened yet. Called on every read and
    /// write, so the already-open case takes a read lock and nothing else.
    fn ensure_open(&self) -> crate::Result<()> {
        if !self.file.read().unopened {
            return Ok(());
        }
        let mut g = self.file.write();
        if !g.unopened {
            return Ok(());
        }
        let path = g.path.clone();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| Error::FsOpen(parent.to_owned(), e))?;
        }
        let f = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|e| Error::FsOpen(path, e))?;
        g.fd = Some(f);
        g.unopened = false;
        Ok(())
    }

    /// Write at `offset` by moving the file pointer instead of passing the
    /// offset to the write call, under an exclusive lock.
    ///
    /// The ordinary path is a positional write: the offset goes to `WriteFile`
    /// in an OVERLAPPED and the file pointer is never touched, which is what
    /// makes it safe for several peers to write to one file at once. Some
    /// volumes refuse that on a sparse file with "Incorrect function" while
    /// accepting a plain seek and write of the very same bytes.
    ///
    /// Seeking moves state shared by every writer of this file, so this takes
    /// the write lock rather than the read lock the positional path uses. That
    /// is why it lives here and not on `File`: two concurrent seek-and-writes
    /// would land each other's bytes at the wrong offset, and the corruption
    /// would only show up as a failed hash check much later.
    #[cfg(windows)]
    pub fn pwrite_all_seeking(&self, offset: u64, buf: &[u8]) -> anyhow::Result<()> {
        use std::io::{Seek, SeekFrom, Write};
        self.ensure_open()?;
        let mut g = self.file.write();
        let f = g.fd.as_mut().ok_or(Error::FsFileIsNone)?;
        f.seek(SeekFrom::Start(offset))?;
        f.write_all(buf)?;
        Ok(())
    }

    /// What is known about this file right now, for an error message.
    ///
    /// A write that fails names a file id and nothing else, which is not
    /// enough to tell a fault in the drive from something particular to one
    /// file - and those call for opposite responses.
    pub fn describe(&self) -> String {
        let g = self.file.read();
        let path = g.path.clone();
        let opened = g.fd.is_some();
        match std::fs::metadata(&path) {
            Ok(m) => {
                use std::os::windows::fs::MetadataExt;
                format!(
                    "{path:?} (on disk: {} bytes, attributes {:#x}, opened: {opened})",
                    m.len(),
                    m.file_attributes()
                )
            }
            Err(e) => format!("{path:?} (cannot be stat'd: {e}, opened: {opened})"),
        }
    }

    /// Throw away the handle so the next read or write opens the file again.
    ///
    /// A removable drive that disappears leaves every handle on it pointing at
    /// nothing. Windows answers I/O on one of those with "Incorrect function"
    /// (`ERROR_INVALID_FUNCTION`) rather than with anything that sounds like a
    /// missing disk, and it answers that way forever: retrying the same handle
    /// cannot work, because the handle is what is broken. Reopening is the
    /// only thing that can, and it costs one `CreateFile` on a path that is
    /// already known.
    ///
    /// A file that was never opened is left alone - there is no stale handle
    /// to drop, and marking it unopened would resurrect a padding placeholder
    /// or a dummy as a real file.
    pub fn reopen_on_next_use(&self) {
        let mut g = self.file.write();
        if g.fd.is_none() {
            return;
        }
        g.fd = None;
        g.unopened = true;
        #[cfg(windows)]
        {
            g.tried_marking_sparse = false;
        }
    }

    pub fn new_dummy() -> Self {
        Self {
            file: RwLock::new(Default::default()),
        }
    }

    pub fn take_clone(&self) -> anyhow::Result<Self> {
        let f = std::mem::take(&mut *self.file.write());
        Ok(Self {
            file: RwLock::new(f),
        })
    }

    pub fn lock_read(&self) -> crate::Result<impl Deref<Target = File>> {
        self.ensure_open()?;
        RwLockReadGuard::try_map(self.file.read(), |f| f.as_ref())
            .ok()
            .ok_or(Error::FsFileIsNone)
    }

    #[allow(dead_code)]
    pub fn lock_write(&self) -> crate::Result<impl DerefMut<Target = File>> {
        self.ensure_open()?;
        RwLockWriteGuard::try_map(self.file.write(), |f| f.as_mut())
            .ok()
            .ok_or(Error::FsFileIsNone)
    }

    #[cfg(windows)]
    pub fn try_mark_sparse(&self) -> crate::Result<impl Deref<Target = File>> {
        self.ensure_open()?;
        {
            let g = self.file.read();
            if g.tried_marking_sparse {
                return RwLockReadGuard::try_map(g, |f| f.fd.as_ref())
                    .ok()
                    .ok_or(Error::FsFileIsNone);
            }
        }
        let mut g = self.file.write();
        if !g.tried_marking_sparse {
            g.tried_marking_sparse = true;
            let f = g.fd.as_ref().ok_or(Error::FsFileIsNone)?;
            // exFAT and FAT32 have no sparse files, and the ioctl that asks
            // for one answers "Incorrect function" there. That was logged at
            // debug and otherwise ignored, so a volume that cannot do sparse
            // files looked exactly like one that can - worth knowing when
            // writes to that same file then start failing.
            let marked = super::sparse::mark_file_sparse(f);
            if marked {
                tracing::debug!(path=?g.path, "marked sparse");
            } else {
                tracing::warn!(
                    path=?g.path,
                    "this file could not be marked sparse; the filesystem may not support it"
                );
            }
        }
        let g = parking_lot::RwLockWriteGuard::downgrade(g);
        Ok(RwLockReadGuard::try_map(g, |f| f.fd.as_ref()).ok().unwrap())
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use librqbit_core::constants::CHUNK_SIZE;
    use peer_binary_protocol::DoubleBufHelper;
    use tempfile::TempDir;

    use crate::storage::filesystem::opened_file::OurFileExt;

    #[test]
    fn test_pwrite_all_vectored() {
        let td = TempDir::with_prefix("test_pwrite_all_vectored").unwrap();
        let mut tmp_buf = [0u8; CHUNK_SIZE as usize];
        for bufsize in [10000usize, CHUNK_SIZE as usize] {
            let mut buf = vec![0u8; bufsize];
            rand::fill(&mut buf[..]);
            for split_point in [0, bufsize / 2, bufsize] {
                let path = td.path().join(format!("file_{bufsize}_{split_point}"));
                let file = std::fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&path)
                    .unwrap();
                let (first, second) = buf.split_at(split_point);
                let bufs = DoubleBufHelper::new(first, second).as_ioslices(bufsize);
                file.pwrite_all_vectored(0, bufs).unwrap();

                let mut file = std::fs::File::open(&path).unwrap();
                assert_eq!(file.metadata().unwrap().len(), bufsize as u64, "{path:?}");
                file.read_exact(&mut tmp_buf[..bufsize]).unwrap();
                assert_eq!(&tmp_buf[..bufsize], buf);
            }
        }
    }
}
