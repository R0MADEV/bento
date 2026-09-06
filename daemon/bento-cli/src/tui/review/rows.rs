//! Cómo se pinta cada fila del panel de archivos: la del fichero, y las del

use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::ListItem;
use serde_json::Value;

use super::format::{split_rows, DiffKind, DiffRow, FileFilter, SplitRow};
use super::syntax::tokens;
use super::visible::PaneRow;
use super::{InputPurpose, ReviewState, SidebarTab};

const DIM: Style = Style::new().fg(Color::Indexed(8));

/// Pinta una fila: un fichero, o una línea del diff del que tenga abierto.
pub(super) fn pane_row_item<'a>(
    review: &ReviewState,
    row: &'a PaneRow<'a>,
    width: u16,
    index: usize,
    marks: Marks,
) -> ListItem<'a> {
    let marker = comment_marker(marks, super::visible::row_line(row), marks.selected == index);
    match row {
        PaneRow::File(file) => file_item(review, file),
        PaneRow::Diff { row, path } => ListItem::new(prefixed(marker, unified_line(row, path))),
        PaneRow::Split { row, path } => ListItem::new(prefixed(marker, split_line(row, width, path))),
        PaneRow::Comment(comment) => ListItem::new(comment_line(review, comment)),
    }
}

/// Un comentario ya puesto: quién y qué, bajo su línea. El cuerpo va en una
/// sola línea —los saltos se comen la lista— y recortado, que un comentario
/// largo taparía el diff que explica.
fn comment_line(review: &ReviewState, comment: &Value) -> Line<'static> {
    // Resuelto: la marca de siempre y todo en gris, como un fichero ya
    // revisado. Sigue estando, que un hilo cerrado también se relee.
    let settled = comment
        .get("id")
        .and_then(Value::as_u64)
        .is_some_and(|id| review.is_resolved(id));
    let who = comment
        .get("user")
        .and_then(|u| u.get("login"))
        .and_then(Value::as_str)
        .unwrap_or("?");
    let body: String = comment.get("body").and_then(Value::as_str).unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
    let (mark, name_style) = match settled {
        true => ("    ✓ ", DIM),
        false => ("    💬 ", Style::new().fg(Color::Indexed(4))),
    };
    // Cuándo se dijo: uno de hace un mes no pesa lo mismo que el de esta
    // mañana. Con el mismo formato corto que el historial de reviews.
    let when = comment
        .get("created_at")
        .and_then(Value::as_str)
        .map(super::format::short_timestamp)
        .unwrap_or_default();
    Line::from(vec![
        Span::styled(mark, DIM),
        Span::styled(format!("{who} "), name_style),
        Span::styled(format!("{when}  "), DIM),
        Span::styled(fit(&body, 80), DIM),
    ])
}

/// La fila con su marca de comentar delante, sin descolocar el resto: el hueco
/// está siempre, con signo o sin él.
fn prefixed(marker: &'static str, line: Line<'static>) -> Line<'static> {
    let mut spans = vec![Span::styled(marker, Style::new().fg(Color::Indexed(4)))];
    spans.extend(line.spans);
    Line::from(spans)
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
fn unified_line(row: &DiffRow, path: &str) -> Line<'static> {
    let gutter = match row.line {
        Some(line) => format!("  {line:>5} "),
        None => "        ".to_string(),
    };
    let mut spans = vec![Span::styled(gutter, DIM)];
    spans.extend(code_spans(&row.text, path, kind_style(row.kind)));
    Line::from(spans)
}

/// El código con sus colores encima del fondo de la línea: el verde y el rojo
/// dicen qué pasó con la línea, y el resaltado, qué dice. Un fichero se lee
/// igual que en el escritorio, que usa estas mismas palabras.
fn code_spans(text: &str, path: &str, base: Style) -> Vec<Span<'static>> {
    let Some((sign, code)) = split_sign(text) else {
        return vec![Span::styled(text.to_string(), base)];
    };
    let mut spans = vec![Span::styled(sign.to_string(), base)];
    for (colour, piece) in tokens(code, path) {
        // El fondo lo pone la línea —verde lo añadido, rojo lo quitado—; el
        // resaltado sólo cambia la letra. Sin color reconocido, la de la línea.
        let style = match colour {
            Some(colour) => base.fg(colour),
            None => base,
        };
        spans.push(Span::styled(piece, style));
    }
    spans
}

/// El `+`, el `-` o el espacio con el que empieza toda línea de un diff. La
/// cabecera de un bloque (`@@`) no lleva ninguno y se deja como está.
fn split_sign(text: &str) -> Option<(&str, &str)> {
    let first = text.chars().next()?;
    match first {
        '+' | '-' | ' ' => Some(text.split_at(1)),
        _ => None,
    }
}


/// El diff en dos columnas. La cabecera de un bloque no pertenece a ninguna de
/// las dos, así que va a lo ancho.
fn split_line(row: &SplitRow, width: u16, path: &str) -> Line<'static> {
    let is_hunk = matches!(row.left.as_ref().map(|r| r.kind), Some(DiffKind::Hunk));
    if is_hunk {
        let header = row.left.as_ref().expect("la cabecera está en los dos lados");
        return unified_line(header, path);
    }
    // Menos el separador, y menos el sangrado que alinea con el unificado.
    let half = usize::from(width.saturating_sub(5)) / 2;
    let mut spans = vec![Span::raw("    ")];
    spans.extend(half_spans(row.left.as_ref(), half, true, path));
    spans.push(Span::styled("│", DIM));
    spans.extend(half_spans(row.right.as_ref(), half, false, path));
    Line::from(spans)
}

