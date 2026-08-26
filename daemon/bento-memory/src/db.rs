//! La base de datos de memoria: conexión, esquema y el mapeo de filas a los
//! tipos del panel.

use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::path::Path;

use super::validate::validate_entry;
use super::{MemoryEntry, MemorySummaryJob, MemoryTranscript};

// El esquema vive con el código que lo aplica.
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


pub(crate) fn connection(data_dir: &Path) -> Result<Connection, String> {
    fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let conn = Connection::open(data_dir.join("memory.sqlite3")).map_err(|e| e.to_string())?;
    init_schema(&conn)?;
    Ok(conn)
}

pub(crate) fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(MEMORY_SCHEMA).map_err(|e| e.to_string())
}

pub(crate) fn encode(values: &[String]) -> Result<String, String> {
    serde_json::to_string(values).map_err(|e| e.to_string())
}

pub(crate) fn decode(value: String) -> Vec<String> {
    serde_json::from_str(&value).unwrap_or_default()
}

pub(crate) fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryEntry> {
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

pub(crate) fn row_to_transcript(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryTranscript> {
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

pub(crate) fn row_to_summary_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemorySummaryJob> {
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

pub(crate) fn find_by_external_id(
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

pub(crate) fn find_transcript_by_summary_external_id(
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

pub(crate) fn upsert_summary_entry(
    conn: &Connection,
    transcript: &MemoryTranscript,
    summary: &str,
) -> Result<MemoryEntry, String> {
    let external_id = format!(
        "{}:session-summary:{}",
        transcript.agent, transcript.session_id
    );
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

pub(crate) fn regenerate_transcript_summary(
    agent: &str,
    cwd: &str,
    transcript: &str,
) -> Result<String, String> {
    let script_path = std::env::var("BENTO_MEMORY_REGEN_SCRIPT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/bento-memory-regenerate.mjs")
        });
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
        stdin
            .write_all(payload.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
