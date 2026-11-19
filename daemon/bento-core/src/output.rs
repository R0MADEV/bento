//! A terminal's output stream as bytes come off the PTY: decoding reads that
//! split a character, and the bounded scrollback a reattaching client replays.

use std::sync::{Arc, Mutex};

// Recent output kept per terminal so a reattaching client sees context.
pub(crate) const SCROLLBACK_CAP: usize = 256 * 1024;

pub(crate) fn push_scrollback(buffer: &Arc<Mutex<Vec<u8>>>, data: &[u8]) {
    let mut guard = buffer.lock().unwrap();
    guard.extend_from_slice(data);
    let overflow = guard.len().saturating_sub(SCROLLBACK_CAP);
    if overflow == 0 {
        return;
    }
    let cut = resync_offset(&guard, overflow);
    guard.drain(0..cut);
}

/// Moves a scrollback cut forward to the next escape sequence or line, so a
/// reattaching client never starts reading halfway through one. Cutting on a
/// byte count alone leaves the tail of a sequence, which the terminal prints
/// as text ("25l") and which also splits multi-byte characters.
fn resync_offset(buffer: &[u8], from: usize) -> usize {
    // Bounded so a screenful of plain text can't push the cut far past the cap.
    const WINDOW: usize = 8 * 1024;
    let end = (from + WINDOW).min(buffer.len());
    for (offset, byte) in buffer[from..end].iter().enumerate() {
        match byte {
            0x1b => return from + offset,
            b'\n' => return from + offset + 1,
            _ => {}
        }
    }
    from
}

/// Drains as much valid UTF-8 as possible from `pending`, keeping any incomplete
/// trailing multi-byte sequence for the next read (PTY reads can split a glyph
/// across the buffer boundary).
pub(crate) fn drain_utf8(pending: &mut Vec<u8>) -> String {
    let valid = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(e) if e.valid_up_to() == 0 && e.error_len().is_some() => {
            pending.remove(0);
            0
        }
        Err(e) => e.valid_up_to(),
    };
    let rest = pending.split_off(valid);
    String::from_utf8(std::mem::replace(pending, rest)).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    // A reattaching client replays the scrollback verbatim, so a cut in the
    // middle of an escape sequence makes it print the tail as text ("?25h").
    #[test]
    fn scrollback_overflow_cuts_between_escape_sequences() {
        let mut full = Vec::from(&b"\x1b[?25l\x1b[2J"[..]);
        full.resize(SCROLLBACK_CAP, b'A');
        let buffer = Arc::new(Mutex::new(full));

        // Overflows by 3: a plain byte count cuts inside "\x1b[?25l".
        push_scrollback(&buffer, b"xyz");

        let kept = buffer.lock().unwrap().clone();
        assert!(kept.len() <= SCROLLBACK_CAP);
        assert!(
            kept.starts_with(b"\x1b[2J"),
            "kept starts mid-sequence: {:?}",
            String::from_utf8_lossy(&kept[..8.min(kept.len())]),
        );
    }

    #[test]
    fn drain_utf8_keeps_split_multibyte() {
        let mut p = vec![0xE2, 0x94];
        assert_eq!(drain_utf8(&mut p), "");
        assert_eq!(p, vec![0xE2, 0x94]);
        p.push(0x80);
        assert_eq!(drain_utf8(&mut p), "─");
        assert!(p.is_empty());
    }
}
