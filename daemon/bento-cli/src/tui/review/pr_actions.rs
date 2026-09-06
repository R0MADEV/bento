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
    /// Pide lo que un PR trae además del diff. Las tres llamadas van juntas y
    /// fuera del bucle: son a la red, y en serie eran seis segundos con el
    /// panel sin repintar ni responder a una tecla.
    pub(super) fn request_pr_detail(&mut self, pr: u64) {
        self.begin_request();
        let (tx, cwd) = (self.work_tx.clone(), self.cwd.clone());
        tokio::spawn(async move {
            let ask = |cmd: &str| json!({ "id": "1", "cmd": cmd, "cwd": cwd, "pr": pr });
            let (comments, checks, inline, resolved) = tokio::join!(
                crate::request_data(ask("review.pr_comments")),
                crate::request_data(ask("review.pr_checks")),
                crate::request_data(ask("review.pr_review_comments")),
                crate::request_data(ask("review.resolved")),
            );
            let inline = inline.ok();
            let _ = tx.send(super::Fetched::PrDetail {
                pr,
                checks: checks.ok().map(|v| format_checks(&v)).unwrap_or_default(),
                inline: inline.as_ref().map(format_review_comments).unwrap_or_default(),
                comments: comments.ok().map(|v| format_pr_comments(&v)).unwrap_or_default(),
                raw: inline.and_then(|v| v.as_array().cloned()).unwrap_or_default(),
                resolved: resolved
                    .ok()
                    .and_then(|v| v.as_array().cloned())
                    .unwrap_or_default()
                    .iter()
                    .filter_map(Value::as_u64)
                    .collect(),
            });
        });
    }

    /// La franja de debajo de los archivos: de qué PR es y cómo va su CI. Lo
    /// largo —los checks uno a uno, los comentarios— sigue en el cajón, para
    /// quien lo abra.
    #[cfg(test)]
    pub(super) fn pr_strip_for_test(&self, pr: u64, checks: &str) -> String {
        self.pr_strip(pr, checks)
    }

    pub(super) fn pr_strip(&self, pr: u64, checks: &str) -> String {
        let title = self
            .prs
            .iter()
            .find(|p| p.get("number").and_then(Value::as_u64) == Some(pr))
            .and_then(|p| p.get("title").and_then(Value::as_str))
            .unwrap_or("");
        let ci = super::format::checks_badge(checks);
        match self.missing_branch() {
            Some(branch) => format!("PR #{pr}: {title} · {branch} no está en tu copia: haz `git fetch`"),
            None => format!("PR #{pr}: {title} · {ci}"),
        }
    }

    /// Contesta al comentario marcado. El hilo se seguía en GitHub porque
    /// aquí sólo se podían poner y leer.
    pub(super) async fn submit_comment_reply(&mut self, id: u64) {
        let body = std::mem::take(&mut self.input);
        let Some(pr) = self.current_pr else { return };
        let req = json!({
            "id": "1", "cmd": "review.pr_review_comment_reply", "cwd": self.cwd,
            "pr": pr, "comment_id": id, "data": body,
        });
        self.pr_status = match crate::request_data(req).await {
            Ok(_) => "respuesta enviada".to_string(),
            Err(error) => format!("no se pudo responder: {error}"),
        };
        self.reload_inline_comments().await;
    }

    /// Retira el comentario marcado.
    pub(super) async fn delete_selected_comment(&mut self) {
        let (Some(pr), Some(id)) = (self.current_pr, self.selected_comment()) else { return };
        let req = json!({
            "id": "1", "cmd": "review.pr_review_comment_delete", "cwd": self.cwd,
            "pr": pr, "comment_id": id,
        });
        self.pr_status = match crate::request_data(req).await {
            Ok(_) => "comentario borrado".to_string(),
            Err(error) => format!("no se pudo borrar: {error}"),
        };
        self.reload_inline_comments().await;
    }

    /// Los vuelve a pedir: lo que se acaba de escribir o retirar tiene que
    /// verse en el diff sin volver a abrir el PR.
    async fn reload_inline_comments(&mut self) {
        let Some(pr) = self.current_pr else { return };
        let req = json!({ "id": "1", "cmd": "review.pr_review_comments", "cwd": self.cwd, "pr": pr });
        self.inline_comments = crate::request_data(req)
            .await
            .ok()
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
    }

    /// Da por resuelto el comentario marcado, o lo reabre. Es el mismo gesto
    /// que marca un fichero como revisado, y se guarda en el mismo almacén.
    pub(super) fn toggle_resolved(&mut self, id: u64) {
        if !self.resolved_comments.remove(&id) {
            self.resolved_comments.insert(id);
        }
        let Some(pr) = self.current_pr else { return };
        let ids: Vec<u64> = self.resolved_comments.iter().copied().collect();
        let (cwd, tx) = (self.cwd.clone(), self.work_tx.clone());
        let _ = &tx;
        tokio::spawn(async move {
            let _ = crate::request_data(json!({
                "id": "1", "cmd": "review.resolved_set", "cwd": cwd, "pr": pr, "ids": ids,
            }))
            .await;
        });
    }

    /// La rama de git con la que comparar un PR.
    pub(super) fn pr_branch(&self, head_ref: &str) -> String {
        bento_review::branches::branch_for(&self.branches, head_ref)
    }

    /// Lo que falta por traerse, si es que falta. Un PR abierto después de tu
    /// último fetch no tiene rama que comparar: la lista sale vacía y parece
    /// que el PR no cambia nada. El aviso va en la franja del PR y no en el
    /// raíl, porque el refresco de la lista limpia el del raíl.
    fn missing_branch(&self) -> Option<&str> {
        let branch = self.branch.as_deref()?;
        let listed = self.branches.iter().any(|b| b == branch);
        (!listed).then_some(branch)
    }

    /// De qué PR es lo que estás leyendo, con lo que ya trae la lista.
    pub(super) fn pr_header(&self, pr: u64) -> String {
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
                self.pr_status = match self.comment_range() {
                    Some((first, last)) => format!("comentando las líneas {first}-{last}"),
                    None => format!("comentando la línea {line}"),
                };
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
        // Con varias líneas seleccionadas, el comentario abarca el bloque
        // entero, como el que se deja arrastrando en GitHub.
        let range = self.comment_range();
        if let Some((first, _)) = range {
            req["start_line"] = json!(first);
        }
        let done = match range {
            Some((first, last)) => format!("comentario puesto en las líneas {first}-{last}"),
            None => format!("comentario puesto en la línea {line}"),
        };
        self.pr_status = match crate::request_data(req).await {
            Ok(_) => done,
            Err(error) => format!("no se pudo comentar: {error}"),
        };
        self.drag_anchor = None;
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
        self.request_pr_detail(pr);
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
        self.request_pr_detail(pr);
    }
}
