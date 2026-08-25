//! Los comandos de importación de transcripciones. El trabajo vive en
//! `bento_memory::import`.

pub use bento_memory::import::ImportedMemory;

#[tauri::command]
pub fn memory_import_claude(
    project_path: String,
    limit: Option<usize>,
) -> Result<Vec<ImportedMemory>, String> {
    bento_memory::import::memory_import_claude(project_path, limit)
}

#[tauri::command]
pub fn memory_import_codex(
    project_path: String,
    limit: Option<usize>,
) -> Result<Vec<ImportedMemory>, String> {
    bento_memory::import::memory_import_codex(project_path, limit)
}
