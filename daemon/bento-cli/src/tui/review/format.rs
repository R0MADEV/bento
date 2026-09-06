
use serde_json::Value;


#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) enum FileFilter {
    All,
    Added,
    Modified,
    Deleted,
}

impl FileFilter {
    pub(super) fn next(self) -> Self {
        match self {
            FileFilter::All => FileFilter::Added,
            FileFilter::Added => FileFilter::Modified,
            FileFilter::Modified => FileFilter::Deleted,
            FileFilter::Deleted => FileFilter::All,
        }
    }

    pub(super) fn label(self) -> &'static str {
        match self {
            FileFilter::All => "All",
            FileFilter::Added => "Added",
            FileFilter::Modified => "Modified",
            FileFilter::Deleted => "Deleted",
        }
    }
}

/// Matches the desktop panel's filter chips: Added = `A`, Deleted = `D`,
/// everything else (M, R, ...) counts as Modified.
pub(super) fn file_matches_filter(status: &str, filter: FileFilter) -> bool {
    match filter {
        FileFilter::All => true,
        FileFilter::Added => status == "A",
        FileFilter::Deleted => status == "D",
        FileFilter::Modified => status != "A" && status != "D",
    }
}

pub(super) fn next_agent(current: &str) -> String {
    bento_review::agents::next_id(current).to_string()
}

/// The same cycle for an optional extra pass, with desktop's "Ninguno" as an
/// extra stop: without it a secondary picked by accident could never be
/// cleared. Wrapping past the last agent lands back on None.
pub(super) fn next_optional_agent(current: Option<&str>) -> Option<String> {
    let ids = bento_review::agents::ids();
    match current {
        None => ids.first().map(|id| id.to_string()),
        Some(current) => {
            let last = ids.last().is_some_and(|id| *id == current);
            (!last).then(|| bento_review::agents::next_id(current).to_string())
        }
    }
}

/// El estado de los checks de CI, en una línea por check. Sin esto había que
/// salir a GitHub para saber si el PR pasaba.
/// Cómo va la CI en una palabra, contando sobre los checks ya formateados:
/// el escritorio pone un `× CI` al lado del título y el detalle a un clic.
pub(super) fn checks_badge(checks: &str) -> String {
    let failed = checks.lines().filter(|l| l.contains('✗')).count();
    match failed {
        0 if checks.trim().is_empty() => "sin CI".to_string(),
        0 => "✓ CI".to_string(),
        n => format!("✗ CI ({n} fallan)"),
    }
}

pub(super) fn format_checks(data: &Value) -> String {
    let checks = data.as_array().map(Vec::as_slice).unwrap_or_default();
    if checks.is_empty() {
        return String::new();
    }
    let mut out = String::from("\n## Checks\n\n");
    for check in checks {
        let name = ["name", "workflowName", "context"]
            .iter()
            .find_map(|key| check.get(*key).and_then(Value::as_str))
            .unwrap_or("check");
        let state = ["conclusion", "state", "status"]
            .iter()
            .find_map(|key| check.get(*key).and_then(Value::as_str))
            .unwrap_or("")
            .to_uppercase();
        // Qué cuenta como fallo o como pendiente lo decide `bento_review::pr`,
        // el mismo criterio que usa el panel: aquí había un tercero distinto.
        let verdict = bento_review::pr::check_verdict(&bento_review::pr::PrCheck {
            name: None,
            context: None,
            conclusion: check.get("conclusion").and_then(Value::as_str).map(str::to_string),
            state: check.get("state").and_then(Value::as_str).map(str::to_string),
            status: check.get("status").and_then(Value::as_str).map(str::to_string),
        });
        let mark = match verdict {
            bento_review::pr::CheckVerdict::Passed => "✓",
            bento_review::pr::CheckVerdict::Failed => "✗",
            bento_review::pr::CheckVerdict::Pending => "⟳",
        };
        out.push_str(&format!("- {mark} {name} ({state})\n"));
    }
    out
}

