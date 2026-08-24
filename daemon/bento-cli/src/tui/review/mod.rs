//! Review tab: a persistent split-pane browser (sidebar: base/agent/compare
//! controls + proyectos/ramas/PRs/historial tabs; main: changed files with
//! per-file "reviewed" tracking) mirroring the desktop app's Tech Review
//! panel, plus full-screen drill-downs for a file's diff, a PR's
//! diff/comments, and a running/loaded review — all via the same
//! `review.*`/`projects.*` IPC commands the one-shot `bento review`
//! subcommands already use.

mod draw;
mod format;
mod input;

pub(super) use draw::draw;
use format::{file_matches_filter, format_pr_comments, FileFilter};

use serde_json::{json, Value};

use crate::review_stream::{self, ReviewEvent};

const AGENTS: [&str; 3] = ["claude", "codex", "opencode"];

enum ReviewView {
    Browse,
    FileDetail,
    PrDetail,
    Output,
}

enum SidebarTab {
    Projects,
    Branches,
    Prs,
    Checkpoints,
}

enum Focus {
    Sidebar,
    Files,
}

#[derive(Clone, Copy, PartialEq, Debug)]

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
    /// The project being reviewed. Starts as wherever `bento` was launched
    /// from; the sidebar's Proyectos tab lets you switch it to any other
    /// directory a currently-open terminal/agent is running in (the same
    /// "known projects" source `/api/projects` uses for the phone remote).
    cwd: String,
    base: String,
    /// La rama a revisar contra `base`. Sin ella se revisa el working tree,
    /// que es el caso habitual; con ella puedes revisar la rama de otro sin
    /// cambiarte a ella.
    branch: Option<String>,
    agent: String,
    /// When on, `start_run` reviews with all of `AGENTS` and synthesizes
    /// their reports instead of just `agent` — mirrors desktop's "compare
    /// agents" toggle (simplified: the TUI has room for an on/off switch,
    /// not per-agent secondary/tertiary pickers).
    compare: bool,
    /// Author-supplied focus notes injected into the review prompt —
    /// mirrors desktop's "Contexto para la review" textarea.
    context: String,

    view: ReviewView,
    focus: Focus,
    sidebar_tab: SidebarTab,

    files: Vec<Value>,
    files_selected: usize,
    file_filter: FileFilter,
    reviewed: std::collections::HashSet<String>,

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

    /// Last failed daemon call, shown in the sidebar header. Without it an
    /// old daemon that doesn't know a `review.*`/`projects.*` command is
    /// indistinguishable from "este proyecto no tiene ramas".
    status: String,
    projects: Vec<Value>,
    projects_selected: usize,
    branches: Vec<String>,
    branches_selected: usize,
    prs: Vec<Value>,
    prs_selected: usize,
    current_pr: Option<u64>,
    pr_detail: String,
    pr_scroll: u16,
    pr_status: String,
    checkpoints: Vec<Value>,
    checkpoints_selected: usize,

    file_diff: String,
    file_scroll: u16,
}

impl ReviewState {
    pub(super) fn new(cwd: String) -> Self {
        Self {
            cwd,
            base: "main".to_string(),
            branch: None,
            agent: AGENTS[0].to_string(),
            compare: false,
            context: String::new(),
            view: ReviewView::Browse,
            focus: Focus::Files,
            sidebar_tab: SidebarTab::Branches,
            files: Vec::new(),
            files_selected: 0,
            file_filter: FileFilter::All,
            reviewed: std::collections::HashSet::new(),
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
            status: String::new(),
            projects: Vec::new(),
            projects_selected: 0,
            branches: Vec::new(),
            branches_selected: 0,
            prs: Vec::new(),
            prs_selected: 0,
            current_pr: None,
            pr_detail: String::new(),
            pr_scroll: 0,
            pr_status: String::new(),
            checkpoints: Vec::new(),
            checkpoints_selected: 0,
            file_diff: String::new(),
            file_scroll: 0,
        }
    }

