//! Rendering for the Review tab: the split-pane browser and the three

use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, List, ListItem, ListState, Paragraph};
use serde_json::Value;

use super::format::{checkpoint_row, short_path};
use super::super::drawer::{Drawer, History};
use super::super::pane::Pane;
use super::super::sidebar::{ItemStatus, Sidebar, SidebarItem};
use super::rows::{filter_bar, pane_row_item};
use super::{Focus, InputPurpose, ReviewState, SidebarTab};

pub(crate) fn draw(frame: &mut ratatui::Frame, review: &ReviewState, sidebar_width: u16, resizing: bool) {
    draw_browse(frame, review, sidebar_width, resizing);
}


const ERROR: Style = Style::new().fg(Color::Red);
/// Same accent the rail and the pane use for focus.
const FOCUSED: Style = Style::new().fg(Color::Indexed(4));
/// The extra passes are dimmed while compare is off — that is precisely
/// when they have no effect.
const DIM: Style = Style::new().fg(Color::DarkGray);

fn draw_browse(frame: &mut ratatui::Frame, review: &ReviewState, sidebar_width: u16, resizing: bool) {
    // El cuadro de texto se queda con las tres últimas líneas en vez de
    // pintarse encima: como capa tapaba las últimas filas de la lista y la
    // franja del PR, que es justo lo que estás mirando al comentar.
    let [area, bottom] = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(input_height(review)),
    ])
    .areas(frame.area());
    // Three columns: what you can pick, what you picked, and the report about
    // it. The drawer only takes width when there is something in it — running
    // a review no longer replaces the panel with a full-screen view.
    // Driven by the flag, not by whether there is text: a run that ends with
    // nothing still has an error worth reading.
    let drawer_width = if review.drawer_open { review.drawer_width } else { 0 };
    let cols = Layout::horizontal([
        Constraint::Length(sidebar_width),
        Constraint::Min(1),
        Constraint::Length(drawer_width),
    ])
    .split(area);
    draw_sidebar(frame, review, cols[0]);
    draw_file_browser(frame, review, cols[1], resizing);
    if drawer_width > 0 && review.showing_history {
        // The history lives where the report does, so picking which review to
        // read is one column, not a trip to the rail. Drawn with the drawer's
        // own chrome, not the rail's: this column folds to the right.
        let rows: Vec<String> = review.checkpoints.iter().map(checkpoint_row).collect();
        History {
            rows: &rows,
            selected: review.checkpoints_selected,
            focused: matches!(review.focus, Focus::Drawer),
            empty_message: "Sin reviews guardadas.",
        }
        .render(frame, cols[2]);
    } else if drawer_width > 0 {
        let title = review.drawer_title();
        let hint = match (review.running, review.current_pr.is_some()) {
            (true, _) => "c parar · w plegar",
            (false, true) => "a comentar · y aprobar · n pedir cambios · w plegar",
            (false, false) => "↑/↓ scroll · a preguntar · w plegar",
        };
        Drawer {
            title: &title,
            hint,
            body: review.drawer_body(),
            scroll: review.scroll,
            focused: matches!(review.focus, Focus::Drawer),
        }
        .render(frame, cols[2]);
    }

    // Cualquier cuadro de texto abierto se pinta. Solo se pintaba el del
    // contexto, así que al abrir el buscador las teclas se iban a un campo
    // invisible: ni cursor, ni caja, ni las flechas moviendo nada. Se ve
    // exactamente igual que un panel colgado.
    // El PR abierto tiene su caja aunque no estés escribiendo todavía: la de
    // abajo del escritorio, con sus botones convertidos en teclas.
    // Con un PR abierto, los botones se llevan la última línea: son los del
    // escritorio, con su tecla escrita y pulsables como todo lo demás.
    let [bottom, buttons] = Layout::vertical([
        Constraint::Min(0),
        Constraint::Length(u16::from(review.current_pr.is_some())),
    ])
    .areas(bottom);
    if review.current_pr.is_some() {
        frame.render_widget(Paragraph::new(super::rows::buttons_line()), buttons);
    }
    let Some(label) = browse_input_label(review) else {
        if review.current_pr.is_some() {
            let waiting = Paragraph::new(Line::from("Deja un comentario de revisión en el PR…").style(DIM))
                .block(pane_block("Comentario de revisión (m para la review entera)"));
            frame.render_widget(waiting, bottom);
        }
        return;
    };
    {
        let input = Paragraph::new(review.input.as_str())
            .block(pane_block(label).border_style(FOCUSED));
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
        // Navegando carpetas el botón explica ese gesto: es donde se mira
        // mientras se elige, y en 24 columnas la cabecera no cabe.
        action: Some(match (review.running, &review.sidebar_tab) {
            (true, _) => "■ Parar (c)",
            (false, SidebarTab::Projects) => "Enter entra · espacio elige ●",
            (false, SidebarTab::Branches) => "Enter revisa la rama · espacio la usa de base",
            (false, _) => "▶ Correr review (r)",
        }),
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
/// En qué línea de la cabecera van las pestañas. El clic las mide por columna
/// —cada una es su propia zona—, así que necesita saber su fila.
pub(crate) const TABS_ROW: usize = 10;

pub(crate) fn sidebar_header(review: &ReviewState, width: u16) -> Vec<Line<'static>> {
    // Dimmed while compare is off, because that is exactly when they do
    // nothing.
    let extra_style = if review.compare { Style::default() } else { DIM };
    let none = "Ninguno";
    let mut header = vec![
        // Cada línea con su tecla: sin ellas no hay forma de saber que el
        // proyecto y la base se cambian, y son lo primero que hay que cambiar.
        Line::from(format!(
            "Proyecto: {} (o)",
            short_path(&review.cwd, width.saturating_sub("Proyecto:  (o)".len() as u16 + 2) as usize),
        )),
        // En dos líneas: juntas no caben en las veinticuatro columnas por
        // defecto del raíl y se comían la tecla del final.
        Line::from(format!("Base: {} (b)", review.base)),
        Line::from(format!(
            "Rama: {} (v)",
            review.branch.as_deref().unwrap_or("sin commitear"),
        )),
        Line::from(format!("Agente: {} (g)", review.agent)),
        // Casilla en vez de "sí/no", como el checkbox del escritorio: se ve
        // marcada de un vistazo sin leer la palabra.
        Line::from(format!("[{}] Comparar agentes (x)", if review.compare { "x" } else { " " })),
        Line::from(format!("  2º: {} (G)", review.secondary.as_deref().unwrap_or(none))).style(extra_style),
        Line::from(format!("  3º: {} (t)", review.tertiary.as_deref().unwrap_or(none))).style(extra_style),
        // One control per line: at the rail's default 24 columns two of them
        // sharing a line got cut off mid-word, hiding the key that works it.
        Line::from(format!("Contexto: {} (c)", if review.context.is_empty() { "no" } else { "sí" })),
        Line::from(format!(
            "Filtro: {} (F3)",
            if review.search.is_empty() { "—".to_string() } else { review.search.clone() },
        )),
        // El historial no es una pestaña del raíl sino el cajón de la
        // derecha: marcarlo entre las pestañas decía "Reviews" mientras
        // estabas mirando los PRs.
        Line::from(format!(
            "Reviews: {} (h)",
            if review.showing_history { "abiertas" } else { "ver" },
        )),
        super::rows::tabs_line(review),
    ];
    if review.loading {
        header.push(Line::from("Cargando…").style(FOCUSED));
    }
    if !review.status.is_empty() {
        // Un error de gh no cabe en las veinticuatro columnas del raíl, y
        // cortado sólo se lee el principio, que es la parte que menos dice.
        header.extend(wrapped(&review.status, width).into_iter().map(|l| Line::from(l).style(ERROR)));
    }
    header.push(Line::raw(""));
    header
}

