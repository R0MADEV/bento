//! The left rail every panel shares: a titled section, its selectable rows
//! (each a label over a dimmed detail, with a status dot) and an optional
//! action pinned to the bottom. Panels own their data; this owns the look.

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Paragraph};

/// The dot in front of a row. Panels map their own domain onto these three
/// so the rail reads the same everywhere.
//
// Only Active has a caller today: `terminals.list` reports id/title/cwd and
// no activity, so there is nothing truthful to paint the other two from yet.
// They stay because the rail's vocabulary is the same for every panel, and
// the ones still to come (tasks, review) do distinguish idle from failed.
#[allow(dead_code)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ItemStatus {
    Active,
    Idle,
    Error,
}

pub(crate) struct SidebarItem {
    pub(crate) label: String,
    pub(crate) detail: String,
    pub(crate) status: ItemStatus,
}

pub(crate) struct Sidebar<'a> {
    pub(crate) title: &'a str,
    pub(crate) items: &'a [SidebarItem],
    pub(crate) selected: usize,
    /// Pinned to the bottom, e.g. "+ Nuevo agente". None hides the row.
    pub(crate) action: Option<&'a str>,
    pub(crate) empty_message: &'a str,
    /// Fixed lines above the list — the context a panel needs on screen at
    /// all times (Review's project, base and agent). Empty for a plain rail.
    pub(crate) header: &'a [Line<'a>],
    /// Tints the border when this rail has the keyboard.
    pub(crate) focused: bool,
}

impl<'a> Sidebar<'a> {
    /// A rail with nothing but a list, which is what most panels want.
    pub(crate) fn new(title: &'a str, items: &'a [SidebarItem], selected: usize) -> Self {
        Self { title, items, selected, action: None, empty_message: "", header: &[], focused: false }
    }
}

/// Each row is the label over its detail, so the list advances two rows at a
/// time and the action's height has to be reserved up front.
const ROWS_PER_ITEM: u16 = 2;
const ACTION_HEIGHT: u16 = 3;

const DIM: Style = Style::new().fg(Color::DarkGray);
const SELECTED: Style = Style::new().bg(Color::Indexed(236));
/// Matches the pane's focused border, so both halves agree on what focus
/// looks like.
const FOCUSED: Style = Style::new().fg(Color::Indexed(4));

impl ItemStatus {
    fn dot(self) -> Span<'static> {
        let color = match self {
            ItemStatus::Active => Color::Green,
            ItemStatus::Idle => Color::DarkGray,
            ItemStatus::Error => Color::Red,
        };
        Span::styled("●", Style::new().fg(color))
    }
}

impl Sidebar<'_> {
    pub(crate) fn render(&self, frame: &mut ratatui::Frame, area: Rect) {
        // No room for the action's own box once collapsed, and half a button
        // reads as a glitch.
        let action_height = if self.action.is_some() && area.width > COLLAPSED_WIDTH { ACTION_HEIGHT } else { 0 };
        let rows = Layout::vertical([Constraint::Min(1), Constraint::Length(action_height)]).split(area);

        let collapsed = area.width <= COLLAPSED_WIDTH;
        // Collapsed, the chevron points the way back out; expanded, it points
        // at the edge it will fold into.
        let chevron = if collapsed { "›" } else { "‹" };
        let block = Block::default()
            .title(Line::from(Span::styled(
                if collapsed { "" } else { self.title },
                Style::new().add_modifier(Modifier::BOLD),
            )))
            .title_top(Line::from(Span::styled(chevron, DIM)).right_aligned())
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(if self.focused { FOCUSED } else { DIM });
        let inner = block.inner(rows[0]);
        frame.render_widget(block, rows[0]);
        if collapsed {
            return;
        }
        // The header is fixed context, so it takes its rows off the top and
        // the list gets what is left.
        let split = Layout::vertical([
            Constraint::Length(self.header.len() as u16),
            Constraint::Min(0),
        ])
        .split(inner);
        if !self.header.is_empty() {
            frame.render_widget(Paragraph::new(self.header.to_vec()), split[0]);
        }
        self.render_items(frame, split[1]);

        if let Some(action) = self.action {
            let button = Paragraph::new(Line::from(Span::styled(action, DIM))).block(
                Block::default().borders(Borders::ALL).border_type(BorderType::Rounded).border_style(DIM),
            );
            frame.render_widget(button, rows[1]);
        }
    }

    fn render_items(&self, frame: &mut ratatui::Frame, area: Rect) {
        if self.items.is_empty() {
            frame.render_widget(Paragraph::new(Line::from(Span::styled(self.empty_message, DIM))), area);
            return;
        }
        // Painted row by row rather than as a List: a row is two lines tall and
        // the selection has to tint both, which a ListItem highlight cannot do
        // without also tinting the gap between rows.
        for (index, item) in self.items.iter().enumerate() {
            let top = area.y + index as u16 * ROWS_PER_ITEM;
            if top + ROWS_PER_ITEM > area.y + area.height {
                break;
            }
            let row = Rect { x: area.x, y: top, width: area.width, height: ROWS_PER_ITEM };
            let style = if index == self.selected { SELECTED } else { Style::default() };
            let lines = vec![
                Line::from(vec![item.status.dot(), Span::raw(" "), Span::raw(item.label.as_str())]),
                Line::from(vec![Span::raw("  "), Span::styled(item.detail.as_str(), DIM)]),
            ];
            frame.render_widget(Paragraph::new(lines).style(style), row);
        }
    }
}

