//! Review tab: browse files/branches/PRs, run a full AI review, and ask
//! follow-up questions — all via the same `review.*` IPC commands the
//! one-shot `bento review` subcommands already use.

use crossterm::event::{Event, KeyCode, KeyEventKind};
use ratatui::layout::{Constraint, Layout};
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph, Wrap};
use serde_json::{json, Value};

use crate::review_stream::{self, ReviewEvent};

const AGENTS: [&str; 3] = ["claude", "codex", "opencode"];

enum ReviewView {
    Files,
    Branches,
    Prs,
    PrDetail,
    Output,
}

pub(super) struct ReviewState {
    base: String,
    agent: String,
    files: Vec<Value>,
    view: ReviewView,
    output: String,
    scroll: u16,
    running: bool,
    last_progress: String,
    stream_rx: Option<tokio::sync::mpsc::UnboundedReceiver<ReviewEvent>>,
    stream_task: Option<tokio::task::JoinHandle<()>>,
    asking: bool,
    input: String,
    /// `true` while the in-flight stream is a `review.run` (vs. a follow-up
    /// `review.ask`) — only a finished `run` gets checkpointed, since an
    /// `ask` either resumes that checkpoint's session or answers from it,
    /// it never needs to replace it.
    is_run_stream: bool,
    session_id: Option<String>,
    session_agent: Option<String>,
    branches: Vec<String>,
    branches_selected: usize,
    prs: Vec<Value>,
    prs_selected: usize,
    pr_detail: String,
    pr_scroll: u16,
}

