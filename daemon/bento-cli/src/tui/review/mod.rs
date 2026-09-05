//! Review tab: a persistent split-pane browser (sidebar: base/agent/compare
//! controls + proyectos/ramas/PRs tabs; main: changed files with
//! per-file "reviewed" tracking) mirroring the desktop app's Tech Review
//! panel, plus full-screen drill-downs for a file's diff, a PR's
//! diff/comments, and a running/loaded review — all via the same
//! `review.*`/`projects.*` IPC commands the one-shot `bento review`
//! subcommands already use.

mod draw;
mod drawer_state;
mod format;
mod input;
mod mouse;
pub(in crate::tui) use mouse::ReviewMouse;
mod pr_actions;
mod rows;
mod run_state;
mod visible;

pub(super) use draw::draw;
use format::{file_matches_filter, FileFilter};

use serde_json::{json, Value};

use crate::review_stream::ReviewEvent;

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
    PrDetail,
}

pub(super) enum SidebarTab {
    Projects,
    Branches,
    Prs,
}

#[derive(Clone, Copy)]
pub(super) enum Focus {
    Sidebar,
    Files,
    /// The report drawer. Arrow keys scroll it instead of moving a selection,
    /// because there is nothing to select in a report.
    Drawer,
}

#[derive(Clone, Copy, PartialEq, Debug)]

