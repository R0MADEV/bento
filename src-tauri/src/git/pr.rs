//! Comandos de pull request. La lógica vive en `bento_review::pr`, compartida
//! con el daemon y el CLI.

pub use bento_review::pr::PrStatus;

/// Cada llamada a `gh` bloquea, así que todas van al pool de bloqueo. Un
/// helper en vez del mismo `spawn_blocking` + doble `map_err` en cada una.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_pr_status(path: String) -> Result<Option<PrStatus>, String> {
    blocking(move || bento_review::pr::status(&path)).await
}

#[tauri::command]
pub async fn gh_pr_view_branch(
    path: String,
    branch: String,
) -> Result<Option<serde_json::Value>, String> {
    blocking(move || bento_review::pr::view_branch(&path, &branch)).await
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
    blocking(move || bento_review::pr::create(&path, &base)).await
}
