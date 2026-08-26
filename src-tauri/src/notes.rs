//! Los comandos de notas. El almacén vive en `bento_notes`, que comparten el
//! desktop, el daemon y el CLI.

pub use bento_notes::NoteFile;

#[tauri::command]
pub fn notes_list() -> Result<Vec<NoteFile>, String> {
    bento_notes::list()
}

#[tauri::command]
pub fn notes_write(name: String, content: String) -> Result<(), String> {
    bento_notes::write(&name, &content)
}

#[tauri::command]
pub fn notes_delete(name: String) -> Result<(), String> {
    bento_notes::delete(&name)
}
