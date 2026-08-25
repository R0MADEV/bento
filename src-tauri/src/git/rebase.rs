//! Comandos del rebase interactivo. La lógica vive en `bento_review::rebase`,
//! compartida con el daemon y el CLI.

pub use bento_review::rebase::RebaseStatus;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_rebase_start(path: String, base: String, todo_lines: Vec<String>) -> Result<(), String> {
    blocking(move || bento_review::rebase::start(&path, &base, &todo_lines)).await
}

#[tauri::command]
pub async fn git_rebase_preserve_merges(path: String, base: String) -> Result<String, String> {
    blocking(move || bento_review::rebase::preserve_merges(&path, &base)).await
}

#[tauri::command]
pub async fn git_rebase_continue(path: String) -> Result<String, String> {
    blocking(move || bento_review::rebase::continue_rebase(&path)).await
}

#[tauri::command]
pub async fn git_rebase_abort(path: String) -> Result<(), String> {
    blocking(move || bento_review::rebase::abort(&path)).await
}

#[tauri::command]
pub async fn git_rebase_split(path: String) -> Result<(), String> {
    blocking(move || bento_review::rebase::split(&path)).await
}

#[tauri::command]
pub async fn git_rebase_status(path: String) -> Result<RebaseStatus, String> {
    blocking(move || bento_review::rebase::status(&path)).await
}
