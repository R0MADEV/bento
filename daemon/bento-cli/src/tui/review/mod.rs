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
use format::{file_matches_filter, format_checks, format_pr_comments, format_review_comments, FileFilter};

use serde_json::{json, Value};

use crate::review_stream::{self, ReviewEvent};

/// `select!` needs a future to poll even with no review running;
/// `pending()` never resolves, so that arm simply stays disabled.
async fn recv_optional<T>(rx: &mut Option<tokio::sync::mpsc::UnboundedReceiver<T>>) -> Option<T> {
    match rx {
        Some(r) => r.recv().await,
        None => std::future::pending().await,
    }
}

/// Los agentes que ofrece el TUI. La lista vive en `bento_review::agents`:
/// tenerla aquí otra vez era pedir que se separaran.
use bento_review::agents::AGENTS;

enum ReviewView {
    Browse,
    FileDetail,
    PrDetail,
}

pub(super) enum SidebarTab {
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
    /// Filtering what is on screen: the branch list, or the lines of a diff.
    /// Local too — nothing is fetched.
    Search,
}

/// What a background request came back with. Requests used to be awaited on
/// the event loop, which stopped the redraw and the keys for as long as the
/// daemon took — and `review.prs` shells out to `gh`, which can take a while.
/// Deciding what to ask is synchronous; asking happens off the loop and lands
/// back here.
/// Something the panel has to react to that did not come from the keyboard.
pub(super) enum ReviewUpdate {
    Stream(ReviewEvent),
    Work(Fetched),
}

pub(super) enum Fetched {
    Files { files: Vec<Value>, viewed: Vec<String> },
    Projects(Vec<Value>),
    Branches(Vec<String>),
    Prs(Vec<Value>),
    Checkpoints(Vec<Value>),
    /// The daemon said no. Shown in the header rather than rendered as an
    /// empty list, which is indistinguishable from "there is nothing".
    Failed(String),
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
    /// The extra passes desktop calls "Secundario" and "Terciario". Only used
    /// when `compare` is on; None is its "Ninguno".
    secondary: Option<String>,
    tertiary: Option<String>,
    /// When on, `start_run` reviews with the primary plus whichever extra
    /// passes are picked, and synthesizes their reports — desktop's "Comparar
    /// agentes" toggle.
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

    /// Results of requests running off the event loop.
    work_tx: tokio::sync::mpsc::UnboundedSender<Fetched>,
    work_rx: tokio::sync::mpsc::UnboundedReceiver<Fetched>,
    /// How many requests are still out, so the header stops saying "loading"
    /// only when the last one lands.
    in_flight: usize,

    /// Width of the report drawer. Kept here rather than in the panel loop
    /// because it is this panel's third column, not a global.
    pub(super) drawer_width: u16,
    /// The width to come back to when it is unfolded.
    pub(super) restored_drawer_width: u16,

    /// True while a daemon call is in flight. The panel awaits those on its
    /// event loop, so it cannot redraw or take keys until one returns; saying
    /// so is the difference between "working" and "it froze".
    pub(super) loading: bool,

