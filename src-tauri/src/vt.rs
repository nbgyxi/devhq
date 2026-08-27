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
    use super::Grid;

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
        Cell { ch: ' ', fg: DEFAULT_COLOR, bg: pen.bg, attr: 0 }
    }
}

impl Default for Cell {
    fn default() -> Self {
        Cell { ch: ' ', fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attr: 0 }
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
    /// DECSCUSR shape: 0-2 block, 3-4 underline, 5-6 bar.
    pub cursor_style: u8,
    pub alt: bool,
    pub title: String,
    pub bracketed_paste: bool,
    /// Rows changed since the last drain.
    dirty: Vec<bool>,
    /// Lines that scrolled off the top since the last drain, for the front end
    /// to append to its history.
    pending_scroll: Vec<Vec<Cell>>,
    pub scrollback: VecDeque<Vec<Cell>>,

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
            cursor_style: 1,
            alt: false,
            title: String::new(),
            bracketed_paste: false,
            dirty: vec![true; rows],
            pending_scroll: Vec::new(),
            scrollback: VecDeque::new(),
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
        let out: Vec<usize> =
            (0..self.rows).filter(|&y| self.dirty.get(y).copied().unwrap_or(false)).collect();
        self.dirty.iter_mut().for_each(|d| *d = false);
        out
    }

    pub fn take_scrolled(&mut self) -> Vec<Vec<Cell>> {
        std::mem::take(&mut self.pending_scroll)
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
            b'A'..=b'H' | b'J' | b'K' | b'L' | b'M' | b'P' | b'S' | b'T' | b'X' | b'@' | b'`' | b'd' | b'f' | b'r'
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
            b'q' => self.cursor_style = self.param(0, 1).min(6) as u8,
            b'r' => {
                let top = self.param(0, 1) as usize - 1;
                let bot = self.params.get(1).copied().filter(|&v| v > 0).unwrap_or(self.rows as u32)
                    as usize
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
        if self.private != b'?' {
            return;
        }
        for i in 0..self.params.len().max(1) {
            match self.param(i, 0) {
                25 => self.cursor_visible = on,
                2004 => self.bracketed_paste = on,
                1049 | 47 | 1047 => self.set_alt(on),
                _ => {}
            }
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

    fn put(&mut self, c: char) {
        if self.wrap_pending {
            self.cx = 0;
            self.linefeed();
            self.wrap_pending = false;
        }
        let i = self.idx(self.cx, self.cy);
        self.cells[i] = Cell { ch: c, fg: self.pen.fg, bg: self.pen.bg, attr: self.pen.attr };
        let y = self.cy;
        self.touch(y);
        if self.cx + 1 >= self.cols {
            self.wrap_pending = true;
        } else {
            self.cx += 1;
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
        self.cursor_style = 1;
        self.wrap_pending = false;
        self.mark_all_dirty();
    }

    /// Reflows to a new size, keeping the top-left of the existing content.
    /// ConPTY repaints after its own resize, so this only has to stay coherent
    /// until that arrives.
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
