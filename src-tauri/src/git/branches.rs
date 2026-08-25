//! Los comandos de ramas. La lógica vive en `bento_review::branches`, que
//! comparten el panel, el daemon y el CLI.

use bento_review::branches;

#[tauri::command]
pub async fn git_default_branch(repo: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(branches::default_branch(&repo)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_remote_branches(repo: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || branches::remote_branches(&repo))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_all_remote_branches(repo: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || branches::all_remote_branches(&repo))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_review_branches(repo: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || branches::review_branches(&repo))
        .await
        .map_err(|error| error.to_string())?
}
