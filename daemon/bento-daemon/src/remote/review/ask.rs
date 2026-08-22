use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, StatusCode},
    response::Response,
};
use futures_util::StreamExt;
use serde::Deserialize;
use std::sync::Arc;

use super::super::{Auth, RemoteState, authorized};
use super::checkpoints::{checkpoint_path, Checkpoint};
use super::run_agent_collecting;

#[derive(Deserialize)]
pub struct AskQuery {
    pub cwd: Option<String>,
    pub base: Option<String>,
    pub agent: Option<String>,
    pub question: Option<String>,
}

pub async fn ask_handler(
    State(state): State<Arc<RemoteState>>,
    Query(auth): Query<Auth>,
    Query(q): Query<AskQuery>,
) -> Response {
    if !authorized(&state, &auth) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap();
    }

    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(v) => v,
        None => return bad_request("cwd requerido"),
    };
    let base = q.base.unwrap_or_else(|| "main".into());
    let question = match q.question.filter(|s| !s.trim().is_empty()) {
        Some(v) => v,
        None => return bad_request("question requerida"),
    };
    let agent = match q.agent.as_deref() {
        Some("opencode") => "opencode",
        Some("codex") => "codex",
        _ => "claude",
    };

    let path = match checkpoint_path(&cwd, &base) {
        Some(p) => p,
        None => return bad_request("no se pudo resolver la ruta del checkpoint"),
    };
    let cp = match std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Checkpoint>(&raw).ok())
    {
        Some(c) if !c.content.trim().is_empty() => c,
        _ => return bad_request("no hay análisis guardado para esta rama"),
    };
    let review_content = cp.content.clone();

    let (tx, rx) = tokio::sync::mpsc::channel::<String>(64);
    let session_id = cp.session_id.clone();
    let session_agent = cp.session_agent.clone().unwrap_or_else(|| agent.to_string());

    if let Some(sid) = session_id {
        // Resume the actual synthesis session — it already has full review context
        let question_owned = question.clone();
        tokio::spawn(async move {
            resume_agent(&session_agent, &cwd, &sid, &question_owned, &tx).await;
            let _ = tx.send("[DONE]".into()).await;
        });
    } else {
        // Fallback: build prompt with review context (no session to resume)
        let project = std::path::Path::new(&cwd)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| cwd.clone());
        let prompt = format!(
            "Eres un revisor de código experto. Acabas de analizar el diff del proyecto \"{project}\" \
            desde la rama \"{base}\". Tu análisis previo fue:\n\n\
            <analisis_previo>\n{review_content}\n</analisis_previo>\n\n\
            El desarrollador tiene la siguiente pregunta. Responde en español, de forma concisa y técnica.\n\n\
            Pregunta: {question}"
        );
        let agent_owned = agent.to_string();
        tokio::spawn(async move {
            run_agent_collecting(&agent_owned, &cwd, &prompt, &tx).await;
            let _ = tx.send("[DONE]".into()).await;
        });
    };

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

async fn resume_agent(
    agent: &str,
    cwd: &str,
    session_id: &str,
    question: &str,
    tx: &tokio::sync::mpsc::Sender<String>,
) {
    match agent {
        "opencode" => resume_opencode(cwd, session_id, question, tx).await,
        _ => resume_claude(session_id, question, tx).await,
    }
}

async fn resume_claude(
    session_id: &str,
    question: &str,
    tx: &tokio::sync::mpsc::Sender<String>,
) {
    let Some(mut child) = tokio::process::Command::new("claude")
        .args(["--resume", session_id, "-p", question, "--output-format", "stream-json", "--verbose"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()
    else { return };

    let Some(stdout) = child.stdout.take() else { return };

    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(300), lines.next_line()).await {
            Ok(Ok(Some(line))) => {
                let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                let event_type = val.get("type").and_then(serde_json::Value::as_str).unwrap_or("");
                if event_type == "system" { continue; }
                if event_type == "content_block_delta" {
                    let text = val.get("delta").and_then(|d| d.get("text")).and_then(serde_json::Value::as_str).unwrap_or("");
                    if !text.is_empty() && tx.send(text.to_string()).await.is_err() {
                        let _ = child.kill().await;
                        return;
                    }
                }
            }
            Ok(Ok(None)) => break,
            Ok(Err(_)) | Err(_) => { let _ = child.kill().await; return; }
        }
    }
    let _ = child.wait().await;
}

async fn resume_opencode(
    cwd: &str,
    session_id: &str,
    question: &str,
    tx: &tokio::sync::mpsc::Sender<String>,
) {
    let Some(mut child) = tokio::process::Command::new("opencode")
        .args(["--session", session_id, "run", "--format", "json", "--dir", cwd, question])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()
    else { return };

    let Some(stdout) = child.stdout.take() else { return };

    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(300), lines.next_line()).await {
            Ok(Ok(Some(line))) => {
                let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                let event_type = val.get("type").and_then(serde_json::Value::as_str).unwrap_or("");
                if event_type != "text" { continue; }
                let text = val.get("part").and_then(|p| p.get("text")).and_then(serde_json::Value::as_str).unwrap_or("");
                if !text.is_empty() && tx.send(text.to_string()).await.is_err() {
                    let _ = child.kill().await;
                    return;
                }
            }
            Ok(Ok(None)) => break,
            Ok(Err(_)) | Err(_) => { let _ = child.kill().await; return; }
        }
    }
    let _ = child.wait().await;
}

fn bad_request(msg: &str) -> Response {
    Response::builder()
        .status(StatusCode::BAD_REQUEST)
        .body(Body::from(msg.to_string()))
        .unwrap()
}
