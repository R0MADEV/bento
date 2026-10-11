//! Terminals/agents list — the panel's landing view — with inline attach
//! (returns here when the remote session ends).

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use super::pane::{self, Pane};
use super::sidebar::{ItemStatus, Sidebar, SidebarItem};

#[derive(Clone)]
pub(super) struct TerminalInfo {
    pub(super) pty_id: String,
    title: String,
    pub(super) cwd: String,
    /// Branch of the folder its agent runs in; none for a plain shell.
    branch: Option<String>,
}

/// Con qué perfil abrir la siguiente, dando la vuelta a la lista: primero
/// ninguno (el shell del daemon), luego cada perfil guardado. Es el mismo gesto
/// que elegir agente en la pestaña de review, y evita un modal para elegir
/// entre tres cosas.
pub(super) fn next_profile(profiles: usize, current: Option<usize>) -> Option<usize> {
    match current {
        None if profiles > 0 => Some(0),
        None => None,
        Some(index) if index + 1 < profiles => Some(index + 1),
        Some(_) => None,
    }
}

/// Dónde abrir la nueva: donde esté la que tienes seleccionada, y si no hay
/// ninguna, donde se lanzó la CLI. El móvil pregunta el proyecto; aquí la lista
/// ya lo está enseñando, así que preguntarlo otra vez sobraría.
pub(super) fn cwd_for_new(items: &[TerminalInfo], selected: usize, fallback: &str) -> String {
    items
        .get(selected)
        .map(|item| item.cwd.clone())
        .filter(|cwd| !cwd.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

pub(super) fn draw_list(
    frame: &mut ratatui::Frame,
    items: &[TerminalInfo],
    selected: usize,
    sidebar_width: u16,
    status: &str,
    list: ListState,
) {
    draw_chrome(frame, items, selected, sidebar_width, status, None, list);
}

/// Everything around the right column's contents: the rail, the status line
/// and the empty framed box. Shared so the layout cannot drift between the
/// list and the attached view — the rail must not shift when connecting.
/// Lo que la lista necesita saber del panel: con qué perfil abriría la
/// siguiente y si las flechas están moviendo bordes en vez de la selección.
pub(super) struct ListState<'a> {
    pub(super) profile: Option<&'a str>,
    pub(super) resizing: bool,
    /// El nombre que se está escribiendo, mientras se renombra una.
    pub(super) renaming: Option<&'a str>,
    /// The selected terminal, live, to show instead of the "Enter to connect" card.
    pub(super) preview: Option<&'a super::screen::Screen>,
}

/// Lo que la cabecera necesita saber del terminal conectado. Fuera de él nada
/// de esto significa nada, de ahí que vayan juntos y en un `Option`.
struct Attachment<'a> {
    looking_back: bool,
    searching: Option<&'a str>,
}

fn draw_chrome(
    frame: &mut ratatui::Frame,
    items: &[TerminalInfo],
    selected: usize,
    sidebar_width: u16,
    status: &str,
    attached: Option<Attachment>,
    list: ListState,
) {
    // The status line only takes room when it has something to say, so a
    // working panel is not permanently one row shorter for nothing.
    let status_height = u16::from(!status.is_empty());
    let body = Layout::vertical([Constraint::Min(1), Constraint::Length(status_height)]).split(frame.area());
    if status_height > 0 {
        let line = Line::from(Span::styled(status, Style::new().fg(Color::Red)));
        frame.render_widget(Paragraph::new(line), body[1]);
    }
    let cols = Layout::horizontal([Constraint::Length(sidebar_width), Constraint::Min(1)]).split(body[0]);
    // Cada fila lleva su número: `1`…`9` salta directo, que es más rápido que
    // bajar con las flechas cuando tienes ocho terminales abiertas.
    let rows: Vec<SidebarItem> = items
        .iter()
        .enumerate()
        .map(|(index, t)| SidebarItem {
            label: match index < 9 {
                true => format!("{} {}", index + 1, t.title),
                false => t.title.clone(),
            },
            detail: location(&t.cwd, t.branch.as_deref(), sidebar_width),
            status: ItemStatus::Active,
        })
        .collect();
    Sidebar {
        action: Some(&match list.profile {
            Some(name) => format!("n nuevo · k cerrar · {name}"),
            None => "n nuevo · k cerrar · p perfil".to_string(),
        }),
        empty_message: "No hay terminales",
        ..Sidebar::new("TERMINAL", &rows, selected)
    }
    .render(frame, cols[0]);

    if let Some(attached) = attached {
        Pane {
            title: items.get(selected).map(|t| t.title.as_str()).unwrap_or(""),
            // Mirando atrás lo que va llegando no se ve, y sin decirlo eso
            // parece un terminal colgado.
            hint: &match (attached.searching, attached.looking_back) {
                (Some(term), _) => format!("buscar: {term}▏ (Enter siguiente · Esc salir)"),
                (None, true) => "mirando atrás · ⇧AvPág para volver al final".to_string(),
                (None, false) => "F5 nuevo · F12 lista · ⇧RePág atrás · F3 buscar".to_string(),
            },
            focused: true,
        }
        .render(frame, cols[1]);
        return;
    }
    draw_detail(frame, items.get(selected), cols[1], &list);
}