    pub(super) fn stream_rx(&mut self) -> &mut Option<tokio::sync::mpsc::UnboundedReceiver<ReviewEvent>> {
        &mut self.stream_rx
    }

    /// Every list the sidebar/browser shows comes through here so a daemon
    /// error surfaces in the header instead of rendering as an empty list.
    async fn fetch_list(&mut self, body: Value) -> Vec<Value> {
        match crate::request_data(body).await {
            Ok(v) => {
                self.status.clear();
                v.as_array().cloned().unwrap_or_default()
            }
            Err(e) => {
                self.status = format!("error: {e}");
                Vec::new()
            }
        }
    }

    pub(super) async fn refresh_files(&mut self) {
        self.files = self.fetch_list(json!({
            "id": "1", "cmd": "review.files", "cwd": self.cwd, "base": self.base,
        })).await;
        self.files_selected = 0;
        // Persistido por proyecto+base en el mismo almacén que los
        // checkpoints: la marca sobrevive al refresco y al reinicio.
        self.reviewed = self
            .fetch_list(json!({ "id": "1", "cmd": "review.viewed", "cwd": self.cwd, "base": self.base }))
            .await
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        self.view = ReviewView::Browse;
    }

    /// Populates both panes for a fresh entry into the Review tab (List →
    /// Tab): files, and the sidebar's default tab (branches) — without this,
    /// the sidebar shows "Ramas" as active but empty until `b` is pressed.
    pub(super) async fn enter(&mut self) {
        self.refresh_files().await;
        self.fetch_branches().await;
    }

    async fn fetch_branches(&mut self) {
        self.branches = self.fetch_list(json!({ "id": "1", "cmd": "review.branches", "cwd": self.cwd })).await
            .into_iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        self.branches_selected = 0;
    }

    fn visible_files(&self) -> Vec<&Value> {
        self.files
            .iter()
            .filter(|f| {
                let status = f.get("status").and_then(Value::as_str).unwrap_or("");
                file_matches_filter(status, self.file_filter)
            })
            .collect()
    }

    async fn set_sidebar_tab(&mut self, tab: SidebarTab) {
        match &tab {
            SidebarTab::Projects => {
                self.projects = self.fetch_list(json!({ "id": "1", "cmd": "projects.list" })).await;
                self.projects_selected = 0;
            }
            SidebarTab::Branches => self.fetch_branches().await,
            SidebarTab::Prs => {
                self.prs = self.fetch_list(json!({ "id": "1", "cmd": "review.prs", "cwd": self.cwd })).await;
                self.prs_selected = 0;
            }
            SidebarTab::Checkpoints => {
                self.checkpoints = self.fetch_list(json!({ "id": "1", "cmd": "review.checkpoints", "cwd": self.cwd })).await;
                self.checkpoints_selected = 0;
            }
        }
        self.sidebar_tab = tab;
        self.focus = Focus::Sidebar;
    }

    async fn load_pr_detail(&mut self, pr: u64) {
        let diff = crate::request_data(json!({ "id": "1", "cmd": "review.pr_diff", "cwd": self.cwd, "pr": pr }))
            .await
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_else(|| "(no se pudo cargar el diff)".to_string());
        let comments = crate::request_data(json!({ "id": "1", "cmd": "review.pr_comments", "cwd": self.cwd, "pr": pr }))
            .await
            .ok()
            .map(|v| format_pr_comments(&v))
            .unwrap_or_default();
        // Encabezado con lo que ya trae la lista: sin él, el detalle abría
        // directamente en el diff y no decía ni de qué PR era.
        let header = self
            .prs
            .iter()
            .find(|p| p.get("number").and_then(Value::as_u64) == Some(pr))
            .map(|p| {
                let field = |key: &str| p.get(key).and_then(Value::as_str).unwrap_or("").to_string();
                let author = p.get("author").and_then(|a| a.get("login")).and_then(Value::as_str).unwrap_or("?");
                format!(
                    "# #{pr} {}\n\n{} → {} · @{author}\n{}\n",
                    field("title"), field("headRefName"), field("baseRefName"), field("url"),
                )
            })
            .unwrap_or_else(|| format!("# PR #{pr}\n"));
        self.pr_detail = format!("{header}\n---\n\n{diff}\n\n---\n\n## Comentarios\n\n{comments}");
        self.pr_scroll = 0;
        self.current_pr = Some(pr);
        self.pr_status.clear();
        self.view = ReviewView::PrDetail;
    }

