//! Copiar al portapapeles desde el terminal.

/// Qué se copia de la fila marcada.
#[derive(Clone, Copy)]
pub(super) enum Copy {
    Diff,
    Path,
}

/// Lo escribe de verdad. Va a la salida a mano y no por ratatui: es una orden
/// al emulador, no algo que se pinte.
pub(super) fn copy_to_clipboard(text: &str) -> bool {
    use std::io::Write;

    let mut out = std::io::stdout();
    out.write_all(clipboard_sequence(text).as_bytes()).is_ok() && out.flush().is_ok()
}

/// Lo que hay que escribir en el terminal para dejar algo en el portapapeles.
/// Un programa de terminal no tiene portapapeles propio: se lo pide al emulador
/// con un OSC 52, que además viaja por SSH — `pbcopy` sólo valdría en la
/// máquina de al lado.
fn clipboard_sequence(text: &str) -> String {
    format!("\u{1b}]52;c;{}\u{1b}\\", base64(text.as_bytes()))
}

/// Base64 sin dependencias: son doce líneas y sólo hace falta para lo de
/// arriba.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let bits = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | u32::from(*b) << (16 - 8 * i));
        for i in 0..4 {
            // Los grupos que el trozo no llena van con el relleno de siempre.
            let full = i <= chunk.len();
            out.push(match full {
                true => ALPHABET[(bits >> (18 - 6 * i)) as usize & 0b11_1111] as char,
                false => '=',
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_clipboard_goes_through_the_terminal_itself() {
        // Un terminal no tiene portapapeles: se le pide al emulador con una
        // secuencia OSC 52, que además viaja por SSH — `pbcopy` sólo valdría
        // en la máquina de al lado.
        let sequence = super::clipboard_sequence("hola");

        assert!(sequence.starts_with("\u{1b}]52;c;"), "{sequence:?}");
        assert!(sequence.ends_with("\u{1b}\\"), "{sequence:?}");
        assert!(sequence.contains("aG9sYQ=="), "el texto en base64: {sequence:?}");
    }
}