/// Where the remote terminal is painted: the right column, minus the border
/// its block draws. The caller needs this before rendering, to tell the pty
/// what size to wrap its output to.
pub(super) fn terminal_area(frame: Rect, sidebar_width: u16, status: &str) -> Rect {
    let status_height = u16::from(!status.is_empty());
    let body = Layout::vertical([Constraint::Min(1), Constraint::Length(status_height)]).split(frame);
    let cols = Layout::horizontal([Constraint::Length(sidebar_width), Constraint::Min(1)]).split(body[0]);
    // The pane's own frame is not usable space; handing the pty the outer
    // size would make it wrap one column late and one row short.
    pane::inner(cols[1])
}

/// The panel while a terminal is attached: the rail stays put on the left and
/// the emulated screen is drawn into the right column.
pub(super) fn draw_attached(
    frame: &mut ratatui::Frame,
    items: &[TerminalInfo],
    selected: usize,
    sidebar_width: u16,
    status: &str,
    screen: &super::screen::Screen,
    searching: Option<&str>,
) {
    let attachment = Attachment { looking_back: screen.is_scrolled_back(), searching };
    draw_chrome(frame, items, selected, sidebar_width, status, Some(attachment), ListState { profile: None, resizing: false, renaming: None, preview: None });
    let area = terminal_area(frame.area(), sidebar_width, status);
    screen.render(frame, area);
    if let Some((x, y)) = screen.cursor_in(area) {
        frame.set_cursor_position((x, y));
    }
}

/// Opens a terminal in `cwd` and returns its pty id, so the caller can select
/// the row that is about to appear instead of guessing where it landed.
pub(super) async fn open_terminal(cwd: &str, shell: Option<&str>) -> std::io::Result<String> {
    let mut body = json!({ "id": "1", "cmd": "terminal.open", "cwd": cwd });
    if let Some(shell) = shell {
        body["shell"] = json!(shell);
    }
    let data = crate::request_data(body).await?;
    Ok(data.get("pty_id").and_then(Value::as_str).unwrap_or_default().to_string())
}

/// The right column while nothing is attached: what Enter would connect to,
/// and the keys that work here.
fn draw_detail(frame: &mut ratatui::Frame, current: Option<&TerminalInfo>, area: Rect, list: &ListState) {
    let dim = Style::new().fg(Color::DarkGray);
    let body = match current {
        Some(t) => vec![
            Line::from(Span::styled(t.title.as_str(), Style::new().fg(Color::White))),
            Line::from(Span::styled(t.cwd.as_str(), dim)),
            Line::raw(""),
            Line::from(Span::styled("Enter para conectar", dim)),
        ],
        None => vec![Line::from(Span::styled("Abrí un terminal desde Bento.", dim))],
    };
    let inner = Pane {
        title: match (list.preview, current) {
            (Some(_), Some(terminal)) => terminal.title.as_str(),
            _ => "",
        },
        // En modo tamaño lo dice, porque las flechas dejan de mover la
        // selección: pulsar `s` y no ver nada es no haber pulsado nada.
        hint: &match (list.renaming, list.resizing) {
            (Some(name), _) => format!("nombre: {name}▏ (Enter guardar · Esc cancelar)"),
            (None, true) => "MODO TAMAÑO · ←/→ ancho del raíl · s o Esc salir".to_string(),
            // Looking does not resize the terminal under whoever is using it,
            // so one bigger than this panel is seen only in part.
            (None, false) if list.preview.is_some_and(|screen| is_cropped(screen.size(), area)) =>
                "vista recortada (está abierto más grande en otro lado) · Enter para ajustarlo a este panel y usarlo".to_string(),
            (None, false) => "1-9/↑↓ elegir · Enter conectar · n nuevo · r renombrar · k cerrar · p perfil · s tamaño · Tab review · q salir".to_string(),
        },
        focused: false,
    }
    .render(frame, area);
    match list.preview {
        Some(screen) => screen.render(frame, inner),
        None => frame.render_widget(Paragraph::new(body), inner),
    }
}

