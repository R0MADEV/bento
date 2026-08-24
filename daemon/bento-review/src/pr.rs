//! Pull-request operations through the `gh` CLI, shared by the desktop app,
//! the daemon's phone remote and the CLI. GitHub has two kinds of comment and
//! they live at different endpoints: *issue* comments (the PR conversation)
//! and *review* comments (inline, anchored to a file and line). Both families
//! are here, named for what they are — the two codebases each implemented one
//! of them under the same name, which is exactly how they drifted apart.

use serde_json::{json, Value};

use crate::vcs::gh_cmd;

/// GitHub rejects comment bodies past this; check locally so an oversized
/// paste fails fast with a clear message instead of a raw API error.
pub const MAX_BODY_BYTES: usize = 65_536;

fn check_body(body: &str) -> Result<(), String> {
    if body.len() > MAX_BODY_BYTES {
        return Err("comment body exceeds maximum length".into());
    }
    Ok(())
}

fn check_commit_sha(sha: &str) -> Result<(), String> {
    let is_valid = !sha.is_empty() && sha.len() <= 40 && sha.chars().all(|c| c.is_ascii_hexdigit());
    if !is_valid {
        return Err(format!("invalid commit SHA: {sha}"));
    }
    Ok(())
}

/// Maps a client-supplied review event onto GitHub's three, defaulting to the
/// harmless one — client input never reaches the API verbatim.
fn review_event(event: &str) -> &'static str {
    match event.to_uppercase().as_str() {
        "APPROVE" => "APPROVE",
        "REQUEST_CHANGES" => "REQUEST_CHANGES",
        _ => "COMMENT",
    }
}

/// Compares a comment's `issue_url` against the PR the client claims to be
/// editing, so a valid request for one PR can't edit or delete a comment on
/// an unrelated issue/PR in the same repo.
fn issue_url_matches_pr(issue_url: &str, pr: u64) -> bool {
    issue_url.trim().ends_with(&format!("/issues/{pr}"))
}

/// Same check for inline review comments, which carry `pull_request_url`.
fn pull_url_matches_pr(pull_request_url: &str, pr: u64) -> bool {
    pull_request_url.trim().ends_with(&format!("/pulls/{pr}"))
}

fn ensure_belongs_to_pr(cwd: &str, endpoint: &str, field: &str, pr: u64, matches: fn(&str, u64) -> bool) -> Result<(), String> {
    let url = gh_cmd(cwd, &["api", endpoint, "--jq", &format!(".{field}")])?;
    if matches(&url, pr) {
        return Ok(());
    }
    Err("comment does not belong to pr".into())
}

fn issue_comment_endpoint(id: u64) -> String {
    format!("repos/{{owner}}/{{repo}}/issues/comments/{id}")
}

fn review_comment_endpoint(id: u64) -> String {
    format!("repos/{{owner}}/{{repo}}/pulls/comments/{id}")
}

fn gh_json(cwd: &str, args: &[&str]) -> Result<Value, String> {
    let out = gh_cmd(cwd, args)?;
    serde_json::from_str(&out).map_err(|e| e.to_string())
}

// ── The PR itself ─────────────────────────────────────────────────────────────

/// Open PRs, newest 30. The JSON is returned as text so callers can forward it
/// straight to their own client without a parse/serialize round-trip.
pub fn list_open(cwd: &str) -> Result<String, String> {
    gh_cmd(cwd, &[
        "pr", "list", "--state", "open", "--limit", "30",
        "--json", "number,title,url,author,headRefName,baseRefName",
    ])
}

pub fn diff(cwd: &str, pr: u64) -> Result<String, String> {
    gh_cmd(cwd, &["pr", "diff", &pr.to_string(), "--color=never"])
}

/// The PR number for a branch, for callers that only know the branch.
pub fn number_for_branch(cwd: &str, branch: &str) -> Result<u64, String> {
    if !crate::vcs::is_safe_branch(branch) {
        return Err(format!("unsafe branch: {branch}"));
    }
    gh_cmd(cwd, &["pr", "view", branch, "--json", "number", "--jq", ".number"])?
        .trim()
        .parse()
        .map_err(|_| "no PR for branch".to_string())
}

