//! Los comandos de commit. La lógica vive en `bento_review::commit`, que
//! comparten el panel, el daemon y el CLI.

use bento_review::commit;

#[tauri::command]
pub async fn git_commit(
    path: String,
    message: String,
    amend: Option<bool>,
    files: Option<Vec<String>>,
    patch: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        commit::commit(
            &path,
            &message,
            amend.unwrap_or(false),
            files.as_deref(),
            patch.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_fixup(
    path: String,
    target: String,
    base: String,
    files: Option<Vec<String>>,
    patch: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        commit::fixup(&path, &target, &base, files.as_deref(), patch.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_branch_rename(path: String, new_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || commit::branch_rename(&path, &new_name))
        .await
        .map_err(|e| e.to_string())?
}
