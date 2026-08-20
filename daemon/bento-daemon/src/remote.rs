//! Phone remote: token-gated HTTP + WebSocket server that lets a browser (your
//! phone) attach to the daemon's terminals. Opt-in — only started when the
//! caller explicitly calls `RemoteControl::start`.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::StatusCode,
    response::{Html, IntoResponse, Json},
    routing::get,
    Router,
};
use bento_core::{PtyEvent, PtyManager};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;
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
}

impl Drop for ActiveRemote {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Shared handle to the optional phone HTTP server. Clone-cheap (Arc inside).
#[derive(Clone, Default)]
pub struct RemoteControl(Arc<Mutex<Option<ActiveRemote>>>);

impl RemoteControl {
    /// Start the server on `0.0.0.0:<port>`. If already running, returns
    /// the existing info without restarting.
    pub fn start(&self, manager: PtyManager, port: u16, token: Option<String>) -> Result<RemoteInfo, String> {
        let mut guard = self.0.lock().unwrap();
        if let Some(active) = &*guard {
            return Ok(active.info.clone());
        }
        let token = token.unwrap_or_else(generate_token);
        let ip = local_ip();
        let bind_addr = format!("0.0.0.0:{port}");
        let url = format!("http://{}:{}/?token={}", ip, port, token);
        let info = RemoteInfo {
            running: true,
            addr: format!("{}:{}", ip, port),
            token: token.clone(),
            url,
        };

        let std_listener = std::net::TcpListener::bind(&bind_addr).map_err(|e| e.to_string())?;
        std_listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let listener = tokio::net::TcpListener::from_std(std_listener).map_err(|e| e.to_string())?;

        let state = Arc::new(RemoteState { manager, token });
        let app = Router::new()
            .route("/", get(index))
            .route("/api/terminals", get(terminals))
            .route("/ws/:id", get(ws_handler))
            .with_state(state);

        let log_addr = bind_addr.clone();
        let handle = tokio::spawn(async move {
            eprintln!("bento-daemon phone server on http://{log_addr}");
            let _ = axum::serve(listener, app).await;
        });

        *guard = Some(ActiveRemote { info: info.clone(), handle });
        Ok(info)
    }

    pub fn stop(&self) {
        *self.0.lock().unwrap() = None; // Drop aborts the JoinHandle
    }

    pub fn status(&self) -> RemoteInfo {
        match &*self.0.lock().unwrap() {
            Some(a) => a.info.clone(),
            None => RemoteInfo { running: false, addr: String::new(), token: String::new(), url: String::new() },
        }
    }
}

// ── Token generation ─────────────────────────────────────────────────────────

pub fn generate_token() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::getrandom(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── LAN IP detection (no extra crates) ───────────────────────────────────────

fn local_ip() -> String {
    use std::net::UdpSocket;
    // Connecting a UDP socket doesn't send packets; it just picks a route.
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| { s.connect("8.8.8.8:80")?; s.local_addr() })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

// ── Internal HTTP server ──────────────────────────────────────────────────────

#[derive(Clone)]
struct RemoteState {
    manager: PtyManager,
    token: String,
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
        .map(|info| json!({ "id": info.id, "title": info.title, "cwd": info.cwd }))
        .collect();
    Json(list).into_response()
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
                Ok(PtyEvent::Exit(_)) => break,
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
:root{--bg:#0d0d0d;--s:#161616;--s2:#1e1e1e;--b:#2a2a2a;--a:#a78bfa;--fg:#e2e8f8;--dim:#555}
html,body{height:100%;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,sans-serif;overflow:hidden;touch-action:none}

/* ── List ─────────────────────────────── */
#list{height:100dvh;overflow-y:auto;padding:16px;touch-action:pan-y}
.list-head{font-size:11px;font-weight:700;letter-spacing:.1em;color:var(--dim);text-transform:uppercase;margin-bottom:14px;padding:0 2px}
.tb{display:flex;align-items:center;gap:12px;width:100%;padding:15px 16px;background:var(--s);border:1px solid var(--b);border-radius:14px;color:var(--fg);text-align:left;margin-bottom:10px;cursor:pointer;transition:background .1s}
.tb:active{background:var(--s2)}
.tb-ico{font-size:22px;flex-shrink:0}
.tb-info{flex:1;min-width:0}
.tb-name{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-cwd{font-size:11px;color:var(--dim);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-arrow{color:var(--dim);font-size:18px;flex-shrink:0}
.empty{padding:40px 16px;text-align:center;color:var(--dim);font-size:14px;line-height:1.6}
.err-msg{color:#f7768e}

/* ── Terminal view ────────────────────── */
#view{display:none;flex-direction:column;height:100dvh}
#view.on{display:flex}

#topbar{display:flex;align-items:center;gap:10px;padding:0 12px;height:48px;background:var(--s);border-bottom:1px solid var(--b);flex-shrink:0}
#back{background:none;border:none;color:var(--a);font-size:26px;padding:4px 6px;cursor:pointer;line-height:1}
#ttitle{flex:1;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#dot{width:8px;height:8px;border-radius:50%;background:#73daca;flex-shrink:0;transition:background .3s}
#dot.off{background:#f7768e}

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
</style>
</head>
<body>
<div id="list"></div>
<div id="view">
  <div id="topbar">
    <button id="back" onclick="goBack()">‹</button>
    <span id="ttitle">Terminal</span>
    <div id="dot" class="off"></div>
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
<script>
const token=new URLSearchParams(location.search).get('token')||'';
const q='?token='+encodeURIComponent(token);
let ws,term,fit,ro;

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
      b.innerHTML='<span class="tb-ico">⬛</span><div class="tb-info"><div class="tb-name">'+(t.title||t.id)+'</div><div class="tb-cwd">'+(t.cwd||'')+'</div></div><span class="tb-arrow">›</span>';
      b.onclick=()=>attach(t.id,t.title||t.id);
      el.appendChild(b);
    });
  }catch(e){el.innerHTML='<div class="empty err-msg">No se pudo conectar al daemon.</div>'}
}

function sendResize(){
  if(ws&&ws.readyState===1&&term)
    ws.send(JSON.stringify({type:'resize',rows:term.rows,cols:term.cols}));
}

function attach(id,title){
  document.getElementById('list').style.display='none';
  document.getElementById('view').classList.add('on');
  document.getElementById('ttitle').textContent=title;
  const dot=document.getElementById('dot');
  dot.className='off';

  const con=document.getElementById('tcon');
  con.innerHTML='';
  term=new Terminal({fontSize:13,fontFamily:'Menlo,Monaco,"Cascadia Code",monospace',theme:{background:'#000000',foreground:'#e2e8f8',cursor:'#a78bfa',selectionBackground:'#3a3a5c'},convertEol:false,cursorBlink:true,scrollback:2000});
  fit=new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(con);
  fit.fit();

  ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws/'+id+q);
  ws.onopen=()=>{dot.className='';sendResize()};
  ws.onmessage=e=>term.write(typeof e.data==='string'?e.data:new Uint8Array(e.data));
  ws.onclose=()=>{dot.className='off';term.write('\r\n\x1b[31m[desconectado — recarga para reconectar]\x1b[0m\r\n')};
  term.onData(d=>s(d));

  ro=new ResizeObserver(()=>{if(fit){fit.fit();sendResize()}});
  ro.observe(con);
}

function goBack(){
  if(ro){ro.disconnect();ro=null}
  if(ws){ws.close();ws=null}
  if(term){term.dispose();term=null}
  document.getElementById('view').classList.remove('on');
  document.getElementById('list').style.display='';
  load();
}

load();
</script>
</body>
</html>"#;
