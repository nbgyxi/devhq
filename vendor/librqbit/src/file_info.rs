use std::path::{Path, PathBuf};

use librqbit_core::torrent_metainfo::FileDetailsAttrs;

/// Make a path from a torrent safe to create on this platform.
///
/// A torrent carries whatever names the person who made it used, and plenty of
/// them were made on Linux, where `?`, `:`, `"` and `|` are ordinary
/// characters. Windows rejects those outright: creating the file fails with
/// "the filename, directory name, or volume label syntax is incorrect"
/// (os error 123), which surfaces as an unrecoverable write error and stops
/// the torrent — one bad character in one file out of thousands.
///
/// So the offending characters are replaced rather than passed through. This
/// is what every other client on Windows does, and it is confined to the name
/// on disk: the torrent's own piece data is untouched, and the name the swarm
/// knows is unchanged.
///
/// Off Windows the name is passed through, because it is already legal there
/// and quietly rewriting it would make the same torrent land in two different
/// places depending on the machine.
#[cfg(windows)]
pub fn sanitize_for_platform(path: &Path) -> PathBuf {
    path.components()
        .map(|component| {
            let name = component.as_os_str().to_string_lossy();
            let mut cleaned: String = name
                .chars()
                .map(|c| match c {
                    // `/` and `\` are absent by construction - the path was
                    // built by splitting on the torrent's own separators.
                    '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
                    c if (c as u32) < 0x20 => '_',
                    c => c,
                })
                .collect();
            // Windows silently drops trailing dots and spaces, so a name
            // ending in one is not the name that ends up on disk - and a later
            // lookup by the original name then misses.
            let trimmed = cleaned.trim_end_matches(['.', ' ']);
            if trimmed.len() != cleaned.len() {
                cleaned = trimmed.to_owned();
            }
            // The DOS device names are still reserved, with or without an
            // extension, and opening one talks to the device instead.
            let stem = cleaned
                .split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase();
            let reserved = matches!(
                stem.as_str(),
                "CON" | "PRN" | "AUX" | "NUL" | "COM0" | "COM1" | "COM2" | "COM3" | "COM4"
                    | "COM5" | "COM6" | "COM7" | "COM8" | "COM9" | "LPT0" | "LPT1" | "LPT2"
                    | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
            );
            if reserved {
                cleaned.insert(0, '_');
            }
            if cleaned.is_empty() {
                cleaned.push('_');
            }
            cleaned
        })
        .collect()
}

#[cfg(not(windows))]
pub fn sanitize_for_platform(path: &Path) -> PathBuf {
    path.to_path_buf()
}

#[derive(Debug, Clone)]
pub struct FileInfo {
    pub relative_filename: PathBuf,
    pub offset_in_torrent: u64,
    pub piece_range: std::ops::Range<u32>,
    pub attrs: FileDetailsAttrs,
    pub len: u64,
}

// Iterate file pieces in the following order: first, last, everything else from start to end.
fn iter_piece_priorities(range: std::ops::Range<usize>) -> impl Iterator<Item = usize> {
    // First and last of each file first, then the rest of pieces in that file.
    let r = range;
    use std::iter::once;

    let first = once(r.start);
    let last = once(r.start + r.len().overflowing_sub(1).0); // it's ok if it repeats, doesn't matter
    let mid = r.clone().skip(1).take(r.len().overflowing_sub(2).0);

    // The take(r.len()) is to not yield start/end pieces in case of 0 and 1 lengths.
    first.chain(last).chain(mid).take(r.len())
}

impl FileInfo {
    pub fn piece_range_usize(&self) -> std::ops::Range<usize> {
        self.piece_range.start as usize..self.piece_range.end as usize
    }

    pub fn iter_piece_priorities(&self) -> impl Iterator<Item = usize> {
        iter_piece_priorities(self.piece_range_usize())
    }
}

#[cfg(test)]
mod tests {
    use super::iter_piece_priorities;

    #[test]
    fn test_iter_piece_priorities() {
        let it = |r: std::ops::Range<usize>| -> Vec<usize> { iter_piece_priorities(r).collect() };
        assert_eq!(it(0..0), Vec::<usize>::new());

        assert_eq!(it(0..1), vec![0]);
        assert_eq!(it(0..2), vec![0, 1]);
        assert_eq!(it(0..3), vec![0, 2, 1]);
        assert_eq!(it(0..4), vec![0, 3, 1, 2]);
    }
}