/// The PR conversation: issue comments plus submitted reviews. Read through
/// the REST API rather than `gh pr view --json comments,reviews` because only
/// the REST payload carries the numeric ids that editing and deleting need.
pub fn discussion(cwd: &str, pr: u64) -> Result<Value, String> {
    let comments = gh_json(cwd, &["api", "--paginate", &format!("repos/{{owner}}/{{repo}}/issues/{pr}/comments")])
        .unwrap_or_else(|_| json!([]));
    let reviews = gh_json(cwd, &["api", "--paginate", &format!("repos/{{owner}}/{{repo}}/pulls/{pr}/reviews")])
        .unwrap_or_else(|_| json!([]));
    Ok(json!({ "comments": comments, "reviews": reviews }))
}

/// Submits a review. Returns its URL.
pub fn submit_review(cwd: &str, pr: u64, event: &str, body: &str) -> Result<String, String> {
    check_body(body)?;
    let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/{pr}/reviews");
    gh_cmd(cwd, &[
        "api", "--method", "POST", &endpoint,
        "-f", &format!("event={}", review_event(event)),
        "-f", &format!("body={body}"),
        "--jq", ".html_url",
    ])
    .map(|url| url.trim().to_string())
}

// ── Issue comments (the PR conversation) ──────────────────────────────────────

/// Posts a comment on the PR conversation. Returns its URL.
pub fn add_comment(cwd: &str, pr: u64, body: &str) -> Result<String, String> {
    check_body(body)?;
    let endpoint = format!("repos/{{owner}}/{{repo}}/issues/{pr}/comments");
    gh_cmd(cwd, &[
        "api", "--method", "POST", &endpoint,
        "-f", &format!("body={body}"),
        "--jq", ".html_url",
    ])
    .map(|url| url.trim().to_string())
}

pub fn update_comment(cwd: &str, pr: u64, id: u64, body: &str) -> Result<(), String> {
    check_body(body)?;
    let endpoint = issue_comment_endpoint(id);
    ensure_belongs_to_pr(cwd, &endpoint, "issue_url", pr, issue_url_matches_pr)?;
    gh_cmd(cwd, &["api", "--method", "PATCH", &endpoint, "-f", &format!("body={body}")]).map(|_| ())
}

pub fn delete_comment(cwd: &str, pr: u64, id: u64) -> Result<(), String> {
    let endpoint = issue_comment_endpoint(id);
    ensure_belongs_to_pr(cwd, &endpoint, "issue_url", pr, issue_url_matches_pr)?;
    gh_cmd(cwd, &["api", "--method", "DELETE", &endpoint]).map(|_| ())
}

// ── Review comments (inline, anchored to a file and line) ─────────────────────

pub fn list_review_comments(cwd: &str, pr: u64) -> Result<Value, String> {
    gh_json(cwd, &["api", "--paginate", &format!("repos/{{owner}}/{{repo}}/pulls/{pr}/comments")])
}

/// Posts an inline comment on `file`:`line` (optionally a range starting at
/// `start_line`). Returns its URL.
pub fn add_review_comment(
    cwd: &str,
    pr: u64,
    commit_id: &str,
    file: &str,
    line: u64,
    start_line: Option<u64>,
    body: &str,
) -> Result<String, String> {
    if line == 0 {
        return Err("line must be >= 1".into());
    }
    check_body(body)?;
    check_commit_sha(commit_id)?;
    if !crate::vcs::is_safe_relative_path(file) {
        return Err(format!("unsafe path: {file}"));
    }
    let mut args = vec![
        "api".to_string(),
        format!("repos/{{owner}}/{{repo}}/pulls/{pr}/comments"),
        "-f".to_string(), format!("body={body}"),
        "-f".to_string(), format!("commit_id={commit_id}"),
        "-f".to_string(), format!("path={file}"),
        "-F".to_string(), format!("line={line}"),
        "-f".to_string(), "side=RIGHT".to_string(),
    ];
    if let Some(start) = start_line.filter(|s| *s < line) {
        args.extend(["-F".to_string(), format!("start_line={start}"), "-f".to_string(), "start_side=RIGHT".to_string()]);
    }
    args.extend(["--jq".to_string(), ".html_url".to_string()]);
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    gh_cmd(cwd, &borrowed).map(|url| url.trim().to_string())
}

