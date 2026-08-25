//! Comandos de estado y diffs. La lógica vive en `bento_review::status`,
//! compartida con el daemon y el CLI.

pub use bento_review::status::{GitStatus, RewritePreflight};

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<GitStatus, String> {
    blocking(move || bento_review::status::status(&path)).await
}

#[tauri::command]
pub async fn git_rewrite_preflight(path: String, base: String) -> Result<RewritePreflight, String> {
    blocking(move || bento_review::status::rewrite_preflight(&path, &base)).await
}

#[tauri::command]
pub async fn git_diff(path: String) -> Result<String, String> {
    blocking(move || bento_review::status::worktree_diff(&path)).await
}

#[tauri::command]
pub async fn git_branch_diff(path: String, base: String) -> Result<String, String> {
    blocking(move || bento_review::status::branch_diff(&path, &base)).await
}

#[tauri::command]
pub async fn git_review_worktree_diff(path: String, base: String) -> Result<String, String> {
    blocking(move || bento_review::status::review_worktree_diff(&path, &base)).await
}