/// Los comentarios anclados a una línea concreta del diff, que son los que de
/// verdad se responden en una review.
pub(super) fn format_review_comments(data: &Value) -> String {
    let comments = data.as_array().map(Vec::as_slice).unwrap_or_default();
    if comments.is_empty() {
        return String::new();
    }
    let mut out = String::from("\n## Comentarios en línea\n\n");
    for c in comments {
        let path = c.get("path").and_then(Value::as_str).unwrap_or("?");
        let line = c.get("line").or_else(|| c.get("original_line")).and_then(Value::as_u64);
        let body = c.get("body").and_then(Value::as_str).unwrap_or("");
        let location = match line {
            Some(line) => format!("{path}:{line}"),
            None => path.to_string(),
        };
        out.push_str(&format!("**{}** · `{location}`\n{body}\n\n", author_of(c)));
    }
    out
}

/// The GitHub REST payload for a comment/review author. Both endpoints nest
/// it under `user`, unlike `gh pr view --json`, which nests it under `author`.
fn author_of(entry: &Value) -> &str {
    entry.get("user").and_then(|u| u.get("login")).and_then(Value::as_str).unwrap_or("?")
}

/// Renders `{"comments": [...], "reviews": [...]}` (as returned by
/// `review.pr_comments`) as readable text — reviews first (they carry the
/// approve/request-changes verdict), then conversation comments, each
/// defaulting to `?`/empty for whatever fields an entry happens to lack.
pub(super) fn format_pr_comments(data: &Value) -> String {
    let mut out = String::new();
    for r in data.get("reviews").and_then(Value::as_array).into_iter().flatten() {
        let state = r.get("state").and_then(Value::as_str).unwrap_or("");
        let body = r.get("body").and_then(Value::as_str).unwrap_or("");
        out.push_str(&format!("**{}** ({state})\n{body}\n\n", author_of(r)));
    }
    for c in data.get("comments").and_then(Value::as_array).into_iter().flatten() {
        let body = c.get("body").and_then(Value::as_str).unwrap_or("");
        out.push_str(&format!("**{}**\n{body}\n\n", author_of(c)));
    }
    if out.is_empty() {
        out.push_str("(sin comentarios)\n");
    }
    out
}

/// Fits a path into `max` columns by dropping leading segments — the sidebar
/// is ~40 columns, and clipping from the right left "/Users/romangomez/Desktop"
/// on screen, which is the half that says nothing about which project it is.
pub(super) fn short_path(path: &str, max: usize) -> String {
    if path.chars().count() <= max {
        return path.to_string();
    }
    let tail: String = path.chars().skip(path.chars().count().saturating_sub(max.saturating_sub(1))).collect();
    match tail.find('/') {
        Some(_) if max > 1 => format!("…{}", tail.trim_start_matches(|c| c != '/')),
        _ => String::new(),
    }
}

/// Qué es cada fila de un diff, para pintarla y para saber si admite
/// comentario. Antes esto se recorría dos veces —una para el color, otra para
/// la línea— y las dos tenían que contar igual.
#[derive(Clone, Copy)]
pub(super) enum DiffKind {
    Added,
    Removed,
    Hunk,
    Context,
}

#[derive(Clone)]
pub(super) struct DiffRow {
    pub(super) kind: DiffKind,
    /// La línea del fichero viejo, cuando existía ahí. Es la numeración de la
    /// columna izquierda de la vista partida.
    pub(super) old: Option<u64>,
    /// La línea del fichero nuevo, cuando existe ahí. Una línea borrada ya no
    /// está en la versión nueva, y GitHub ancla los comentarios a esa.
    pub(super) line: Option<u64>,
    pub(super) text: String,
}

/// El diff en filas pintables. La cabecera de git (`diff --git`, `index`, los
/// `---`/`+++`) se queda fuera: no es código, y el título ya dice qué fichero
/// es — el panel del escritorio tampoco la enseña.
pub(super) fn diff_rows(diff: &str) -> Vec<DiffRow> {
    let mut rows = Vec::new();
    let mut new_line = 0u64;
    let mut old_line = 0u64;
    let mut inside_hunk = false;
    for line in diff.lines() {
        if let Some((from, to)) = hunk_start(line) {
            old_line = from;
            new_line = to;
            inside_hunk = true;
            rows.push(DiffRow { kind: DiffKind::Hunk, old: None, line: None, text: line.to_string() });
            continue;
        }
        if !inside_hunk || line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        // Una línea añadida no estaba en el fichero viejo y una borrada ya no
        // está en el nuevo: cada lado avanza sólo con las suyas.
        let (kind, in_old, in_new) = match line.chars().next() {
            Some('+') => (DiffKind::Added, false, true),
            Some('-') => (DiffKind::Removed, true, false),
            _ => (DiffKind::Context, true, true),
        };
        let before = in_old.then_some(old_line);
        let after = in_new.then_some(new_line);
        old_line += u64::from(in_old);
        new_line += u64::from(in_new);
        rows.push(DiffRow { kind, old: before, line: after, text: line.to_string() });
    }
    rows
}

