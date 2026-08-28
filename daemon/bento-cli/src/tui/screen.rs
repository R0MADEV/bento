//! The remote terminal, kept as a grid instead of dumped to stdout.
//!
//! A pty speaks in absolute screen coordinates ("go to row 5", "clear the
//! screen"), so writing its bytes straight out would paint over the sidebar.
//! Feeding them to a parser and rendering the resulting grid into a `Rect` is
//! what lets the terminal live inside the panel.

use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};

/// vt100 underflows on a grid this small: wrapping computes `cols - width`,
/// and the scroll that follows subtracts from row 0. Both panic rather than
/// clamp. A collapsed or not-yet-laid-out panel really can report zero, so
/// the floor is enforced here instead of trusted from the caller.
const MIN_ROWS: u16 = 2;
const MIN_COLS: u16 = 2;

pub(crate) struct Screen {
    parser: vt100::Parser,
    wants_mouse: bool,
}

impl Screen {
    pub(crate) fn new(rows: u16, cols: u16) -> Self {
        Self { parser: vt100::Parser::new(rows.max(MIN_ROWS), cols.max(MIN_COLS), 0), wants_mouse: false }
    }

    pub(crate) fn feed(&mut self, bytes: &[u8]) {
        if let Some(wanted) = mouse_mode_change(bytes) {
            self.wants_mouse = wanted;
        }
        self.parser.process(bytes);
    }

    /// Whether the remote program asked for the mouse. While it has it the
    /// panel forwards clicks instead of using them for its own divider —
    /// vim and htop are unusable without it, and vt100 does not track the
    /// mode, so it is read off the stream here.
    pub(crate) fn wants_mouse(&self) -> bool {
        self.wants_mouse
    }

    /// Resizes the emulated screen, telling the caller whether anything
    /// changed so it can avoid a pointless round trip to the daemon.
    pub(crate) fn resize(&mut self, rows: u16, cols: u16) -> bool {
        let (rows, cols) = (rows.max(MIN_ROWS), cols.max(MIN_COLS));
        if self.parser.screen().size() == (rows, cols) {
            return false;
        }
        self.parser.screen_mut().set_size(rows, cols);
        true
    }

    /// Only the tests read this back; the panel drives the size rather than
    /// asking for it.
    #[cfg(test)]
    pub(crate) fn size(&self) -> (u16, u16) {
        self.parser.screen().size()
    }

    /// Where the remote program left its cursor, in absolute frame
    /// coordinates, or None when it is hidden.
    pub(crate) fn cursor_in(&self, area: Rect) -> Option<(u16, u16)> {
        let screen = self.parser.screen();
        if screen.hide_cursor() {
            return None;
        }
        let (row, col) = screen.cursor_position();
        (row < area.height && col < area.width).then(|| (area.x + col, area.y + row))
    }

    /// Paints the grid into `area`, one cell at a time: the parser already
    /// resolved every escape sequence into a character plus its colours.
    pub(crate) fn render(&self, frame: &mut ratatui::Frame, area: Rect) {
        let screen = self.parser.screen();
        let buffer = frame.buffer_mut();
        for row in 0..area.height {
            for col in 0..area.width {
                let Some(cell) = screen.cell(row, col) else { continue };
                let target = &mut buffer[(area.x + col, area.y + row)];
                let contents = cell.contents();
                // An empty cell means "nothing drawn here", which has to be
                // painted as a space or the previous frame shows through.
                target.set_symbol(if contents.is_empty() { " " } else { contents });
                target.set_style(cell_style(cell));
            }
        }
    }
}

fn cell_style(cell: &vt100::Cell) -> Style {
    let mut style = Style::default();
    if let Some(color) = convert(cell.fgcolor()) {
        style = style.fg(color);
    }
    if let Some(color) = convert(cell.bgcolor()) {
        style = style.bg(color);
    }
    if cell.bold() {
        style = style.add_modifier(Modifier::BOLD);
    }
    if cell.italic() {
        style = style.add_modifier(Modifier::ITALIC);
    }
    if cell.underline() {
        style = style.add_modifier(Modifier::UNDERLINED);
    }
    if cell.inverse() {
        style = style.add_modifier(Modifier::REVERSED);
    }
    style
}

