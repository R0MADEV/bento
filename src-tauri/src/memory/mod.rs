//! Los comandos del panel de memoria. Los tipos, la validación y el acceso a
//! datos viven en `bento_memory`, que comparten el desktop, el daemon y el CLI.

pub mod import;
pub mod sources;

pub use bento_memory::{MemoryEntry, MemoryPatch, MemorySummaryJob, MemoryTranscript};

use tauri::{AppHandle, Manager};

/// Tauri es quien sabe dónde guarda sus datos la app; la crate opera sobre el
/// directorio ya resuelto.
fn data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn memory_list(app: AppHandle, project_path: String) -> Result<Vec<MemoryEntry>, String> {
    bento_memory::memory_list(&data_dir(&app)?, project_path)
}

#[tauri::command]
pub fn memory_list_all(app: AppHandle) -> Result<Vec<MemoryEntry>, String> {
    bento_memory::memory_list_all(&data_dir(&app)?)
}

#[tauri::command]
pub fn memory_create(app: AppHandle, entry: MemoryEntry) -> Result<MemoryEntry, String> {
    bento_memory::memory_create(&data_dir(&app)?, entry)
}

#[tauri::command]
pub fn memory_update(
    app: AppHandle,
    project_path: String,
    id: String,
    patch: MemoryPatch,
    updated_at: String,
) -> Result<Option<MemoryEntry>, String> {
    bento_memory::memory_update(&data_dir(&app)?, project_path, id, patch, updated_at)
}

#[tauri::command]
pub fn memory_remove(app: AppHandle, project_path: String, id: String) -> Result<bool, String> {
    bento_memory::memory_remove(&data_dir(&app)?, project_path, id)
}

#[tauri::command]
pub fn memory_migrate(app: AppHandle, entries: Vec<MemoryEntry>) -> Result<usize, String> {
    bento_memory::memory_migrate(&data_dir(&app)?, entries)
}

#[tauri::command]
pub fn memory_transcript_list(
    app: AppHandle,
    project_path: String,
) -> Result<Vec<MemoryTranscript>, String> {
    bento_memory::memory_transcript_list(&data_dir(&app)?, project_path)
}

#[tauri::command]
pub fn memory_summary_job_list(
    app: AppHandle,
    project_path: String,
) -> Result<Vec<MemorySummaryJob>, String> {
    bento_memory::memory_summary_job_list(&data_dir(&app)?, project_path)
}

#[tauri::command]
pub fn memory_transcript_create(
    app: AppHandle,
    entry: MemoryTranscript,
) -> Result<MemoryTranscript, String> {
    bento_memory::memory_transcript_create(&data_dir(&app)?, entry)
}

#[tauri::command]
pub fn memory_regenerate_summary(
    app: AppHandle,
    project_path: String,
    external_id: String,
) -> Result<Option<MemoryEntry>, String> {
    bento_memory::memory_regenerate_summary(&data_dir(&app)?, project_path, external_id)
}