/// Una fila de la vista partida: el fichero viejo a la izquierda y el nuevo a
/// la derecha. Un cambio es un par —lo que había y lo que hay—, y en la vista
/// unificada eso son dos filas que hay que leer una detrás de otra.
pub(super) struct SplitRow {
    pub(super) left: Option<DiffRow>,
    pub(super) right: Option<DiffRow>,
}

/// Empareja las filas de un diff en dos columnas. Un bloque de borradas
/// seguido de añadidas es una sustitución: van una al lado de la otra, y el
/// lado que se quede corto queda vacío.
pub(super) fn split_rows(rows: Vec<DiffRow>) -> Vec<SplitRow> {
    let mut out = Vec::new();
    let mut removed: Vec<DiffRow> = Vec::new();
    let mut added: Vec<DiffRow> = Vec::new();
    for row in rows {
        match row.kind {
            DiffKind::Removed => removed.push(row),
            DiffKind::Added => added.push(row),
            // Cualquier otra cosa cierra el bloque que se estuviera juntando.
            _ => {
                flush_pairs(&mut removed, &mut added, &mut out);
                out.push(SplitRow { left: Some(row.clone()), right: Some(row) });
            }
        }
    }
    flush_pairs(&mut removed, &mut added, &mut out);
    out
}

fn flush_pairs(removed: &mut Vec<DiffRow>, added: &mut Vec<DiffRow>, out: &mut Vec<SplitRow>) {
    let pairs = removed.len().max(added.len());
    let mut lefts = removed.drain(..);
    let mut rights = added.drain(..);
    for _ in 0..pairs {
        out.push(SplitRow { left: lefts.next(), right: rights.next() });
    }
}

/// Las primeras líneas del fichero viejo y del nuevo que cubre un
/// `@@ -a,b +c,d @@`. La vista partida numera las dos columnas.
fn hunk_start(line: &str) -> Option<(u64, u64)> {
    let rest = line.strip_prefix("@@ ")?;
    Some((number_after(rest, '-')?, number_after(rest, '+')?))
}

fn number_after(rest: &str, sign: char) -> Option<u64> {
    let tail = rest.split(sign).nth(1)?;
    let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// La tecla que una línea de la cabecera del raíl anuncia entre paréntesis al
/// final: "Agente: claude (g)". Se lee de lo que está pintado, así que un clic
/// hace exactamente lo mismo que la tecla y no hay una segunda tabla que se
/// desincronice del dibujo. Una línea que no anuncia ninguna no es un botón.
pub(super) fn key_in(line: &str) -> Option<crossterm::event::KeyCode> {
    use crossterm::event::KeyCode;

    let inside = line.trim_end().strip_suffix(')')?.rsplit_once('(')?.1.to_string();
    if let Some(number) = inside.strip_prefix('F') {
        return number.parse().ok().map(KeyCode::F);
    }
    let mut chars = inside.chars();
    let key = chars.next()?;
    chars.next().is_none().then_some(KeyCode::Char(key))
}

/// Las carpetas que hay dentro de `path`, con ".." delante cuando hay dónde
/// subir. Las ocultas fuera: elegir `.git` como proyecto no es lo que nadie
/// quiere, y ensucian la lista.
pub(super) fn subdirs(path: &std::path::Path) -> Vec<String> {
    let mut rows: Vec<String> = std::fs::read_dir(path)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| !name.starts_with('.'))
                .collect()
        })
        .unwrap_or_default();
    rows.sort();
    match path.parent().is_some() {
        true => std::iter::once("..".to_string()).chain(rows).collect(),
        false => rows,
    }
}