pub fn update_review_comment(cwd: &str, pr: u64, id: u64, body: &str) -> Result<(), String> {
    check_body(body)?;
    let endpoint = review_comment_endpoint(id);
    ensure_belongs_to_pr(cwd, &endpoint, "pull_request_url", pr, pull_url_matches_pr)?;
    gh_cmd(cwd, &["api", "--method", "PATCH", &endpoint, "-f", &format!("body={body}")]).map(|_| ())
}

pub fn delete_review_comment(cwd: &str, pr: u64, id: u64) -> Result<(), String> {
    let endpoint = review_comment_endpoint(id);
    ensure_belongs_to_pr(cwd, &endpoint, "pull_request_url", pr, pull_url_matches_pr)?;
    gh_cmd(cwd, &["api", "--method", "DELETE", &endpoint]).map(|_| ())
}

/// Replies to an inline comment thread. Returns the reply's URL.
pub fn reply_review_comment(cwd: &str, pr: u64, id: u64, body: &str) -> Result<String, String> {
    check_body(body)?;
    ensure_belongs_to_pr(cwd, &review_comment_endpoint(id), "pull_request_url", pr, pull_url_matches_pr)?;
    let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/comments/{id}/replies");
    gh_cmd(cwd, &["api", "--method", "POST", &endpoint, "-f", &format!("body={body}"), "--jq", ".html_url"])
        .map(|url| url.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_url_matches_pr_accepts_matching_pr() {
        assert!(issue_url_matches_pr("https://api.github.com/repos/acme/widget/issues/42", 42));
    }

    #[test]
    fn issue_url_matches_pr_rejects_other_pr() {
        assert!(!issue_url_matches_pr("https://api.github.com/repos/acme/widget/issues/42", 41));
        assert!(!issue_url_matches_pr("https://api.github.com/repos/acme/widget/issues/423", 42));
    }

    #[test]
    fn pull_url_matches_pr_accepts_matching_pr() {
        assert!(pull_url_matches_pr("https://api.github.com/repos/acme/widget/pulls/42", 42));
    }

    #[test]
    fn pull_url_matches_pr_rejects_other_pr() {
        assert!(!pull_url_matches_pr("https://api.github.com/repos/acme/widget/pulls/423", 42));
        assert!(!pull_url_matches_pr("https://api.github.com/repos/acme/widget/issues/42", 42));
    }

    #[test]
    fn review_event_maps_the_three_github_events() {
        assert_eq!(review_event("approve"), "APPROVE");
        assert_eq!(review_event("REQUEST_CHANGES"), "REQUEST_CHANGES");
        assert_eq!(review_event("COMMENT"), "COMMENT");
    }

    #[test]
    fn review_event_falls_back_to_comment_for_anything_else() {
        // Never forwards client input verbatim: an unknown event becomes the
        // harmless one instead of reaching the API as-is.
        assert_eq!(review_event("MERGE"), "COMMENT");
        assert_eq!(review_event(""), "COMMENT");
    }

    #[test]
    fn check_body_rejects_an_oversized_comment() {
        assert!(check_body(&"x".repeat(MAX_BODY_BYTES)).is_ok());
        assert!(check_body(&"x".repeat(MAX_BODY_BYTES + 1)).is_err());
    }

    #[test]
    fn check_commit_sha_accepts_only_hex() {
        assert!(check_commit_sha("abc123def4567890").is_ok());
        assert!(check_commit_sha("").is_err());
        assert!(check_commit_sha("../../etc/passwd").is_err());
        assert!(check_commit_sha(&"a".repeat(41)).is_err());
    }
}