/// El texto partido por palabras en líneas de `width` columnas. Una palabra
/// más larga que el raíl se parte donde toque: peor es no verla.
fn wrapped(text: &str, width: u16) -> Vec<String> {
    let width = usize::from(width).max(1);
    let mut lines = vec![String::new()];
    for word in text.split_whitespace() {
        let line = lines.last_mut().expect("siempre hay una");
        let fits = line.chars().count() + 1 + word.chars().count() <= width;
        if line.is_empty() || fits {
            if !line.is_empty() {
                line.push(' ');
            }
            line.push_str(word);
            continue;
        }
        lines.push(word.to_string());
    }
    // Una palabra sola más ancha que el raíl se trocea al final, ya colocada.
    lines
        .into_iter()
        .flat_map(|line| {
            line.chars()
                .collect::<Vec<_>>()
                .chunks(width)
                .map(|chunk| chunk.iter().collect::<String>())
                .collect::<Vec<_>>()
        })
        .collect()
}

/// The rail's rows for the active tab. Each entry gets a label and the detail
/// that identifies it — the same shape every other panel's rail uses.
pub(crate) fn sidebar_rows(review: &ReviewState) -> (String, Vec<SidebarItem>, usize) {
    let row = |label: String, detail: String| SidebarItem { label, detail, status: ItemStatus::Idle };
    match review.sidebar_tab {
        SidebarTab::Projects => (
            format!("[o] {}", short_path(&review.browse_path.display().to_string(), 18)),
            // El punto verde marca las que son repositorios: elegir una que no
            // lo es no lleva a ninguna parte, y así se ve antes de intentarlo.
            review.browse_dirs.iter().map(|name| SidebarItem {
                label: name.clone(),
                detail: String::new(),
                status: match crate::tui::review::format::is_repo(&review.browse_path.join(name)) {
                    true => ItemStatus::Active,
                    false => ItemStatus::Idle,
                },
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
    }
}

/// A framed box in the panel's own style, for the places that need a `Block`
/// rather than `Pane`'s inner area — an input, or a paragraph that scrolls.
/// Square, undimmed borders here read as a different application.
fn pane_block(title: &str) -> Block<'static> {
    Block::default()
        .title(Line::from(Span::styled(format!(" {title} "), DIM)))
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(DIM)
}

fn draw_file_browser(frame: &mut ratatui::Frame, review: &ReviewState, area: ratatui::layout::Rect, resizing: bool) {
    // El ancho de dentro del marco: las dos columnas se reparten eso.
    let inner_width = area.width.saturating_sub(2);
    let visible = review.visible_files();
    let total = review.pane_rows_len();
    let inner = Pane {
        title: &format!(
            "ARCHIVOS {}/{} · {} revisados",
            visible.len(), review.files.len(), review.reviewed.len(),
        ),
        // En modo tamaño el pie dice qué hacen las flechas, porque dejan de
        // mover la selección.
        hint: match (resizing, review.selected_comment().is_some()) {
            (true, _) => "MODO TAMAÑO · ←/→ raíl · ↑/↓ informe · s o Esc salir",
            // Sobre un comentario, lo que se puede hacer con él: son los
            // botones que el escritorio pone al lado de la burbuja.
            (false, true) => "Enter responder · e editar · d borrar · espacio resolver",
            (false, false) => "Enter despliega · 2 columnas · arrastra o + para comentar · espacio marcar · f estado · F3 buscar",
        },
        focused: matches!(review.focus, Focus::Files),
    }
    .render(frame, area);
    // La barra se queda con la primera línea de dentro del marco y, con un PR
    // abierto, su franja con la última: el título y la CI van debajo de los
    // archivos, como en el escritorio, y no en una columna que los tape.
    let strip = u16::from(!review.pr_summary.is_empty());
    let [bar, rest, pr] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(strip),
    ])
    .areas(inner);
    frame.render_widget(Paragraph::new(filter_bar(review)), bar);

    // Sólo se arman las filas que caben en pantalla. Se armaban todas: con los
    // sesenta y seis ficheros abiertos son trece mil, de las que se ven
    // cuarenta, y cada una lleva su resaltado — el desplazamiento iba a
    // tirones porque cada tecla repintaba el diff entero.
    let height = super::mouse::list_height(review, area);
    let first = review.scroll_offset(review.files_selected, height, total);
    // Sólo las que caben: armarlas copia cada línea de cada diff abierto.
    let rows = review.pane_rows_window(first, height);
    // Guardada para el ratón: traducir una fila de la pantalla a una de la
    // lista necesita saber por dónde empieza lo que se ve.
    review.files_offset.set(first);
    let items: Vec<ListItem> = match rows.is_empty() {
        true => vec![ListItem::new(format!("Sin archivos ({}) respecto a {}.", review.file_filter.label(), review.base))],
        false => {
            // Una vez por frame, no una por fila: preguntarlo por fila
            // reconstruye las filas cada vez.
            let marks = super::rows::Marks::of(review);
            rows
                .iter()
                .enumerate()
                .flat_map(|(offset, row)| {
                    let index = first + offset;
                    let mut items = vec![pane_row_item(review, row, inner_width, index, marks)];
                    if index == review.files_selected {
                        items.extend(super::rows::comment_box(review));
                    }
                    items
                })
                .collect()
        }
    };
    let mut state = ListState::default();
    if !rows.is_empty() {
        state.select(Some(review.files_selected.saturating_sub(first)));
    }
    let list = List::new(items)
        .highlight_style(Style::default().add_modifier(ratatui::style::Modifier::REVERSED));
    frame.render_stateful_widget(list, rest, &mut state);
    if strip > 0 {
        // Lo último que ha pasado con el PR gana a su ficha: enviar algo y no
        // ver nada es no saber si ha salido, y así un fallo pasa inadvertido.
        let (text, style) = match review.pr_status.is_empty() {
            true => (review.pr_summary.clone(), FOCUSED),
            false => (review.pr_status.clone(), ERROR),
        };
        frame.render_widget(Paragraph::new(Line::from(text).style(style)), pr);
    }
}


