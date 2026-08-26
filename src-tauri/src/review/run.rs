//! Running a review from the desktop app.
//!
//! Like the CLI and the phone client, this goes through the daemon rather than
//! running the engine in-process: the review then belongs to the daemon, so it
//! survives closing the app and is visible from the TUI. All three speak the
//! same `review.run` command and parse its stream with the same code
//! (`bento_review::stream`).

use bento_review::stream::{parse_stream_line, StreamLine};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

fn daemon_addr() -> String {
    std::env::var("BENTO_DAEMON_ADDR").unwrap_or_else(|_| "127.0.0.1:7877".into())
}

/// The connection of every review in flight. Dropping it closes the socket,
/// which is what the daemon reads as "cancel this run" — the agents are
/// killed rather than left running for a stream nobody reads.
fn running() -> &'static Mutex<HashMap<String, tokio::task::JoinHandle<()>>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

fn emit(app: &AppHandle, id: &str, kind: &str, payload: serde_json::Value) {
    let _ = app.emit(&format!("review://{kind}:{id}"), payload);
}

/// Stops a review. Unknown ids are not an error: a run that already finished
/// is already stopped.
#[tauri::command]
pub fn review_cancel(id: String) {
    if let Some(task) = running().lock().ok().and_then(|mut runs| runs.remove(&id)) {
        task.abort();
    }
}

/// Starts a review on the daemon and streams its events to the frontend.
/// Returns as soon as it is running; the frontend follows `review://…:{id}`.
#[tauri::command]
pub async fn review_run(
    app: AppHandle,
    id: String,
    cwd: String,
    base: String,
    branch: Option<String>,
    agents: Vec<String>,
    context: String,
) -> Result<(), String> {
    let request = json!({
        "id": "1", "cmd": "review.run", "cwd": cwd, "base": base,
        "branch": branch, "context": context, "agents": agents.join(","),
    });

    let task = {
        let (app, id) = (app.clone(), id.clone());
        tokio::spawn(async move {
            if let Err(error) = stream_review(&app, &id, request).await {
                emit(&app, &id, "error", json!({ "message": error }));
            }
            // Always emitted, however the run ended: the frontend waits on it
            // to render what it has.
            emit(&app, &id, "done", json!({}));
            if let Ok(mut runs) = running().lock() {
                runs.remove(&id);
            }
        })
    };
    if let Ok(mut runs) = running().lock() {
        runs.insert(id, task);
    }
    Ok(())
}

async fn stream_review(app: &AppHandle, id: &str, request: serde_json::Value) -> Result<(), String> {
    let stream = TcpStream::connect(daemon_addr()).await.map_err(|e| e.to_string())?;
    let (read_half, mut write_half) = stream.into_split();
    write_half.write_all(format!("{request}\n").as_bytes()).await.map_err(|e| e.to_string())?;

    let mut lines = BufReader::new(read_half).lines();
    // The first line acknowledges the command; the stream follows.
    let _ = lines.next_line().await.map_err(|e| e.to_string())?;

    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        let payload = serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .and_then(|value| value.get("data").and_then(|d| d.as_str()).map(str::to_string))
            .unwrap_or(line);
        match parse_stream_line(&payload) {
            StreamLine::Batch { index, total, label } => {
                emit(app, id, "batch", json!({ "index": index, "total": total, "label": label }))
            }
            StreamLine::Synthesis => emit(app, id, "synthesis", json!({})),
            StreamLine::Session { agent, id: session } => {
                emit(app, id, "session", json!({ "agent": agent, "sessionId": session }))
            }
            StreamLine::Tool(tool) => emit(app, id, "tool", json!({ "tool": tool })),
            StreamLine::Error(message) => emit(app, id, "error", json!({ "message": message })),
            StreamLine::Text(text) => emit(app, id, "chunk", json!({ "text": format!("{text}\n") })),
            StreamLine::Done => break,
        }
    }
    Ok(())
}
