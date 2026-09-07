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
            let (comments, checks, inline, threads) = tokio::join!(
                crate::request_data(ask("review.pr_comments")),
                crate::request_data(ask("review.pr_checks")),
                crate::request_data(ask("review.pr_review_comments")),
                crate::request_data(ask("review.pr_threads")),
            );
            let inline = inline.ok();
            let _ = tx.send(super::Fetched::PrDetail {
                pr,
                checks: checks.ok().map(|v| format_checks(&v)).unwrap_or_default(),
                inline: inline.as_ref().map(format_review_comments).unwrap_or_default(),
                comments: comments.ok().map(|v| format_pr_comments(&v)).unwrap_or_default(),
                raw: inline.and_then(|v| v.as_array().cloned()).unwrap_or_default(),
                threads: threads.ok().unwrap_or(Value::Null),
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

    /// Abre la corrección del comentario marcado, con lo que decía dentro:
    /// empezar de cero para arreglar una palabra no es editar.
    pub(super) fn start_comment_edit(&mut self) {
        let Some(id) = self.selected_comment() else { return };
        let body = self
            .inline_comments
            .iter()
            .find(|c| c.get("id").and_then(Value::as_u64) == Some(id))
            .and_then(|c| c.get("body").and_then(Value::as_str))
            .unwrap_or_default();
        self.input = body.to_string();
        self.input_purpose = Some(super::InputPurpose::CommentEdit(id));
    }

    /// Guarda la corrección.
    pub(super) async fn submit_comment_edit(&mut self, id: u64) {
        let body = std::mem::take(&mut self.input);
        let Some(pr) = self.current_pr else { return };
        let req = json!({
            "id": "1", "cmd": "review.pr_review_comment_update", "cwd": self.cwd,
            "pr": pr, "comment_id": id, "data": body,
        });
        self.pr_status = match crate::request_data(req).await {
            Ok(_) => "comentario corregido".to_string(),
            Err(error) => format!("no se pudo corregir: {error}"),
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

    /// Resuelve en GitHub el hilo del comentario marcado, o lo reabre. Es la
    /// conversación entera la que se resuelve, no el comentario suelto, y la
    /// marca la ve todo el equipo.
    pub(super) async fn toggle_resolved(&mut self, id: u64) {
        let Some(pr) = self.current_pr else { return };
        let resolved = !self.is_resolved(id);
        self.pr_status = match resolved {
            true => "resolviendo la conversación…".to_string(),
            false => "reabriendo la conversación…".to_string(),
        };
        let req = json!({
            "id": "1", "cmd": "review.pr_thread_resolve", "cwd": self.cwd,
            "pr": pr, "comment_id": id, "resolved": resolved,
        });
        self.pr_status = match crate::request_data(req).await {
            Ok(_) => match resolved {
                true => "conversación resuelta".to_string(),
                false => "conversación reabierta".to_string(),
            },
            Err(error) => format!("no se pudo: {error}"),
        };
        self.reload_threads().await;
    }

    /// Relee los hilos: lo que se acaba de resolver tiene que verse sin volver
    /// a abrir el PR.
    async fn reload_threads(&mut self) {
        let Some(pr) = self.current_pr else { return };
        let req = json!({ "id": "1", "cmd": "review.pr_threads", "cwd": self.cwd, "pr": pr });
        if let Ok(threads) = crate::request_data(req).await {
            self.threads = threads;
        }
    }

    /// Salta al comentario siguiente, o al anterior. Da la vuelta al llegar
    /// al final, que es lo que se espera de "el siguiente".
    ///
    /// Los ficheros que llevan comentarios se despliegan antes: plegados, sus
    /// comentarios no son filas a las que saltar.
    pub(super) async fn jump_to_comment(&mut self, forward: bool) {
        let with_comments: Vec<String> = self
            .inline_comments
            .iter()
            .filter_map(|c| c.get("path").and_then(Value::as_str).map(String::from))
            .collect();
        for path in with_comments {
            if !self.is_expanded(&path) {
                self.toggle_file(path).await;
            }
        }
        let rows = self.comment_rows();
        if rows.is_empty() {
            self.pr_status = "este PR no tiene comentarios en líneas".into();
            return;
        }
        let at = self.files_selected;
        let next = match forward {
            true => rows.iter().find(|row| **row > at).or_else(|| rows.first()),
            false => rows.iter().rev().find(|row| **row < at).or_else(|| rows.last()),
        };
        if let Some(row) = next {
            self.files_selected = *row;
            self.drag_anchor = None;
        }
    }

    /// Deja en el portapapeles el diff del fichero marcado, o su ruta. Son
    /// los dos botones que el escritorio tiene en la fila del fichero.
    pub(super) fn copy_from_file(&mut self, what: super::Copy) {
        let Some(path) = self.selected_path() else { return };
        let text = match what {
            super::Copy::Path => Some(path.clone()),
            super::Copy::Diff => self.expanded.get(&path).cloned(),
        };
        let Some(text) = text else {
            self.pr_status = "despliega el fichero (Enter) para copiar su diff".into();
            return;
        };
        self.pr_status = match super::copy_to_clipboard(&text) {
            true => match what {
                super::Copy::Path => format!("copiado: {path}"),
                super::Copy::Diff => format!("copiado el diff de {path}"),
            },
            false => "no se pudo copiar: el terminal no lo admite".to_string(),
        };
    }

    /// Abre el fichero marcado en el editor, el mismo que abre el escritorio.
    pub(super) fn open_in_editor(&mut self) {
        let Some(path) = self.selected_path() else { return };
        let full = format!("{}/{path}", self.cwd);
        self.pr_status = match bento_core::editor::open(&full) {
            Ok(()) => format!("abriendo {path}"),
            Err(error) => format!("no se pudo abrir: {error}"),
        };
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
