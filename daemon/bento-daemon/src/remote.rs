//! Phone remote: token-gated HTTP + WebSocket server that lets a browser (your
//! phone) attach to the daemon's terminals. Opt-in — only started when the
//! caller explicitly calls `RemoteControl::start`.

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, StatusCode},
    response::{Html, IntoResponse, Json, Response},
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
        // Signal graceful shutdown first — axum releases the listening socket.
        let _ = self.shutdown_tx.send(true);
        // Hard abort so we don't wait for connections to drain.
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
    /// Start the server on `0.0.0.0:<port>`. If already running, returns
    /// the existing info without restarting.
    pub async fn start(&self, manager: PtyManager, port: u16, token: Option<String>, use_tailscale: bool, herdr_socket: Option<String>) -> Result<RemoteInfo, String> {
        // Fast path: server is already healthy.
        {
            let guard = self.0.active.lock().unwrap();
            if let Some(active) = &*guard {
                if !active.handle.is_finished() {
                    return Ok(active.info.clone());
                }
            }
        }

        // Claim a generation slot. If stop() or a concurrent start() bumps the
        // counter before the bind finishes, we'll see it and abort.
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

        // stop() was called while we were binding — discard our new server.
        if self.0.generation.load(Ordering::SeqCst) != gen + 1 {
            return Ok(RemoteInfo { running: false, addr: String::new(), token: String::new(), url: String::new() });
        }

        let state = Arc::new(RemoteState { manager, token, herdr_socket });
        let app = Router::new()
            .route("/", get(index))
            .route("/api/terminals", get(terminals))
            .route("/api/terminals", post(new_terminal))
            .route("/api/terminals/:id", delete(kill_terminal))
            .route("/api/projects", get(projects_handler))
            .route("/api/review", get(review_handler))
            .route("/ws/:id", get(ws_handler))
            .with_state(state);

        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let log_addr = bind_addr.clone();
        let handle = tokio::spawn(async move {
            eprintln!("bento-daemon phone server on http://{log_addr}");
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    // Wait until the shutdown_tx sends true (or is dropped).
                    let _ = shutdown_rx.wait_for(|v| *v).await;
                })
                .await;
        });

        *self.0.active.lock().unwrap() = Some(ActiveRemote { info: info.clone(), handle, shutdown_tx });
        Ok(info)
    }

    pub fn stop(&self) {
        // Bump generation to invalidate any start() that is still binding.
        self.0.generation.fetch_add(1, Ordering::SeqCst);
        // Drop aborts the handle immediately, freeing the port.
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
    /// Address the TCP listener binds to (e.g. "0.0.0.0" or "100.64.0.1").
    bind_host: String,
    /// IP shown in the URL/QR code.
    display_ip: String,
}

/// Choose bind host and display IP based on whether Tailscale mode is requested.
/// - LAN mode: bind to LAN IP only (Tailscale traffic blocked).
/// - Tailscale mode + IP found: bind Tailscale IP (only reachable via Tailscale).
/// - Tailscale mode + no IP: fall back to LAN.
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

/// Returns the Tailscale IPv4 address if Tailscale is installed and connected.
pub fn tailscale_ip() -> Option<String> {
    let output = std::process::Command::new("tailscale")
        .args(["ip", "-4"])
        .output()
        .ok()?;
    let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() && !ip.is_empty() { Some(ip) } else { None }
}

// ── Internal HTTP server ──────────────────────────────────────────────────────

#[derive(Clone)]
struct RemoteState {
    manager: PtyManager,
    token: String,
    herdr_socket: Option<String>,
}

#[derive(Deserialize)]
struct Auth {
    token: Option<String>,
}

fn authorized(state: &RemoteState, auth: &Auth) -> bool {
    !state.token.is_empty() && auth.token.as_deref() == Some(state.token.as_str())
}

async fn index(State(state): State<Arc<RemoteState>>, Query(auth): Query<Auth>) -> impl IntoResponse {
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    Html(MOBILE_HTML).into_response()
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
                // Control message: {"type":"resize","rows":N,"cols":N}
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

// ── /api/review (SSE) ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ReviewQuery {
    token: Option<String>,
    cwd: Option<String>,
    base: Option<String>,
}

