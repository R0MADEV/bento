use super::*;

/// Every `gh` call blocks, so each command runs on the blocking pool. One
/// helper instead of the same `spawn_blocking` + double `map_err` in each.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct PrCheck {
    name: Option<String>,
    context: Option<String>,
    conclusion: Option<String>,
    state: Option<String>,
    status: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct PrStatus {
    state: String,
    title: String,
    url: String,
    #[ts(type = "number")]
    number: u64,
    base_ref_name: Option<String>,
    is_draft: Option<bool>,
    mergeable: Option<String>,
    review_decision: Option<String>,
    #[serde(default)]
    status_check_rollup: Vec<PrCheck>,
}

// Returns typed PR metadata or null if no PR / gh is unavailable.
#[tauri::command]
pub async fn git_pr_status(path: String) -> Result<Option<PrStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = Command::new("gh")
            .current_dir(&path)
            .args(["pr", "view", "--json", "state,title,url,number,baseRefName,isDraft,mergeable,reviewDecision,statusCheckRollup"])
            .output();
        let Ok(out) = out else { return Ok(None); };
        if !out.status.success() || out.stdout.is_empty() { return Ok(None); }
        serde_json::from_slice::<PrStatus>(&out.stdout).map(Some).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Returns PR info for any branch via gh CLI.
#[tauri::command]
pub async fn gh_pr_view_branch(
    path: String,
    branch: String,
) -> Result<Option<serde_json::Value>, String> {
    if !is_safe_branch(&branch) {
        return Err(format!("unsafe branch: {branch}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let out = Command::new("gh")
            .current_dir(&path)
            .args([
                "pr",
                "view",
                &branch,
                "--json",
                "number,title,url,body,state,mergedAt,statusCheckRollup,reviewDecision",
            ])
            .output();
        let Ok(out) = out else {
            return Ok(None);
        };
        if !out.status.success() || out.stdout.is_empty() {
            return Ok(None);
        }
        serde_json::from_slice::<serde_json::Value>(&out.stdout)
            .map(Some)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn gh_pr_diff_number(path: String, pr_number: u64) -> Result<String, String> {
    blocking(move || Ok(bento_review::pr::diff(&path, pr_number).unwrap_or_default())).await
}

// PR conversation: issue comments + submitted reviews.
#[tauri::command]
pub async fn gh_pr_list_discussion(path: String, pr_number: u64) -> Result<serde_json::Value, String> {
    blocking(move || bento_review::pr::discussion(&path, pr_number)).await
}

// Posts a comment on the PR conversation and returns its URL.
#[tauri::command]
pub async fn gh_pr_comment(path: String, branch: String, body: String) -> Result<String, String> {
    blocking(move || {
        let pr = bento_review::pr::number_for_branch(&path, &branch)?;
        bento_review::pr::add_comment(&path, pr, &body)
    })
    .await
}

// Posts an inline review comment on a specific file+line.
#[tauri::command]
pub async fn gh_pr_inline_comment(
    path: String,
    pr_number: u64,
    commit_id: String,
    file: String,
    line: u64,
    start_line: Option<u64>,
    body: String,
) -> Result<String, String> {
    blocking(move || {
        if !is_git_repo(&path) {
            return Err("not a git repository".into());
        }
        bento_review::pr::add_review_comment(&path, pr_number, &commit_id, &file, line, start_line, &body)
    })
    .await
}

// Open pull requests for the repo.
#[tauri::command]
pub async fn gh_pr_list_open(path: String) -> Result<serde_json::Value, String> {
    blocking(move || {
        let json = bento_review::pr::list_open(&path)?;
        serde_json::from_str(&json).map_err(|e| e.to_string())
    })
    .await
}

// Edits an existing inline review comment. `pr_number` is what scopes the edit
// to this PR: without it a comment id from an unrelated PR in the same repo
// would be edited just as happily.
#[tauri::command]
pub async fn gh_pr_update_comment(path: String, pr_number: u64, comment_id: u64, body: String) -> Result<(), String> {
    blocking(move || bento_review::pr::update_review_comment(&path, pr_number, comment_id, &body)).await
}

// Deletes an inline review comment (scoped to the PR, see above).
#[tauri::command]
pub async fn gh_pr_delete_comment(path: String, pr_number: u64, comment_id: u64) -> Result<(), String> {
    blocking(move || bento_review::pr::delete_review_comment(&path, pr_number, comment_id)).await
}

// Replies to an inline review comment thread (scoped to the PR, see above).
#[tauri::command]
pub async fn gh_pr_reply_comment(path: String, pr_number: u64, comment_id: u64, body: String) -> Result<String, String> {
    blocking(move || bento_review::pr::reply_review_comment(&path, pr_number, comment_id, &body)).await
}

// Every inline review comment on a PR.
#[tauri::command]
pub async fn gh_pr_list_comments(path: String, pr_number: u64) -> Result<serde_json::Value, String> {
    blocking(move || bento_review::pr::list_review_comments(&path, pr_number)).await
}

// Submits a pull request review (APPROVE / REQUEST_CHANGES / COMMENT).
#[tauri::command]
pub async fn gh_pr_submit_review(path: String, pr_number: u64, event: String, body: String) -> Result<String, String> {
    blocking(move || bento_review::pr::submit_review(&path, pr_number, &event, &body)).await
}

#[tauri::command]
pub async fn git_create_pr(path: String, base: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_branch(&base) {
            return Err(format!("unsafe base branch: {base}"));
        }
        let out = Command::new("gh")
            .current_dir(&path)
            .args(["pr", "create", "--fill", "--base", &base])
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
        }
        // Fallback: return compare URL so the frontend can open it in the browser.
        if let Ok(remote) = git_output(&path, &["remote", "get-url", "origin"]) {
            let remote = remote.trim().trim_end_matches(".git").to_string();
            let branch =
                git_output(&path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
            let branch = branch.trim().to_string();
            if !remote.is_empty() && !branch.is_empty() {
                return Ok(format!("{remote}/compare/{base}...{branch}?expand=1"));
            }
        }
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
