//! Resaltado del código dentro del diff: las mismas palabras y el mismo
//! recorrido que el del escritorio (`reviewFormat.ts`), para que un fichero se
//! lea igual en los dos. Sin librería: son cuatro cosas —comentario, cadena,
//! número y palabra reservada— y una tabla por lenguaje.

/// Qué es cada trozo de una línea. Lo demás es texto corriente.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) enum Token {
    Keyword,
    Str,
    Number,
    Comment,
    Plain,
}

const TS: &str = "const let var function return if else for while class import export from default async await new this typeof null undefined true false void type interface enum extends implements public private protected readonly static abstract switch case break continue try catch finally throw delete in of instanceof";
const RS: &str = "fn let mut const struct enum impl trait use pub mod return if else for while match Some None Ok Err true false self Self super crate async await move where type ref loop break continue";
const PY: &str = "def class return if else elif for while import from as with in not and or is None True False pass break continue try except finally raise yield async await lambda global nonlocal";
const GO: &str = "func var const return if else for range go select case default break continue type struct interface import package nil true false defer make new len cap chan map switch";

/// Las palabras del lenguaje de ese fichero, y con qué empieza un comentario.
/// Una extensión que no está en la tabla se pinta sin colores, que es mejor
/// que pintarla con las palabras de otro lenguaje.
fn language_of(path: &str) -> Option<(&'static str, &'static str)> {
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_lowercase())?;
    match ext.as_str() {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => Some((TS, "//")),
        "rs" => Some((RS, "//")),
        "py" => Some((PY, "#")),
        "go" => Some((GO, "//")),
        _ => None,
    }
}

/// Parte una línea de código en trozos con su color. Mismo recorrido que el
/// del escritorio: comentario hasta el final, cadena hasta su comilla —con
/// escapes—, número, palabra, y lo que quede tal cual.
pub(super) fn tokens(code: &str, path: &str) -> Vec<(Token, String)> {
    let Some((words, comment)) = language_of(path) else {
        return vec![(Token::Plain, code.to_string())];
    };
    let keywords: Vec<&str> = words.split(' ').collect();
    let chars: Vec<char> = code.chars().collect();
    let mut out: Vec<(Token, String)> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let rest: String = chars[i..].iter().collect();
        if rest.starts_with(comment) {
            out.push((Token::Comment, rest));
            break;
        }
        let c = chars[i];
        if c == '"' || c == '\'' || c == '`' {
            let mut j = i + 1;
            while j < chars.len() {
                if chars[j] == '\\' {
                    j += 2;
                    continue;
                }
                if chars[j] == c {
                    j += 1;
                    break;
                }
                j += 1;
            }
            out.push((Token::Str, chars[i..j.min(chars.len())].iter().collect()));
            i = j;
            continue;
        }
        if c.is_ascii_digit() {
            let mut j = i;
            while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '.' || chars[j] == '_') {
                j += 1;
            }
            out.push((Token::Number, chars[i..j].iter().collect()));
            i = j;
            continue;
        }
        if c.is_alphabetic() || c == '_' || c == '$' {
            let mut j = i;
            while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_' || chars[j] == '$') {
                j += 1;
            }
            let word: String = chars[i..j].iter().collect();
            let kind = match keywords.contains(&word.as_str()) {
                true => Token::Keyword,
                false => Token::Plain,
            };
            out.push((kind, word));
            i = j;
            continue;
        }
        out.push((Token::Plain, c.to_string()));
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::Token::*;

    fn kinds(code: &str, path: &str) -> Vec<(super::Token, String)> {
        super::tokens(code, path)
    }

    #[test]
    fn a_keyword_is_told_apart_from_a_name_that_contains_it() {
        // "iffy" no es un `if`, y pintarlo como tal es peor que no pintar.
        let out = kinds("if iffy", "a.rs");

        assert_eq!(out[0], (Keyword, "if".to_string()));
        assert_eq!(out[2], (Plain, "iffy".to_string()));
    }

    #[test]
    fn a_string_runs_to_its_closing_quote_escapes_included() {
        let out = kinds(r#"let s = "a\"b" ;"#, "a.rs");

        assert!(out.contains(&(Str, r#""a\"b""#.to_string())), "{out:?}");
    }

    #[test]
    fn a_comment_takes_the_rest_of_the_line() {
        let out = kinds("let x = 1; // por qué", "a.rs");

        assert_eq!(out.last().unwrap(), &(Comment, "// por qué".to_string()));
    }

    #[test]
    fn python_comments_start_with_a_hash() {
        assert_eq!(kinds("x = 1  # nota", "a.py").last().unwrap().0, Comment);
        // En Rust una almohadilla es otra cosa, no un comentario.
        assert_ne!(kinds("#[derive(Debug)]", "a.rs")[0].0, Comment);
    }

    #[test]
    fn an_unknown_extension_is_left_alone() {
        // Pintarla con las palabras de otro lenguaje es peor que no pintarla.
        assert_eq!(kinds("fn x", "notas.txt"), vec![(Plain, "fn x".to_string())]);
    }

    #[test]
    fn a_number_is_one_piece() {
        assert_eq!(kinds("= 1_000;", "a.rs")[2], (Number, "1_000".to_string()));
    }
}