enum InputPurpose {
    Ask,
    PrComment,
    /// Comentando una línea del diff: la del fichero nuevo a la que se ancla.
    InlineComment(u64),
    /// Submitting a PR review: "APPROVE" | "REQUEST_CHANGES" | "COMMENT".
    PrReview(&'static str),
    /// Editing the author context injected into the review prompt — purely
    /// local state, no request fires on Enter.
    Context,
    /// Filtrando el raíl: la lista de ramas. Local — no se pide nada.
    Search,
    /// Filtrando la derecha: los ficheros y las líneas del diff.
    FileSearch,
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
    /// La fila marcada del panel, contando los ficheros y las líneas de los
    /// diffs desplegados: se navega por una sola lista, como en el escritorio.
    files_selected: usize,
    /// El diff de cada fichero abierto, por ruta. Varios a la vez, que es lo
    /// que permite comparar dos sitios de un cambio sin ir y volver.
    expanded: std::collections::HashMap<String, String>,
    /// Vista partida: el fichero viejo a la izquierda y el nuevo a la derecha,
    /// como el botón de dos columnas del escritorio.
    split: bool,
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

    /// Identifies the review in flight, so its saves land on one entry and a
    /// later review of the same branch does not overwrite it.
    run_id: Option<String>,

    /// Whether the drawer is listing past reviews instead of showing one.
    /// The drawer is either "the report" or "which report", never a third
    /// place to look.
    pub(super) showing_history: bool,

    /// Whether the report drawer is on screen. An explicit flag rather than
    /// "is there output": a run that failed before writing anything used to
    /// take the drawer away along with the error inside it. Once open it
    /// stays until the user folds it.
    pub(super) drawer_open: bool,
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
    /// La carpeta que se está mirando al elegir proyecto, y lo que hay dentro.
    /// El escritorio abre el diálogo del sistema y el móvil su navegador; esta
    /// enseñaba solo los proyectos con terminal abierta, que no es elegir.
    browse_path: std::path::PathBuf,
    browse_dirs: Vec<String>,
    projects_selected: usize,
    /// Lo que se ha escrito con `/`. Filtra la lista de ramas y las líneas del
    /// diff que estés mirando: en un diff de mil líneas, buscar es la
    /// diferencia entre revisar y rendirse.
    search: String,
    /// Y el de la derecha: ficheros y líneas del diff. Son dos cosas distintas
    /// —el escritorio tiene "Filtrar…" sobre las ramas y "Buscar archivos…"
    /// sobre la lista—, y con uno solo, buscar una rama te vaciaba la lista de
    /// ficheros.
    file_search: String,
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
    /// Si la review en curso ya mandó su documento, para no archivarla dos
    /// veces ni dejar de archivarla con un daemon que todavía no lo manda.
    has_document: bool,

    /// El fichero cuyo diff se está mirando: un comentario en línea va contra
    /// él, no contra el que esté seleccionado en la lista.
    current_file: Option<String>,
}

/// Contra qué se compara al abrir: `origin/<la principal>` si existe, y si no
/// la principal a secas. Es lo mismo que elige el panel del escritorio; la TUI
/// tenía "main" escrito a mano, así que en un repo cuya principal es otra —o
/// estando en la principal, con todo commiteado— no enseñaba ni un fichero.
fn default_base(cwd: &str) -> String {
    let branch = bento_review::branches::default_branch(cwd);
    let remote = format!("origin/{branch}");
    let branches = bento_review::branches::review_branches(cwd).unwrap_or_default();
    match branches.contains(&remote) {
        true => remote,
        false => branch,
    }
}

impl ReviewState {
    pub(super) fn new(cwd: String) -> Self {
        let base = default_base(&cwd);
        let browse_path = std::path::PathBuf::from(&cwd);
        let (work_tx, work_rx) = tokio::sync::mpsc::unbounded_channel();
        Self {
            cwd,
            base,
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
            expanded: std::collections::HashMap::new(),
            split: false,
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
            showing_history: false,
            run_id: None,
            drawer_open: false,
            drawer_width: crate::tui::drawer::DEFAULT_WIDTH,
            restored_drawer_width: crate::tui::drawer::DEFAULT_WIDTH,
            loading: false,
            status: String::new(),
            browse_path,
            browse_dirs: Vec::new(),
            projects_selected: 0,
            search: String::new(),
            file_search: String::new(),
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
            has_document: false,
            current_file: None,
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
    /// Relee la carpeta que se está mirando.
    pub(super) fn refresh_browse(&mut self) {
        self.browse_dirs = format::subdirs(&self.browse_path);
        self.projects_selected = 0;
    }

    pub(super) fn request_sidebar_tab(&mut self, tab: SidebarTab) {
        if matches!(tab, SidebarTab::Projects) {
            self.refresh_browse();
            self.sidebar_tab = tab;
            self.focus = Focus::Sidebar;
            return;
        }
        let cwd = self.cwd.clone();
        let body = match &tab {
            // Se atiende arriba: la carpeta se lee del disco, no del daemon.
            SidebarTab::Projects => return,
            SidebarTab::Branches => json!({ "id": "1", "cmd": "review.branches", "cwd": cwd }),
            SidebarTab::Prs => json!({ "id": "1", "cmd": "review.prs", "cwd": cwd }),
        };
        let wrap: fn(Vec<Value>) -> Fetched = match &tab {
            SidebarTab::Projects => return,
            SidebarTab::Branches => |rows| {
                Fetched::Branches(rows.into_iter().filter_map(|v| v.as_str().map(String::from)).collect())
            },
            SidebarTab::Prs => Fetched::Prs,
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

    pub(super) async fn refresh_files(&mut self) {
        let mut body = json!({
            "id": "1", "cmd": "review.files", "cwd": self.cwd, "base": self.base,
        });
        // Con rama elegida, sus ficheros; sin ella, lo que tengas sin commitear.
        if let Some(branch) = &self.branch {
            body["branch"] = json!(branch);
        }
        self.files = self.fetch_list(body).await;
        self.files_selected = 0;
        // Los diffs abiertos son de la comparación anterior: dejarlos ahí
        // mostraría cambios de otra rama bajo los ficheros de esta.
        self.expanded.clear();
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

}

/// Identifies one review run. Only has to be unique among the runs of a
/// project, which the clock gives with room to spare.
fn new_run_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{nanos}")
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
    use super::visible::PaneRow;
    use crossterm::event::KeyCode;

    fn state_with(branches: &[&str], search: &str) -> ReviewState {
        let mut state = ReviewState::new("/repo".to_string());
        state.branches = branches.iter().map(|b| b.to_string()).collect();
        state.search = search.to_string();
        state
    }

    fn state_with_files(paths: &[&str]) -> ReviewState {
        let mut state = ReviewState::new("/repo".to_string());
        state.files = paths.iter().map(|p| serde_json::json!({"path": p, "status": "M"})).collect();
        state
    }

    #[test]
    fn a_closed_file_is_one_row_and_an_open_one_carries_its_diff_below() {
        // El escritorio despliega el diff bajo la fila del fichero; abrirlo no
        // tapa la lista, que es lo que permite tener dos abiertos y comparar.
        let mut state = state_with_files(&["a.rs", "b.rs"]);
        assert_eq!(state.pane_rows().len(), 2, "cerrados, un fichero es una fila");

        state.expanded.insert("a.rs".to_string(), "@@ -1 +1 @@\n+uno\n dos".to_string());

        let rows = state.pane_rows();
        assert_eq!(rows.len(), 5, "las tres líneas del diff van bajo a.rs");
        assert!(matches!(rows[0], PaneRow::File(_)));
        assert!(matches!(&rows[1], PaneRow::Diff { path, .. } if path == "a.rs"));
        assert!(matches!(rows[4], PaneRow::File(_)), "b.rs sigue debajo, no desaparece");
    }

    #[test]
    fn the_cursor_over_a_diff_line_knows_its_file_and_its_line() {
        // Comentar una línea necesita las dos cosas, y con el diff desplegado
        // bajo su fichero la fila marcada ya no dice por sí sola de cuál es.
        let mut state = state_with_files(&["a.rs"]);
        state.expanded.insert("a.rs".to_string(), "@@ -1,0 +7,1 @@\n+uno".to_string());

        state.files_selected = 2; // la fila del "+uno"

        assert_eq!(state.selected_path().as_deref(), Some("a.rs"));
        assert_eq!(state.selected_diff_line(), Some(7));
    }

    #[test]
    fn the_cursor_over_a_file_row_has_no_line_to_comment() {
        let state = state_with_files(&["a.rs"]);

        assert_eq!(state.selected_path().as_deref(), Some("a.rs"));
        assert_eq!(state.selected_diff_line(), None, "la fila del fichero no es una línea del diff");
    }

    #[tokio::test]
    async fn enter_closes_a_file_that_was_open_instead_of_reloading_it() {
        // Un desplegable se cierra con la misma tecla que lo abre; si Enter
        // volviera a pedir el diff, un fichero abierto no habría forma de
        // cerrarlo.
        let mut state = state_with_files(&["a.rs"]);
        state.focus = Focus::Files;
        state.expanded.insert("a.rs".to_string(), "@@ -1 +1 @@\n+uno".to_string());

        state.handle_event(press(KeyCode::Enter)).await;

        assert!(state.expanded.is_empty(), "Enter sobre un fichero abierto lo cierra");
        assert!(matches!(state.view, ReviewView::Browse), "y no se va a otra pantalla");
    }

    #[tokio::test]
    async fn z_collapses_every_open_diff_and_puts_the_cursor_back_on_a_file() {
        // Con varios diffs abiertos la lista de ficheros se sale de pantalla;
        // el cursor se quedaba sobre una línea de diff que ya no existe.
        let mut state = state_with_files(&["a.rs", "b.rs"]);
        state.focus = Focus::Files;
        state.expanded.insert("a.rs".to_string(), "@@ -1 +1 @@\n+uno".to_string());
        state.files_selected = 2;

        state.handle_event(press(KeyCode::Char('z'))).await;

        assert!(state.expanded.is_empty());
        assert_eq!(state.files_selected, 0, "el cursor vuelve a una fila que existe");
    }

    #[tokio::test]
    async fn c_over_a_diff_line_comments_it_instead_of_opening_the_review_context() {
        // `c` es el contexto de la review en todo el panel; sobre una línea
        // del diff tiene que ser el comentario de esa línea, que es lo que
        // hace el escritorio con su botón en la línea.
        let mut state = state_with_files(&["a.rs"]);
        state.focus = Focus::Files;
        state.current_pr = Some(7);
        state.expanded.insert("a.rs".to_string(), "@@ -1,0 +7,1 @@\n+uno".to_string());
        state.files_selected = 2;

        state.handle_event(press(KeyCode::Char('c'))).await;

        assert!(matches!(state.input_purpose, Some(InputPurpose::InlineComment(7))));
    }

    #[tokio::test]
    async fn page_down_moves_the_list_you_are_looking_at_not_the_report() {
        // La TUI captura el ratón, así que la rueda del terminal no baja
        // nada: RePág/AvPág son la única forma de recorrer un diff largo, y
        // movían el informe estuvieras donde estuvieras.
        let mut state = state_with_files(&["a.rs"]);
        state.focus = Focus::Files;
        let diff = format!("@@ -1,0 +1,40 @@\n{}", (0..40).map(|n| format!("+{n}")).collect::<Vec<_>>().join("\n"));
        state.expanded.insert("a.rs".to_string(), diff);

        state.handle_event(press(KeyCode::PageDown)).await;

        assert_eq!(state.files_selected, 10);
        assert_eq!(state.scroll, 0, "el informe se queda donde estaba");
    }

    #[test]
    fn the_wheel_moves_whatever_is_under_the_pointer() {
        // Con el ratón capturado la rueda la recibe la aplicación: si no la
        // atiende nadie, girarla no hace absolutamente nada.
        let mut state = state_with_files(&["a.rs", "b.rs", "c.rs"]);
        state.drawer_width = 30;

        state.scroll_wheel(80, 20, 100, 3); // sobre el cajón
        assert_eq!(state.scroll, 3, "sobre el informe, la rueda lo desplaza");

        state.scroll_wheel(40, 20, 100, 3); // sobre los archivos
        assert_eq!(state.files_selected, 2);

        state.scroll_wheel(40, 20, 100, -3);
        assert_eq!(state.files_selected, 0, "y hacia arriba vuelve");
    }

    #[test]
    fn the_wheel_over_the_rail_moves_the_branch_list() {
        let mut state = state_with(&["main", "otra", "tercera"], "");
        state.sidebar_tab = SidebarTab::Branches;

        state.scroll_wheel(5, 20, 100, 3);

        assert_eq!(state.branches_selected, 2);
    }

    #[tokio::test]
    async fn two_columns_pair_a_replacement_into_one_row_and_keep_the_cursor_inside() {
        // Partida, una sustitución es una fila en vez de dos: el cursor puede
        // quedarse apuntando a una fila que ya no existe.
        let mut state = state_with_files(&["a.rs"]);
        state.focus = Focus::Files;
        state.expanded.insert("a.rs".to_string(), "@@ -1,1 +1,1 @@\n-antes\n+después".to_string());
        state.files_selected = 3; // la última fila del modo a lo ancho

        state.handle_event(press(KeyCode::Char('2'))).await;

        assert!(state.split);
        assert_eq!(state.pane_rows().len(), 3, "fichero, cabecera y el par");
        assert!(state.files_selected < 3, "el cursor no se queda fuera de la lista");
    }

    #[test]
    fn a_comment_in_two_columns_still_lands_on_the_new_line() {
        // La izquierda es el fichero viejo; GitHub ancla los comentarios a la
        // numeración del nuevo, que es la columna derecha.
        let mut state = state_with_files(&["a.rs"]);
        state.split = true;
        state.expanded.insert("a.rs".to_string(), "@@ -1,1 +7,1 @@\n-antes\n+después".to_string());
        state.files_selected = 2;

        assert_eq!(state.selected_diff_line(), Some(7));
    }

    #[test]
    fn the_filters_say_how_many_files_are_of_each_kind() {
        // El escritorio los tiene siempre a la vista con su recuento; aquí `f`
        // cambiaba de filtro a ciegas, sin decir cuántos ibas a encontrar.
        let mut state = ReviewState::new("/repo".to_string());
        state.files = [("A", "uno.rs"), ("A", "dos.rs"), ("M", "tres.rs"), ("R", "cuatro.rs")]
            .iter()
            .map(|(status, path)| serde_json::json!({"status": status, "path": path}))
            .collect();

        let counts = state.filter_counts();

        assert_eq!(counts[0], (FileFilter::All, 4));
        assert_eq!(counts[1], (FileFilter::Added, 2));
        assert_eq!(counts[2], (FileFilter::Modified, 2), "un renombrado cuenta como modificado");
        assert_eq!(counts[3], (FileFilter::Deleted, 0));
    }

    #[test]
    fn the_counts_follow_the_search_so_they_match_the_list_below() {
        let mut state = ReviewState::new("/repo".to_string());
        state.files = [("A", "uno.rs"), ("A", "dos.rs"), ("M", "tres.rs")]
            .iter()
            .map(|(status, path)| serde_json::json!({"status": status, "path": path}))
            .collect();
        state.file_search = "os".to_string();

        assert_eq!(state.filter_counts()[0], (FileFilter::All, 1), "sólo dos.rs pasa la búsqueda");
        assert_eq!(state.filter_counts()[1], (FileFilter::Added, 1));
    }

    #[test]
    fn the_filter_in_use_is_the_one_highlighted_in_the_bar() {
        // Los cuatro se ven a la vez, así que el texto no dice cuál actúa:
        // sin el resaltado no hay forma de saberlo.
        let mut state = ReviewState::new("/repo".to_string());
        state.file_filter = FileFilter::Modified;

        let bar = super::rows::filter_bar(&state);
        let highlighted: Vec<&str> = bar
            .spans
            .iter()
            .filter(|s| s.style.add_modifier.contains(ratatui::style::Modifier::REVERSED))
            .map(|s| s.content.as_ref())
            .collect();

        assert_eq!(highlighted, vec![" ~0 modificados "]);
    }

    #[test]
    fn a_header_line_says_which_key_it_is_and_that_is_what_a_click_sends() {
        // Cada línea de la cabecera lleva su tecla escrita al final; leerla de
        // ahí evita una segunda tabla de posiciones que se desincronice del
        // dibujo.
        use super::format::key_in;

        assert_eq!(key_in("Agente: claude (g)"), Some(KeyCode::Char('g')));
        assert_eq!(key_in("Filtro: — (F3)"), Some(KeyCode::F(3)));
        assert_eq!(key_in("Ver: b ramas · p PRs · h reviews"), None, "esa línea no es un botón");
        assert_eq!(key_in(""), None);
    }

    #[test]
    fn clicking_a_chip_puts_that_filter_and_clicking_a_row_picks_it() {
        // El escritorio se maneja a ratón: aquí sólo respondían el raíl y el
        // cajón, y los archivos y sus filtros no hacían nada.
        use super::mouse::{file_click, FileClick};
        let state = ReviewState::new("/repo".to_string());
        let area = ratatui::layout::Rect::new(20, 0, 60, 20);
        // "Buscar (F3): todos  ·  " ocupa 23 columnas antes del primer chip.
        let first_chip = area.x + 1 + 23;

        assert_eq!(file_click(&state, first_chip, 1, area), Some(FileClick::Chip(0)));
        assert_eq!(file_click(&state, 1, 1, area), None, "eso es el raíl, no el panel");
        assert_eq!(file_click(&state, 30, 2, area), Some(FileClick::Row(0)), "la lista empieza debajo");
        assert_eq!(file_click(&state, 30, 5, area), Some(FileClick::Row(3)));
        assert_eq!(file_click(&state, 30, 19, area), None, "el borde de abajo no es una fila");
    }

    #[test]
    fn clicking_far_down_a_long_list_picks_the_row_you_see_not_the_one_underneath() {
        // La lista se desplaza sola para no perder de vista la fila marcada,
        // así que la de arriba deja de ser la primera del listado.
        use super::mouse::visible_offset;

        assert_eq!(visible_offset(3, 10), 0, "cabe entera: no se ha desplazado");
        assert_eq!(visible_offset(12, 10), 3, "con la 12 marcada y diez de alto, arriba está la 3");
    }

    fn click(column: u16, row: u16) -> crossterm::event::MouseEvent {
        crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
            column,
            row,
            modifiers: crossterm::event::KeyModifiers::NONE,
        }
    }

    /// Lo que hay escrito en una fila de la pantalla tras pintar el panel.
    fn painted(state: &ReviewState, width: u16, height: u16, row: u16) -> String {
        let backend = ratatui::backend::TestBackend::new(width, height);
        let mut terminal = ratatui::Terminal::new(backend).unwrap();
        terminal.draw(|f| super::draw::draw(f, state, 24, false)).unwrap();
        let buf = terminal.backend().buffer();
        (0..width).map(|c| buf[(c, row)].symbol()).collect()
    }

    #[tokio::test]
    async fn clicking_a_file_row_picks_the_file_that_is_painted_there() {
        // Una geometría que señale a otra fila es peor que no poder pulsar:
        // se marca un fichero distinto del que estás señalando.
        let mut state = state_with_files(&["uno.rs", "dos.rs", "tres.rs", "cuatro.rs"]);
        let area = state.files_area(100, 20, 24);
        let row = 4;
        assert!(painted(&state, 100, 20, row).contains("tres.rs"), "la fila 4 es la de tres.rs");

        state.handle_files_mouse(click(40, row), area).await;

        assert_eq!(state.selected_path().as_deref(), Some("tres.rs"));
        assert!(matches!(state.focus, Focus::Files), "y el panel se queda con el foco");
    }

    #[tokio::test]
    async fn clicking_a_file_opens_its_diff_and_clicking_again_closes_it() {
        // Como el desplegable del escritorio: se pulsa el fichero y se abre.
        let mut state = state_with_files(&["uno.rs"]);
        let area = state.files_area(100, 20, 24);

        state.handle_files_mouse(click(40, 2), area).await;
        assert!(state.is_expanded("uno.rs"));

        state.handle_files_mouse(click(40, 2), area).await;
        assert!(!state.is_expanded("uno.rs"));
    }

    #[tokio::test]
    async fn clicking_a_chip_switches_to_that_filter() {
        let mut state = state_with_files(&["uno.rs"]);
        let area = state.files_area(100, 20, 24);
        let chip = area.x + 1 + super::rows::chip_ranges(&state)[3].0;

        state.handle_files_mouse(click(chip, 1), area).await;

        assert_eq!(state.file_filter, FileFilter::Deleted);
    }

    #[test]
    fn clicking_an_option_in_the_rail_runs_its_key() {
        // La cabecera anuncia la tecla de cada opción; el clic manda esa misma
        // tecla, así que las dos vías no pueden divergir.
        let state = ReviewState::new("/repo".to_string());
        let header = super::draw::sidebar_header(&state, 24);
        let agent_line = header.iter().position(|l| l.to_string().starts_with("Agente:")).unwrap();

        let key = state.header_key_at(click(3, agent_line as u16 + 1), 24);

        assert_eq!(key, Some(KeyCode::Char('g')));
        assert_eq!(
            state.header_key_at(click(23, agent_line as u16 + 1), 24),
            None,
            "esa columna es el divisor: arrastrarlo no cambia de agente",
        );
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

        state.apply_fetched(Fetched::Branches(vec![]));
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
    async fn each_review_gets_its_own_id_so_the_previous_one_survives() {
        // Same id would mean the second review overwrote the first's report
        // and, worse, the verifier session you could still ask.
        let mut state = ReviewState::new("/repo".to_string());

        state.start_run();
        let first = state.run_id.clone();
        state.start_run();

        assert!(first.is_some());
        assert_ne!(first, state.run_id);
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
        // Open it, then fold it — the first toggle on a closed drawer opens it.
        state.open_drawer();
        state.toggle_drawer();
        assert_eq!(state.drawer_width, crate::tui::drawer::COLLAPSED_WIDTH);

        state.start_run();

        assert!(state.drawer_width > crate::tui::drawer::COLLAPSED_WIDTH);
    }

    #[tokio::test]
    async fn a_review_that_failed_says_why_after_it_stops() {
        // The daemon reports failures as progress, and progress was only shown
        // while running — so a run that died left an empty drawer and no
        // reason anywhere.
        let mut state = ReviewState::new("/repo".to_string());
        state.start_run();

        state.handle_stream_event(ReviewEvent::Progress("error: claude no encontrado".into()));
        state.handle_stream_event(ReviewEvent::Done);

        assert!(state.output.contains("claude no encontrado"), "el motivo se queda a la vista:\n{}", state.output);
    }

    #[tokio::test]
    async fn ordinary_progress_does_not_end_up_in_the_report() {
        // Tool lines are noise once the report is written.
        let mut state = ReviewState::new("/repo".to_string());
        state.start_run();

        state.handle_stream_event(ReviewEvent::Progress("Read engine.rs".into()));
        state.handle_stream_event(ReviewEvent::Done);

        assert!(!state.output.contains("Read engine.rs"));
    }

    #[tokio::test]
    async fn the_drawer_does_not_vanish_when_a_review_ends_with_nothing() {
        // Deriving its visibility from "is there output" meant a run that
        // failed before writing anything took the drawer — and the error
        // message inside it — off the screen at the exact moment it mattered.
        let mut state = ReviewState::new("/repo".to_string());
        state.start_run();

        state.handle_stream_event(ReviewEvent::Done);

        assert!(state.drawer_open, "el cajón se queda hasta que lo cierres tú");
    }

    #[tokio::test]
    async fn a_finished_review_keeps_its_report_on_screen() {
        let mut state = ReviewState::new("/repo".to_string());
        state.start_run();
        state.handle_stream_event(ReviewEvent::Content("veredicto".into()));
        state.handle_stream_event(ReviewEvent::Done);

        assert!(state.drawer_open);
        assert!(!state.running);
    }

    #[test]
    fn folding_the_drawer_remembers_how_wide_it_was() {
        let mut state = ReviewState::new("/repo".to_string());
        state.open_drawer();
        state.drawer_width = 90;

        state.toggle_drawer();
        state.toggle_drawer();

        assert_eq!(state.drawer_width, 90, "vuelve a 90, no al ancho por defecto");
    }

    #[tokio::test]
    async fn right_from_the_files_reaches_the_drawer_when_it_is_open() {
        let mut state = ReviewState::new("/repo".to_string());
        state.open_drawer();
        state.focus = Focus::Files;

        state.focus_right();

        assert!(matches!(state.focus, Focus::Drawer));
    }

    #[test]
    fn right_stays_on_the_files_when_the_drawer_is_closed() {
        // Otherwise the keys would land somewhere invisible.
        let mut state = ReviewState::new("/repo".to_string());
        state.focus = Focus::Files;

        state.focus_right();

        assert!(matches!(state.focus, Focus::Files));
    }

    #[test]
    fn left_from_the_drawer_goes_back_to_the_files() {
        let mut state = ReviewState::new("/repo".to_string());
        state.open_drawer();
        state.focus = Focus::Drawer;

        state.focus_left();

        assert!(matches!(state.focus, Focus::Files));
    }

    #[test]
    fn the_arrows_scroll_the_report_while_it_has_the_focus() {
        let mut state = ReviewState::new("/repo".to_string());
        state.open_drawer();
        state.focus = Focus::Drawer;
        state.scroll = 5;

        state.scroll_drawer(3);
        assert_eq!(state.scroll, 8);

        state.scroll_drawer(-10);
        assert_eq!(state.scroll, 0, "no se sube más allá del principio");
    }

    #[test]
    fn the_first_press_on_a_closed_drawer_opens_it() {
        // Otherwise the key would appear to do nothing the first time.
        let mut state = ReviewState::new("/repo".to_string());
        assert!(!state.drawer_open);

        state.toggle_drawer();

        assert!(state.drawer_open);
        assert!(state.drawer_width > crate::tui::drawer::COLLAPSED_WIDTH);
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
        // El diff va con la búsqueda de la derecha, la de ficheros: filtrar
        // ramas en el raíl no debe tocar lo que estás leyendo.
        let mut state = state_with(&[], "");
        state.file_search = "todo".into();
        let diff = "+ hecho\n+ TODO: esto no\n- otra cosa\n";
        assert_eq!(state.filtered(diff), "+ TODO: esto no");
    }

    #[test]
    fn without_a_search_the_diff_is_untouched() {
        let state = state_with(&[], "");
        let diff = "+ a\n- b";
        assert_eq!(state.filtered(diff), diff);
    }

    #[tokio::test]
    async fn a_letter_typed_into_a_box_is_a_letter_and_not_a_shortcut() {
        // El modo tamaño mira las teclas antes que el panel; escribiendo, no
        // debe mirarlas, o "s" nunca se podría teclear.
        let mut state = ReviewState::new("/repo".into());
        state.handle_event(press(KeyCode::Char('c'))).await;
        assert!(state.is_typing(), "la 'c' abre el cuadro de contexto");

        state.handle_event(press(KeyCode::Char('s'))).await;

        assert_eq!(state.input, "s");
    }

    #[tokio::test]
    async fn with_no_box_open_the_keys_are_the_panels() {
        let state = ReviewState::new("/repo".into());

        assert!(!state.is_typing());
    }

    fn press(code: KeyCode) -> crossterm::event::Event {
        crossterm::event::Event::Key(crossterm::event::KeyEvent::new(
            code,
            crossterm::event::KeyModifiers::NONE,
        ))
    }

    #[test]
    fn the_marked_branch_is_the_one_you_see_not_the_one_underneath() {
        // Con filtro, la fila 0 de lo que ves es otra rama de la lista entera:
        // pulsabas Enter sobre una y se revisaba otra.
        let mut state = state_with(&["main", "feat/uno", "feat/dos"], "dos");
        state.branches_selected = 0;

        assert_eq!(state.selected_branch().as_deref(), Some("feat/dos"));
    }

    #[test]
    fn with_nothing_matching_there_is_no_branch_to_mark() {
        let state = state_with(&["main"], "no-existe");

        assert_eq!(state.selected_branch(), None);
    }
}
