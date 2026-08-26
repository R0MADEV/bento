//! Running a review from the desktop app, on the same engine the CLI and the
//! phone client use.
//!
//! The orchestration used to live in TypeScript (`reviewAiRun.ts`) while the
//! daemon used `bento_review::engine`, and the two drifted: parallelism,
//! lexis context, per-file budgets and snapshots each ended up in one and not
//! the other. This is the single source of truth the other two already had.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use bento_review::engine::{run_review_cancellable, Agents, CancelToken, ReviewEvent, ReviewRequest};
use tauri::{AppHandle, Emitter};

/// The token of every review in flight, so Stop can reach the run started by
/// a previous call. Cleared when the run ends, however it ends.
fn running() -> &'static Mutex<HashMap<String, CancelToken>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, CancelToken>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

/// Stops a review: the agents are killed, not just ignored. Unknown ids are
/// not an error — a run that already finished is already stopped.
#[tauri::command]
pub fn review_cancel(id: String) {
    if let Some(token) = running().lock().ok().and_then(|mut runs| runs.remove(&id)) {
        token.cancel();
    }
}

/// Events are emitted per run id, matching how the agent and pty commands
/// already stream to the frontend.
fn emit(app: &AppHandle, id: &str, kind: &str, payload: serde_json::Value) {
    let _ = app.emit(&format!("review://{kind}:{id}"), payload);
}

/// Starts a review and streams its events to the frontend. Returns as soon as
/// the run is spawned; the frontend follows `review://…:{id}` until `done`.
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
    let (tx, mut rx) = tokio::sync::mpsc::channel::<ReviewEvent>(64);

    let forwarding = {
        let app = app.clone();
        let id = id.clone();
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    ReviewEvent::Content(text) => emit(&app, &id, "chunk", serde_json::json!({ "text": text })),
                    ReviewEvent::Tool(tool) => emit(&app, &id, "tool", serde_json::json!({ "tool": tool })),
                    ReviewEvent::Batch { index, total, label } => {
                        emit(&app, &id, "batch", serde_json::json!({ "index": index, "total": total, "label": label }))
                    }
                    ReviewEvent::Synthesis => emit(&app, &id, "synthesis", serde_json::json!({})),
                    ReviewEvent::Session { agent, id: session } => {
                        emit(&app, &id, "session", serde_json::json!({ "agent": agent, "sessionId": session }))
                    }
                    ReviewEvent::Error(message) => emit(&app, &id, "error", serde_json::json!({ "message": message })),
                    ReviewEvent::Done => {}
                }
            }
            emit(&app, &id, "done", serde_json::json!({}));
        })
    };

    let cancel = CancelToken::default();
    if let Ok(mut runs) = running().lock() {
        runs.insert(id.clone(), cancel.clone());
    }

    let request = ReviewRequest { cwd, base, context, agents };
    tokio::spawn(async move {
        run_review_cancellable(&request, branch.as_deref(), &Agents, &tx, &cancel).await;
        // Removed however the run ended, so a cancelled or crashed review does
        // not leave its token behind for an id that will never be used again.
        if let Ok(mut runs) = running().lock() {
            runs.remove(&id);
        }
        // Dropping the sender is what ends the forwarding task, which is what
        // emits `done` — the frontend waits on that, so it must always run.
        drop(tx);
        let _ = forwarding.await;
    });
    Ok(())
}
