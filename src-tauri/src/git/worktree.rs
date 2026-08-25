use super::*;

pub use bento_review::worktrees::WorktreeInfo;


#[tauri::command]
pub async fn git_worktree_list(repo: String) -> Result<Vec<WorktreeInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(bento_review::worktrees::list(&repo)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_worktree_add(
    repo: String,
    path: String,
    branch: String,
    base: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_git_repo(&repo) {
            return Err("not a git repository".into());
        }
        if !is_safe_branch(&branch) {
            return Err(format!("unsafe branch name: {branch}"));
        }
        if !is_safe_branch(&base) {
            return Err(format!("unsafe base branch: {base}"));
        }
        if Path::new(&path).exists() {
            return Err(format!("path already exists: {path}"));
        }
        git_output(&repo, &["worktree", "add", &path, "-b", &branch, &base])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_worktree_remove(
    repo: String,
    path: String,
    force: bool,
    branch: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        bento_review::tasks::remove(&repo, &path, force)?;
        // La rama de la tarea se borra aparte: quitar el worktree no la toca.
        if let Some(branch) = branch {
            if is_safe_branch(&branch) {
                let _ = git_output(&repo, &["branch", "-D", &branch]);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
