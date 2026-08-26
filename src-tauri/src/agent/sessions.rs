//! Comandos de sesiones de agente. La lógica vive en `bento_sessions`,
//! compartida con el daemon y el CLI.

#[tauri::command]
pub fn agent_codex_clear_lock(session_id: String) {
    bento_sessions::codex_clear_lock(&session_id);
}

#[tauri::command]
pub fn agent_codex_session_exists(session_id: String) -> bool {
    bento_sessions::codex_session_exists(&session_id)
}

#[tauri::command]
pub fn agent_claude_session_exists(cwd: String, session_id: String) -> bool {
    bento_sessions::claude_session_exists(&cwd, &session_id)
}

#[tauri::command]
pub fn agent_find_opencode_session(
    cwd: String,
    since_ms: u64,
    exclude: Vec<String>,
) -> Option<String> {
    bento_sessions::find_opencode_session(&cwd, since_ms, &exclude)
}
