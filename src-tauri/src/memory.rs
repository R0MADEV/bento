use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::io::Write;
use tauri::{AppHandle, Manager};

const MAX_TEXT_LENGTH: usize = 20_000;
const MAX_LIST_ITEMS: usize = 100;
const MAX_LIST_ITEM_LENGTH: usize = 500;
const MEMORY_SCHEMA: &str = "PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS memory_entries (
            id TEXT PRIMARY KEY,
            project_path TEXT NOT NULL,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            details TEXT NOT NULL,
            tags_json TEXT NOT NULL,
            files_json TEXT NOT NULL,
            source TEXT NOT NULL,
            external_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memory_entries_project_updated
          ON memory_entries(project_path, updated_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS memory_entries_project_external_id
          ON memory_entries(project_path, external_id) WHERE external_id <> '';
        CREATE TABLE IF NOT EXISTS memory_transcripts (
            id TEXT PRIMARY KEY,
            project_path TEXT NOT NULL,
            agent TEXT NOT NULL,
            session_id TEXT NOT NULL,
            title TEXT NOT NULL,
            transcript TEXT NOT NULL,
            summary TEXT NOT NULL,
            source TEXT NOT NULL,
            external_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memory_transcripts_project_updated
          ON memory_transcripts(project_path, updated_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS memory_transcripts_project_external_id
          ON memory_transcripts(project_path, external_id) WHERE external_id <> '';
        CREATE TABLE IF NOT EXISTS memory_summary_jobs (
            id TEXT PRIMARY KEY,
            project_path TEXT NOT NULL,
            agent TEXT NOT NULL,
            session_id TEXT NOT NULL,
            transcript_external_id TEXT NOT NULL,
            transcript_hash TEXT NOT NULL,
            status TEXT NOT NULL,
            error TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            metadata_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS memory_summary_jobs_transcript
          ON memory_summary_jobs(project_path, transcript_external_id);
        CREATE INDEX IF NOT EXISTS memory_summary_jobs_status_updated
          ON memory_summary_jobs(status, updated_at DESC);
        PRAGMA user_version = 2;";
const MAX_TRANSCRIPT_LENGTH: usize = 200_000;

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

fn connection(app: &AppHandle) -> Result<Connection, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let conn = Connection::open(dir.join("memory.sqlite3")).map_err(|e| e.to_string())?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(MEMORY_SCHEMA).map_err(|e| e.to_string())
}

fn validate_text(field: &str, value: &str, required: bool) -> Result<(), String> {
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

fn validate_list(field: &str, values: &[String]) -> Result<(), String> {
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

fn validate_entry(entry: &MemoryEntry) -> Result<(), String> {
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

fn validate_transcript(entry: &MemoryTranscript) -> Result<(), String> {
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

fn encode(values: &[String]) -> Result<String, String> {
    serde_json::to_string(values).map_err(|e| e.to_string())
}

fn decode(value: String) -> Vec<String> {
    serde_json::from_str(&value).unwrap_or_default()
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryEntry> {
    Ok(MemoryEntry {
        id: row.get(0)?,
        project_path: row.get(1)?,
        kind: row.get(2)?,
        title: row.get(3)?,
        summary: row.get(4)?,
        details: row.get(5)?,
        tags: decode(row.get(6)?),
        files: decode(row.get(7)?),
        source: row.get(8)?,
        external_id: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn row_to_transcript(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryTranscript> {
    Ok(MemoryTranscript {
        id: row.get(0)?,
        project_path: row.get(1)?,
        agent: row.get(2)?,
        session_id: row.get(3)?,
        title: row.get(4)?,
        transcript: row.get(5)?,
        summary: row.get(6)?,
        source: row.get(7)?,
        external_id: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn row_to_summary_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemorySummaryJob> {
    Ok(MemorySummaryJob {
        id: row.get(0)?,
        project_path: row.get(1)?,
        agent: row.get(2)?,
        session_id: row.get(3)?,
        transcript_external_id: row.get(4)?,
        transcript_hash: row.get(5)?,
        status: row.get(6)?,
        error: row.get(7)?,
        attempts: row.get(8)?,
        metadata_json: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn find_by_external_id(
    conn: &Connection,
    project_path: &str,
    external_id: &str,
) -> Result<Option<MemoryEntry>, String> {
    conn.query_row(
        "SELECT id, project_path, kind, title, summary, details, tags_json, files_json, source, external_id, created_at, updated_at
         FROM memory_entries WHERE project_path = ?1 AND external_id = ?2 LIMIT 1",
        params![project_path.trim(), external_id],
        row_to_entry,
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn find_transcript_by_summary_external_id(
    conn: &Connection,
    project_path: &str,
    external_id: &str,
) -> Result<Option<MemoryTranscript>, String> {
    let session_id = external_id
        .rsplit(':')
        .next()
        .ok_or_else(|| "externalId invalido".to_string())?;
    let agent = if external_id.starts_with("claude:") {
        "claude"
    } else if external_id.starts_with("codex:") {
        "codex"
    } else {
        return Err("externalId invalido".to_string());
    };
    conn.query_row(
        "SELECT id, project_path, agent, session_id, title, transcript, summary, source, external_id, created_at, updated_at
         FROM memory_transcripts WHERE project_path = ?1 AND agent = ?2 AND session_id = ?3 LIMIT 1",
        params![project_path.trim(), agent, session_id],
        row_to_transcript,
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn upsert_summary_entry(conn: &Connection, transcript: &MemoryTranscript, summary: &str) -> Result<MemoryEntry, String> {
    let external_id = format!("{}:session-summary:{}", transcript.agent, transcript.session_id);
    let title = format!(
        "Resumen de sesion: {}",
        transcript
            .project_path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("bento")
    );
    if let Some(existing) = find_by_external_id(conn, &transcript.project_path, &external_id)? {
        conn.execute(
            "UPDATE memory_entries SET title = ?1, summary = ?2, details = ?3, tags_json = ?4, source = ?5, updated_at = ?6
             WHERE project_path = ?7 AND external_id = ?8",
            params![
                title,
                summary.chars().take(500).collect::<String>(),
                summary,
                encode(&["session-summary".to_string(), transcript.agent.clone()])?,
                format!("{}-regen", transcript.agent),
                transcript.updated_at,
                transcript.project_path,
                external_id
            ],
        ).map_err(|e| e.to_string())?;
        return Ok(MemoryEntry {
            title,
            summary: summary.chars().take(500).collect(),
            details: summary.to_string(),
            updated_at: transcript.updated_at.clone(),
            source: format!("{}-regen", transcript.agent),
            ..existing
        });
    }
    let entry = MemoryEntry {
        id: format!("summary-{}", transcript.session_id),
        project_path: transcript.project_path.clone(),
        kind: "note".into(),
        title,
        summary: summary.chars().take(500).collect(),
        details: summary.to_string(),
        tags: vec!["session-summary".into(), transcript.agent.clone()],
        files: vec![],
        source: format!("{}-regen", transcript.agent),
        external_id,
        created_at: transcript.created_at.clone(),
        updated_at: transcript.updated_at.clone(),
    };
    validate_entry(&entry)?;
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
            encode(&entry.tags)?,
            encode(&entry.files)?,
            entry.source,
            entry.external_id,
            entry.created_at,
            entry.updated_at
        ],
    ).map_err(|e| e.to_string())?;
    Ok(entry)
}

fn regenerate_transcript_summary(agent: &str, cwd: &str, transcript: &str) -> Result<String, String> {
    let script_path = std::env::var("BENTO_MEMORY_REGEN_SCRIPT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/bento-memory-regenerate.mjs"));
    let node_bin = std::env::var("BENTO_MEMORY_NODE_BIN").unwrap_or_else(|_| "node".to_string());
    let payload = serde_json::json!({
        "agent": agent,
        "cwd": cwd,
        "transcript": transcript,
    })
    .to_string();
    let mut child = Command::new(node_bin)
        .arg(script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(payload.as_bytes()).map_err(|e| e.to_string())?;
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

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
pub fn memory_transcript_list(app: AppHandle, project_path: String) -> Result<Vec<MemoryTranscript>, String> {
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
pub fn memory_summary_job_list(app: AppHandle, project_path: String) -> Result<Vec<MemorySummaryJob>, String> {
    let conn = connection(&app)?;
    let select = "SELECT id, project_path, agent, session_id, transcript_external_id, transcript_hash,
                  status, error, attempts, metadata_json, created_at, updated_at FROM memory_summary_jobs";
    if project_path.trim().is_empty() {
        let mut stmt = conn.prepare(&format!("{select} ORDER BY updated_at DESC LIMIT 100"))
            .map_err(|e| e.to_string())?;
        return stmt.query_map([], row_to_summary_job)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string());
    }
    let mut stmt = conn.prepare(&format!("{select} WHERE project_path = ?1 ORDER BY updated_at DESC LIMIT 100"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![project_path.trim()], row_to_summary_job)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn memory_transcript_create(app: AppHandle, entry: MemoryTranscript) -> Result<MemoryTranscript, String> {
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
    let Some(mut transcript) = find_transcript_by_summary_external_id(&conn, &project_path, &external_id)? else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE memory_summary_jobs SET status = 'processing', error = '', updated_at = ?1
         WHERE project_path = ?2 AND transcript_external_id = ?3",
        params![chrono_like_now(), transcript.project_path, transcript.external_id],
    ).map_err(|e| e.to_string())?;
    let summary = match regenerate_transcript_summary(&transcript.agent, &transcript.project_path, &transcript.transcript) {
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
        let status = if summary.eq_ignore_ascii_case("SIN_MEMORIA") { "skipped" } else { "failed" };
        let error = if status == "failed" { "El resumidor no devolvió un resultado válido." } else { "" };
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
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs() as i64;
    let tm = time::OffsetDateTime::from_unix_timestamp(secs).unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    tm.format(&time::format_description::well_known::Rfc3339).unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

#[cfg(test)]
mod tests {
    use super::*;

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