/// vt100's default means "whatever the terminal uses", which is ratatui's
/// unset — not a colour of its own.
fn convert(color: vt100::Color) -> Option<Color> {
    match color {
        vt100::Color::Default => None,
        vt100::Color::Idx(i) => Some(Color::Indexed(i)),
        vt100::Color::Rgb(r, g, b) => Some(Color::Rgb(r, g, b)),
    }
}

/// The last mouse-tracking mode change in `bytes`, if any. Programs enable
/// tracking with `CSI ? <mode> h` and drop it with `l`; the modes that matter
/// are 1000 (clicks), 1002/1003 (drag and motion) and 1006 (SGR encoding).
fn mouse_mode_change(bytes: &[u8]) -> Option<bool> {
    const MODES: [&[u8]; 4] = [b"1000", b"1002", b"1003", b"1006"];
    let mut last = None;
    let mut rest = bytes;
    while let Some(at) = rest.windows(2).position(|w| w == b"\x1b[") {
        let after = &rest[at + 2..];
        if after.first() == Some(&b'?') {
            let body = &after[1..];
            if let Some(end) = body.iter().position(|b| *b == b'h' || *b == b'l') {
                if MODES.iter().any(|mode| body[..end].split(|b| *b == b';').any(|part| part == *mode)) {
                    last = Some(body[end] == b'h');
                }
            }
        }
        rest = after;
    }
    last
}

