use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager};

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

fn connection(app: &AppHandle) -> Result<Connection, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let conn = Connection::open(dir.join("memory.sqlite3")).map_err(|e| e.to_string())?;
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

fn clip(value: &str, max: usize) -> String {
    let clean = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= max {
        return clean;
    }
    clean.chars().take(max.saturating_sub(1)).collect::<String>() + "…"
}

fn file_timestamp(path: &Path) -> String {
    fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|secs| time::OffsetDateTime::from_unix_timestamp(secs.as_secs() as i64).ok())
        .and_then(|dt| dt.format(&time::format_description::well_known::Rfc3339).ok())
        .unwrap_or_else(now_iso)
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

fn supported(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| SUPPORTED_EXTENSIONS.contains(&ext))
        .unwrap_or(false)
}

fn excluded_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| EXCLUDED_DIR_NAMES.contains(&name))
        .unwrap_or(false)
}

fn collect_files(root: &Path, out: &mut Vec<PathBuf>) {
    if out.len() >= MAX_SCAN_FILES {
        return;
    }
    if root.is_file() {
        if supported(root) {
            out.push(root.to_path_buf());
        }
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_SCAN_FILES {
            break;
        }
        let path = entry.path();
        if path.is_dir() {
            if excluded_dir(&path) {
                continue;
            }
            collect_files(&path, out);
        } else if supported(&path) {
            out.push(path);
        }
    }
}

fn title_from_content(path: &Path, content: &str) -> String {
    if let Some(line) = content.lines().map(str::trim).find(|line| !line.is_empty()) {
        if let Some(stripped) = line.strip_prefix("# ") {
            return clip(stripped, 120);
        }
        if let Some(stripped) = line.strip_prefix("title:") {
            return clip(stripped.trim(), 120);
        }
        return clip(line, 120);
    }
    path.file_stem()
        .and_then(|name| name.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| "Resumen importado".to_string())
}

fn summary_from_content(content: &str) -> String {
    let clean = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect::<Vec<_>>()
        .join(" ");
    clip(&clean, 240)
}

fn details_from_content(content: &str) -> String {
    let trimmed = content.trim();
    if trimmed.chars().count() <= MAX_IMPORTED_DETAILS {
        return trimmed.to_string();
    }
    trimmed
        .chars()
        .take(MAX_IMPORTED_DETAILS.saturating_sub(1))
        .collect::<String>()
        + "…"
}

fn sanitize_tag(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .replace(|ch: char| !ch.is_alphanumeric() && ch != '-' && ch != '_', "-")
}

fn format_bytes(bytes: u64) -> String {
    const MB: u64 = 1024 * 1024;
    const KB: u64 = 1024;
    if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{bytes} B")
    }
}

fn is_lexis_index(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()) == Some("index.json")
        && path.to_string_lossy().contains("/.lexis/projects/")
}

fn read_prefix(path: &Path, max: usize) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buffer = vec![0u8; max];
    let bytes = file.read(&mut buffer).map_err(|e| e.to_string())?;
    buffer.truncate(bytes);
    Ok(String::from_utf8_lossy(&buffer).to_string())
}

fn extract_json_string(snippet: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":\"");
    let start = snippet.find(&needle)? + needle.len();
    let tail = &snippet[start..];
    let end = tail.find('"')?;
    Some(tail[..end].replace("\\/", "/"))
}

fn project_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| path.to_string())
}

fn candidate_from_lexis_index(source: &MemorySource, path: &Path) -> Option<ImportedMemoryCandidate> {
    let meta = fs::metadata(path).ok()?;
    let snippet = read_prefix(path, MAX_METADATA_READ_BYTES).ok()?;
    let path_text = path.to_string_lossy().to_string();
    let project_path = extract_json_string(&snippet, "projectPath")
        .unwrap_or_else(|| path.parent().and_then(|parent| parent.file_name()).and_then(|name| name.to_str()).unwrap_or("proyecto").to_string());
    let created_at = extract_json_string(&snippet, "createdAt").unwrap_or_else(|| file_timestamp(path));
    let size_label = format_bytes(meta.len());
    let project_label = project_name(&project_path);
    let label_tag = sanitize_tag(&source.label);
    Some(ImportedMemoryCandidate {
        title: format!("Lexis snapshot · {project_label}"),
        summary: format!("Snapshot de Lexis para {project_path} ({size_label}). Importado como metadatos para evitar cargar el índice completo."),
        details: format!(
            "Fuente: {}\nArchivo: {}\nProyecto indexado: {}\nCreado: {}\nTamaño: {}\n\nNota: Bento detectó un índice grande de Lexis y guardó solo metadatos reutilizables en vez del JSON completo.",
            source.label, path_text, project_path, created_at, size_label
        ),
        source: format!("source:{}", source.label),
        external_id: format!("source:{}:{}", source.id, path_text),
        created_at,
        files: vec![project_path, path_text],
        tags: vec![
            "imported".into(),
            "source".into(),
            "lexis".into(),
            "snapshot".into(),
            format!("source:{label_tag}"),
        ],
    })
}

