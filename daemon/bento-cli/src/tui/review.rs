//! Review tab: browse files changed vs `base`, run a full AI review, and
//! ask follow-up questions — all via the same `review.*` IPC commands the
//! one-shot `bento review` subcommands already use.

use crossterm::event::{Event, KeyCode, KeyEventKind};
use ratatui::layout::{Constraint, Layout};
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph, Wrap};
use serde_json::{json, Value};

use crate::review_stream::{self, ReviewEvent};

enum ReviewView {
    Files,
    Output,
}

pub(super) struct ReviewState {
    base: String,
    files: Vec<Value>,
    view: ReviewView,
    output: String,
    scroll: u16,
    running: bool,
    last_progress: String,
    stream_rx: Option<tokio::sync::mpsc::UnboundedReceiver<ReviewEvent>>,
    asking: bool,
    input: String,
    /// `true` while the in-flight stream is a `review.run` (vs. a follow-up
    /// `review.ask`) — only a finished `run` gets checkpointed, since an
    /// `ask` either resumes that checkpoint's session or answers from it,
    /// it never needs to replace it.
    is_run_stream: bool,
    session_id: Option<String>,
    session_agent: Option<String>,
}

impl ReviewState {
    pub(super) fn new() -> Self {
        Self {
            base: "main".to_string(),
            files: Vec::new(),
            view: ReviewView::Files,
            output: String::new(),
            scroll: 0,
            running: false,
            last_progress: String::new(),
            stream_rx: None,
            asking: false,
            input: String::new(),
            is_run_stream: false,
            session_id: None,
            session_agent: None,
        }
    }

    pub(super) fn stream_rx(&mut self) -> &mut Option<tokio::sync::mpsc::UnboundedReceiver<ReviewEvent>> {
        &mut self.stream_rx
    }

    pub(super) async fn refresh_files(&mut self, cwd: &str) {
        let data = crate::request_data(json!({
            "id": "1", "cmd": "review.files", "cwd": cwd, "base": self.base,
        })).await;
        self.files = data.ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
        self.view = ReviewView::Files;
    }

    /// Handles one input event. Returns `true` if the panel should switch
    /// back to the terminals list.
    pub(super) fn handle_event(&mut self, event: Event, cwd: &str) -> bool {
        let Event::Key(key) = event else { return false };
        if key.kind != KeyEventKind::Press {
            return false;
        }
        if self.asking {
            self.handle_ask_input(key.code, cwd);
            return false;
        }
        match self.view {
            ReviewView::Files => self.handle_files_key(key.code, cwd),
            ReviewView::Output => self.handle_output_key(key.code),
        }
    }

    fn handle_files_key(&mut self, code: KeyCode, cwd: &str) -> bool {
        match code {
            KeyCode::Enter => {
                self.start_run(cwd);
                false
            }
            KeyCode::Tab | KeyCode::Char('q') | KeyCode::Esc => true,
            _ => false,
        }
    }

    fn handle_output_key(&mut self, code: KeyCode) -> bool {
        match code {
            KeyCode::Up => { self.scroll = self.scroll.saturating_sub(1); false }
            KeyCode::Down => { self.scroll = self.scroll.saturating_add(1); false }
            KeyCode::PageUp => { self.scroll = self.scroll.saturating_sub(10); false }
            KeyCode::PageDown => { self.scroll = self.scroll.saturating_add(10); false }
            KeyCode::Char('a') if !self.running => {
                self.asking = true;
                self.input.clear();
                false
            }
            KeyCode::Tab => true,
            KeyCode::Esc => {
                self.view = ReviewView::Files;
                false
            }
            _ => false,
        }
    }

    fn handle_ask_input(&mut self, code: KeyCode, cwd: &str) {
        match code {
            KeyCode::Char(c) => self.input.push(c),
            KeyCode::Backspace => { self.input.pop(); }
            KeyCode::Esc => {
                self.asking = false;
                self.input.clear();
            }
            KeyCode::Enter => {
                if !self.input.trim().is_empty() {
                    self.start_ask(cwd);
                }
                self.asking = false;
            }
            _ => {}
        }
    }

    fn start_run(&mut self, cwd: &str) {
        self.output.clear();
        self.session_id = None;
        self.session_agent = None;
        let body = json!({
            "id": "1", "cmd": "review.run", "cwd": cwd, "base": self.base,
            "context": "", "agents": "",
        });
        self.begin_stream(body, true);
    }

