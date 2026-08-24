use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct ImportedMemory {
    title: String,
    summary: String,
    details: String,
    source: String,
    external_id: String,
    created_at: String,
    files: Vec<String>,
    tags: Vec<String>,
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .map_err(|_| "no home dir".to_string())
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .ok()
        .into_iter()
        .flat_map(|text| {
            text.lines()
                .map(str::trim)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|line| !line.is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .collect()
}

fn short(text: &str, max: usize) -> String {
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= max {
        return clean;
    }
    clean
        .chars()
        .take(max.saturating_sub(1))
        .collect::<String>()
        + "…"
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !value.is_empty() && !list.contains(&value) {
        list.push(value);
    }
}

fn sanitize_project_path(project_path: &str) -> String {
    format!("-{}", project_path.trim_matches('/').replace('/', "-"))
}

#[tauri::command]
pub fn memory_import_claude(
    project_path: String,
    limit: Option<usize>,
) -> Result<Vec<ImportedMemory>, String> {
    let dir = home_dir()?
        .join(".claude")
        .join("projects")
        .join(sanitize_project_path(&project_path));
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|_| format!("No existe historial de Claude para {}", project_path))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .collect();
    files.sort();
    files.reverse();

    let mut out = Vec::new();
    for path in files.into_iter().take(limit.unwrap_or(10)) {
        let rows = read_jsonl(&path);
        let mut first_user = String::new();
        let mut last_assistant = String::new();
        let mut created_at = String::new();
        let mut files = Vec::new();
        for row in rows {
            if created_at.is_empty() {
                created_at = row
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
            }
            if row.get("type").and_then(Value::as_str) == Some("user") && first_user.is_empty() {
                if let Some(text) = row.pointer("/message/content").and_then(Value::as_str) {
                    first_user = text.to_string();
                }
            }
            if row.get("type").and_then(Value::as_str) == Some("assistant") {
                if let Some(content) = row.pointer("/message/content").and_then(Value::as_array) {
                    for chunk in content {
                        if chunk.get("type").and_then(Value::as_str) == Some("text") {
                            if let Some(text) = chunk.get("text").and_then(Value::as_str) {
                                last_assistant = text.to_string();
                            }
                        }
                    }
                }
            }
            if row.get("type").and_then(Value::as_str) == Some("user") {
                if let Some(content) = row.pointer("/message/content").and_then(Value::as_array) {
                    for chunk in content {
                        if let Some(text) = chunk.get("text").and_then(Value::as_str) {
                            if text.starts_with("FILE: ") {
                                let file = text
                                    .trim_start_matches("FILE: ")
                                    .split(" (showing lines ")
                                    .next()
                                    .unwrap_or("")
                                    .trim()
                                    .to_string();
                                push_unique(&mut files, file);
                            }
                        }
                    }
                }
            }
        }
        if first_user.is_empty() && last_assistant.is_empty() {
            continue;
        }
        let session_id = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("claude-session");
        out.push(ImportedMemory {
            title: short(&first_user, 80),
            summary: short(&last_assistant, 240),
            details: format!("Prompt:\n{}\n\nRespuesta:\n{}", first_user, last_assistant),
            source: "claude".into(),
            external_id: format!("claude:{}", session_id),
            created_at,
            files,
            tags: vec!["imported".into(), "claude".into()],
        });
    }
    Ok(out)
}

fn codex_session_meta_matches(row: &Value, project_path: &str) -> bool {
    row.get("type").and_then(Value::as_str) == Some("session_meta")
        && row.pointer("/payload/cwd").and_then(Value::as_str) == Some(project_path)
}

#[tauri::command]
pub fn memory_import_codex(
    project_path: String,
    limit: Option<usize>,
) -> Result<Vec<ImportedMemory>, String> {
    let base = home_dir()?.join(".codex").join("sessions");
    let mut session_files = Vec::new();
    for year in fs::read_dir(&base).map_err(|_| "No existe historial de Codex".to_string())? {
        let year = match year {
            Ok(v) => v.path(),
            Err(_) => continue,
        };
        for month in match fs::read_dir(&year) {
            Ok(v) => v,
            Err(_) => continue,
        } {
            let month = match month {
                Ok(v) => v.path(),
                Err(_) => continue,
            };
            for day in match fs::read_dir(&month) {
                Ok(v) => v,
                Err(_) => continue,
            } {
                let day = match day {
                    Ok(v) => v.path(),
                    Err(_) => continue,
                };
                for file in match fs::read_dir(&day) {
                    Ok(v) => v,
                    Err(_) => continue,
                } {
                    let path = match file {
                        Ok(v) => v.path(),
                        Err(_) => continue,
                    };
                    if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
                        session_files.push(path);
                    }
                }
            }
        }
    }
    session_files.sort();
    session_files.reverse();

    let mut out = Vec::new();
    for path in session_files {
        let rows = read_jsonl(&path);
        if !rows
            .iter()
            .any(|row| codex_session_meta_matches(row, &project_path))
        {
            continue;
        }
        let mut first_user = String::new();
        let mut last_assistant = String::new();
        let mut created_at = String::new();
        for row in &rows {
            if created_at.is_empty() {
                created_at = row
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
            }
            if first_user.is_empty() {
                if let Some(text) = row
                    .pointer("/payload/content/0/text")
                    .and_then(Value::as_str)
                {
                    if row.pointer("/payload/role").and_then(Value::as_str) == Some("user") {
                        first_user = text.to_string();
                    }
                }
                if first_user.is_empty() {
                    if let Some(text) = row.pointer("/payload/message").and_then(Value::as_str) {
                        if row.get("type").and_then(Value::as_str) == Some("event_msg")
                            && row.pointer("/payload/type").and_then(Value::as_str)
                                == Some("user_message")
                        {
                            first_user = text.to_string();
                        }
                    }
                }
            }
            if let Some(text) = row
                .pointer("/payload/content/0/text")
                .and_then(Value::as_str)
            {
                if row.pointer("/payload/role").and_then(Value::as_str) == Some("assistant") {
                    last_assistant = text.to_string();
                }
            }
            if let Some(text) = row.pointer("/payload/message").and_then(Value::as_str) {
                if row.get("type").and_then(Value::as_str) == Some("event_msg")
                    && row.pointer("/payload/type").and_then(Value::as_str) == Some("agent_message")
                {
                    last_assistant = text.to_string();
                }
            }
        }
        if first_user.is_empty() && last_assistant.is_empty() {
            continue;
        }
        let session_id = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("codex-session");
        out.push(ImportedMemory {
            title: short(&first_user, 80),
            summary: short(&last_assistant, 240),
            details: format!("Prompt:\n{}\n\nRespuesta:\n{}", first_user, last_assistant),
            source: "codex".into(),
            external_id: format!("codex:{}", session_id),
            created_at,
            files: Vec::new(),
            tags: vec!["imported".into(), "codex".into()],
        });
        if out.len() >= limit.unwrap_or(10) {
            break;
        }
    }
    Ok(out)
}
