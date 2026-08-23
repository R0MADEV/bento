//! Phone remote: token-gated HTTP + WebSocket server that lets a browser (your
//! phone) attach to the daemon's terminals. Opt-in — only started when the
//! caller explicitly calls `RemoteControl::start`.

mod review;
pub(crate) mod webrtc_bridge;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::StatusCode,
    response::{Html, IntoResponse, Json},
    routing::{delete, get, post},
    Router,
};
use bento_core::{PtyEvent, PtyManager};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;

use review::{
    ask_handler,
    delete_checkpoint_handler, get_checkpoint_handler,
    list_checkpoints_handler, put_checkpoint_handler,
    review_branches_handler, review_files_handler, review_file_handler, review_handler,
    review_pr_add_comment_handler, review_pr_comments_handler,
    review_pr_delete_comment_handler, review_pr_diff_handler,
    review_pr_submit_handler,
    review_pr_update_comment_handler, review_prs_handler,
};

const MOBILE_HTML: &str = include_str!("web/index.html");
const SHARED_CSS: &str = include_str!("web/shared.css");
const TERMINAL_CSS: &str = include_str!("web/terminal.css");
const REVIEW_CSS: &str = include_str!("web/review.css");
const SHARED_JS: &str = include_str!("web/shared.js");
const TERMINAL_JS: &str = include_str!("web/terminal.js");
const REVIEW_JS: &str = include_str!("web/review.js");

// ── Public types ─────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct RemoteInfo {
    pub running: bool,
    pub addr: String,
    pub token: String,
    pub url: String,
}

struct ActiveRemote {
    info: RemoteInfo,
    handle: JoinHandle<()>,
    /// Sending on this channel triggers axum's graceful shutdown, which closes
    /// the TcpListener and drains connections. We also abort() as a hard fallback.
    shutdown_tx: watch::Sender<bool>,
}

impl Drop for ActiveRemote {
    fn drop(&mut self) {
        let _ = self.shutdown_tx.send(true);
        self.handle.abort();
    }
}

struct RemoteControlInner {
    active: Mutex<Option<ActiveRemote>>,
    /// Bumped by stop() and by each new start() attempt. A start() that sees
    /// the counter move after the async TCP bind knows a stop (or newer start)
    /// arrived while it was binding — it aborts without storing the new server.
    generation: AtomicU64,
}

impl Default for RemoteControlInner {
    fn default() -> Self {
        Self { active: Mutex::new(None), generation: AtomicU64::new(0) }
    }
}

/// Shared handle to the optional phone HTTP server. Clone-cheap (Arc inside).
#[derive(Clone)]
pub struct RemoteControl(Arc<RemoteControlInner>);

impl Default for RemoteControl {
    fn default() -> Self {
        Self(Arc::new(RemoteControlInner::default()))
    }
}

