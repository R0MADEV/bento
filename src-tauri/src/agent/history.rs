//! Comandos del scrollback de los agentes. La lógica vive en
//! `bento_sessions`, compartida con el daemon y el CLI.

#[tauri::command]
pub fn agent_history_load(scope: String) -> Result<String, String> {
    bento_sessions::history_load(&scope)
}

#[tauri::command]
pub fn agent_history_save(scope: String, content: String) -> Result<(), String> {
    bento_sessions::history_save(&scope, &content)
}

#[tauri::command]
pub fn agent_history_clear(scope: String) -> Result<(), String> {
    bento_sessions::history_clear(&scope)
}
