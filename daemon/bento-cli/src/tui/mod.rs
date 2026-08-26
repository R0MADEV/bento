//! Full-screen panel mode: a navigable list of terminals/agents, with
//! inline attach (returns to the list when the remote session ends), plus a
//! Review tab for running AI code reviews without leaving the terminal.

mod review;
mod terminals;

use crossterm::event::{Event, EventStream, KeyCode, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{EnterAlternateScreen, LeaveAlternateScreen};
use tokio_stream::StreamExt;

use review::ReviewState;

enum Mode {
    List,
    Attached { pty_id: String },
    Review,
}

pub async fn run() -> std::io::Result<()> {
    let mut terminal = ratatui::try_init()?;
    let result = run_app(&mut terminal).await;
    ratatui::try_restore()?;
    result
}

async fn run_app(terminal: &mut ratatui::DefaultTerminal) -> std::io::Result<()> {
    let mut events = EventStream::new();
    let mut mode = Mode::List;
    let mut items = terminals::fetch_terminals().await.unwrap_or_default();
    let mut selected: usize = 0;
    let mut refresh = tokio::time::interval(std::time::Duration::from_secs(2));
    let cwd = std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default();
    let mut review = ReviewState::new(cwd);

    loop {
        match &mode {
            Mode::List => {
                terminal.draw(|f| terminals::draw_list(f, &items, selected))?;
                tokio::select! {
                    _ = refresh.tick() => {
                        items = terminals::fetch_terminals().await.unwrap_or_default();
                        if selected >= items.len() {
                            selected = items.len().saturating_sub(1);
                        }
                    }
                    maybe_event = events.next() => {
                        let Some(Ok(Event::Key(key))) = maybe_event else { continue };
                        if key.kind != KeyEventKind::Press { continue; }
                        match key.code {
                            KeyCode::Up => selected = selected.saturating_sub(1),
                            KeyCode::Down => {
                                if selected + 1 < items.len() { selected += 1; }
                            }
                            KeyCode::Enter => {
                                if let Some(item) = items.get(selected) {
                                    mode = Mode::Attached { pty_id: item.pty_id.clone() };
                                }
                            }
                            KeyCode::Tab => {
                                review.enter().await;
                                mode = Mode::Review;
                            }
                            KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
                            _ => {}
                        }
                    }
                }
            }
            Mode::Attached { pty_id } => {
                let id = pty_id.clone();
                // A remote terminal's own alt-screen use (vim, htop) shares one
                // non-ref-counted flag with the panel's — leaving the panel's
                // alt-screen before attaching, and reasserting it after, avoids
                // desyncing ratatui's belief about screen state from what the
                // remote program actually left behind.
                execute!(std::io::stdout(), LeaveAlternateScreen)?;
                terminals::run_attached(&id, &mut events).await?;
                execute!(std::io::stdout(), EnterAlternateScreen)?;
                // NOT terminal.clear(): it queries the cursor position by
                // writing a DSR escape sequence and synchronously reading
                // the reply off stdin — which races the EventStream's own
                // background reader for the same fd 0 and can steal or miss
                // that reply, hanging until crossterm's read timeout fires
                // ("cursor position could not be read within a normal
                // duration"). resize() to the current size forces the same
                // full-repaint-on-next-draw effect via a pure ANSI clear
                // write, no read involved.
                let area = terminal.size()?.into();
                terminal.resize(area)?;
                mode = Mode::List;
                items = terminals::fetch_terminals().await.unwrap_or_default();
                if selected >= items.len() {
                    selected = items.len().saturating_sub(1);
                }
            }
            Mode::Review => {
                terminal.draw(|f| review::draw(f, &review))?;
                tokio::select! {
                    maybe_event = events.next() => {
                        let Some(Ok(event)) = maybe_event else { continue };
                        if review.handle_event(event).await {
                            mode = Mode::List;
                        }
                    }
                    Some(ev) = recv_optional(review.stream_rx()) => {
                        review.handle_stream_event(ev);
                    }
                }
            }
        }
    }
}

/// `tokio::select!` needs a future to poll even when no review stream is
/// active — `std::future::pending()` never resolves, so this branch simply
/// stays disabled for the loop iteration until `stream_rx` is `Some` again
/// (confirmed against tokio's own select! semantics: a non-matching pattern
/// just disables that arm for the current call, re-armed next iteration).
async fn recv_optional<T>(rx: &mut Option<tokio::sync::mpsc::UnboundedReceiver<T>>) -> Option<T> {
    match rx {
        Some(r) => r.recv().await,
        None => std::future::pending().await,
    }
}