impl RemoteControl {
    pub async fn start(&self, manager: PtyManager, port: u16, token: Option<String>, use_tailscale: bool, herdr_socket: Option<String>) -> Result<RemoteInfo, String> {
        {
            let guard = self.0.active.lock().unwrap();
            if let Some(active) = &*guard {
                if !active.handle.is_finished() {
                    return Ok(active.info.clone());
                }
            }
        }

        let gen = self.0.generation.fetch_add(1, Ordering::SeqCst);
        *self.0.active.lock().unwrap() = None;

        let token = token.unwrap_or_else(generate_token);
        let res = resolve_bind_ip(use_tailscale, tailscale_ip(), local_ip());
        let bind_addr = format!("{}:{}", res.bind_host, port);
        let url = format!("http://{}:{}/?token={}", res.display_ip, port, token);
        let info = RemoteInfo {
            running: true,
            addr: format!("{}:{}", res.display_ip, port),
            token: token.clone(),
            url,
        };

        let listener = tokio::net::TcpListener::bind(&bind_addr)
            .await
            .map_err(|e| e.to_string())?;

        if self.0.generation.load(Ordering::SeqCst) != gen + 1 {
            return Ok(RemoteInfo { running: false, addr: String::new(), token: String::new(), url: String::new() });
        }

        let state = Arc::new(RemoteState { manager, token, herdr_socket });
        let app = Router::new()
            .route("/", get(index))
            .route("/shared.css", get(|| asset("text/css", SHARED_CSS)))
            .route("/terminal.css", get(|| asset("text/css", TERMINAL_CSS)))
            .route("/review.css", get(|| asset("text/css", REVIEW_CSS)))
            .route("/shared.js", get(|| asset("text/javascript", SHARED_JS)))
            .route("/terminal.js", get(|| asset("text/javascript", TERMINAL_JS)))
            .route("/review.js", get(|| asset("text/javascript", REVIEW_JS)))
            .route("/api/terminals", get(terminals))
            .route("/api/terminals", post(new_terminal))
            .route("/api/terminals/:id", delete(kill_terminal))
            .route("/api/projects", get(projects_handler))
            .route("/api/fs/dirs", get(fs_dirs_handler))
            .route("/api/review", get(review_handler))
            .route("/api/review/branches", get(review_branches_handler))
            .route("/api/review/files", get(review_files_handler))
            .route("/api/review/file", get(review_file_handler))
            .route("/api/review/prs", get(review_prs_handler))
            .route("/api/review/pr/diff", get(review_pr_diff_handler))
            .route("/api/review/pr/comments", get(review_pr_comments_handler))
            .route("/api/review/pr/comment", post(review_pr_add_comment_handler))
            .route("/api/review/pr/comment/:id", axum::routing::put(review_pr_update_comment_handler))
            .route("/api/review/pr/comment/:id", delete(review_pr_delete_comment_handler))
            .route("/api/review/ask", get(ask_handler))
        .route("/api/review/checkpoints", get(list_checkpoints_handler))
        .route("/api/review/checkpoint", get(get_checkpoint_handler))
        .route("/api/review/checkpoint", axum::routing::put(put_checkpoint_handler))
        .route("/api/review/checkpoint", delete(delete_checkpoint_handler))
        .route("/api/review/pr/submit", post(review_pr_submit_handler))
            .route("/ws/:id", get(ws_handler))
            .with_state(state);

        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let log_addr = bind_addr.clone();
        let handle = tokio::spawn(async move {
            eprintln!("bento-daemon phone server on http://{log_addr}");
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.wait_for(|v| *v).await;
                })
                .await;
        });

        *self.0.active.lock().unwrap() = Some(ActiveRemote { info: info.clone(), handle, shutdown_tx });
        Ok(info)
    }

    pub fn stop(&self) {
        self.0.generation.fetch_add(1, Ordering::SeqCst);
        *self.0.active.lock().unwrap() = None;
    }

    pub fn status(&self) -> RemoteInfo {
        let mut guard = self.0.active.lock().unwrap();
        if let Some(active) = &*guard {
            if !active.handle.is_finished() {
                return active.info.clone();
            }
        }
        *guard = None;
        RemoteInfo { running: false, addr: String::new(), token: String::new(), url: String::new() }
    }
}

// ── Token generation ─────────────────────────────────────────────────────────

pub fn generate_token() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::getrandom(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── IP detection ─────────────────────────────────────────────────────────────

struct BindResolution {
    bind_host: String,
    display_ip: String,
}

fn resolve_bind_ip(use_tailscale: bool, tailscale_ip: Option<String>, lan_ip: String) -> BindResolution {
    match (use_tailscale, tailscale_ip) {
        (true, Some(ts_ip)) => BindResolution { bind_host: ts_ip.clone(), display_ip: ts_ip },
        _ => BindResolution { bind_host: lan_ip.clone(), display_ip: lan_ip },
    }
}

fn local_ip() -> String {
    use std::net::UdpSocket;
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| { s.connect("8.8.8.8:80")?; s.local_addr() })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

/// `Command::new("tailscale")` relies on PATH, but a GUI-launched macOS app
/// (Finder/Launchpad/Dock) gets launchd's minimal PATH — `/usr/bin:/bin:/usr/sbin:/sbin` —
/// which doesn't include where the CLI actually lives, so the plain name is
/// never found there. Check the well-known install locations directly first.
fn tailscale_binary() -> std::path::PathBuf {
    for candidate in ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"] {
        if std::path::Path::new(candidate).exists() {
            return candidate.into();
        }
    }
    "tailscale".into()
}

