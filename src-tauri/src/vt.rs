//! A VT/ANSI screen. Bytes from a pseudoconsole go in, a grid of cells comes
//! out, and the front end never sees an escape sequence.
//!
//! The sequence set here is deliberately narrow, and it can be: ConPTY is not a
//! Unix pty. It keeps its own screen buffer, normalises whatever the child
//! program emits and sends us a well-behaved diff, so the long tail of legacy
//! terminal quirks never reaches this parser.

use std::collections::VecDeque;

/// Sentinel for "the terminal's default colour", distinct from any palette
/// index or RGB value.
pub const DEFAULT_COLOR: u32 = 0xFFFF_FFFF;
/// Tag bit marking the low 24 bits as literal RGB rather than a palette index.
pub const RGB_FLAG: u32 = 0x0100_0000;

pub const ATTR_BOLD: u8 = 1;
pub const ATTR_DIM: u8 = 2;
pub const ATTR_ITALIC: u8 = 4;
pub const ATTR_UNDERLINE: u8 = 8;
pub const ATTR_REVERSE: u8 = 16;
pub const ATTR_STRIKE: u8 = 32;

/// Marks the second column of a double-width glyph. The glyph itself lives in
/// the cell before it; this one exists only so every column of the row still
/// has a cell, and it is never drawn.
pub const CONT: char = '\0';

/// How many columns a character occupies on the screen.
///
/// This is the terminal's own arithmetic, not the font's: a program pads its
/// table to a column count, and the only way its columns land where it meant
/// them to is for us to count a CJK ideograph or an emoji as the two columns
/// ConPTY charged it for. The ranges are East Asian Wide and Fullwidth plus
/// the emoji that render double-width, and the marks that take no column at
/// all - combining accents, variation selectors and the zero-width joiners.
pub fn char_width(c: char) -> usize {
    let u = c as u32;
    if u < 0x7F {
        // The common case, and the whole of it: printable ASCII is one column,
        // and no control character reaches here.
        return 1;
    }
    match u {
        // Marks and joiners that hang off the character before them.
        0x0300..=0x036F
        | 0x0483..=0x0489
        | 0x0591..=0x05BD
        | 0x0610..=0x061A
        | 0x064B..=0x065F
        | 0x0670
        | 0x06D6..=0x06DC
        | 0x0730..=0x074A
        | 0x07A6..=0x07B0
        | 0x0816..=0x0819
        | 0x081B..=0x0823
        | 0x0951..=0x0954
        | 0x1AB0..=0x1AFF
        | 0x1DC0..=0x1DFF
        | 0x200B..=0x200F
        | 0x2060..=0x2064
        | 0x20D0..=0x20F0
        | 0xFE00..=0xFE0F
        | 0xFE20..=0xFE2F
        | 0xFEFF
        | 0xE0100..=0xE01EF => 0,

        // East Asian Wide and Fullwidth.
        0x1100..=0x115F
        | 0x2E80..=0x303E
        | 0x3041..=0x33FF
        | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xA000..=0xA4CF
        | 0xA960..=0xA97F
        | 0xAC00..=0xD7A3
        | 0xF900..=0xFAFF
        | 0xFE10..=0xFE19
        | 0xFE30..=0xFE6F
        | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6
        | 0x16FE0..=0x16FFF
        | 0x17000..=0x18AFF
        | 0x1B000..=0x1B2FF
        | 0x20000..=0x3FFFD => 2,

        // Emoji that a terminal gives two columns to. The scattered singles in
        // the symbol blocks are the ones the emoji-presentation tables list;
        // everything else down there is a one-column symbol.
        0x231A..=0x231B
        | 0x23E9..=0x23EC
        | 0x23F0
        | 0x23F3
        | 0x25FD..=0x25FE
        | 0x2614..=0x2615
        | 0x2648..=0x2653
        | 0x267F
        | 0x2693
        | 0x26A1
        | 0x26AA..=0x26AB
        | 0x26BD..=0x26BE
        | 0x26C4..=0x26C5
        | 0x26CE
        | 0x26D4
        | 0x26EA
        | 0x26F2..=0x26F3
        | 0x26F5
        | 0x26FA
        | 0x26FD
        | 0x2705
        | 0x270A..=0x270B
        | 0x2728
        | 0x274C
        | 0x274E
        | 0x2753..=0x2755
        | 0x2757
        | 0x2795..=0x2797
        | 0x27B0
        | 0x27BF
        | 0x2B1B..=0x2B1C
        | 0x2B50
        | 0x2B55
        | 0x1F004
        | 0x1F0CF
        | 0x1F18E
        | 0x1F191..=0x1F19A
        | 0x1F200..=0x1F320
        | 0x1F32D..=0x1F335
        | 0x1F337..=0x1F37C
        | 0x1F37E..=0x1F393
        | 0x1F3A0..=0x1F3CA
        | 0x1F3CF..=0x1F3D3
        | 0x1F3E0..=0x1F3F0
        | 0x1F3F4
        | 0x1F3F8..=0x1F43E
        | 0x1F440
        | 0x1F442..=0x1F4FC
        | 0x1F4FF..=0x1F53D
        | 0x1F54B..=0x1F54E
        | 0x1F550..=0x1F567
        | 0x1F57A
        | 0x1F595..=0x1F596
        | 0x1F5A4
        | 0x1F5FB..=0x1F64F
        | 0x1F680..=0x1F6C5
        | 0x1F6CC
        | 0x1F6D0..=0x1F6D2
        | 0x1F6EB..=0x1F6EC
        | 0x1F6F4..=0x1F6FC
        | 0x1F7E0..=0x1F7EB
        | 0x1F90C..=0x1F9FF
        | 0x1FA70..=0x1FAFF => 2,

        _ => 1,
    }
}

