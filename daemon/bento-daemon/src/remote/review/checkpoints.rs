//! HTTP handlers for the review checkpoint store. The store itself lives in
//! `bento_review::checkpoints`, shared with the desktop app and the CLI.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::Json,
};
use std::sync::Arc;

use super::super::{Auth, RemoteState, authorized};

pub use bento_review::checkpoints::{
    checkpoint_path, delete_checkpoint, get_checkpoint, list_checkpoint_metas, now_iso8601,
    save_checkpoint, Checkpoint, CheckpointMeta,
};

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
    Ok(Json(list_checkpoint_metas(cwd)))
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
    get_checkpoint(cwd, base).map(Json).ok_or(StatusCode::NOT_FOUND)
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
    match save_checkpoint(&cp) {
        Ok(()) => StatusCode::OK,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
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
    let _ = delete_checkpoint(cwd, base);
    StatusCode::OK
}
