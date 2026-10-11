//! Las terminales por HTTP: listarlas, abrir, renombrar, cerrar y el
//! WebSocket por el que viajan sus bytes. Los PTY los abre `bento_core`; esto
//! es el adaptador. Salió de `remote/mod.rs`, que se pasaba del presupuesto de
//! tamaño con el router y el control remoto dentro.

use axum::{
    extract::{ws::{Message, WebSocket}, Path, Query, State, WebSocketUpgrade},
    http::StatusCode,
    response::{IntoResponse, Json},
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

use bento_core::{PtyEvent, PtyManager};
use tokio::sync::broadcast;

use super::{authorized, git_branch, Auth, RemoteState};

pub(super) async fn terminals(
    State(state): State<Arc<RemoteState>>,
    Query(auth): Query<Auth>,
) -> impl IntoResponse {
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let list: Vec<_> = state
        .manager
        .list()
        .into_iter()
        .map(|info| {
            let branch = if info.cwd.is_empty() { None } else { git_branch(&info.cwd) };
            json!({ "id": info.id, "title": info.title, "cwd": info.cwd, "branch": branch })
        })
        .collect();
    Json(list).into_response()
}

// PATCH /api/terminals/:id  (body: { title })
//
// Renombrar existía por el socket y no por HTTP, así que desde el teléfono una
// terminal se quedaba con el nombre que le tocara.
pub(super) async fn rename_terminal(
    State(state): State<Arc<RemoteState>>,
    Path(id): Path<String>,
    Query(auth): Query<Auth>,
    Json(body): Json<TitleBody>,
) -> impl IntoResponse {
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let title = body.title.trim();
    if title.is_empty() {
        return (StatusCode::BAD_REQUEST, "empty title").into_response();
    }
    state.manager.set_title(&id, title);
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
pub(super) struct TitleBody {
    pub(super) title: String,
}

pub(super) async fn kill_terminal(
    State(state): State<Arc<RemoteState>>,
    Path(id): Path<String>,
    Query(auth): Query<Auth>,
) -> impl IntoResponse {
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    match state.manager.close(&id) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

// GET /api/profiles
//
// Los perfiles de terminal, para que el móvil pueda abrir con tu shell y no
// con el que el daemon tenga a mano.
pub(super) async fn profiles(
    State(state): State<Arc<RemoteState>>,
    Query(auth): Query<Auth>,
) -> impl IntoResponse {
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    Json(bento_core::profiles::list()).into_response()
}

/// Dónde abrir el terminal que pide el móvil: donde diga, si existe y es un
/// directorio; si no, en casa. La ruta llega por HTTP, así que se comprueba
/// aquí en vez de dársela al shell tal cual.
fn open_cwd(requested: Option<String>, home: &str) -> String {
    requested
        .filter(|path| !path.is_empty() && std::path::Path::new(path).is_dir())
        .unwrap_or_else(|| home.to_string())
}

pub(super) async fn new_terminal(
    State(state): State<Arc<RemoteState>>,
    Query(auth): Query<Auth>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    // Por id de perfil y no por shell: así lo que se ejecuta sale siempre de
    // algo que ya estaba guardado, no de lo que llegue por la red.
    let shell = params
        .get("profile")
        .and_then(|id| bento_core::profiles::shell_of(id))
        .unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()));
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    // Sin esto el móvil solo sabía abrir una shell en casa, que para trabajar
    // en un proyecto no vale de nada.
    let home = open_cwd(params.get("cwd").cloned(), &home);
    let id = format!("pty-mobile-{}", uuid_v4());
    let opts = bento_core::OpenOptions {
        id: Some(id.clone()),
        shell: Some(shell),
        cwd: Some(home),
        rows: 24,
        cols: 80,
        ..Default::default()
    };
    match state.manager.open(opts) {
        Ok((id, _)) => Json(json!({ "id": id })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().subsec_nanos();
    format!("{:08x}", t)
}

pub(super) async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<RemoteState>>,
    Path(id): Path<String>,
    Query(auth): Query<Auth>,
) -> impl IntoResponse {
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let manager = state.manager.clone();
    ws.on_upgrade(move |socket| bridge(socket, manager, id))
}

async fn bridge(socket: WebSocket, manager: PtyManager, id: String) {
    let Some(mut rx) = manager.subscribe(&id) else { return };
    let (mut sender, mut receiver) = socket.split();

    if let Some(scrollback) = manager.scrollback(&id) {
        if !scrollback.is_empty() && sender.send(Message::Text(scrollback)).await.is_err() {
            return;
        }
    }

    let outgoing = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(PtyEvent::Output(text)) => {
                    if sender.send(Message::Text(text)).await.is_err() { break; }
                }
                Ok(PtyEvent::TitleChanged(title)) => {
                    let msg = format!("{{\"type\":\"title\",\"value\":{}}}", serde_json::json!(title));
                    if sender.send(Message::Text(msg)).await.is_err() { break; }
                }
                Ok(PtyEvent::Exit(_)) => {
                    let _ = sender.send(Message::Text(r#"{"type":"exit"}"#.into())).await;
                    break;
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });

    while let Some(Ok(message)) = receiver.next().await {
        match message {
            Message::Text(text) => {
                if let Ok(ctrl) = serde_json::from_str::<serde_json::Value>(&text) {
                    if ctrl.get("type").and_then(serde_json::Value::as_str) == Some("resize") {
                        let rows = ctrl.get("rows").and_then(serde_json::Value::as_u64).unwrap_or(24) as u16;
                        let cols = ctrl.get("cols").and_then(serde_json::Value::as_u64).unwrap_or(80) as u16;
                        let _ = manager.resize(&id, rows, cols);
                    } else {
                        let _ = manager.write(&id, &text);
                    }
                } else {
                    let _ = manager.write(&id, &text);
                }
            }
            Message::Binary(bytes) => {
                if let Ok(text) = std::str::from_utf8(&bytes) { let _ = manager.write(&id, text); }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    outgoing.abort();
}
// ── /api/fs/dirs ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_terminal_opens_where_you_asked_when_that_place_exists() {
        let dir = std::env::temp_dir();
        let home = "/home/quien-sea".to_string();

        assert_eq!(open_cwd(Some(dir.to_string_lossy().to_string()), &home), dir.to_string_lossy());
    }

    #[test]
    fn and_falls_back_home_when_it_does_not() {
        // Llega por HTTP: una ruta inventada, o un fichero, no abre nada raro.
        let home = "/home/quien-sea".to_string();

        assert_eq!(open_cwd(Some("/no/existe/esto".into()), &home), home);
        assert_eq!(open_cwd(Some(String::new()), &home), home);
        assert_eq!(open_cwd(None, &home), home);
    }
}