/// How many lines that have scrolled off the top we keep.
const SCROLLBACK_MAX: usize = 5000;

#[derive(Clone, Copy, PartialEq)]
pub struct Cell {
    pub ch: char,
    pub fg: u32,
    pub bg: u32,
    pub attr: u8,
}

#[cfg(test)]
mod tests {
    use super::{char_width, Grid, CONT};

    #[test]
    fn a_wide_glyph_takes_two_columns() {
        let mut grid = Grid::new(10, 3);
        grid.feed("a你b".as_bytes());
        assert_eq!(grid.row(0)[0].ch, 'a');
        assert_eq!(grid.row(0)[1].ch, '你');
        assert_eq!(grid.row(0)[2].ch, CONT);
        assert_eq!(grid.row(0)[3].ch, 'b');
        assert_eq!(grid.cx, 4);
    }

    #[test]
    fn overwriting_half_a_wide_glyph_clears_the_other_half() {
        let mut grid = Grid::new(10, 3);
        grid.feed("你好".as_bytes());
        // Land on the second column of the first glyph.
        grid.feed(b"[1;2Hx");
        assert_eq!(grid.row(0)[0].ch, ' ');
        assert_eq!(grid.row(0)[1].ch, 'x');
        // The glyph after it is untouched.
        assert_eq!(grid.row(0)[2].ch, '好');
        assert_eq!(grid.row(0)[3].ch, CONT);
    }

    #[test]
    fn a_wide_glyph_wraps_whole_rather_than_straddling_the_edge() {
        let mut grid = Grid::new(4, 3);
        grid.feed("abc你".as_bytes());
        assert_eq!(grid.row(0)[3].ch, ' ');
        assert_eq!(grid.row(1)[0].ch, '你');
        assert_eq!(grid.row(1)[1].ch, CONT);
    }

    #[test]
    fn a_combining_mark_does_not_eat_the_letter_it_belongs_to() {
        let mut grid = Grid::new(10, 3);
        grid.feed("éf".as_bytes());
        assert_eq!(grid.row(0)[0].ch, 'e');
        assert_eq!(grid.row(0)[1].ch, 'f');
        assert_eq!(grid.cx, 2);
    }

    #[test]
    fn box_drawing_is_one_column() {
        for c in ['─', '│', '┌', '┼', '█'] {
            assert_eq!(char_width(c), 1, "{c:?}");
        }
    }

    #[test]
    fn alternate_screen_cursor_is_not_overwritten_by_tui_cursor_saves() {
        let mut grid = Grid::new(40, 12);
        grid.feed(b"prompt\x1b[4;8H");
        assert_eq!((grid.cx, grid.cy), (7, 3));

        grid.feed(b"\x1b[?1049h\x1b[9;20H\x1b7\x1b[2;2H\x1b8\x1b[?1049l");

        assert_eq!((grid.cx, grid.cy), (7, 3));
        assert!(!grid.alt);
    }

    // Filling the last column parks the cursor there instead of wrapping; the
    // wrap only happens if another character actually arrives. Anything that
    // moves the cursor in between must cancel that parked wrap, or the next
    // character opens a line the program never asked for — which is how an
    // inline TUI's redraw ends up one line off from the shell that hosts it.
    #[test]
    fn cursor_up_cancels_a_pending_wrap() {
        let mut grid = Grid::new(8, 6);
        grid.feed(b"\x1b[3;1Habcdefgh");
        assert_eq!((grid.cx, grid.cy), (7, 2));

        grid.feed(b"\x1b[Ax");
        assert_eq!(grid.row(1)[7].ch, 'x');
        assert_eq!(grid.cy, 1);
    }

    #[test]
    fn vertical_position_cancels_a_pending_wrap() {
        let mut grid = Grid::new(8, 6);
        grid.feed(b"abcdefgh\x1b[4dx");
        assert_eq!(grid.row(3)[7].ch, 'x');
        assert_eq!(grid.cy, 3);
    }

    #[test]
    fn restored_cursor_cancels_a_pending_wrap() {
        let mut grid = Grid::new(8, 6);
        grid.feed(b"\x1b[5;3H\x1b7\x1b[1;1Habcdefgh\x1b8x");
        assert_eq!(grid.row(4)[2].ch, 'x');
        assert_eq!(grid.cy, 4);
    }