/// Una mitad: su número de línea y su texto, recortados al ancho de la columna
/// para que un lado largo no empuje al otro fuera de la pantalla.
fn half_spans(row: Option<&DiffRow>, width: usize, old_side: bool, path: &str) -> Vec<Span<'static>> {
    let Some(row) = row else {
        return vec![Span::raw(" ".repeat(width))];
    };
    let number = if old_side { row.old } else { row.line };
    let gutter = match number {
        Some(line) => format!("{line:>5} "),
        None => "      ".to_string(),
    };
    let text = fit(&row.text, width.saturating_sub(gutter.chars().count()));
    let mut spans = vec![Span::styled(gutter, DIM)];
    spans.extend(code_spans(&text, path, kind_style(row.kind)));
    spans
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
    ("Proyectos", 'o', SidebarTab::Projects),
    ("Ramas", 'b', SidebarTab::Branches),
    ("PRs", 'p', SidebarTab::Prs),
];

pub(super) fn tabs_line(review: &ReviewState) -> Line<'static> {
    let spans = TABS
        .iter()
        .map(|(label, _, tab)| {
            let style = match review.sidebar_tab == *tab {
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

/// Los tres botones del PR, con su tecla y su color: los mismos que el
/// escritorio pone bajo la caja de comentario.
pub(super) fn pr_buttons() -> Vec<(&'static str, char, Color)> {
    vec![
        ("Enviar comentario", 'a', Color::Indexed(4)),
        ("Aprobar", 'y', Color::Green),
        ("Pedir cambios", 'n', Color::Red),
    ]
}

/// Dónde empieza y acaba cada uno, y qué tecla pide.
pub(super) fn button_ranges() -> Vec<(u16, u16, char)> {
    let mut left = 0u16;
    pr_buttons()
        .into_iter()
        .map(|(label, key, _)| {
            let width = label.chars().count() as u16 + 6;
            let range = (left, left + width, key);
            left += width + 1;
            range
        })
        .collect()
}

pub(super) fn buttons_line() -> Line<'static> {
    let spans = pr_buttons()
        .into_iter()
        .flat_map(|(label, key, color)| {
            [
                Span::styled(format!(" {label} ({key}) "), Style::new().fg(color).bg(Color::Indexed(236))),
                Span::raw(" "),
            ]
        })
        .collect::<Vec<_>>();
    Line::from(spans)
}

/// Las filas que abre un comentario en curso, bajo la línea que comenta. En el
/// escritorio la caja sale ahí mismo: abajo del todo no se ve sobre qué línea
/// estás escribiendo, que es lo que hay que tener delante al escribirlo.
pub(super) fn comment_box(review: &ReviewState) -> Vec<ListItem<'static>> {
    let Some(InputPurpose::InlineComment(line)) = review.input_purpose else {
        return Vec::new();
    };
    let what = match review.comment_range() {
        Some((first, last)) => format!("líneas {first}-{last}"),
        None => format!("línea {line}"),
    };
    let title = format!("    ╭ comentario en {what} · Enter enviar · Esc cancelar");
    vec![
        ListItem::new(Line::from(Span::styled(title, Style::new().fg(Color::Indexed(4))))),
        ListItem::new(Line::from(vec![
            Span::styled("    │ ", Style::new().fg(Color::Indexed(4))),
            Span::raw(format!("{}▏", review.input)),
        ])),
    ]
}

/// El `+` del escritorio: dice que esa línea admite comentario. Sólo con un PR
/// abierto, que es cuando hay dónde mandarlo.
/// Se calcula con lo que el dibujo ya tiene delante —la línea de esta fila y
/// el rango del frame— y no preguntándoselo otra vez al panel: cada pregunta
/// reconstruye las filas, y eso es reparsear todos los diffs abiertos por cada
/// línea que se pinta.
pub(super) fn comment_marker(marks: Marks, line: Option<u64>, selected: bool) -> &'static str {
    if !marks.has_pr {
        return "  ";
    }
    // Una franja para el bloque arrastrado, como el resaltado de GitHub: sin
    // ella no se ve hasta dónde llega lo que vas a comentar.
    if let (Some((first, last)), Some(line)) = (marks.range, line) {
        if line >= first && line <= last {
            return "┃ ";
        }
    }
    match selected && line.is_some() {
        true => "+ ",
        false => "  ",
    }
}

/// Lo que hace falta para marcar las filas, calculado una vez por frame.
#[derive(Clone, Copy)]
pub(super) struct Marks {
    pub(super) has_pr: bool,
    pub(super) range: Option<(u64, u64)>,
    pub(super) selected: usize,
}

impl Marks {
    pub(super) fn of(review: &ReviewState, rows: &[PaneRow<'_>]) -> Self {
        Self {
            has_pr: review.current_pr.is_some(),
            range: review.comment_range_in(rows),
            selected: review.files_selected,
        }
    }
}