pub fn tailscale_ip() -> Option<String> {
    let output = std::process::Command::new(tailscale_binary())
        .args(["ip", "-4"])
        .output()
        .ok()?;
    let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() && !ip.is_empty() { Some(ip) } else { None }
}

// ── HTTP server state ─────────────────────────────────────────────────────────

#[derive(Clone)]
pub(super) struct RemoteState {
    pub manager: PtyManager,
    pub token: String,
    pub herdr_socket: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct Auth {
    pub token: Option<String>,
}

pub(super) fn authorized(state: &RemoteState, auth: &Auth) -> bool {
    !state.token.is_empty() && auth.token.as_deref() == Some(state.token.as_str())
}

// ── Handlers ──────────────────────────────────────────────────────────────────

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

fn git_branch(cwd: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if out.status.success() {
        let b = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !b.is_empty() && b != "HEAD" { Some(b) } else { None }
    } else {
        None
    }
}

async fn terminals(
    State(state): State<Arc<RemoteState>>,
    Query(auth): Query<Auth>,
) -> impl IntoResponse {
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let list: Vec<_> = state
        .manager
        .list()
        .into_iter()
        .map(|info| {
            let branch = if info.cwd.is_empty() { None } else { git_branch(&info.cwd) };
            json!({ "id": info.id, "title": info.title, "cwd": info.cwd, "branch": branch })
        })
        .collect();
    Json(list).into_response()
}

async fn kill_terminal(
    State(state): State<Arc<RemoteState>>,
    Path(id): Path<String>,
    Query(auth): Query<Auth>,
) -> impl IntoResponse {
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    match state.manager.close(&id) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn new_terminal(
    State(state): State<Arc<RemoteState>>,
    Query(auth): Query<Auth>,
) -> impl IntoResponse {
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let id = format!("pty-mobile-{}", uuid_v4());
    let mut env = vec![];
    if let Some(socket) = &state.herdr_socket {
        env.push(("HERDR_ENV".into(), "1".into()));
        env.push(("HERDR_SOCKET_PATH".into(), socket.clone()));
        env.push(("HERDR_PANE_ID".into(), id.clone()));
    }
    let opts = bento_core::OpenOptions {
        id: Some(id.clone()),
        shell: Some(shell),
        cwd: Some(home),
        rows: 24,
        cols: 80,
        env,
        ..Default::default()
    };
    match state.manager.open(opts) {
        Ok((id, _)) => Json(json!({ "id": id })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().subsec_nanos();
    format!("{:08x}", t)
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<RemoteState>>,
    Path(id): Path<String>,
    Query(auth): Query<Auth>,
) -> impl IntoResponse {
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let manager = state.manager.clone();
    ws.on_upgrade(move |socket| bridge(socket, manager, id))
}

async fn bridge(socket: WebSocket, manager: PtyManager, id: String) {
    let Some(mut rx) = manager.subscribe(&id) else { return };
    let (mut sender, mut receiver) = socket.split();

    if let Some(scrollback) = manager.scrollback(&id) {
        if !scrollback.is_empty() && sender.send(Message::Text(scrollback)).await.is_err() {
            return;
        }
    }

    let outgoing = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(PtyEvent::Output(text)) => {
                    if sender.send(Message::Text(text)).await.is_err() { break; }
                }
                Ok(PtyEvent::TitleChanged(title)) => {
                    let msg = format!("{{\"type\":\"title\",\"value\":{}}}", serde_json::json!(title));
                    if sender.send(Message::Text(msg)).await.is_err() { break; }
                }
                Ok(PtyEvent::Exit(_)) => {
                    let _ = sender.send(Message::Text(r#"{"type":"exit"}"#.into())).await;
                    break;
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });

    while let Some(Ok(message)) = receiver.next().await {
        match message {
            Message::Text(text) => {
                if let Ok(ctrl) = serde_json::from_str::<serde_json::Value>(&text) {
                    if ctrl.get("type").and_then(serde_json::Value::as_str) == Some("resize") {
                        let rows = ctrl.get("rows").and_then(serde_json::Value::as_u64).unwrap_or(24) as u16;
                        let cols = ctrl.get("cols").and_then(serde_json::Value::as_u64).unwrap_or(80) as u16;
                        let _ = manager.resize(&id, rows, cols);
                    } else {
                        let _ = manager.write(&id, &text);
                    }
                } else {
                    let _ = manager.write(&id, &text);
                }
            }
            Message::Binary(bytes) => {
                if let Ok(text) = std::str::from_utf8(&bytes) { let _ = manager.write(&id, text); }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    outgoing.abort();
}

// ── /api/projects ─────────────────────────────────────────────────────────────

async fn projects_handler(
    State(state): State<Arc<RemoteState>>,
    Query(auth): Query<Auth>,
) -> impl IntoResponse {
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let mut seen = std::collections::HashSet::new();
    let list: Vec<_> = state
        .manager
        .list()
        .into_iter()
        .filter(|info| !info.cwd.is_empty())
        .filter(|info| seen.insert(info.cwd.clone()))
        .map(|info| {
            let branch = git_branch(&info.cwd);
            json!({ "cwd": info.cwd, "branch": branch })
        })
        .collect();
    Json(list).into_response()
}

// ── /api/fs/dirs ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct FsDirsQuery {
    token: Option<String>,
    path: Option<String>,
}

async fn fs_dirs_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<FsDirsQuery>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let path = q.path.filter(|s| !s.is_empty()).unwrap_or(home);
    let current = std::path::Path::new(&path);
    let parent = current.parent().map(|p| p.to_string_lossy().into_owned());
    let mut dirs: Vec<String> = std::fs::read_dir(&path)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    dirs.sort();
    Json(json!({ "path": path, "dirs": dirs, "parent": parent })).into_response()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_mode_binds_to_lan_ip_only() {
        let r = resolve_bind_ip(false, Some("100.64.0.1".into()), "192.168.1.10".into());
        assert_eq!(r.bind_host, "192.168.1.10");
        assert_eq!(r.display_ip, "192.168.1.10");
    }

    #[test]
    fn tailscale_mode_binds_to_tailscale_ip() {
        let r = resolve_bind_ip(true, Some("100.64.0.1".into()), "192.168.1.10".into());
        assert_eq!(r.bind_host, "100.64.0.1");
        assert_eq!(r.display_ip, "100.64.0.1");
    }

    #[test]
    fn tailscale_mode_falls_back_to_lan_when_unavailable() {
        let r = resolve_bind_ip(true, None, "192.168.1.10".into());
        assert_eq!(r.bind_host, "192.168.1.10");
        assert_eq!(r.display_ip, "192.168.1.10");
    }

    #[test]
    fn mobile_html_references_split_assets() {
        assert!(MOBILE_HTML.contains(r#"href="/shared.css""#));
        assert!(MOBILE_HTML.contains(r#"href="/terminal.css""#));
        assert!(MOBILE_HTML.contains(r#"href="/review.css""#));
        assert!(MOBILE_HTML.contains(r#"src="/shared.js""#));
        assert!(MOBILE_HTML.contains(r#"src="/terminal.js""#));
        assert!(MOBILE_HTML.contains(r#"src="/review.js""#));
        assert!(!MOBILE_HTML.contains("<style>"));
        assert!(!MOBILE_HTML.contains("function switchTab"));
    }

    #[test]
    fn split_assets_contain_expected_functions() {
        assert!(SHARED_JS.contains("function switchTab"));
        assert!(SHARED_JS.contains("function esc"));
        assert!(TERMINAL_JS.contains("function attach"));
        assert!(TERMINAL_JS.contains("function connect"));
        assert!(REVIEW_JS.contains("function startReview"));
        assert!(REVIEW_JS.contains("function loadPRs"));
        assert!(SHARED_CSS.contains("#tabbar"));
        assert!(TERMINAL_CSS.contains("#tcon"));
        assert!(REVIEW_CSS.contains("#rv-output"));
    }
}