    #[test]
    fn kitty_keyboard_flag_stack_is_not_a_cursor_restore() {
        // `CSI > 1 u` / `CSI < u` push and pop keyboard flags. Only the
        // unprefixed `CSI u` restores the cursor.
        let mut grid = Grid::new(40, 12);
        grid.feed(b"\x1b[1;1H\x1b[s\x1b[8;3Hdrawing");
        assert_eq!(grid.cy, 7);

        grid.feed(b"\x1b[>1u\x1b[<u\x1b[<u");
        assert_eq!(grid.cy, 7, "flag push/pop moved the cursor");

        grid.feed(b"\x1b[u");
        assert_eq!((grid.cx, grid.cy), (0, 0), "a bare CSI u still restores");
    }

    #[test]
    fn csi_3j_clears_scrollback() {
        let mut grid = Grid::new(20, 4);
        grid.feed(b"one\n\rtwo\n\rthree\n\rfour\n\rfive");
        assert!(!grid.scrollback.is_empty(), "lines have scrolled off");
        grid.feed(b"\x1b[3J");
        assert!(grid.scrollback.is_empty());
        assert!(grid.take_clear_history());
        assert!(!grid.take_clear_history(), "the flag is one-shot");
    }

    #[test]
    fn erasing_the_line_cancels_a_pending_wrap() {
        let mut grid = Grid::new(8, 6);
        grid.feed(b"abcdefgh\x1b[K\x1b[1;1Hz");
        assert_eq!(grid.row(0)[0].ch, 'z');
        assert_eq!(grid.cy, 0);
    }
}

impl Cell {
    fn blank(pen: &Cell) -> Cell {
        // Erasing paints with the current background, which is why a program
        // that sets a background and clears the line gets a coloured bar.
        Cell {
            ch: ' ',
            fg: DEFAULT_COLOR,
            bg: pen.bg,
            attr: 0,
        }
    }
}

impl Default for Cell {
    fn default() -> Self {
        Cell {
            ch: ' ',
            fg: DEFAULT_COLOR,
            bg: DEFAULT_COLOR,
            attr: 0,
        }
    }
}

#[derive(PartialEq)]
enum State {
    Ground,
    Esc,
    /// Collecting parameters of a `CSI` sequence.
    Csi,
    /// Inside an `OSC` string, waiting for BEL or ST.
    Osc,
    /// A sequence whose next byte is a charset designator we ignore.
    Charset,
}

pub struct Grid {
    pub cols: usize,
    pub rows: usize,
    cells: Vec<Cell>,
    /// The primary screen, parked here while the alternate screen is active.
    saved_primary: Option<Vec<Cell>>,
    /// Cursor belonging to `saved_primary`. This must not share storage with
    /// DECSC/SCOSC: full-screen apps use those while the alt screen is active.
    saved_primary_cursor: (usize, usize),
    pub cx: usize,
    pub cy: usize,
    pub cursor_visible: bool,
    /// DECSCUSR shape: 0 nothing asked for, 1-2 block, 3-4 underline, 5-6 bar.
    pub cursor_style: u8,
    /// IRM, the insert/overwrite toggle behind the Insert key.
    pub insert_mode: bool,
    pub alt: bool,
    pub title: String,
    pub bracketed_paste: bool,
    /// Rows changed since the last drain.
    dirty: Vec<bool>,
    /// Lines that scrolled off the top since the last drain, for the front end
    /// to append to its history.
    pending_scroll: Vec<Vec<Cell>>,
    pub scrollback: VecDeque<Vec<Cell>>,
    /// Set when CSI 3 J wipes the scrollback, so the front end can drop its
    /// history DOM in the same update.
    pending_clear_history: bool,
    /// Replies requested by terminal queries (DSR/DA), drained by the ConPTY
    /// reader and written back to the application as terminal input.
    pending_reply: Vec<u8>,

    scroll_top: usize,
    scroll_bot: usize,
    pen: Cell,
    saved_cursor: (usize, usize),
    /// The VT deferred-wrap rule: writing the last column parks the cursor
    /// there and only wraps when the *next* character arrives.
    wrap_pending: bool,

    state: State,
    params: Vec<u32>,
    /// The `?` / `<` / `>` prefix of a private-mode sequence, or 0.
    private: u8,
    osc: String,
    utf8_buf: Vec<u8>,
    utf8_need: usize,
}

impl Grid {
    pub fn new(cols: usize, rows: usize) -> Grid {
        let cols = cols.max(1);
        let rows = rows.max(1);
        Grid {
            cols,
            rows,
            cells: vec![Cell::default(); cols * rows],
            saved_primary: None,
            saved_primary_cursor: (0, 0),
            cx: 0,
            cy: 0,
            cursor_visible: true,
            cursor_style: 0,
            insert_mode: false,
            alt: false,
            title: String::new(),
            bracketed_paste: false,
            dirty: vec![true; rows],
            pending_scroll: Vec::new(),
            scrollback: VecDeque::new(),
            pending_clear_history: false,
            pending_reply: Vec::new(),
            scroll_top: 0,
            scroll_bot: rows - 1,
            pen: Cell::default(),
            saved_cursor: (0, 0),
            wrap_pending: false,
            state: State::Ground,
            params: Vec::new(),
            private: 0,
            osc: String::new(),
            utf8_buf: Vec::new(),
            utf8_need: 0,
        }
    }

