//! Validación de lo que llega del frontend antes de tocar la base de datos.
//! Es la frontera de confianza del panel de memoria: aquí no se recorta.

use super::{MemoryEntry, MemoryTranscript, MAX_LIST_ITEMS, MAX_LIST_ITEM_LENGTH, MAX_TEXT_LENGTH, MAX_TRANSCRIPT_LENGTH};

pub(super) fn validate_text(field: &str, value: &str, required: bool) -> Result<(), String> {
    if required && value.trim().is_empty() {
        return Err(format!("{field} es obligatorio"));
    }
    if value.len() > MAX_TEXT_LENGTH {
        return Err(format!(
            "{field} supera el límite de {MAX_TEXT_LENGTH} caracteres"
        ));
    }
    Ok(())
}

pub(super) fn validate_list(field: &str, values: &[String]) -> Result<(), String> {
    if values.len() > MAX_LIST_ITEMS {
        return Err(format!(
            "{field} admite como máximo {MAX_LIST_ITEMS} elementos"
        ));
    }
    if values
        .iter()
        .any(|value| value.len() > MAX_LIST_ITEM_LENGTH)
    {
        return Err(format!(
            "cada elemento de {field} admite como máximo {MAX_LIST_ITEM_LENGTH} caracteres"
        ));
    }
    Ok(())
}

pub(super) fn validate_entry(entry: &MemoryEntry) -> Result<(), String> {
    if !matches!(entry.kind.as_str(), "decision" | "fact" | "task" | "note") {
        return Err("kind debe ser decision, fact, task o note".to_string());
    }
    validate_text("id", &entry.id, true)?;
    // An empty path represents the global-memory panel.
    validate_text("projectPath", &entry.project_path, false)?;
    validate_text("title", &entry.title, false)?;
    validate_text("summary", &entry.summary, false)?;
    validate_text("details", &entry.details, false)?;
    validate_text("source", &entry.source, true)?;
    validate_text("externalId", &entry.external_id, false)?;
    validate_text("createdAt", &entry.created_at, true)?;
    validate_text("updatedAt", &entry.updated_at, true)?;
    validate_list("tags", &entry.tags)?;
    validate_list("files", &entry.files)?;
    if entry.title.trim().is_empty()
        && entry.summary.trim().is_empty()
        && entry.details.trim().is_empty()
    {
        return Err("title, summary o details es obligatorio".to_string());
    }
    Ok(())
}

pub(super) fn validate_transcript(entry: &MemoryTranscript) -> Result<(), String> {
    validate_text("id", &entry.id, true)?;
    validate_text("projectPath", &entry.project_path, false)?;
    validate_text("agent", &entry.agent, true)?;
    validate_text("sessionId", &entry.session_id, true)?;
    validate_text("title", &entry.title, true)?;
    validate_text("source", &entry.source, true)?;
    validate_text("externalId", &entry.external_id, true)?;
    validate_text("createdAt", &entry.created_at, true)?;
    validate_text("updatedAt", &entry.updated_at, true)?;
    if entry.transcript.trim().is_empty() {
        return Err("transcript es obligatorio".to_string());
    }
    if entry.transcript.len() > MAX_TRANSCRIPT_LENGTH {
        return Err(format!(
            "transcript supera el límite de {MAX_TRANSCRIPT_LENGTH} caracteres"
        ));
    }
    if !matches!(entry.agent.as_str(), "claude" | "codex") {
        return Err("agent debe ser claude o codex".to_string());
    }
    Ok(())
}