impl ReviewState {
    pub(super) fn new() -> Self {
        Self {
            base: "main".to_string(),
            agent: AGENTS[0].to_string(),
            files: Vec::new(),
            view: ReviewView::Files,
            output: String::new(),
            scroll: 0,
            running: false,
            last_progress: String::new(),
            stream_rx: None,
            stream_task: None,
            asking: false,
            input: String::new(),
            is_run_stream: false,
            session_id: None,
            session_agent: None,
            branches: Vec::new(),
            branches_selected: 0,
            prs: Vec::new(),
            prs_selected: 0,
            pr_detail: String::new(),
            pr_scroll: 0,
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
    pub(super) async fn handle_event(&mut self, event: Event, cwd: &str) -> bool {
        let Event::Key(key) = event else { return false };
        if key.kind != KeyEventKind::Press {
            return false;
        }
        if self.asking {
            self.handle_ask_input(key.code, cwd);
            return false;
        }
        match self.view {
            ReviewView::Files => self.handle_files_key(key.code, cwd).await,
            ReviewView::Branches => self.handle_branches_key(key.code, cwd).await,
            ReviewView::Prs => self.handle_prs_key(key.code, cwd).await,
            ReviewView::PrDetail => self.handle_pr_detail_key(key.code),
            ReviewView::Output => self.handle_output_key(key.code),
        }
    }

    async fn handle_files_key(&mut self, code: KeyCode, cwd: &str) -> bool {
        match code {
            KeyCode::Enter => {
                self.start_run(cwd);
                false
            }
            KeyCode::Char('b') => {
                let data = crate::request_data(json!({ "id": "1", "cmd": "review.branches", "cwd": cwd })).await;
                self.branches = data.ok()
                    .and_then(|v| v.as_array().cloned())
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect();
                self.branches_selected = 0;
                self.view = ReviewView::Branches;
                false
            }
            KeyCode::Char('p') => {
                let data = crate::request_data(json!({ "id": "1", "cmd": "review.prs", "cwd": cwd })).await;
                self.prs = data.ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
                self.prs_selected = 0;
                self.view = ReviewView::Prs;
                false
            }
            KeyCode::Char('g') => {
                self.agent = next_agent(&self.agent);
                false
            }
            KeyCode::Tab | KeyCode::Char('q') | KeyCode::Esc => true,
            _ => false,
        }
    }

    async fn handle_branches_key(&mut self, code: KeyCode, cwd: &str) -> bool {
        match code {
            KeyCode::Up => { self.branches_selected = self.branches_selected.saturating_sub(1); false }
            KeyCode::Down => {
                if self.branches_selected + 1 < self.branches.len() { self.branches_selected += 1; }
                false
            }
            KeyCode::Enter => {
                if let Some(b) = self.branches.get(self.branches_selected) {
                    self.base = b.clone();
                    self.refresh_files(cwd).await;
                } else {
                    self.view = ReviewView::Files;
                }
                false
            }
            KeyCode::Tab => true,
            KeyCode::Char('q') | KeyCode::Esc => {
                self.view = ReviewView::Files;
                false
            }
            _ => false,
        }
    }

    async fn handle_prs_key(&mut self, code: KeyCode, cwd: &str) -> bool {
        match code {
            KeyCode::Up => { self.prs_selected = self.prs_selected.saturating_sub(1); false }
            KeyCode::Down => {
                if self.prs_selected + 1 < self.prs.len() { self.prs_selected += 1; }
                false
            }
            KeyCode::Enter => {
                if let Some(pr) = self.prs.get(self.prs_selected).and_then(|p| p.get("number")).and_then(Value::as_u64) {
                    self.load_pr_detail(cwd, pr).await;
                }
                false
            }
            KeyCode::Tab => true,
            KeyCode::Char('q') | KeyCode::Esc => {
                self.view = ReviewView::Files;
                false
            }
            _ => false,
        }
    }

    async fn load_pr_detail(&mut self, cwd: &str, pr: u64) {
        let diff = crate::request_data(json!({ "id": "1", "cmd": "review.pr_diff", "cwd": cwd, "pr": pr }))
            .await
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_else(|| "(no se pudo cargar el diff)".to_string());
        let comments = crate::request_data(json!({ "id": "1", "cmd": "review.pr_comments", "cwd": cwd, "pr": pr }))
            .await
            .ok()
            .map(|v| format_pr_comments(&v))
            .unwrap_or_default();
        self.pr_detail = format!("{diff}\n\n---\n\n## Comentarios\n\n{comments}");
        self.pr_scroll = 0;
        self.view = ReviewView::PrDetail;
    }

    fn handle_pr_detail_key(&mut self, code: KeyCode) -> bool {
        match code {
            KeyCode::Up => { self.pr_scroll = self.pr_scroll.saturating_sub(1); false }
            KeyCode::Down => { self.pr_scroll = self.pr_scroll.saturating_add(1); false }
            KeyCode::PageUp => { self.pr_scroll = self.pr_scroll.saturating_sub(10); false }
            KeyCode::PageDown => { self.pr_scroll = self.pr_scroll.saturating_add(10); false }
            KeyCode::Tab => true,
            KeyCode::Char('q') | KeyCode::Esc => {
                self.view = ReviewView::Prs;
                false
            }
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
            KeyCode::Char('c') if self.running => {
                if let Some(task) = self.stream_task.take() { task.abort(); }
                self.stream_rx = None;
                self.running = false;
                self.output.push_str("\n\n*(cancelado)*\n");
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
            "context": "", "agents": self.agent,
        });
        self.begin_stream(body, true);
    }

    fn start_ask(&mut self, cwd: &str) {
        let question = std::mem::take(&mut self.input);
        self.output.push_str(&format!("\n\n---\n\n**Pregunta:** {question}\n\n"));
        let body = json!({
            "id": "1", "cmd": "review.ask", "cwd": cwd, "base": self.base,
            "agent": self.agent, "question": question,
        });
        self.begin_stream(body, false);
    }

    fn begin_stream(&mut self, body: Value, is_run: bool) {
        let (rx, task) = review_stream::spawn_review_stream(body);
        self.stream_rx = Some(rx);
        self.stream_task = Some(task);
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
                self.stream_task = None;
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

fn next_agent(current: &str) -> String {
    let i = AGENTS.iter().position(|a| *a == current).unwrap_or(0);
    AGENTS[(i + 1) % AGENTS.len()].to_string()
}

/// Renders `{"comments": [...], "reviews": [...]}` (from `gh pr view --json
/// comments,reviews`, forwarded raw by `review.pr_comments`) as readable
/// text — reviews first (they carry the approve/request-changes verdict),
/// then line/general comments, each defaulting to `?`/empty for whatever
/// fields a given entry happens to lack.
fn format_pr_comments(data: &Value) -> String {
    let mut out = String::new();
    for r in data.get("reviews").and_then(Value::as_array).into_iter().flatten() {
        let author = r.get("author").and_then(|a| a.get("login")).and_then(Value::as_str).unwrap_or("?");
        let state = r.get("state").and_then(Value::as_str).unwrap_or("");
        let body = r.get("body").and_then(Value::as_str).unwrap_or("");
        out.push_str(&format!("**{author}** ({state})\n{body}\n\n"));
    }
    for c in data.get("comments").and_then(Value::as_array).into_iter().flatten() {
        let author = c.get("author").and_then(|a| a.get("login")).and_then(Value::as_str).unwrap_or("?");
        let body = c.get("body").and_then(Value::as_str).unwrap_or("");
        out.push_str(&format!("**{author}**\n{body}\n\n"));
    }
    if out.is_empty() {
        out.push_str("(sin comentarios)\n");
    }
    out
}

pub(super) fn draw(frame: &mut ratatui::Frame, review: &ReviewState) {
    match review.view {
        ReviewView::Files => draw_files(frame, review),
        ReviewView::Branches => draw_branches(frame, review),
        ReviewView::Prs => draw_prs(frame, review),
        ReviewView::PrDetail => draw_pr_detail(frame, review),
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
    let title = format!(
        "Review ({}) [{}] — Enter: correr · b: ramas · p: PRs · g: agente · Tab: volver",
        review.base, review.agent
    );
    let list = List::new(items).block(Block::default().title(title).borders(Borders::ALL));
    frame.render_widget(list, frame.area());
}

fn draw_branches(frame: &mut ratatui::Frame, review: &ReviewState) {
    let items: Vec<ListItem> = review.branches.iter().map(|b| ListItem::new(b.as_str())).collect();
    let mut state = ratatui::widgets::ListState::default();
    if !review.branches.is_empty() {
        state.select(Some(review.branches_selected));
    }
    let list = List::new(items)
        .block(Block::default().title("Ramas — Enter: usar como base · Esc: volver").borders(Borders::ALL))
        .highlight_style(ratatui::style::Style::default().add_modifier(ratatui::style::Modifier::REVERSED));
    frame.render_stateful_widget(list, frame.area(), &mut state);
}

fn draw_prs(frame: &mut ratatui::Frame, review: &ReviewState) {
    let items: Vec<ListItem> = if review.prs.is_empty() {
        vec![ListItem::new("No hay PRs abiertos.")]
    } else {
        review
            .prs
            .iter()
            .map(|pr| {
                let number = pr.get("number").and_then(Value::as_u64).unwrap_or(0);
                let title = pr.get("title").and_then(Value::as_str).unwrap_or("");
                let branch = pr.get("headRefName").and_then(Value::as_str).unwrap_or("");
                ListItem::new(format!("#{number}  {title}  ({branch})"))
            })
            .collect()
    };
    let mut state = ratatui::widgets::ListState::default();
    if !review.prs.is_empty() {
        state.select(Some(review.prs_selected));
    }
    let list = List::new(items)
        .block(Block::default().title("Pull requests — Enter: ver diff y comentarios · Esc: volver").borders(Borders::ALL))
        .highlight_style(ratatui::style::Style::default().add_modifier(ratatui::style::Modifier::REVERSED));
    frame.render_stateful_widget(list, frame.area(), &mut state);
}

fn draw_pr_detail(frame: &mut ratatui::Frame, review: &ReviewState) {
    let paragraph = Paragraph::new(review.pr_detail.as_str())
        .wrap(Wrap { trim: false })
        .scroll((review.pr_scroll, 0))
        .block(Block::default().title("↑/↓ scroll · Esc: volver a la lista de PRs").borders(Borders::ALL));
    frame.render_widget(paragraph, frame.area());
}

fn draw_output(frame: &mut ratatui::Frame, review: &ReviewState) {
    let area = frame.area();
    let title = if review.running {
        let progress = if review.last_progress.is_empty() { "corriendo…".to_string() } else { review.last_progress.clone() };
        format!("{progress} — c: cancelar")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_agent_cycles_claude_codex_opencode_and_back() {
        assert_eq!(next_agent("claude"), "codex");
        assert_eq!(next_agent("codex"), "opencode");
        assert_eq!(next_agent("opencode"), "claude");
    }

    #[test]
    fn next_agent_defaults_to_first_for_an_unknown_value() {
        assert_eq!(next_agent("bogus"), "codex");
    }

    #[test]
    fn format_pr_comments_lists_reviews_before_comments() {
        let data = json!({
            "reviews": [{ "author": { "login": "ada" }, "state": "APPROVED", "body": "lgtm" }],
            "comments": [{ "author": { "login": "bob" }, "body": "nit: rename this" }],
        });
        let text = format_pr_comments(&data);
        let review_pos = text.find("ada").unwrap();
        let comment_pos = text.find("bob").unwrap();
        assert!(review_pos < comment_pos);
        assert!(text.contains("APPROVED"));
        assert!(text.contains("nit: rename this"));
    }

    #[test]
    fn format_pr_comments_handles_empty_lists() {
        let data = json!({ "reviews": [], "comments": [] });
        assert_eq!(format_pr_comments(&data), "(sin comentarios)\n");
    }
}
