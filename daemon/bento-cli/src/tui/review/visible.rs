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

impl ReviewState {
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
