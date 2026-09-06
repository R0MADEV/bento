//! Review tab: a persistent split-pane browser (sidebar: base/agent/compare
//! controls + proyectos/ramas/PRs tabs; main: changed files with
//! per-file "reviewed" tracking) mirroring the desktop app's Tech Review
//! panel, plus full-screen drill-downs for a file's diff, a PR's
//! diff/comments, and a running/loaded review — all via the same
//! `review.*`/`projects.*` IPC commands the one-shot `bento review`

mod draw;
mod drawer_state;
mod format;
mod input;
mod mouse;
pub(in crate::tui) use mouse::ReviewMouse;
mod pr_actions;
mod rows;
mod syntax;
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

#[derive(Clone, Copy, PartialEq)]
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
    /// Contestando a un comentario ya puesto, por su id.
    CommentReply(u64),
    /// Corrigiendo uno tuyo, por su id.
    CommentEdit(u64),
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
    /// Lo que un PR trae además del diff. Son tres llamadas a `gh` —a la red—
    /// y se pedían en serie esperando en el bucle: seis segundos con el panel
    /// congelado antes de ver un solo fichero.
    PrDetail {
        pr: u64,
        checks: String,
        inline: String,
        comments: String,
        raw: Vec<Value>,
        resolved: Vec<u64>,
    },
    /// The daemon said no. Shown in the header rather than rendered as an
    /// empty list, which is indistinguishable from "there is nothing".
    Failed(String),
}

/// Lo que se guardó y con qué se hizo: si cambia la seña, hay que rehacerlo.
#[derive(Default)]
struct ParsedDiffs {
    mark: String,
    rows: std::collections::HashMap<String, Vec<format::DiffRow>>,
    /// Cuántas filas salen en total, contadas una vez.
    len: Option<usize>,
    /// Cuántas veces se ha partido un diff, para que las pruebas puedan ver si
    /// se está reaprovechando lo guardado.
    parses: usize,
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

    focus: Focus,
    sidebar_tab: SidebarTab,

