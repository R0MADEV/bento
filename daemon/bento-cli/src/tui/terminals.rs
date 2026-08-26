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
    cwd: String,
}

pub(super) fn draw_list(
    frame: &mut ratatui::Frame,
    items: &[TerminalInfo],
    selected: usize,
    sidebar_width: u16,
    status: &str,
) {
    draw_chrome(frame, items, selected, sidebar_width, status, false);
}

/// Everything around the right column's contents: the rail, the status line
/// and the empty framed box. Shared so the layout cannot drift between the
/// list and the attached view — the rail must not shift when connecting.
fn draw_chrome(
    frame: &mut ratatui::Frame,
    items: &[TerminalInfo],
    selected: usize,
    sidebar_width: u16,
    status: &str,
    attached: bool,
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
    let rows: Vec<SidebarItem> = items
        .iter()
        .map(|t| SidebarItem {
            label: t.title.clone(),
            detail: short_cwd(&t.cwd, sidebar_width),
            status: ItemStatus::Active,
        })
        .collect();
    Sidebar {
        action: Some("+ Nuevo agente  (n·F5)"),
        empty_message: "No hay terminales",
        ..Sidebar::new("TERMINAL", &rows, selected)
    }
    .render(frame, cols[0]);

    if attached {
        Pane {
            title: items.get(selected).map(|t| t.title.as_str()).unwrap_or(""),
            hint: "F5 nuevo · F12 lista",
            focused: true,
        }
        .render(frame, cols[1]);
        return;
    }
    draw_detail(frame, items.get(selected), cols[1]);
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
) {
    draw_chrome(frame, items, selected, sidebar_width, status, true);
    let area = terminal_area(frame.area(), sidebar_width, status);
    screen.render(frame, area);
    if let Some((x, y)) = screen.cursor_in(area) {
        frame.set_cursor_position((x, y));
    }
}

/// Opens a terminal in `cwd` and returns its pty id, so the caller can select
/// the row that is about to appear instead of guessing where it landed.
pub(super) async fn open_terminal(cwd: &str) -> std::io::Result<String> {
    let data = crate::request_data(json!({ "id": "1", "cmd": "terminal.open", "cwd": cwd })).await?;
    Ok(data.get("pty_id").and_then(Value::as_str).unwrap_or_default().to_string())
}

/// The right column while nothing is attached: what Enter would connect to,
/// and the keys that work here.
fn draw_detail(frame: &mut ratatui::Frame, current: Option<&TerminalInfo>, area: Rect) {
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
        title: "",
        hint: "↑/↓ navegar · Enter conectar · n nuevo · b plegar · Tab review · q salir",
        focused: false,
    }
    .render(frame, area);
    frame.render_widget(Paragraph::new(body), inner);
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

/// A live connection to one pty. Unlike the previous inline attach, it does
/// not own the screen or the event loop: it hands the remote bytes to the
/// caller, which feeds them to an emulator and paints them inside the panel.
pub(super) struct Session {
    pty_id: String,
    out_tx: tokio::sync::mpsc::UnboundedSender<String>,
    pub(super) output_rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    pub(super) exit_rx: tokio::sync::oneshot::Receiver<()>,
    writer: tokio::task::JoinHandle<()>,
}

impl Session {
    pub(super) async fn connect(id: &str, rows: u16, cols: u16) -> std::io::Result<Self> {
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
        let _ = out_tx.send(json!({ "cmd": "terminal.resize", "pty_id": id, "rows": rows, "cols": cols }).to_string());

        let (output_tx, output_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let mut lines = BufReader::new(read_half).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                match value.get("event").and_then(Value::as_str) {
                    Some("terminal.output") => {
                        if let Some(data) = value.get("data").and_then(Value::as_str) {
                            if output_tx.send(data.as_bytes().to_vec()).is_err() { break; }
                        }
                    }
                    Some("terminal.exit") => break,
                    _ => {}
                }
            }
            let _ = exit_tx.send(());
        });

        Ok(Self { pty_id: id.to_string(), out_tx, output_rx, exit_rx, writer })
    }

    pub(super) fn send_key(&self, key: KeyEvent) {
        let bytes = key_event_to_bytes(key);
        if bytes.is_empty() {
            return;
        }
        if let Ok(text) = String::from_utf8(bytes) {
            let _ = self
                .out_tx
                .send(json!({ "cmd": "terminal.write", "pty_id": self.pty_id, "data": text }).to_string());
        }
    }

    pub(super) fn resize(&self, rows: u16, cols: u16) {
        let _ = self
            .out_tx
            .send(json!({ "cmd": "terminal.resize", "pty_id": self.pty_id, "rows": rows, "cols": cols }).to_string());
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
        let (width, height) = (70u16, 12u16);
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| draw_list(frame, items, 0, 24, status)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..height)
            .map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
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
    fn an_empty_cwd_stays_empty_rather_than_becoming_a_lone_tilde() {
        assert_eq!(short_cwd("", 24), "");
    }

    #[test]
    fn an_absurdly_narrow_rail_does_not_underflow_the_budget() {
        assert!(!short_cwd("/tmp/bento", 2).is_empty());
    }
}
