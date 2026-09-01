//! The pull request side of the panel: loading one, and the two things you can
//! do to it from here — leave a comment and submit a review. Split out of
//! `mod.rs` for size.

use serde_json::{json, Value};

use super::format::{format_checks, format_pr_comments, format_review_comments};
use super::{ReviewState, ReviewView};

impl ReviewState {
    pub(super) async fn load_pr_detail(&mut self, pr: u64) {
        let diff = crate::request_data(json!({ "id": "1", "cmd": "review.pr_diff", "cwd": self.cwd, "pr": pr }))
            .await
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_else(|| "(no se pudo cargar el diff)".to_string());
        let comments = crate::request_data(json!({ "id": "1", "cmd": "review.pr_comments", "cwd": self.cwd, "pr": pr }))
            .await
            .ok()
            .map(|v| format_pr_comments(&v))
            .unwrap_or_default();
        let checks = crate::request_data(json!({ "id": "1", "cmd": "review.pr_checks", "cwd": self.cwd, "pr": pr }))
            .await
            .ok()
            .map(|v| format_checks(&v))
            .unwrap_or_default();
        let inline = crate::request_data(json!({ "id": "1", "cmd": "review.pr_review_comments", "cwd": self.cwd, "pr": pr }))
            .await
            .ok()
            .map(|v| format_review_comments(&v))
            .unwrap_or_default();
        // Encabezado con lo que ya trae la lista: sin él, el detalle abría
        // directamente en el diff y no decía ni de qué PR era.
        let header = self
            .prs
            .iter()
            .find(|p| p.get("number").and_then(Value::as_u64) == Some(pr))
            .map(|p| {
                let field = |key: &str| p.get(key).and_then(Value::as_str).unwrap_or("").to_string();
                let author = p.get("author").and_then(|a| a.get("login")).and_then(Value::as_str).unwrap_or("?");
                format!(
                    "# #{pr} {}\n\n{} → {} · @{author}\n{}\n",
                    field("title"), field("headRefName"), field("baseRefName"), field("url"),
                )
            })
            .unwrap_or_else(|| format!("# PR #{pr}\n"));
        self.pr_detail = format!(
            "{header}{checks}{inline}\n---\n\n{diff}\n\n---\n\n## Comentarios\n\n{comments}"
        );
        self.pr_scroll = 0;
        self.current_pr = Some(pr);
        self.pr_status.clear();
        self.view = ReviewView::PrDetail;
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
