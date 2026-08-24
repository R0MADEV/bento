//! Terminals/agents list — the panel's landing view — with inline attach
//! (returns here when the remote session ends).

use crossterm::event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::style::{Modifier, Style};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_stream::StreamExt;

#[derive(Clone)]
pub(super) struct TerminalInfo {
    pub(super) pty_id: String,
    title: String,
    cwd: String,
}

pub(super) fn draw_list(frame: &mut ratatui::Frame, items: &[TerminalInfo], selected: usize) {
    let list_items: Vec<ListItem> = if items.is_empty() {
        vec![ListItem::new("No hay terminales abiertos. Abrí uno desde Bento.")]
    } else {
        items
            .iter()
            .map(|t| {
                let label = if t.cwd.is_empty() { t.title.clone() } else { format!("{}  ({})", t.title, t.cwd) };
                ListItem::new(label)
            })
            .collect()
    };
    let list = List::new(list_items)
        .block(Block::default().title("Terminales — ↑/↓ navegar, Enter conectar, Tab review, q salir").borders(Borders::ALL))
        .highlight_style(Style::default().add_modifier(Modifier::REVERSED));
    let mut state = ListState::default();
    if !items.is_empty() {
        state.select(Some(selected));
    }
    frame.render_stateful_widget(list, frame.area(), &mut state);
}

pub(super) async fn fetch_terminals() -> std::io::Result<Vec<TerminalInfo>> {
    let data = crate::request_data(json!({ "id": "1", "cmd": "terminals.list" })).await?;
    let items = data
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|v| TerminalInfo {
            pty_id: v.get("pty_id").and_then(Value::as_str).unwrap_or_default().to_string(),
            title: v.get("title").and_then(Value::as_str).unwrap_or_default().to_string(),
            cwd: v.get("cwd").and_then(Value::as_str).unwrap_or_default().to_string(),
        })
        .collect();
    Ok(items)
}

/// Attach inline to `id`: same IPC protocol and single-writer-task pattern
/// as `attach.rs`, but driven off the panel's shared `EventStream` (so it
/// can return normally instead of hard-exiting) and writing remote output
/// straight to stdout while ratatui's own drawing is paused.
pub(super) async fn run_attached(id: &str, events: &mut EventStream) -> std::io::Result<()> {
    let stream = TcpStream::connect(crate::addr()).await?;
    let (read_half, write_half) = stream.into_split();

    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut write_half = write_half;
        while let Some(line) = out_rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err() { break; }
            if write_half.write_all(b"\n").await.is_err() { break; }
        }
    });

    let _ = out_tx.send(json!({ "id": "1", "cmd": "terminal.subscribe", "pty_id": id }).to_string());
    if let Ok((cols, rows)) = crossterm::terminal::size() {
        let _ = out_tx.send(json!({ "cmd": "terminal.resize", "pty_id": id, "rows": rows, "cols": cols }).to_string());
    }

    let (exit_tx, mut exit_rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let mut lines = BufReader::new(read_half).lines();
        let mut stdout = tokio::io::stdout();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
            match value.get("event").and_then(Value::as_str) {
                Some("terminal.output") => {
                    if let Some(data) = value.get("data").and_then(Value::as_str) {
                        let _ = stdout.write_all(data.as_bytes()).await;
                        let _ = stdout.flush().await;
                    }
                }
                Some("terminal.exit") => break,
                _ => {}
            }
        }
        let _ = exit_tx.send(());
    });

    loop {
        tokio::select! {
            maybe_event = events.next() => {
                let Some(Ok(event)) = maybe_event else { continue };
                match event {
                    Event::Key(key) => {
                        let bytes = key_event_to_bytes(key);
                        if !bytes.is_empty() {
                            if let Ok(text) = String::from_utf8(bytes) {
                                let _ = out_tx.send(json!({ "cmd": "terminal.write", "pty_id": id, "data": text }).to_string());
                            }
                        }
                    }
                    // crossterm reports (columns, rows); the daemon's fields are
                    // named, not positional, so map explicitly rather than by
                    // habit from term_size()'s (rows, cols) in attach.rs.
                    Event::Resize(cols, rows) => {
                        let _ = out_tx.send(json!({ "cmd": "terminal.resize", "pty_id": id, "rows": rows, "cols": cols }).to_string());
                    }
                    _ => {}
                }
            }
            _ = &mut exit_rx => break,
        }
    }

    drop(out_tx);
    writer.abort();
    Ok(())
}

