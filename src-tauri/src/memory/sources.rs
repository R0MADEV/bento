//! Los comandos de las fuentes de memoria. El escaneo y el almacén viven en
//! `bento_memory::sources`.

pub use bento_memory::sources::{ImportedMemoryCandidate, MemorySource};

use tauri::{AppHandle, Manager};

/// Tauri es quien sabe dónde guarda sus datos la app; la crate opera sobre el
/// directorio ya resuelto.
fn data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn memory_source_scan_path(
    path: String,
    label: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<ImportedMemoryCandidate>, String> {
    bento_memory::sources::memory_source_scan_path(path, label, limit)
}

#[tauri::command]
pub fn memory_source_list(
    app: AppHandle,
    project_path: String,
) -> Result<Vec<MemorySource>, String> {
    bento_memory::sources::memory_source_list(&data_dir(&app)?, project_path)
}

#[tauri::command]
pub fn memory_source_create(app: AppHandle, source: MemorySource) -> Result<MemorySource, String> {
    bento_memory::sources::memory_source_create(&data_dir(&app)?, source)
}

#[tauri::command]
pub fn memory_source_remove(
    app: AppHandle,
    project_path: String,
    id: String,
) -> Result<bool, String> {
    bento_memory::sources::memory_source_remove(&data_dir(&app)?, project_path, id)
}

#[tauri::command]
pub fn memory_source_scan(
    app: AppHandle,
    project_path: String,
    id: String,
    limit: Option<usize>,
) -> Result<Vec<ImportedMemoryCandidate>, String> {
    bento_memory::sources::memory_source_scan(&data_dir(&app)?, project_path, id, limit)
}

#[tauri::command]
pub fn memory_source_import(
    app: AppHandle,
    project_path: String,
    id: String,
    limit: Option<usize>,
) -> Result<usize, String> {
    bento_memory::sources::memory_source_import(&data_dir(&app)?, project_path, id, limit)
}
