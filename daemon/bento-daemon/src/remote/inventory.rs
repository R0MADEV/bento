//! Lo que el móvil puede *mirar* de la máquina: proyectos abiertos, tareas y
//! contenedores. Todo de solo lectura — lo que actúa vive en el socket local.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Json},
};
use bento_core::PtyManager;
use serde_json::json;

use super::{authorized, git_branch, Auth, RemoteState};

// ── /api/projects ─────────────────────────────────────────────────────────────

/// Distinct project directories currently in use — derived from open
/// terminals'/agents' cwds (deduped), each with its current branch. Shared
/// by the HTTP `/api/projects` handler (phone) and the daemon's IPC socket
/// (`projects.list`, for the TUI panel's project picker).
pub(crate) fn list_projects(manager: &PtyManager) -> Vec<serde_json::Value> {
    let mut seen = std::collections::HashSet::new();
    manager
        .list()
        .into_iter()
        .filter(|info| !info.cwd.is_empty())
        .filter(|info| seen.insert(info.cwd.clone()))
        .map(|info| {
            let branch = git_branch(&info.cwd);
            json!({ "cwd": info.cwd, "branch": branch })
        })
        .collect()
}

/// Los contenedores, corriendo o no. Solo lectura: arrancar y parar se queda
/// en el socket local, donde no hace falta un token para tener permiso.
pub(super) async fn docker_handler(
    State(state): State<Arc<RemoteState>>,
    Query(auth): Query<Auth>,
) -> impl IntoResponse {
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    Json(bento_docker::list()).into_response()
}

/// Las tareas (worktrees) de un proyecto: en qué rama está cada una y sobre
/// qué commit. Solo lectura — crear, borrar o rebasear una tarea se queda en
/// la app, donde hay confirmaciones y deshacer.
pub(super) async fn tasks_handler(
    State(state): State<Arc<RemoteState>>,
    Query(auth): Query<Auth>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let Some(cwd) = params.get("cwd").filter(|c| !c.is_empty()) else {
        return (StatusCode::BAD_REQUEST, "missing cwd").into_response();
    };
    Json(bento_review::worktrees::list(cwd)).into_response()
}

pub(super) async fn projects_handler(
    State(state): State<Arc<RemoteState>>,
    Query(auth): Query<Auth>,
) -> impl IntoResponse {
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    Json(list_projects(&state.manager)).into_response()
}