    fn start_ask(&mut self, cwd: &str) {
        let question = std::mem::take(&mut self.input);
        self.output.push_str(&format!("\n\n---\n\n**Pregunta:** {question}\n\n"));
        let body = json!({
            "id": "1", "cmd": "review.ask", "cwd": cwd, "base": self.base,
            "agent": "claude", "question": question,
        });
        self.begin_stream(body, false);
    }

    fn begin_stream(&mut self, body: Value, is_run: bool) {
        self.stream_rx = Some(review_stream::spawn_review_stream(body));
        self.running = true;
        self.is_run_stream = is_run;
        self.last_progress.clear();
        self.scroll = 0;
        self.view = ReviewView::Output;
    }

    pub(super) fn handle_stream_event(&mut self, event: ReviewEvent, cwd: &str) {
        match event {
            ReviewEvent::Content(text) => self.output.push_str(&text),
            ReviewEvent::Progress(msg) => {
                // run_review()'s own "[SESSION:agent:id]" sentinel, already
                // stripped of its brackets by classify_review_chunk — keep
                // it so a finished run's checkpoint can resume that session.
                if let Some((agent, id)) = msg.strip_prefix("SESSION:").and_then(|rest| rest.split_once(':')) {
                    self.session_agent = Some(agent.to_string());
                    self.session_id = Some(id.to_string());
                }
                self.last_progress = msg;
            }
            ReviewEvent::Done => {
                self.running = false;
                self.stream_rx = None;
                if self.is_run_stream && !self.output.trim().is_empty() {
                    self.save_checkpoint(cwd);
                }
            }
        }
    }

    /// Fire-and-forget: persists the just-finished run as a checkpoint so a
    /// later `a` (ask) has something to resume — mirrors what the web
    /// panel's own JS does after each batch, via the same `review.*`
    /// checkpoint storage (`review.checkpoint_save`, a thin IPC wrapper
    /// around the same save the web panel's `PUT /api/review/checkpoint`
    /// uses).
    fn save_checkpoint(&self, cwd: &str) {
        let body = json!({
            "id": "1", "cmd": "review.checkpoint_save", "cwd": cwd, "base": self.base,
            "content": self.output, "session_id": self.session_id, "agent": self.session_agent,
        });
        tokio::spawn(async move {
            let _ = crate::request_data(body).await;
        });
    }
}

pub(super) fn draw(frame: &mut ratatui::Frame, review: &ReviewState) {
    match review.view {
        ReviewView::Files => draw_files(frame, review),
        ReviewView::Output => draw_output(frame, review),
    }
}

fn draw_files(frame: &mut ratatui::Frame, review: &ReviewState) {
    let items: Vec<ListItem> = if review.files.is_empty() {
        vec![ListItem::new(format!("Sin cambios respecto a {}.", review.base))]
    } else {
        review
            .files
            .iter()
            .map(|f| {
                let status = f.get("status").and_then(Value::as_str).unwrap_or("?");
                let path = f.get("path").and_then(Value::as_str).unwrap_or("");
                let added = f.get("added").and_then(Value::as_i64).unwrap_or(0);
                let deleted = f.get("deleted").and_then(Value::as_i64).unwrap_or(0);
                ListItem::new(format!("{status}  {path}  +{added}/-{deleted}"))
            })
            .collect()
    };
    let title = format!("Review ({}) — Enter: correr review · Tab: volver", review.base);
    let list = List::new(items).block(Block::default().title(title).borders(Borders::ALL));
    frame.render_widget(list, frame.area());
}

fn draw_output(frame: &mut ratatui::Frame, review: &ReviewState) {
    let area = frame.area();
    let title = if review.running {
        if review.last_progress.is_empty() { "corriendo…".to_string() } else { review.last_progress.clone() }
    } else {
        "↑/↓ scroll · a: preguntar · Esc: volver".to_string()
    };
    let block = Block::default().title(format!("Review — {title}")).borders(Borders::ALL);

    if review.asking {
        let chunks = Layout::vertical([Constraint::Min(1), Constraint::Length(3)]).split(area);
        let paragraph = Paragraph::new(review.output.as_str())
            .wrap(Wrap { trim: false })
            .scroll((review.scroll, 0))
            .block(block);
        frame.render_widget(paragraph, chunks[0]);
        let input = Paragraph::new(format!("{}▏", review.input))
            .block(Block::default().title("Pregunta (Enter enviar, Esc cancelar)").borders(Borders::ALL));
        frame.render_widget(input, chunks[1]);
    } else {
        let paragraph = Paragraph::new(review.output.as_str())
            .wrap(Wrap { trim: false })
            .scroll((review.scroll, 0))
            .block(block);
        frame.render_widget(paragraph, area);
    }
}
