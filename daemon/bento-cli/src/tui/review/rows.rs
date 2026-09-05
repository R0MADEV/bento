//! Cómo se pinta cada fila del panel de archivos: la del fichero, y las del
//! diff que tenga desplegado — a lo ancho, o en dos columnas.

use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::ListItem;
use serde_json::Value;

use super::format::{split_rows, DiffKind, DiffRow, FileFilter, SplitRow};
use super::visible::PaneRow;
use super::{ReviewState, SidebarTab};

const DIM: Style = Style::new().fg(Color::Indexed(8));

/// Pinta una fila: un fichero, o una línea del diff del que tenga abierto.
pub(super) fn pane_row_item<'a>(review: &ReviewState, row: &'a PaneRow<'a>, width: u16) -> ListItem<'a> {
    match row {
        PaneRow::File(file) => file_item(review, file),
        PaneRow::Diff { row, .. } => ListItem::new(unified_line(row)),
        PaneRow::Split { row, .. } => ListItem::new(split_line(row, width)),
    }
}

fn file_item<'a>(review: &ReviewState, file: &'a Value) -> ListItem<'a> {
    let status = file.get("status").and_then(Value::as_str).unwrap_or("?");
    let path = file.get("path").and_then(Value::as_str).unwrap_or("");
    let added = file.get("added").and_then(Value::as_i64).unwrap_or(0);
    let deleted = file.get("deleted").and_then(Value::as_i64).unwrap_or(0);
    let checkbox = if review.reviewed.contains(path) { "[x]" } else { "[ ]" };
    // El triángulo dice si el diff está desplegado, que es lo único que
    // distingue una fila abierta de una cerrada cuando el diff queda fuera de
    // pantalla.
    let caret = if review.is_expanded(path) { "▾" } else { "▸" };
    ListItem::new(format!("{caret} {checkbox} {status}  {path}  +{added}/-{deleted}"))
}

/// El color de una línea según lo que le pasó. Fondo además de letra: es lo
/// que deja ver de un vistazo dónde empieza y acaba un bloque sin leer el
/// primer carácter de cada línea.
fn kind_style(kind: DiffKind) -> Style {
    match kind {
        DiffKind::Added => Style::new().fg(Color::Green).bg(Color::Indexed(22)),
        DiffKind::Removed => Style::new().fg(Color::Red).bg(Color::Indexed(52)),
        DiffKind::Hunk => Style::new().fg(Color::Indexed(4)),
        DiffKind::Context => Style::default(),
    }
}

/// El diff a lo ancho, sangrado bajo su fichero y con el número de la línea
/// nueva.
fn unified_line(row: &DiffRow) -> Line<'static> {
    let gutter = match row.line {
        Some(line) => format!("    {line:>5} "),
        None => "          ".to_string(),
    };
    Line::from(vec![
        Span::styled(gutter, DIM),
        Span::styled(row.text.clone(), kind_style(row.kind)),
    ])
}

/// El diff en dos columnas. La cabecera de un bloque no pertenece a ninguna de
/// las dos, así que va a lo ancho.
fn split_line(row: &SplitRow, width: u16) -> Line<'static> {
    let is_hunk = matches!(row.left.as_ref().map(|r| r.kind), Some(DiffKind::Hunk));
    if is_hunk {
        return unified_line(row.left.as_ref().expect("la cabecera está en los dos lados"));
    }
    // Menos el separador, y menos el sangrado que alinea con el unificado.
    let half = usize::from(width.saturating_sub(5)) / 2;
    let mut spans = vec![Span::raw("    ")];
    spans.extend(half_spans(row.left.as_ref(), half, true));
    spans.push(Span::styled("│", DIM));
    spans.extend(half_spans(row.right.as_ref(), half, false));
    Line::from(spans)
}

/// Una mitad: su número de línea y su texto, recortados al ancho de la columna
/// para que un lado largo no empuje al otro fuera de la pantalla.
fn half_spans(row: Option<&DiffRow>, width: usize, old_side: bool) -> Vec<Span<'static>> {
    let Some(row) = row else {
        return vec![Span::raw(" ".repeat(width))];
    };
    let number = if old_side { row.old } else { row.line };
    let gutter = match number {
        Some(line) => format!("{line:>5} "),
        None => "      ".to_string(),
    };
    let text = fit(&row.text, width.saturating_sub(gutter.chars().count()));
    vec![Span::styled(gutter, DIM), Span::styled(text, kind_style(row.kind))]
}

/// El texto en exactamente `width` columnas: cortado si sobra, rellenado si
/// falta — el relleno es lo que pinta el fondo de la línea hasta el borde.
fn fit(text: &str, width: usize) -> String {
    let mut out: String = text.chars().take(width).collect();
    let painted = out.chars().count();
    out.extend(std::iter::repeat_n(' ', width.saturating_sub(painted)));
    out
}