/// Where a terminal's agent is working: its folder and, in a repository, the
/// branch — the same line the app and the phone show. The folder gives way to
/// the branch when the rail is too narrow for both.
fn location(cwd: &str, branch: Option<&str>, sidebar_width: u16) -> String {
    let Some(branch) = branch else { return short_cwd(cwd, sidebar_width) };
    let branch_width = branch.chars().count() as u16 + 3;
    format!("{} · {branch}", short_cwd(cwd, sidebar_width.saturating_sub(branch_width)))
}

/// Whether a terminal of `size` (rows, cols) is too big to be seen whole in
/// the pane drawn at `area`, borders included.
fn is_cropped(size: (u16, u16), area: Rect) -> bool {
    let (rows, cols) = size;
    rows > area.height.saturating_sub(2) || cols > area.width.saturating_sub(2)
}

/// `~` for home and a leading ellipsis for anything long: the rail is narrow,
/// so a full path would be cut mid-segment and read as nothing.
fn short_cwd(cwd: &str, sidebar_width: u16) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let shortened = match cwd.strip_prefix(&home) {
        Some(rest) if !home.is_empty() => format!("~{rest}"),
        _ => cwd.to_string(),
    };
    let budget = sidebar_width.saturating_sub(4).max(1) as usize;
    if shortened.chars().count() <= budget {
        return shortened;
    }
    let tail: String = shortened.chars().skip(shortened.chars().count() - (budget - 1)).collect();
    format!("…{tail}")
}

/// Un clic en el raíl, se esté conectado o no: elegir una fila abre esa
/// terminal y el botón abre una nueva y entra en ella. Estaba escrito dos
/// veces, una por modo, y las dos hacían lo mismo.
///
/// Devuelve el modo al que ir, o el aviso de por qué no se pudo.
pub(super) async fn rail_click(
    rail: super::rail::RailMouse<'_>,
    mouse: crossterm::event::MouseEvent,
    items: &mut Vec<TerminalInfo>,
    selected: &mut usize,
    area: ratatui::layout::Rect,
    open: (&str, Option<&str>),
) -> Option<Result<super::Mode, String>> {
    let (cwd, shell) = open;
    let index = match rail.handle(mouse)? {
        super::rail::RailClick::Select(index) => index,
        super::rail::RailClick::Action => {
            let where_to = cwd_for_new(items, *selected, cwd);
            match new_agent(&where_to, shell).await {
                Ok((fetched, index)) => {
                    *items = fetched;
                    index?
                }
                Err(message) => return Some(Err(message)),
            }
        }
    };
    *selected = index;
    let item = items.get(index)?;
    Some(attach_to(&item.pty_id, area).await)
}

/// Lo que una tecla le hace al nombre que se está escribiendo: seguir
/// escribiéndolo, guardarlo o dejarlo.
pub(super) enum Rename {
    Typing(String),
    Save(String),
    Cancel,
}

pub(super) fn rename_key(name: String, code: KeyCode) -> Rename {
    let mut name = name;
    match code {
        KeyCode::Esc => Rename::Cancel,
        KeyCode::Enter => Rename::Save(name),
        KeyCode::Backspace => { name.pop(); Rename::Typing(name) }
        KeyCode::Char(c) => { name.push(c); Rename::Typing(name) }
        _ => Rename::Typing(name),
    }
}

/// Le pone nombre a una terminal. El daemon ya sabía hacerlo —el escritorio lo
/// usa— y por aquí no había forma de pedirlo.
pub(super) async fn rename_terminal(pty_id: &str, title: &str) -> std::io::Result<()> {
    crate::request_data(json!({
        "id": "1", "cmd": "terminal.set_title", "pty_id": pty_id, "title": title,
    })).await?;
    Ok(())
}