/// Translates one crossterm `KeyEvent` into the raw bytes a real raw-mode
/// tty would have produced for it — the same byte shape `attach.rs`'s
/// `tokio::io::stdin()` loop received verbatim, needed here because
/// crossterm hands us structured events instead of raw bytes.
fn key_event_to_bytes(key: KeyEvent) -> Vec<u8> {
    if key.kind != KeyEventKind::Press {
        return Vec::new();
    }
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    match key.code {
        KeyCode::Char(c) if ctrl => match c.to_ascii_lowercase() {
            c @ 'a'..='z' => vec![c as u8 - b'a' + 1],
            c @ '4'..='7' => vec![c as u8 - b'4' + 0x1C],
            ' ' => vec![0x00],
            _ => c.to_string().into_bytes(),
        },
        KeyCode::Char(c) => c.to_string().into_bytes(),
        KeyCode::Enter => vec![b'\r'],
        KeyCode::Backspace => vec![0x7f],
        KeyCode::Tab => vec![b'\t'],
        KeyCode::Esc => vec![0x1b],
        KeyCode::Up => b"\x1b[A".to_vec(),
        KeyCode::Down => b"\x1b[B".to_vec(),
        KeyCode::Right => b"\x1b[C".to_vec(),
        KeyCode::Left => b"\x1b[D".to_vec(),
        KeyCode::Home => b"\x1b[H".to_vec(),
        KeyCode::End => b"\x1b[F".to_vec(),
        KeyCode::PageUp => b"\x1b[5~".to_vec(),
        KeyCode::PageDown => b"\x1b[6~".to_vec(),
        KeyCode::Insert => b"\x1b[2~".to_vec(),
        KeyCode::Delete => b"\x1b[3~".to_vec(),
        KeyCode::F(1) => b"\x1bOP".to_vec(),
        KeyCode::F(2) => b"\x1bOQ".to_vec(),
        KeyCode::F(3) => b"\x1bOR".to_vec(),
        KeyCode::F(4) => b"\x1bOS".to_vec(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    fn press(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    #[test]
    fn plain_char_encodes_as_utf8() {
        assert_eq!(key_event_to_bytes(press(KeyCode::Char('a'), KeyModifiers::NONE)), b"a");
    }

    #[test]
    fn uppercase_char_is_not_treated_as_control() {
        assert_eq!(key_event_to_bytes(press(KeyCode::Char('A'), KeyModifiers::SHIFT)), b"A");
    }

    #[test]
    fn enter_sends_carriage_return_not_newline() {
        assert_eq!(key_event_to_bytes(press(KeyCode::Enter, KeyModifiers::NONE)), b"\r");
    }

    #[test]
    fn backspace_sends_del_not_bs() {
        // 0x08 would round-trip as Ctrl+H through crossterm's own parser.
        assert_eq!(key_event_to_bytes(press(KeyCode::Backspace, KeyModifiers::NONE)), vec![0x7f]);
    }

    #[test]
    fn arrow_keys_send_ansi_sequences() {
        assert_eq!(key_event_to_bytes(press(KeyCode::Up, KeyModifiers::NONE)), b"\x1b[A");
        assert_eq!(key_event_to_bytes(press(KeyCode::Down, KeyModifiers::NONE)), b"\x1b[B");
        assert_eq!(key_event_to_bytes(press(KeyCode::Right, KeyModifiers::NONE)), b"\x1b[C");
        assert_eq!(key_event_to_bytes(press(KeyCode::Left, KeyModifiers::NONE)), b"\x1b[D");
    }

    #[test]
    fn ctrl_c_sends_0x03() {
        assert_eq!(key_event_to_bytes(press(KeyCode::Char('c'), KeyModifiers::CONTROL)), vec![0x03]);
    }

    #[test]
    fn ctrl_a_sends_0x01() {
        assert_eq!(key_event_to_bytes(press(KeyCode::Char('a'), KeyModifiers::CONTROL)), vec![0x01]);
    }

    #[test]
    fn release_events_are_ignored() {
        let mut key = press(KeyCode::Char('a'), KeyModifiers::NONE);
        key.kind = KeyEventKind::Release;
        assert!(key_event_to_bytes(key).is_empty());
    }

    #[test]
    fn unmapped_key_returns_empty() {
        assert!(key_event_to_bytes(press(KeyCode::F(9), KeyModifiers::NONE)).is_empty());
    }
}
