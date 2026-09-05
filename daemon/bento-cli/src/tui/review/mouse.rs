//! El panel de archivos visto desde el ratón: en qué chip o en qué fila cayó
//! un clic. El raíl y el cajón ya se manejaban con el ratón; esto es lo que
//! faltaba para que el panel se use como el del escritorio.

use ratatui::layout::Rect;

use crossterm::event::{Event, MouseButton, MouseEvent, MouseEventKind};

use super::format::key_in;
use super::{FileFilter, ReviewState};

/// Dónde cayó un clic dentro del panel de archivos.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum FileClick {
    /// Uno de los cuatro filtros, por su posición en la barra.
    Chip(usize),
    /// Una fila de la lista, contando desde la primera que se ve.
    Row(usize),
}

/// La primera línea de dentro del marco es la barra de filtros; la lista
/// empieza justo debajo.
const BAR_ROW: u16 = 1;

pub(super) fn file_click(review: &ReviewState, column: u16, row: u16, area: Rect) -> Option<FileClick> {
    let inside = column > area.x && column < area.x + area.width - 1;
    if !inside || row < BAR_ROW || row + 1 >= area.y + area.height {
        return None;
    }
    if row == BAR_ROW {
        return chip_at(review, column - area.x - 1).map(FileClick::Chip);
    }
    Some(FileClick::Row(usize::from(row - BAR_ROW - 1)))
}

/// En qué chip cae una columna de la barra. Las etiquetas llevan el recuento,
/// así que su ancho cambia: se miden como se pintan, no con posiciones fijas.
fn chip_at(review: &ReviewState, column: u16) -> Option<usize> {
    super::rows::chip_ranges(review)
        .into_iter()
        .position(|(start, end)| column >= start && column < end)
}

/// Qué pestaña pide un clic en esa columna de su fila.
fn tab_key_at(column: u16) -> Option<char> {
    super::rows::tab_ranges()
        .into_iter()
        .find(|(start, end, _)| column >= *start && column < *end)
        .map(|(_, _, key)| key)
}

/// La primera fila que se ve de una lista de alto `height` con `selected`
/// marcada. La lista se desplaza sola para no perderla de vista, así que la
/// fila de arriba deja de ser la primera del listado.
pub(super) fn visible_offset(selected: usize, height: usize) -> usize {
    selected.saturating_sub(height.saturating_sub(1))
}

impl ReviewState {
    /// El hueco que ocupa el panel de archivos: entre el raíl y el informe.
    /// Lo mismo que reparte `draw_browse`, que si no el clic cae donde no es.
    pub(in crate::tui) fn files_area(&self, total: u16, height: u16, sidebar_width: u16) -> Rect {
        let drawer = if self.drawer_open { self.drawer_width } else { 0 };
        let width = total.saturating_sub(sidebar_width).saturating_sub(drawer);
        Rect::new(sidebar_width, 0, width, height)
    }

    /// La tecla que pide un clic sobre las opciones del raíl, si cayó en una.
    pub(in crate::tui) fn header_key_at(&self, mouse: MouseEvent, sidebar_width: u16) -> Option<crossterm::event::KeyCode> {
        if !matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) || mouse.column >= sidebar_width {
            return None;
        }
        // El divisor pisa la última columna del raíl y gana: un arrastre leído
        // como opción cambiaría de agente cada vez que se estrecha el panel.
        // Plegado no se pinta la cabecera, así que tampoco responde.
        let collapsed = sidebar_width <= crate::tui::sidebar::COLLAPSED_WIDTH;
        if collapsed || crate::tui::sidebar::grabs_divider(mouse.column, sidebar_width) {
            return None;
        }
        // La fila 0 es el borde del marco; la cabecera va justo debajo.
        let line = usize::from(mouse.row.checked_sub(1)?);
        if line == super::draw::TABS_ROW {
            // La columna 0 es el borde del marco, igual que la fila 0.
            return tab_key_at(mouse.column.checked_sub(1)?).map(crossterm::event::KeyCode::Char);
        }
        let header = super::draw::sidebar_header(self, sidebar_width);
        key_in(&header.get(line)?.to_string())
    }

    /// Atiende un clic en el panel de archivos: dice si era suyo. El filtro
    /// que se pulsó, o la fila que se marcó — y si es la de un fichero,
    /// además despliega o cierra su diff.
    pub(in crate::tui) async fn handle_files_mouse(&mut self, mouse: MouseEvent, area: Rect) -> bool {
        if !matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) {
            return false;
        }
        let Some(click) = file_click(self, mouse.column, mouse.row, area) else { return false };
        self.apply_file_click(click, area.height).await;
        true
    }

    async fn apply_file_click(&mut self, click: FileClick, height: u16) {
        self.focus = super::Focus::Files;
        match click {
            FileClick::Chip(index) => {
                self.file_filter = [FileFilter::All, FileFilter::Added, FileFilter::Modified, FileFilter::Deleted][index];
                self.files_selected = 0;
            }
            FileClick::Row(row) => {
                // La lista puede estar desplazada: la fila de arriba no es la
                // primera del listado.
                let rows = self.pane_rows().len();
                let listed = usize::from(height.saturating_sub(3));
                let index = visible_offset(self.files_selected, listed) + row;
                if index >= rows {
                    return;
                }
                let on_file = matches!(self.pane_rows().get(index), Some(super::visible::PaneRow::File(_)));
                self.files_selected = index;
                // Pulsar el fichero abre su diff y vuelve a cerrarlo, igual
                // que el desplegable del escritorio. Sobre una línea del diff,
                // el clic sólo la marca: es la que recibe el comentario.
                if on_file {
                    if let Some(path) = self.selected_path() {
                        self.toggle_file(path).await;
                    }
                }
            }
        }
    }
}

