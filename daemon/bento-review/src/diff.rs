use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, PartialEq, Serialize)]
pub struct DiffEntry {
    pub status: String,
    pub path: String,
    pub old_path: Option<String>,
}

pub fn parse_diff_name_status(output: &str) -> Vec<DiffEntry> {
    output
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let status_raw = parts.next()?.trim();
            let first = parts.next()?.trim().to_string();
            let second = parts.next().map(|s| s.trim().to_string());
            let status = if status_raw.starts_with('R') || status_raw.starts_with('C') {
                status_raw[..1].to_string()
            } else {
                status_raw.to_string()
            };
            // git emits `old_path\tnew_path` for renames/copies; the current path is always last.
            let (path, old_path) = match second {
                Some(new_path) => (new_path, Some(first)),
                None => (first, None),
            };
            Some(DiffEntry { status, path, old_path })
        })
        .collect()
}

#[allow(dead_code)]
pub fn parse_diff_stat(output: &str) -> Vec<Value> {
    output
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.contains("file changed") && !l.contains("files changed"))
        .map(|line| {
            let mut parts = line.splitn(3, '\t');
            let added: i64 = parts.next().unwrap_or("0").trim().parse().unwrap_or(0);
            let deleted: i64 = parts.next().unwrap_or("0").trim().parse().unwrap_or(0);
            let path = parts.next().unwrap_or("").trim().to_string();
            json!({ "path": path, "added": added, "deleted": deleted })
        })
        .collect()
}

// ── Diff batching ─────────────────────────────────────────────────────────────

/// Splits a unified diff into one string per changed file.
/// Each chunk starts with the `diff --git` header line.
pub fn split_diff_into_file_diffs(diff: &str) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in diff.lines() {
        if line.starts_with("diff --git") && !current.is_empty() {
            files.push(current.trim_end().to_string());
            current = String::new();
        }
        current.push_str(line);
        current.push('\n');
    }
    let trimmed = current.trim_end().to_string();
    if !trimmed.is_empty() {
        files.push(trimmed);
    }
    files
}

