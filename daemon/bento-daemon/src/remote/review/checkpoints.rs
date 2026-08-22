use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::Json,
};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc};

use super::super::{Auth, RemoteState, authorized};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Checkpoint {
    pub cwd: String,
    pub base: String,
    pub content: String,
    pub saved_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_agent: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CheckpointMeta {
    pub base: String,
    pub saved_at: String,
}

fn checkpoints_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".bento").join("review-checkpoints"))
}

// Stable FNV-1a 64-bit — no extra deps needed.
fn fnv1a(s: &str) -> String {
    let mut h: u64 = 14695981039346656037;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    format!("{:016x}", h)
}

pub fn checkpoint_path(cwd: &str, base: &str) -> Option<PathBuf> {
    checkpoints_dir().map(|d| d.join(format!("{}.json", fnv1a(&format!("{}:{}", cwd, base)))))
}

// GET /api/review/checkpoints?cwd=…
pub async fn list_checkpoints_handler(
    State(state): State<Arc<RemoteState>>,
    Query(auth): Query<Auth>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Vec<CheckpointMeta>>, StatusCode> {
    if !authorized(&state, &auth) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let cwd = params.get("cwd").ok_or(StatusCode::BAD_REQUEST)?;
    let dir = checkpoints_dir().ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    if !dir.exists() {
        return Ok(Json(vec![]));
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Json(vec![]));
    };
    let mut metas: Vec<CheckpointMeta> = entries
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|raw| serde_json::from_str::<Checkpoint>(&raw).ok())
        .filter(|cp| cp.cwd == *cwd)
        .map(|cp| CheckpointMeta { base: cp.base, saved_at: cp.saved_at })
        .collect();
    metas.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(Json(metas))
}

// GET /api/review/checkpoint?cwd=…&base=…
pub async fn get_checkpoint_handler(
    State(state): State<Arc<RemoteState>>,
    Query(auth): Query<Auth>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Checkpoint>, StatusCode> {
    if !authorized(&state, &auth) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let cwd = params.get("cwd").ok_or(StatusCode::BAD_REQUEST)?;
    let base = params.get("base").ok_or(StatusCode::BAD_REQUEST)?;
    let path = checkpoint_path(cwd, base).ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    let raw = std::fs::read_to_string(path).map_err(|_| StatusCode::NOT_FOUND)?;
    serde_json::from_str::<Checkpoint>(&raw).map(Json).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

// PUT /api/review/checkpoint  (body: Checkpoint JSON)
pub async fn put_checkpoint_handler(
    State(state): State<Arc<RemoteState>>,
    Query(auth): Query<Auth>,
    Json(cp): Json<Checkpoint>,
) -> StatusCode {
    if !authorized(&state, &auth) {
        return StatusCode::UNAUTHORIZED;
    }
    if cp.content.trim().is_empty() {
        return StatusCode::BAD_REQUEST;
    }
    let Some(dir) = checkpoints_dir() else { return StatusCode::INTERNAL_SERVER_ERROR };
    if std::fs::create_dir_all(&dir).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    let Some(path) = checkpoint_path(&cp.cwd, &cp.base) else { return StatusCode::INTERNAL_SERVER_ERROR };
    let Ok(raw) = serde_json::to_string(&cp) else { return StatusCode::INTERNAL_SERVER_ERROR };
    if std::fs::write(path, raw).is_err() { StatusCode::INTERNAL_SERVER_ERROR } else { StatusCode::OK }
}

// DELETE /api/review/checkpoint?cwd=…&base=…
pub async fn delete_checkpoint_handler(
    State(state): State<Arc<RemoteState>>,
    Query(auth): Query<Auth>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> StatusCode {
    if !authorized(&state, &auth) {
        return StatusCode::UNAUTHORIZED;
    }
    let Some(cwd) = params.get("cwd") else { return StatusCode::BAD_REQUEST };
    let Some(base) = params.get("base") else { return StatusCode::BAD_REQUEST };
    let Some(path) = checkpoint_path(cwd, base) else { return StatusCode::INTERNAL_SERVER_ERROR };
    let _ = std::fs::remove_file(path);
    StatusCode::OK
}