/// One mouse event as the SGR (1006) encoding a modern program expects:
/// `CSI < button ; col ; row M` for a press, `m` for a release. Coordinates
/// are 1-based and relative to the pane, not the window.
pub(crate) fn encode_mouse(kind: crossterm::event::MouseEventKind, column: u16, row: u16) -> Option<Vec<u8>> {
    use crossterm::event::{MouseButton, MouseEventKind};
    let (button, press) = match kind {
        MouseEventKind::Down(MouseButton::Left) => (0, true),
        MouseEventKind::Down(MouseButton::Middle) => (1, true),
        MouseEventKind::Down(MouseButton::Right) => (2, true),
        MouseEventKind::Up(MouseButton::Left) => (0, false),
        MouseEventKind::Up(MouseButton::Middle) => (1, false),
        MouseEventKind::Up(MouseButton::Right) => (2, false),
        // 32 is the drag bit; wheel events are 64 and 65.
        MouseEventKind::Drag(MouseButton::Left) => (32, true),
        MouseEventKind::ScrollUp => (64, true),
        MouseEventKind::ScrollDown => (65, true),
        _ => return None,
    };
    let final_byte = if press { 'M' } else { 'm' };
    Some(format!("\x1b[<{button};{};{}{final_byte}", column + 1, row + 1).into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    /// Renders the screen into a sub-area of a larger frame and returns the
    /// whole frame as text, so a test can check both what landed inside the
    /// area and what stayed untouched outside it.
    fn render_into(screen: &Screen, area: Rect, width: u16, height: u16) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| {
                // A marker outside the area, to catch a render that overflows.
                frame.buffer_mut()[(0u16, 0u16)].set_symbol("#");
                screen.render(frame, area);
            })
            .unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..height)
            .map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect())
            .collect()
    }

    #[test]
    fn a_program_that_asks_for_the_mouse_gets_it() {
        let mut screen = Screen::new(10, 20);
        assert!(!screen.wants_mouse(), "el panel se queda el ratón por defecto");

        screen.feed(b"\x1b[?1002h\x1b[?1006h");
        assert!(screen.wants_mouse());

        // vim turns it off on exit; the panel takes it back.
        screen.feed(b"\x1b[?1002l\x1b[?1006l");
        assert!(!screen.wants_mouse());
    }

    #[test]
    fn an_unrelated_escape_does_not_hand_over_the_mouse() {
        let mut screen = Screen::new(10, 20);
        // Alternate screen and cursor hiding are not mouse modes.
        screen.feed(b"\x1b[?1049h\x1b[?25l");
        assert!(!screen.wants_mouse());
    }

    #[test]
    fn a_click_is_encoded_where_the_program_expects_it() {
        use crossterm::event::{MouseButton, MouseEventKind};
        // SGR is 1-based, and the coordinates are the pane's, not the window's.
        assert_eq!(
            encode_mouse(MouseEventKind::Down(MouseButton::Left), 4, 9).unwrap(),
            b"\x1b[<0;5;10M".to_vec()
        );
        assert_eq!(
            encode_mouse(MouseEventKind::Up(MouseButton::Left), 0, 0).unwrap(),
            b"\x1b[<0;1;1m".to_vec(),
        );
    }

    #[test]
    fn the_wheel_reaches_the_program_too() {
        use crossterm::event::MouseEventKind;
        assert!(encode_mouse(MouseEventKind::ScrollUp, 0, 0).unwrap().starts_with(b"\x1b[<64;"));
        assert!(encode_mouse(MouseEventKind::ScrollDown, 0, 0).unwrap().starts_with(b"\x1b[<65;"));
    }

    #[test]
    fn an_event_with_no_encoding_is_dropped_rather_than_faked() {
        use crossterm::event::MouseEventKind;
        assert!(encode_mouse(MouseEventKind::Moved, 0, 0).is_none());
    }

    #[test]
    fn plain_output_lands_in_the_grid() {
        let mut screen = Screen::new(4, 10);
        screen.feed(b"hola");

        let lines = render_into(&screen, Rect::new(2, 1, 10, 4), 14, 6);
        assert!(lines[1].contains("hola"));
    }

    #[test]
    fn the_cursor_escape_moves_text_instead_of_printing_itself() {
        let mut screen = Screen::new(4, 10);
        // "go to row 3, column 1" — the whole point of the emulator: this must
        // place the text, not show up as characters.
        screen.feed(b"\x1b[3;1Habajo");

        let lines = render_into(&screen, Rect::new(0, 0, 10, 4), 10, 4);
        assert!(lines[2].contains("abajo"));
        assert!(!lines.join("\n").contains("1H"), "la secuencia no se imprime literal");
    }

    #[test]
    fn clearing_the_remote_screen_does_not_touch_anything_outside_the_area() {
        let mut screen = Screen::new(3, 6);
        screen.feed(b"\x1b[2J");

        // The marker at 0,0 sits outside the area and must survive: dumping
        // this to stdout is exactly what would have wiped the sidebar.
        let lines = render_into(&screen, Rect::new(2, 1, 6, 3), 10, 5);
        assert_eq!(&lines[0][0..1], "#");
    }

    #[test]
    fn colours_survive_into_the_buffer() {
        let mut screen = Screen::new(2, 8);
        screen.feed(b"\x1b[31mrojo\x1b[0m");

        let mut terminal = Terminal::new(TestBackend::new(8, 2)).unwrap();
        terminal.draw(|frame| screen.render(frame, Rect::new(0, 0, 8, 2))).unwrap();
        let buffer = terminal.backend().buffer().clone();

        assert_eq!(buffer[(0u16, 0u16)].style().fg, Some(Color::Indexed(1)));
    }

    #[test]
    fn resizing_reports_whether_it_actually_changed() {
        let mut screen = Screen::new(10, 20);

        assert!(screen.resize(12, 30), "un tamaño nuevo sí cambia");
        assert_eq!(screen.size(), (12, 30));
        assert!(!screen.resize(12, 30), "el mismo tamaño no vuelve a avisar al daemon");
    }

    #[test]
    fn a_zero_sized_area_does_not_panic_the_parser() {
        let mut screen = Screen::new(0, 0);
        screen.resize(0, 0);
        screen.feed(b"algo");

        assert_eq!(screen.size(), (MIN_ROWS, MIN_COLS));
    }

    #[test]
    fn the_cursor_is_reported_in_frame_coordinates() {
        let mut screen = Screen::new(4, 10);
        screen.feed(b"\x1b[2;3H");

        // Row 2, column 3 in 1-based ANSI is (1, 2) zero-based, offset by the
        // area's own origin.
        assert_eq!(screen.cursor_in(Rect::new(5, 10, 10, 4)), Some((5 + 2, 10 + 1)));
    }

    #[test]
    fn a_cursor_outside_the_area_is_not_reported() {
        let mut screen = Screen::new(20, 20);
        screen.feed(b"\x1b[19;19H");

        assert_eq!(screen.cursor_in(Rect::new(0, 0, 5, 5)), None);
    }
}