/// Cierra un terminal. Lo mismo que hacen el escritorio y el móvil: los tres
/// hablan con el mismo daemon, y esta era la única de las tres que solo sabía
/// abrirlos.
pub(super) async fn close_terminal(pty_id: &str) -> std::io::Result<()> {
    crate::request_data(json!({ "id": "1", "cmd": "terminal.close", "pty_id": pty_id })).await?;
    Ok(())
}

/// Dónde queda el cursor tras cerrar el de la fila `selected`, contando los
/// terminales que había antes. Cerrar el último dejaba el cursor apuntando a
/// una fila que ya no existe.
pub(super) fn selection_after_close(before: usize, selected: usize) -> usize {
    let left = before.saturating_sub(1);
    selected.min(left.saturating_sub(1))
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
            branch: v.get("branch").and_then(Value::as_str).map(str::to_string),
        })
        .collect();
    Ok(items)
}

/// A live connection to one pty. Unlike the previous inline attach, it does
/// not own the screen or the event loop: it hands the remote bytes to the
/// caller, which feeds them to an emulator and paints them inside the panel.
pub(super) struct Session {
    pty_id: String,
    out_tx: tokio::sync::mpsc::UnboundedSender<String>,
    /// What the terminal does, in the order it happened: output only makes
    /// sense drawn at the size announced before it.
    pub(super) events_rx: tokio::sync::mpsc::UnboundedReceiver<SessionEvent>,
    pub(super) exit_rx: tokio::sync::oneshot::Receiver<()>,
    /// The size that fits this panel, and the one the terminal really has. The
    /// same terminal can be open in the app and on the phone: it has ONE size,
    /// every client draws at it, and the one being used asks for its own.
    own: (u16, u16),
    pub(super) shared: Option<(u16, u16)>,
    writer: tokio::task::JoinHandle<()>,
}

pub(super) enum SessionEvent {
    Output(Vec<u8>),
    /// The size the daemon says the terminal has now.
    Size(u16, u16),
}

/// Whether this client must ask for its own size before sending input: the
/// terminal is known to be at another client's.
fn needs_claim(own: (u16, u16), shared: Option<(u16, u16)>) -> bool {
    shared.is_some_and(|size| size != own)
}

/// The selected terminal shown live while only browsing the list. Read-only,
/// and it never asks for a size: looking at a terminal must not resize it under
/// the client that is using it.
pub(super) struct Preview {
    pub(super) pty_id: String,
    session: Session,
    pub(super) screen: super::screen::Screen,
}

impl Preview {
    pub(super) async fn open(pty_id: &str) -> Option<Self> {
        let session = Session::open(pty_id, None).await.ok()?;
        Some(Self { pty_id: pty_id.to_string(), session, screen: super::screen::Screen::new(0, 0) })
    }

    /// Applies the next thing the terminal does. Without a preview (or once its
    /// terminal is gone) there is nothing to wait for, so it never resolves.
    pub(super) async fn changed(preview: &mut Option<Self>) {
        let Some(preview) = preview else { return std::future::pending().await };
        match preview.session.events_rx.recv().await {
            Some(SessionEvent::Output(bytes)) => preview.screen.feed(&bytes),
            Some(SessionEvent::Size(rows, cols)) => { preview.screen.resize(rows, cols); }
            None => std::future::pending().await,
        }
    }
}

impl Session {
    pub(super) async fn connect(id: &str, rows: u16, cols: u16) -> std::io::Result<Self> {
        Self::open(id, Some((rows, cols))).await
    }

