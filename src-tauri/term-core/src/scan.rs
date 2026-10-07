//! The lines of terminal output the rest of the app acts on: a dev server
//! saying where it is serving, and a program saying the port it wanted was taken.

use crate::vt::{Cell, CONT};

/// The printable text of one screen row, with the marker that holds the second
/// half of a double-width glyph dropped.
pub(crate) fn row_text(cells: &[Cell]) -> String {
    cells
        .iter()
        .map(|cell| cell.ch)
        .filter(|&ch| ch != CONT)
        .collect()
}

/// The first loopback address with a port in a line of terminal text, which is
/// how every dev server worth pointing a browser at says it has started. Both
/// schemes, and every spelling of "this machine" a dev server prints -
/// `localhost`, `127.0.0.1`, `[::1]`, and the `0.0.0.0` a server that binds
/// every interface reports, that last one rewritten to `localhost` because it
/// is an address to listen on rather than one to browse to.
///
/// This reads the *screen*, not the byte stream. ConPTY does not forward what
/// the program wrote - it repaints, and it is free to break a line into
/// separate writes with cursor moves and colour changes in between, which is
/// exactly what a dev server's boxed, coloured, right-aligned banner provokes.
/// The row is where the address is reliably one contiguous run of characters,
/// and it is the same place the terminal itself finds links to underline.
///
/// Deliberately narrow. Matching any URL would have the browser panel chasing
/// documentation links and npm advisories printed during a build; matching
/// loopback with a port is the one case where the terminal is saying "there is
/// something to look at here, now".
/// Every prefix a dev server uses to say "on this machine", paired with what a
/// browser should be pointed at for it. The earliest match in the line wins,
/// whichever entry found it.
const HOSTS: [(&str, &str); 8] = [
    ("http://localhost:", "http://localhost:"),
    ("https://localhost:", "https://localhost:"),
    ("http://127.0.0.1:", "http://127.0.0.1:"),
    ("https://127.0.0.1:", "https://127.0.0.1:"),
    ("http://[::1]:", "http://[::1]:"),
    ("https://[::1]:", "https://[::1]:"),
    ("http://0.0.0.0:", "http://localhost:"),
    ("https://0.0.0.0:", "https://localhost:"),
];

pub(crate) fn scan_local_url(text: &str) -> Option<String> {
    // The earliest address in the chunk wins. A dev server that prints both a
    // local and a network address prints the local one first, which is the one
    // a browser on this machine should be pointed at.
    let mut best: Option<(usize, String)> = None;
    for (host, browse) in HOSTS {
        let mut from = 0;
        // Every index here is derived from an ASCII match, but the byte after
        // one is not necessarily a character boundary and can be past the end
        // of the string - and either would panic this thread, taking the
        // terminal's output with it.
        while from < text.len() {
            let Some(at) = text[from..].find(host) else {
                break;
            };
            let start = from + at;
            let rest = &text[start + host.len()..];
            let port: String = rest.chars().take_while(char::is_ascii_digit).collect();
            from = (start + host.len() + port.len().max(1)).min(text.len());
            while from < text.len() && !text.is_char_boundary(from) {
                from += 1;
            }
            if port.is_empty() || port.len() > 5 {
                continue;
            }
            // Whatever follows the port up to whitespace is the path. A dev
            // server that prints a trailing slash means it, and one that prints
            // `/admin` means that.
            let tail: String = rest[port.len()..]
                .chars()
                .take_while(|c| !c.is_whitespace() && !matches!(c, '"' | '\'' | '\u{1b}' | ','))
                .collect();
            let found = format!("{browse}{port}{tail}");
            if best.as_ref().is_none_or(|(seen, _)| start < *seen) {
                best = Some((start, found));
            }
        }
    }
    best.map(|(_, url)| url)
}

/// The first port number after `needle` in an already-lowercased line, where
/// the needle starts a word. Anything that is not a port - a build's file
/// count, a version, a number too long to be a port - parses to nothing rather
/// than to a wrong answer.
fn port_after(lower: &str, needle: &str) -> Option<u16> {
    let mut from = 0;
    while from < lower.len() {
        let at = from + lower[from..].find(needle)?;
        let before = lower[..at].chars().next_back();
        from = (at + needle.len()).min(lower.len());
        while from < lower.len() && !lower.is_char_boundary(from) {
            from += 1;
        }
        if before.is_some_and(|c| c.is_alphanumeric()) {
            continue;
        }
        let digits: String = lower[from..]
            .trim_start()
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if let Some(port) = digits.parse::<u16>().ok().filter(|&port| port > 0) {
            return Some(port);
        }
    }
    None
}

/// A program saying the port it asked for was taken, as the port it wanted and
/// the port it settled for. Read off the screen row for the same reason
/// `scan_local_url` is: the pseudoconsole repaints, and the row is the only
/// place the sentence is one contiguous run of characters.
///
/// Deliberately narrow, and only the shapes a dev server actually prints:
/// Vite's "Port 5173 is in use", Next's "Port 3000 is in use, trying 3001
/// instead", the Firebase/Angular style "Unable to find an available port
/// (tried 41823 ...). Using alternative port 3000.", and a bare
/// `EADDRINUSE` from Node. Everything else is left alone - a false positive
/// here offers to kill somebody's process.
pub(crate) fn scan_port_conflict(text: &str) -> Option<(u16, Option<u16>)> {
    let lower = text.to_ascii_lowercase();
    let in_use = lower.contains("in use") || lower.contains("eaddrinuse");
    if !in_use && !lower.contains("available port") {
        return None;
    }
    let wanted = port_after(&lower, "available port (tried ")
        .or_else(|| port_after(&lower, "port "))
        // Node says it in an address rather than a sentence:
        // `listen EADDRINUSE: address already in use :::3000`.
        .or_else(|| {
            lower.rsplit(':').next().and_then(|tail| {
                let digits: String = tail
                    .trim()
                    .chars()
                    .take_while(char::is_ascii_digit)
                    .collect();
                digits.parse::<u16>().ok().filter(|&port| port > 0)
            })
        })?;
    let fallback = port_after(&lower, "alternative port ")
        .or_else(|| port_after(&lower, "trying "))
        .or_else(|| port_after(&lower, "using port "))
        .filter(|&port| port != wanted);
    Some((wanted, fallback))
}