/// Si una carpeta es un repositorio. Se mira su `.git` en vez de preguntarle a
/// git: esto se llama una vez por fila de la lista, y arrancar un proceso por
/// carpeta para pintar un punto no sale a cuenta.
pub(super) fn is_repo(path: &std::path::Path) -> bool {
    path.join(".git").exists()
}

/// One saved review, in a line: when it was made, what it is about, and
/// whether it can still be asked a follow-up. The branch reviewed wins over
/// the ref it is filed under — that is what the reader recognises.
pub(super) fn checkpoint_row(cp: &Value) -> String {
    let about = cp
        .get("branch")
        .and_then(Value::as_str)
        .filter(|branch| !branch.is_empty())
        .or_else(|| cp.get("base").and_then(Value::as_str))
        .unwrap_or("?");
    let when = cp.get("saved_at").and_then(Value::as_str).unwrap_or("");
    let resumable = cp.get("resumable").and_then(Value::as_bool).unwrap_or(false);
    let mark = if resumable { " · se puede seguir" } else { "" };
    // La rama se movió desde que se hizo: el informe habla de otro código.
    let stale = match cp.get("stale").and_then(Value::as_bool).unwrap_or(false) {
        true => " · desfasada",
        false => "",
    };
    format!("{} · {about}{mark}{stale}", short_timestamp(when))
}

