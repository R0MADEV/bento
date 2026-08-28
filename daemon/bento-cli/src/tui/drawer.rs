//! The right-hand drawer: the panel's third column.
//!
//! The rail says what you can pick and the pane shows what you picked; this
//! holds the conversation about it — a review's report, an agent's answer.
//! It folds like the rail, because it is worth the width only while you are
//! reading it.

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Paragraph, Wrap};

/// Default width: wide enough for a report's prose without starving the pane
/// it sits next to.
pub(crate) const DEFAULT_WIDTH: u16 = 60;
/// Folded still leaves a stub, so there is something to click to get it back.
pub(crate) const COLLAPSED_WIDTH: u16 = 3;
const MIN_WIDTH: u16 = 20;
const MAX_WIDTH_PERCENT: u16 = 70;

const DIM: Style = Style::new().fg(Color::DarkGray);
const FOCUSED: Style = Style::new().fg(Color::Indexed(4));

pub(crate) struct Drawer<'a> {
    pub(crate) title: &'a str,
    pub(crate) hint: &'a str,
    pub(crate) body: &'a str,
    /// Lines scrolled past, so a long report can be read to the end.
    pub(crate) scroll: u16,
    pub(crate) focused: bool,
}

impl Drawer<'_> {
    pub(crate) fn render(&self, frame: &mut ratatui::Frame, area: Rect) {
        let collapsed = area.width <= COLLAPSED_WIDTH;
        // Folded, the chevron points back the way it opens; open, it points at
        // the edge it will fold into. Mirrored from the rail's, which folds
        // the other way.
        let chevron = if collapsed { "‹" } else { "›" };
        let heading = match collapsed {
            true => Line::from(Span::styled(chevron, DIM)),
            false => Line::from(vec![
                Span::styled(chevron, DIM),
                Span::raw(" "),
                Span::styled(self.title, Style::new().add_modifier(Modifier::BOLD)),
            ]),
        };
        let block = Block::default()
            .title(heading)
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(if self.focused { FOCUSED } else { DIM });
        let inner = block.inner(area);
        frame.render_widget(block, area);
        if collapsed {
            return;
        }
        let rows = Layout::vertical([Constraint::Min(0), Constraint::Length(1)]).split(inner);
        frame.render_widget(
            Paragraph::new(self.body).wrap(Wrap { trim: false }).scroll((self.scroll, 0)),
            rows[0],
        );
        if !self.hint.is_empty() {
            frame.render_widget(Paragraph::new(Line::from(Span::styled(self.hint, DIM))), rows[1]);
        }
    }
}

/// Whether a click grabbed the drawer's left edge, with a column of slack on
/// each side — the divider is one cell and hitting it exactly is fussy.
pub(crate) fn grabs_divider(column: u16, drawer_left: u16) -> bool {
    column + 1 >= drawer_left && column <= drawer_left + 1
}

/// Whether a click landed on the chevron, which folds and unfolds.
pub(crate) fn grabs_chevron(column: u16, row: u16, drawer_left: u16) -> bool {
    row == 0 && column >= drawer_left && column <= drawer_left + 1
}

/// The drawer's width after dragging its edge to `column`, clamped so it can
/// neither vanish nor take over the window.
pub(crate) fn width_after_drag(column: u16, total_width: u16) -> u16 {
    let max = (total_width * MAX_WIDTH_PERCENT / 100).max(MIN_WIDTH);
    total_width.saturating_sub(column).clamp(MIN_WIDTH, max)
}

/// Folds the drawer away, or unfolds it to the width it had before.
pub(crate) fn toggle(current: u16, restored: &mut u16) -> u16 {
    if current > COLLAPSED_WIDTH {
        *restored = current;
        return COLLAPSED_WIDTH;
    }
    *restored
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn render(drawer: &Drawer, width: u16, height: u16) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| drawer.render(frame, frame.area())).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..height)
            .map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect())
            .collect()
    }

    fn drawer<'a>(body: &'a str, scroll: u16) -> Drawer<'a> {
        Drawer { title: "REVIEW", hint: "Esc cerrar", body, scroll, focused: false }
    }

    #[test]
    fn shows_its_title_and_body() {
        let screen = render(&drawer("veredicto: fail", 0), 40, 10).join("\n");
        assert!(screen.contains("REVIEW"));
        assert!(screen.contains("veredicto: fail"));
    }

    #[test]
    fn scrolling_moves_the_body_so_a_long_report_can_be_finished() {
        let body = (1..=20).map(|n| format!("linea {n}")).collect::<Vec<_>>().join("\n");
        let top = render(&drawer(&body, 0), 40, 6).join("\n");
        let further = render(&drawer(&body, 10), 40, 6).join("\n");

        assert!(top.contains("linea 1 "), "el principio se ve sin scroll");
        // "linea 1" alone would match "linea 11"; the trailing space is what
        // makes this about the first line.
        assert!(!further.contains("linea 1 "), "scroll tiene que dejar atrás el principio");
        assert!(further.contains("linea 11"));
    }

    #[test]
    fn folded_it_keeps_a_stub_rather_than_disappearing() {
        let screen = render(&drawer("un informe largo", 0), COLLAPSED_WIDTH, 10).join("\n");
        assert!(!screen.contains("informe"), "plegado no pinta el contenido a medias");
        assert!(screen.contains('‹'), "y deja el chevron para volver a abrirlo");
    }

    #[test]
    fn its_divider_is_on_its_left_edge() {
        // Mirrored from the rail's, whose divider is on its right.
        assert!(grabs_divider(40, 40));
        assert!(grabs_divider(39, 40));
        assert!(!grabs_divider(20, 40));
    }

    #[test]
    fn dragging_left_makes_it_wider() {
        // The drawer grows towards the middle of the window, so a smaller
        // column means a wider drawer — the opposite of the rail.
        assert!(width_after_drag(40, 100) > width_after_drag(70, 100));
    }

    #[test]
    fn it_can_neither_vanish_nor_take_the_whole_window() {
        assert_eq!(width_after_drag(99, 100), MIN_WIDTH);
        assert_eq!(width_after_drag(0, 100), 70);
    }

    #[test]
    fn on_a_narrow_window_the_minimum_still_wins() {
        // 70% of 20 is 14, under MIN_WIDTH: clamp must not invert its bounds.
        assert_eq!(width_after_drag(1, 20), MIN_WIDTH);
    }

    #[test]
    fn folding_and_unfolding_returns_the_width_it_had() {
        let mut restored = DEFAULT_WIDTH;
        let folded = toggle(80, &mut restored);

        assert_eq!(folded, COLLAPSED_WIDTH);
        assert_eq!(toggle(folded, &mut restored), 80, "vuelve a 80, no al ancho por defecto");
    }

    #[test]
    fn the_chevron_is_clickable_on_the_top_row_only() {
        assert!(grabs_chevron(40, 0, 40));
        assert!(!grabs_chevron(40, 3, 40), "eso ya es el cuerpo");
    }
}
