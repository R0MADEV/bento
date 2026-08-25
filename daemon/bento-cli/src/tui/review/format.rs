//! Pure formatting helpers for the Review tab — no state, no IPC, no drawing.

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

/// El estado de los checks de CI, en una línea por check. Sin esto había que
/// salir a GitHub para saber si el PR pasaba.
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn next_agent_cycles_claude_codex_opencode_and_back() {
        assert_eq!(next_agent("claude"), "codex");
        assert_eq!(next_agent("codex"), "opencode");
        assert_eq!(next_agent("opencode"), "claude");
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
}