/// `2026-08-27T09:00:00Z` → `27/08 09:00`. Only the shape the store writes is
/// shortened; anything else is left alone rather than sliced into nonsense.
pub(super) fn short_timestamp(saved_at: &str) -> String {
    let Some((date, time)) = saved_at.split_once('T') else { return saved_at.to_string() };
    let parts: Vec<&str> = date.split('-').collect();
    let [_, month, day] = parts[..] else { return saved_at.to_string() };
    match time.len() >= 5 {
        true => format!("{day}/{month} {}", &time[..5]),
        false => saved_at.to_string(),
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn the_ci_badge_counts_what_failed() {
        // El detalle no cabe en una franja de una línea; lo que hay que ver de
        // un vistazo es si se puede aprobar o no.
        let checks = "\n## Checks\n\n- ✗ jenkins (ERROR)\n- ✗ cypress (FAILURE)\n- ✓ build (SUCCESS)\n";

        assert_eq!(super::checks_badge(checks), "✗ CI (2 fallan)");
        assert_eq!(super::checks_badge("- ✓ build (SUCCESS)"), "✓ CI");
        assert_eq!(super::checks_badge(""), "sin CI", "un PR sin CI no es un PR roto");
    }

    #[test]
    fn a_row_carries_the_line_it_had_before_and_the_one_it_has_now() {
        // La vista partida pone el fichero viejo a la izquierda con su propia
        // numeración: contar sólo la nueva deja esa columna sin números.
        let rows = super::diff_rows("@@ -10,3 +20,3 @@\n contexto\n-vieja\n+nueva");

        assert_eq!((rows[1].old, rows[1].line), (Some(10), Some(20)), "el contexto está en las dos");
        assert_eq!((rows[2].old, rows[2].line), (Some(11), None), "la borrada sólo en la vieja");
        assert_eq!((rows[3].old, rows[3].line), (None, Some(21)), "la añadida sólo en la nueva");
    }

    #[test]
    fn a_replaced_line_shows_the_old_beside_the_new() {
        // Un bloque de borradas seguido de añadidas es una sustitución: en dos
        // columnas van emparejadas, no una debajo de otra.
        let rows = super::split_rows(super::diff_rows("@@ -1,2 +1,2 @@\n-antes\n+después"));

        let pair = &rows[1];
        assert_eq!(pair.left.as_ref().map(|r| r.text.as_str()), Some("-antes"));
        assert_eq!(pair.right.as_ref().map(|r| r.text.as_str()), Some("+después"));
    }

    #[test]
    fn an_added_line_leaves_the_old_side_empty() {
        let rows = super::split_rows(super::diff_rows("@@ -1,1 +1,2 @@\n uno\n+dos"));

        assert!(rows[1].left.is_some() && rows[1].right.is_some(), "el contexto va en las dos");
        assert!(rows[2].left.is_none(), "lo que se añadió no estaba en el fichero viejo");
        assert_eq!(rows[2].right.as_ref().map(|r| r.text.as_str()), Some("+dos"));
    }

    #[test]
    fn more_removed_than_added_still_pairs_row_by_row() {
        // Tres fuera y una dentro: las dos sobrantes se quedan solas a la
        // izquierda, sin desplazar lo que venga después.
        let rows = super::split_rows(super::diff_rows("@@ -1,3 +1,1 @@\n-a\n-b\n-c\n+d\n fin"));

        assert_eq!(rows.len(), 5, "cabecera, tres pares y el contexto");
        assert_eq!(rows[1].right.as_ref().map(|r| r.text.as_str()), Some("+d"));
        assert!(rows[2].right.is_none() && rows[3].right.is_none());
        assert!(rows[4].left.is_some() && rows[4].right.is_some());
    }
    use super::*;
    use serde_json::json;

    #[test]
    fn next_agent_cycles_claude_codex_opencode_and_back() {
        assert_eq!(next_agent("claude"), "codex");
        assert_eq!(next_agent("codex"), "opencode");
        assert_eq!(next_agent("opencode"), "claude");
    }

    #[test]
    fn an_optional_pass_cycles_through_none_so_it_can_be_unset_again() {
        // Desktop's "Ninguno" has to be reachable, or a secondary picked by
        // accident could never be cleared.
        assert_eq!(next_optional_agent(None), Some("claude".to_string()));
        assert_eq!(next_optional_agent(Some("claude")), Some("codex".to_string()));
        assert_eq!(next_optional_agent(Some("codex")), Some("opencode".to_string()));
        assert_eq!(next_optional_agent(Some("opencode")), None);
    }

    #[test]
    fn next_agent_defaults_to_first_for_an_unknown_value() {
        assert_eq!(next_agent("bogus"), "codex");
    }

    #[test]
    fn format_pr_comments_lists_reviews_before_comments() {
        let data = json!({
            "reviews": [{ "user": { "login": "ada" }, "state": "APPROVED", "body": "lgtm" }],
            "comments": [{ "user": { "login": "bob" }, "body": "nit: rename this" }],
        });
        let text = format_pr_comments(&data);
        let review_pos = text.find("ada").unwrap();
        let comment_pos = text.find("bob").unwrap();
        assert!(review_pos < comment_pos);
        assert!(text.contains("APPROVED"));
        assert!(text.contains("nit: rename this"));
    }

    #[test]
    fn format_pr_comments_handles_empty_lists() {
        let data = json!({ "reviews": [], "comments": [] });
        assert_eq!(format_pr_comments(&data), "(sin comentarios)\n");
    }

    #[test]
    fn file_filter_cycles_all_added_modified_deleted() {
        assert_eq!(FileFilter::All.next(), FileFilter::Added);
        assert_eq!(FileFilter::Added.next(), FileFilter::Modified);
        assert_eq!(FileFilter::Modified.next(), FileFilter::Deleted);
        assert_eq!(FileFilter::Deleted.next(), FileFilter::All);
    }

    #[test]
    fn file_matches_filter_buckets_renamed_as_modified() {
        assert!(file_matches_filter("R", FileFilter::Modified));
        assert!(!file_matches_filter("R", FileFilter::Added));
        assert!(!file_matches_filter("R", FileFilter::Deleted));
    }

    #[test]
    fn file_matches_filter_all_accepts_everything() {
        for status in ["A", "M", "D", "R", "?"] {
            assert!(file_matches_filter(status, FileFilter::All));
        }
    }

    #[test]
    fn short_path_keeps_a_path_that_fits() {
        assert_eq!(short_path("/a/b/c", 20), "/a/b/c");
    }

    #[test]
    fn short_path_keeps_the_tail_of_a_long_path() {
        // Lo que identifica el proyecto está al final: cortar por la izquierda
        // deja "…/roma/bento/daemon" en vez de "/Users/romangomez/Desktop/roma".
        assert_eq!(short_path("/Users/ana/Desktop/roma/bento/daemon", 20), "…/roma/bento/daemon");
    }

    #[test]
    fn short_path_handles_a_width_smaller_than_the_ellipsis() {
        assert_eq!(short_path("/a/b/c", 0), "");
    }

    #[test]
    fn checks_are_listed_with_their_result() {
        let data = json!([
            { "name": "build", "conclusion": "SUCCESS" },
            { "name": "test", "conclusion": "FAILURE" },
            { "workflowName": "deploy", "status": "IN_PROGRESS" },
        ]);
        let text = format_checks(&data);
        assert!(text.contains("✓ build"));
        assert!(text.contains("✗ test"));
        assert!(text.contains("⟳ deploy"));
    }

    #[test]
    fn checks_say_nothing_when_the_pr_has_none() {
        assert_eq!(format_checks(&json!([])), "");
    }

    #[test]
    fn inline_comments_show_where_they_are_anchored() {
        let data = json!([{ "user": { "login": "ada" }, "path": "src/a.rs", "line": 42, "body": "esto sobra" }]);
        let text = format_review_comments(&data);
        assert!(text.contains("ada"));
        assert!(text.contains("src/a.rs:42"));
        assert!(text.contains("esto sobra"));
    }

    #[test]
    fn an_inline_comment_on_deleted_code_falls_back_to_the_file() {
        // GitHub deja `line` a null cuando la línea comentada ya no existe.
        let data = json!([{ "user": { "login": "ada" }, "path": "src/a.rs", "line": null, "body": "x" }]);
        assert!(format_review_comments(&data).contains("`src/a.rs`"));
    }

    #[test]
    fn a_review_of_code_that_moved_says_so() {
        let cp = serde_json::json!({
            "base": "main", "branch": "feat/x", "saved_at": "2026-08-27T09:05:00Z", "stale": true,
        });

        assert!(checkpoint_row(&cp).contains("desfasada"));
    }

    #[test]
    fn a_saved_review_reads_as_when_and_what_it_was_about() {
        let cp = serde_json::json!({
            "base": "main", "branch": "feat/x",
            "saved_at": "2026-08-27T09:05:00Z", "resumable": true,
        });

        assert_eq!(checkpoint_row(&cp), "27/08 09:05 · feat/x · se puede seguir");
    }

    #[test]
    fn a_review_of_the_working_tree_falls_back_to_the_ref_it_is_filed_under() {
        let cp = serde_json::json!({ "base": "main", "saved_at": "2026-08-27T09:05:00.123Z" });

        assert_eq!(checkpoint_row(&cp), "27/08 09:05 · main");
    }

    #[test]
    fn a_timestamp_that_is_not_the_stores_shape_is_left_alone() {
        let cp = serde_json::json!({ "base": "main", "saved_at": "hace un rato" });

        assert_eq!(checkpoint_row(&cp), "hace un rato · main");
    }

    const DIFF: &str = "\
diff --git a/a.rs b/a.rs
--- a/a.rs
+++ b/a.rs
@@ -10,4 +10,5 @@ fn cosa() {
 contexto
-lo viejo
+lo nuevo
+otra mas
 final
";

    #[test]
    fn a_comment_lands_on_the_line_of_the_new_file() {
        // GitHub ancla los comentarios a la versión nueva. La cabecera de git
        // no sale, así que la primera fila ya es el `@@`.
        let rows = diff_rows(DIFF);

        assert!(matches!(rows[0].kind, DiffKind::Hunk));
        assert_eq!(rows[1].line, Some(10), "el contexto");
        assert_eq!(rows[3].line, Some(11), "la añadida");
        assert_eq!(rows[4].line, Some(12));
        assert_eq!(rows[5].line, Some(13), "el contexto de después");
    }

    #[test]
    fn there_is_nothing_to_comment_on_a_removed_line_or_a_header() {
        let rows = diff_rows(DIFF);

        // Una línea borrada ya no está en el fichero nuevo.
        assert!(matches!(rows[2].kind, DiffKind::Removed));
        assert_eq!(rows[2].line, None);
        // Y la cabecera de git ni aparece: `diff --git`, `index`, `---`, `+++`.
        assert!(!rows.iter().any(|r| r.text.starts_with("diff --git")));
        assert!(!rows.iter().any(|r| r.text.starts_with("+++")));
    }




}
