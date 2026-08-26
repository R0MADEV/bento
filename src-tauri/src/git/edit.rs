//! Comandos para editar el worktree. La lógica vive en `bento_review::edit`,
//! compartida con el daemon y el CLI; aquí solo queda abrir el editor, que es
//! del escritorio.

use std::process::Command;

use bento_review::edit;

use super::login_shell_output;
use crate::command_error::CommandError;

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

async fn blocking_command<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, CommandError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| CommandError::runtime(e.to_string()))?
        .map_err(CommandError::git)
}

#[tauri::command]
pub async fn git_resolve_conflict(path: String, file: String, side: String) -> Result<(), String> {
    blocking(move || edit::resolve_conflict(&path, &file, &side)).await
}

#[tauri::command]
pub async fn git_add_files(path: String, files: Vec<String>) -> Result<(), CommandError> {
    blocking_command(move || edit::add_files(&path, &files)).await
}

#[tauri::command]
pub async fn git_read_file(path: String, file: String) -> Result<String, CommandError> {
    blocking_command(move || edit::read_file(&path, &file)).await
}

#[tauri::command]
pub async fn git_write_file(
    path: String,
    file: String,
    content: String,
) -> Result<(), CommandError> {
    blocking_command(move || edit::write_file(&path, &file, &content)).await
}

#[tauri::command]
pub async fn git_reset(path: String, target: String, mode: Option<String>) -> Result<(), String> {
    blocking(move || edit::reset(&path, &target, mode.as_deref())).await
}

// Abrir el editor es del escritorio: no tiene sentido por IPC ni en el CLI.
#[tauri::command]
pub async fn open_in_editor(path: String) -> Result<(), String> {
    blocking(move || {
        for editor in &["cursor", "code"] {
            if let Some(found) = login_shell_output(&format!("command -v {editor}")) {
                let bin_path = found.trim().to_string();
                if !bin_path.is_empty() && Command::new(&bin_path).arg(&path).spawn().is_ok() {
                    return Ok(());
                }
            }
        }
        #[cfg(target_os = "macos")]
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        #[cfg(target_os = "linux")]
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        #[cfg(target_os = "windows")]
        Command::new("explorer.exe")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}
