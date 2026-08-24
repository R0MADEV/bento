//! Review tab: browse files/branches/PRs, view per-file diffs, comment on
//! and submit PR reviews, run a full AI review, and ask follow-up questions
//! — all via the same `review.*` IPC commands the one-shot `bento review`
//! subcommands already use.

use crossterm::event::{Event, KeyCode, KeyEventKind};
use ratatui::layout::{Constraint, Layout};
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph, Wrap};
use serde_json::{json, Value};

use crate::review_stream::{self, ReviewEvent};

const AGENTS: [&str; 3] = ["claude", "codex", "opencode"];

enum ReviewView {
    Files,
    FileDetail,
    Branches,
    Prs,
    PrDetail,
    Checkpoints,
    Output,
}

/// What a pending text-input buffer is for — set when entering input mode,
/// consumed on Enter to decide which `review.*` command to fire.
enum InputPurpose {
    Ask,
    PrComment,
    /// Submitting a PR review: "APPROVE" | "REQUEST_CHANGES" | "COMMENT".
    PrReview(&'static str),
    /// Editing the author context injected into the review prompt — purely
    /// local state, no request fires on Enter.
    Context,
}

pub(super) struct ReviewState {
    base: String,
    agent: String,
    /// When on, `start_run` reviews with all of `AGENTS` and synthesizes
    /// their reports instead of just `agent` — mirrors desktop's "compare
    /// agents" toggle (simplified: the TUI has room for an on/off switch,
    /// not per-agent secondary/tertiary pickers).
    compare: bool,
    /// Author-supplied focus notes injected into the review prompt —
    /// mirrors desktop's "Contexto para la review" textarea.
    context: String,
    files: Vec<Value>,
    files_selected: usize,
    view: ReviewView,
    output: String,
    scroll: u16,
    running: bool,
    last_progress: String,
    stream_rx: Option<tokio::sync::mpsc::UnboundedReceiver<ReviewEvent>>,
    stream_task: Option<tokio::task::JoinHandle<()>>,
    input_purpose: Option<InputPurpose>,
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
    current_pr: Option<u64>,
    pr_detail: String,
    pr_scroll: u16,
    pr_status: String,
    file_diff: String,
    file_scroll: u16,
    checkpoints: Vec<Value>,
    checkpoints_selected: usize,
}

impl ReviewState {
    pub(super) fn new() -> Self {
        Self {
            base: "main".to_string(),
            agent: AGENTS[0].to_string(),
            compare: false,
            context: String::new(),
            files: Vec::new(),
            files_selected: 0,
            view: ReviewView::Files,
            output: String::new(),
            scroll: 0,
            running: false,
            last_progress: String::new(),
            stream_rx: None,
            stream_task: None,
            input_purpose: None,
            input: String::new(),
            is_run_stream: false,
            session_id: None,
            session_agent: None,
            branches: Vec::new(),
            branches_selected: 0,
            prs: Vec::new(),
            prs_selected: 0,
            current_pr: None,
            pr_detail: String::new(),
            pr_scroll: 0,
            pr_status: String::new(),
            file_diff: String::new(),
            file_scroll: 0,
            checkpoints: Vec::new(),
            checkpoints_selected: 0,
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
        self.files_selected = 0;
        self.view = ReviewView::Files;
    }

    /// Handles one input event. Returns `true` if the panel should switch
    /// back to the terminals list.
    pub(super) async fn handle_event(&mut self, event: Event, cwd: &str) -> bool {
        let Event::Key(key) = event else { return false };
        if key.kind != KeyEventKind::Press {
            return false;
        }
        if self.input_purpose.is_some() {
            self.handle_text_input(key.code, cwd).await;
            return false;
        }
        match self.view {
            ReviewView::Files => self.handle_files_key(key.code, cwd).await,
            ReviewView::FileDetail => self.handle_file_detail_key(key.code),
            ReviewView::Branches => self.handle_branches_key(key.code, cwd).await,
            ReviewView::Prs => self.handle_prs_key(key.code, cwd).await,
            ReviewView::PrDetail => self.handle_pr_detail_key(key.code),
            ReviewView::Checkpoints => self.handle_checkpoints_key(key.code, cwd).await,
            ReviewView::Output => self.handle_output_key(key.code),
        }
    }

    async fn handle_files_key(&mut self, code: KeyCode, cwd: &str) -> bool {
        match code {
            KeyCode::Up => { self.files_selected = self.files_selected.saturating_sub(1); false }
            KeyCode::Down => {
                if self.files_selected + 1 < self.files.len() { self.files_selected += 1; }
                false
            }
            KeyCode::Enter => {
                if let Some(path) = self.files.get(self.files_selected).and_then(|f| f.get("path")).and_then(Value::as_str) {
                    let data = crate::request_data(json!({
                        "id": "1", "cmd": "review.file", "cwd": cwd, "base": self.base, "path": path,
                    })).await;
                    self.file_diff = data.ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| "(no se pudo cargar el diff)".to_string());
                    self.file_scroll = 0;
                    self.view = ReviewView::FileDetail;
                }
                false
            }
            KeyCode::Char('r') => {
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
            KeyCode::Char('x') => {
                self.compare = !self.compare;
                false
            }
            KeyCode::Char('c') => {
                self.input_purpose = Some(InputPurpose::Context);
                self.input = self.context.clone();
                false
            }
            KeyCode::Char('h') => {
                let data = crate::request_data(json!({ "id": "1", "cmd": "review.checkpoints", "cwd": cwd })).await;
                self.checkpoints = data.ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
                self.checkpoints_selected = 0;
                self.view = ReviewView::Checkpoints;
                false
            }
            KeyCode::Tab | KeyCode::Char('q') | KeyCode::Esc => true,
            _ => false,
        }
    }

    async fn handle_checkpoints_key(&mut self, code: KeyCode, cwd: &str) -> bool {
        match code {
            KeyCode::Up => { self.checkpoints_selected = self.checkpoints_selected.saturating_sub(1); false }
            KeyCode::Down => {
                if self.checkpoints_selected + 1 < self.checkpoints.len() { self.checkpoints_selected += 1; }
                false
            }
            KeyCode::Enter => {
                if let Some(base) = self.checkpoints.get(self.checkpoints_selected).and_then(|c| c.get("base")).and_then(Value::as_str) {
                    let base = base.to_string();
                    let data = crate::request_data(json!({ "id": "1", "cmd": "review.checkpoint_get", "cwd": cwd, "base": base })).await;
                    if let Ok(cp) = data {
                        self.base = base;
                        self.output = cp.get("content").and_then(Value::as_str).unwrap_or_default().to_string();
                        self.session_id = cp.get("session_id").and_then(Value::as_str).map(String::from);
                        self.session_agent = cp.get("session_agent").and_then(Value::as_str).map(String::from);
                        self.scroll = 0;
                        self.running = false;
                        self.last_progress.clear();
                        self.view = ReviewView::Output;
                    }
                }
                false
            }
            KeyCode::Char('d') => {
                if let Some(base) = self.checkpoints.get(self.checkpoints_selected).and_then(|c| c.get("base")).and_then(Value::as_str) {
                    let base = base.to_string();
                    let _ = crate::request_data(json!({ "id": "1", "cmd": "review.checkpoint_delete", "cwd": cwd, "base": base })).await;
                    let data = crate::request_data(json!({ "id": "1", "cmd": "review.checkpoints", "cwd": cwd })).await;
                    self.checkpoints = data.ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
                    if self.checkpoints_selected >= self.checkpoints.len() {
                        self.checkpoints_selected = self.checkpoints.len().saturating_sub(1);
                    }
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

    fn handle_file_detail_key(&mut self, code: KeyCode) -> bool {
        match code {
            KeyCode::Up => { self.file_scroll = self.file_scroll.saturating_sub(1); false }
            KeyCode::Down => { self.file_scroll = self.file_scroll.saturating_add(1); false }
            KeyCode::PageUp => { self.file_scroll = self.file_scroll.saturating_sub(10); false }
            KeyCode::PageDown => { self.file_scroll = self.file_scroll.saturating_add(10); false }
            KeyCode::Tab => true,
            KeyCode::Char('q') | KeyCode::Esc => {
                self.view = ReviewView::Files;
                false
            }
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
        self.current_pr = Some(pr);
        self.pr_status.clear();
        self.view = ReviewView::PrDetail;
    }

    fn handle_pr_detail_key(&mut self, code: KeyCode) -> bool {
        match code {
            KeyCode::Up => { self.pr_scroll = self.pr_scroll.saturating_sub(1); false }
            KeyCode::Down => { self.pr_scroll = self.pr_scroll.saturating_add(1); false }
            KeyCode::PageUp => { self.pr_scroll = self.pr_scroll.saturating_sub(10); false }
            KeyCode::PageDown => { self.pr_scroll = self.pr_scroll.saturating_add(10); false }
            KeyCode::Char('a') => {
                self.input_purpose = Some(InputPurpose::PrComment);
                self.input.clear();
                false
            }
            KeyCode::Char('y') => {
                self.input_purpose = Some(InputPurpose::PrReview("APPROVE"));
                self.input.clear();
                false
            }
            KeyCode::Char('n') => {
                self.input_purpose = Some(InputPurpose::PrReview("REQUEST_CHANGES"));
                self.input.clear();
                false
            }
            KeyCode::Char('m') => {
                self.input_purpose = Some(InputPurpose::PrReview("COMMENT"));
                self.input.clear();
                false
            }
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
                self.input_purpose = Some(InputPurpose::Ask);
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

    async fn handle_text_input(&mut self, code: KeyCode, cwd: &str) {
        match code {
            KeyCode::Char(c) => self.input.push(c),
            KeyCode::Backspace => { self.input.pop(); }
            KeyCode::Esc => {
                self.input_purpose = None;
                self.input.clear();
            }
            KeyCode::Enter => {
                match self.input_purpose.take() {
                    Some(InputPurpose::Ask) => {
                        if !self.input.trim().is_empty() { self.start_ask(cwd); }
                    }
                    Some(InputPurpose::PrComment) => self.submit_pr_comment(cwd).await,
                    Some(InputPurpose::PrReview(event)) => self.submit_pr_review(cwd, event).await,
                    Some(InputPurpose::Context) => self.context = std::mem::take(&mut self.input),
                    None => {}
                }
            }
            _ => {}
        }
    }

    async fn submit_pr_comment(&mut self, cwd: &str) {
        let Some(pr) = self.current_pr else { return };
        let body = std::mem::take(&mut self.input);
        if body.trim().is_empty() {
            return;
        }
        let result = crate::request_data(json!({
            "id": "1", "cmd": "review.pr_comment_add", "cwd": cwd, "pr": pr, "data": body,
        })).await;
        self.pr_status = match result {
            Ok(_) => "comentario agregado".to_string(),
            Err(e) => format!("error: {e}"),
        };
        self.load_pr_detail(cwd, pr).await;
    }

    async fn submit_pr_review(&mut self, cwd: &str, event: &str) {
        let Some(pr) = self.current_pr else { return };
        let body = std::mem::take(&mut self.input);
        let mut req = json!({ "id": "1", "cmd": "review.pr_submit", "cwd": cwd, "pr": pr, "event": event });
        if !body.trim().is_empty() {
            req["data"] = json!(body);
        }
        let result = crate::request_data(req).await;
        self.pr_status = match result {
            Ok(_) => format!("review enviada ({event})"),
            Err(e) => format!("error: {e}"),
        };
        self.load_pr_detail(cwd, pr).await;
    }

    fn start_run(&mut self, cwd: &str) {
        self.output.clear();
        self.session_id = None;
        self.session_agent = None;
        let agents = if self.compare { AGENTS.join(",") } else { self.agent.clone() };
        let body = json!({
            "id": "1", "cmd": "review.run", "cwd": cwd, "base": self.base,
            "context": self.context, "agents": agents,
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
        ReviewView::FileDetail => draw_file_detail(frame, review),
        ReviewView::Branches => draw_branches(frame, review),
        ReviewView::Prs => draw_prs(frame, review),
        ReviewView::PrDetail => draw_pr_detail(frame, review),
        ReviewView::Checkpoints => draw_checkpoints(frame, review),
        ReviewView::Output => draw_output(frame, review),
    }
}

fn draw_files(frame: &mut ratatui::Frame, review: &ReviewState) {
    let area = frame.area();
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
    let mut state = ratatui::widgets::ListState::default();
    if !review.files.is_empty() {
        state.select(Some(review.files_selected));
    }
    let agent_label = if review.compare { "comparar todos".to_string() } else { review.agent.clone() };
    let context_hint = if review.context.is_empty() { "" } else { " · contexto: sí" };
    let title = format!(
        "Review ({}) [{agent_label}]{context_hint} — Enter: ver diff · r: correr · x: comparar · c: contexto · h: historial · b: ramas · p: PRs · g: agente · Tab: volver",
        review.base,
    );
    let block = Block::default().title(title).borders(Borders::ALL);

    if matches!(review.input_purpose, Some(InputPurpose::Context)) {
        let chunks = Layout::vertical([Constraint::Min(1), Constraint::Length(3)]).split(area);
        let list = List::new(items)
            .block(block)
            .highlight_style(ratatui::style::Style::default().add_modifier(ratatui::style::Modifier::REVERSED));
        frame.render_stateful_widget(list, chunks[0], &mut state);
        let input = Paragraph::new(format!("{}▏", review.input))
            .block(Block::default().title("Contexto para la review (Enter guardar, Esc cancelar)").borders(Borders::ALL));
        frame.render_widget(input, chunks[1]);
    } else {
        let list = List::new(items)
            .block(block)
            .highlight_style(ratatui::style::Style::default().add_modifier(ratatui::style::Modifier::REVERSED));
        frame.render_stateful_widget(list, area, &mut state);
    }
}

fn draw_checkpoints(frame: &mut ratatui::Frame, review: &ReviewState) {
    let items: Vec<ListItem> = if review.checkpoints.is_empty() {
        vec![ListItem::new("Sin reviews guardadas.")]
    } else {
        review
            .checkpoints
            .iter()
            .map(|c| {
                let base = c.get("base").and_then(Value::as_str).unwrap_or("?");
                let saved_at = c.get("saved_at").and_then(Value::as_str).unwrap_or("");
                ListItem::new(format!("{base}  ({saved_at})"))
            })
            .collect()
    };
    let mut state = ratatui::widgets::ListState::default();
    if !review.checkpoints.is_empty() {
        state.select(Some(review.checkpoints_selected));
    }
    let list = List::new(items)
        .block(Block::default().title("Historial — Enter: abrir · d: borrar · Esc: volver").borders(Borders::ALL))
        .highlight_style(ratatui::style::Style::default().add_modifier(ratatui::style::Modifier::REVERSED));
    frame.render_stateful_widget(list, frame.area(), &mut state);
}

fn draw_file_detail(frame: &mut ratatui::Frame, review: &ReviewState) {
    let paragraph = Paragraph::new(review.file_diff.as_str())
        .wrap(Wrap { trim: false })
        .scroll((review.file_scroll, 0))
        .block(Block::default().title("↑/↓ scroll · Esc: volver a la lista de archivos").borders(Borders::ALL));
    frame.render_widget(paragraph, frame.area());
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
    let area = frame.area();
    let title = if review.pr_status.is_empty() {
        "↑/↓ scroll · a: comentar · y: aprobar · n: pedir cambios · m: comentar review · Esc: volver".to_string()
    } else {
        review.pr_status.clone()
    };
    let block = Block::default().title(format!("PR — {title}")).borders(Borders::ALL);

    if let Some(label) = pr_input_label(review) {
        let chunks = Layout::vertical([Constraint::Min(1), Constraint::Length(3)]).split(area);
        let paragraph = Paragraph::new(review.pr_detail.as_str())
            .wrap(Wrap { trim: false })
            .scroll((review.pr_scroll, 0))
            .block(block);
        frame.render_widget(paragraph, chunks[0]);
        let input = Paragraph::new(format!("{}▏", review.input))
            .block(Block::default().title(label).borders(Borders::ALL));
        frame.render_widget(input, chunks[1]);
    } else {
        let paragraph = Paragraph::new(review.pr_detail.as_str())
            .wrap(Wrap { trim: false })
            .scroll((review.pr_scroll, 0))
            .block(block);
        frame.render_widget(paragraph, area);
    }
}

fn pr_input_label(review: &ReviewState) -> Option<&'static str> {
    match review.input_purpose {
        Some(InputPurpose::PrComment) => Some("Comentario (Enter enviar, Esc cancelar)"),
        Some(InputPurpose::PrReview("APPROVE")) => Some("Aprobar — texto opcional (Enter enviar, Esc cancelar)"),
        Some(InputPurpose::PrReview("REQUEST_CHANGES")) => Some("Pedir cambios — texto (Enter enviar, Esc cancelar)"),
        Some(InputPurpose::PrReview(_)) => Some("Comentario de review (Enter enviar, Esc cancelar)"),
        Some(InputPurpose::Ask) | Some(InputPurpose::Context) | None => None,
    }
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

    if matches!(review.input_purpose, Some(InputPurpose::Ask)) {
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
