//! Replays a captured pseudoconsole stream through the parser, and — this is
//! the point — rebuilds the screen a second time the way the front end does,
//! from the per-chunk `scrolled` + dirty-row deltas alone.
//!
//! If the two disagree, the delta protocol in `term.rs`/`terminal.js` is losing
//! something. If they agree but the screen is still wrong, the parser in
//! `vt.rs` is. That tells you which half to look at without opening the window.
//!
//! ```bash
//! # In the app: set DEVHQ_TERM_LOG to a directory, reproduce, then
//! cd src-tauri
//! cargo run --example term_replay -- C:\tmp\termlog\t1.bin
//! cargo run --example term_replay -- C:\tmp\termlog\t1.bin --chunk 4096
//! ```

use devhq_lib::vt::{Cell, Grid};

fn text(cells: &[Cell]) -> String {
    let mut s: String = cells.iter().map(|c| c.ch).collect();
    while s.ends_with(' ') {
        s.pop();
    }
    s
}

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(path) = args.next() else {
        eprintln!("usage: term_replay <capture.bin> [--chunk N]");
        std::process::exit(2);
    };
    let mut chunk = 0usize;
    while let Some(arg) = args.next() {
        if arg == "--chunk" {
            chunk = args.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        }
    }

    // A directory means "whichever capture is newest", which is almost always
    // the one just recorded — and saves picking through runs by hand.
    let path = match std::fs::metadata(&path) {
        Ok(m) if m.is_dir() => {
            let newest = std::fs::read_dir(&path)
                .ok()
                .into_iter()
                .flatten()
                .flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "bin"))
                .filter(|e| e.metadata().map(|m| m.len() > 0).unwrap_or(false))
                .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
            match newest {
                Some(entry) => {
                    let picked = entry.path().display().to_string();
                    println!("[newest capture in {path}: {picked}]");
                    picked
                }
                None => {
                    eprintln!("no non-empty .bin captures in {path}");
                    std::process::exit(1);
                }
            }
        }
        _ => path,
    };

    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("cannot read {path}: {e}");
            std::process::exit(1);
        }
    };

    // The sidecar the capture wrote: the size the session opened at, then one
    // `resize <byte offset> <cols> <rows>` line per resize. A replay that
    // ignores those runs the whole session at the opening size, and every line
    // the shell drew for a wider screen wraps — which looks exactly like the
    // bug being hunted, so the sidecar is not optional.
    let meta = std::path::Path::new(&path).with_extension("meta");
    let meta = std::fs::read_to_string(&meta).unwrap_or_default();
    let mut lines = meta.trim_start_matches('\u{feff}').lines();
    let (cols, rows) = lines
        .next()
        .and_then(|l| {
            let mut it = l.split_whitespace();
            Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
        })
        .unwrap_or((80usize, 24usize));
    let mut resizes: Vec<(usize, usize, usize)> = lines
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            if it.next()? != "resize" {
                return None;
            }
            Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?, it.next()?.parse().ok()?))
        })
        .collect();
    resizes.reverse();

    let mut grid = Grid::new(cols, rows);
    // The front end's model: history above, a fixed-height screen below.
    let mut history: Vec<String> = Vec::new();
    let mut shadow: Vec<String> = vec![String::new(); rows];

    // Feeding stops at every resize boundary so the bytes before it are parsed
    // at the old size and the bytes after it at the new one. Resizes due at the
    // current offset are applied *before* the next byte is fed — a resize at
    // byte 0 (the usual case, since the view fits itself the moment it mounts)
    // otherwise lands after the whole stream has been parsed at the wrong size.
    let step = if chunk == 0 { bytes.len().max(1) } else { chunk };
    let mut at = 0usize;
    loop {
        while let Some(&(off, c, r)) = resizes.last() {
            if off > at {
                break;
            }
            resizes.pop();
            println!("[resize to {c}x{r} at byte {off}]");
            grid.resize(c, r);
            // What the front end does: a blank screen of the new height, then
            // `attachRepaint` fills every row from a fresh snapshot. Modelling
            // that as a blank shadow instead would report every row that the
            // stream never touches again as drift.
            shadow = (0..grid.rows).map(|y| text(grid.row(y))).collect();
            let _ = grid.take_dirty();
        }
        if at >= bytes.len() {
            break;
        }
        let stop = resizes
            .last()
            .map(|&(off, _, _)| off.clamp(at, bytes.len()))
            .filter(|&off| off > at)
            .unwrap_or(bytes.len());
        for part in bytes[at..stop].chunks(step) {
            grid.feed(part);
            for line in grid.take_scrolled() {
                history.push(text(&line));
            }
            for y in grid.take_dirty() {
                shadow[y] = text(grid.row(y));
            }
        }
        at = stop;
    }
    let (cols, rows) = (grid.cols, grid.rows);

    println!("{} bytes, {cols}x{rows}, cursor at row {} col {}", bytes.len(), grid.cy, grid.cx);
    println!("--- screen (parser) ---");
    for y in 0..rows {
        let mark = if y == grid.cy { '>' } else { ' ' };
        println!("{mark}{y:>3} |{}|", text(grid.row(y)));
    }

    let mut drift = 0;
    for y in 0..rows {
        if shadow[y] != text(grid.row(y)) {
            if drift == 0 {
                println!("--- rows the delta stream never repainted ---");
            }
            drift += 1;
            println!("{y:>4} delta |{}|", shadow[y]);
            println!("     grid  |{}|", text(grid.row(y)));
        }
    }
    if drift == 0 {
        println!("--- delta stream matches the parser on every row ---");
    }

    println!("--- last 10 lines of history ({} total) ---", history.len());
    for line in history.iter().rev().take(10).rev() {
        println!("     |{line}|");
    }
}
