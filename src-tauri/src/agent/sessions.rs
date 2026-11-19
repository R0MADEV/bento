//! Comandos de sesiones de agente. La lógica vive en `bento_sessions`,
//! compartida con el daemon y el CLI.

/// The line that brings `agent` back in a terminal opened in `cwd`, by the same
/// rules the daemon resumes with. `None` for an agent those rules don't cover.
#[tauri::command]
pub fn agent_resume_line(agent: String, cwd: String, session_id: Option<String>, config_dir: Option<String>) -> Option<String> {
    let record = bento_sessions::AgentRecord::to_resume(&agent, session_id, config_dir, cwd.clone());
    bento_sessions::resume_line_for_shell(&record, &cwd)
}

/// `session_id` when an agent run in `cwd` can continue it, by the rule the
/// daemon answers a review's follow-up with; `None` means starting afresh.
#[tauri::command]
pub fn agent_resumable_session(agent: String, cwd: String, session_id: String) -> Option<String> {
    bento_sessions::resumable_in_place(&bento_sessions::AgentRecord::to_resume(&agent, Some(session_id), None, cwd))
}

#[tauri::command]
pub fn agent_find_opencode_session(
    cwd: String,
    since_ms: u64,
    exclude: Vec<String>,
) -> Option<String> {
    bento_sessions::find_opencode_session(&cwd, since_ms, &exclude)
}
