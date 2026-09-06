//! Resaltado del código dentro del diff.
//!
//! Con `syntect`, las mismas definiciones que usa Sublime: reconoce el
//! lenguaje de verdad en vez de buscar palabras en una lista, así que
//! distingue un tipo de una función y cubre las decenas de lenguajes que trae
//! —JSON, CSS, Markdown, SQL, YAML…—, no los cuatro que teníamos a mano.
//!
//! Las sintaxis y el tema se cargan una vez: hacerlo por línea cuesta cientos
//! de milisegundos, y esto se pinta en cada frame.

use std::sync::OnceLock;

use ratatui::style::Color;
use syntect::easy::HighlightLines;
use syntect::highlighting::{Theme, ThemeSet};
use syntect::parsing::SyntaxSet;

struct Syntaxes {
    set: SyntaxSet,
    theme: Theme,
}

fn syntaxes() -> &'static Syntaxes {
    static SYNTAXES: OnceLock<Syntaxes> = OnceLock::new();
    SYNTAXES.get_or_init(|| Syntaxes {
        set: SyntaxSet::load_defaults_newlines(),
        // Oscuro y de contraste suave, para que el resaltado no compita con
        // el verde y el rojo del diff, que son los que dicen qué cambió.
        theme: ThemeSet::load_defaults().themes["base16-ocean.dark"].clone(),
    })
}

/// El código partido en trozos con su color. Un lenguaje que `syntect` no
/// conozca sale de una pieza y sin color, que es mejor que pintarlo mal.
pub(super) fn tokens(code: &str, path: &str) -> Vec<(Option<Color>, String)> {
    let Syntaxes { set, theme } = syntaxes();
    let extension = path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    let Some(syntax) = set.find_syntax_by_extension(extension) else {
        return vec![(None, code.to_string())];
    };
    let mut lines = HighlightLines::new(syntax, theme);
    match lines.highlight_line(code, set) {
        Ok(pieces) => pieces
            .into_iter()
            .map(|(style, text)| {
                let color = style.foreground;
                (Some(Color::Rgb(color.r, color.g, color.b)), text.to_string())
            })
            .collect(),
        Err(_) => vec![(None, code.to_string())],
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_keyword_and_a_string_get_different_colours() {
        let out = super::tokens(r#"let s = "hola";"#, "a.rs");
        let colours: std::collections::HashSet<_> = out.iter().map(|(c, _)| *c).collect();

        assert!(colours.len() > 2, "keyword, texto y cadena no pueden ser el mismo color: {out:?}");
        assert_eq!(out.iter().map(|(_, t)| t.as_str()).collect::<String>(), r#"let s = "hola";"#);
    }

    #[test]
    fn a_language_the_old_table_did_not_have_is_highlighted_too() {
        // Un JSON, un CSS o un YAML salían en plano con la tabla de cuatro
        // lenguajes escrita a mano.
        let out = super::tokens(r#"{"clave": 1}"#, "paquete.json");

        assert!(out.len() > 1, "{out:?}");
    }

    #[test]
    fn an_unknown_extension_comes_back_whole_and_plain() {
        assert_eq!(super::tokens("cualquier cosa", "notas.xyz"), vec![(None, "cualquier cosa".to_string())]);
    }

    #[test]
    fn the_text_survives_the_highlighting() {
        // Perder un carácter al colorear es peor que no colorear.
        let code = "  const x = obj?.[k] ?? `a${b}`; // fin";
        let out: String = super::tokens(code, "a.ts").iter().map(|(_, t)| t.as_str()).collect();

        assert_eq!(out, code);
    }
}