/// Qué cuadro está abierto en la vista principal, si hay alguno.
/// Las líneas que se lleva el cuadro de texto. Con un PR abierto está puesto
/// desde el principio, como la caja de comentario del escritorio: si sólo
/// apareciera al pulsar, no habría forma de saber que se puede comentar.
pub(super) fn input_height(review: &ReviewState) -> u16 {
    let box_lines = u16::from(browse_input_label(review).is_some() || review.current_pr.is_some());
    // Y una línea más para los botones, que sólo tiene el PR.
    let buttons = u16::from(review.current_pr.is_some());
    box_lines * 3 + buttons
}

/// Qué dice el cuadro de texto abierto. Sin él, las teclas se van a un campo
/// invisible y el panel se lee como colgado.
fn browse_input_label(review: &ReviewState) -> Option<&'static str> {
    match review.input_purpose {
        Some(InputPurpose::Context) => Some("Contexto para la review (Enter guardar, Esc cancelar)"),
        Some(InputPurpose::Search) => Some("Filtrar ramas (Enter aplicar, Esc cancelar)"),
        Some(InputPurpose::FileSearch) => Some("Buscar archivos (Enter aplicar, Esc cancelar)"),
        Some(InputPurpose::Ask) => Some("Pregunta sobre la review (Enter enviar, Esc cancelar)"),
        Some(InputPurpose::PrComment) => Some("Comentario en el PR (Enter enviar, Esc cancelar)"),
        Some(InputPurpose::PrReview("APPROVE")) => Some("Aprobar — texto opcional (Enter enviar, Esc cancelar)"),
        Some(InputPurpose::PrReview("REQUEST_CHANGES")) => Some("Pedir cambios — texto (Enter enviar, Esc cancelar)"),
        Some(InputPurpose::PrReview(_)) => Some("Comentario de review (Enter enviar, Esc cancelar)"),
        // El comentario de una línea tiene su caja bajo la línea, dentro del
        // diff: aquí abajo saldría por duplicado.
        Some(InputPurpose::InlineComment(_)) => None,
        Some(InputPurpose::CommentReply(_)) => Some("Responder al comentario (Enter enviar, Esc cancelar)"),
        Some(InputPurpose::CommentEdit(_)) => Some("Corregir el comentario (Enter guardar, Esc cancelar)"),
        None => None,
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    /// La pantalla ya pintada, en texto. La usan también las pruebas del
    /// panel: comprobar contra lo que se pinta es lo único que ve un descuadre.
    pub(in crate::tui::review) fn screen(review: &ReviewState, width: u16, height: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| draw(frame, review, 24, false)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..height)
            .map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn a_request_in_flight_says_so_instead_of_looking_frozen() {
        // The panel awaits daemon calls on its event loop, so a slow one (PRs
        // shell out to `gh`) stops redrawing and stops taking keys. It cannot
        // be interrupted, but it can at least say what it is doing rather
        // than looking like it died.
        let mut review = ReviewState::new("/repo".to_string());
        review.loading = true;

        assert!(screen(&review, 80, 24).to_lowercase().contains("cargando"));
    }

    #[test]
    fn an_idle_panel_does_not_claim_to_be_loading() {
        let review = ReviewState::new("/repo".to_string());
        assert!(!screen(&review, 80, 24).to_lowercase().contains("cargando"));
    }

    #[test]
    fn asking_for_context_shows_the_input_box() {
        let mut review = ReviewState::new("/repo".to_string());
        review.input_purpose = Some(InputPurpose::Context);
        review.input = "revisa el manejo de errores".to_string();

        let text = screen(&review, 80, 24);
        assert!(text.contains("revisa el manejo de errores"), "no se ve lo que se escribe:\n{text}");
    }


    #[test]
    fn the_search_box_is_painted_so_the_panel_does_not_look_frozen() {
        // Sin caja ni cursor, las teclas se van a un campo invisible y el panel
        // se lee como colgado: fue exactamente lo que pasó.
        let mut review = ReviewState::new("/repo".to_string());
        review.input_purpose = Some(InputPurpose::FileSearch);
        review.input = "engine".to_string();

        let text = screen(&review, 80, 24);

        assert!(text.contains("Buscar archivos"), "{text}");
        assert!(text.contains("engine"), "y lo que llevas escrito: {text}");
    }

    #[test]
    fn approving_a_pr_paints_its_box_in_the_panel() {
        // Aprobar y pedir cambios se hacían en una pantalla aparte que ya no
        // existe: si su cuadro no se pinta aquí, la tecla no hace nada visible.
        let mut review = ReviewState::new("/repo".to_string());
        review.current_pr = Some(291);
        review.input_purpose = Some(InputPurpose::PrReview("APPROVE"));

        let text = screen(&review, 80, 24);

        assert!(text.contains("Aprobar"), "{text}");
    }
}
