//! Comandos de sincronización con origin. La lógica vive en
//! `bento_review::sync`, compartida con el daemon y el CLI.

pub use bento_review::sync::{FetchInfo, UpstreamStatus};

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_sync(
    path: String,
    base: String,
    mode: String,
    autostash: Option<bool>,
) -> Result<String, String> {
    blocking(move || bento_review::sync::sync(&path, &base, &mode, autostash.unwrap_or(false)))
        .await
}

#[tauri::command]
pub async fn git_push(path: String, force_with_lease: Option<bool>) -> Result<String, String> {
    blocking(move || bento_review::tasks::push(&path, force_with_lease.unwrap_or(false))).await
}

#[tauri::command]
pub async fn git_upstream_status(path: String) -> Result<UpstreamStatus, String> {
    blocking(move || bento_review::sync::upstream_status(&path)).await
}

#[tauri::command]
pub async fn git_fetch_info(path: String) -> Result<FetchInfo, String> {
    blocking(move || bento_review::sync::fetch_info(&path)).await
}

#[tauri::command]
pub async fn git_ahead_behind(path: String, base: String) -> Result<String, String> {
    blocking(move || bento_review::sync::ahead_behind(&path, &base)).await
}
