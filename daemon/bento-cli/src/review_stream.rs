//! Shared plumbing for the `review.run`/`review.ask` IPC streaming
//! protocol: connect, send the request, read the ack, then classify and
//! forward chunks until `review.done`. Used by both the one-shot CLI
//! (`bento review run`/`ask`, which prints the events synchronously) and
//! the TUI panel's Review tab (which feeds a redraw loop) — extracted so
//! the connection/ack/classification logic has exactly one implementation.

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

pub(crate) enum ReviewEvent {
    Content(String),
    Progress(String),
    Done,
}

pub(crate) fn spawn_review_stream(body: Value) -> mpsc::UnboundedReceiver<ReviewEvent> {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        run(body, tx).await;
    });
    rx
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
                    match classify_review_chunk(chunk) {
                        ReviewChunk::Stdout(text) => { let _ = tx.send(ReviewEvent::Content(text.to_string())); }
                        ReviewChunk::Stderr(msg) => { let _ = tx.send(ReviewEvent::Progress(msg)); }
                    }
                }
            }
            Some("review.done") => break,
            _ => {}
        }
    }
    let _ = tx.send(ReviewEvent::Done);
}

#[derive(Debug, PartialEq)]
enum ReviewChunk<'a> {
    Stderr(String),
    Stdout(&'a str),
}

/// Routes the protocol's own control sentinels (batch/synthesis progress,
/// the session-id marker, error text) away from the actual review content —
/// mirrors the filtering `review.js` already does for the web panel.
fn classify_review_chunk(chunk: &str) -> ReviewChunk<'_> {
    let is_batch_or_session_marker = (chunk.starts_with("[BATCH:") || chunk.starts_with("[SESSION:"))
        && chunk.ends_with(']');
    if is_batch_or_session_marker || chunk == "[SYNTHESIS]" {
        return ReviewChunk::Stderr(chunk.trim_start_matches('[').trim_end_matches(']').to_string());
    }
    if let Some(msg) = chunk.strip_prefix("[ERROR] ") {
        return ReviewChunk::Stderr(format!("error: {msg}"));
    }
    ReviewChunk::Stdout(chunk)
}

#[cfg(test)]
mod review_chunk_tests {
    use super::*;

    #[test]
    fn batch_marker_goes_to_stderr() {
        assert_eq!(classify_review_chunk("[BATCH:1/2]"), ReviewChunk::Stderr("BATCH:1/2".into()));
    }

    #[test]
    fn session_marker_goes_to_stderr() {
        assert_eq!(classify_review_chunk("[SESSION:claude:abc]"), ReviewChunk::Stderr("SESSION:claude:abc".into()));
    }

    #[test]
    fn synthesis_marker_goes_to_stderr() {
        assert_eq!(classify_review_chunk("[SYNTHESIS]"), ReviewChunk::Stderr("SYNTHESIS".into()));
    }

    #[test]
    fn error_marker_is_prefixed_and_goes_to_stderr() {
        assert_eq!(classify_review_chunk("[ERROR] algo falló"), ReviewChunk::Stderr("error: algo falló".into()));
    }

    #[test]
    fn plain_text_goes_to_stdout() {
        assert_eq!(classify_review_chunk("## Título"), ReviewChunk::Stdout("## Título"));
    }

    #[test]
    fn bracketed_text_that_is_not_a_known_marker_goes_to_stdout() {
        assert_eq!(classify_review_chunk("[foo]"), ReviewChunk::Stdout("[foo]"));
    }
}
