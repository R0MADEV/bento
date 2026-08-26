//! Rendering for the Review tab: the split-pane browser and the three
//! full-screen drill-downs (a file's diff, a PR, a running review).

use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap};
use serde_json::Value;

use super::format::short_path;
use super::super::pane::Pane;
use super::super::sidebar::{ItemStatus, Sidebar, SidebarItem};
use super::{Focus, InputPurpose, ReviewState, ReviewView, SidebarTab};

pub(crate) fn draw(frame: &mut ratatui::Frame, review: &ReviewState, sidebar_width: u16) {
    match review.view {
        ReviewView::Browse => draw_browse(frame, review, sidebar_width),
        ReviewView::FileDetail => draw_file_detail(frame, review),
        ReviewView::PrDetail => draw_pr_detail(frame, review),
        ReviewView::Output => draw_output(frame, review),
    }
}


const ERROR: Style = Style::new().fg(Color::Red);
/// Same accent the rail and the pane use for focus.
const FOCUSED: Style = Style::new().fg(Color::Indexed(4));
/// The extra passes are dimmed while compare is off — that is precisely
/// when they have no effect.
const DIM: Style = Style::new().fg(Color::DarkGray);

fn draw_browse(frame: &mut ratatui::Frame, review: &ReviewState, sidebar_width: u16) {
    let area = frame.area();
    // The same rail width as the terminal panel, so dragging it in one place
    // is not silently ignored in the other.
    let cols = Layout::horizontal([Constraint::Length(sidebar_width), Constraint::Min(1)]).split(area);
    draw_sidebar(frame, review, cols[0]);
    draw_file_browser(frame, review, cols[1]);

    if matches!(review.input_purpose, Some(InputPurpose::Context)) {
        let bottom = Layout::vertical([Constraint::Min(1), Constraint::Length(3)]).split(area)[1];
        let input = Paragraph::new(review.input.as_str()).block(
            Block::default()
                .title("Contexto para la review (Enter guardar, Esc cancelar)")
                .borders(Borders::ALL)
                .border_style(FOCUSED),
        );
        frame.render_widget(input, bottom);
        // A real cursor rather than a drawn "▏": on a tall screen the box
        // opens far from where the eye is, and without a blinking cursor it
        // reads as "nothing happened".
        let x = bottom.x + 1 + review.input.chars().count() as u16;
        frame.set_cursor_position((x.min(bottom.x + bottom.width - 2), bottom.y + 1));
    }
}

fn draw_sidebar(frame: &mut ratatui::Frame, review: &ReviewState, area: ratatui::layout::Rect) {
    let header = sidebar_header(review, area.width);
    let (title, items, selected) = sidebar_rows(review);
    Sidebar {
        header: &header,
        focused: matches!(review.focus, Focus::Sidebar),
        empty_message: "Nada que mostrar.",
        // The panel's whole point, and the migration to this component had
        // dropped the only place that said which key runs it.
        action: Some(if review.running { "■ Parar (c)" } else { "▶ Correr review (r)" }),
        ..Sidebar::new(&title, &items, selected)
    }
    .render(frame, area);
}

/// The rail's fixed context, mirroring the desktop panel's controls in its
/// order: project, base, primary agent, the compare toggle, then the two extra
/// passes it calls Secundario and Terciario.
///
/// Hit-testing counts these same lines through `header_lines`, so both come
/// from here — a click that assumes a different height selects the wrong row.
pub(crate) fn sidebar_header(review: &ReviewState, width: u16) -> Vec<Line<'static>> {
    // Dimmed while compare is off, because that is exactly when they do
    // nothing.
    let extra_style = if review.compare { Style::default() } else { DIM };
    let none = "Ninguno";
    let mut header = vec![
        Line::from(format!(
            "Proyecto: {}",
            short_path(&review.cwd, width.saturating_sub("Proyecto: ".len() as u16 + 2) as usize),
        )),
        Line::from(format!("Base: {} ← {}", review.base, review.branch.as_deref().unwrap_or("sin commitear"))),
        Line::from(format!("Agente: {} (g)", review.agent)),
        Line::from(format!("Comparar: {} (x)", on_off(review.compare))),
        Line::from(format!("  2º: {} (G)", review.secondary.as_deref().unwrap_or(none))).style(extra_style),
        Line::from(format!("  3º: {} (t)", review.tertiary.as_deref().unwrap_or(none))).style(extra_style),
        // One control per line: at the rail's default 24 columns two of them
        // sharing a line got cut off mid-word, hiding the key that works it.
        Line::from(format!("Contexto: {} (c)", if review.context.is_empty() { "no" } else { "sí" })),
        Line::from(format!(
            "Filtro: {} (/)",
            if review.search.is_empty() { "—".to_string() } else { review.search.clone() },
        )),
    ];
    if !review.status.is_empty() {
        header.push(Line::from(review.status.clone()).style(ERROR));
    }
    header.push(Line::raw(""));
    header
}

