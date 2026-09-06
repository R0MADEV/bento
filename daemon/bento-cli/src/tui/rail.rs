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

/// Si una tecla pide salir de la aplicación. Ctrl+C siempre, porque en modo
/// crudo no manda ninguna señal y sin esto no hay forma de salir del panel de
/// review; `q` sólo cuando no estás escribiendo, que si no una q es una q.
pub(super) fn quits(key: crossterm::event::KeyEvent, typing: bool) -> bool {
    use crossterm::event::{KeyCode, KeyModifiers};

    let is_ctrl_c = key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c');
    is_ctrl_c || (!typing && key.code == KeyCode::Char('q'))
}

/// Cuánto pide mover la rueda, si el evento es de rueda: negativo hacia
/// arriba. El paso es el mismo en todas partes a propósito — la rueda tiene
/// que sentirse igual en la review, en la lista de terminales y en el
/// scrollback, y cada panel decide qué mueve con él.
pub(super) fn wheel(mouse: crossterm::event::MouseEvent) -> Option<i16> {
    // Una fila por muesca. Con tres, un gesto de trackpad —que manda decenas
    // de eventos— se comía media pantalla de golpe.
    const STEP: i16 = 1;
    match mouse.kind {
        MouseEventKind::ScrollUp => Some(-STEP),
        MouseEventKind::ScrollDown => Some(STEP),
        _ => None,
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

/// Qué pide una tecla al modo tamaño, si es que le pide algo. Lo mismo en las
/// dos pestañas: entrar y salir, y mover cada borde.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Resize {
    Toggle,
    Exit,
    /// Columnas que crece (o mengua, en negativo) el raíl.
    Rail(i16),
    /// Lo mismo para el informe de la review.
    Drawer(i16),
}

/// Con el modo apagado solo `s` significa algo: las flechas siguen siendo de
/// quien mueve la selección.
pub(super) fn resize_key(key: crossterm::event::KeyEvent, active: bool) -> Option<Resize> {
    use crossterm::event::{KeyCode, KeyEventKind};
    if key.kind != KeyEventKind::Press {
        return None;
    }
    match (key.code, active) {
        (KeyCode::Char('s'), _) => Some(Resize::Toggle),
        (KeyCode::Esc, true) => Some(Resize::Exit),
        (KeyCode::Left, true) => Some(Resize::Rail(-2)),
        (KeyCode::Right, true) => Some(Resize::Rail(2)),
        (KeyCode::Up, true) => Some(Resize::Drawer(2)),
        (KeyCode::Down, true) => Some(Resize::Drawer(-2)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn ctrl_c_gets_you_out_from_anywhere() {
        // En modo crudo Ctrl+C no manda ninguna señal: llega como una tecla
        // más. Sin atenderla, la única salida era volver a la lista y pulsar
        // `q` — y en el panel de review, `c` a secas abre el contexto, así que
        // intentar salir abría un cuadro de texto.
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let ctrl_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);

        assert!(super::quits(ctrl_c, false));
        assert!(super::quits(ctrl_c, true), "también con un cuadro abierto");
    }

    #[test]
    fn q_quits_unless_you_are_writing() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let q = KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE);

        assert!(super::quits(q, false));
        assert!(!super::quits(q, true), "escribiendo, una q es una q");
    }

    #[test]
    fn an_ordinary_c_is_not_a_way_out() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

        assert!(!super::quits(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::NONE), false));
    }

    #[test]
    fn the_wheel_reads_the_same_in_every_panel() {
        // El paso vivía copiado en tres sitios con tres signos distintos; la
        // rueda tiene que sentirse igual en los tres.
        use crossterm::event::{MouseEvent, MouseEventKind};
        let at = |kind| MouseEvent { kind, column: 0, row: 0, modifiers: crossterm::event::KeyModifiers::NONE };

        assert_eq!(super::wheel(at(MouseEventKind::ScrollDown)), Some(1));
        assert_eq!(super::wheel(at(MouseEventKind::ScrollUp)), Some(-1), "arriba es hacia atrás");
        assert_eq!(super::wheel(at(MouseEventKind::Moved)), None, "sólo la rueda");
    }
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

    fn key(code: crossterm::event::KeyCode) -> crossterm::event::KeyEvent {
        crossterm::event::KeyEvent::new(code, crossterm::event::KeyModifiers::NONE)
    }

    #[test]
    fn s_toggles_the_resize_mode_from_either_side() {
        use crossterm::event::KeyCode;
        assert_eq!(resize_key(key(KeyCode::Char('s')), false), Some(Resize::Toggle));
        assert_eq!(resize_key(key(KeyCode::Char('s')), true), Some(Resize::Toggle));
    }

    #[test]
    fn the_arrows_only_move_edges_while_the_mode_is_on() {
        use crossterm::event::KeyCode;
        // Apagado son de quien mueve la selección, que es lo que se espera de
        // ellas en una lista.
        assert_eq!(resize_key(key(KeyCode::Left), false), None);
        assert_eq!(resize_key(key(KeyCode::Left), true), Some(Resize::Rail(-2)));
        assert_eq!(resize_key(key(KeyCode::Up), true), Some(Resize::Drawer(2)));
        assert_eq!(resize_key(key(KeyCode::Esc), true), Some(Resize::Exit));
        assert_eq!(resize_key(key(KeyCode::Esc), false), None);
    }
}
