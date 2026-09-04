//! The report column: whether it is showing a review or the list of past
//! ones, how wide it is, and where the focus goes. Split out of `mod.rs` for
//! size; the drawing itself lives in `crate::tui::drawer`.

use serde_json::{json, Value};

use super::{Fetched, Focus, ReviewState};

impl ReviewState {
    /// Moves the focus one column right, skipping the drawer when it is not
    /// there — keys landing on something invisible read as a dead keyboard.
    pub(super) fn focus_right(&mut self) {
        self.focus = match self.focus {
            Focus::Sidebar => Focus::Files,
            Focus::Files if self.drawer_open => Focus::Drawer,
            other => other,
        };
    }

    /// And one column left.
    pub(super) fn focus_left(&mut self) {
        self.focus = match self.focus {
            Focus::Drawer => Focus::Files,
            Focus::Files => Focus::Sidebar,
            other => other,
        };
    }

    /// Scrolls the report. `saturating_add_signed` on an unsigned counter
    /// already stops at the top, which is what scrolling up past the
    /// beginning should do.
    pub(super) fn scroll_drawer(&mut self, delta: i16) {
        self.scroll = self.scroll.saturating_add_signed(delta);
    }

    /// Opens the review selected in the history: its report and, with it, the
    /// verifier's session — which is what makes "keep asking about this one"
    /// work later.
    pub(super) async fn open_selected_review(&mut self) {
        let Some(entry) = self.checkpoints.get(self.checkpoints_selected).cloned() else { return };
        let base = entry.get("base").and_then(Value::as_str).unwrap_or(&self.base).to_string();
        let mut body = json!({ "id": "1", "cmd": "review.checkpoint_get", "cwd": self.cwd, "base": base });
        // Asking for this run rather than the newest of that branch, which is
        // the whole point of keeping them apart.
        if let Some(run) = entry.get("run_id").and_then(Value::as_str) {
            body["run_id"] = json!(run);
        }
        let Ok(cp) = crate::request_data(body).await else {
            self.status = "no se pudo abrir esa review".into();
            return;
        };
        self.output = cp.get("content").and_then(Value::as_str).unwrap_or_default().to_string();
        self.session_id = cp.get("session_id").and_then(Value::as_str).map(String::from);
        self.session_agent = cp.get("session_agent").and_then(Value::as_str).map(String::from);
        self.scroll = 0;
        self.running = false;
        self.last_progress.clear();
        self.showing_history = false;
        // El listado ya dice cuáles dejó atrás la rama; al abrir una, se dice
        // otra vez, que es cuando se va a leer el informe.
        let stale = entry.get("stale").and_then(Value::as_bool).unwrap_or(false);
        self.status = match stale {
            true => "esta review es de un commit que la rama ya dejó atrás".into(),
            false => String::new(),
        };
    }

    /// Deletes the review selected in the history and asks for the list
    /// again. Naming the run is what makes the delete reach the file; by base
    /// alone it missed and the entry came back on the next listing.
    pub(super) async fn delete_selected_review(&mut self) {
        let Some(entry) = self.checkpoints.get(self.checkpoints_selected).cloned() else { return };
        let Some(base) = entry.get("base").and_then(Value::as_str).map(String::from) else { return };
        let run = entry.get("run_id").and_then(Value::as_str).map(String::from);
        let body = json!({
            "id": "1", "cmd": "review.checkpoint_delete",
            "cwd": self.cwd, "base": base, "run_id": run,
        });
        if crate::request_data(body).await.is_err() {
            self.status = "no se pudo borrar esa review".into();
            return;
        }
        self.checkpoints.remove(self.checkpoints_selected);
        if self.checkpoints_selected >= self.checkpoints.len() {
            self.checkpoints_selected = self.checkpoints.len().saturating_sub(1);
        }
    }

    /// Swaps the drawer between the report and the list of past reviews,
    /// asking for the list off the loop when it is opened.
    pub(super) fn toggle_history(&mut self) {
        self.showing_history = !self.showing_history;
        self.drawer_open = true;
        if self.drawer_width <= crate::tui::drawer::COLLAPSED_WIDTH {
            self.drawer_width = self.restored_drawer_width;
        }
        if self.showing_history {
            let body = json!({ "id": "1", "cmd": "review.checkpoints", "cwd": self.cwd });
            self.spawn_list_request(body, Fetched::Checkpoints);
        }
    }

    /// Mueve el borde del informe con el teclado, con los mismos topes que el
    /// ratón: es la única forma de cambiarlo sin ratón.
    pub(in crate::tui) fn nudge_drawer(&mut self, delta: i16, total: u16) {
        let moved = i32::from(self.drawer_width) + i32::from(delta);
        let column = u16::try_from(i32::from(total) - moved.max(0)).unwrap_or(0);
        self.drawer_width = crate::tui::drawer::width_after_drag(column, total);
        self.drawer_open = true;
    }

    /// Si hay un cuadro de texto abierto (contexto, pregunta, buscar). Mientras
    /// lo haya, las teclas son suyas: los atajos del panel que las miran antes
    /// —el modo tamaño— tienen que apartarse, o una "s" no se podría teclear.
    pub(in crate::tui) fn is_typing(&self) -> bool {
        self.input_purpose.is_some()
    }

    /// Shows the drawer, so a report never lands somewhere invisible.
    pub(super) fn open_drawer(&mut self) {
        self.drawer_open = true;
        // A report takes the drawer back from the list: you asked for this one.
        self.showing_history = false;
        if self.drawer_width <= crate::tui::drawer::COLLAPSED_WIDTH {
            self.drawer_width = self.restored_drawer_width;
        }
    }

    /// Folds it to its stub, or brings it back to the width it had. Folding
    /// leaves the stub rather than hiding it, so there is something to click.
    pub(in crate::tui) fn toggle_drawer(&mut self) {
        if !self.drawer_open {
            self.open_drawer();
            return;
        }
        self.drawer_width = crate::tui::drawer::toggle(self.drawer_width, &mut self.restored_drawer_width);
    }
}
