mod ask;
mod checkpoints;

pub use ask::ask_handler;
pub(crate) use ask::ask;
pub use checkpoints::{
    delete_checkpoint_handler, get_checkpoint_handler,
    list_checkpoints_handler, put_checkpoint_handler,
};
pub(crate) use checkpoints::{
    delete_checkpoint, get_checkpoint, list_checkpoint_metas, now_iso8601, save_checkpoint,
    Checkpoint,
};


use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Json, Response},
};
use futures_util::StreamExt;
use serde::Deserialize;
use std::sync::Arc;

use super::{Auth, RemoteState, authorized};
use bento_review::vcs::is_safe_branch;
pub(crate) use bento_review::pr::{
    add_comment, delete_comment, diff as pr_diff, discussion as pr_comments,
    list_open as list_prs, submit_review, update_comment,
};
pub(crate) use bento_review::vcs::{file_diff, list_branches, list_files};

// ── Query param structs ───────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ReviewQuery {
    pub token: Option<String>,
    pub cwd: Option<String>,
    pub base: Option<String>,
    pub branch: Option<String>,
    pub context: Option<String>,
    pub agents: Option<String>,
}

#[derive(Deserialize)]
pub struct ReviewFileQuery {
    pub token: Option<String>,
    pub cwd: Option<String>,
    pub base: Option<String>,
    pub path: Option<String>,
}

#[derive(Deserialize)]
pub struct PrQuery {
    pub token: Option<String>,
    pub cwd: Option<String>,
    pub pr: Option<u64>,
}

#[derive(Deserialize)]
pub struct PrCommentBody {
    pub body: String,
    #[allow(dead_code)]
    pub file: Option<String>,
    #[allow(dead_code)]
    pub line: Option<u64>,
}

#[derive(Deserialize)]
pub struct PrSubmitBody {
    pub event: String,
    pub body: Option<String>,
}

// ── Shell helpers ─────────────────────────────────────────────────────────────

// ── /api/review (SSE) ─────────────────────────────────────────────────────────

pub async fn review_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<ReviewQuery>,
) -> Response {
    let auth = Auth { token: q.token };
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd {
        Some(c) if !c.is_empty() => c,
        _ => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let base = q.base.unwrap_or_else(|| "main".into());
    if !is_safe_branch(&base) {
        return (StatusCode::BAD_REQUEST, "unsafe base").into_response();
    }
    let branch = q.branch.filter(|s| !s.is_empty());
    if let Some(ref br) = branch {
        if !is_safe_branch(br) {
            return (StatusCode::BAD_REQUEST, "unsafe branch").into_response();
        }
    }
    let context = q.context.unwrap_or_default();
    let agents = q.agents.unwrap_or_default();

    let (tx, rx) = tokio::sync::mpsc::channel::<String>(64);
    tokio::spawn(async move {
        run_review(cwd, base, branch, context, agents, tx).await;
    });

    let stream = tokio_stream::wrappers::ReceiverStream::new(rx)
        .map(|chunk| -> Result<axum::body::Bytes, std::convert::Infallible> {
            let encoded = serde_json::to_string(&chunk).unwrap_or_else(|_| "\"\"".to_string());
            Ok(axum::body::Bytes::from(format!("data: {}\n\n", encoded)))
        });

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("X-Accel-Buffering", "no")
        .body(Body::from_stream(stream))
        .unwrap()
}


/// Runs a full review and forwards it to the client as the flat text stream
/// this protocol has always spoken: control markers in `[BRACKETS]`, agent
/// text as-is. The review itself (validation, batching, multi-agent,
/// synthesis) lives in `bento_review::engine`, shared with the desktop app.
pub(crate) async fn run_review(cwd: String, base: String, branch: Option<String>, context: String, agents_raw: String, tx: tokio::sync::mpsc::Sender<String>) {
    use bento_review::engine::{run_review as engine_run, Agents, ReviewEvent, ReviewRequest};

    let request = ReviewRequest {
        cwd,
        base,
        context,
        agents: bento_review::engine::parse_agents(&agents_raw),
    };
    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<ReviewEvent>(64);
    let forwarding = tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            let line = match event {
                ReviewEvent::Content(text) => text,
                ReviewEvent::Batch { index, total } => format!("[BATCH:{index}/{total}]"),
                ReviewEvent::Synthesis => "[SYNTHESIS]".to_string(),
                ReviewEvent::Session { agent, id } => format!("[SESSION:{agent}:{id}]"),
                ReviewEvent::Error(message) => format!("[ERROR] {message}"),
                ReviewEvent::Done => "[DONE]".to_string(),
            };
            if tx.send(line).await.is_err() {
                break;
            }
        }
    });
    engine_run(&request, branch.as_deref(), &Agents, &event_tx).await;
    drop(event_tx);
    let _ = forwarding.await;
}