/// Las filas del diff de un fichero, en el modo que esté puesto.
pub(super) fn diff_pane_rows(state: &ReviewState, path: &str, diff: &str) -> Vec<PaneRow<'static>> {
    let rows = super::format::diff_rows(diff);
    match state.split {
        true => split_rows(rows)
            .into_iter()
            .map(|row| PaneRow::Split { path: path.to_string(), row })
            .collect(),
        false => rows
            .into_iter()
            .map(|row| PaneRow::Diff { path: path.to_string(), row })
            .collect(),
    }
}

/// La barra de encima de la lista: la búsqueda y los cuatro filtros con su
/// recuento, como el escritorio. `f` cambiaba de filtro sin decir cuántos
/// ficheros había de cada tipo ni si quedaba una búsqueda puesta.
pub(super) fn filter_bar(review: &ReviewState) -> Line<'static> {
    let mut spans = vec![Span::styled("Buscar (F3): ", DIM)];
    match review.file_search.is_empty() {
        true => spans.push(Span::styled("todos", DIM)),
        false => spans.push(Span::styled(review.file_search.clone(), Style::new().fg(Color::Yellow))),
    }
    spans.push(Span::styled("  ·  ", DIM));
    for (filter, count) in review.filter_counts() {
        spans.push(chip(filter, count, filter == review.file_filter));
        spans.push(Span::raw(" "));
    }
    spans.push(Span::styled("(f)", DIM));
    Line::from(spans)
}

/// Dónde empieza y acaba cada chip en la barra, midiendo lo mismo que se
/// pinta: llevan el recuento dentro, así que su ancho cambia y una tabla de
/// posiciones fijas señalaría al de al lado.
pub(super) fn chip_ranges(review: &ReviewState) -> Vec<(u16, u16)> {
    let search = match review.file_search.is_empty() {
        true => "todos".to_string(),
        false => review.file_search.clone(),
    };
    // En caracteres, no en bytes: el `·` de la barra ocupa dos, y contarlo
    // como dos columnas señalaba al chip de al lado.
    let prefix = "Buscar (F3): ".chars().count() + "  ·  ".chars().count();
    let mut left = (prefix + search.chars().count()) as u16;
    let mut ranges = Vec::new();
    for (filter, count) in review.filter_counts() {
        let width = chip_text(filter, count).chars().count() as u16;
        ranges.push((left, left + width));
        left += width + 1;
    }
    ranges
}

fn chip_text(filter: FileFilter, count: usize) -> String {
    match filter {
        FileFilter::All => format!(" Todos {count} "),
        FileFilter::Added => format!(" +{count} nuevos "),
        FileFilter::Modified => format!(" ~{count} modificados "),
        FileFilter::Deleted => format!(" -{count} borrados "),
    }
}

/// Un filtro con su recuento. El puesto va en vídeo inverso: en un terminal
/// sin ratón es lo único que dice cuál de los cuatro está actuando.
fn chip(filter: FileFilter, count: usize, active: bool) -> Span<'static> {
    let text = chip_text(filter, count);
    let style = match active {
        true => Style::new().add_modifier(ratatui::style::Modifier::REVERSED),
        false => DIM,
    };
    Span::styled(text, style)
}

/// Las tres pestañas del raíl, con la tecla que abre cada una. El escritorio
/// las tiene como pestañas; aquí eran una línea de ayuda que no decía cuál
/// estabas mirando.
pub(super) const TABS: [(&str, char, SidebarTab); 3] = [
    ("Ramas", 'b', SidebarTab::Branches),
    ("PRs", 'p', SidebarTab::Prs),
    ("Reviews", 'h', SidebarTab::Branches),
];

pub(super) fn tabs_line(review: &ReviewState) -> Line<'static> {
    let spans = TABS
        .iter()
        .map(|(label, _, tab)| {
            // Las reviews no son una pestaña del raíl sino el cajón, así que
            // se marca cuando está abierto y no por la pestaña que haya.
            let open = match *label {
                "Reviews" => review.showing_history,
                _ => !review.showing_history && review.sidebar_tab == *tab,
            };
            let style = match open {
                true => Style::new().add_modifier(ratatui::style::Modifier::REVERSED),
                false => DIM,
            };
            Span::styled(format!(" {label} "), style)
        })
        .collect::<Vec<_>>();
    Line::from(spans)
}

/// Dónde empieza y acaba cada pestaña, y qué tecla pide. Medido de las mismas
/// etiquetas que se pintan.
pub(super) fn tab_ranges() -> Vec<(u16, u16, char)> {
    let mut left = 0u16;
    TABS.iter()
        .map(|(label, key, _)| {
            let width = label.chars().count() as u16 + 2;
            let range = (left, left + width, *key);
            left += width;
            range
        })
        .collect()
}
