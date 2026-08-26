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
}

impl Screen {
    pub(crate) fn new(rows: u16, cols: u16) -> Self {
        Self { parser: vt100::Parser::new(rows.max(MIN_ROWS), cols.max(MIN_COLS), 0) }
    }

    pub(crate) fn feed(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
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
