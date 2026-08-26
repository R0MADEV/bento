//! The right-hand half of every panel: a titled frame with the hints for
//! whatever is inside it. The rail's counterpart — panels own their contents,
//! this owns the frame around them.

use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders};

const DIM: Style = Style::new().fg(Color::DarkGray);
/// The focused frame is tinted rather than brightened: a panel with the
/// keyboard should be obvious without shouting over its own contents.
const FOCUSED: Style = Style::new().fg(Color::Indexed(4));

pub(crate) struct Pane<'a> {
    pub(crate) title: &'a str,
    /// The keys that work in this pane, shown along the frame.
    pub(crate) hint: &'a str,
    pub(crate) focused: bool,
}

impl Pane<'_> {
    /// Draws the frame and hands back the area inside it.
    pub(crate) fn render(&self, frame: &mut ratatui::Frame, area: Rect) -> Rect {
        let heading = match (self.title.is_empty(), self.hint.is_empty()) {
            (true, true) => String::new(),
            (true, false) => format!(" {} ", self.hint),
            (false, true) => format!(" {} ", self.title),
            (false, false) => format!(" {} · {} ", self.title, self.hint),
        };
        let block = Block::default()
            .title(Line::from(Span::styled(heading, DIM)))
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(if self.focused { FOCUSED } else { DIM });
        let inner = block.inner(area);
        frame.render_widget(block, area);
        inner
    }
}

/// The usable area inside a pane, without drawing it. Needed before a render
/// — a pty has to be told what size to wrap to before its frame exists.
pub(crate) fn inner(area: Rect) -> Rect {
    Block::default().borders(Borders::ALL).inner(area)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn render(pane: &Pane, area: Rect, width: u16, height: u16) -> (Vec<String>, Rect) {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let mut inner = Rect::default();
        terminal.draw(|frame| inner = pane.render(frame, area)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        let lines = (0..height)
            .map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect())
            .collect();
        (lines, inner)
    }

    #[test]
    fn the_title_and_the_hint_share_the_frame() {
        let pane = Pane { title: "Agent 1", hint: "F12 lista", focused: false };

        let (lines, _) = render(&pane, Rect::new(0, 0, 40, 5), 40, 5);
        assert!(lines[0].contains("Agent 1"));
        assert!(lines[0].contains("F12 lista"));
    }

    #[test]
    fn a_pane_without_a_title_still_shows_its_hint() {
        let pane = Pane { title: "", hint: "solo atajos", focused: false };

        let (lines, _) = render(&pane, Rect::new(0, 0, 40, 5), 40, 5);
        assert!(lines[0].contains("solo atajos"));
        // No stray separator left over from the empty half.
        assert!(!lines[0].contains("· solo"));
    }

    #[test]
    fn the_inner_area_excludes_the_border() {
        let pane = Pane { title: "x", hint: "", focused: false };

        let (_, inner) = render(&pane, Rect::new(10, 4, 30, 8), 60, 20);
        assert_eq!(inner, Rect::new(11, 5, 28, 6));
    }

    #[test]
    fn the_standalone_inner_agrees_with_the_rendered_one() {
        // The pty is sized from `inner` before the frame is ever drawn; if the
        // two disagreed the remote program would wrap to the wrong width.
        let pane = Pane { title: "x", hint: "y", focused: true };
        let area = Rect::new(3, 2, 25, 9);

        let (_, rendered) = render(&pane, area, 40, 20);
        assert_eq!(inner(area), rendered);
    }

    #[test]
    fn focus_changes_the_border_rather_than_the_layout() {
        let area = Rect::new(0, 0, 20, 5);
        let (_, plain) = render(&Pane { title: "x", hint: "", focused: false }, area, 20, 5);
        let (_, focused) = render(&Pane { title: "x", hint: "", focused: true }, area, 20, 5);

        assert_eq!(plain, focused, "el foco no puede mover el contenido");
    }
}