fn candidate_from_large_file(source: &MemorySource, path: &Path) -> Option<ImportedMemoryCandidate> {
    let meta = fs::metadata(path).ok()?;
    let path_text = path.to_string_lossy().to_string();
    let label_tag = sanitize_tag(&source.label);
    Some(ImportedMemoryCandidate {
        title: path.file_stem().and_then(|name| name.to_str()).unwrap_or("Archivo grande").to_string(),
        summary: format!(
            "Archivo grande detectado ({}) en {}. Se importan solo metadatos para no saturar la memoria.",
            format_bytes(meta.len()),
            source.label
        ),
        details: format!(
            "Fuente: {}\nArchivo: {}\nTamaño: {}\n\nBento omitió el contenido completo porque supera el límite de importación segura.",
            source.label,
            path_text,
            format_bytes(meta.len())
        ),
        source: format!("source:{}", source.label),
        external_id: format!("source:{}:{}", source.id, path_text),
        created_at: file_timestamp(path),
        files: vec![path_text],
        tags: vec![
            "imported".into(),
            "source".into(),
            "large-file".into(),
            format!("source:{label_tag}"),
        ],
    })
}

fn candidate_from_file(source: &MemorySource, path: &Path) -> Option<ImportedMemoryCandidate> {
    if is_lexis_index(path) {
        return candidate_from_lexis_index(source, path);
    }
    let meta = fs::metadata(path).ok()?;
    if meta.len() > MAX_TEXT_FILE_BYTES {
        return candidate_from_large_file(source, path);
    }
    let content = fs::read_to_string(path).ok()?;
    if content.trim().is_empty() {
        return None;
    }
    let path_text = path.to_string_lossy().to_string();
    let label_tag = sanitize_tag(&source.label);
    Some(ImportedMemoryCandidate {
        title: title_from_content(path, &content),
        summary: summary_from_content(&content),
        details: details_from_content(&content),
        source: format!("source:{}", source.label),
        external_id: format!("source:{}:{}", source.id, path_text),
        created_at: file_timestamp(path),
        files: vec![path_text],
        tags: vec![
            "imported".into(),
            "source".into(),
            format!("source:{label_tag}"),
        ],
    })
}

fn scan_candidates(source: &MemorySource, limit: Option<usize>) -> Result<Vec<ImportedMemoryCandidate>, String> {
    if source.kind != "filesystem" {
        return Err("Solo se soportan fuentes filesystem por ahora".to_string());
    }
    let mut files = Vec::new();
    collect_files(Path::new(&source.path), &mut files);
    files.sort();
    let max = limit.unwrap_or(20).min(MAX_SCAN_FILES);
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for file in files.into_iter().take(max) {
        let key = file.to_string_lossy().to_string();
        if !seen.insert(key) {
            continue;
        }
        if let Some(candidate) = candidate_from_file(source, &file) {
            out.push(candidate);
        }
    }
    Ok(out)
}

#[tauri::command]
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

#[tauri::command]
pub fn memory_source_list(app: AppHandle, project_path: String) -> Result<Vec<MemorySource>, String> {
    let conn = connection(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, project_path, kind, label, path, created_at, updated_at
             FROM memory_sources WHERE project_path = ?1 ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![project_path.trim()], row_to_source)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn memory_source_create(app: AppHandle, source: MemorySource) -> Result<MemorySource, String> {
    let conn = connection(&app)?;
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

#[tauri::command]
pub fn memory_source_remove(app: AppHandle, project_path: String, id: String) -> Result<bool, String> {
    let conn = connection(&app)?;
    Ok(conn
        .execute(
            "DELETE FROM memory_sources WHERE project_path = ?1 AND id = ?2",
            params![project_path.trim(), id],
        )
        .map_err(|e| e.to_string())?
        > 0)
}

#[tauri::command]
pub fn memory_source_scan(
    app: AppHandle,
    project_path: String,
    id: String,
    limit: Option<usize>,
) -> Result<Vec<ImportedMemoryCandidate>, String> {
    let conn = connection(&app)?;
    let source = find_source(&conn, &project_path, &id)?;
    scan_candidates(&source, limit)
}

#[tauri::command]
pub fn memory_source_import(
    app: AppHandle,
    project_path: String,
    id: String,
    limit: Option<usize>,
) -> Result<usize, String> {
    let conn = connection(&app)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_title_and_summary_from_markdown() {
        let path = Path::new("/tmp/demo.md");
        let content = "# Resumen\n\nEsto es una nota reutilizable.\n\nMás detalle.";
        assert_eq!(title_from_content(path, content), "Resumen");
        assert!(summary_from_content(content).contains("Esto es una nota reutilizable"));
    }

    #[test]
    fn details_are_clipped() {
        let content = "a".repeat(MAX_IMPORTED_DETAILS + 20);
        let clipped = details_from_content(&content);
        assert!(clipped.chars().count() <= MAX_IMPORTED_DETAILS);
    }

    #[test]
    fn detects_lexis_index_paths() {
        assert!(is_lexis_index(Path::new("/Users/test/.lexis/projects/demo/index.json")));
        assert!(!is_lexis_index(Path::new("/Users/test/notes/index.json")));
    }

    #[test]
    fn extracts_json_string_from_snippet() {
        let snippet = r#"{"projectPath":"/tmp/demo","createdAt":"2026-07-28T10:00:00Z"}"#;
        assert_eq!(extract_json_string(snippet, "projectPath").as_deref(), Some("/tmp/demo"));
        assert_eq!(extract_json_string(snippet, "createdAt").as_deref(), Some("2026-07-28T10:00:00Z"));
    }
}
