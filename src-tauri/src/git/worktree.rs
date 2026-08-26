//! Comandos de worktrees. La lógica vive en `bento_review::{worktrees, tasks}`,
//! compartida con el daemon y el CLI.

pub use bento_review::worktrees::WorktreeInfo;

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_worktree_list(repo: String) -> Result<Vec<WorktreeInfo>, String> {
    blocking(move || Ok(bento_review::worktrees::list(&repo))).await
}

#[tauri::command]
pub async fn git_worktree_add(
    repo: String,
    path: String,
    branch: String,
    base: String,
) -> Result<(), String> {
    blocking(move || bento_review::tasks::create_at(&repo, &path, &branch, &base)).await
}

#[tauri::command]
pub async fn git_worktree_remove(
    repo: String,
    path: String,
    force: bool,
    branch: Option<String>,
) -> Result<(), String> {
    blocking(move || bento_review::tasks::remove_with_branch(&repo, &path, force, branch.as_deref()))
        .await
}