/// The rail's rows for the active tab. Each entry gets a label and the detail
/// that identifies it — the same shape every other panel's rail uses.
pub(crate) fn sidebar_rows(review: &ReviewState) -> (String, Vec<SidebarItem>, usize) {
    let row = |label: String, detail: String| SidebarItem { label, detail, status: ItemStatus::Idle };
    match review.sidebar_tab {
        SidebarTab::Projects => (
            format!("[o] PROYECTOS ({})", review.projects.len()),
            review.projects.iter().map(|p| {
                row(
                    short_path(p.get("cwd").and_then(Value::as_str).unwrap_or("?"), 18),
                    p.get("branch").and_then(Value::as_str).unwrap_or("").to_string(),
                )
            }).collect(),
            review.projects_selected,
        ),
        SidebarTab::Branches => (
            format!("[b] RAMAS ({})", review.visible_branches().len()),
            review.visible_branches().into_iter().map(|b| row(b.clone(), String::new())).collect(),
            review.branches_selected,
        ),
        SidebarTab::Prs => (
            format!("[p] PRs ({})", review.prs.len()),
            review.prs.iter().map(|pr| {
                row(
                    format!("#{} {}", pr.get("number").and_then(Value::as_u64).unwrap_or(0),
                        pr.get("title").and_then(Value::as_str).unwrap_or("")),
                    pr.get("headRefName").and_then(Value::as_str).unwrap_or("").to_string(),
                )
            }).collect(),
            review.prs_selected,
        ),
        SidebarTab::Checkpoints => (
            format!("[h] HISTORIAL ({})", review.checkpoints.len()),
            review.checkpoints.iter().map(|c| {
                row(
                    c.get("base").and_then(Value::as_str).unwrap_or("?").to_string(),
                    c.get("saved_at").and_then(Value::as_str).unwrap_or("").to_string(),
                )
            }).collect(),
            review.checkpoints_selected,
        ),
    }
}

fn on_off(v: bool) -> &'static str {
    if v { "sí" } else { "no" }
}

fn draw_file_browser(frame: &mut ratatui::Frame, review: &ReviewState, area: ratatui::layout::Rect) {
    let visible = review.visible_files();
    let items: Vec<ListItem> = if visible.is_empty() {
        vec![ListItem::new(format!("Sin archivos ({}) respecto a {}.", review.file_filter.label(), review.base))]
    } else {
        visible
            .iter()
            .map(|f| {
                let status = f.get("status").and_then(Value::as_str).unwrap_or("?");
                let path = f.get("path").and_then(Value::as_str).unwrap_or("");
                let added = f.get("added").and_then(Value::as_i64).unwrap_or(0);
                let deleted = f.get("deleted").and_then(Value::as_i64).unwrap_or(0);
                let checkbox = if review.reviewed.contains(path) { "[x]" } else { "[ ]" };
                ListItem::new(format!("{checkbox} {status}  {path}  +{added}/-{deleted}"))
            })
            .collect()
    };
    let mut state = ListState::default();
    if !visible.is_empty() {
        state.select(Some(review.files_selected));
    }
    let inner = Pane {
        title: &format!(
            "ARCHIVOS {}/{} · {} revisados",
            visible.len(), review.files.len(), review.reviewed.len(),
        ),
        hint: "f filtro · espacio marcar · Enter diff",
        focused: matches!(review.focus, Focus::Files),
    }
    .render(frame, area);
    let list = List::new(items)
        .highlight_style(Style::default().add_modifier(ratatui::style::Modifier::REVERSED));
    frame.render_stateful_widget(list, inner, &mut state);
}

fn draw_file_detail(frame: &mut ratatui::Frame, review: &ReviewState) {
    let paragraph = Paragraph::new(review.filtered(&review.file_diff))
        .wrap(Wrap { trim: false })
        .scroll((review.file_scroll, 0))
        .block(Block::default().title("↑/↓ scroll · Esc: volver").borders(Borders::ALL));
    frame.render_widget(paragraph, frame.area());
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
        let paragraph = Paragraph::new(review.filtered(&review.pr_detail))
            .wrap(Wrap { trim: false })
            .scroll((review.pr_scroll, 0))
            .block(block);
        frame.render_widget(paragraph, chunks[0]);
        let input = Paragraph::new(format!("{}▏", review.input))
            .block(Block::default().title(label).borders(Borders::ALL));
        frame.render_widget(input, chunks[1]);
    } else {
        let paragraph = Paragraph::new(review.filtered(&review.pr_detail))
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
        Some(InputPurpose::Search) => Some("Buscar en el diff (Enter aplicar, Esc cancelar)"),
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
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn screen(review: &ReviewState, width: u16, height: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| draw(frame, review, 24)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..height)
            .map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn asking_for_context_shows_the_input_box() {
        let mut review = ReviewState::new("/repo".to_string());
        review.input_purpose = Some(InputPurpose::Context);
        review.input = "revisa el manejo de errores".to_string();

        let text = screen(&review, 80, 24);
        assert!(text.contains("revisa el manejo de errores"), "no se ve lo que se escribe:\n{text}");
    }
}
