//! The pull request side of the panel: loading one, and the two things you can
//! do to it from here — leave a comment and submit a review. Split out of

use serde_json::{json, Value};

use super::format::{format_checks, format_pr_comments, format_review_comments};
use super::ReviewState;

impl ReviewState {
    /// Deja abierto un PR: la lista de archivos ya está en su rama, así que
    /// aquí sólo se trae lo que el diff no cuenta —checks, comentarios— y va
    /// al cajón, que es donde se lee texto largo. El diff no se duplica: se
    /// lee en la lista, con sus desplegables y sus dos columnas, como en el
    /// escritorio.
    pub(super) async fn load_pr_detail(&mut self, pr: u64) {
        let ask = |cmd: &str| json!({ "id": "1", "cmd": cmd, "cwd": self.cwd, "pr": pr });
        let comments = crate::request_data(ask("review.pr_comments"))
            .await
            .ok()
            .map(|v| format_pr_comments(&v))
            .unwrap_or_default();
        let checks = crate::request_data(ask("review.pr_checks"))
            .await
            .ok()
            .map(|v| format_checks(&v))
            .unwrap_or_default();
        let inline = crate::request_data(ask("review.pr_review_comments"))
            .await
            .ok()
            .map(|v| format_review_comments(&v))
            .unwrap_or_default();
        let header = self.pr_header(pr);
        self.pr_detail = format!("{header}{checks}{inline}\n## Comentarios\n\n{comments}");
        self.scroll = 0;
        self.current_pr = Some(pr);
        self.pr_status.clear();
        self.drawer_open = true;
    }

    /// De qué PR es lo que estás leyendo, con lo que ya trae la lista.
    fn pr_header(&self, pr: u64) -> String {
        let Some(entry) = self.prs.iter().find(|p| p.get("number").and_then(Value::as_u64) == Some(pr)) else {
            return format!("# PR #{pr}\n");
        };
        let field = |key: &str| entry.get(key).and_then(Value::as_str).unwrap_or("").to_string();
        let author = entry.get("author").and_then(|a| a.get("login")).and_then(Value::as_str).unwrap_or("?");
        format!(
            "# #{pr} {}\n\n{} → {} · @{author}\n{}\n",
            field("title"), field("headRefName"), field("baseRefName"), field("url"),
        )
    }

    /// Abre el cuadro para comentar la línea marcada. Con el filtro puesto no
    /// se puede: las filas de la vista ya no son las del diff, y el comentario
    /// acabaría en otra línea.
    pub(super) fn start_inline_comment(&mut self) {
        if !self.file_search.is_empty() {
            self.pr_status = "quita la búsqueda (F3) para comentar una línea".into();
            return;
        }
        if self.current_pr.is_none() {
            self.pr_status = "abre antes el PR (p) para comentar en él".into();
            return;
        }
        let Some(path) = self.selected_path() else { return };
        // La fila marcada puede ser la del fichero, y entonces no hay línea a
        // la que anclar el comentario.
        match self.selected_diff_line() {
            Some(line) => {
                self.current_file = Some(path);
                self.input_purpose = Some(super::InputPurpose::InlineComment(line));
                self.input.clear();
                self.pr_status = format!("comentando la línea {line}");
            }
            None => self.pr_status = "marca una línea del diff (Enter abre el fichero)".into(),
        }
    }

    /// Manda el comentario a la línea marcada. El sha al que se ancla lo
    /// resuelve el daemon desde la rama, igual que el panel del escritorio.
    pub(super) async fn submit_inline_comment(&mut self, line: u64) {
        let body = std::mem::take(&mut self.input);
        let (Some(pr), Some(path)) = (self.current_pr, self.current_file.clone()) else {
            self.pr_status = "no hay PR o fichero abierto".into();
            return;
        };
        let mut req = json!({
            "id": "1", "cmd": "review.pr_inline_comment", "cwd": self.cwd,
            "pr": pr, "path": path, "line": line, "data": body,
        });
        if let Some(branch) = &self.branch {
            req["branch"] = json!(branch);
        }
        self.pr_status = match crate::request_data(req).await {
            Ok(_) => format!("comentario puesto en la línea {line}"),
            Err(error) => format!("no se pudo comentar: {error}"),
        };
    }

    pub(super) async fn submit_pr_comment(&mut self) {
        let Some(pr) = self.current_pr else { return };
        let body = std::mem::take(&mut self.input);
        if body.trim().is_empty() {
            return;
        }
        let result = crate::request_data(json!({
            "id": "1", "cmd": "review.pr_comment_add", "cwd": self.cwd, "pr": pr, "data": body,
        })).await;
        self.pr_status = match result {
            Ok(_) => "comentario agregado".to_string(),
            Err(e) => format!("error: {e}"),
        };
        self.load_pr_detail(pr).await;
    }

    pub(super) async fn submit_pr_review(&mut self, event: &str) {
        let Some(pr) = self.current_pr else { return };
        let body = std::mem::take(&mut self.input);
        let mut req = json!({ "id": "1", "cmd": "review.pr_submit", "cwd": self.cwd, "pr": pr, "event": event });
        if !body.trim().is_empty() {
            req["data"] = json!(body);
        }
        let result = crate::request_data(req).await;
        self.pr_status = match result {
            Ok(_) => format!("review enviada ({event})"),
            Err(e) => format!("error: {e}"),
        };
        self.load_pr_detail(pr).await;
    }
}
