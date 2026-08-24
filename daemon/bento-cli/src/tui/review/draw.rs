//! Rendering for the Review tab: the split-pane browser and the three
//! full-screen drill-downs (a file's diff, a PR, a running review).

use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Style};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap};
use serde_json::Value;

use super::format::short_path;
use super::{Focus, InputPurpose, ReviewState, ReviewView, SidebarTab};

pub(crate) fn draw(frame: &mut ratatui::Frame, review: &ReviewState) {
    match review.view {
        ReviewView::Browse => draw_browse(frame, review),
        ReviewView::FileDetail => draw_file_detail(frame, review),
        ReviewView::PrDetail => draw_pr_detail(frame, review),
        ReviewView::Output => draw_output(frame, review),
    }
}

const FOCUSED: Style = Style::new().fg(Color::Yellow);
const ERROR: Style = Style::new().fg(Color::Red);

fn draw_browse(frame: &mut ratatui::Frame, review: &ReviewState) {
    let area = frame.area();
    let cols = Layout::horizontal([Constraint::Percentage(35), Constraint::Percentage(65)]).split(area);
    draw_sidebar(frame, review, cols[0]);
    draw_file_browser(frame, review, cols[1]);

    if matches!(review.input_purpose, Some(InputPurpose::Context)) {
        let bottom = Layout::vertical([Constraint::Min(1), Constraint::Length(3)]).split(area)[1];
        let input = Paragraph::new(format!("{}▏", review.input))
            .block(Block::default().title("Contexto para la review (Enter guardar, Esc cancelar)").borders(Borders::ALL));
        frame.render_widget(input, bottom);
    }
}

fn draw_sidebar(frame: &mut ratatui::Frame, review: &ReviewState, area: ratatui::layout::Rect) {
    let agent_line = if review.compare {
        "Agente: comparar todos (claude+codex+opencode)".to_string()
    } else {
        format!("Agente: {} (g cambia)", review.agent)
    };
    let compare_line = format!("Comparar: {} (x)  Contexto: {} (c)", on_off(review.compare), if review.context.is_empty() { "no" } else { "sí" });
    let mut lines = vec![
        ratatui::text::Line::from(format!(
            "Proyecto: {} (o cambia)",
            short_path(&review.cwd, area.width.saturating_sub("Proyecto:  (o cambia)".len() as u16 + 2) as usize),
        )),
        ratatui::text::Line::from(format!(
            "Base: {}  ←  {}",
            review.base,
            review.branch.as_deref().unwrap_or("cambios sin commitear"),
        )),
        ratatui::text::Line::from(agent_line),
        ratatui::text::Line::from(compare_line),
    ];
    if !review.status.is_empty() {
        lines.push(ratatui::text::Line::from(review.status.as_str()).style(ERROR));
    }
    // Sized to the lines it holds (+2 borders): a fixed height silently
    // clipped the agent/compare lines once "Proyecto" was added.
    let rows = Layout::vertical([Constraint::Length(lines.len() as u16 + 2), Constraint::Min(1)]).split(area);
    let header = Paragraph::new(lines)
        .block(Block::default().title("Tech Review — r: correr · F5: refrescar").borders(Borders::ALL));
    frame.render_widget(header, rows[0]);

    let border_style = if matches!(review.focus, Focus::Sidebar) { FOCUSED } else { Style::default() };
    let (title, items, selected): (String, Vec<ListItem>, usize) = match review.sidebar_tab {
        SidebarTab::Projects => (
            format!("[o] Proyectos ({}) · b ramas · p PRs · h historial", review.projects.len()),
            if review.projects.is_empty() {
                vec![ListItem::new("Sin otros proyectos abiertos.")]
            } else {
                review.projects.iter().map(|p| {
                    let cwd = p.get("cwd").and_then(Value::as_str).unwrap_or("?");
                    let branch = p.get("branch").and_then(Value::as_str).unwrap_or("");
                    ListItem::new(format!("{cwd}  ({branch})"))
                }).collect()
            },
            review.projects_selected,
        ),
        SidebarTab::Branches => (
            format!("o proyectos · [b] Ramas ({}) · v: revisar rama · p PRs · h historial", review.branches.len()),
            review.branches.iter().map(|b| ListItem::new(b.as_str())).collect(),
            review.branches_selected,
        ),
        SidebarTab::Prs => (
            format!("o proyectos · b ramas · [p] PRs ({}) · h historial", review.prs.len()),
            if review.prs.is_empty() {
                vec![ListItem::new("No hay PRs abiertos.")]
            } else {
                review.prs.iter().map(|pr| {
                    let number = pr.get("number").and_then(Value::as_u64).unwrap_or(0);
                    let title = pr.get("title").and_then(Value::as_str).unwrap_or("");
                    let branch = pr.get("headRefName").and_then(Value::as_str).unwrap_or("");
                    ListItem::new(format!("#{number}  {title}  ({branch})"))
                }).collect()
            },
            review.prs_selected,
        ),
        SidebarTab::Checkpoints => (
            format!("o proyectos · b ramas · p PRs · [h] historial ({}, d borra)", review.checkpoints.len()),
            if review.checkpoints.is_empty() {
                vec![ListItem::new("Sin reviews guardadas.")]
            } else {
                review.checkpoints.iter().map(|c| {
                    let base = c.get("base").and_then(Value::as_str).unwrap_or("?");
                    let saved_at = c.get("saved_at").and_then(Value::as_str).unwrap_or("");
                    ListItem::new(format!("{base}  ({saved_at})"))
                }).collect()
            },
            review.checkpoints_selected,
        ),
    };
    let mut state = ListState::default();
    if !items.is_empty() {
        state.select(Some(selected));
    }
    let list = List::new(items)
        .block(Block::default().title(title).borders(Borders::ALL).border_style(border_style))
        .highlight_style(Style::default().add_modifier(ratatui::style::Modifier::REVERSED));
    frame.render_stateful_widget(list, rows[1], &mut state);
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
    let border_style = if matches!(review.focus, Focus::Files) { FOCUSED } else { Style::default() };
    let title = format!(
        "Archivos — {}/{} · filtro: {} (f) · {}/{} revisados · espacio: marcar · Enter: diff",
        visible.len(), review.files.len(), review.file_filter.label(), review.reviewed.len(), review.files.len(),
    );
    let list = List::new(items)
        .block(Block::default().title(title).borders(Borders::ALL).border_style(border_style))
        .highlight_style(Style::default().add_modifier(ratatui::style::Modifier::REVERSED));
    frame.render_stateful_widget(list, area, &mut state);
}

fn draw_file_detail(frame: &mut ratatui::Frame, review: &ReviewState) {
    let paragraph = Paragraph::new(review.file_diff.as_str())
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
