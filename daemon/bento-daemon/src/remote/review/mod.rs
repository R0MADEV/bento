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
use bento_review::diff::{batch_file_diffs, split_diff_into_file_diffs};
use bento_review::vcs::{diff_no_index, is_safe_branch, untracked_files};
pub(crate) use bento_review::pr::{
    add_comment, delete_comment, diff as pr_diff, discussion as pr_comments,
    list_open as list_prs, submit_review, update_comment,
};
pub(crate) use bento_review::vcs::{file_diff, list_branches, list_files};
use bento_review::{build_review_prompt, build_synthesis_prompt, ReviewPromptInput};

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

fn parse_agents(raw: &str) -> Vec<String> {
    let filtered: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|s| matches!(*s, "claude" | "opencode" | "codex"))
        .map(String::from)
        .collect();
    if filtered.is_empty() { vec!["claude".to_string()] } else { filtered }
}

/// Runs a full (possibly multi-agent, batched) code review and streams
/// progress/output through `tx`, finishing with `[DONE]`. Shared by the HTTP
/// `/api/review` SSE handler and the daemon's IPC socket (`review.run`) —
/// `base`/`branch` are re-validated here (not just at the HTTP layer) so the
/// IPC caller, which has no query-param validation of its own, gets the same
/// protection against unsafe git refs.
pub(crate) async fn run_review(cwd: String, base: String, branch: Option<String>, context: String, agents_raw: String, tx: tokio::sync::mpsc::Sender<String>) {
    let send = |msg: String| {
        let tx = tx.clone();
        async move { let _ = tx.send(msg).await; }
    };

    if !is_safe_branch(&base) {
        send("[ERROR] rama base inválida".into()).await;
        return;
    }
    if let Some(ref br) = branch {
        if !is_safe_branch(br) {
            send("[ERROR] rama inválida".into()).await;
            return;
        }
    }
    let agents = parse_agents(&agents_raw);

    // When a specific branch is given, diff that branch vs base (committed changes only).
    // Otherwise diff the working tree vs base and also include untracked files.
    let diff_out = if let Some(ref br) = branch {
        let range = format!("{}..{}", base, br);
        match tokio::process::Command::new("git")
            .args(["-C", &cwd, "diff", &range])
            .output()
            .await
        {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
            Ok(o) => {
                send(format!("[ERROR] git diff falló: {}", String::from_utf8_lossy(&o.stderr).trim())).await;
                return;
            }
            Err(e) => { send(format!("[ERROR] no se pudo ejecutar git: {e}")).await; return; }
        }
    } else {
        let tracked_diff = match tokio::process::Command::new("git")
            .args(["-C", &cwd, "diff", &base])
            .output()
            .await
        {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
            Ok(o) => {
                send(format!("[ERROR] git diff falló: {}", String::from_utf8_lossy(&o.stderr).trim())).await;
                return;
            }
            Err(e) => { send(format!("[ERROR] no se pudo ejecutar git: {e}")).await; return; }
        };

        let cwd_clone = cwd.clone();
        let untracked_diff = tokio::task::spawn_blocking(move || {
            untracked_files(&cwd_clone)
                .into_iter()
                .map(|p| diff_no_index(&cwd_clone, &p))
                .filter(|d| !d.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .await
        .unwrap_or_default();

        if untracked_diff.is_empty() { tracked_diff } else { format!("{tracked_diff}\n{untracked_diff}") }
    };

    if diff_out.trim().is_empty() {
        send("[ERROR] No hay cambios respecto a la rama base.".into()).await;
        return;
    }

    let is_multi_agent = agents.len() > 1;
    let mut reports: Vec<(String, String)> = Vec::new();

    if is_multi_agent {
        let total = agents.len();
        for (i, agent) in agents.iter().enumerate() {
            send(format!("[BATCH:{}/{}]", i + 1, total)).await;
            let review_prompt = build_review_prompt(&ReviewPromptInput::new(&cwd, &base, &diff_out, &context));
            match run_agent_collecting(agent, &cwd, &review_prompt, &tx).await {
                Some((report, _)) => reports.push((format!("Agente {}/{} ({})", i + 1, total, agent), report)),
                None => { send(format!("[ERROR] {} no encontrado o falló", agent)).await; return; }
            }
        }
        if reports.len() >= 2 {
            send("[SYNTHESIS]".into()).await;
            let truncated: Vec<(String, String)> = reports.iter()
                .map(|(l, r)| (l.clone(), r.chars().take(8_000).collect()))
                .collect();
            let refs: Vec<(&str, &str)> = truncated.iter().map(|(l, r)| (l.as_str(), r.as_str())).collect();
            let synthesis = build_synthesis_prompt(
                &refs,
                "Escribe el informe final directamente, sin preámbulo. Empieza con:\n\n**Veredicto:**",
            );
            let last_agent = agents.last().unwrap();
            match run_agent_collecting(last_agent, &cwd, &synthesis, &tx).await {
                None => { send("[ERROR] síntesis falló".into()).await; return; }
                Some((_, sid)) => {
                    if let Some(id) = sid {
                        send(format!("[SESSION:{}:{}]", last_agent, id)).await;
                    }
                }
            }
        }
    } else {
        let agent = &agents[0];
        let file_diffs = split_diff_into_file_diffs(&diff_out);
        let batches = batch_file_diffs(file_diffs, 60_000);
        let total = batches.len();
        let mut last_session_id: Option<String> = None;
        for (i, batch_diff) in batches.into_iter().enumerate() {
            let label = format!("Batch {}/{}", i + 1, total);
            send(format!("[BATCH:{}/{}]", i + 1, total)).await;
            let review_prompt = build_review_prompt(&ReviewPromptInput::new(&cwd, &base, &batch_diff, &context));
            match run_agent_collecting(agent, &cwd, &review_prompt, &tx).await {
                Some((report, sid)) => {
                    if let Some(id) = sid { last_session_id = Some(id); }
                    reports.push((label, report));
                }
                None => { send(format!("[ERROR] {} no encontrado o falló", agent)).await; return; }
            }
        }
        if total > 1 {
            send("[SYNTHESIS]".into()).await;
            let truncated: Vec<(String, String)> = reports.iter()
                .map(|(l, r)| (l.clone(), r.chars().take(8_000).collect()))
                .collect();
            let refs: Vec<(&str, &str)> = truncated.iter().map(|(l, r)| (l.as_str(), r.as_str())).collect();
            let synthesis = build_synthesis_prompt(
                &refs,
                "Escribe el informe final directamente, sin preámbulo. Empieza con:\n\n**Veredicto:**",
            );
            match run_agent_collecting(agent, &cwd, &synthesis, &tx).await {
                None => { send("[ERROR] síntesis falló".into()).await; return; }
                Some((_, sid)) => {
                    if let Some(id) = sid { last_session_id = Some(id); }
                }
            }
        }
        if let Some(id) = last_session_id {
            send(format!("[SESSION:{}:{}]", agent, id)).await;
        }
    }

    send("[DONE]".into()).await;
}


/// Runs one agent in review mode (read-only) and collects its report.
/// The spawning/parsing itself lives in `bento_review::agents`, shared with
/// the desktop app — this used to be three near-identical loops here, one per
/// agent, none of which restricted Claude's tools the way the desktop did.
pub(super) async fn run_agent_collecting(
    agent: &str,
    cwd: &str,
    prompt: &str,
    tx: &tokio::sync::mpsc::Sender<String>,
) -> Option<(String, Option<String>)> {
    bento_review::agents::run_collecting(agent, cwd, prompt, None, true, tx).await
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
