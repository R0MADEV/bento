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
    // With a run id, that review; without one, the branch's newest — which is
    // what a client that predates several-per-branch still asks for.
    let found = match params.get("run_id") {
        Some(run) => bento_review::checkpoints::get_run(cwd, base, run),
        None => get_checkpoint(cwd, base),
    };
    found.map(Json).ok_or(StatusCode::NOT_FOUND)
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

// GET /api/review/viewed?cwd=…&base=…
//
// Los ficheros ya revisados. El almacén (`bento_review::viewed`) lo comparten
// el escritorio y la CLI desde siempre; por HTTP no había forma de llegar a él,
// así que desde el teléfono no se podía marcar nada.
pub async fn get_viewed_handler(
    State(state): State<Arc<RemoteState>>,
    Query(auth): Query<Auth>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Vec<String>>, StatusCode> {
    if !authorized(&state, &auth) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let cwd = params.get("cwd").ok_or(StatusCode::BAD_REQUEST)?;
    let base = params.get("base").ok_or(StatusCode::BAD_REQUEST)?;
    Ok(Json(bento_review::viewed::get(cwd, base)))
}

// PUT /api/review/viewed  (body: { cwd, base, paths })
pub async fn set_viewed_handler(
    State(state): State<Arc<RemoteState>>,
    Query(auth): Query<Auth>,
    Json(body): Json<ViewedBody>,
) -> StatusCode {
    if !authorized(&state, &auth) {
        return StatusCode::UNAUTHORIZED;
    }
    match bento_review::viewed::set(&body.cwd, &body.base, &body.paths) {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

#[derive(serde::Deserialize)]
pub struct ViewedBody {
    pub cwd: String,
    pub base: String,
    pub paths: Vec<String>,
}

// DELETE /api/review/checkpoint?cwd=…&base=…[&run_id=…]
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
    // Naming the run is what makes this reach a review saved today; without
    // it only the runless entry was ever removed.
    let _ = delete_checkpoint(cwd, base, params.get("run_id").map(String::as_str));
    StatusCode::OK
}

#[cfg(test)]
mod tests {
    use super::*;
    use bento_core::PtyManager;

    fn state(token: &str) -> Arc<RemoteState> {
        Arc::new(RemoteState {
            manager: PtyManager::new(),
            token: token.to_string(),
        })
    }

    fn auth(token: Option<&str>) -> Auth {
        Auth { token: token.map(str::to_string) }
    }

    fn a_checkpoint(content: &str) -> Checkpoint {
        Checkpoint {
            cwd: "/repo-http".into(),
            base: "main".into(),
            content: content.into(),
            saved_at: now_iso8601(),
            run_id: Some("run-http".into()),
            branch: None,
            commit: None,
            session_id: None,
            session_agent: None,
        }
    }

    #[tokio::test]
    async fn saving_without_the_token_is_refused() {
        // The phone reaches this over the network. Everything here writes to
        // the same store the desktop reads.
        let status = put_checkpoint_handler(
            State(state("s3cr3t")),
            Query(auth(Some("otro"))),
            Json(a_checkpoint("informe")),
        )
        .await;

        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn an_empty_review_is_not_worth_saving() {
        // A blank checkpoint would take the place of the branch's real one in
        // the history and answer the next reopen with nothing.
        let status = put_checkpoint_handler(
            State(state("s3cr3t")),
            Query(auth(Some("s3cr3t"))),
            Json(a_checkpoint("   \n  ")),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn listing_without_the_token_is_refused_too() {
        let params = std::collections::HashMap::from([("cwd".to_string(), "/repo-http".to_string())]);
        let answer = list_checkpoints_handler(
            State(state("s3cr3t")),
            Query(auth(None)),
            Query(params),
        )
        .await;

        assert!(matches!(answer, Err(StatusCode::UNAUTHORIZED)));
    }

    #[tokio::test]
    async fn asking_for_a_review_without_saying_which_repo_is_a_bad_request() {
        let answer = get_checkpoint_handler(
            State(state("s3cr3t")),
            Query(auth(Some("s3cr3t"))),
            Query(std::collections::HashMap::new()),
        )
        .await;

        assert!(matches!(answer, Err(StatusCode::BAD_REQUEST)));
    }

    #[tokio::test]
    async fn marking_a_file_as_read_without_the_token_is_refused() {
        let status = set_viewed_handler(
            State(state("s3cr3t")),
            Query(auth(None)),
            Json(ViewedBody { cwd: "/repo".into(), base: "main".into(), paths: vec!["a.rs".into()] }),
        )
        .await;

        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn asking_what_is_read_without_saying_against_what_is_a_bad_request() {
        // Las marcas son por proyecto y rama: sin la rama no se sabe de qué
        // diff se está hablando.
        let params = std::collections::HashMap::from([("cwd".to_string(), "/repo".to_string())]);
        let answer = get_viewed_handler(State(state("s3cr3t")), Query(auth(Some("s3cr3t"))), Query(params)).await;

        assert!(matches!(answer, Err(StatusCode::BAD_REQUEST)));
    }
}