/// Groups file diffs into batches where each batch is at most `max_chars` long.
/// A single file that exceeds `max_chars` on its own is placed in its own batch.
pub fn batch_file_diffs(file_diffs: Vec<String>, max_chars: usize) -> Vec<String> {
    if file_diffs.is_empty() {
        return Vec::new();
    }
    let mut batches: Vec<String> = Vec::new();
    let mut current = String::new();
    for diff in file_diffs {
        let needs_separator = !current.is_empty();
        let would_exceed = current.len() + diff.len() > max_chars;
        if needs_separator && would_exceed {
            batches.push(current.trim_end().to_string());
            current = String::new();
        }
        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(&diff);
    }
    if !current.trim().is_empty() {
        batches.push(current.trim_end().to_string());
    }
    batches
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_modified_file() {
        let out = "M\tsrc/main.rs\n";
        let entries = parse_diff_name_status(out);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].status, "M");
        assert_eq!(entries[0].path, "src/main.rs");
        assert_eq!(entries[0].old_path, None);
    }

    #[test]
    fn parse_added_and_deleted_files() {
        let out = "A\tsrc/new.rs\nD\tsrc/old.rs\n";
        let entries = parse_diff_name_status(out);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].status, "A");
        assert_eq!(entries[1].status, "D");
    }

    #[test]
    fn parse_renamed_file_strips_similarity_score() {
        let out = "R100\tsrc/old.rs\tsrc/new.rs\n";
        let entries = parse_diff_name_status(out);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].status, "R");
        assert_eq!(entries[0].path, "src/new.rs");
        assert_eq!(entries[0].old_path, Some("src/old.rs".into()));
    }

    #[test]
    fn parse_copied_file_keeps_old_and_new_path() {
        let out = "C75\tsrc/base.rs\tsrc/copy.rs\n";
        let entries = parse_diff_name_status(out);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].status, "C");
        assert_eq!(entries[0].path, "src/copy.rs");
        assert_eq!(entries[0].old_path, Some("src/base.rs".into()));
    }

    #[test]
    fn parse_empty_output_returns_empty_vec() {
        assert!(parse_diff_name_status("").is_empty());
        assert!(parse_diff_name_status("   \n  \n").is_empty());
    }

    #[test]
    fn parse_multiple_files_preserves_order() {
        let out = "M\ta.rs\nA\tb.rs\nD\tc.rs\n";
        let entries = parse_diff_name_status(out);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, ["a.rs", "b.rs", "c.rs"]);
    }

    #[test]
    fn parse_diff_stat_extracts_added_deleted_path() {
        let out = "10\t3\tsrc/foo.rs\n5\t0\tsrc/bar.rs\n";
        let stats = parse_diff_stat(out);
        assert_eq!(stats.len(), 2);
        assert_eq!(stats[0]["path"], "src/foo.rs");
        assert_eq!(stats[0]["added"], 10);
        assert_eq!(stats[0]["deleted"], 3);
    }

    #[test]
    fn parse_diff_stat_skips_summary_line() {
        let out = "10\t3\tsrc/foo.rs\n2 files changed, 10 insertions(+), 3 deletions(-)\n";
        let stats = parse_diff_stat(out);
        assert_eq!(stats.len(), 1);
    }

    // ── split_diff_into_file_diffs ────────────────────────────────────────────

    #[test]
    fn split_single_file_diff() {
        let diff = "diff --git a/foo.rs b/foo.rs\n--- a/foo.rs\n+++ b/foo.rs\n@@ -1 +1 @@\n-old\n+new";
        let parts = split_diff_into_file_diffs(diff);
        assert_eq!(parts.len(), 1);
        assert!(parts[0].starts_with("diff --git a/foo.rs"));
    }

    #[test]
    fn split_two_file_diffs() {
        let diff = "diff --git a/a.rs b/a.rs\n+added\ndiff --git a/b.rs b/b.rs\n-removed";
        let parts = split_diff_into_file_diffs(diff);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].contains("a/a.rs"));
        assert!(parts[1].contains("a/b.rs"));
    }

    #[test]
    fn split_empty_diff_returns_empty_vec() {
        assert!(split_diff_into_file_diffs("").is_empty());
        assert!(split_diff_into_file_diffs("   \n  \n").is_empty());
    }

    #[test]
    fn split_preserves_full_content_of_each_file() {
        let diff = "diff --git a/x.rs b/x.rs\n--- a/x.rs\n+++ b/x.rs\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/y.rs b/y.rs\n--- a/y.rs\n+++ b/y.rs\n@@ -1 +1 @@\n-a\n+b";
        let parts = split_diff_into_file_diffs(diff);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].contains("-old") && parts[0].contains("+new"));
        assert!(parts[1].contains("-a") && parts[1].contains("+b"));
    }

    // ── batch_file_diffs ──────────────────────────────────────────────────────

    #[test]
    fn batch_all_files_fit_in_one_batch() {
        let diffs = vec!["diff --git a/a.rs\n+line".to_string(), "diff --git a/b.rs\n+line".to_string()];
        let batches = batch_file_diffs(diffs, 10_000);
        assert_eq!(batches.len(), 1);
        assert!(batches[0].contains("a/a.rs"));
        assert!(batches[0].contains("a/b.rs"));
    }

    #[test]
    fn batch_splits_when_exceeds_max_chars() {
        let big = "x".repeat(6_000);
        let diffs = vec![
            format!("diff --git a/a.rs\n{}", big),
            format!("diff --git a/b.rs\n{}", big),
        ];
        let batches = batch_file_diffs(diffs, 8_000);
        assert_eq!(batches.len(), 2, "each file should be in its own batch");
    }

    #[test]
    fn batch_empty_input_returns_empty() {
        assert!(batch_file_diffs(vec![], 12_000).is_empty());
    }

    #[test]
    fn batch_single_oversized_file_gets_own_batch() {
        let huge = format!("diff --git a/huge.rs\n{}", "x".repeat(20_000));
        let batches = batch_file_diffs(vec![huge], 12_000);
        assert_eq!(batches.len(), 1, "oversized file must still appear in exactly one batch");
    }

    #[test]
    fn batch_three_files_pack_correctly() {
        let a = format!("diff --git a/a.rs\n{}", "x".repeat(4_000));
        let b = format!("diff --git a/b.rs\n{}", "x".repeat(4_000));
        let c = format!("diff --git a/c.rs\n{}", "x".repeat(4_000));
        let batches = batch_file_diffs(vec![a, b, c], 10_000);
        // a+b fit (~8k), c goes to second batch
        assert_eq!(batches.len(), 2);
    }
}