    files: Vec<Value>,
    /// La fila marcada del panel, contando los ficheros y las líneas de los
    /// diffs desplegados: se navega por una sola lista, como en el escritorio.
    files_selected: usize,
    /// Los diffs ya partidos en filas, por fichero. Partirlos es lo caro y el
    /// dibujo los pide en cada frame, así que se guardan hasta que cambie lo
    /// que se ve: qué está desplegado, la búsqueda o las dos columnas.
    parsed: std::cell::RefCell<ParsedDiffs>,
    /// Por dónde empieza lo que se ve, tal y como quedó en el último dibujo.
    /// Lo apunta el dibujo —que es quien sabe cuántas filas hay y cuántas
    /// caben— y lo lee el ratón para traducir una fila de la pantalla.
    files_offset: std::cell::Cell<usize>,
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
    /// Lo que va en la franja de debajo de los archivos: de qué PR es y cómo
    /// va su CI. En el escritorio es la barra con el título y el `× CI`.
    pr_summary: String,
    /// Los comentarios de línea del PR abierto, como los devuelve GitHub. Se
    /// leen bajo la línea de la que hablan, no en una lista aparte.
    inline_comments: Vec<Value>,
    /// Los que das por resueltos. Marca tuya, no de GitHub, guardada donde las
    /// de "revisado" para que la vean también el escritorio y el móvil.
    resolved_comments: std::collections::HashSet<u64>,
    /// La fila donde empezó un arrastre por el diff: con ella y la marcada
    /// sale el rango que se comenta, como al arrastrar en GitHub.
    drag_anchor: Option<usize>,
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
            focus: Focus::Files,
            sidebar_tab: SidebarTab::Branches,
            files: Vec::new(),
            files_selected: 0,
            parsed: std::cell::RefCell::new(ParsedDiffs::default()),
            files_offset: std::cell::Cell::new(0),
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
            pr_summary: String::new(),
            inline_comments: Vec::new(),
            resolved_comments: std::collections::HashSet::new(),
            drag_anchor: None,
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
                self.status.clear();
            }
            Fetched::Branches(branches) => { self.branches = branches; self.branches_selected = 0; self.status.clear() }
            Fetched::Prs(prs) => { self.prs = prs; self.prs_selected = 0; self.status.clear() }
            Fetched::Checkpoints(checkpoints) => {
                self.checkpoints = checkpoints;
                self.checkpoints_selected = 0;
                self.status.clear()
            }
            Fetched::PrDetail { pr, checks, inline, comments, raw, resolved } => {
                self.resolved_comments = resolved.into_iter().collect();
                let header = self.pr_header(pr);
                self.pr_detail = format!("{header}{checks}{inline}\n## Comentarios\n\n{comments}");
                self.pr_summary = self.pr_strip(pr, &checks);
                self.inline_comments = raw;
                self.current_pr = Some(pr);
                self.scroll = 0;
                self.pr_status.clear();
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
        // Lo que se ve es siempre de la petición en curso: si esta falla, la
        // lista anterior se quedaba en pantalla bajo el nombre del proyecto
        // nuevo — el raíl decía "PRs (1)" de un repo y enseñaba el de otro.
        self.apply_fetched(wrap(Vec::new()));
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

    /// Asks for the changed files off the loop. Two requests, one result:
    /// the list and the per-file "reviewed" marks are always shown together,
    /// so applying them separately would flash a list with no marks.
    pub(super) fn request_files(&mut self) {
        self.begin_request();
        let (tx, cwd, base) = (self.work_tx.clone(), self.cwd.clone(), self.base.clone());
        // Los diffs abiertos son de la comparación anterior: dejarlos ahí
        // mostraría cambios de otra rama bajo los ficheros de esta.
        self.expanded.clear();
        let mut body = json!({ "id": "1", "cmd": "review.files", "cwd": cwd, "base": base });
        // Con rama elegida, sus ficheros; sin ella, lo que tengas sin commitear.
        if let Some(branch) = &self.branch {
            body["branch"] = json!(branch);
        }
        tokio::spawn(async move {
            let files = crate::request_data(body);
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
        assert!(state.expanded.is_empty(), "y no se va a otra pantalla: sigue siendo la lista");
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
    fn the_wheel_carries_the_marked_row_with_it() {
        // Desplazarse mueve la línea marcada: es la que se comenta y la que
        // dice por dónde vas, así que quedarse quieta arriba mientras el
        // texto pasa por debajo no sirve de nada.
        let mut state = state_with_files(&["a.rs", "b.rs", "c.rs", "d.rs"]);

        state.scroll_wheel(40, 20, 100, 2);

        assert_eq!(state.files_selected, 2);
    }

    #[test]
    fn the_marked_row_does_not_run_past_the_last_one() {
        let mut state = state_with_files(&["a.rs", "b.rs"]);

        for _ in 0..50 {
            state.scroll_wheel(40, 20, 100, 1);
        }

        assert_eq!(state.files_selected, 1, "no se va más allá de lo que hay");
    }

    #[test]
    fn scrolling_keeps_the_marked_row_in_the_middle() {
        // Y la vista la sigue: lo que importa al leer un diff es lo que hay
        // alrededor de la línea en la que estás.
        let names: Vec<String> = (0..60).map(|n| format!("f{n}.rs")).collect();
        let paths: Vec<&str> = names.iter().map(String::as_str).collect();
        let state = state_with_files(&paths);

        // Alto veinte, marcada la treinta: arriba queda la veinte.
        assert_eq!(state.scroll_offset(30, 20, 60), 20);
    }

    #[test]
    fn the_wheel_over_the_drawer_still_moves_the_report() {
        let mut state = state_with_files(&["a.rs"]);
        state.drawer_width = 30;
        state.drawer_open = true;

        state.scroll_wheel(80, 20, 100, 1);

        assert_eq!(state.scroll, 1);
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

    #[tokio::test]
    async fn clicking_far_down_a_long_list_picks_the_row_you_see_not_the_one_underneath() {
        // Con la lista desplazada, la fila de arriba no es la primera del
        // listado: el clic tiene que contar desde la que se ve.
        let names: Vec<String> = (0..40).map(|n| format!("f{n}.rs")).collect();
        let paths: Vec<&str> = names.iter().map(String::as_str).collect();
        let mut state = state_with_files(&paths);
        state.files_selected = 25;
        let area = state.files_area(100, 20, 24);
        let painted = super::draw::tests::screen(&state, 100, 20);
        let shown = painted.lines().nth(4).expect("la fila").to_string();

        state.handle_files_mouse(click(40, 4), area).await;

        let picked = state.selected_path().unwrap_or_default();
        assert!(shown.contains(&picked), "se marcó {picked} y ahí pone:\n{shown}");
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
    fn the_tabs_are_a_row_of_tabs_with_the_open_one_marked() {
        // El escritorio las tiene como pestañas y aquí eran una línea de
        // ayuda: "Ver: b ramas · p PRs" no dice cuál estás mirando.
        let mut state = ReviewState::new("/repo".to_string());
        state.sidebar_tab = SidebarTab::Prs;
        state.showing_history = true; // el cajón abierto no cambia la pestaña

        let line = super::rows::tabs_line(&state);
        let marked: Vec<&str> = line
            .spans
            .iter()
            .filter(|s| s.style.add_modifier.contains(ratatui::style::Modifier::REVERSED))
            .map(|s| s.content.as_ref())
            .collect();

        assert_eq!(marked, vec![" PRs "]);
    }

    #[test]
    fn clicking_a_tab_opens_that_tab() {
        // Cada pestaña es su propia zona: la línea entera no puede mandar una
        // sola tecla como el resto de las opciones.
        let state = ReviewState::new("/repo".to_string());
        let row = super::draw::TABS_ROW as u16 + 1;
        // La columna 0 es el borde del marco: la cabecera empieza en la 1.
        let ranges = super::rows::tab_ranges();
        let prs = ranges.iter().find(|(_, _, key)| *key == 'p').unwrap().0 + 1;
        let first = ranges[0];

        assert_eq!(state.header_key_at(click(prs, row), 24), Some(KeyCode::Char('p')));
        assert_eq!(state.header_key_at(click(1, row), 24), Some(KeyCode::Char(first.2)));
        assert_eq!(state.header_key_at(click(0, row), 24), None, "el borde no es una pestaña");
    }

    #[test]
    fn the_tabs_row_is_where_the_click_expects_it() {
        // La constante y el dibujo tienen que decir lo mismo: si se añade una
        // opción encima, el clic señalaría a otra línea.
        let state = ReviewState::new("/repo".to_string());
        let header = super::draw::sidebar_header(&state, 24);

        assert!(header[super::draw::TABS_ROW].to_string().contains("Ramas"));
    }

    #[test]
    fn a_long_error_is_wrapped_instead_of_cut_off_at_the_rail_edge() {
        // Un error de gh no cabe en veinticuatro columnas: cortado, lo único
        // que se lee es el principio, que es la parte que menos dice.
        let mut state = ReviewState::new("/repo".to_string());
        state.status = "GitHub no encuentra irontec-comms/deitu: si el remoto no es de GitHub, aquí no hay PRs".into();

        let header = super::draw::sidebar_header(&state, 24);
        // Las del error: las que son un trozo del mensaje.
        let lines: Vec<String> = header
            .iter()
            .map(|l| l.to_string())
            .filter(|l| !l.is_empty() && state.status.contains(l.as_str()))
            .collect();

        assert!(lines.iter().any(|l| l.contains("irontec-comms/deitu")), "el nombre del repo se lee");
        assert!(lines.iter().any(|l| l.contains("no hay PRs")), "y el final también");
        assert!(lines.iter().all(|l| l.chars().count() <= 24), "ninguna se sale del raíl");
    }

    #[tokio::test]
    async fn asking_for_another_project_empties_the_list_before_it_answers() {
        // Si la petición falla, la lista se quedaba con la del proyecto
        // anterior: el raíl decía "PRs (1)" de un repositorio y enseñaba el
        // PR de otro.
        let mut state = ReviewState::new("/repo".to_string());
        state.prs = vec![serde_json::json!({"number": 10, "title": "de otro proyecto"})];

        state.request_sidebar_tab(SidebarTab::Prs);

        assert!(state.prs.is_empty(), "lo que se ve es siempre de la petición en curso");

        state.apply_fetched(Fetched::Failed("gh no encuentra el repo".into()));

        assert!(state.prs.is_empty(), "y un error no resucita la anterior");
        assert!(state.status.contains("gh no encuentra"));
    }

    #[test]
    fn a_pr_is_read_in_the_file_list_not_in_a_screen_of_its_own() {
        // El escritorio no abre otra pantalla: pone la review en la rama del
        // PR y lo lees en la misma lista de archivos, con su diff desplegable
        // y sus dos columnas. Un volcado del diff en crudo no es eso.
        let mut state = ReviewState::new("/repo".to_string());
        state.pr_detail = "# #291 rebranding\n\n## Checks\n- ✗ jenkins (ERROR)".into();
        state.current_pr = Some(291);

        assert_eq!(state.drawer_body(), state.pr_detail, "el PR va al cajón, donde va el informe");
        assert!(state.drawer_title().contains("291"), "y el cajón dice de qué PR es");
    }

    #[test]
    fn running_a_review_takes_the_drawer_back() {
        // El cajón es uno: mientras corre una review enseña la review, que es
        // lo que estás esperando ver.
        let mut state = ReviewState::new("/repo".to_string());
        state.pr_detail = "lo del PR".into();
        state.output = "lo de la review".into();
        state.running = true;

        assert_eq!(state.drawer_body(), "lo de la review");
    }

    #[test]
    fn the_open_pr_is_a_strip_under_the_files_not_a_panel_of_its_own() {
        // En el escritorio el PR va debajo de la lista —título, estado de CI y
        // los botones—, no en una columna aparte que tape los archivos.
        let mut state = state_with_files(&["a.rs"]);
        state.current_pr = Some(291);
        state.pr_summary = "PR #291: rebranding deitu · ✗ CI (2 fallan)".into();

        let text = super::draw::tests::screen(&state, 100, 20);

        assert!(text.contains("PR #291"), "{text}");
        assert!(text.contains("✗ CI"), "y cómo va la CI: {text}");
        assert!(!state.drawer_open, "elegir un PR no abre el cajón encima de nada");

        // Y al comentar sigue viéndose: el cuadro se pintaba encima y tapaba
        // justo la franja del PR sobre el que estabas escribiendo.
        state.input_purpose = Some(InputPurpose::PrComment);
        let text = super::draw::tests::screen(&state, 100, 20);

        assert!(text.contains("PR #291"), "el cuadro no la tapa: {text}");
        assert!(text.contains("Comentario en el PR"), "{text}");
    }

    #[test]
    fn a_pr_whose_branch_you_do_not_have_says_to_fetch() {
        // Un PR abierto después de tu último fetch no tiene rama que comparar:
        // la lista sale vacía y parece que el PR no cambia nada.
        let mut state = ReviewState::new("/repo".to_string());
        state.branches = vec!["main".into(), "origin/main".into()];
        state.prs = vec![serde_json::json!({"number": 9, "title": "recién abierto"})];

        state.branch = Some(state.pr_branch("DEITU-9999-recien-abierta"));

        assert_eq!(state.branch.as_deref(), Some("origin/DEITU-9999-recien-abierta"));
        let strip = state.pr_strip_for_test(9, "");
        assert!(strip.contains("git fetch"), "avisa de qué hacer: {strip}");
    }

    #[test]
    fn the_comment_box_of_an_open_pr_is_there_before_you_press_anything() {
        // En el escritorio la caja y sus botones están puestos desde que
        // abres el PR. Aquí sólo aparecían al pulsar `a`, así que no había
        // forma de saber que se podía comentar.
        let mut state = state_with_files(&["a.rs"]);
        state.current_pr = Some(291);
        state.pr_summary = "PR #291: rebranding · ✗ CI (2 fallan)".into();

        let text = super::draw::tests::screen(&state, 100, 20);

        assert!(text.contains("Deja un comentario"), "{text}");
        assert!(text.contains("Aprobar (y)"), "y los botones que lo mandan: {text}");
    }

    #[test]
    fn the_pr_has_the_same_three_buttons_as_the_desktop() {
        // Enviar comentario, Aprobar y Pedir cambios: en el escritorio son
        // botones bajo la caja, no una lista de teclas en un título.
        let state = ReviewState::new("/repo".to_string());

        let labels: Vec<String> = super::rows::pr_buttons()
            .into_iter()
            .map(|(label, key, _)| format!("{label} ({key})"))
            .collect();

        assert_eq!(labels, vec!["Enviar comentario (a)", "Aprobar (y)", "Pedir cambios (n)"]);
        assert_eq!(super::rows::pr_buttons().len(), super::rows::button_ranges().len());
        let _ = state;
    }

    #[test]
    fn clicking_a_button_does_what_its_key_does() {
        // Los botones se miden como se pintan, igual que los chips: si no, un
        // clic manda la acción del de al lado, y una es aprobar un PR.
        let mut state = state_with_files(&["a.rs"]);
        state.current_pr = Some(291);
        let ranges = super::rows::button_ranges();
        let approve = ranges[1].0;

        let key = state.button_key_at(click(approve, 19), 100, 20);

        assert_eq!(key, Some('y'), "el segundo botón es Aprobar");
        assert_eq!(state.button_key_at(click(approve, 5), 100, 20), None, "arriba no hay botones");
    }

    #[test]
    fn the_line_comment_box_opens_under_its_line() {
        // En el escritorio la caja sale bajo la línea que estás comentando.
        // Abajo del todo no se ve sobre cuál escribes, que es justo lo que
        // hay que tener delante al escribirlo.
        let mut state = state_with_files(&["a.rs"]);
        state.current_pr = Some(291);
        state.expanded.insert("a.rs".into(), "@@ -1,0 +43,1 @@\n+  const x = 1;".into());
        state.files_selected = 2;
        state.input_purpose = Some(InputPurpose::InlineComment(43));
        state.input = "esto sobra".into();

        let text = super::draw::tests::screen(&state, 90, 16);
        let lines: Vec<&str> = text.lines().collect();
        let line_row = lines.iter().position(|l| l.contains("const x = 1;")).expect("la línea");

        assert!(lines[line_row + 1].contains("línea 43"), "{text}");
        assert!(!text.contains("Comentario en la línea (Enter"), "y no por duplicado abajo: {text}");
        assert!(lines[line_row + 2].contains("esto sobra"), "y lo que llevas escrito: {text}");
    }

    #[test]
    fn a_commentable_line_says_so_while_you_are_on_it() {
        // El escritorio saca un `+` al pasar por encima. Sin nada, no hay
        // forma de saber que esa línea admite comentario.
        let mut state = state_with_files(&["a.rs"]);
        state.current_pr = Some(291);
        state.expanded.insert("a.rs".into(), "@@ -1,0 +43,1 @@\n+  const x = 1;".into());
        state.files_selected = 2;

        let text = super::draw::tests::screen(&state, 90, 16);
        let marked = text.lines().find(|l| l.contains("const x = 1;")).expect("la línea");

        assert!(marked.contains('+'), "el signo de comentar: {marked}");
    }

    fn drag(column: u16, row: u16) -> crossterm::event::MouseEvent {
        crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::Drag(crossterm::event::MouseButton::Left),
            column,
            row,
            modifiers: crossterm::event::KeyModifiers::NONE,
        }
    }

    fn state_with_diff() -> ReviewState {
        let mut state = state_with_files(&["a.rs"]);
        state.current_pr = Some(291);
        state.expanded.insert(
            "a.rs".into(),
            "@@ -1,0 +43,3 @@\n+  uno\n+  dos\n+  tres".into(),
        );
        state
    }

    #[tokio::test]
    async fn dragging_over_the_diff_selects_a_range_of_lines() {
        // Como en GitHub: arrastras por las líneas que quieres y comentas
        // sobre todas. Una sola línea no siempre es lo que hay que señalar.
        let mut state = state_with_diff();
        let area = state.files_area(100, 20, 24);

        state.handle_files_mouse(click(40, 4), area).await; // la línea 43
        state.handle_files_mouse(drag(40, 6), area).await; // hasta la 45

        assert_eq!(state.comment_range(), Some((43, 45)));
    }

    #[tokio::test]
    async fn dragging_upwards_still_gives_the_range_in_order() {
        // GitHub quiere start_line < line: al revés lo rechaza.
        let mut state = state_with_diff();
        let area = state.files_area(100, 20, 24);

        state.handle_files_mouse(click(40, 6), area).await;
        state.handle_files_mouse(drag(40, 4), area).await;

        assert_eq!(state.comment_range(), Some((43, 45)));
    }

    #[tokio::test]
    async fn a_click_on_a_single_line_is_not_a_range() {
        let mut state = state_with_diff();
        let area = state.files_area(100, 20, 24);

        state.handle_files_mouse(click(40, 4), area).await;

        assert_eq!(state.comment_range(), None, "una sola línea se comenta como siempre");
        assert_eq!(state.selected_diff_line(), Some(43));
    }

    #[tokio::test]
    async fn the_selected_block_is_marked_down_the_margin() {
        // Sin verlo, no se sabe hasta dónde llega lo que vas a comentar.
        let mut state = state_with_diff();
        let area = state.files_area(100, 20, 24);
        state.handle_files_mouse(click(40, 4), area).await;
        state.handle_files_mouse(drag(40, 6), area).await;

        let text = super::draw::tests::screen(&state, 90, 16);
        let marked = text.lines().filter(|l| l.contains('┃')).count();

        assert_eq!(marked, 3, "las tres líneas del bloque: {text}");
    }

    fn release(column: u16, row: u16) -> crossterm::event::MouseEvent {
        crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::Up(crossterm::event::MouseButton::Left),
            column,
            row,
            modifiers: crossterm::event::KeyModifiers::NONE,
        }
    }

    #[tokio::test]
    async fn letting_go_of_a_selection_opens_the_comment() {
        // En GitHub sueltas y la caja se abre: seleccionar y luego buscar qué
        // tecla la abre no es seleccionar para comentar.
        let mut state = state_with_diff();
        let area = state.files_area(100, 20, 24);
        state.handle_files_mouse(click(40, 4), area).await;
        state.handle_files_mouse(drag(40, 6), area).await;

        state.handle_files_mouse(release(40, 6), area).await;

        assert!(matches!(state.input_purpose, Some(InputPurpose::InlineComment(45))));
    }

    #[tokio::test]
    async fn clicking_the_plus_comments_that_single_line() {
        // El `+` del margen es el botón de GitHub: pulsarlo abre la caja de
        // esa línea sin tener que arrastrar nada.
        let mut state = state_with_diff();
        let area = state.files_area(100, 20, 24);

        state.handle_files_mouse(click(area.x + 1, 4), area).await;

        assert!(matches!(state.input_purpose, Some(InputPurpose::InlineComment(43))), "un solo clic");
    }

    #[tokio::test]
    async fn letting_go_without_having_selected_anything_opens_nothing() {
        // Un clic suelto en el diff es moverse, no comentar.
        let mut state = state_with_diff();
        let area = state.files_area(100, 20, 24);
        state.handle_files_mouse(click(40, 4), area).await;

        state.handle_files_mouse(release(40, 4), area).await;

        assert!(state.input_purpose.is_none());
    }

    #[tokio::test]
    async fn selecting_with_the_mouse_works_through_the_real_event_path() {
        // Los tests llamaban al panel a mano; la aplicación entra por
        // ReviewMouse, que antes mira la rueda, el cajón y el raíl. Si alguno
        // se come el evento, arrastrar no selecciona nada.
        let mut state = state_with_diff();
        let mut width = 24u16;
        let mut restored = 24u16;
        let mut rail_drag = false;
        let mut drawer_drag = false;

        macro_rules! send {
            ($event:expr) => {
                super::ReviewMouse {
                    width: &mut width,
                    restored: &mut restored,
                    dragging_rail: &mut rail_drag,
                    dragging_drawer: &mut drawer_drag,
                    total: 100,
                    height: 20,
                }
                .handle(&mut state, $event)
                .await
            };
        }

        send!(click(40, 4));
        send!(drag(40, 6));
        assert_eq!(state.comment_range(), Some((43, 45)), "el arrastre selecciona");

        send!(release(40, 6));
        assert!(matches!(state.input_purpose, Some(InputPurpose::InlineComment(45))), "y soltar comenta");
    }

    #[test]
    fn a_closed_drawer_does_not_take_the_wheel_that_belongs_to_the_files() {
        // El cajón cerrado no está en pantalla: la rueda sobre la derecha del
        // panel es de la lista de archivos.
        let mut state = state_with_files(&["a.rs", "b.rs", "c.rs", "d.rs"]);
        state.drawer_width = 30;
        state.drawer_open = false;

        state.scroll_wheel(90, 20, 100, 3);

        assert_eq!(state.scroll, 0, "el informe no se mueve");
        assert_eq!(state.files_selected, 3, "la lista sí");
    }

    #[tokio::test]
    async fn the_plus_and_the_buttons_also_work_through_the_real_event_path() {
        // Lo mismo que la selección: probados a mano funcionaban, y por la
        // ruta de la aplicación se los comía el cajón cerrado.
        let mut state = state_with_diff();
        let mut width = 24u16;
        let mut restored = 24u16;
        let mut rail_drag = false;
        let mut drawer_drag = false;
        macro_rules! send {
            ($event:expr) => {
                super::ReviewMouse {
                    width: &mut width,
                    restored: &mut restored,
                    dragging_rail: &mut rail_drag,
                    dragging_drawer: &mut drawer_drag,
                    total: 100,
                    height: 20,
                }
                .handle(&mut state, $event)
                .await
            };
        }

        send!(click(25, 4)); // el `+` de la línea 43
        assert!(matches!(state.input_purpose, Some(InputPurpose::InlineComment(43))), "el +");

        state.input_purpose = None;
        let approve = super::rows::button_ranges()[1].0;
        send!(click(approve, 19)); // el botón Aprobar, en la última fila

        assert!(matches!(state.input_purpose, Some(InputPurpose::PrReview("APPROVE"))), "el botón");
    }

    #[test]
    fn painting_a_frame_does_not_reparse_the_diffs_once_per_line() {
        // Cada fila preguntaba por el rango seleccionado, y cada pregunta
        // reconstruía todas las filas: con cinco diffs abiertos, un frame
        // tardaba seiscientos milisegundos y arrastrar era imposible.
        let mut state = ReviewState::new("/repo".to_string());
        state.files = (0..66)
            .map(|n| serde_json::json!({"status": "M", "path": format!("src/file{n}.tsx"), "added": 3, "deleted": 1}))
            .collect();
        state.current_pr = Some(291);
        // Líneas como las de un diff de verdad, no `const x = 1;`: el coste de
        // resaltar depende de lo que haya en la línea.
        let sample = [
            "+pub async fn git_current_branch(path: String) -> Result<String, String> {",
            "+    tauri::async_runtime::spawn_blocking(move || current_branch(&path))",
            "+        .map_err(|e| format!(\"no se pudo: {e}\"))? // y aquí un comentario",
            "-    let previous: HashMap<String, Vec<u64>> = HashMap::new();",
            " impl<'a> Iterator for Rows<'a> where T: Clone + Send + 'static {",
        ];
        let diff: String = std::iter::once("@@ -1,400 +1,400 @@".to_string())
            .chain((0..400).map(|n| sample[n % sample.len()].to_string()))
            .collect::<Vec<_>>()
            .join("\n");
        for n in 0..5 {
            state.expanded.insert(format!("src/file{n}.tsx"), diff.clone());
        }
        state.files_selected = 40;
        state.drag_anchor = Some(10);

        let start = std::time::Instant::now();
        for _ in 0..10 {
            let _ = super::draw::tests::screen(&state, 120, 40);
        }

        // Holgado a propósito: lo que se vigila es el orden de magnitud, no
        // los milisegundos de una máquina concreta.
        let spent = start.elapsed();
        println!("diez frames: {spent:?}");
        assert!(spent.as_millis() < 1000, "diez frames tardaron {spent:?}");
    }

    #[tokio::test]
    async fn choosing_a_branch_asks_for_its_files_without_blocking_the_panel() {
        // Se pedían la lista y las marcas una detrás de otra y esperando en el
        // bucle de eventos: hasta que contestaba el daemon, el panel no
        // repintaba ni respondía a una tecla.
        let mut state = ReviewState::new("/repo".to_string());
        state.branch = Some("origin/una-rama".into());
        state.expanded.insert("a.rs".into(), "@@ -1 +1 @@\n+uno".into());

        state.request_files();

        assert!(state.loading, "la petición queda en marcha, no esperada");
        assert!(state.expanded.is_empty(), "y los diffs de la comparación anterior se cierran");
    }

    fn comment(id: u64, path: &str, line: u64, who: &str, body: &str) -> Value {
        serde_json::json!({
            "id": id, "path": path, "line": line, "body": body,
            "user": {"login": who},
        })
    }

    #[test]
    fn a_comment_is_read_under_the_line_it_is_about() {
        // Se listaban como texto suelto en el cajón, sin ver a qué línea van:
        // revisar un PR ajeno es leer lo que ya han dicho sobre cada sitio.
        let mut state = state_with_diff();
        state.inline_comments = vec![comment(1, "a.rs", 44, "R0MANDEV", "esto sobra")];

        let text = super::draw::tests::screen(&state, 100, 20);
        let lines: Vec<&str> = text.lines().collect();
        let at = lines.iter().position(|l| l.contains("+  dos")).expect("la línea 44");

        assert!(lines[at + 1].contains("R0MANDEV"), "{text}");
        assert!(lines[at + 1].contains("esto sobra"), "{text}");
    }

    #[test]
    fn a_comment_of_another_file_does_not_leak_into_this_one() {
        let mut state = state_with_diff();
        state.inline_comments = vec![comment(1, "otro.rs", 44, "R0MANDEV", "de otro fichero")];

        let text = super::draw::tests::screen(&state, 100, 20);

        assert!(!text.contains("de otro fichero"), "{text}");
    }

    #[test]
    fn the_marked_comment_is_the_one_that_gets_answered() {
        // Con varios en la misma línea, hay que saber a cuál contestas.
        let mut state = state_with_diff();
        state.inline_comments = vec![
            comment(7, "a.rs", 43, "uno", "primero"),
            comment(9, "a.rs", 43, "dos", "segundo"),
        ];
        // Fila 2 la línea 43, y sus comentarios debajo en orden.
        state.files_selected = 3;
        assert_eq!(state.selected_comment(), Some(7));

        state.files_selected = 4;
        assert_eq!(state.selected_comment(), Some(9));
    }

    #[tokio::test]
    async fn enter_on_a_comment_answers_it_instead_of_folding_the_file() {
        // Enter despliega ficheros; sobre un comentario tiene que contestarlo,
        // que es lo que se hace con un comentario ajeno.
        let mut state = state_with_diff();
        state.focus = Focus::Files;
        state.inline_comments = vec![comment(7, "a.rs", 43, "R0MANDEV", "esto sobra")];
        state.files_selected = 3;

        state.handle_event(press(KeyCode::Enter)).await;

        assert!(matches!(state.input_purpose, Some(InputPurpose::CommentReply(7))));
        let text = super::draw::tests::screen(&state, 100, 20);
        assert!(text.contains("Responder al comentario"), "y su cuadro lo dice: {text}");
    }

    #[tokio::test]
    async fn opening_a_pr_does_not_wait_for_github_before_painting() {
        // Lo del PR son tres llamadas a la red; en serie y esperadas en el
        // bucle eran seis segundos sin repintar ni responder, y sin ver los
        // ficheros que ya habían llegado.
        let mut state = ReviewState::new("/repo".to_string());
        state.prs = vec![serde_json::json!({"number": 291, "title": "rebranding"})];

        state.request_pr_detail(291);

        assert!(state.loading, "queda pedido, no esperado");
        assert!(state.pr_detail.is_empty(), "y el panel no se bloquea a la espera");
    }

    #[tokio::test]
    async fn space_gives_a_comment_as_resolved_and_takes_it_back() {
        // El mismo gesto que marca un fichero como revisado: sobre un
        // comentario es darlo por resuelto.
        let mut state = state_with_diff();
        state.focus = Focus::Files;
        state.inline_comments = vec![comment(7, "a.rs", 43, "R0MANDEV", "esto sobra")];
        state.files_selected = 3;

        state.handle_event(press(KeyCode::Char(' '))).await;
        assert!(state.resolved_comments.contains(&7));

        state.handle_event(press(KeyCode::Char(' '))).await;
        assert!(!state.resolved_comments.contains(&7), "y se puede reabrir");
    }

    #[test]
    fn a_resolved_comment_is_painted_as_settled() {
        let mut state = state_with_diff();
        state.inline_comments = vec![comment(7, "a.rs", 43, "R0MANDEV", "esto sobra")];
        state.resolved_comments.insert(7);

        let text = super::draw::tests::screen(&state, 100, 20);

        assert!(text.contains("✓ R0MANDEV"), "{text}");
    }

    #[tokio::test]
    async fn e_edits_the_marked_comment_starting_from_what_it_says() {
        // El escritorio tiene Editar junto a Responder. Empezar de cero para
        // corregir una palabra no es editar.
        let mut state = state_with_diff();
        state.focus = Focus::Files;
        state.inline_comments = vec![comment(7, "a.rs", 43, "R0MADEV", "jelllo")];
        state.files_selected = 3;

        state.handle_event(press(KeyCode::Char('e'))).await;

        assert!(matches!(state.input_purpose, Some(InputPurpose::CommentEdit(7))));
        assert_eq!(state.input, "jelllo", "con lo que decía, para corregirlo");
    }

    #[test]
    fn a_comment_says_when_it_was_written() {
        // Un comentario de hace un mes no pesa lo mismo que el de esta
        // mañana, y en el escritorio la fecha va junto al nombre.
        let mut state = state_with_diff();
        let mut c = comment(7, "a.rs", 43, "R0MADEV", "jelllo");
        c["created_at"] = serde_json::json!("2026-08-02T10:15:00Z");
        state.inline_comments = vec![c];

        let text = super::draw::tests::screen(&state, 100, 20);

        assert!(text.contains("02/08 10:15"), "{text}");
    }

    #[test]
    fn over_a_comment_the_footer_offers_its_actions() {
        // En el escritorio son botones al lado del comentario; aquí, las
        // teclas que valen sobre él.
        let mut state = state_with_diff();
        state.inline_comments = vec![comment(7, "a.rs", 43, "R0MADEV", "jelllo")];
        state.files_selected = 3;

        let text = super::draw::tests::screen(&state, 120, 20);

        assert!(text.contains("Enter responder"), "{text}");
        assert!(text.contains("e editar"), "{text}");
        assert!(text.contains("d borrar"), "{text}");
    }

    #[test]
    fn what_happened_to_a_comment_is_said_where_the_pr_is() {
        // El resultado de responder, editar o borrar se guardaba y no se
        // pintaba en ninguna parte: enviar y no ver nada es no saber si ha
        // salido, y así un 404 pasó semanas sin que nadie lo notara.
        let mut state = state_with_files(&["a.rs"]);
        state.current_pr = Some(291);
        state.pr_summary = "PR #291: rebranding · ✗ CI".into();
        state.pr_status = "no se pudo responder: gh: Not Found (HTTP 404)".into();

        let text = super::draw::tests::screen(&state, 110, 20);

        assert!(text.contains("no se pudo responder"), "{text}");
    }

    #[test]
    fn the_code_in_a_diff_is_coloured_by_what_it_says() {
        // El verde y el rojo dicen qué pasó con la línea; el resaltado, qué
        // dice. En el escritorio se lee así y aquí era todo del mismo color.
        let mut state = state_with_files(&["src/git.rs"]);
        state.expanded.insert(
            "src/git.rs".into(),
            "@@ -1,0 +307,1 @@\n+pub async fn git_current_branch(path: String) {".into(),
        );

        let backend = ratatui::backend::TestBackend::new(100, 12);
        let mut terminal = ratatui::Terminal::new(backend).unwrap();
        terminal.draw(|f| super::draw::draw(f, &state, 24, false)).unwrap();
        let buf = terminal.backend().buffer();
        let row = (0..12)
            .find(|r| (0..100).any(|c| buf[(c, *r)].symbol() == "p" && buf[(c + 1, *r)].symbol() == "u"))
            .expect("la línea del diff");
        let colours: std::collections::HashSet<_> = (0..100).map(|c| buf[(c, row)].fg).collect();

        assert!(colours.len() > 2, "más de un color en la línea: {colours:?}");
    }

    #[test]
    fn the_marked_row_rides_in_the_middle_of_the_list() {
        // Leyendo un diff, lo que importa es lo que hay alrededor de la línea
        // marcada: pegada al borde de abajo sólo se ve lo de antes.
        let state = state_with_files(&["a.rs"]);

        // Alto diez: la marcada se queda a media altura.
        assert_eq!(state.scroll_offset(20, 10, 40), 15);
        assert_eq!(state.scroll_offset(25, 10, 40), 20);
    }

    #[test]
    fn at_the_ends_it_goes_as_far_as_there_is_something_to_read() {
        // Al principio y al final no hay con qué centrarla, y dejar media
        // pantalla en blanco para centrarla sería peor.
        let state = state_with_files(&["a.rs"]);

        assert_eq!(state.scroll_offset(2, 10, 40), 0, "arriba del todo");
        assert_eq!(state.scroll_offset(39, 10, 40), 30, "y abajo, hasta la última");
    }

    #[test]
    fn a_list_that_fits_never_scrolls() {
        let state = state_with_files(&["a.rs"]);

        assert_eq!(state.scroll_offset(4, 40, 6), 0);
    }

    #[test]
    fn the_diff_of_a_file_is_parsed_once_and_reused() {
        // Armar las filas parte todos los diffs abiertos, y el dibujo las pide
        // en cada frame: eran las mismas líneas repartidas sesenta veces por
        // segundo para no cambiar nada.
        let mut state = state_with_files(&["a.rs"]);
        state.expanded.insert("a.rs".into(), "@@ -1,0 +1,2 @@\n+uno\n+dos".into());

        let first = state.pane_rows().len();
        let parsed = state.diffs_parsed();
        let second = state.pane_rows().len();

        assert_eq!(first, second);
        assert_eq!(state.diffs_parsed(), parsed, "la segunda vez sale de lo ya partido");
    }

    #[test]
    fn changing_what_is_shown_parses_again() {
        // Lo guardado caduca con lo que lo hizo: al buscar en el diff y al
        // desplegar otro fichero.
        let mut state = state_with_files(&["a.rs", "b.rs"]);
        state.expanded.insert("a.rs".into(), "@@ -1,0 +1,2 @@\n+uno\n+dos".into());
        let _ = state.pane_rows();
        let parsed = state.diffs_parsed();

        state.file_search = "a".into();
        let _ = state.pane_rows();
        assert!(state.diffs_parsed() > parsed, "la búsqueda cambia lo que se ve");

        let parsed = state.diffs_parsed();
        state.expanded.insert("b.rs".into(), "@@ -1,0 +1,1 @@\n+tres".into());
        let _ = state.pane_rows();

        assert!(state.diffs_parsed() > parsed, "lo desplegado también");
    }

    #[tokio::test]
    async fn opening_them_all_stops_at_a_sensible_number() {
        // Cada fichero es una petición al daemon: con mil seiscientos, `z` se
        // quedaba veinte segundos pidiendo diffs que no caben en la pantalla
        // ni se van a leer de una sentada.
        let names: Vec<String> = (0..300).map(|n| format!("f{n}.rs")).collect();
        let paths: Vec<&str> = names.iter().map(String::as_str).collect();
        let mut state = state_with_files(&paths);
        state.focus = Focus::Files;

        state.handle_event(press(KeyCode::Char('z'))).await;

        assert_eq!(state.expanded.len(), 100, "los cien primeros");
        assert!(state.status.contains("100 de 300"), "y lo dice: {}", state.status);
    }

    #[tokio::test]
    async fn scrolling_after_a_click_does_not_start_selecting_lines() {
        // El ancla del arrastre se quedaba puesta desde el clic anterior, así
        // que al desplazarse se iba marcando todo lo que quedaba en medio como
        // si estuvieras eligiendo líneas para comentarlas. Revisar código no
        // es ir seleccionando.
        let mut state = state_with_diff();
        let area = state.files_area(100, 20, 24);
        state.handle_files_mouse(click(40, 4), area).await;

        state.scroll_wheel(40, 20, 100, 2);

        assert_eq!(state.comment_range(), None, "desplazarse no selecciona");
    }

    #[tokio::test]
    async fn moving_with_the_keyboard_does_not_select_either() {
        let mut state = state_with_diff();
        state.focus = Focus::Files;
        let area = state.files_area(100, 20, 24);
        state.handle_files_mouse(click(40, 4), area).await;

        state.handle_event(press(KeyCode::Down)).await;

        assert_eq!(state.comment_range(), None);
    }

    #[tokio::test]
    async fn but_dragging_still_selects() {
        let mut state = state_with_diff();
        let area = state.files_area(100, 20, 24);

        state.handle_files_mouse(click(40, 4), area).await;
        state.handle_files_mouse(drag(40, 6), area).await;

        assert_eq!(state.comment_range(), Some((43, 45)), "arrastrar sí");
    }

    #[test]
    fn counting_the_rows_does_not_build_them() {
        // Mover el cursor sólo necesita saber cuántas filas hay, y armarlas
        // copia cada línea de cada diff abierto: con un gesto de trackpad son
        // treinta copias de todo para bajar quince filas.
        let mut state = state_with_files(&["a.rs", "b.rs"]);
        state.expanded.insert("a.rs".into(), "@@ -1,0 +1,3 @@\n+uno\n+dos\n+tres".into());
        state.inline_comments = vec![comment(7, "a.rs", 2, "R0MADEV", "algo")];

        assert_eq!(state.pane_rows_len(), state.pane_rows().len());
    }

    fn state_with_two_open() -> ReviewState {
        let mut state = state_with_files(&["a.rs", "b.rs", "c.rs"]);
        state.current_pr = Some(1);
        state.expanded.insert("a.rs".into(), "@@ -1,0 +1,4 @@\n+uno\n+dos\n+tres\n+cuatro".into());
        state.expanded.insert("c.rs".into(), "@@ -1,0 +10,2 @@\n+diez\n+once".into());
        state.inline_comments = vec![comment(7, "a.rs", 2, "R0MADEV", "algo")];
        state
    }

    #[test]
    fn a_window_of_rows_is_the_same_as_cutting_the_whole_list() {
        // El dibujo arma sólo lo que cabe en pantalla: si la ventana no
        // coincide con la lista entera, se pinta una fila y se marca otra.
        let state = state_with_two_open();
        let all = state.pane_rows();

        for first in 0..all.len() {
            let window = state.pane_rows_window(first, 3);
            let expected = &all[first..(first + 3).min(all.len())];
            assert_eq!(window.len(), expected.len(), "en la fila {first}");
            for (a, b) in window.iter().zip(expected) {
                assert_eq!(row_label(a), row_label(b), "en la fila {first}");
            }
        }
    }

    /// Cómo se ve una fila, para comparar dos listas sin exigirles ser iguales.
    fn row_label(row: &super::visible::PaneRow<'_>) -> String {
        use super::visible::PaneRow;
        match row {
            PaneRow::File(f) => format!("file:{}", f.get("path").and_then(Value::as_str).unwrap_or("")),
            PaneRow::Diff { path, row } => format!("diff:{path}:{}", row.text),
            PaneRow::Split { path, row } => {
                format!("split:{path}:{:?}", row.right.as_ref().map(|r| r.text.clone()))
            }
            PaneRow::Comment(c) => format!("comment:{}", c.get("id").and_then(Value::as_u64).unwrap_or(0)),
        }
    }

    #[test]
    fn the_window_also_matches_in_two_columns() {
        let mut state = state_with_two_open();
        state.split = true;
        let all = state.pane_rows();

        let window = state.pane_rows_window(1, all.len());

        assert_eq!(window.len(), all.len() - 1);
        assert_eq!(row_label(&window[0]), row_label(&all[1]));
    }

    #[test]
    fn the_row_count_follows_the_filter_and_the_comments() {
        // El total se guarda para no recorrer las líneas en cada frame, así
        // que tiene que caducar con todo lo que lo cambia: el filtro de
        // estado, las dos columnas y los comentarios que llegan.
        let mut state = state_with_files(&["a.rs"]);
        state.files = vec![
            serde_json::json!({"status": "A", "path": "nuevo.rs"}),
            serde_json::json!({"status": "M", "path": "viejo.rs"}),
        ];
        assert_eq!(state.pane_rows_len(), 2);

        state.file_filter = FileFilter::Added;
        assert_eq!(state.pane_rows_len(), 1, "el filtro cambia el total");

        state.file_filter = FileFilter::All;
        state.expanded.insert("nuevo.rs".into(), "@@ -1,0 +1,2 @@\n+uno\n+dos".into());
        assert_eq!(state.pane_rows_len(), 5, "y el diff desplegado");

        state.inline_comments = vec![comment(7, "nuevo.rs", 1, "x", "y")];
        assert_eq!(state.pane_rows_len(), 6, "y un comentario que llega");
    }

    #[test]
    fn counting_comments_does_not_walk_every_line_for_each_one() {
        // Se preguntaba por cada línea si tenía comentarios: con veintiocho
        // mil líneas y siete comentarios eran doscientas mil comparaciones
        // para contar unas filas, y un gesto de trackpad tardaba un cuarto de
        // segundo.
        let mut state = state_with_files(&["a.rs", "b.rs"]);
        let long: String = std::iter::once("@@ -1,4000 +1,4000 @@".to_string())
            .chain((0..4000).map(|n| format!("+  linea {n}")))
            .collect::<Vec<_>>()
            .join("\n");
        state.expanded.insert("a.rs".into(), long.clone());
        state.expanded.insert("b.rs".into(), long);
        state.inline_comments = (0..7).map(|n| comment(n, "a.rs", n + 1, "x", "y")).collect();

        let start = std::time::Instant::now();
        for _ in 0..50 {
            state.parsed.borrow_mut().len = None;
            let _ = state.pane_rows_len();
        }

        assert!(start.elapsed().as_millis() < 500, "cincuenta recuentos: {:?}", start.elapsed());
    }

    #[test]
    fn an_added_line_is_tinted_not_painted_over() {
        // El escritorio pone ese verde al ocho por ciento y encima se lee el
        // código con sus colores; en sólido se come el resaltado y la línea
        // entera queda verde.
        let mut state = state_with_files(&["src/panel.ts"]);
        state.expanded.insert(
            "src/panel.ts".into(),
            "@@ -1,0 +23,1 @@\n+const toolbar = document.createElement('div')".into(),
        );

        let backend = ratatui::backend::TestBackend::new(92, 8);
        let mut terminal = ratatui::Terminal::new(backend).unwrap();
        terminal.draw(|f| super::draw::draw(f, &state, 20, false)).unwrap();
        let buf = terminal.backend().buffer();
        let row = (0..8)
            .find(|r| (20..92).map(|c| buf[(c, *r)].symbol()).collect::<String>().contains("toolbar"))
            .expect("la línea añadida");

        let tint = (20..92)
            .map(|c| buf[(c, row)].bg)
            .find(|bg| *bg != ratatui::style::Color::Reset)
            .expect("el tinte de añadido");
        let ratatui::style::Color::Rgb(r, g, b) = tint else { panic!("un tinte, no un color de paleta") };
        assert!(u32::from(r) + u32::from(g) + u32::from(b) < 120, "el fondo tiene que ser tenue: {tint:?}");

        let letters: std::collections::BTreeSet<String> =
            (20..92).map(|c| format!("{:?}", buf[(c, row)].fg)).collect();
        assert!(letters.len() >= 3, "y el código encima con sus colores: {letters:?}");

        // El verde de añadido, sólo en el signo: con la letra verde también,
        // un fichero nuevo —donde todo son líneas añadidas— se lee de un solo
        // color de arriba abajo.
        let green = ratatui::style::Color::Rgb(158, 206, 106);
        let painted: Vec<u16> = (20..92).filter(|c| buf[(*c, row)].fg == green).collect();
        let signs: Vec<u16> = painted
            .iter()
            .copied()
            .filter(|c| buf[(*c, row)].symbol() == "+")
            .collect();
        assert_eq!(painted, signs, "sólo el + va en verde");
    }

    #[tokio::test]
    async fn a_long_drag_selects_every_line_it_crosses() {
        // Entre un evento y el siguiente la aplicación repinta, y el repintado
        // centraba la fila marcada: la lista se movía bajo el ratón mientras
        // arrastrabas, así que el bloque salía cortado o no salía.
        let mut state = state_with_files(&["a.rs"]);
        // Bastantes más de las que caben: es cuando la vista se mueve.
        let lines: Vec<String> = (0..200).map(|n| format!("+  linea {n}")).collect();
        state.expanded.insert("a.rs".into(), format!("@@ -1,0 +1,200 @@\n{}", lines.join("\n")));
        state.current_pr = Some(1);
        state.files_selected = 100;
        let area = state.files_area(100, 30, 24);
        let _ = super::draw::tests::screen(&state, 100, 30);

        // Pulsar en una línea y arrastrar diez filas hacia abajo, repintando
        // en medio como hace la aplicación.
        state.handle_files_mouse(click(40, 4), area).await;
        let from = state.selected_diff_line().expect("la línea de partida");
        for row in 5..=14 {
            let _ = super::draw::tests::screen(&state, 100, 30);
            state.handle_files_mouse(drag(40, row), area).await;
        }

        assert_eq!(state.comment_range(), Some((from, from + 10)), "las once líneas del gesto");

        // Y se ven marcadas: el estado decía "comentando las líneas X-Y" y en
        // pantalla no había nada señalado.
        let text = super::draw::tests::screen(&state, 100, 30);
        let marked = text.lines().filter(|l| l.contains('┃')).count();
        assert_eq!(marked, 11, "las mismas once, marcadas:\n{text}");
    }

    #[tokio::test]
    async fn opening_another_file_drops_a_selection_from_the_one_before() {
        // Desplegar mueve todas las filas de sitio, así que el bloque
        // señalado deja de ser el que era: quedaba una selección de otro
        // fichero, con sus números de línea, sobre el que acabas de abrir.
        let mut state = state_with_diff();
        state.focus = Focus::Files;
        let area = state.files_area(100, 20, 24);
        state.handle_files_mouse(click(40, 4), area).await;
        state.handle_files_mouse(drag(40, 6), area).await;
        assert!(state.comment_range().is_some());

        state.toggle_file("b.rs".to_string()).await;

        assert_eq!(state.comment_range(), None, "abrir otro fichero retira la selección");
    }

    #[test]
    fn only_a_failure_is_painted_as_a_failure() {
        // "comentando las líneas 12-20" salía en rojo, como si algo hubiera
        // ido mal: el rojo es para lo que falla.
        use super::draw::status_is_failure;

        assert!(status_is_failure("no se pudo comentar: gh: Not Found"));
        assert!(status_is_failure("error: algo"));
        assert!(!status_is_failure("comentando las líneas 12-20"));
        assert!(!status_is_failure("comentario puesto en la línea 12"));
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

        assert!(state.drawer_width > crate::tui::drawer::COLLAPSED_WIDTH, "el cajón se abre");
        assert_eq!(state.drawer_body(), state.output, "y enseña la review, sin tapar el panel");
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