    /// Subscribes to a terminal. With `claim` it also asks the terminal to take
    /// that size, which is what a client that is going to be used does.
    async fn open(id: &str, claim: Option<(u16, u16)>) -> std::io::Result<Self> {
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
        // Sized to the panel's inner area, not the whole window: the remote
        // program must wrap its lines to the box it is drawn in.
        if let Some((rows, cols)) = claim {
            let _ = out_tx.send(json!({ "cmd": "terminal.resize", "pty_id": id, "rows": rows, "cols": cols }).to_string());
        }

        let (events_tx, events_rx) = tokio::sync::mpsc::unbounded_channel::<SessionEvent>();
        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let mut lines = BufReader::new(read_half).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                match value.get("event").and_then(Value::as_str) {
                    Some("terminal.output") => {
                        if let Some(data) = value.get("data").and_then(Value::as_str) {
                            if events_tx.send(SessionEvent::Output(data.as_bytes().to_vec())).is_err() { break; }
                        }
                    }
                    Some("terminal.size") => {
                        let cells = |key: &str| value.get(key).and_then(Value::as_u64).and_then(|n| u16::try_from(n).ok());
                        if let (Some(rows), Some(cols)) = (cells("rows"), cells("cols")) {
                            let _ = events_tx.send(SessionEvent::Size(rows, cols));
                        }
                    }
                    Some("terminal.exit") => break,
                    _ => {}
                }
            }
            let _ = exit_tx.send(());
        });

        Ok(Self { pty_id: id.to_string(), out_tx, events_rx, exit_rx, own: claim.unwrap_or_default(), shared: None, writer })
    }

    pub(super) fn send_key(&self, key: KeyEvent) {
        self.write(key_event_to_bytes(key));
    }

    /// Raw bytes to the pty — the encoded mouse events go through here, since
    /// they are input like any other.
    pub(super) fn write(&self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        // Typing here makes this the client in use: take the terminal back to
        // this panel's size if another client had it at its own.
        if needs_claim(self.own, self.shared) {
            self.send_size();
        }
        if let Ok(text) = String::from_utf8(bytes) {
            let _ = self
                .out_tx
                .send(json!({ "cmd": "terminal.write", "pty_id": self.pty_id, "data": text }).to_string());
        }
    }

    /// The panel changed size: ask the terminal to follow it.
    pub(super) fn resize(&mut self, rows: u16, cols: u16) {
        self.own = (rows, cols);
        self.send_size();
    }

    fn send_size(&self) {
        let (rows, cols) = self.own;
        let _ = self
            .out_tx
            .send(json!({ "cmd": "terminal.resize", "pty_id": self.pty_id, "rows": rows, "cols": cols }).to_string());
    }

    pub(super) fn own_size(&self) -> (u16, u16) {
        self.own
    }

    /// The grid to draw: the terminal's real size once known, so what an agent
    /// paints for another client's size lands in the same cells here.
    pub(super) fn grid(&self) -> (u16, u16) {
        self.shared.unwrap_or(self.own)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.writer.abort();
    }
}

/// F5 opens a new agent without leaving the terminal. It is free to reserve:
/// `key_event_to_bytes` maps only F1–F4, so F5 never reached the remote
/// program anyway.
pub(super) fn is_new_agent_key(key: KeyEvent) -> bool {
    key.kind == KeyEventKind::Press && key.code == KeyCode::F(5)
}

/// F12 returns to the list. While attached every other key belongs to the
/// remote program, so the way out has to be one almost nothing binds — and a
/// bare function key, unlike telnet's Ctrl+], is typable on every keyboard
/// layout (on a Spanish one "]" is already AltGr+"+").
/// Cuántas líneas mover la vista, si esta tecla es de mirar hacia atrás.
/// Con Shift, porque RePág y AvPág a secas son del programa de dentro — un
/// `less` o un `htop` las quieren.
pub(super) fn scrollback_keys(key: KeyEvent) -> Option<i32> {
    if key.kind != KeyEventKind::Press || !key.modifiers.contains(KeyModifiers::SHIFT) {
        return None;
    }
    match key.code {
        KeyCode::PageUp => Some(10),
        KeyCode::PageDown => Some(-10),
        _ => None,
    }
}

/// F3 abre el buscador y, con uno escrito, salta a la siguiente aparición.
/// Una tecla de función porque cualquier letra es del programa de dentro.
pub(super) fn is_search_key(key: KeyEvent) -> bool {
    key.kind == KeyEventKind::Press && key.code == KeyCode::F(3)
}

