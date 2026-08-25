//! Comandos del historial del chat. La lógica vive en `bento_sessions`,
//! compartida con el daemon y el CLI.

#[tauri::command]
pub fn chat_history_load() -> Result<String, String> {
    bento_sessions::chat_load()
}

#[tauri::command]
pub fn chat_history_save(content: String) -> Result<(), String> {
    bento_sessions::chat_save(&content)
}
