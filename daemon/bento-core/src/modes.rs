//! The modes a program switched on in its terminal: mouse reporting, the
//! alternate screen, bracketed paste… A client that attaches later only gets
//! the last stretch of output replayed, and the switch is rarely in it — a
//! full-screen program repaints so much that it has long scrolled out. Without
//! it the client draws the program but, for example, never sends it a click.

use std::collections::BTreeMap;

/// The modes worth restoring, with whether a fresh terminal has them on.
const TRACKED: [(u16, bool); 15] = [
    (1, false),    // application cursor keys
    (7, true),     // autowrap
    (25, true),    // cursor visible
    (47, false),   // alternate screen (old)
    (1000, false), // mouse: clicks
    (1002, false), // mouse: drag
    (1003, false), // mouse: any motion
    (1004, false), // focus events
    (1005, false), // mouse: UTF-8 coordinates
    (1006, false), // mouse: SGR coordinates
    (1015, false), // mouse: urxvt coordinates
    (1016, false), // mouse: pixel coordinates
    (1047, false), // alternate screen
    (1049, false), // alternate screen, saving the cursor
    (2004, false), // bracketed paste
];

/// Longest `ESC [ ? … h` parameter list worth following; anything longer is
/// not a mode switch.
const MAX_PARAMS: usize = 64;

#[derive(Default)]
enum Parser {
    #[default]
    Ground,
    Escape,
    Csi,
    /// Inside `ESC [ ?`, with the parameters read so far.
    Private(String),
}

/// Follows a terminal's output and remembers which modes are switched on.
#[derive(Default)]
pub(crate) struct Modes {
    on: BTreeMap<u16, bool>,
    parser: Parser,
}

impl Modes {
    /// Output arrives in arbitrary chunks, so a sequence may be cut between two.
    pub(crate) fn feed(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.parser = match (std::mem::take(&mut self.parser), byte) {
                (_, 0x1b) => Parser::Escape,
                (Parser::Escape, b'[') => Parser::Csi,
                (Parser::Csi, b'?') => Parser::Private(String::new()),
                (Parser::Private(mut params), b'0'..=b'9' | b';') if params.len() < MAX_PARAMS => {
                    params.push(char::from(byte));
                    Parser::Private(params)
                }
                (Parser::Private(params), b'h' | b'l') => {
                    self.switch(&params, byte == b'h');
                    Parser::Ground
                }
                _ => Parser::Ground,
            };
        }
    }

    fn switch(&mut self, params: &str, on: bool) {
        for mode in params.split(';').filter_map(|param| param.parse::<u16>().ok()) {
            let is_tracked = TRACKED.iter().any(|(tracked, _)| *tracked == mode);
            if is_tracked {
                self.on.insert(mode, on);
            }
        }
    }

    /// The sequences that put a fresh terminal in the modes this one is in.
    pub(crate) fn restore(&self) -> String {
        TRACKED
            .iter()
            .filter_map(|(mode, default)| {
                let on = *self.on.get(mode)?;
                (on != *default).then(|| format!("\x1b[?{mode}{}", if on { 'h' } else { 'l' }))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn after(chunks: &[&str]) -> String {
        let mut modes = Modes::default();
        for chunk in chunks {
            modes.feed(chunk.as_bytes());
        }
        modes.restore()
    }

    #[test]
    fn a_terminal_nobody_touched_needs_nothing_restored() {
        assert_eq!(after(&["hola\r\n"]), "");
    }

    #[test]
    fn mouse_reporting_is_restored_for_a_client_that_arrives_later() {
        let restore = after(&["\x1b[?1000h\x1b[?1006h"]);
        assert!(restore.contains("\x1b[?1000h"));
        assert!(restore.contains("\x1b[?1006h"));
    }

    #[test]
    fn several_modes_in_one_sequence_are_all_seen() {
        let restore = after(&["\x1b[?1002;1006;2004h"]);
        assert!(restore.contains("\x1b[?1002h"));
        assert!(restore.contains("\x1b[?1006h"));
        assert!(restore.contains("\x1b[?2004h"));
    }

    #[test]
    fn a_mode_switched_off_again_is_not_restored() {
        assert_eq!(after(&["\x1b[?1000h", "texto", "\x1b[?1000l"]), "");
    }

    // The pty hands output over in arbitrary chunks.
    #[test]
    fn a_sequence_cut_between_two_chunks_still_counts() {
        assert!(after(&["\x1b[?10", "49h"]).contains("\x1b[?1049h"));
        assert!(after(&["\x1b", "[?1049h"]).contains("\x1b[?1049h"));
    }

    // The cursor is visible unless said otherwise: what needs restoring is "off".
    #[test]
    fn a_hidden_cursor_is_restored_as_hidden() {
        assert_eq!(after(&["\x1b[?25l"]), "\x1b[?25l");
        assert_eq!(after(&["\x1b[?25l\x1b[?25h"]), "");
    }

    #[test]
    fn what_is_not_a_mode_a_late_client_needs_is_left_alone() {
        // Synchronized output is per frame, a colour is not a mode at all, and
        // an ordinary (non-private) CSI with the same number means something else.
        assert_eq!(after(&["\x1b[?2026h", "\x1b[31m", "\x1b[1000h"]), "");
    }
}