    async fn submit_pr_comment(&mut self) {
        let Some(pr) = self.current_pr else { return };
        let body = std::mem::take(&mut self.input);
        if body.trim().is_empty() {
            return;
        }
        let result = crate::request_data(json!({
            "id": "1", "cmd": "review.pr_comment_add", "cwd": self.cwd, "pr": pr, "data": body,
        })).await;
        self.pr_status = match result {
            Ok(_) => "comentario agregado".to_string(),
            Err(e) => format!("error: {e}"),
        };
        self.load_pr_detail(pr).await;
    }

    async fn submit_pr_review(&mut self, event: &str) {
        let Some(pr) = self.current_pr else { return };
        let body = std::mem::take(&mut self.input);
        let mut req = json!({ "id": "1", "cmd": "review.pr_submit", "cwd": self.cwd, "pr": pr, "event": event });
        if !body.trim().is_empty() {
            req["data"] = json!(body);
        }
        let result = crate::request_data(req).await;
        self.pr_status = match result {
            Ok(_) => format!("review enviada ({event})"),
            Err(e) => format!("error: {e}"),
        };
        self.load_pr_detail(pr).await;
    }

    fn start_run(&mut self) {
        self.output.clear();
        self.session_id = None;
        self.session_agent = None;
        let agents = if self.compare { AGENTS.join(",") } else { self.agent.clone() };
        let mut body = json!({
            "id": "1", "cmd": "review.run", "cwd": self.cwd, "base": self.base,
            "context": self.context, "agents": agents,
        });
        if let Some(branch) = &self.branch {
            body["branch"] = json!(branch);
        }
        self.begin_stream(body, true);
    }

    fn start_ask(&mut self) {
        let question = std::mem::take(&mut self.input);
        self.output.push_str(&format!("\n\n---\n\n**Pregunta:** {question}\n\n"));
        let body = json!({
            "id": "1", "cmd": "review.ask", "cwd": self.cwd, "base": self.base,
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

    pub(super) fn handle_stream_event(&mut self, event: ReviewEvent) {
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
                    self.save_checkpoint();
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
    fn save_checkpoint(&self) {
        let body = json!({
            "id": "1", "cmd": "review.checkpoint_save", "cwd": self.cwd, "base": self.base,
            "content": self.output, "session_id": self.session_id, "agent": self.session_agent,
        });
        tokio::spawn(async move {
            let _ = crate::request_data(body).await;
        });
    }
}

impl ReviewState {
    /// Fire-and-forget: guarda la lista de revisados para este proyecto+base.
    pub(super) fn save_reviewed(&self) {
        let body = json!({
            "id": "1", "cmd": "review.viewed_set", "cwd": self.cwd, "base": self.base,
            "paths": self.reviewed.iter().cloned().collect::<Vec<_>>(),
        });
        tokio::spawn(async move {
            let _ = crate::request_data(body).await;
        });
    }
}

impl ReviewState {
    /// Vuelve a pedir lo que se ve ahora mismo: los archivos y la pestaña
    /// activa del sidebar. Sin esto, un commit o un `git add` hechos en otra
    /// terminal no aparecían hasta salir y volver a entrar.
    pub(super) async fn refresh(&mut self) {
        self.refresh_files().await;
        let tab = std::mem::replace(&mut self.sidebar_tab, SidebarTab::Branches);
        self.set_sidebar_tab(tab).await;
    }
}
