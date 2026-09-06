//! Lo que se ve de cada lista: qué pasa el filtro y cuál está marcada.
//!
//! Aparte porque son las respuestas a "¿qué estoy mirando?" y "¿sobre qué voy a
//! actuar?", y confundirlas fue justo el fallo: con un filtro puesto, la fila

use serde_json::Value;

use super::{draw, file_matches_filter, FileFilter, ReviewState, SidebarTab};

impl ReviewState {
    /// Los ficheros que pasan el filtro de estado (`f`) y la búsqueda (`/`).
    /// El escritorio tiene su "Buscar archivos…" encima de la lista; aquí `/`
    /// filtraba ramas y texto pero no esto, así que con noventa ficheros no
    /// había forma de llegar a uno por su nombre.
    pub(super) fn visible_files(&self) -> Vec<&Value> {
        self.searched_files()
            .into_iter()
            .filter(|f| {
                let status = f.get("status").and_then(Value::as_str).unwrap_or("");
                file_matches_filter(status, self.file_filter)
            })
            .collect()
    }

    /// Los que pasan la búsqueda, sea cual sea su estado.
    fn searched_files(&self) -> Vec<&Value> {
        let needle = self.file_search.to_lowercase();
        self.files
            .iter()
            .filter(|f| {
                let path = f.get("path").and_then(Value::as_str).unwrap_or("");
                needle.is_empty() || path.to_lowercase().contains(&needle)
            })
            .collect()
    }

    /// Cuántos ficheros hay de cada tipo, para los cuatro filtros que el
    /// escritorio tiene siempre a la vista sobre la lista. Cuenta sobre lo que
    /// pasa la búsqueda: si no, los números no cuadran con la lista de debajo.
    pub(super) fn filter_counts(&self) -> [(FileFilter, usize); 4] {
        let searched = self.searched_files();
        let count = |filter: FileFilter| {
            searched
                .iter()
                .filter(|f| file_matches_filter(f.get("status").and_then(Value::as_str).unwrap_or(""), filter))
                .count()
        };
        [
            (FileFilter::All, count(FileFilter::All)),
            (FileFilter::Added, count(FileFilter::Added)),
            (FileFilter::Modified, count(FileFilter::Modified)),
            (FileFilter::Deleted, count(FileFilter::Deleted)),
        ]
    }
}

