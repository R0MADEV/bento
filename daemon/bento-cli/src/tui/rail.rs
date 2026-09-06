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

/// La rueda, con la cuenta de lo que aún no ha llegado a una fila. Un gesto de
/// trackpad manda decenas de eventos y a fila por evento un roce se lleva media
/// pantalla; así hacen falta varios para mover una, y el sobrante espera al
/// siguiente. Es la misma en los tres paneles a propósito: la rueda tiene que
/// sentirse igual mires lo que mires.
#[derive(Default)]
pub(super) struct Wheel {
    pending: i16,
}

impl Wheel {
    /// Cuántas filas pide mover este evento, si es que ya llega a una.
    pub(super) fn step(&mut self, mouse: crossterm::event::MouseEvent) -> Option<i16> {
        /// Eventos por fila. A uno, un gesto de trackpad se lleva media
        /// pantalla; a tres se queda corto y hay que insistir. Es el número
        /// que hay que tocar si el desplazamiento no se siente bien.
        const PER_ROW: i16 = 2;

        let direction = match mouse.kind {
            MouseEventKind::ScrollUp => -1,
            MouseEventKind::ScrollDown => 1,
            _ => return None,
        };
        // Al cambiar de sentido se empieza de cero: lo guardado de bajar
        // restado al subir dejaría el primer roce sin efecto.
        if self.pending.signum() != direction {
            self.pending = 0;
        }
        self.pending += direction;
        if self.pending.abs() < PER_ROW {
            return Some(0).filter(|_| false);
        }
        let rows = self.pending / PER_ROW;
        self.pending -= rows * PER_ROW;
        Some(rows)
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
    use super::*;

    #[test]
    fn a_trackpad_gesture_does_not_run_away_with_the_list() {
        // Un gesto de trackpad manda decenas de eventos: a una fila cada uno,
        // un roce se lleva media pantalla. Hacen falta unos cuantos para
        // mover una fila, y el resto se guarda para el siguiente.
        use crossterm::event::{MouseEvent, MouseEventKind};
        let at = |kind| MouseEvent { kind, column: 0, row: 0, modifiers: crossterm::event::KeyModifiers::NONE };
        let mut wheel = super::Wheel::default();

        let moved: i16 = (0..8).filter_map(|_| wheel.step(at(MouseEventKind::ScrollDown))).sum();

        assert_eq!(moved, 4, "ocho eventos, cuatro filas");
    }

    #[test]
    fn changing_direction_does_not_carry_the_leftovers() {
        // Lo guardado de bajar no puede restarse al empezar a subir: el
        // primer roce hacia arriba se quedaría quieto.
        use crossterm::event::{MouseEvent, MouseEventKind};
        let at = |kind| MouseEvent { kind, column: 0, row: 0, modifiers: crossterm::event::KeyModifiers::NONE };
        let mut wheel = super::Wheel::default();

        let _ = wheel.step(at(MouseEventKind::ScrollDown));
        let up: Vec<i16> = (0..2).filter_map(|_| wheel.step(at(MouseEventKind::ScrollUp))).collect();

        assert_eq!(up, vec![-1], "los dos primeros hacia arriba mueven una fila");
    }

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
