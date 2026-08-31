//! Headless check of the terminal stack: spawn a shell on a real pseudoconsole,
//! type into it, and print the screen the parser produced.
//!
//! ```bash
//! cd src-tauri
//! cargo run --example term_cli
//! cargo run --example term_cli -- "C:\code" "git status --short"
//! ```

#[cfg(windows)]
fn main() {
    use devhq_lib::conpty::{self, ConPty};
    use devhq_lib::vt::{Grid, DEFAULT_COLOR};
    use std::sync::{Arc, Mutex};

    let mut args = std::env::args().skip(1);
    let dir = args.next().unwrap_or_else(|| ".".to_string());
    let typed = args
        .next()
        .unwrap_or_else(|| "echo conpty-works".to_string());

    let (cols, rows) = (100usize, 30usize);
    let pty = match ConPty::spawn(
        "powershell.exe -NoLogo",
        std::path::Path::new(&dir),
        cols as u16,
        rows as u16,
    ) {
        Ok(pty) => pty,
        Err(e) => {
            eprintln!("spawn failed: {e}");
            std::process::exit(1);
        }
    };
    println!("shell pid {} in {dir}", pty.pid());

    let grid = Arc::new(Mutex::new(Grid::new(cols, rows)));
    let reader_grid = grid.clone();
    let output = pty.output();
    let debug = std::env::var("TERM_DEBUG").is_ok();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut total = 0usize;
        loop {
            match conpty::read_chunk(output, &mut buf) {
                Some(n) => {
                    total += n;
                    if debug {
                        eprintln!(
                            "[read {n} (total {total})] {:?}",
                            String::from_utf8_lossy(&buf[..n.min(200)])
                        );
                    }
                    reader_grid.lock().unwrap().feed(&buf[..n]);
                }
                None => {
                    if debug {
                        eprintln!(
                            "[reader stopped after {total} bytes; last os error {:?}]",
                            std::io::Error::last_os_error()
                        );
                    }
                    break;
                }
            }
        }
    });

    // Let the prompt settle, type, then let the command finish.
    std::thread::sleep(std::time::Duration::from_millis(1200));
    pty.write(format!("{typed}\r").as_bytes())
        .expect("write failed");
    std::thread::sleep(std::time::Duration::from_millis(1800));

    let grid = grid.lock().unwrap();
    println!(
        "--- screen {}x{} cursor {},{} ---",
        grid.cols, grid.rows, grid.cx, grid.cy
    );
    let mut coloured = 0;
    for y in 0..grid.rows {
        let line: String = grid.row(y).iter().map(|c| c.ch).collect();
        coloured += grid.row(y).iter().filter(|c| c.fg != DEFAULT_COLOR).count();
        let line = line.trim_end();
        if !line.is_empty() {
            println!("{y:>2} | {line}");
        }
    }
    println!(
        "--- {} coloured cells, {} scrollback lines ---",
        coloured,
        grid.scrollback.len()
    );
}

#[cfg(not(windows))]
fn main() {
    eprintln!("The terminal stack is Windows-only.");
}