/// Default width: fits "+ Nuevo agente" plus the rail's borders.
pub(crate) const DEFAULT_WIDTH: u16 = 24;
/// Collapsed still leaves a stub: a rail that vanishes entirely gives the user
/// nothing to click to bring it back.
pub(crate) const COLLAPSED_WIDTH: u16 = 3;
/// Narrower than this and the labels stop being readable; wider and the rail
/// starts eating the panel it is meant to serve.
const MIN_WIDTH: u16 = 14;
const MAX_WIDTH_PERCENT: u16 = 50;

/// Whether a click at `column` grabbed the rail's right edge. One column of
/// slack on each side: the divider is a single cell and hitting it exactly
/// with a mouse is needlessly fussy.
pub(crate) fn grabs_divider(column: u16, width: u16) -> bool {
    let divider = width.saturating_sub(1);
    column + 1 >= divider && column <= divider + 1
}

/// Whether a click landed on the action pinned to the rail's bottom. It is
/// not painted on a collapsed rail, so it must not answer there either.
pub(crate) fn grabs_action(column: u16, row: u16, width: u16, height: u16) -> bool {
    // Below this the list's own Min(1) wins the layout and the button is
    // squeezed out, so there is nothing there to click.
    if column >= width || width <= COLLAPSED_WIDTH || height <= ACTION_HEIGHT {
        return false;
    }
    row >= height - ACTION_HEIGHT && row < height
}

/// Which row a click at (`column`, `row`) landed on, if any. Rows are two
/// lines tall and start below the block's top border and the `header_lines`
/// of fixed context above them, so this has to mirror what `render` paints —
/// a click that selects a different row than the one under the pointer is
/// worse than no click at all.
pub(crate) fn item_at_with_header(
    column: u16,
    row: u16,
    width: u16,
    count: usize,
    header_lines: u16,
) -> Option<usize> {
    if column >= width || width <= COLLAPSED_WIDTH {
        return None;
    }
    // Row 0 is the block's border; the header sits directly under it.
    let first_row = 1 + header_lines;
    if row < first_row {
        return None;
    }
    let index = ((row - first_row) / ROWS_PER_ITEM) as usize;
    (index < count).then_some(index)
}

