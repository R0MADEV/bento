//! Lo que el teléfono necesita de las conversaciones de un PR: los
//! comentarios de línea, si su hilo está resuelto y poder resolverlo.
//!
//! Aparte del resto porque `mod.rs` ya no cabe, y porque esto es una cosa:
//! leer una conversación y darla por zanjada.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;

use super::super::{Auth, RemoteState, authorized};
use super::PrQuery;

/// Lo que hace falta para resolver: el comentario que se ve y hacia dónde.
#[derive(Deserialize)]
pub struct ResolveBody {
    pub comment_id: u64,
    pub resolved: bool,
}

/// Los comentarios de línea del PR, para leerlos bajo la línea de la que
/// hablan en vez de en una lista aparte.
pub async fn review_pr_line_comments_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<PrQuery>,
) -> impl IntoResponse {
    let Some((cwd, pr)) = checked(&state, q) else {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    };
    match bento_review::pr::list_review_comments(&cwd, pr) {
        Ok(value) => Json(value).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// Las conversaciones con su marca de resuelto, la de GitHub.
pub async fn review_pr_threads_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<PrQuery>,
) -> impl IntoResponse {
    let Some((cwd, pr)) = checked(&state, q) else {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    };
    match bento_review::threads::review_threads(&cwd, pr) {
        Ok(value) => Json(value).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// Resuelve la conversación de un comentario, o la reabre. Va por el
/// comentario porque es lo que el teléfono tiene a mano: GitHub resuelve
/// hilos, no comentarios sueltos.
pub async fn review_pr_resolve_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<PrQuery>,
    Json(body): Json<ResolveBody>,
) -> impl IntoResponse {
    let Some((cwd, pr)) = checked(&state, q) else {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    };
    let threads = match bento_review::threads::review_threads(&cwd, pr) {
        Ok(threads) => threads,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };
    let Some(thread) = bento_review::threads::thread_of(&threads, body.comment_id) else {
        return (StatusCode::NOT_FOUND, "ese comentario no está en ningún hilo").into_response();
    };
    match bento_review::threads::set_thread_resolved(&cwd, &thread, body.resolved) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// Contesta al comentario marcado, dentro de su hilo.
pub async fn review_pr_reply_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<PrQuery>,
    Json(body): Json<ReplyBody>,
) -> impl IntoResponse {
    let Some((cwd, pr)) = checked(&state, q) else {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    };
    match bento_review::pr::reply_review_comment(&cwd, pr, body.comment_id, &body.body) {
        Ok(url) => Json(url).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(Deserialize)]
pub struct ReplyBody {
    pub comment_id: u64,
    pub body: String,
}

/// El token y los datos que toda petición necesita, en un sitio: sin el
/// proyecto y el PR no hay nada que mirar.
fn checked(state: &Arc<RemoteState>, q: PrQuery) -> Option<(String, u64)> {
    if !authorized(state, &Auth { token: q.token }) {
        return None;
    }
    let cwd = q.cwd.filter(|s| !s.is_empty())?;
    Some((cwd, q.pr?))
}
