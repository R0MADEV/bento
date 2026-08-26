//! Shared plumbing for the `review.run`/`review.ask` IPC streaming
//! protocol: connect, send the request, read the ack, then classify and
//! forward chunks until `review.done`. Used by both the one-shot CLI
//! (`bento review run`/`ask`, which prints the events synchronously) and
//! the TUI panel's Review tab (which feeds a redraw loop) — extracted so
//! the connection/ack/classification logic has exactly one implementation.

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use bento_review::stream::{parse_stream_line, StreamLine};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

pub(crate) enum ReviewEvent {
    Content(String),
    Progress(String),
    Done,
}

/// Returns the event receiver plus the background task's `JoinHandle` so a
/// caller that wants to support cancelling an in-flight review (the TUI's
/// Review tab) can `.abort()` it — the one-shot CLI just drops its handle
/// and lets the task run to completion.
pub(crate) fn spawn_review_stream(body: Value) -> (mpsc::UnboundedReceiver<ReviewEvent>, tokio::task::JoinHandle<()>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = tokio::spawn(async move {
        run(body, tx).await;
    });
    (rx, handle)
}

async fn run(body: Value, tx: mpsc::UnboundedSender<ReviewEvent>) {
    let Ok(mut stream) = TcpStream::connect(crate::addr()).await else {
        let _ = tx.send(ReviewEvent::Progress("error: no se pudo conectar al daemon".into()));
        let _ = tx.send(ReviewEvent::Done);
        return;
    };
    if stream.write_all(body.to_string().as_bytes()).await.is_err() || stream.write_all(b"\n").await.is_err() {
        let _ = tx.send(ReviewEvent::Done);
        return;
    }
    let mut lines = BufReader::new(stream).lines();

    let Ok(Some(ack)) = lines.next_line().await else {
        let _ = tx.send(ReviewEvent::Done);
        return;
    };
    if let Ok(ack) = serde_json::from_str::<Value>(&ack) {
        if ack.get("ok").and_then(Value::as_bool) == Some(false) {
            let msg = ack.get("error").and_then(Value::as_str).unwrap_or("daemon error");
            let _ = tx.send(ReviewEvent::Progress(format!("error: {msg}")));
            let _ = tx.send(ReviewEvent::Done);
            return;
        }
    }

    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        match value.get("event").and_then(Value::as_str) {
            Some("review.output") => {
                if let Some(chunk) = value.get("data").and_then(Value::as_str) {
                    // Parsed by the shared crate, so the CLI, the phone client
                    // and the desktop app cannot drift on the wire format.
                    match parse_stream_line(chunk) {
                        StreamLine::Text(text) => { let _ = tx.send(ReviewEvent::Content(text)); }
                        StreamLine::Batch { index, total, label } => {
                            let _ = tx.send(ReviewEvent::Progress(format!("BATCH:{index}/{total}:{label}")));
                        }
                        StreamLine::Synthesis => { let _ = tx.send(ReviewEvent::Progress("SYNTHESIS".into())); }
                        StreamLine::Session { agent, id } => {
                            let _ = tx.send(ReviewEvent::Progress(format!("SESSION:{agent}:{id}")));
                        }
                        StreamLine::Tool(tool) => { let _ = tx.send(ReviewEvent::Progress(tool)); }
                        StreamLine::Error(message) => { let _ = tx.send(ReviewEvent::Progress(format!("error: {message}"))); }
                        StreamLine::Done => {}
                    }
                }
            }
            Some("review.done") => break,
            _ => {}
        }
    }
    let _ = tx.send(ReviewEvent::Done);
}