/// The rail's width after dragging its divider to `column`, clamped so it can
/// neither vanish nor take over the screen.
pub(crate) fn width_after_drag(column: u16, total_width: u16) -> u16 {
    let max = (total_width * MAX_WIDTH_PERCENT / 100).max(MIN_WIDTH);
    (column + 1).clamp(MIN_WIDTH, max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn item(label: &str, detail: &str, status: ItemStatus) -> SidebarItem {
        SidebarItem { label: label.into(), detail: detail.into(), status }
    }

    /// Renders the rail on its own and returns the screen as text lines, so a
    /// test can assert on what is actually painted.
    fn render(sidebar: &Sidebar, width: u16, height: u16) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| sidebar.render(frame, frame.area())).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..height)
            .map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect())
            .collect()
    }

    #[test]
    fn shows_the_section_title() {
        let items = [item("Agent 1", "~", ItemStatus::Active)];
        let sidebar = Sidebar::new("TERMINAL", &items, 0);

        assert!(render(&sidebar, 20, 10).join("\n").contains("TERMINAL"));
    }

    #[test]
    fn shows_each_item_over_its_detail() {
        let items = [item("Agent 1", "~/proyecto", ItemStatus::Active)];
        let sidebar = Sidebar::new("TERMINAL", &items, 0);

        let screen = render(&sidebar, 24, 10);
        let label_row = screen.iter().position(|line| line.contains("Agent 1")).expect("falta el label");
        assert!(screen[label_row + 1].contains("~/proyecto"), "el detalle va justo debajo del label");
    }

    #[test]
    fn marks_the_selected_item_and_only_that_one() {
        let items = [
            item("Agent 1", "~", ItemStatus::Active),
            item("Agent 2", "~", ItemStatus::Idle),
        ];
        let sidebar = Sidebar::new("TERMINAL", &items, 1);

        let mut terminal = Terminal::new(TestBackend::new(24, 10)).unwrap();
        terminal.draw(|frame| sidebar.render(frame, frame.area())).unwrap();
        let buffer = terminal.backend().buffer().clone();

        let row_of = |needle: &str| {
            (0..10u16)
                .find(|y| (0..24u16).map(|x| buffer[(x, *y)].symbol().to_string()).collect::<String>().contains(needle))
                .expect("fila no encontrada")
        };
        let background = |y: u16| buffer[(2u16, y)].style().bg;
        assert_ne!(background(row_of("Agent 2")), background(row_of("Agent 1")));
    }

    #[test]
    fn pins_the_action_to_the_bottom() {
        let items = [item("Agent 1", "~", ItemStatus::Active)];
        let sidebar = Sidebar { action: Some("+ Nuevo agente"), ..Sidebar::new("TERMINAL", &items, 0) };

        let screen = render(&sidebar, 24, 12);
        let action_row = screen.iter().position(|line| line.contains("+ Nuevo agente")).expect("falta la acción");
        let item_row = screen.iter().position(|line| line.contains("Agent 1")).unwrap();
        assert!(action_row > item_row, "la acción va debajo de la lista");
        assert!(action_row >= 12 - 3, "la acción va pegada al fondo, no flotando tras la lista");
    }

    #[test]
    fn falls_back_to_the_empty_message_with_no_items() {
        let sidebar = Sidebar { empty_message: "No hay agentes", ..Sidebar::new("TERMINAL", &[], 0) };

        assert!(render(&sidebar, 24, 10).join("\n").contains("No hay agentes"));
    }

    #[test]
    fn a_selection_past_the_end_does_not_panic() {
        let items = [item("Agent 1", "~", ItemStatus::Active)];
        let sidebar = Sidebar::new("TERMINAL", &items, 9);

        assert!(render(&sidebar, 24, 10).join("\n").contains("Agent 1"));
    }

    #[test]
    fn the_divider_is_grabbable_with_a_column_of_slack_on_each_side() {
        // Width 24 → the border sits on column 23.
        assert!(grabs_divider(23, 24));
        assert!(grabs_divider(22, 24));
        assert!(grabs_divider(24, 24));
    }

    #[test]
    fn a_click_inside_the_rail_or_deep_in_the_panel_does_not_grab_it() {
        assert!(!grabs_divider(5, 24));
        assert!(!grabs_divider(40, 24));
    }

    #[test]
    fn dragging_sets_the_width_to_the_column_the_divider_landed_on() {
        assert_eq!(width_after_drag(29, 100), 30);
    }

    #[test]
    fn the_rail_can_neither_vanish_nor_take_over_the_screen() {
        assert_eq!(width_after_drag(0, 100), MIN_WIDTH);
        assert_eq!(width_after_drag(99, 100), 50);
    }

    #[test]
    fn on_a_narrow_terminal_the_minimum_still_wins_over_the_percentage() {
        // 50% of 20 is 10, below MIN_WIDTH: clamp must not invert its bounds
        // and panic.
        assert_eq!(width_after_drag(18, 20), MIN_WIDTH);
    }

    #[test]
    fn a_click_picks_the_row_it_landed_on() {
        // Rows are two lines tall and start below the block's top border, so
        // row 1-2 is the first item and 3-4 the second.
        assert_eq!(item_at_with_header(5, 1, 24, 3, 0), Some(0));
        assert_eq!(item_at_with_header(5, 2, 24, 3, 0), Some(0), "el detalle también selecciona su fila");
        assert_eq!(item_at_with_header(5, 3, 24, 3, 0), Some(1));
        assert_eq!(item_at_with_header(5, 4, 24, 3, 0), Some(1));
    }

    #[test]
    fn a_header_is_painted_above_the_rows() {
        let items = [item("Agent 1", "~", ItemStatus::Active)];
        let header = [Line::from("Proyecto: bento"), Line::from("Base: main")];
        let sidebar = Sidebar { header: &header, ..Sidebar::new("REVIEW", &items, 0) };

        let screen = render(&sidebar, 30, 12);
        let header_row = screen.iter().position(|l| l.contains("Proyecto: bento")).expect("falta el header");
        let item_row = screen.iter().position(|l| l.contains("Agent 1")).expect("falta la fila");
        assert!(header_row < item_row);
    }

    #[test]
    fn a_click_still_picks_the_right_row_under_a_header() {
        // The header pushes the rows down; if item_at ignored it, every click
        // would select a row above the one being pointed at.
        assert_eq!(item_at_with_header(5, 1, 24, 3, 2), None, "eso es el header");
        assert_eq!(item_at_with_header(5, 3, 24, 3, 2), Some(0));
        assert_eq!(item_at_with_header(5, 5, 24, 3, 2), Some(1));
    }

    #[test]
    fn the_action_button_is_clickable_along_its_whole_box() {
        // It is pinned to the bottom ACTION_HEIGHT rows of a 20-row rail.
        assert!(grabs_action(5, 17, 24, 20));
        assert!(grabs_action(5, 19, 24, 20));
    }

    #[test]
    fn a_click_above_the_action_box_is_not_the_action() {
        assert!(!grabs_action(5, 16, 24, 20));
    }

    #[test]
    fn a_collapsed_rail_has_no_action_to_click() {
        // It is not painted when collapsed, so it must not be clickable
        // either — an invisible button that works is worse than none.
        assert!(!grabs_action(1, 19, COLLAPSED_WIDTH, 20));
    }

    #[test]
    fn a_click_outside_the_rail_is_not_the_action() {
        assert!(!grabs_action(30, 19, 24, 20));
    }

    #[test]
    fn a_rail_shorter_than_its_own_action_box_does_not_underflow() {
        assert!(!grabs_action(5, 0, 24, 2));
    }

    #[test]
    fn a_click_on_the_border_or_past_the_last_row_selects_nothing() {
        assert_eq!(item_at_with_header(5, 0, 24, 3, 0), None, "la fila 0 es el borde");
        assert_eq!(item_at_with_header(5, 9, 24, 3, 0), None, "más allá del último item");
    }

    #[test]
    fn a_click_outside_the_rail_is_not_a_row_click() {
        assert_eq!(item_at_with_header(30, 1, 24, 3, 0), None);
    }

    #[test]
    fn a_collapsed_rail_has_no_rows_to_click() {
        assert_eq!(item_at_with_header(1, 1, COLLAPSED_WIDTH, 3, 0), None);
    }

    #[test]
    fn collapsing_leaves_a_stub_the_user_can_still_click_to_get_back() {
        assert_eq!(COLLAPSED_WIDTH, 3, "colapsado no es lo mismo que desaparecido");
        assert!(grabs_divider(COLLAPSED_WIDTH - 1, COLLAPSED_WIDTH));
    }

    #[test]
    fn a_collapsed_rail_shows_the_title_but_not_the_rows() {
        let items = [item("Agent 1", "~", ItemStatus::Active)];
        let sidebar = Sidebar::new("TERMINAL", &items, 0);

        let screen = render(&sidebar, COLLAPSED_WIDTH, 10).join("\n");
        assert!(!screen.contains("Agent 1"), "no cabe una fila en 3 columnas: no se pinta a medias");
    }

    #[test]
    fn dragging_a_collapsed_rail_open_restores_a_usable_width() {
        // Dragging out from the stub must land on something readable rather
        // than the 3-column stub plus one.
        assert_eq!(width_after_drag(1, 100), MIN_WIDTH);
    }
}