pub(super) fn is_detach_key(key: KeyEvent) -> bool {
    key.kind == KeyEventKind::Press && key.code == KeyCode::F(12)
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

/// row, and switching while already attached.
pub(super) async fn attach_to(pty_id: &str, area: ratatui::layout::Rect) -> Result<super::Mode, String> {
    match Session::connect(pty_id, area.height, area.width).await {
        Ok(session) => Ok(super::Mode::Attached(Box::new(super::Attached {
            session,
            screen: super::screen::Screen::new(area.height, area.width),
        }))),
        Err(error) => Err(format!("No se pudo conectar: {error}")),
    }
}

/// Opens a terminal and reports where it landed in the refreshed list, so the
/// caller can select it. Shared by the "n" key and the rail's action button.
pub(super) async fn new_agent(
    cwd: &str,
    shell: Option<&str>,
) -> Result<(Vec<TerminalInfo>, Option<usize>), String> {
    match open_terminal(cwd, shell).await {
        Ok(pty_id) => {
            let items = fetch_terminals().await.unwrap_or_default();
            let index = items.iter().position(|t| t.pty_id == pty_id);
            Ok((items, index))
        }
        Err(error) => Err(format!("No se pudo abrir: {error}")),
    }
}

/// La fila marcada tras mover la rueda, sin salirse de la lista.
pub(crate) fn scrolled(selected: usize, rows: usize, step: i16) -> usize {
    let last = rows.saturating_sub(1);
    selected.saturating_add_signed(step as isize).min(last)
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_wheel_stops_at_both_ends_of_the_list() {
        assert_eq!(super::scrolled(0, 2, 3), 1, "no se pasa del final");
        assert_eq!(super::scrolled(1, 2, -3), 0, "ni del principio");
        assert_eq!(super::scrolled(0, 0, 3), 0, "ni con la lista vacía");
        assert_eq!(super::scrolled(4, 9, 1), 5, "una muesca, una fila");
    }

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
    fn f12_is_the_way_back_to_the_list() {
        // Attached, every other key belongs to the remote program, so without
        // this the user is trapped until the remote terminal dies.
        assert!(is_detach_key(press(KeyCode::F(12), KeyModifiers::NONE)));
    }

    #[test]
    fn the_way_out_does_not_need_a_modifier_a_spanish_layout_cannot_type() {
        // Ctrl+] was unreachable here: on a Spanish layout "]" is AltGr+"+".
        // A bare function key is typable on every layout.
        assert!(is_detach_key(press(KeyCode::F(12), KeyModifiers::NONE)));
        assert!(!is_detach_key(press(KeyCode::Char(']'), KeyModifiers::NONE)));
    }

    #[test]
    fn f5_opens_a_new_agent_without_leaving_the_terminal() {
        assert!(is_new_agent_key(press(KeyCode::F(5), KeyModifiers::NONE)));
        assert!(!is_new_agent_key(press(KeyCode::F(4), KeyModifiers::NONE)));
    }

    #[test]
    fn reserving_f5_costs_the_remote_program_nothing() {
        // It was already unmapped, so nothing that used to reach the pty stops
        // doing so — unlike F1–F4, which do carry sequences.
        assert!(key_event_to_bytes(press(KeyCode::F(5), KeyModifiers::NONE)).is_empty());
        assert!(!key_event_to_bytes(press(KeyCode::F(4), KeyModifiers::NONE)).is_empty());
    }

    #[test]
    fn ordinary_keys_still_reach_the_remote_program() {
        assert!(!is_detach_key(press(KeyCode::Char('c'), KeyModifiers::CONTROL)));
        assert!(!is_detach_key(press(KeyCode::F(1), KeyModifiers::NONE)));
        assert!(!is_detach_key(press(KeyCode::Esc, KeyModifiers::NONE)));
    }

    #[test]
    fn a_detach_key_release_does_not_count_as_a_second_detach() {
        let mut key = press(KeyCode::F(12), KeyModifiers::NONE);
        key.kind = KeyEventKind::Release;
        assert!(!is_detach_key(key));
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

    /// Renders the whole list view and returns the screen as text, so a test
    /// can assert on what the user actually ends up seeing.
    fn render_list(items: &[TerminalInfo], status: &str) -> String {
        render_list_with(items, status, None)
    }

    fn render_list_with(items: &[TerminalInfo], status: &str, preview: Option<&super::super::screen::Screen>) -> String {
        let (width, height) = (70u16, 12u16);
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| draw_list(frame, items, 0, 24, status, ListState { profile: None, resizing: false, renaming: None, preview })).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..height)
            .map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    // Choosing a row shows that terminal live, as the app does: what was asked
    // in it from another client must be readable without connecting first.
    #[test]
    fn the_selected_terminal_is_shown_live_while_browsing_the_list() {
        let mut live = super::super::screen::Screen::new(8, 40);
        live.feed(b"pregunta hecha en la app");
        let items = [TerminalInfo { pty_id: "1".into(), title: "agente".into(), cwd: "/repo".into(), branch: None }];

        let screen = render_list_with(&items, "", Some(&live));

        assert!(screen.contains("pregunta hecha en la app"), "se tiene que ver lo que hay en el terminal:\n{screen}");
    }

    // Looking at a terminal does not resize it under whoever is using it, so a
    // bigger one is seen in part — and has to say so, or it just looks broken.
    #[test]
    fn a_preview_too_big_for_the_pane_says_it_is_cropped() {
        let live = super::super::screen::Screen::new(64, 224);
        let items = [TerminalInfo { pty_id: "1".into(), title: "agente".into(), cwd: "/repo".into(), branch: None }];

        let screen = render_list_with(&items, "", Some(&live));

        assert!(screen.contains("vista recortada"), "tiene que avisar de que no se ve entero:\n{screen}");
    }

    #[test]
    fn a_failure_is_shown_instead_of_swallowed() {
        // "n" failed silently whenever the daemon was down: the whole point of
        // the status line is that the user sees why nothing happened.
        let screen = render_list(&[], "No se pudo abrir: Connection refused");
        assert!(screen.contains("Connection refused"), "el fallo tiene que verse en pantalla");
    }

    #[test]
    fn with_nothing_to_report_no_status_line_is_painted() {
        assert!(!render_list(&[], "").contains("No se pudo"));
    }

    #[test]
    fn the_terminal_area_starts_after_the_rail_and_excludes_the_border() {
        let area = terminal_area(Rect::new(0, 0, 100, 30), 24, "");

        // Right column is x=24..100; the block's border eats one column and
        // one row on each side.
        assert_eq!(area, Rect::new(25, 1, 74, 28));
    }

    #[test]
    fn a_status_line_takes_a_row_from_the_terminal_not_from_thin_air() {
        let without = terminal_area(Rect::new(0, 0, 100, 30), 24, "");
        let with = terminal_area(Rect::new(0, 0, 100, 30), 24, "algo falló");

        assert_eq!(with.height, without.height - 1);
    }

    #[test]
    fn widening_the_rail_narrows_the_terminal_by_the_same_amount() {
        let narrow = terminal_area(Rect::new(0, 0, 100, 30), 24, "");
        let wide = terminal_area(Rect::new(0, 0, 100, 30), 34, "");

        assert_eq!(wide.width, narrow.width - 10);
    }

    #[test]
    fn a_short_path_is_left_alone() {
        assert_eq!(short_cwd("/tmp/bento", 24), "/tmp/bento");
    }

    #[test]
    fn a_long_path_keeps_its_tail_which_is_the_part_that_identifies_it() {
        let short = short_cwd("/opt/muy/larga/ruta/que/no/entra/en/la/barra/proyecto", 24);
        assert!(short.chars().count() <= 20);
        assert!(short.ends_with("proyecto"), "el final es lo que distingue una ruta de otra");
        assert!(short.starts_with('…'));
    }

    #[test]
    fn a_wider_rail_shortens_less() {
        let path = "/opt/muy/larga/ruta/que/no/entra/en/la/barra/proyecto";
        assert!(short_cwd(path, 40).chars().count() > short_cwd(path, 24).chars().count());
    }

    #[test]
    fn input_takes_the_terminal_back_only_from_another_clients_size() {
        assert!(needs_claim((40, 120), Some((24, 80))));
        assert!(!needs_claim((40, 120), Some((40, 120))));
        // Unknown size: the connect already asked for ours.
        assert!(!needs_claim((40, 120), None));
    }

    #[test]
    fn a_terminal_bigger_than_the_pane_is_reported_as_cropped() {
        let pane = Rect::new(0, 0, 100, 30);
        assert!(is_cropped((64, 224), pane));
        assert!(is_cropped((28, 120), pane));
        assert!(!is_cropped((28, 98), pane));
    }

    #[test]
    fn an_agent_shows_its_folder_and_branch() {
        assert_eq!(location("/tmp/bento", Some("main"), 40), "/tmp/bento · main");
        assert_eq!(location("/tmp/bento", None, 40), "/tmp/bento");
    }

    #[test]
    fn a_long_branch_shortens_the_folder_instead_of_running_off_the_rail() {
        let shown = location("/opt/una/ruta/bastante/larga/proyecto", Some("feat/login"), 30);
        assert!(shown.ends_with(" · feat/login"));
        assert!(shown.starts_with('…'));
    }

    #[test]
    fn an_empty_cwd_stays_empty_rather_than_becoming_a_lone_tilde() {
        assert_eq!(short_cwd("", 24), "");
    }

    #[test]
    fn an_absurdly_narrow_rail_does_not_underflow_the_budget() {
        assert!(!short_cwd("/tmp/bento", 2).is_empty());
    }

    #[test]
    fn closing_the_last_terminal_leaves_the_selection_inside_the_list() {
        // Matar el último dejaba el cursor apuntando a una fila que ya no
        // está, y la siguiente tecla leía fuera de la lista.
        assert_eq!(selection_after_close(3, 2), 1);
        assert_eq!(selection_after_close(3, 0), 0);
        assert_eq!(selection_after_close(1, 0), 0, "sin terminales, la primera fila");
    }

    #[test]
    fn shift_pageup_looks_back_and_plain_pageup_belongs_to_the_program() {
        assert_eq!(scrollback_keys(press(KeyCode::PageUp, KeyModifiers::SHIFT)), Some(10));
        assert_eq!(scrollback_keys(press(KeyCode::PageDown, KeyModifiers::SHIFT)), Some(-10));
        // Sin Shift son del programa de dentro: `less` y `htop` las quieren.
        assert_eq!(scrollback_keys(press(KeyCode::PageUp, KeyModifiers::NONE)), None);
        assert_eq!(scrollback_keys(press(KeyCode::Char('a'), KeyModifiers::SHIFT)), None);
    }

    #[test]
    fn f3_is_the_search_key_and_letters_belong_to_the_program() {
        assert!(is_search_key(press(KeyCode::F(3), KeyModifiers::NONE)));
        assert!(!is_search_key(press(KeyCode::Char('/'), KeyModifiers::NONE)));
    }

    fn info(cwd: &str) -> TerminalInfo {
        TerminalInfo { pty_id: "1".into(), title: "t".into(), cwd: cwd.into(), branch: None }
    }

    #[test]
    fn a_new_terminal_opens_where_the_selected_one_lives() {
        let items = vec![info("/repo/uno"), info("/repo/dos")];

        assert_eq!(cwd_for_new(&items, 1, "/donde-sea"), "/repo/dos");
    }

    #[test]
    fn with_no_terminals_it_falls_back_to_where_the_cli_started() {
        assert_eq!(cwd_for_new(&[], 0, "/donde-sea"), "/donde-sea");
        assert_eq!(cwd_for_new(&[info("")], 0, "/donde-sea"), "/donde-sea");
    }

    #[test]
    fn the_profile_cycles_through_the_saved_ones_and_back_to_none() {
        assert_eq!(next_profile(2, None), Some(0));
        assert_eq!(next_profile(2, Some(0)), Some(1));
        assert_eq!(next_profile(2, Some(1)), None, "y vuelve al shell de siempre");
    }

    #[test]
    fn with_no_profiles_there_is_nothing_to_cycle() {
        assert_eq!(next_profile(0, None), None);
    }

    #[test]
    fn typing_a_name_and_saving_it() {
        let name = match rename_key(String::new(), KeyCode::Char('a')) {
            Rename::Typing(name) => name,
            _ => panic!("escribir no guarda ni cancela"),
        };
        assert_eq!(name, "a");
        assert!(matches!(rename_key(name.clone(), KeyCode::Enter), Rename::Save(saved) if saved == "a"));
        assert!(matches!(rename_key(name, KeyCode::Esc), Rename::Cancel));
    }

    #[test]
    fn backspace_erases_instead_of_cancelling() {
        // Borrarse una letra no puede tirar el nombre entero.
        assert!(matches!(rename_key("ab".into(), KeyCode::Backspace), Rename::Typing(name) if name == "a"));
    }
}
