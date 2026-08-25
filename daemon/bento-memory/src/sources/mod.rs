use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS memory_entries (
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
CREATE UNIQUE INDEX IF NOT EXISTS memory_entries_project_external_id
  ON memory_entries(project_path, external_id) WHERE external_id <> '';
CREATE INDEX IF NOT EXISTS memory_entries_project_updated
  ON memory_entries(project_path, updated_at DESC);
CREATE TABLE IF NOT EXISTS memory_sources (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_sources_project_updated
  ON memory_sources(project_path, updated_at DESC);";

const MAX_IMPORTED_DETAILS: usize = 8_000;
const MAX_SCAN_FILES: usize = 200;
const MAX_TEXT_FILE_BYTES: u64 = 1_000_000;
const MAX_METADATA_READ_BYTES: usize = 64 * 1024;
const SUPPORTED_EXTENSIONS: &[&str] = &["md", "markdown", "txt", "json", "jsonl"];
const EXCLUDED_DIR_NAMES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    ".pnpm-store",
    "dist",
    "build",
    "target",
    ".next",
    ".nuxt",
    ".cache",
    ".turbo",
    "coverage",
];

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySource {
    pub id: String,
    pub project_path: String,
    pub kind: String,
    pub label: String,
    pub path: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMemoryCandidate {
    pub title: String,
    pub summary: String,
    pub details: String,
    pub source: String,
    pub external_id: String,
    pub created_at: String,
    pub files: Vec<String>,
    pub tags: Vec<String>,
}

pub mod scan;

use scan::{now_iso, scan_candidates};

fn connection(data_dir: &Path) -> Result<Connection, String> {
    fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let conn = Connection::open(data_dir.join("memory.sqlite3")).map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn row_to_source(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemorySource> {
    Ok(MemorySource {
        id: row.get(0)?,
        project_path: row.get(1)?,
        kind: row.get(2)?,
        label: row.get(3)?,
        path: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

pub fn memory_source_scan_path(
    path: String,
    label: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<ImportedMemoryCandidate>, String> {
    let trimmed_path = path.trim();
    if trimmed_path.is_empty() {
        return Err("path es obligatorio".to_string());
    }
    let guessed_label = label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            Path::new(trimmed_path)
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "fuente".to_string());
    let source = MemorySource {
        id: "preview".to_string(),
        project_path: String::new(),
        kind: "filesystem".to_string(),
        label: guessed_label,
        path: trimmed_path.to_string(),
        created_at: now_iso(),
        updated_at: now_iso(),
    };
    scan_candidates(&source, limit)
}

fn find_source(conn: &Connection, project_path: &str, id: &str) -> Result<MemorySource, String> {
    conn.query_row(
        "SELECT id, project_path, kind, label, path, created_at, updated_at
         FROM memory_sources WHERE project_path = ?1 AND id = ?2 LIMIT 1",
        params![project_path.trim(), id],
        row_to_source,
    )
    .map_err(|e| e.to_string())
}

fn entry_exists(conn: &Connection, project_path: &str, external_id: &str) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(1) FROM memory_entries WHERE project_path = ?1 AND external_id = ?2",
            params![project_path.trim(), external_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(count > 0)
}

pub fn memory_source_list(
    data_dir: &Path,
    project_path: String,
) -> Result<Vec<MemorySource>, String> {
    let conn = connection(data_dir)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, project_path, kind, label, path, created_at, updated_at
             FROM memory_sources WHERE project_path = ?1 ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_path.trim()], row_to_source)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn memory_source_create(data_dir: &Path, source: MemorySource) -> Result<MemorySource, String> {
    let conn = connection(data_dir)?;
    if source.kind != "filesystem" {
        return Err("kind debe ser filesystem".to_string());
    }
    if source.label.trim().is_empty() || source.path.trim().is_empty() {
        return Err("label y path son obligatorios".to_string());
    }
    conn.execute(
        "INSERT INTO memory_sources (id, project_path, kind, label, path, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, path = excluded.path, updated_at = excluded.updated_at",
        params![
            source.id,
            source.project_path.trim(),
            source.kind,
            source.label.trim(),
            source.path.trim(),
            source.created_at,
            source.updated_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(source)
}

pub fn memory_source_remove(
    data_dir: &Path,
    project_path: String,
    id: String,
) -> Result<bool, String> {
    let conn = connection(data_dir)?;
    Ok(conn
        .execute(
            "DELETE FROM memory_sources WHERE project_path = ?1 AND id = ?2",
            params![project_path.trim(), id],
        )
        .map_err(|e| e.to_string())?
        > 0)
}

pub fn memory_source_scan(
    data_dir: &Path,
    project_path: String,
    id: String,
    limit: Option<usize>,
) -> Result<Vec<ImportedMemoryCandidate>, String> {
    let conn = connection(data_dir)?;
    let source = find_source(&conn, &project_path, &id)?;
    scan_candidates(&source, limit)
}

pub fn memory_source_import(
    data_dir: &Path,
    project_path: String,
    id: String,
    limit: Option<usize>,
) -> Result<usize, String> {
    let conn = connection(data_dir)?;
    let source = find_source(&conn, &project_path, &id)?;
    let candidates = scan_candidates(&source, limit)?;
    let mut imported = 0;
    for candidate in candidates {
        if entry_exists(&conn, &project_path, &candidate.external_id)? {
            continue;
        }
        conn.execute(
            "INSERT INTO memory_entries (id, project_path, kind, title, summary, details, tags_json, files_json, source, external_id, created_at, updated_at)
             VALUES (?1, ?2, 'note', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                uuid::Uuid::new_v4().to_string(),
                project_path.trim(),
                candidate.title,
                candidate.summary,
                candidate.details,
                serde_json::to_string(&candidate.tags).map_err(|e| e.to_string())?,
                serde_json::to_string(&candidate.files).map_err(|e| e.to_string())?,
                candidate.source,
                candidate.external_id,
                candidate.created_at,
                now_iso(),
            ],
        )
        .map_err(|e| e.to_string())?;
        imported += 1;
    }
    Ok(imported)
}
