//! What a terminal snapshot actually holds when the shell is sitting at an
//! empty prompt — the input to the history DevHQ restores on the next launch.
//!
//! ```bash
//! cd src-tauri
//! cargo run --example term_snapshot
//! ```
//!
//! Every line is printed quoted, so trailing spaces and blank-but-styled rows
//! are visible instead of looking like the empty lines they are not.

#[cfg(windows)]
fn main() {
    use devhq_lib::conpty::{self, ConPty};
    use devhq_lib::vt::{Cell, Grid, DEFAULT_COLOR};
    use std::sync::{Arc, Mutex};

    let dir = std::env::args().nth(1).unwrap_or_else(|| ".".to_string());
    let (cols, rows) = (100usize, 20usize);
    let pty = ConPty::spawn(
        "powershell.exe -NoLogo",
        std::path::Path::new(&dir),
        cols as u16,
        rows as u16,
    )
    .expect("spawn failed");

    let grid = Arc::new(Mutex::new(Grid::new(cols, rows)));
    let reader_grid = grid.clone();
    let output = pty.output();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        while let Some(n) = conpty::read_chunk(output, &mut buf) {
            reader_grid.lock().unwrap().feed(&buf[..n]);
        }
    });

    std::thread::sleep(std::time::Duration::from_millis(1500));
    pty.write(b"echo hello\r").expect("write failed");
    std::thread::sleep(std::time::Duration::from_millis(1200));
    // Enter on an empty prompt: the terminal is now standing on an empty line.
    pty.write(b"\r").expect("write failed");
    std::thread::sleep(std::time::Duration::from_millis(1200));

    // Exactly what `pack` in term.rs keeps: trailing default-background blanks
    // are dropped, anything else stays.
    let pack_text = |cells: &[Cell]| -> String {
        let end = cells
            .iter()
            .rposition(|c| c.ch != ' ' || c.bg != DEFAULT_COLOR || c.attr != 0)
            .map(|i| i + 1)
            .unwrap_or(0);
        cells[..end].iter().map(|c| c.ch).collect()
    };

    let grid = grid.lock().unwrap();
    let mut lines: Vec<String> = grid.scrollback.iter().map(|row| pack_text(row)).collect();
    let history = lines.len();
    lines.extend((0..grid.rows).map(|y| pack_text(grid.row(y))));
    println!(
        "cursor {},{}  history {}  screen {}",
        grid.cx, grid.cy, history, grid.rows
    );
    for (i, line) in lines.iter().enumerate() {
        let tag = if i < history { "hist" } else { "scrn" };
        println!("{i:>3} {tag} {line:?}");
    }
    // The trim snapshotText does before the text is written to prefs.
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    println!("--- restored text ends with: {:?}", lines.last());
}

#[cfg(not(windows))]
fn main() {
    eprintln!("The terminal stack is Windows-only.");
}
