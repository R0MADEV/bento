//! El raíl izquierdo visto desde el ratón: plegar, arrastrar el divisor y
//! elegir fila. Lo comparten la lista de terminales y la review, y estaba en
//! `mod.rs`, que se pasaba del presupuesto de tamaño.

use crossterm::event::{MouseButton, MouseEventKind};

use super::sidebar;

/// The rail's mouse behaviour, borrowed rather than owned so both the list
/// and the attached view drive the same one: connected, the rail is still
/// there and must still fold, resize and select.
pub(super) struct RailMouse<'a> {
    pub(super) width: &'a mut u16,
    pub(super) restored: &'a mut u16,
    pub(super) dragging: &'a mut bool,
    pub(super) total: u16,
    pub(super) height: u16,
    pub(super) rows: usize,
    /// Lines of fixed context the rail paints above its rows. Ignoring it made
    /// every click in Review land on the wrong row (or on none).
    pub(super) header_lines: u16,
}

/// What a click on the rail asked for. The action is whatever the panel
/// pinned to the bottom of its rail — a new agent, a review run.
pub(super) enum RailClick {
    Select(usize),
    Action,
}

impl RailMouse<'_> {
    /// Returns what the click asked for, if anything.
    pub(super) fn handle(self, mouse: crossterm::event::MouseEvent) -> Option<RailClick> {
        let on_chevron = mouse.row == 0 && mouse.column + 2 >= *self.width && mouse.column < *self.width;
        match mouse.kind {
            // The chevron sits on the rail's top-right corner; clicking it
            // folds and unfolds.
            MouseEventKind::Down(MouseButton::Left) if on_chevron => {
                *self.width = toggle_sidebar(*self.width, self.restored);
            }
            MouseEventKind::Down(MouseButton::Left) => {
                // The divider wins over the row underneath it: it overlaps the
                // rail's last column, and a resize misread as a selection
                // would swap terminals on every drag.
                *self.dragging = sidebar::grabs_divider(mouse.column, *self.width);
                if *self.dragging {
                    return None;
                }
                if sidebar::grabs_action(mouse.column, mouse.row, *self.width, self.height) {
                    return Some(RailClick::Action);
                }
                return sidebar::item_at_with_header(
                    mouse.column, mouse.row, *self.width, self.rows, self.header_lines,
                )
                .map(RailClick::Select);
            }
            MouseEventKind::Drag(MouseButton::Left) if *self.dragging => {
                *self.width = sidebar::width_after_drag(mouse.column, self.total);
            }
            MouseEventKind::Up(MouseButton::Left) => *self.dragging = false,
            _ => {}
        }
        None
    }
}

/// Folds the rail away, or unfolds it back to the width it had before —
/// remembered in `restored`, so a rail the user widened does not come back
/// as the default.
pub(super) fn toggle_sidebar(current: u16, restored: &mut u16) -> u16 {
    if current > sidebar::COLLAPSED_WIDTH {
        *restored = current;
        return sidebar::COLLAPSED_WIDTH;
    }
    *restored
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folding_and_unfolding_returns_the_width_the_user_had_chosen() {
        let mut restored = sidebar::DEFAULT_WIDTH;

        let collapsed = toggle_sidebar(40, &mut restored);
        assert_eq!(collapsed, sidebar::COLLAPSED_WIDTH);
        assert_eq!(toggle_sidebar(collapsed, &mut restored), 40, "vuelve a 40, no al ancho por defecto");
    }

    #[test]
    fn folding_twice_does_not_lose_the_remembered_width() {
        // Collapsing an already-collapsed rail must not record the stub as the
        // width to restore, which would leave it stuck folded.
        let mut restored = 40;

        let once = toggle_sidebar(sidebar::COLLAPSED_WIDTH, &mut restored);
        assert_eq!(once, 40);
        assert_eq!(restored, 40);
    }
}
