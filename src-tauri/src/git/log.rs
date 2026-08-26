//! Los comandos del historial. La lógica vive en `bento_review::log`, que
//! comparten el panel, el daemon y el CLI.

pub use bento_review::log::{CommitEntry, CommitFile};

use bento_review::log;

#[tauri::command]
pub async fn git_log(
    path: String,
    limit: u32,
    no_merges: Option<bool>,
) -> Result<Vec<CommitEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || log::log(&path, limit, no_merges.unwrap_or(false)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_graph(path: String, base: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || log::graph(&path, &base))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_rebase_log(path: String, base: String) -> Result<Vec<CommitEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || log::rebase_log(&path, &base))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_merge_log(path: String, base: String) -> Result<Vec<CommitEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || log::merge_log(&path, &base))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_ref_diff(path: String, base: String, target: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || log::ref_diff(&path, &base, &target))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_rev_parse(path: String, reference: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || log::rev_parse(&path, &reference))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_show_files(path: String, hash: String) -> Result<Vec<CommitFile>, String> {
    tauri::async_runtime::spawn_blocking(move || log::show_files(&path, &hash))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_show_commit_diff(
    path: String,
    hash: String,
    file: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        log::show_commit_diff(&path, &hash, file.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_show_file(path: String, hash: String, file: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || log::show_file(&path, &hash, &file))
        .await
        .map_err(|error| error.to_string())?
}
