//! Lo que se ve de cada lista: qué pasa el filtro y cuál está marcada.
//!
//! Aparte porque son las respuestas a "¿qué estoy mirando?" y "¿sobre qué voy a
//! actuar?", y confundirlas fue justo el fallo: con un filtro puesto, la fila
//! marcada de lo que ves no es la misma de la lista entera.

use serde_json::Value;

use super::{draw, file_matches_filter, ReviewState, SidebarTab};

impl ReviewState {
    /// Los ficheros que pasan el filtro de estado (`f`) y la búsqueda (`/`).
    /// El escritorio tiene su "Buscar archivos…" encima de la lista; aquí `/`
    /// filtraba ramas y texto pero no esto, así que con noventa ficheros no
    /// había forma de llegar a uno por su nombre.
    pub(super) fn visible_files(&self) -> Vec<&Value> {
        let needle = self.file_search.to_lowercase();
        self.files
            .iter()
            .filter(|f| {
                let status = f.get("status").and_then(Value::as_str).unwrap_or("");
                let path = f.get("path").and_then(Value::as_str).unwrap_or("");
                let matches_search = needle.is_empty() || path.to_lowercase().contains(&needle);
                matches_search && file_matches_filter(status, self.file_filter)
            })
            .collect()
    }
}

/// Una fila de lo que se ve en el panel: un fichero, o una línea del diff de
/// uno desplegado. El escritorio despliega el diff bajo su fichero y lo navegas
/// todo junto; esta es esa misma lista.
pub(super) enum PaneRow<'a> {
    File(&'a Value),
    Diff { path: String, row: super::format::DiffRow },
}

impl ReviewState {
    /// Los ficheros que se ven, con el diff de los abiertos bajo cada uno.
    pub(super) fn pane_rows(&self) -> Vec<PaneRow<'_>> {
        let mut rows = Vec::new();
        for file in self.visible_files() {
            rows.push(PaneRow::File(file));
            let Some(path) = file.get("path").and_then(Value::as_str) else { continue };
            let Some(diff) = self.expanded.get(path) else { continue };
            for row in super::format::diff_rows(&self.filtered(diff)) {
                rows.push(PaneRow::Diff { path: path.to_string(), row });
            }
        }
        rows
    }

    /// La rueda mueve lo que haya bajo el puntero: el informe si está sobre
    /// el cajón, y si no la lista de esa zona. La TUI captura el ratón, así
    /// que la rueda no la atiende el terminal — sin esto no hace nada.
    pub(in crate::tui) fn scroll_wheel(&mut self, column: u16, sidebar_width: u16, total: u16, up: bool) {
        let step = if up { -3 } else { 3 };
        let drawer_left = total.saturating_sub(self.drawer_width);
        let on_drawer = self.drawer_width > 0 && column >= drawer_left;
        if on_drawer {
            self.scroll_drawer(step);
            return;
        }
        match column < sidebar_width {
            true => self.select_sidebar_by(step),
            false => self.select_file_by(step),
        }
    }

    /// Mueve el cursor del panel de archivos sin salirse de la lista.
    pub(in crate::tui) fn select_file_by(&mut self, delta: i16) {
        let last = self.pane_rows().len().saturating_sub(1);
        self.files_selected = self.files_selected.saturating_add_signed(delta as isize).min(last);
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

    /// El fichero de la fila marcada, esté marcada su fila o una de su diff.
    pub(super) fn selected_path(&self) -> Option<String> {
        match self.pane_rows().get(self.files_selected)? {
            PaneRow::File(file) => file.get("path").and_then(Value::as_str).map(String::from),
            PaneRow::Diff { path, .. } => Some(path.clone()),
        }
    }

    /// La línea del fichero nuevo bajo el cursor, si está sobre una del diff.
    pub(super) fn selected_diff_line(&self) -> Option<u64> {
        match self.pane_rows().get(self.files_selected)? {
            PaneRow::Diff { row, .. } => row.line,
            PaneRow::File(_) => None,
        }
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