async fn review_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<ReviewQuery>,
) -> Response {
    let auth = Auth { token: q.token };
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd {
        Some(c) if !c.is_empty() => c,
        _ => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let base = q.base.unwrap_or_else(|| "main".into());

    let (tx, rx) = tokio::sync::mpsc::channel::<String>(64);
    tokio::spawn(async move {
        run_review(cwd, base, tx).await;
    });

    let stream = tokio_stream::wrappers::ReceiverStream::new(rx)
        .map(|chunk| -> Result<axum::body::Bytes, std::convert::Infallible> {
            Ok(axum::body::Bytes::from(format!("data: {}\n\n", chunk)))
        });

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("X-Accel-Buffering", "no")
        .body(Body::from_stream(stream))
        .unwrap()
}

async fn run_review(cwd: String, base: String, tx: tokio::sync::mpsc::Sender<String>) {
    let send = |msg: String| {
        let tx = tx.clone();
        async move { let _ = tx.send(msg).await; }
    };

    let diff_out = match tokio::process::Command::new("git")
        .args(["-C", &cwd, "diff", &format!("{}...HEAD", base)])
        .output()
        .await
    {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        Ok(o) => {
            send(format!("[ERROR] git diff falló: {}", String::from_utf8_lossy(&o.stderr).trim())).await;
            return;
        }
        Err(e) => { send(format!("[ERROR] no se pudo ejecutar git: {e}")).await; return; }
    };

    if diff_out.trim().is_empty() {
        send("[ERROR] No hay cambios respecto a la rama base.".into()).await;
        return;
    }

    let prompt = build_review_prompt(&cwd, &base, &diff_out);

    let mut child = match tokio::process::Command::new("claude")
        .args(["-p", &prompt, "--output-format", "stream-json", "--allowedTools", "Read,Glob,Grep"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => { send(format!("[ERROR] claude no encontrado: {e}")).await; return; }
    };

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => { send("[ERROR] no se pudo leer stdout de claude".into()).await; return; }
    };

    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        // stream-json format: extract text from message content blocks
        if let Some(content) = val.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
            for block in content {
                if block.get("type").and_then(serde_json::Value::as_str) == Some("text") {
                    if let Some(text) = block.get("text").and_then(serde_json::Value::as_str) {
                        if !text.is_empty() {
                            send(text.to_string()).await;
                        }
                    }
                }
            }
        }
    }

    let _ = child.wait().await;
    send("[DONE]".into()).await;
}

fn build_review_prompt(cwd: &str, base: &str, diff: &str) -> String {
    let project = std::path::Path::new(cwd)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| cwd.to_string());

    format!(
        r#"Eres un revisor de código experto. Analiza el siguiente diff de git para el proyecto "{project}" (cambios desde la rama "{base}") y produce un informe de revisión técnica completo en español.

Evalúa TODOS los aspectos siguientes. Para cada uno, escribe un encabezado de nivel 2 (##) y lista los hallazgos con viñetas. Si no hay problemas en algún aspecto, escribe "Sin problemas detectados." en lugar de omitirlo.

## Corrección y lógica
Busca errores de lógica, condiciones incorrectas, casos borde no manejados, valores nulos sin comprobar, índices fuera de rango, desbordamientos, conversiones de tipo incorrectas.

## Seguridad
Busca inyección SQL/NoSQL/shell, XSS, CSRF, autenticación o autorización incorrecta, exposición de datos sensibles, secretos en código, deserialización insegura, path traversal, dependencias vulnerables.

## Cambios que rompen compatibilidad
Identifica cambios en APIs públicas, contratos de serialización, esquemas de base de datos, eventos o mensajes IPC, que puedan romper llamadores existentes.

## Rendimiento
Busca consultas N+1, asignaciones innecesarias en bucles críticos, bloqueos en el hilo principal, uso excesivo de memoria, operaciones de I/O bloqueantes en contextos async.

## Manejo de errores
Comprueba que los errores se propagan o registran correctamente, que no se silencian con unwrap/expect sin justificación, que los recursos se liberan aunque falle la operación.

## Concurrencia
Detecta condiciones de carrera, deadlocks potenciales, variables compartidas sin protección, uso incorrecto de primitivas de sincronización.

## Calidad del código
Señala duplicación evitable, abstracciones mal nombradas, funciones que hacen demasiado, código muerto, comentarios engañosos.

## Cobertura de tests
Indica qué lógica nueva carece de tests, qué casos borde deberían cubrirse, y si los tests existentes siguen siendo válidos tras los cambios.

---

DIFF:
```diff
{diff}
```

Escribe el informe directamente, sin preámbulo. Empieza con:

## Corrección y lógica"#,
        project = project,
        base = base,
        diff = diff,
    )
}