/// Una fila de lo que se ve en el panel: un fichero, o una línea del diff de
/// uno desplegado. El escritorio despliega el diff bajo su fichero y lo navegas
/// todo junto; esta es esa misma lista.
pub(super) enum PaneRow<'a> {
    File(&'a Value),
    Diff { path: String, row: super::format::DiffRow },
    Split { path: String, row: super::format::SplitRow },
    /// Un comentario ya puesto, bajo la línea de la que habla.
    Comment(&'a Value),
}

impl ReviewState {
    /// Los ficheros que se ven, con el diff de los abiertos bajo cada uno.
    pub(super) fn pane_rows(&self) -> Vec<PaneRow<'_>> {
        self.reparse_if_needed();
        let parsed = self.parsed.borrow();
        let mut rows = Vec::new();
        for file in self.visible_files() {
            rows.push(PaneRow::File(file));
            let Some(path) = file.get("path").and_then(Value::as_str) else { continue };
            let Some(diff) = parsed.rows.get(path) else { continue };
            for row in super::rows::pane_rows_of(self, path, diff) {
                let line = row_line(&row);
                rows.push(row);
                // Los de esa línea van justo debajo, que es donde se leen.
                rows.extend(self.comments_on(path, line).map(PaneRow::Comment));
            }
        }
        rows
    }

    /// Cuántas filas hay, sin armarlas. Armarlas copia cada línea de cada
    /// diff abierto, y moverse por la lista sólo necesita el número: con un
    /// gesto de trackpad eran treinta copias de todo para bajar quince filas.
    pub(in crate::tui) fn pane_rows_len(&self) -> usize {
        self.reparse_if_needed();
        let parsed = self.parsed.borrow();
        self.visible_files()
            .iter()
            .map(|file| {
                let Some(path) = file.get("path").and_then(Value::as_str) else { return 1 };
                let Some(diff) = parsed.rows.get(path) else { return 1 };
                let lines = match self.split {
                    // Partido, un borrado y el añadido que lo sustituye son
                    // una sola fila.
                    true => super::format::split_rows(diff.clone()).len(),
                    false => diff.len(),
                };
                let comments: usize = diff
                    .iter()
                    .map(|row| self.comments_on(path, row.line).count())
                    .sum();
                1 + lines + comments
            })
            .sum()
    }

    /// Vuelve a partir los diffs sólo si cambió lo que se ve. Partirlos es lo
    /// caro —tres cuartas partes de lo que cuesta pintar— y entre un frame y
    /// el siguiente casi nunca cambia nada.
    fn reparse_if_needed(&self) {
        let mark = self.parse_mark();
        if self.parsed.borrow().mark == mark {
            return;
        }
        let mut parsed = self.parsed.borrow_mut();
        parsed.rows = self
            .expanded
            .iter()
            .map(|(path, diff)| (path.clone(), super::format::diff_rows(&self.filtered(diff))))
            .collect();
        parsed.parses += 1;
        parsed.mark = mark;
    }

    /// La seña de lo guardado: qué ficheros están desplegados, con qué diff, y
    /// con qué búsqueda se partieron.
    fn parse_mark(&self) -> String {
        let mut open: Vec<String> = self
            .expanded
            .iter()
            .map(|(path, diff)| format!("{path}:{}", diff.len()))
            .collect();
        open.sort();
        format!("{}|{}", open.join(","), self.file_search)
    }

    /// Cuántas veces se han partido los diffs, para las pruebas.
    #[cfg(test)]
    pub(in crate::tui::review) fn diffs_parsed(&self) -> usize {
        self.parsed.borrow().parses
    }

    /// La rueda mueve lo que haya bajo el puntero: el informe si está sobre
    /// el cajón, y si no la lista de esa zona. La TUI captura el ratón, así
    /// que la rueda no la atiende el terminal — sin esto no hace nada.
    pub(in crate::tui) fn scroll_wheel(&mut self, column: u16, sidebar_width: u16, total: u16, step: i16) {
        // Cerrado no ocupa nada: mirando el ancho configurado, la rueda sobre
        // la derecha del panel movía un informe que no está en pantalla.
        let drawer = match self.drawer_open {
            true => self.drawer_width,
            false => 0,
        };
        let on_drawer = drawer > 0 && column >= total.saturating_sub(drawer);
        if on_drawer {
            self.scroll_drawer(step);
            return;
        }
        match column < sidebar_width {
            true => self.select_sidebar_by(step),
            // Desplazarse se lleva la fila marcada: es la que se comenta y
            // la que dice por dónde vas. La vista la sigue centrándola.
            false => self.select_file_by(step),
        }
    }

    /// Mueve el cursor del panel de archivos sin salirse de la lista.
    pub(in crate::tui) fn select_file_by(&mut self, delta: i16) {
        let last = self.pane_rows_len().saturating_sub(1);
        self.files_selected = self.files_selected.saturating_add_signed(delta as isize).min(last);
        // Moverse no es seleccionar: el ancla del arrastre se quedaba puesta
        // desde el clic anterior y desplazarse iba marcando todo lo que
        // quedaba en medio, como si estuvieras eligiendo líneas que comentar.
        self.drag_anchor = None;
    }

    /// Lo mismo para la lista del raíl, sea cual sea la pestaña abierta.
    pub(in crate::tui) fn select_sidebar_by(&mut self, delta: i16) {
        let current = match self.sidebar_tab {
            SidebarTab::Projects => self.projects_selected,
            SidebarTab::Branches => self.branches_selected,
            SidebarTab::Prs => self.prs_selected,
        };
        let last = self.sidebar_len().saturating_sub(1);
        self.select_sidebar(current.saturating_add_signed(delta as isize).min(last));
    }

    /// Si el diff de un fichero está desplegado bajo su fila.
    pub(super) fn is_expanded(&self, path: &str) -> bool {
        self.expanded.contains_key(path)
    }

    /// Los comentarios puestos en una línea de un fichero.
    fn comments_on<'a>(&'a self, path: &'a str, line: Option<u64>) -> impl Iterator<Item = &'a Value> {
        self.inline_comments.iter().filter(move |c| {
            let same_file = c.get("path").and_then(Value::as_str) == Some(path);
            // `line` viene a null cuando la línea ya no está en la versión
            // nueva; GitHub guarda entonces la que tenía al comentarse.
            let at = c.get("line").or_else(|| c.get("original_line")).and_then(Value::as_u64);
            same_file && line.is_some() && at == line
        })
    }

    /// Si un comentario está dado por resuelto.
    pub(super) fn is_resolved(&self, id: u64) -> bool {
        self.resolved_comments.contains(&id)
    }

    /// El comentario de la fila marcada, para contestarlo o retirarlo.
    pub(in crate::tui) fn selected_comment(&self) -> Option<u64> {
        comment_id_at(&self.pane_rows(), self.files_selected)
    }

    /// El fichero de la fila marcada, esté marcada su fila o una de su diff.
    pub(super) fn selected_path(&self) -> Option<String> {
        match self.pane_rows().get(self.files_selected)? {
            PaneRow::File(file) => file.get("path").and_then(Value::as_str).map(String::from),
            PaneRow::Diff { path, .. } | PaneRow::Split { path, .. } => Some(path.clone()),
            PaneRow::Comment(c) => c.get("path").and_then(Value::as_str).map(String::from),
        }
    }

    /// Las líneas que abarca la selección, si abarca más de una. GitHub las
    /// quiere en orden —la primera antes que la última—, y arrastrar hacia
    /// arriba las da al revés.
    pub(in crate::tui) fn comment_range(&self) -> Option<(u64, u64)> {
        self.comment_range_in(&self.pane_rows())
    }

    /// Lo mismo sobre unas filas ya construidas: construirlas reparsea todos
    /// los diffs abiertos, y el dibujo ya las tiene en la mano.
    pub(super) fn comment_range_in(&self, rows: &[PaneRow<'_>]) -> Option<(u64, u64)> {
        let anchor = self.drag_anchor?;
        let from = row_line(rows.get(anchor)?)?;
        let to = row_line(rows.get(self.files_selected)?)?;
        let (first, last) = match from <= to {
            true => (from, to),
            false => (to, from),
        };
        (first != last).then_some((first, last))
    }

    /// La línea del fichero nuevo bajo el cursor, si está sobre una del diff.
    pub(super) fn selected_diff_line(&self) -> Option<u64> {
        row_line(self.pane_rows().get(self.files_selected)?)
    }

    /// Fire-and-forget: guarda la lista de revisados para este proyecto+base.
    pub(in crate::tui) fn header_lines(&self) -> u16 {
        // The width only affects how the project path is shortened, never how
        // many lines there are.
        draw::sidebar_header(self, 24).len() as u16
    }

    /// How many rows the rail is showing for the tab that is open. The click
    /// handler needs it to reject clicks past the end of the list.
    pub(in crate::tui) fn sidebar_len(&self) -> usize {
        match self.sidebar_tab {
            SidebarTab::Projects => self.browse_dirs.len(),
            SidebarTab::Branches => self.visible_branches().len(),
            SidebarTab::Prs => self.prs.len(),
        }
    }

    /// How many saved reviews the history is showing, for the same reason.
    pub(in crate::tui) fn checkpoints_len(&self) -> usize {
        self.checkpoints.len()
    }

    /// Picks one of them, ignoring a row that is not there.
    pub(in crate::tui) fn select_checkpoint(&mut self, index: usize) {
        if index < self.checkpoints.len() {
            self.checkpoints_selected = index;
        }
    }

    /// Moves the selection of the open tab, ignoring a row that is not there.
    /// Each tab keeps its own cursor, so switching back finds it where it was.
    pub(in crate::tui) fn select_sidebar(&mut self, index: usize) {
        if index >= self.sidebar_len() {
            return;
        }
        match self.sidebar_tab {
            SidebarTab::Projects => self.projects_selected = index,
            SidebarTab::Branches => self.branches_selected = index,
            SidebarTab::Prs => self.prs_selected = index,
        }
    }

    /// La rama marcada: la de la lista que se está viendo, no la de la lista
    /// entera. Con un filtro puesto, la fila 0 de lo que ves no es la fila 0 de
    /// todas — se elegía otra rama, y los ficheros eran los de esa otra.
    pub(super) fn selected_branch(&self) -> Option<String> {
        self.visible_branches().get(self.branches_selected).map(|b| (*b).clone())
    }

    /// Las ramas que pasan el filtro escrito con `/`.
    pub(super) fn visible_branches(&self) -> Vec<&String> {
        let needle = self.search.to_lowercase();
        self.branches.iter().filter(|b| needle.is_empty() || b.to_lowercase().contains(&needle)).collect()
    }

    /// El texto con solo las líneas que contienen la búsqueda. Se aplica al
    /// diff de un archivo, al de un PR y a la salida de la review.
    pub(super) fn filtered(&self, text: &str) -> String {
        if self.file_search.is_empty() {
            return text.to_string();
        }
        let needle = self.file_search.to_lowercase();
        text.lines().filter(|l| l.to_lowercase().contains(&needle)).collect::<Vec<_>>().join("\n")
    }
}

/// La línea del fichero nuevo de una fila, que en la vista partida es la de la
/// columna derecha: es a la que GitHub ancla los comentarios.
pub(super) fn row_line(row: &PaneRow<'_>) -> Option<u64> {
    match row {
        PaneRow::Diff { row, .. } => row.line,
        PaneRow::Split { row, .. } => row.right.as_ref().and_then(|r| r.line),
        PaneRow::File(_) | PaneRow::Comment(_) => None,
    }
}

/// El id del comentario de una fila, si esa fila es un comentario.
pub(super) fn comment_id_at(rows: &[PaneRow<'_>], index: usize) -> Option<u64> {
    match rows.get(index)? {
        PaneRow::Comment(c) => c.get("id").and_then(Value::as_u64),
        _ => None,
    }
}