/// Todo el ratón de la review, con lo que comparte con la lista de terminales
/// prestado en vez de copiado: el raíl es el mismo componente en las dos
/// pestañas y tiene que plegarse y arrastrarse igual.
pub(in crate::tui) struct ReviewMouse<'a> {
    pub(in crate::tui) width: &'a mut u16,
    pub(in crate::tui) restored: &'a mut u16,
    pub(in crate::tui) dragging_rail: &'a mut bool,
    pub(in crate::tui) dragging_drawer: &'a mut bool,
    pub(in crate::tui) total: u16,
    pub(in crate::tui) height: u16,
}

impl ReviewMouse<'_> {
    pub(in crate::tui) async fn handle(mut self, review: &mut ReviewState, mouse: MouseEvent) {
        // La rueda la recibe la aplicación mientras el ratón está capturado,
        // así que sin atenderla aquí girarla no mueve nada.
        if let Some(step) = crate::tui::rail::wheel(mouse) {
            review.scroll_wheel(mouse.column, *self.width, self.total, step);
            return;
        }
        if self.drawer(review, mouse) {
            return;
        }
        // Las opciones del raíl llevan su tecla escrita ("Agente: claude (g)"):
        // un clic manda esa misma tecla, así que hacen lo mismo por las dos vías.
        if let Some(key) = review.header_key_at(mouse, *self.width) {
            // Tocar el raíl es mirar el raíl: si no, una `c` pulsada ahí
            // comentaría la línea del diff que quedara marcada en el panel.
            review.focus = super::Focus::Sidebar;
            review.handle_event(Event::Key(key.into())).await;
            return;
        }
        let files = review.files_area(self.total, self.height, *self.width);
        if review.handle_files_mouse(mouse, files).await {
            return;
        }
        let rail = crate::tui::rail::RailMouse {
            width: self.width,
            restored: self.restored,
            dragging: self.dragging_rail,
            total: self.total,
            height: self.height,
            rows: review.sidebar_len(),
            header_lines: review.header_lines(),
        };
        match rail.handle(mouse) {
            Some(crate::tui::rail::RailClick::Select(index)) => review.select_sidebar(index),
            Some(crate::tui::rail::RailClick::Action) => review.toggle_run(),
            None => {}
        }
    }

    /// El borde y el galón del informe, mirados antes que nada: están a la
    /// derecha de todo lo que es del raíl. Dice si el clic era suyo.
    fn drawer(&mut self, review: &mut ReviewState, mouse: MouseEvent) -> bool {
        use crate::tui::drawer;

        let left = self.total.saturating_sub(review.drawer_width);
        if review.drawer_width == 0 {
            return false;
        }
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) if drawer::grabs_chevron(mouse.column, mouse.row, left) => {
                review.toggle_drawer();
                true
            }
            MouseEventKind::Down(MouseButton::Left) if drawer::grabs_divider(mouse.column, left) => {
                *self.dragging_drawer = true;
                true
            }
            MouseEventKind::Drag(MouseButton::Left) if *self.dragging_drawer => {
                review.drawer_width = drawer::width_after_drag(mouse.column, self.total);
                true
            }
            MouseEventKind::Up(MouseButton::Left) if *self.dragging_drawer => {
                *self.dragging_drawer = false;
                true
            }
            // Con el historial abierto, sus filas son el sentido de la columna:
            // alcanzables con el ratón como cualquier otra lista del panel.
            MouseEventKind::Down(MouseButton::Left) if review.showing_history && mouse.column > left => {
                if let Some(index) = drawer::history_row_at(mouse.row, review.checkpoints_len()) {
                    review.select_checkpoint(index);
                }
                true
            }
            _ => false,
        }
    }
}
