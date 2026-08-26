//! Comandos de respaldo. La lógica vive en `bento_review::backup`, compartida
//! con el daemon y el CLI.

pub use bento_review::backup::{BackupEntry, BackupStatus};

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_backup_status(path: String) -> Result<BackupStatus, String> {
    blocking(move || bento_review::backup::status(&path)).await
}

#[tauri::command]
pub async fn git_backup_list(path: String) -> Result<Vec<BackupEntry>, String> {
    blocking(move || bento_review::backup::list(&path)).await
}

#[tauri::command]
pub async fn git_backup_diff(path: String, target: String) -> Result<String, String> {
    blocking(move || bento_review::backup::diff(&path, &target)).await
}

#[tauri::command]
pub async fn git_restore_backup(path: String, target: Option<String>) -> Result<(), String> {
    blocking(move || bento_review::backup::restore(&path, target)).await
}