const MOBILE_HTML: &str = r#"<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<title>Bento</title>
<link rel="stylesheet" href="https://unpkg.com/xterm@5.3.0/css/xterm.css">
<script src="https://unpkg.com/xterm@5.3.0/lib/xterm.js"></script>
<script src="https://unpkg.com/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{--bg:#0d0d0d;--s:#161616;--s2:#1e1e1e;--b:#2a2a2a;--a:#a78bfa;--ag:#73daca;--re:#f7768e;--fg:#e2e8f8;--dim:#555}
html,body{height:100%;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,sans-serif;overflow:hidden;touch-action:none}

/* ── Tab bar ──────────────────────────── */
#tabbar{display:flex;height:44px;background:var(--s);border-bottom:1px solid var(--b);flex-shrink:0}
.tab{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px;font-weight:600;color:var(--dim);border:none;background:none;cursor:pointer;border-bottom:2px solid transparent;transition:color .15s,border-color .15s}
.tab.active{color:var(--a);border-bottom-color:var(--a)}

/* ── Shared list styles ───────────────── */
.list-head{font-size:11px;font-weight:700;letter-spacing:.1em;color:var(--dim);text-transform:uppercase;margin-bottom:14px;padding:0 2px}
.tb{display:flex;align-items:center;gap:12px;width:100%;padding:15px 16px;background:var(--s);border:1px solid var(--b);border-radius:14px;color:var(--fg);text-align:left;margin-bottom:10px;cursor:pointer;transition:background .1s}
.tb:active{background:var(--s2)}
.tb-ico{font-size:22px;flex-shrink:0}
.tb-info{flex:1;min-width:0}
.tb-name{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-cwd{font-size:11px;color:var(--dim);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-arrow{color:var(--dim);font-size:18px;flex-shrink:0}
.empty{padding:40px 16px;text-align:center;color:var(--dim);font-size:14px;line-height:1.6}
.err-msg{color:var(--re)}

/* ── Terminals tab ────────────────────── */
#page-terminals{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}
#list{flex:1;overflow-y:auto;padding:16px 16px 80px;touch-action:pan-y}
#newbtn{position:fixed;bottom:20px;left:16px;right:16px;padding:14px;background:var(--s);border:1px solid var(--b);border-radius:14px;color:var(--fg);font-size:15px;font-weight:600;cursor:pointer;text-align:center;z-index:10}
#newbtn:active{opacity:.7}

/* ── Terminal view ────────────────────── */
#view{display:none;flex-direction:column;height:100dvh}
#view.on{display:flex}
#topbar{display:flex;align-items:center;gap:10px;padding:0 12px;height:48px;background:var(--s);border-bottom:1px solid var(--b);flex-shrink:0}
#back{background:none;border:none;color:var(--a);font-size:26px;padding:4px 6px;cursor:pointer;line-height:1}
#ttitle{flex:1;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#dot{width:8px;height:8px;border-radius:50%;background:var(--ag);flex-shrink:0;transition:background .3s}
#dot.off{background:var(--re)}
#killbtn{background:none;border:none;color:var(--dim);font-size:20px;padding:4px 6px;cursor:pointer;line-height:1;flex-shrink:0}
#killbtn:active{color:var(--re)}
#tcon{flex:1;min-height:0;background:#000;overflow:hidden}
#tcon .xterm,#tcon .xterm-viewport,#tcon .xterm-screen{height:100%!important}
#keys{display:flex;gap:5px;padding:6px 8px;background:var(--s);border-top:1px solid var(--b);overflow-x:auto;flex-shrink:0;scrollbar-width:none}
#keys::-webkit-scrollbar{display:none}
.k{flex-shrink:0;padding:7px 12px;background:var(--bg);border:1px solid var(--b);border-radius:8px;color:var(--fg);font-size:13px;font-family:monospace;cursor:pointer}
.k:active{background:var(--s2);border-color:var(--a)}
#inputbar{display:flex;gap:8px;padding:8px 10px;background:var(--s);border-top:1px solid var(--b);flex-shrink:0}
#inp{flex:1;padding:11px 14px;background:var(--bg);border:1px solid var(--b);border-radius:12px;color:var(--fg);font-size:16px;outline:none;-webkit-appearance:none;caret-color:var(--a)}
#inp:focus{border-color:var(--a)}
#sendbtn{padding:11px 18px;background:var(--a);border:none;border-radius:12px;color:#07070f;font-weight:700;font-size:16px;cursor:pointer}
#sendbtn:active{opacity:.8}

/* ── Review tab ───────────────────────── */
#page-review{display:none;flex-direction:column;flex:1;min-height:0;overflow:hidden}
#page-review.active{display:flex}
#rv-form{padding:16px;display:flex;flex-direction:column;gap:12px;border-bottom:1px solid var(--b);flex-shrink:0}
.rv-label{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin-bottom:4px}
#rv-project{width:100%;padding:11px 14px;background:var(--bg);border:1px solid var(--b);border-radius:12px;color:var(--fg);font-size:15px;outline:none;-webkit-appearance:none}
#rv-project:focus{border-color:var(--a)}
#rv-base{width:100%;padding:11px 14px;background:var(--bg);border:1px solid var(--b);border-radius:12px;color:var(--fg);font-size:15px;outline:none;-webkit-appearance:none;caret-color:var(--a)}
#rv-base:focus{border-color:var(--a)}
#rv-start{width:100%;padding:14px;background:var(--a);border:none;border-radius:12px;color:#07070f;font-size:15px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px}
#rv-start:active{opacity:.8}
#rv-start:disabled{opacity:.4;cursor:default}
#rv-output{flex:1;overflow-y:auto;padding:16px;touch-action:pan-y}
#rv-output.empty-state{display:flex;align-items:center;justify-content:center}
.rv-placeholder{text-align:center;color:var(--dim);font-size:14px;line-height:1.7}
/* Markdown render */
.rv-md h2{font-size:16px;font-weight:700;color:var(--a);margin:20px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--b)}
.rv-md h2:first-child{margin-top:0}
.rv-md h3{font-size:14px;font-weight:600;color:var(--fg);margin:14px 0 6px}
.rv-md p{font-size:14px;line-height:1.65;margin-bottom:10px;color:var(--fg)}
.rv-md ul,.rv-md ol{padding-left:20px;margin-bottom:10px}
.rv-md li{font-size:14px;line-height:1.6;color:var(--fg);margin-bottom:4px}
.rv-md code{font-family:Menlo,Monaco,monospace;font-size:12px;background:var(--s2);border:1px solid var(--b);padding:1px 5px;border-radius:4px;color:var(--ag)}
.rv-md pre{background:var(--s);border:1px solid var(--b);border-radius:10px;padding:12px;overflow-x:auto;margin-bottom:12px}
.rv-md pre code{background:none;border:none;padding:0;color:var(--fg);font-size:12px}
.rv-md strong{font-weight:700;color:var(--fg)}
.rv-md em{font-style:italic;color:var(--dim)}
.rv-spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(0,0,0,.3);border-top-color:#07070f;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body style="display:flex;flex-direction:column;height:100dvh">

<!-- Tab bar -->
<div id="tabbar">
  <button class="tab active" onclick="switchTab('terminals')">⬛ Terminales</button>
  <button class="tab" onclick="switchTab('review')">🔍 Review</button>
</div>

<!-- Terminals page -->
<div id="page-terminals" style="display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden">
  <div id="list" style="flex:1;overflow-y:auto;padding:16px 16px 80px;touch-action:pan-y"></div>
  <button id="newbtn" onclick="newTerminal()">+ Nueva terminal</button>
</div>

<!-- Terminal view (fullscreen, hides tabs) -->
<div id="view">
  <div id="topbar">
    <button id="back" onclick="goBack()">‹</button>
    <span id="ttitle">Terminal</span>
    <div id="dot" class="off"></div>
    <button id="killbtn" onclick="killTerminal()" title="Cerrar terminal">✕</button>
  </div>
  <div id="tcon"></div>
  <div id="keys">
    <button class="k" onclick="s('\x1b')">Esc</button>
    <button class="k" onclick="s('\t')">Tab</button>
    <button class="k" onclick="s('\x1b[A')">↑</button>
    <button class="k" onclick="s('\x1b[B')">↓</button>
    <button class="k" onclick="s('\x1b[C')">→</button>
    <button class="k" onclick="s('\x1b[D')">←</button>
    <button class="k" onclick="s('\x03')">^C</button>
    <button class="k" onclick="s('\x04')">^D</button>
    <button class="k" onclick="s('\x0c')">^L</button>
    <button class="k" onclick="s('\x1b[H')">Home</button>
    <button class="k" onclick="s('\x1b[F')">End</button>
  </div>
  <div id="inputbar">
    <input id="inp" type="text" placeholder="Escribe…" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
    <button id="sendbtn" onclick="sendInp()">↵</button>
  </div>
</div>

<!-- Review page -->
<div id="page-review" style="display:none;flex-direction:column;flex:1;min-height:0;overflow:hidden">
  <div id="rv-form">
    <div>
      <div class="rv-label">Proyecto</div>
      <select id="rv-project"><option value="">Cargando…</option></select>
    </div>
    <div>
      <div class="rv-label">Rama base</div>
      <input id="rv-base" type="text" value="main" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
    </div>
    <button id="rv-start" onclick="startReview()">Iniciar revisión</button>
  </div>
  <div id="rv-output" class="empty-state">
    <div class="rv-placeholder">Elige un proyecto y una rama base<br>para iniciar la revisión.</div>
  </div>
</div>

<script>
const token=new URLSearchParams(location.search).get('token')||'';
const q='?token='+encodeURIComponent(token);
let ws,term,fit,ro,reconnTimer,reconnDelay,activeId,activeTitle,leaving=false;
let reviewSse=null;

// ── Tab switching ──────────────────────────────────────────────────────────────

function switchTab(name){
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',i===(name==='review'?1:0)));
  const pt=document.getElementById('page-terminals');
  const pr=document.getElementById('page-review');
  if(name==='review'){
    pt.style.display='none';
    pr.style.display='flex';
    loadProjects();
  } else {
    pr.style.display='none';
    pt.style.display='flex';
    load();
  }
}

// ── Terminals ─────────────────────────────────────────────────────────────────

function s(d){if(ws&&ws.readyState===1)ws.send(d)}

function sendInp(){
  const inp=document.getElementById('inp');
  s(inp.value+'\r');
  inp.value='';
  inp.focus();
}

document.getElementById('inp').addEventListener('keydown',e=>{
  if(e.key==='Enter'){e.preventDefault();sendInp()}
});

async function load(){
  const el=document.getElementById('list');
  try{
    const r=await fetch('/api/terminals'+q);
    if(!r.ok){el.innerHTML='<div class="empty err-msg">Token inválido.</div>';return}
    const ts=await r.json();
    if(!ts.length){el.innerHTML='<div class="empty">No hay terminales abiertos.<br>Abre un agente o terminal en Bento.</div>';return}
    el.innerHTML='<div class="list-head">Terminales activos</div>';
    ts.forEach(t=>{
      const b=document.createElement('button');
      b.className='tb';
      const sub=(t.branch?'⎇ '+t.branch+(t.cwd?' · '+t.cwd:''):t.cwd||'');
      b.innerHTML='<span class="tb-ico">⬛</span><div class="tb-info"><div class="tb-name">'+(t.title||t.id)+'</div><div class="tb-cwd">'+sub+'</div></div><span class="tb-arrow">›</span>';
      b.onclick=()=>attach(t.id,t.title||t.id);
      el.appendChild(b);
    });
  }catch(e){el.innerHTML='<div class="empty err-msg">No se pudo conectar al daemon.</div>'}
}

function sendResize(){
  if(ws&&ws.readyState===1&&term)
    ws.send(JSON.stringify({type:'resize',rows:term.rows,cols:term.cols}));
}

function connect(id){
  if(leaving)return;
  const dot=document.getElementById('dot');
  ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws/'+id+q);
  ws.onopen=()=>{dot.className='';reconnDelay=1000;sendResize()};
  ws.onmessage=e=>{
    if(typeof e.data==='string'){
      try{
        const msg=JSON.parse(e.data);
        if(msg.type==='title'){activeTitle=msg.value;document.getElementById('ttitle').textContent=msg.value;return}
        if(msg.type==='exit'){goBack();return}
      }catch(_){}
      term&&term.write(e.data);
    }else{
      term&&term.write(new Uint8Array(e.data));
    }
  };
  ws.onclose=()=>{
    if(leaving)return;
    dot.className='off';
    term&&term.write('\r\n\x1b[33m[reconectando en '+(reconnDelay/1000)+'s…]\x1b[0m\r\n');
    reconnTimer=setTimeout(()=>connect(id),reconnDelay);
    reconnDelay=Math.min(reconnDelay*2,16000);
  };
}

function attach(id,title){
  leaving=false;
  activeId=id;activeTitle=title;
  reconnDelay=1000;
  document.getElementById('page-terminals').style.display='none';
  document.getElementById('tabbar').style.display='none';
  document.getElementById('view').style.display='flex';
  document.getElementById('ttitle').textContent=title;
  document.getElementById('dot').className='off';

  const con=document.getElementById('tcon');
  con.innerHTML='';
  term=new Terminal({fontSize:13,fontFamily:'Menlo,Monaco,"Cascadia Code",monospace',theme:{background:'#000000',foreground:'#e2e8f8',cursor:'#a78bfa',selectionBackground:'#3a3a5c'},convertEol:false,cursorBlink:true,scrollback:2000});
  fit=new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(con);
  fit.fit();
  term.onData(d=>s(d));

  ro=new ResizeObserver(()=>{if(fit){fit.fit();sendResize()}});
  ro.observe(con);
  connect(id);
}

function goBack(){
  leaving=true;
  clearTimeout(reconnTimer);
  if(ro){ro.disconnect();ro=null}
  if(ws){ws.close();ws=null}
  if(term){term.dispose();term=null}
  document.getElementById('view').style.display='none';
  document.getElementById('tabbar').style.display='flex';
  document.getElementById('page-terminals').style.display='flex';
  const nb=document.getElementById('newbtn');
  nb.textContent='+ Nueva terminal';nb.disabled=false;
  load();
}

async function killTerminal(){
  if(!activeId)return;
  const ok=confirm('¿Cerrar "'+activeTitle+'"?');
  if(!ok)return;
  try{ await fetch('/api/terminals/'+encodeURIComponent(activeId)+q,{method:'DELETE'}) }catch(_){}
  goBack();
}

async function newTerminal(){
  const btn=document.getElementById('newbtn');
  btn.textContent='Abriendo…';
  btn.disabled=true;
  try{
    const r=await fetch('/api/terminals'+q,{method:'POST'});
    if(!r.ok){btn.textContent='+ Nueva terminal';btn.disabled=false;return}
    const {id}=await r.json();
    await load();
    attach(id,id);
  }catch(e){btn.textContent='+ Nueva terminal';btn.disabled=false}
}

// ── Review ─────────────────────────────────────────────────────────────────────

async function loadProjects(){
  const sel=document.getElementById('rv-project');
  try{
    const r=await fetch('/api/projects'+q);
    if(!r.ok){sel.innerHTML='<option value="">Sin proyectos</option>';return}
    const ps=await r.json();
    if(!ps.length){sel.innerHTML='<option value="">No hay terminales con cwd</option>';return}
    sel.innerHTML=ps.map(p=>`<option value="${esc(p.cwd)}">${esc(p.cwd)}${p.branch?' (⎇ '+esc(p.branch)+')':''}</option>`).join('');
  }catch(_){sel.innerHTML='<option value="">Error al cargar</option>'}
}

function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

function mdToHtml(text){
  // Fenced code blocks first
  text=text.replace(/```[\w]*\n([\s\S]*?)```/g,(_,c)=>'<pre><code>'+esc(c.trim())+'</code></pre>');
  // Inline code
  text=text.replace(/`([^`]+)`/g,(_,c)=>'<code>'+esc(c)+'</code>');
  // Headings
  text=text.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  text=text.replace(/^## (.+)$/gm,'<h2>$1</h2>');
  text=text.replace(/^# (.+)$/gm,'<h2>$1</h2>');
  // Bold/italic
  text=text.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  text=text.replace(/\*(.+?)\*/g,'<em>$1</em>');
  // Unordered lists
  text=text.replace(/^[-*] (.+)$/gm,'<li>$1</li>');
  text=text.replace(/(<li>.*<\/li>\n?)+/g,'<ul>$&</ul>');
  // Paragraphs (lines not inside blocks)
  text=text.replace(/^(?!<[hup]|<\/|<li)(.+)$/gm,'<p>$1</p>');
  // Blank lines
  text=text.replace(/\n{2,}/g,'');
  return text;
}

function startReview(){
  const cwd=document.getElementById('rv-project').value;
  const base=document.getElementById('rv-base').value.trim()||'main';
  if(!cwd)return;

  if(reviewSse){reviewSse.close();reviewSse=null}

  const out=document.getElementById('rv-output');
  const btn=document.getElementById('rv-start');
  out.className='rv-md';
  out.innerHTML='';
  btn.disabled=true;
  btn.innerHTML='<span class="rv-spinner"></span> Analizando…';

  let buf='';
  const url='/api/review'+q+'&cwd='+encodeURIComponent(cwd)+'&base='+encodeURIComponent(base);
  reviewSse=new EventSource(url);

  reviewSse.onmessage=e=>{
    const data=e.data;
    if(data==='[DONE]'){
      reviewSse.close();reviewSse=null;
      btn.disabled=false;btn.innerHTML='Iniciar revisión';
      return;
    }
    if(data.startsWith('[ERROR]')){
      out.innerHTML='<p class="err-msg">'+esc(data.slice(7).trim())+'</p>';
      reviewSse.close();reviewSse=null;
      btn.disabled=false;btn.innerHTML='Iniciar revisión';
      return;
    }
    buf+=data;
    out.innerHTML=mdToHtml(buf);
    out.scrollTop=out.scrollHeight;
  };
  reviewSse.onerror=()=>{
    reviewSse.close();reviewSse=null;
    btn.disabled=false;btn.innerHTML='Iniciar revisión';
    if(!buf)out.innerHTML='<p class="err-msg">Error de conexión.</p>';
  };
}

// ── Init ───────────────────────────────────────────────────────────────────────
load();
setInterval(()=>{
  const pt=document.getElementById('page-terminals');
  if(pt.style.display!=='none')load();
},3000);
</script>
</body>
</html>"#;

#[cfg(test)]
mod tests {
    use super::*;

    // ── resolve_bind_ip ───────────────────────────────────────────────────────

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

    // ── build_review_prompt ───────────────────────────────────────────────────

    #[test]
    fn prompt_contains_project_name_from_cwd() {
        let p = build_review_prompt("/home/user/mi-proyecto", "main", "diff content");
        assert!(p.contains("mi-proyecto"), "debe incluir el nombre del proyecto");
    }

    #[test]
    fn prompt_contains_base_branch() {
        let p = build_review_prompt("/repo", "develop", "diff content");
        assert!(p.contains("develop"), "debe mencionar la rama base");
    }

    #[test]
    fn prompt_embeds_diff() {
        let diff = "--- a/foo.rs\n+++ b/foo.rs\n@@ -1 +1 @@\n-old\n+new";
        let p = build_review_prompt("/repo", "main", diff);
        assert!(p.contains(diff), "debe incrustar el diff completo");
    }

    #[test]
    fn prompt_covers_all_eight_sections() {
        let p = build_review_prompt("/repo", "main", "x");
        let sections = [
            "Corrección y lógica",
            "Seguridad",
            "Cambios que rompen compatibilidad",
            "Rendimiento",
            "Manejo de errores",
            "Concurrencia",
            "Calidad del código",
            "Cobertura de tests",
        ];
        for s in &sections {
            assert!(p.contains(s), "falta sección: {s}");
        }
    }

    #[test]
    fn prompt_uses_project_basename_not_full_path() {
        let p = build_review_prompt("/home/user/deep/path/proyecto", "main", "x");
        assert!(p.contains("proyecto"));
        assert!(!p.contains("/home/user/deep/path/proyecto"), "no debe aparecer la ruta completa");
    }

    #[test]
    fn prompt_ends_with_first_section_instruction() {
        let p = build_review_prompt("/repo", "main", "x");
        assert!(p.trim_end().ends_with("## Corrección y lógica"), "debe terminar instruyendo con el primer encabezado");
    }
}