    /// Last failed daemon call, shown in the sidebar header. Without it an
    /// old daemon that doesn't know a `review.*`/`projects.*` command is
    /// indistinguishable from "este proyecto no tiene ramas".
    status: String,
    projects: Vec<Value>,
    projects_selected: usize,
    /// Lo que se ha escrito con `/`. Filtra la lista de ramas y las líneas del
    /// diff que estés mirando: en un diff de mil líneas, buscar es la
    /// diferencia entre revisar y rendirse.
    search: String,
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
        let (work_tx, work_rx) = tokio::sync::mpsc::unbounded_channel();
        Self {
            cwd,
            base: "main".to_string(),
            branch: None,
            agent: AGENTS[0].id.to_string(),
            secondary: None,
            tertiary: None,
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
            work_tx,
            work_rx,
            in_flight: 0,
            drawer_width: crate::tui::drawer::DEFAULT_WIDTH,
            restored_drawer_width: crate::tui::drawer::DEFAULT_WIDTH,
            loading: false,
            status: String::new(),
            projects: Vec::new(),
            projects_selected: 0,
            search: String::new(),
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

    /// Whatever arrives first: a chunk of a running review, or the result of
    /// a request made off the event loop. One method rather than two
    /// receivers, because `select!` in the panel's loop cannot borrow the
    /// state twice while it also has to draw it.
    pub(super) async fn next_update(&mut self) -> Option<ReviewUpdate> {
        let Self { stream_rx, work_rx, .. } = self;
        tokio::select! {
            event = recv_optional(stream_rx) => event.map(ReviewUpdate::Stream),
            fetched = work_rx.recv() => fetched.map(ReviewUpdate::Work),
        }
    }


    /// Records that a request went out. The indicator counts them, so two
    /// overlapping requests do not have the first one to land clear it.
    pub(super) fn begin_request(&mut self) {
        self.in_flight += 1;
        self.loading = true;
    }

    /// Applies a result that came back from off the loop.
    pub(super) fn apply_fetched(&mut self, fetched: Fetched) {
        self.in_flight = self.in_flight.saturating_sub(1);
        self.loading = self.in_flight > 0;
        match fetched {
            Fetched::Files { files, viewed } => {
                self.files = files;
                self.files_selected = 0;
                self.reviewed = viewed.into_iter().collect();
                self.view = ReviewView::Browse;
                self.status.clear();
            }
            Fetched::Projects(projects) => { self.projects = projects; self.projects_selected = 0; self.status.clear() }
            Fetched::Branches(branches) => { self.branches = branches; self.branches_selected = 0; self.status.clear() }
            Fetched::Prs(prs) => { self.prs = prs; self.prs_selected = 0; self.status.clear() }
            Fetched::Checkpoints(checkpoints) => {
                self.checkpoints = checkpoints;
                self.checkpoints_selected = 0;
                self.status.clear()
            }
            Fetched::Failed(message) => self.status = format!("error: {message}"),
        }
    }

    /// Switches tab now and asks for its contents in the background — the tab
    /// is usable immediately, and the rows appear when the daemon answers.
    pub(super) fn request_sidebar_tab(&mut self, tab: SidebarTab) {
        let cwd = self.cwd.clone();
        let body = match &tab {
            SidebarTab::Projects => json!({ "id": "1", "cmd": "projects.list" }),
            SidebarTab::Branches => json!({ "id": "1", "cmd": "review.branches", "cwd": cwd }),
            SidebarTab::Prs => json!({ "id": "1", "cmd": "review.prs", "cwd": cwd }),
            SidebarTab::Checkpoints => json!({ "id": "1", "cmd": "review.checkpoints", "cwd": cwd }),
        };
        let wrap: fn(Vec<Value>) -> Fetched = match &tab {
            SidebarTab::Projects => Fetched::Projects,
            SidebarTab::Branches => |rows| {
                Fetched::Branches(rows.into_iter().filter_map(|v| v.as_str().map(String::from)).collect())
            },
            SidebarTab::Prs => Fetched::Prs,
            SidebarTab::Checkpoints => Fetched::Checkpoints,
        };
        self.sidebar_tab = tab;
        self.focus = Focus::Sidebar;
        self.spawn_list_request(body, wrap);
    }

    /// Runs one list request off the event loop and posts its result back.
    fn spawn_list_request(&mut self, body: Value, wrap: fn(Vec<Value>) -> Fetched) {
        self.begin_request();
        let tx = self.work_tx.clone();
        tokio::spawn(async move {
            let result = match crate::request_data(body).await {
                Ok(value) => wrap(value.as_array().cloned().unwrap_or_default()),
                Err(error) => Fetched::Failed(error.to_string()),
            };
            let _ = tx.send(result);
        });
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

    /// Asks for the changed files off the loop. Two requests, one result:
    /// the list and the per-file "reviewed" marks are always shown together,
    /// so applying them separately would flash a list with no marks.
    pub(super) fn request_files(&mut self) {
        self.begin_request();
        let (tx, cwd, base) = (self.work_tx.clone(), self.cwd.clone(), self.base.clone());
        tokio::spawn(async move {
            let files = crate::request_data(json!({ "id": "1", "cmd": "review.files", "cwd": cwd, "base": base }));
            let viewed = crate::request_data(json!({ "id": "1", "cmd": "review.viewed", "cwd": cwd, "base": base }));
            let (files, viewed) = tokio::join!(files, viewed);
            let result = match files {
                Ok(files) => Fetched::Files {
                    files: files.as_array().cloned().unwrap_or_default(),
                    viewed: viewed
                        .ok()
                        .and_then(|v| v.as_array().cloned())
                        .unwrap_or_default()
                        .iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect(),
                },
                Err(error) => Fetched::Failed(error.to_string()),
            };
            let _ = tx.send(result);
        });
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
    /// Entering the tab asks for both halves without waiting: the panel opens
    /// straight away and fills in as the answers arrive.
    pub(super) fn enter(&mut self) {
        self.request_files();
        self.request_sidebar_tab(SidebarTab::Branches);
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
        let checks = crate::request_data(json!({ "id": "1", "cmd": "review.pr_checks", "cwd": self.cwd, "pr": pr }))
            .await
            .ok()
            .map(|v| format_checks(&v))
            .unwrap_or_default();
        let inline = crate::request_data(json!({ "id": "1", "cmd": "review.pr_review_comments", "cwd": self.cwd, "pr": pr }))
            .await
            .ok()
            .map(|v| format_review_comments(&v))
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
        self.pr_detail = format!(
            "{header}{checks}{inline}\n---\n\n{diff}\n\n---\n\n## Comentarios\n\n{comments}"
        );
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

    pub(super) fn start_run(&mut self) {
        self.output.clear();
        self.session_id = None;
        self.session_agent = None;
        let agents = self.review_agents();
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
        // Stays in Browse: the report goes to the drawer beside the files
        // rather than replacing the panel, so the rail and the file list are
        // still there while it runs.
        self.view = ReviewView::Browse;
        self.open_drawer();
    }

    /// Unfolds the drawer, so a report never lands somewhere invisible.
    pub(super) fn open_drawer(&mut self) {
        if self.drawer_width <= crate::tui::drawer::COLLAPSED_WIDTH {
            self.drawer_width = self.restored_drawer_width;
        }
    }

    /// Folds it away, or brings it back to the width it had.
    pub(super) fn toggle_drawer(&mut self) {
        self.drawer_width = crate::tui::drawer::toggle(self.drawer_width, &mut self.restored_drawer_width);
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
                // A multi-agent run streams every report into one buffer. The
                // sentinels are the only place that says where one pass ends
                // and the next begins, so they become headings instead of
                // being dropped after the progress line.
                if let Some(heading) = batch_heading(&msg) {
                    self.output.push_str(&heading);
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
    /// Both halves of the panel, asked for at once and off the loop.
    pub(super) fn request_refresh(&mut self) {
        self.request_files();
        let tab = std::mem::replace(&mut self.sidebar_tab, SidebarTab::Branches);
        self.request_sidebar_tab(tab);
    }
}

impl ReviewState {
    /// Stops the review. Aborting the task drops its TcpStream, which closes
    /// the connection, which is what the daemon reads as "cancel this run" —
    /// so the agents are killed rather than left running for a stream nobody
    /// is reading.
    ///
    /// The daemon notices on its next write, so an agent that has been silent
    /// for a while keeps going until it says something. Better than the old
    /// behaviour, which was to never stop at all.
    pub(super) fn cancel_run(&mut self) {
        if let Some(task) = self.stream_task.take() {
            task.abort();
        }
        self.stream_rx = None;
        self.running = false;
        self.output.push_str("\n\n*(cancelado)*\n");
    }

    /// What the rail's action button does, which depends on what the button
    /// currently says: starting a second run from a button labelled "Parar"
    /// duplicates the work and the billing.
    pub(super) fn toggle_run(&mut self) {
        if self.running {
            self.cancel_run();
            return;
        }
        self.start_run();
    }

    /// The agents this run should use, as the daemon's comma-separated list.
    /// Without compare it is just the primary; with it, every extra pass that
    /// is set — repeats included, since asking one agent for several passes
    /// is a deliberate choice and not a mistake to correct.
    pub(super) fn review_agents(&self) -> String {
        if !self.compare {
            return self.agent.clone();
        }
        let mut agents = vec![self.agent.clone()];
        agents.extend([&self.secondary, &self.tertiary].into_iter().flatten().cloned());
        agents.join(",")
    }

    /// How many lines of fixed context the rail paints above its rows, taken
    /// from the very list that gets rendered — counting them by hand here is
    /// how the clicks drifted off by a row in the first place.
    pub(super) fn header_lines(&self) -> u16 {
        // The width only affects how the project path is shortened, never how
        // many lines there are.
        draw::sidebar_header(self, 24).len() as u16
    }

    /// How many rows the rail is showing for the tab that is open. The click
    /// handler needs it to reject clicks past the end of the list.
    pub(super) fn sidebar_len(&self) -> usize {
        match self.sidebar_tab {
            SidebarTab::Projects => self.projects.len(),
            SidebarTab::Branches => self.visible_branches().len(),
            SidebarTab::Prs => self.prs.len(),
            SidebarTab::Checkpoints => self.checkpoints.len(),
        }
    }

    /// Moves the selection of the open tab, ignoring a row that is not there.
    /// Each tab keeps its own cursor, so switching back finds it where it was.
    pub(super) fn select_sidebar(&mut self, index: usize) {
        if index >= self.sidebar_len() {
            return;
        }
        match self.sidebar_tab {
            SidebarTab::Projects => self.projects_selected = index,
            SidebarTab::Branches => self.branches_selected = index,
            SidebarTab::Prs => self.prs_selected = index,
            SidebarTab::Checkpoints => self.checkpoints_selected = index,
        }
    }

    /// Las ramas que pasan el filtro escrito con `/`.
    pub(super) fn visible_branches(&self) -> Vec<&String> {
        let needle = self.search.to_lowercase();
        self.branches.iter().filter(|b| needle.is_empty() || b.to_lowercase().contains(&needle)).collect()
    }

    /// El texto con solo las líneas que contienen la búsqueda. Se aplica al
    /// diff de un archivo, al de un PR y a la salida de la review.
    pub(super) fn filtered(&self, text: &str) -> String {
        if self.search.is_empty() {
            return text.to_string();
        }
        let needle = self.search.to_lowercase();
        text.lines().filter(|l| l.to_lowercase().contains(&needle)).collect::<Vec<_>>().join("\n")
    }
}

/// The heading for a `BATCH:i/n:agent` or `SYNTHESIS` sentinel, or None when
/// there is nothing worth announcing — a single-pass run has no other report
/// to be told apart from.
fn batch_heading(msg: &str) -> Option<String> {
    if msg == "SYNTHESIS" {
        // Same wording as the desktop panel's own label.
        return Some("\n\n---\n\n# Síntesis final\n\n".to_string());
    }
    let rest = msg.strip_prefix("BATCH:")?;
    let (counts, label) = rest.split_once(':')?;
    let (_, total) = counts.split_once('/')?;
    if total == "1" {
        return None;
    }
    // The engine's own label already says whether this is an agent's pass or
    // a slice of the diff, so it is repeated verbatim rather than reworded.
    Some(format!("\n\n---\n\n# {label}\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_with(branches: &[&str], search: &str) -> ReviewState {
        let mut state = ReviewState::new("/repo".to_string());
        state.branches = branches.iter().map(|b| b.to_string()).collect();
        state.search = search.to_string();
        state
    }

    #[test]
    fn the_rail_action_cancels_while_running_instead_of_starting_another() {
        // The button reads "■ Parar" while running; firing another run there
        // would duplicate the work, the billing and the output.
        let mut state = ReviewState::new("/repo".to_string());
        state.running = true;

        state.toggle_run();

        assert!(!state.running, "la acción tenía que parar la review en curso");
        assert!(state.output.contains("cancelado"));
    }

    // start_run() spawns the stream task, so this one needs a runtime.
    #[tokio::test]
    async fn the_rail_action_starts_a_run_when_nothing_is_running() {
        let mut state = ReviewState::new("/repo".to_string());

        state.toggle_run();

        assert!(state.running);
    }

    #[test]
    fn a_single_agent_run_sends_only_that_agent() {
        let mut state = ReviewState::new("/repo".to_string());
        state.agent = "claude".into();
        state.secondary = Some("codex".into());
        state.compare = false;

        assert_eq!(state.review_agents(), "claude", "sin comparar, los secundarios no corren");
    }

    #[test]
    fn comparing_sends_the_primary_and_every_extra_pass_in_order() {
        let mut state = ReviewState::new("/repo".to_string());
        state.agent = "claude".into();
        state.secondary = Some("codex".into());
        state.tertiary = Some("gemini".into());
        state.compare = true;

        assert_eq!(state.review_agents(), "claude,codex,gemini");
    }

    #[test]
    fn an_unset_secondary_does_not_leave_a_hole_in_the_list() {
        let mut state = ReviewState::new("/repo".to_string());
        state.agent = "claude".into();
        state.secondary = None;
        state.tertiary = Some("gemini".into());
        state.compare = true;

        assert_eq!(state.review_agents(), "claude,gemini");
    }

    #[test]
    fn comparing_with_nothing_extra_still_runs_the_primary() {
        let mut state = ReviewState::new("/repo".to_string());
        state.agent = "claude".into();
        state.compare = true;

        assert_eq!(state.review_agents(), "claude", "nunca una lista vacía");
    }

    #[test]
    fn the_same_agent_picked_twice_runs_twice() {
        // Deliberately picking one agent for several passes is a real way to
        // use this — the reports differ run to run. Deduplicating silently
        // turned three chosen passes into one, and the engine then split the
        // diff instead, which looks the same on screen but is not.
        let mut state = ReviewState::new("/repo".to_string());
        state.agent = "opencode".into();
        state.secondary = Some("opencode".into());
        state.tertiary = Some("opencode".into());
        state.compare = true;

        assert_eq!(state.review_agents(), "opencode,opencode,opencode");
    }

    #[test]
    fn each_agents_report_is_labelled_in_the_output() {
        // Three passes concatenated with no heading are indistinguishable —
        // you cannot tell whose verdict you are reading, or whether an agent
        // ran at all.
        let mut state = ReviewState::new("/repo".to_string());

        state.handle_stream_event(ReviewEvent::Progress("BATCH:1/3:Agente 1/3 (claude)".into()));
        state.handle_stream_event(ReviewEvent::Content("veredicto uno".into()));
        state.handle_stream_event(ReviewEvent::Progress("BATCH:2/3:Agente 2/3 (codex)".into()));
        state.handle_stream_event(ReviewEvent::Content("veredicto dos".into()));

        assert!(state.output.contains("claude"), "falta quién escribió el primero:\n{}", state.output);
        assert!(state.output.contains("codex"), "falta quién escribió el segundo");
        assert!(state.output.find("claude") < state.output.find("veredicto uno"));
        assert!(state.output.find("veredicto uno") < state.output.find("codex"));
    }

    #[test]
    fn a_split_diff_is_not_dressed_up_as_several_agents() {
        // One agent reading a big diff in three slices must not read as three
        // agents having run — that is exactly the claim that cannot be made
        // from the screen otherwise.
        let mut state = ReviewState::new("/repo".to_string());
        state.handle_stream_event(ReviewEvent::Progress("BATCH:1/3:Batch 1/3".into()));

        assert!(state.output.contains("Batch 1/3"));
        assert!(!state.output.to_lowercase().contains("agente"), "no hubo tres agentes:\n{}", state.output);
    }

    #[test]
    fn the_synthesis_says_it_is_the_synthesis() {
        let mut state = ReviewState::new("/repo".to_string());
        state.handle_stream_event(ReviewEvent::Progress("SYNTHESIS".into()));

        assert!(state.output.to_lowercase().contains("síntesis") || state.output.to_lowercase().contains("sintesis"));
    }

    #[test]
    fn a_single_pass_run_is_not_cluttered_with_a_heading() {
        // With one agent there is nothing to tell apart.
        let mut state = ReviewState::new("/repo".to_string());
        state.handle_stream_event(ReviewEvent::Progress("BATCH:1/1:Agente 1/1 (claude)".into()));

        assert!(state.output.is_empty(), "una sola pasada no necesita cabecera");
    }

    #[tokio::test]
    async fn switching_tab_does_not_wait_for_the_daemon() {
        // The whole point: the call is out, the panel is already usable. It
        // used to sit on the event loop, so a slow `gh` froze the tab.
        let mut state = ReviewState::new("/repo".to_string());

        state.request_sidebar_tab(SidebarTab::Prs);

        assert!(matches!(state.sidebar_tab, SidebarTab::Prs), "la pestaña cambia ya");
        assert!(state.loading, "y dice que está pidiendo");
    }

    #[test]
    fn a_result_lands_in_the_tab_it_belongs_to() {
        let mut state = ReviewState::new("/repo".to_string());
        state.sidebar_tab = SidebarTab::Branches;
        state.begin_request();

        state.apply_fetched(Fetched::Branches(vec!["main".into(), "feat/x".into()]));

        assert_eq!(state.branches, vec!["main".to_string(), "feat/x".to_string()]);
        assert!(!state.loading, "la última respuesta apaga el indicador");
    }

    #[test]
    fn the_indicator_waits_for_every_request_not_just_the_first() {
        let mut state = ReviewState::new("/repo".to_string());
        state.begin_request();
        state.begin_request();

        state.apply_fetched(Fetched::Projects(vec![]));
        assert!(state.loading, "queda una petición fuera");

        state.apply_fetched(Fetched::Prs(vec![]));
        assert!(!state.loading);
    }

    #[test]
    fn a_failed_request_says_why_instead_of_showing_an_empty_list() {
        let mut state = ReviewState::new("/repo".to_string());
        state.begin_request();

        state.apply_fetched(Fetched::Failed("daemon caído".into()));

        assert!(state.status.contains("daemon caído"));
        assert!(!state.loading);
    }

    /// The point of all this: asking does not stop the panel. If the request
    /// were still awaited inline, this would sit here until the daemon
    /// answered — and there is no daemon in a test.
    #[tokio::test]
    async fn the_panel_stays_responsive_while_a_request_is_out() {
        let mut state = ReviewState::new("/repo".to_string());
        state.request_sidebar_tab(SidebarTab::Prs);

        // Keys still work with the request in flight.
        state.branches = vec!["main".into(), "feat/x".into()];
        state.sidebar_tab = SidebarTab::Branches;
        state.select_sidebar(1);

        assert_eq!(state.branches_selected, 1);
        assert!(state.loading, "y la petición sigue fuera");
    }

    #[tokio::test]
    async fn running_a_review_keeps_you_in_the_panel() {
        // It used to switch to a full-screen view, so the rail and the file
        // list vanished for as long as the review lasted.
        let mut state = ReviewState::new("/repo".to_string());
        state.start_run();

        assert!(matches!(state.view, ReviewView::Browse), "sigue en el panel");
        assert!(state.drawer_width > crate::tui::drawer::COLLAPSED_WIDTH, "y el cajón se abre");
    }

    #[tokio::test]
    async fn a_report_never_lands_in_a_folded_drawer() {
        let mut state = ReviewState::new("/repo".to_string());
        state.toggle_drawer();
        assert_eq!(state.drawer_width, crate::tui::drawer::COLLAPSED_WIDTH);

        state.start_run();

        assert!(state.drawer_width > crate::tui::drawer::COLLAPSED_WIDTH);
    }

    #[test]
    fn folding_the_drawer_remembers_how_wide_it_was() {
        let mut state = ReviewState::new("/repo".to_string());
        state.drawer_width = 90;

        state.toggle_drawer();
        state.toggle_drawer();

        assert_eq!(state.drawer_width, 90, "vuelve a 90, no al ancho por defecto");
    }

    #[test]
    fn the_click_geometry_matches_what_the_rail_actually_paints() {
        // These two drifting apart is the whole bug: the rail painted nine or
        // ten header lines while hit-testing assumed zero, so every click in
        // Review landed on the wrong row.
        let mut state = ReviewState::new("/repo".to_string());
        assert_eq!(state.header_lines() as usize, draw::sidebar_header(&state, 24).len());

        // A status line appears and disappears, and the count has to follow.
        state.status = "error: lo que sea".into();
        assert_eq!(state.header_lines() as usize, draw::sidebar_header(&state, 24).len());

        // So does the loading line, which is the newest way to shift the rows.
        state.loading = true;
        assert_eq!(state.header_lines() as usize, draw::sidebar_header(&state, 24).len());
    }

    #[test]
    fn the_rail_reports_the_length_of_whichever_tab_is_open() {
        // The click handler needs this to know which rows exist; reporting the
        // wrong tab's length would let clicks land on rows that are not there.
        let mut state = state_with(&["main", "feat/a", "fix/b"], "");
        state.sidebar_tab = SidebarTab::Branches;
        assert_eq!(state.sidebar_len(), 3);

        state.sidebar_tab = SidebarTab::Prs;
        assert_eq!(state.sidebar_len(), 0);
    }

    #[test]
    fn selecting_from_the_rail_moves_the_open_tab_only() {
        let mut state = state_with(&["main", "feat/a", "fix/b"], "");
        state.sidebar_tab = SidebarTab::Branches;

        state.select_sidebar(2);

        assert_eq!(state.branches_selected, 2);
        assert_eq!(state.prs_selected, 0, "las otras pestañas no se mueven");
    }

    #[test]
    fn a_selection_past_the_end_is_ignored_rather_than_stored() {
        let mut state = state_with(&["main"], "");
        state.sidebar_tab = SidebarTab::Branches;

        state.select_sidebar(7);

        assert_eq!(state.branches_selected, 0);
    }

    #[test]
    fn without_a_search_every_branch_is_visible() {
        let state = state_with(&["main", "feat/a"], "");
        assert_eq!(state.visible_branches().len(), 2);
    }

    #[test]
    fn the_search_filters_branches_ignoring_case() {
        let state = state_with(&["main", "feat/Cache", "fix/cachear"], "CACHE");
        assert_eq!(state.visible_branches().len(), 2);
    }

    #[test]
    fn a_search_with_no_matches_leaves_the_list_empty() {
        let state = state_with(&["main"], "no-existe");
        assert!(state.visible_branches().is_empty());
    }

    #[test]
    fn the_diff_keeps_only_the_matching_lines() {
        let state = state_with(&[], "todo");
        let diff = "+ hecho\n+ TODO: esto no\n- otra cosa\n";
        assert_eq!(state.filtered(diff), "+ TODO: esto no");
    }

    #[test]
    fn without_a_search_the_diff_is_untouched() {
        let state = state_with(&[], "");
        let diff = "+ a\n- b";
        assert_eq!(state.filtered(diff), diff);
    }
}
