//! Lo que sirve la web del móvil: el HTML, sus hojas de estilo y sus scripts,
//! todos incrustados en el binario. Separado de `mod.rs` para que añadir un
//! script no toque el fichero donde vive la lógica del servidor.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{Html, IntoResponse},
    routing::get,
    Router,
};

use super::{authorized, Auth, RemoteState};

const MOBILE_HTML: &str = include_str!("web/index.html");
const SHARED_CSS: &str = include_str!("web/shared.css");
const TERMINAL_CSS: &str = include_str!("web/terminal.css");
const REVIEW_CSS: &str = include_str!("web/review.css");
const SHARED_JS: &str = include_str!("web/shared.js");
const TERMINAL_JS: &str = include_str!("web/terminal.js");
const REVIEW_JS: &str = include_str!("web/review.js");
const REVIEW_ASK_JS: &str = include_str!("web/review-ask.js");
const REVIEW_RUN_JS: &str = include_str!("web/review-run.js");
const REVIEW_PR_JS: &str = include_str!("web/review-pr.js");

/// Las rutas estáticas, para engancharlas al router del servidor.
pub(super) fn routes() -> Router<Arc<RemoteState>> {
    Router::new()
        .route("/", get(index))
        .route("/shared.css", get(|| asset("text/css", SHARED_CSS)))
        .route("/terminal.css", get(|| asset("text/css", TERMINAL_CSS)))
        .route("/review.css", get(|| asset("text/css", REVIEW_CSS)))
        .route("/shared.js", get(|| asset("text/javascript", SHARED_JS)))
        .route("/terminal.js", get(|| asset("text/javascript", TERMINAL_JS)))
        .route("/review.js", get(|| asset("text/javascript", REVIEW_JS)))
        .route("/review-ask.js", get(|| asset("text/javascript", REVIEW_ASK_JS)))
        .route("/review-run.js", get(|| asset("text/javascript", REVIEW_RUN_JS)))
        .route("/review-pr.js", get(|| asset("text/javascript", REVIEW_PR_JS)))
}

async fn index(State(state): State<Arc<RemoteState>>, Query(auth): Query<Auth>) -> impl IntoResponse {
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    Html(MOBILE_HTML).into_response()
}

// Static CSS/JS assets for the mobile web client. Unauthenticated: `index.html`
// is a compile-time `include_str!` constant with no server-side templating, so
// a `<script src>`/`<link>` tag has no way to carry the `?token=` query param.
// The content itself is non-sensitive UI code — every data-bearing route
// (`/api/*`, `/ws/*`) keeps its own `authorized()` check untouched.
async fn asset(content_type: &'static str, body: &'static str) -> impl IntoResponse {
    ([(axum::http::header::CONTENT_TYPE, content_type)], body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mobile_html_references_split_assets() {
        assert!(MOBILE_HTML.contains(r#"href="/shared.css""#));
        assert!(MOBILE_HTML.contains(r#"href="/terminal.css""#));
        assert!(MOBILE_HTML.contains(r#"href="/review.css""#));
        assert!(MOBILE_HTML.contains(r#"src="/shared.js""#));
        assert!(MOBILE_HTML.contains(r#"src="/terminal.js""#));
        assert!(MOBILE_HTML.contains(r#"src="/review.js""#));
        assert!(MOBILE_HTML.contains(r#"src="/review-run.js""#));
        assert!(MOBILE_HTML.contains(r#"src="/review-pr.js""#));
        assert!(MOBILE_HTML.contains(r#"src="/review-ask.js""#));
        assert!(!MOBILE_HTML.contains("<style>"));
        assert!(!MOBILE_HTML.contains("function switchTab"));
    }

    #[test]
    fn split_assets_contain_expected_functions() {
        assert!(SHARED_JS.contains("function switchTab"));
        assert!(SHARED_JS.contains("function esc"));
        assert!(TERMINAL_JS.contains("function attach"));
        assert!(TERMINAL_JS.contains("function connect"));
        assert!(REVIEW_RUN_JS.contains("function startReview"));
        assert!(REVIEW_PR_JS.contains("function loadPRs"));
        assert!(REVIEW_ASK_JS.contains("function sendAsk"));
        assert!(REVIEW_JS.contains("function renderReviewHistory"));
        assert!(SHARED_CSS.contains("#tabbar"));
        assert!(TERMINAL_CSS.contains("#tcon"));
        assert!(REVIEW_CSS.contains("#rv-output"));
    }
}