// ── /api/review/files ─────────────────────────────────────────────────────────

pub async fn review_files_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<ReviewFileQuery>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let base = q.base.unwrap_or_else(|| "main".into());
    if !is_safe_branch(&base) {
        return (StatusCode::BAD_REQUEST, "unsafe base").into_response();
    }
    match list_files(&cwd, &base) {
        Ok(list) => Json(list).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ── /api/review/file ──────────────────────────────────────────────────────────

pub async fn review_file_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<ReviewFileQuery>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let path = match q.path.filter(|s| !s.is_empty()) {
        Some(p) => p,
        None => return (StatusCode::BAD_REQUEST, "missing path").into_response(),
    };
    let base = q.base.unwrap_or_else(|| "main".into());
    match file_diff(&cwd, &path, &base) {
        Ok(diff) => (StatusCode::OK, [("content-type", "text/plain")], diff).into_response(),
        Err(_) => (StatusCode::BAD_REQUEST, "unsafe path or base").into_response(),
    }
}

// ── /api/review/prs ───────────────────────────────────────────────────────────

pub async fn review_prs_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<PrQuery>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    match list_prs(&cwd) {
        Ok(json_str) => (StatusCode::OK, [("content-type", "application/json")], json_str).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ── /api/review/pr/diff ───────────────────────────────────────────────────────

pub async fn review_pr_diff_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<PrQuery>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let pr = match q.pr {
        Some(n) => n,
        None => return (StatusCode::BAD_REQUEST, "missing pr").into_response(),
    };
    match pr_diff(&cwd, pr) {
        Ok(diff) => (StatusCode::OK, [("content-type", "text/plain")], diff).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ── /api/review/pr/comments ───────────────────────────────────────────────────

pub async fn review_pr_comments_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<PrQuery>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let pr = match q.pr {
        Some(n) => n,
        None => return (StatusCode::BAD_REQUEST, "missing pr").into_response(),
    };
    match pr_comments(&cwd, pr) {
        Ok(value) => Json(value).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ── /api/review/pr/comment (POST) ────────────────────────────────────────────

pub async fn review_pr_add_comment_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<PrQuery>,
    axum::Json(body): axum::Json<PrCommentBody>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let pr = match q.pr {
        Some(n) => n,
        None => return (StatusCode::BAD_REQUEST, "missing pr").into_response(),
    };
    match add_comment(&cwd, pr, &body.body) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ── /api/review/pr/comment/:id (PUT) ─────────────────────────────────────────

pub async fn review_pr_update_comment_handler(
    State(state): State<Arc<RemoteState>>,
    Path(id): Path<u64>,
    Query(q): Query<PrQuery>,
    axum::Json(body): axum::Json<PrCommentBody>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let pr = match q.pr {
        Some(n) => n,
        None => return (StatusCode::BAD_REQUEST, "missing pr").into_response(),
    };
    match update_comment(&cwd, pr, id, &body.body) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) if e == "comment does not belong to pr" => (StatusCode::FORBIDDEN, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ── /api/review/pr/comment/:id (DELETE) ──────────────────────────────────────

pub async fn review_pr_delete_comment_handler(
    State(state): State<Arc<RemoteState>>,
    Path(id): Path<u64>,
    Query(q): Query<PrQuery>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let pr = match q.pr {
        Some(n) => n,
        None => return (StatusCode::BAD_REQUEST, "missing pr").into_response(),
    };
    match delete_comment(&cwd, pr, id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) if e == "comment does not belong to pr" => (StatusCode::FORBIDDEN, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ── /api/review/pr/submit (POST) ─────────────────────────────────────────────

pub async fn review_pr_submit_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<PrQuery>,
    axum::Json(body): axum::Json<PrSubmitBody>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let pr = match q.pr {
        Some(n) => n,
        None => return (StatusCode::BAD_REQUEST, "missing pr").into_response(),
    };
    match submit_review(&cwd, pr, &body.event, body.body.as_deref().unwrap_or_default()) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ── /api/review/branches ──────────────────────────────────────────────────────

pub async fn review_branches_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<PrQuery>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    Json(list_branches(&cwd)).into_response()
}