    pub fn row(&self, y: usize) -> &[Cell] {
        &self.cells[y * self.cols..(y + 1) * self.cols]
    }

    /// Rows touched since the last call, then cleared.
    pub fn take_dirty(&mut self) -> Vec<usize> {
        let out: Vec<usize> = (0..self.rows)
            .filter(|&y| self.dirty.get(y).copied().unwrap_or(false))
            .collect();
        self.dirty.iter_mut().for_each(|d| *d = false);
        out
    }

    pub fn take_scrolled(&mut self) -> Vec<Vec<Cell>> {
        std::mem::take(&mut self.pending_scroll)
    }

    /// Whether CSI 3 J cleared the scrollback since the last drain.
    pub fn take_clear_history(&mut self) -> bool {
        std::mem::take(&mut self.pending_clear_history)
    }

    pub fn take_reply(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.pending_reply)
    }

    pub fn mark_all_dirty(&mut self) {
        self.dirty.iter_mut().for_each(|d| *d = true);
    }

    fn idx(&self, x: usize, y: usize) -> usize {
        y * self.cols + x
    }

    fn touch(&mut self, y: usize) {
        if let Some(d) = self.dirty.get_mut(y) {
            *d = true;
        }
    }

    // ---- feeding -------------------------------------------------------

    pub fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.byte(b);
        }
    }

    fn byte(&mut self, b: u8) {
        match self.state {
            State::Ground => self.ground(b),
            State::Esc => self.escape(b),
            State::Csi => self.csi(b),
            State::Osc => self.osc_byte(b),
            State::Charset => self.state = State::Ground,
        }
    }

    fn ground(&mut self, b: u8) {
        // A continuation byte only makes sense mid-codepoint; anything else
        // abandons a truncated sequence rather than corrupting the next glyph.
        if self.utf8_need > 0 {
            if b & 0xC0 == 0x80 {
                self.utf8_buf.push(b);
                self.utf8_need -= 1;
                if self.utf8_need == 0 {
                    let text = String::from_utf8_lossy(&self.utf8_buf).into_owned();
                    self.utf8_buf.clear();
                    for c in text.chars() {
                        self.put(c);
                    }
                }
                return;
            }
            self.utf8_buf.clear();
            self.utf8_need = 0;
        }
        match b {
            0x1B => {
                self.state = State::Esc;
                self.params.clear();
                self.private = 0;
            }
            b'\r' => {
                self.cx = 0;
                self.wrap_pending = false;
            }
            b'\n' => {
                self.linefeed();
                self.wrap_pending = false;
            }
            0x08 => {
                self.cx = self.cx.saturating_sub(1);
                self.wrap_pending = false;
            }
            b'\t' => {
                let next = ((self.cx / 8) + 1) * 8;
                self.cx = next.min(self.cols - 1);
                self.wrap_pending = false;
            }
            0x07 => {}
            0x00..=0x1F => {}
            0x20..=0x7F => self.put(b as char),
            _ => {
                // Lead byte of a multi-byte UTF-8 sequence.
                self.utf8_need = match b {
                    0xC0..=0xDF => 1,
                    0xE0..=0xEF => 2,
                    0xF0..=0xF7 => 3,
                    _ => 0,
                };
                if self.utf8_need > 0 {
                    self.utf8_buf.clear();
                    self.utf8_buf.push(b);
                } else {
                    self.put('\u{FFFD}');
                }
            }
        }
    }

    fn escape(&mut self, b: u8) {
        match b {
            b'[' => {
                self.state = State::Csi;
                self.params.clear();
                self.private = 0;
            }
            b']' => {
                self.state = State::Osc;
                self.osc.clear();
            }
            b'7' => {
                self.saved_cursor = (self.cx, self.cy);
                self.state = State::Ground;
            }
            b'8' => {
                let (x, y) = self.saved_cursor;
                self.cx = x.min(self.cols - 1);
                self.cy = y.min(self.rows - 1);
                self.wrap_pending = false;
                self.state = State::Ground;
            }
            b'M' => {
                // Reverse index: up one line, scrolling the region if at the top.
                if self.cy == self.scroll_top {
                    self.scroll_down(1);
                } else {
                    self.cy = self.cy.saturating_sub(1);
                }
                self.wrap_pending = false;
                self.state = State::Ground;
            }
            b'D' => {
                self.linefeed();
                self.wrap_pending = false;
                self.state = State::Ground;
            }
            b'E' => {
                self.cx = 0;
                self.linefeed();
                self.wrap_pending = false;
                self.state = State::Ground;
            }
            b'c' => {
                self.reset();
                self.state = State::Ground;
            }
            b'(' | b')' | b'*' | b'+' => self.state = State::Charset,
            _ => self.state = State::Ground,
        }
    }

    fn csi(&mut self, b: u8) {
        match b {
            b'0'..=b'9' => {
                if self.params.is_empty() {
                    self.params.push(0);
                }
                let last = self.params.last_mut().unwrap();
                *last = last.saturating_mul(10).saturating_add((b - b'0') as u32);
            }
            b';' => self.params.push(0),
            // Sub-parameters (`38:2:r:g:b`) are flattened onto the same list,
            // which reads identically for every sequence we act on.
            b':' => self.params.push(0),
            b'?' | b'<' | b'=' | b'>' => self.private = b,
            b' '..=b'/' => {}
            0x40..=0x7E => {
                self.dispatch(b);
                self.state = State::Ground;
            }
            _ => self.state = State::Ground,
        }
    }

    fn osc_byte(&mut self, b: u8) {
        match b {
            0x07 => {
                self.finish_osc();
                self.state = State::Ground;
            }
            0x1B => {
                // ESC \ terminator: the backslash is swallowed by Esc handling.
                self.finish_osc();
                self.state = State::Esc;
            }
            _ => {
                if self.osc.len() < 512 {
                    self.osc.push(b as char);
                }
            }
        }
    }

    fn finish_osc(&mut self) {
        let s = std::mem::take(&mut self.osc);
        if let Some((code, text)) = s.split_once(';') {
            if code == "0" || code == "2" {
                self.title = text.to_string();
            }
        }
    }

    fn param(&self, i: usize, default: u32) -> u32 {
        match self.params.get(i) {
            Some(&0) | None => default,
            Some(&v) => v,
        }
    }

    fn dispatch(&mut self, final_byte: u8) {
        let p0 = self.param(0, 1) as usize;
        // Every sequence below either moves the cursor or rewrites the cells
        // around it, and each one cancels a wrap that is merely parked. Missing
        // one leaves the flag set, and the next printable character opens a
        // line the program never asked for — which is how an inline TUI's
        // redraw drifts a line away from the shell hosting it.
        if matches!(
            final_byte,
            b'A'..=b'H'
                | b'J'
                | b'K'
                | b'L'
                | b'M'
                | b'P'
                | b'S'
                | b'T'
                | b'X'
                | b'@'
                | b'`'
                | b'd'
                | b'f'
                | b'r'
        ) {
            self.wrap_pending = false;
        }
        match final_byte {
            b'A' => self.cy = self.cy.saturating_sub(p0),
            b'B' => self.cy = (self.cy + p0).min(self.rows - 1),
            b'C' => self.cx = (self.cx + p0).min(self.cols - 1),
            b'D' => self.cx = self.cx.saturating_sub(p0),
            b'E' => {
                self.cy = (self.cy + p0).min(self.rows - 1);
                self.cx = 0;
            }
            b'F' => {
                self.cy = self.cy.saturating_sub(p0);
                self.cx = 0;
            }
            b'G' | b'`' => self.cx = (p0 - 1).min(self.cols - 1),
            b'd' => self.cy = (p0 - 1).min(self.rows - 1),
            b'H' | b'f' => {
                let row = self.param(0, 1) as usize;
                let col = self.param(1, 1) as usize;
                self.cy = (row - 1).min(self.rows - 1);
                self.cx = (col - 1).min(self.cols - 1);
            }
            b'J' => self.erase_display(self.param(0, 0)),
            b'K' => self.erase_line(self.param(0, 0)),
            b'L' => self.insert_lines(p0),
            b'M' => self.delete_lines(p0),
            b'P' => self.delete_chars(p0),
            b'@' => self.insert_chars(p0),
            b'X' => self.erase_chars(p0),
            b'S' => self.scroll_up(p0),
            b'T' => self.scroll_down(p0),
            b'm' => self.sgr(),
            b'n' if self.private == 0 => match self.param(0, 0) {
                5 => self.pending_reply.extend_from_slice(b"\x1b[0n"),
                6 => self
                    .pending_reply
                    .extend_from_slice(format!("\x1b[{};{}R", self.cy + 1, self.cx + 1).as_bytes()),
                _ => {}
            },
            b'c' if self.private == 0 => {
                self.pending_reply.extend_from_slice(b"\x1b[?1;2c");
            }
            b'c' if self.private == b'>' => {
                self.pending_reply.extend_from_slice(b"\x1b[>0;10;1c");
            }
            b'q' => self.cursor_style = self.param(0, 0).min(6) as u8,
            b'r' => {
                let top = self.param(0, 1) as usize - 1;
                let bot = self
                    .params
                    .get(1)
                    .copied()
                    .filter(|&v| v > 0)
                    .unwrap_or(self.rows as u32) as usize
                    - 1;
                if top < bot && bot < self.rows {
                    self.scroll_top = top;
                    self.scroll_bot = bot;
                    self.cx = 0;
                    self.cy = top;
                }
            }
            b'h' => self.set_mode(true),
            b'l' => self.set_mode(false),
            // Save/restore cursor only with no private marker. `CSI > 1 u` and
            // `CSI < u` push and pop keyboard flags in the kitty protocol, and
            // reading those as a restore throws the cursor back to wherever it
            // was last saved — which is how a program that pops its flags on
            // the way out of Ctrl+C leaves the shell drawing its next prompt
            // above everything still on screen.
            b's' if self.private == 0 => self.saved_cursor = (self.cx, self.cy),
            b'u' if self.private == 0 => {
                let (x, y) = self.saved_cursor;
                self.cx = x.min(self.cols - 1);
                self.cy = y.min(self.rows - 1);
                self.wrap_pending = false;
            }
            _ => {}
        }
    }

    fn set_mode(&mut self, on: bool) {
        // The < and > prefixes address other protocols entirely; only the
        // unprefixed ANSI modes and the ? private ones are ours.
        if self.private != b'?' && self.private != 0 {
            return;
        }
        for i in 0..self.params.len().max(1) {
            let p = self.param(i, 0);
            if self.private == 0 {
                // IRM. Nothing here inserts on the terminal's behalf - conpty
                // sends the finished line - but it is what the Insert key
                // toggles, and the cursor has to show it.
                if p == 4 {
                    self.insert_mode = on;
                }
                continue;
            }
            match p {
                25 => self.cursor_visible = on,
                2004 => self.bracketed_paste = on,
                1049 | 47 | 1047 => self.set_alt(on),
                _ => {}
            }
        }
    }

    /// The shape the cursor is actually drawn with. Insert mode outranks the
    /// resting shape: a block is how overwrite has always announced itself.
    pub fn effective_cursor_style(&self) -> u8 {
        if self.insert_mode {
            2
        } else {
            self.cursor_style
        }
    }

    /// The alternate screen: full-screen programs get a scratch buffer that
    /// never touches scrollback, and the primary screen comes back untouched.
    fn set_alt(&mut self, on: bool) {
        if on == self.alt {
            return;
        }
        if on {
            self.saved_primary = Some(self.cells.clone());
            self.saved_primary_cursor = (self.cx, self.cy);
            self.cells = vec![Cell::default(); self.cols * self.rows];
            self.cx = 0;
            self.cy = 0;
        } else if let Some(prev) = self.saved_primary.take() {
            // A resize while the alt screen was up would leave the saved buffer
            // the wrong length, so fall back to a clear rather than panic.
            if prev.len() == self.cols * self.rows {
                self.cells = prev;
            } else {
                self.cells = vec![Cell::default(); self.cols * self.rows];
            }
            let (x, y) = self.saved_primary_cursor;
            self.cx = x.min(self.cols - 1);
            self.cy = y.min(self.rows - 1);
        }
        self.alt = on;
        self.wrap_pending = false;
        self.mark_all_dirty();
    }

    fn sgr(&mut self) {
        if self.params.is_empty() {
            self.pen = Cell::default();
            return;
        }
        let mut i = 0;
        while i < self.params.len() {
            let p = self.params[i];
            match p {
                0 => self.pen = Cell::default(),
                1 => self.pen.attr |= ATTR_BOLD,
                2 => self.pen.attr |= ATTR_DIM,
                3 => self.pen.attr |= ATTR_ITALIC,
                4 => self.pen.attr |= ATTR_UNDERLINE,
                7 => self.pen.attr |= ATTR_REVERSE,
                9 => self.pen.attr |= ATTR_STRIKE,
                21 | 22 => self.pen.attr &= !(ATTR_BOLD | ATTR_DIM),
                23 => self.pen.attr &= !ATTR_ITALIC,
                24 => self.pen.attr &= !ATTR_UNDERLINE,
                27 => self.pen.attr &= !ATTR_REVERSE,
                29 => self.pen.attr &= !ATTR_STRIKE,
                30..=37 => self.pen.fg = p - 30,
                39 => self.pen.fg = DEFAULT_COLOR,
                40..=47 => self.pen.bg = p - 40,
                49 => self.pen.bg = DEFAULT_COLOR,
                90..=97 => self.pen.fg = p - 90 + 8,
                100..=107 => self.pen.bg = p - 100 + 8,
                38 | 48 => {
                    let (color, used) = self.extended_color(i);
                    if p == 38 {
                        self.pen.fg = color;
                    } else {
                        self.pen.bg = color;
                    }
                    i += used;
                }
                _ => {}
            }
            i += 1;
        }
    }

    /// Reads a `38;5;n` or `38;2;r;g;b` colour starting at `i`, returning the
    /// colour and how many extra parameters it consumed.
    fn extended_color(&self, i: usize) -> (u32, usize) {
        match self.params.get(i + 1) {
            Some(5) => (self.params.get(i + 2).copied().unwrap_or(0) & 0xFF, 2),
            Some(2) => {
                let r = self.params.get(i + 2).copied().unwrap_or(0) & 0xFF;
                let g = self.params.get(i + 3).copied().unwrap_or(0) & 0xFF;
                let b = self.params.get(i + 4).copied().unwrap_or(0) & 0xFF;
                (RGB_FLAG | (r << 16) | (g << 8) | b, 4)
            }
            _ => (DEFAULT_COLOR, 0),
        }
    }

    // ---- screen operations ---------------------------------------------

    /// Clears whichever half of a double-width glyph the cell at `i` belongs
    /// to. Writing into either half leaves the other one stranded - a lead
    /// with no continuation draws two columns wide into one, a continuation
    /// with no lead draws nothing - so the partner is blanked first. The
    /// cell's own colours stay: only the character is being taken away.
    fn split_wide(&mut self, i: usize) {
        let col = i % self.cols;
        let clear = |cell: &mut Cell| cell.ch = ' ';
        if self.cells[i].ch == CONT {
            if col > 0 {
                clear(&mut self.cells[i - 1]);
            }
        } else if char_width(self.cells[i].ch) == 2 && col + 1 < self.cols {
            clear(&mut self.cells[i + 1]);
        }
    }

    fn put(&mut self, c: char) {
        let w = char_width(c);
        // A combining mark owns no column. A cell holds one character, so
        // there is nowhere to attach it - and writing it into a column of its
        // own would eat the letter it belongs to and shift the rest of the
        // line. Losing the accent keeps every column where the program put it.
        if w == 0 {
            return;
        }
        if self.wrap_pending {
            self.cx = 0;
            self.linefeed();
            self.wrap_pending = false;
        }
        // A double-width glyph cannot straddle the right edge: it wraps whole,
        // leaving the last column blank, which is what the program's own
        // column arithmetic assumed.
        if w == 2 && self.cx + 1 >= self.cols {
            let i = self.idx(self.cx, self.cy);
            self.split_wide(i);
            self.cells[i].ch = ' ';
            let y = self.cy;
            self.touch(y);
            self.cx = 0;
            self.linefeed();
        }
        let i = self.idx(self.cx, self.cy);
        self.split_wide(i);
        self.cells[i] = Cell {
            ch: c,
            fg: self.pen.fg,
            bg: self.pen.bg,
            attr: self.pen.attr,
        };
        if w == 2 {
            self.split_wide(i + 1);
            self.cells[i + 1] = Cell {
                ch: CONT,
                fg: self.pen.fg,
                bg: self.pen.bg,
                attr: self.pen.attr,
            };
        }
        let y = self.cy;
        self.touch(y);
        if self.cx + w >= self.cols {
            self.cx = self.cols - 1;
            self.wrap_pending = true;
        } else {
            self.cx += w;
        }
    }

    fn linefeed(&mut self) {
        if self.cy == self.scroll_bot {
            self.scroll_up(1);
        } else if self.cy + 1 < self.rows {
            self.cy += 1;
        }
    }

    fn scroll_up(&mut self, n: usize) {
        let (top, bot) = (self.scroll_top, self.scroll_bot);
        for _ in 0..n.min(self.rows) {
            // Only a full-height region on the primary screen produces history;
            // a scrolling sub-region is a program drawing, not output flowing by.
            if !self.alt && top == 0 && bot == self.rows - 1 {
                let line = self.row(top).to_vec();
                self.pending_scroll.push(line.clone());
                self.scrollback.push_back(line);
                while self.scrollback.len() > SCROLLBACK_MAX {
                    self.scrollback.pop_front();
                }
            }
            for y in top..bot {
                let (dst, src) = (self.idx(0, y), self.idx(0, y + 1));
                self.cells.copy_within(src..src + self.cols, dst);
            }
            let blank = Cell::blank(&self.pen);
            let start = self.idx(0, bot);
            self.cells[start..start + self.cols].fill(blank);
        }
        for y in top..=bot {
            self.touch(y);
        }
    }

    fn scroll_down(&mut self, n: usize) {
        let (top, bot) = (self.scroll_top, self.scroll_bot);
        for _ in 0..n.min(self.rows) {
            let mut y = bot;
            while y > top {
                let (dst, src) = (self.idx(0, y), self.idx(0, y - 1));
                self.cells.copy_within(src..src + self.cols, dst);
                y -= 1;
            }
            let blank = Cell::blank(&self.pen);
            let start = self.idx(0, top);
            self.cells[start..start + self.cols].fill(blank);
        }
        for y in top..=bot {
            self.touch(y);
        }
    }

    fn erase_display(&mut self, mode: u32) {
        let blank = Cell::blank(&self.pen);
        match mode {
            0 => {
                let from = self.idx(self.cx, self.cy);
                self.cells[from..].fill(blank);
                for y in self.cy..self.rows {
                    self.touch(y);
                }
            }
            1 => {
                let to = self.idx(self.cx, self.cy) + 1;
                self.cells[..to].fill(blank);
                for y in 0..=self.cy {
                    self.touch(y);
                }
            }
            // xterm's CSI 3 J: drop the scrollback. `clear` / Clear-Host send
            // this after CSI 2 J; without it the screen goes blank underneath
            // a history the front end still paints.
            3 => {
                self.scrollback.clear();
                self.pending_scroll.clear();
                self.pending_clear_history = true;
            }
            _ => {
                self.cells.fill(blank);
                self.mark_all_dirty();
            }
        }
    }

    fn erase_line(&mut self, mode: u32) {
        let blank = Cell::blank(&self.pen);
        let start = self.idx(0, self.cy);
        let (a, b) = match mode {
            0 => (start + self.cx, start + self.cols),
            1 => (start, start + self.cx + 1),
            _ => (start, start + self.cols),
        };
        self.cells[a..b.min(start + self.cols)].fill(blank);
        let y = self.cy;
        self.touch(y);
    }

    fn erase_chars(&mut self, n: usize) {
        let blank = Cell::blank(&self.pen);
        let start = self.idx(self.cx, self.cy);
        let end = (start + n).min(self.idx(0, self.cy) + self.cols);
        self.cells[start..end].fill(blank);
        let y = self.cy;
        self.touch(y);
    }

    fn insert_chars(&mut self, n: usize) {
        let row = self.idx(0, self.cy);
        let n = n.min(self.cols - self.cx);
        let from = row + self.cx;
        let to = row + self.cols;
        self.cells.copy_within(from..to - n, from + n);
        let blank = Cell::blank(&self.pen);
        self.cells[from..from + n].fill(blank);
        let y = self.cy;
        self.touch(y);
    }

    fn delete_chars(&mut self, n: usize) {
        let row = self.idx(0, self.cy);
        let n = n.min(self.cols - self.cx);
        let from = row + self.cx;
        let to = row + self.cols;
        self.cells.copy_within(from + n..to, from);
        let blank = Cell::blank(&self.pen);
        self.cells[to - n..to].fill(blank);
        let y = self.cy;
        self.touch(y);
    }

    /// Insert/delete lines act only within the scroll region, and only when the
    /// cursor is inside it — the same rule that keeps a status line pinned.
    fn insert_lines(&mut self, n: usize) {
        if self.cy < self.scroll_top || self.cy > self.scroll_bot {
            return;
        }
        let saved = self.scroll_top;
        self.scroll_top = self.cy;
        self.scroll_down(n);
        self.scroll_top = saved;
    }

    fn delete_lines(&mut self, n: usize) {
        if self.cy < self.scroll_top || self.cy > self.scroll_bot {
            return;
        }
        let saved = self.scroll_top;
        self.scroll_top = self.cy;
        self.scroll_up(n);
        self.scroll_top = saved;
    }

    fn reset(&mut self) {
        self.cells.fill(Cell::default());
        self.pen = Cell::default();
        self.cx = 0;
        self.cy = 0;
        self.scroll_top = 0;
        self.scroll_bot = self.rows - 1;
        self.cursor_visible = true;
        self.cursor_style = 0;
        self.insert_mode = false;
        self.wrap_pending = false;
        self.mark_all_dirty();
    }

    /// Reflows to a new size, keeping the top-left of the existing content.
    /// ConPTY repaints after its own resize, so this only has to stay coherent
    /// until that arrives.
    /// True when the parser is holding nothing half-read: no escape sequence
    /// in progress, no partial UTF-8. A stream may be cut here, and fed from
    /// here, which is what lets a kept session log be shortened from the front
    /// without the replay coming apart on a sequence that lost its beginning.
    pub fn at_ground(&self) -> bool {
        self.state == State::Ground && self.utf8_need == 0
    }

    /// Moves what is on screen into the scrollback and leaves a blank screen,
    /// the same way lines that scroll off the top become history.
    ///
    /// This is what a session does after its kept stream has been replayed:
    /// the shell that drew that screen is gone, and the one about to start
    /// must not paint over its output. `through` is the row to stop at - the
    /// row the old shell was standing on, holding a prompt nobody submitted.
    pub fn retire_screen(&mut self, through: usize) {
        // A full-screen program was still running when the stream ended. What
        // it drew was never output; the primary screen underneath it is. So
        // the alternate screen is dropped exactly as leaving it would drop it.
        if self.alt {
            if let Some(primary) = self.saved_primary.take() {
                self.cells = primary;
            }
            self.alt = false;
            self.cx = self.saved_primary_cursor.0.min(self.cols - 1);
            self.cy = self.saved_primary_cursor.1.min(self.rows - 1);
        }
        // Blank rows at the end of the range are unused screen, not output.
        let mut end = through.min(self.rows);
        while end > 0
            && self
                .row(end - 1)
                .iter()
                .all(|c| c.ch == ' ' && c.bg == DEFAULT_COLOR && c.attr == 0)
        {
            end -= 1;
        }
        for y in 0..end {
            self.scrollback.push_back(self.row(y).to_vec());
            while self.scrollback.len() > SCROLLBACK_MAX {
                self.scrollback.pop_front();
            }
        }
        self.cells = vec![Cell::default(); self.cols * self.rows];
        self.cx = 0;
        self.cy = 0;
        self.pen = Cell::default();
        self.saved_cursor = (0, 0);
        self.wrap_pending = false;
        self.pending_scroll.clear();
        self.pending_clear_history = false;
        self.dirty = vec![true; self.rows];
    }

    pub fn resize(&mut self, cols: usize, rows: usize) {
        let cols = cols.max(1);
        let rows = rows.max(1);
        if cols == self.cols && rows == self.rows {
            return;
        }
        let mut next = vec![Cell::default(); cols * rows];
        for y in 0..rows.min(self.rows) {
            for x in 0..cols.min(self.cols) {
                next[y * cols + x] = self.cells[y * self.cols + x];
            }
        }
        self.cells = next;
        self.saved_primary = None;
        self.saved_primary_cursor = (0, 0);
        self.cols = cols;
        self.rows = rows;
        self.dirty = vec![true; rows];
        self.cx = self.cx.min(cols - 1);
        self.cy = self.cy.min(rows - 1);
        self.scroll_top = 0;
        self.scroll_bot = rows - 1;
        self.wrap_pending = false;
    }
}
