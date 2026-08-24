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

/// Writes `cp` to its checkpoint file — shared by the HTTP `PUT
/// /api/review/checkpoint` handler (the web panel saves incrementally as
/// batches complete) and the daemon's IPC socket (`review.checkpoint_save`,
/// called once after a `review.run` finishes so `review.ask` has something
/// to resume).
pub(crate) fn save_checkpoint(cp: &Checkpoint) -> Result<(), String> {
    let dir = checkpoints_dir().ok_or_else(|| "no home dir".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = checkpoint_path(&cp.cwd, &cp.base).ok_or_else(|| "bad checkpoint path".to_string())?;
    let raw = serde_json::to_string(cp).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

/// A JS-`Date`-parseable UTC timestamp with no extra crate: the daemon
/// workspace has no date/time dependency, so this hand-rolls the
/// epoch-seconds → calendar-date conversion (Howard Hinnant's
/// `civil_from_days`) — used when the IPC caller (the TUI, not a browser)
/// has no `Date.toISOString()` of its own to send.
pub(crate) fn now_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    iso8601_from_unix_secs(secs)
}

fn iso8601_from_unix_secs(secs: u64) -> String {
    let (days, rem) = (secs / 86400, secs % 86400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
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
    let Some(path) = checkpoint_path(cwd, base) else { return StatusCode::INTERNAL_SERVER_ERROR };
    let _ = std::fs::remove_file(path);
    StatusCode::OK
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_zero_is_the_unix_epoch_date() {
        assert_eq!(iso8601_from_unix_secs(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn known_timestamp_round_trips_correctly() {
        // 1700000000 is a commonly-cited round Unix timestamp.
        assert_eq!(iso8601_from_unix_secs(1_700_000_000), "2023-11-14T22:13:20Z");
    }

    #[test]
    fn end_of_a_leap_year_day_is_february_29() {
        // 2024-02-29T12:00:00Z (2024 is a leap year).
        assert_eq!(iso8601_from_unix_secs(1_709_208_000), "2024-02-29T12:00:00Z");
    }
}
