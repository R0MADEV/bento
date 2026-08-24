//! El panel de memoria: tipos, comandos de Tauri y el trabajo de resumen.
//! La validación vive en `validate` y el acceso a datos en `db`.

mod db;
mod validate;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

pub(super) const MAX_TEXT_LENGTH: usize = 20_000;
pub(super) const MAX_LIST_ITEMS: usize = 100;
pub(super) const MAX_LIST_ITEM_LENGTH: usize = 500;
pub(super) const MAX_TRANSCRIPT_LENGTH: usize = 200_000;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: String,
    pub project_path: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub details: String,
    pub tags: Vec<String>,
    pub files: Vec<String>,
    pub source: String,
    pub external_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPatch {
    pub kind: Option<String>,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub details: Option<String>,
    pub tags: Option<Vec<String>>,
    pub files: Option<Vec<String>>,
    pub source: Option<String>,
    pub external_id: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTranscript {
    pub id: String,
    pub project_path: String,
    pub agent: String,
    pub session_id: String,
    pub title: String,
    pub transcript: String,
    pub summary: String,
    pub source: String,
    pub external_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySummaryJob {
    pub id: String,
    pub project_path: String,
    pub agent: String,
    pub session_id: String,
    pub transcript_external_id: String,
    pub transcript_hash: String,
    pub status: String,
    pub error: String,
    pub attempts: i64,
    pub metadata_json: String,
    pub created_at: String,
    pub updated_at: String,
}

use db::{connection, encode, find_by_external_id, find_transcript_by_summary_external_id, regenerate_transcript_summary, row_to_entry, row_to_summary_job, row_to_transcript, upsert_summary_entry};
use validate::{validate_entry, validate_transcript};

#[tauri::command]
pub fn memory_list(app: AppHandle, project_path: String) -> Result<Vec<MemoryEntry>, String> {
    let conn = connection(&app)?;
    let mut stmt = conn.prepare(
        "SELECT id, project_path, kind, title, summary, details, tags_json, files_json, source, external_id, created_at, updated_at
         FROM memory_entries WHERE project_path = ?1 ORDER BY updated_at DESC",
    ).map_err(|e| e.to_string())?;
    let entries = stmt
        .query_map(params![project_path.trim()], row_to_entry)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(entries)
}

#[tauri::command]
pub fn memory_list_all(app: AppHandle) -> Result<Vec<MemoryEntry>, String> {
    let conn = connection(&app)?;
    let mut stmt = conn.prepare(
        "SELECT id, project_path, kind, title, summary, details, tags_json, files_json, source, external_id, created_at, updated_at
         FROM memory_entries ORDER BY updated_at DESC",
    ).map_err(|e| e.to_string())?;
    let entries = stmt
        .query_map([], row_to_entry)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(entries)
}

#[tauri::command]
pub fn memory_create(app: AppHandle, entry: MemoryEntry) -> Result<MemoryEntry, String> {
    let conn = connection(&app)?;
    validate_entry(&entry)?;
    if !entry.external_id.trim().is_empty() {
        let existing = find_by_external_id(&conn, &entry.project_path, &entry.external_id)?;
        if let Some(existing) = existing {
            return Ok(existing);
        }
    }
    conn.execute(
        "INSERT INTO memory_entries (id, project_path, kind, title, summary, details, tags_json, files_json, source, external_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![entry.id, entry.project_path.trim(), entry.kind, entry.title, entry.summary, entry.details,
          encode(&entry.tags)?, encode(&entry.files)?, entry.source, entry.external_id, entry.created_at, entry.updated_at],
    ).map_err(|e| e.to_string())?;
    Ok(entry)
}

#[tauri::command]
pub fn memory_update(
    app: AppHandle,
    project_path: String,
    id: String,
    patch: MemoryPatch,
    updated_at: String,
) -> Result<Option<MemoryEntry>, String> {
    let conn = connection(&app)?;
    let current = conn.query_row(
        "SELECT id, project_path, kind, title, summary, details, tags_json, files_json, source, external_id, created_at, updated_at
         FROM memory_entries WHERE project_path = ?1 AND id = ?2",
        params![project_path.trim(), id], row_to_entry,
    ).optional().map_err(|e| e.to_string())?;
    let Some(mut entry) = current else {
        return Ok(None);
    };
    if let Some(value) = patch.kind {
        entry.kind = value;
    }
    if let Some(value) = patch.title {
        entry.title = value;
    }
    if let Some(value) = patch.summary {
        entry.summary = value;
    }
    if let Some(value) = patch.details {
        entry.details = value;
    }
    if let Some(value) = patch.tags {
        entry.tags = value;
    }
    if let Some(value) = patch.files {
        entry.files = value;
    }
    if let Some(value) = patch.source {
        entry.source = value;
    }
    if let Some(value) = patch.external_id {
        entry.external_id = value;
    }
    entry.updated_at = updated_at;
    validate_entry(&entry)?;
    conn.execute(
        "UPDATE memory_entries SET kind = ?1, title = ?2, summary = ?3, details = ?4, tags_json = ?5, files_json = ?6,
         source = ?7, external_id = ?8, updated_at = ?9 WHERE project_path = ?10 AND id = ?11",
        params![entry.kind, entry.title, entry.summary, entry.details, encode(&entry.tags)?, encode(&entry.files)?,
          entry.source, entry.external_id, entry.updated_at, entry.project_path, entry.id],
    ).map_err(|e| e.to_string())?;
    Ok(Some(entry))
}

#[tauri::command]
pub fn memory_remove(app: AppHandle, project_path: String, id: String) -> Result<bool, String> {
    let conn = connection(&app)?;
    Ok(conn
        .execute(
            "DELETE FROM memory_entries WHERE project_path = ?1 AND id = ?2",
            params![project_path.trim(), id],
        )
        .map_err(|e| e.to_string())?
        > 0)
}

#[tauri::command]
pub fn memory_migrate(app: AppHandle, entries: Vec<MemoryEntry>) -> Result<usize, String> {
    let mut conn = connection(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut migrated = 0;
    for entry in entries {
        validate_entry(&entry)?;
        migrated += tx.execute(
            "INSERT OR IGNORE INTO memory_entries (id, project_path, kind, title, summary, details, tags_json, files_json, source, external_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![entry.id, entry.project_path.trim(), entry.kind, entry.title, entry.summary, entry.details,
              encode(&entry.tags)?, encode(&entry.files)?, entry.source, entry.external_id, entry.created_at, entry.updated_at],
        ).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(migrated)
}

#[tauri::command]
pub fn memory_transcript_list(
    app: AppHandle,
    project_path: String,
) -> Result<Vec<MemoryTranscript>, String> {
    let conn = connection(&app)?;
    let mut stmt = conn.prepare(
        "SELECT id, project_path, agent, session_id, title, transcript, summary, source, external_id, created_at, updated_at
         FROM memory_transcripts WHERE project_path = ?1 ORDER BY updated_at DESC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_path.trim()], row_to_transcript)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn memory_summary_job_list(
    app: AppHandle,
    project_path: String,
) -> Result<Vec<MemorySummaryJob>, String> {
    let conn = connection(&app)?;
    let select = "SELECT id, project_path, agent, session_id, transcript_external_id, transcript_hash,
                  status, error, attempts, metadata_json, created_at, updated_at FROM memory_summary_jobs";
    if project_path.trim().is_empty() {
        let mut stmt = conn
            .prepare(&format!("{select} ORDER BY updated_at DESC LIMIT 100"))
            .map_err(|e| e.to_string())?;
        return stmt
            .query_map([], row_to_summary_job)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string());
    }
    let mut stmt = conn
        .prepare(&format!(
            "{select} WHERE project_path = ?1 ORDER BY updated_at DESC LIMIT 100"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_path.trim()], row_to_summary_job)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn memory_transcript_create(
    app: AppHandle,
    entry: MemoryTranscript,
) -> Result<MemoryTranscript, String> {
    let conn = connection(&app)?;
    validate_transcript(&entry)?;
    conn.execute(
        "INSERT INTO memory_transcripts (id, project_path, agent, session_id, title, transcript, summary, source, external_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(project_path, external_id) WHERE external_id <> ''
         DO UPDATE SET title = excluded.title, transcript = excluded.transcript, summary = excluded.summary, source = excluded.source, updated_at = excluded.updated_at",
        params![
            entry.id,
            entry.project_path,
            entry.agent,
            entry.session_id,
            entry.title,
            entry.transcript,
            entry.summary,
            entry.source,
            entry.external_id,
            entry.created_at,
            entry.updated_at
        ],
    ).map_err(|e| e.to_string())?;
    Ok(entry)
}

#[tauri::command]
pub fn memory_regenerate_summary(
    app: AppHandle,
    project_path: String,
    external_id: String,
) -> Result<Option<MemoryEntry>, String> {
    let conn = connection(&app)?;
    let Some(mut transcript) =
        find_transcript_by_summary_external_id(&conn, &project_path, &external_id)?
    else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE memory_summary_jobs SET status = 'processing', error = '', updated_at = ?1
         WHERE project_path = ?2 AND transcript_external_id = ?3",
        params![
            chrono_like_now(),
            transcript.project_path,
            transcript.external_id
        ],
    )
    .map_err(|e| e.to_string())?;
    let summary = match regenerate_transcript_summary(
        &transcript.agent,
        &transcript.project_path,
        &transcript.transcript,
    ) {
        Ok(value) => value,
        Err(error) => {
            conn.execute(
                "UPDATE memory_summary_jobs SET status = 'failed', error = ?1, attempts = attempts + 1, updated_at = ?2
                 WHERE project_path = ?3 AND transcript_external_id = ?4",
                params![error, chrono_like_now(), transcript.project_path, transcript.external_id],
            ).map_err(|e| e.to_string())?;
            return Ok(None);
        }
    };
    if summary.is_empty()
        || summary.eq_ignore_ascii_case("SIN_MEMORIA")
        || summary.to_lowercase().contains("not logged in")
    {
        let status = if summary.eq_ignore_ascii_case("SIN_MEMORIA") {
            "skipped"
        } else {
            "failed"
        };
        let error = if status == "failed" {
            "El resumidor no devolvió un resultado válido."
        } else {
            ""
        };
        conn.execute(
            "UPDATE memory_summary_jobs SET status = ?1, error = ?2, attempts = attempts + 1, updated_at = ?3
             WHERE project_path = ?4 AND transcript_external_id = ?5",
            params![status, error, chrono_like_now(), transcript.project_path, transcript.external_id],
        ).map_err(|e| e.to_string())?;
        return Ok(None);
    }
    transcript.summary = summary.clone();
    transcript.updated_at = chrono_like_now();
    conn.execute(
        "UPDATE memory_transcripts SET summary = ?1, updated_at = ?2 WHERE project_path = ?3 AND id = ?4",
        params![
            transcript.summary.clone(),
            transcript.updated_at.clone(),
            transcript.project_path.clone(),
            transcript.id.clone()
        ],
    ).map_err(|e| e.to_string())?;
    let entry = upsert_summary_entry(&conn, &transcript, &summary)?;
    conn.execute(
        "UPDATE memory_summary_jobs SET status = 'completed', error = '', attempts = attempts + 1, updated_at = ?1
         WHERE project_path = ?2 AND transcript_external_id = ?3",
        params![transcript.updated_at, transcript.project_path, transcript.external_id],
    ).map_err(|e| e.to_string())?;
    Ok(Some(entry))
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let tm =
        time::OffsetDateTime::from_unix_timestamp(secs).unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    tm.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

#[cfg(test)]
mod tests {
    use super::db::{find_by_external_id, init_schema};
    use super::*;
    use rusqlite::Connection;

    fn sample_entry(external_id: &str) -> MemoryEntry {
        MemoryEntry {
            id: format!("id-{external_id}"),
            project_path: "/tmp/bento".into(),
            kind: "note".into(),
            title: "Resumen".into(),
            summary: "Resumen corto".into(),
            details: "Detalle reutilizable".into(),
            tags: vec!["memory".into()],
            files: vec!["src/main.ts".into()],
            source: "test".into(),
            external_id: external_id.into(),
            created_at: "2026-07-28T20:00:00.000Z".into(),
            updated_at: "2026-07-28T20:00:00.000Z".into(),
        }
    }

    fn sample_transcript(external_id: &str) -> MemoryTranscript {
        MemoryTranscript {
            id: format!("transcript-{external_id}"),
            project_path: "/tmp/bento".into(),
            agent: "codex".into(),
            session_id: "abc".into(),
            title: "Sesion codex: bento".into(),
            transcript: "user: hola\nassistant: revision".into(),
            summary: "Resumen corto".into(),
            source: "codex-session-end".into(),
            external_id: external_id.into(),
            created_at: "2026-07-28T20:00:00.000Z".into(),
            updated_at: "2026-07-28T20:00:00.000Z".into(),
        }
    }

    #[test]
    fn validate_entry_requires_content() {
        let mut entry = sample_entry("ext-1");
        entry.title.clear();
        entry.summary.clear();
        entry.details.clear();
        assert_eq!(
            validate_entry(&entry).unwrap_err(),
            "title, summary o details es obligatorio"
        );
    }

    #[test]
    fn schema_enforces_unique_external_id_per_project() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let entry = sample_entry("ext-1");
        conn.execute(
            "INSERT INTO memory_entries (id, project_path, kind, title, summary, details, tags_json, files_json, source, external_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                entry.id,
                entry.project_path,
                entry.kind,
                entry.title,
                entry.summary,
                entry.details,
                encode(&entry.tags).unwrap(),
                encode(&entry.files).unwrap(),
                entry.source,
                entry.external_id,
                entry.created_at,
                entry.updated_at
            ],
        )
        .unwrap();

        let duplicate = sample_entry("ext-1");
        let err = conn
            .execute(
                "INSERT INTO memory_entries (id, project_path, kind, title, summary, details, tags_json, files_json, source, external_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    "id-2",
                    duplicate.project_path,
                    duplicate.kind,
                    duplicate.title,
                    duplicate.summary,
                    duplicate.details,
                    encode(&duplicate.tags).unwrap(),
                    encode(&duplicate.files).unwrap(),
                    duplicate.source,
                    duplicate.external_id,
                    duplicate.created_at,
                    duplicate.updated_at
                ],
            )
            .unwrap_err();

        assert!(err.to_string().contains("UNIQUE constraint failed"));
    }

    #[test]
    fn find_by_external_id_returns_existing_entry() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let entry = sample_entry("ext-2");
        conn.execute(
            "INSERT INTO memory_entries (id, project_path, kind, title, summary, details, tags_json, files_json, source, external_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                entry.id,
                entry.project_path,
                entry.kind,
                entry.title,
                entry.summary,
                entry.details,
                encode(&entry.tags).unwrap(),
                encode(&entry.files).unwrap(),
                entry.source,
                entry.external_id,
                entry.created_at,
                entry.updated_at
            ],
        )
        .unwrap();

        let found = find_by_external_id(&conn, "/tmp/bento", "ext-2").unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().source, "test");
    }

    #[test]
    fn transcript_schema_enforces_unique_external_id_per_project() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let entry = sample_transcript("codex:session-transcript:abc");
        conn.execute(
            "INSERT INTO memory_transcripts (id, project_path, agent, session_id, title, transcript, summary, source, external_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                entry.id,
                entry.project_path,
                entry.agent,
                entry.session_id,
                entry.title,
                entry.transcript,
                entry.summary,
                entry.source,
                entry.external_id,
                entry.created_at,
                entry.updated_at
            ],
        )
        .unwrap();

        let duplicate = sample_transcript("codex:session-transcript:abc");
        let err = conn
            .execute(
                "INSERT INTO memory_transcripts (id, project_path, agent, session_id, title, transcript, summary, source, external_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    "transcript-2",
                    duplicate.project_path,
                    duplicate.agent,
                    duplicate.session_id,
                    duplicate.title,
                    duplicate.transcript,
                    duplicate.summary,
                    duplicate.source,
                    duplicate.external_id,
                    duplicate.created_at,
                    duplicate.updated_at
                ],
            )
            .unwrap_err();

        assert!(err.to_string().contains("UNIQUE constraint failed"));
    }
}