#[cfg(test)]
mod tests {
    use super::{row_text, scan_local_url, scan_port_conflict};
    use crate::vt::Grid;

    /// The address as the screen holds it, which is the only place it is
    /// reliably one piece: this is a dev server's banner as it arrives -
    /// coloured, underlined, and with the line split by the pseudoconsole
    /// between the label and the address.
    fn screen_line(stream: &[u8]) -> String {
        let mut grid = Grid::new(80, 4);
        grid.feed(stream);
        (0..grid.rows)
            .map(|y| row_text(grid.row(y)))
            .find(|line| line.contains("http"))
            .unwrap_or_default()
    }

    #[test]
    fn finds_the_port_a_server_could_not_have() {
        assert_eq!(
            scan_port_conflict(
                "Unable to find an available port (tried 41823 on host \"localhost\"). Using alternative port 3000."
            ),
            Some((41823, Some(3000)))
        );
        assert_eq!(
            scan_port_conflict("  ⚠ Port 3000 is in use, trying 3001 instead."),
            Some((3000, Some(3001)))
        );
        assert_eq!(
            scan_port_conflict("Port 5173 is in use, trying another one..."),
            Some((5173, None))
        );
        assert_eq!(
            scan_port_conflict("Error: listen EADDRINUSE: address already in use :::3000"),
            Some((3000, None))
        );
    }

    /// A false positive here offers to kill somebody's process, so ordinary
    /// output that happens to mention a port says nothing.
    #[test]
    fn leaves_ordinary_output_alone() {
        assert_eq!(
            scan_port_conflict("  Local:   http://localhost:5173/"),
            None
        );
        assert_eq!(scan_port_conflict("export const port = 3000;"), None);
        assert_eq!(scan_port_conflict("Listening on port 8080"), None);
    }

    #[test]
    fn finds_the_address_a_dev_server_prints() {
        let line = screen_line(
            b"  \x1b[32m-\x1b[0m \x1b[1mLocal\x1b[0m:    \x1b[36m\x1b[4mhttp://localhost:41823/\x1b[0m\r\n",
        );
        assert_eq!(
            scan_local_url(&line).as_deref(),
            Some("http://localhost:41823/")
        );
    }

    /// The case the byte stream could not handle: the pseudoconsole repaints a
    /// line in pieces, moving the cursor between them. On the screen it is one
    /// line either way.
    #[test]
    fn finds_one_the_pseudoconsole_painted_in_pieces() {
        let line = screen_line(b"  - Local:\r\n\x1b[1A\x1b[13Ghttp://localhost:5173/\r\n");
        assert_eq!(
            scan_local_url(&line).as_deref(),
            Some("http://localhost:5173/")
        );
    }

    #[test]
    fn finds_loopback_by_number_too() {
        assert_eq!(
            scan_local_url("  Listening on http://127.0.0.1:8080/admin now").as_deref(),
            Some("http://127.0.0.1:8080/admin")
        );
    }

    /// A row is space-padded to the full width, so the address must not eat the
    /// padding after it.
    #[test]
    fn stops_at_the_padding_a_row_carries() {
        let line = screen_line(b"http://localhost:3000/\r\n");
        assert_eq!(line.len(), 80);
        assert_eq!(
            scan_local_url(&line).as_deref(),
            Some("http://localhost:3000/")
        );
    }

    /// The other spellings of this machine. A server that binds every
    /// interface prints the address it listens on, which is not one a browser
    /// can be pointed at.
    #[test]
    fn finds_the_other_ways_a_server_says_this_machine() {
        assert_eq!(
            scan_local_url("Now listening on: https://localhost:7186").as_deref(),
            Some("https://localhost:7186")
        );
        assert_eq!(
            scan_local_url("Serving HTTP on http://0.0.0.0:8000/ ...").as_deref(),
            Some("http://localhost:8000/")
        );
        assert_eq!(
            scan_local_url("  Network: http://[::1]:4200/").as_deref(),
            Some("http://[::1]:4200/")
        );
    }

    #[test]
    fn ignores_what_is_not_a_local_server() {
        assert_eq!(scan_local_url("see http://localhost/docs"), None);
        assert_eq!(scan_local_url("read https://docs.example.com/x"), None);
        assert_eq!(scan_local_url("open http://localhost:"), None);
    }

    /// The row is arbitrary text, so the scan must not assume where a character
    /// begins or that anything follows the port.
    #[test]
    fn survives_odd_bytes_after_the_port() {
        assert_eq!(scan_local_url("http://localhost:\u{2713}"), None);
        assert_eq!(
            scan_local_url("http://localhost:8080/\u{2713}").as_deref(),
            Some("http://localhost:8080/\u{2713}")
        );
    }
}
