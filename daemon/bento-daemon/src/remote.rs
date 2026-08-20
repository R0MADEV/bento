//! Phone remote: an HTTP + WebSocket server that lets a browser (your phone)
//! attach to the daemon's terminals over the LAN. Token-gated. Opt-in — only
//! started when BENTO_REMOTE_ADDR is set. Because this exposes terminal control
//! to the network, every route requires the exact token.

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
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::broadcast;

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

/// 16 random bytes as hex — the token the phone must present.
pub fn generate_token() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::getrandom(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub async fn serve(addr: &str, manager: PtyManager, token: String) -> std::io::Result<()> {
    let state = Arc::new(RemoteState { manager, token });
    let app = Router::new()
        .route("/", get(index))
        .route("/api/terminals", get(terminals))
        .route("/ws/:id", get(ws_handler))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    eprintln!("bento-daemon phone server on http://{addr}");
    axum::serve(listener, app).await
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

/// Pump terminal output → WebSocket and WebSocket input → terminal.
async fn bridge(socket: WebSocket, manager: PtyManager, id: String) {
    let Some(mut rx) = manager.subscribe(&id) else {
        return;
    };
    let (mut sender, mut receiver) = socket.split();

    // Prime with recent output so the phone isn't blank.
    if let Some(scrollback) = manager.scrollback(&id) {
        if !scrollback.is_empty() && sender.send(Message::Text(scrollback)).await.is_err() {
            return;
        }
    }

    let outgoing = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(PtyEvent::Output(text)) => {
                    if sender.send(Message::Text(text)).await.is_err() {
                        break;
                    }
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
                let _ = manager.write(&id, &text);
            }
            Message::Binary(bytes) => {
                if let Ok(text) = std::str::from_utf8(&bytes) {
                    let _ = manager.write(&id, text);
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    outgoing.abort();
}

const MOBILE_HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Bento</title>
<link rel="stylesheet" href="https://unpkg.com/xterm@5.3.0/css/xterm.css">
<script src="https://unpkg.com/xterm@5.3.0/lib/xterm.js"></script>
<style>
body{margin:0;background:#0d0d0d;color:#eee;font-family:system-ui,-apple-system,sans-serif}
#list{padding:12px}#list h3{margin:6px 4px}
button{display:block;width:100%;text-align:left;margin:6px 0;padding:14px;background:#1c1c1c;color:#eee;border:1px solid #333;border-radius:10px;font-size:15px}
#view{display:none;height:100vh;flex-direction:column}#term{flex:1;min-height:0;padding:4px}
#bar{display:flex;gap:6px;padding:6px;background:#000}
#bar input{flex:1;padding:12px;background:#1c1c1c;color:#eee;border:1px solid #333;border-radius:8px;font-size:16px}
#bar button{width:auto;margin:0;padding:12px 14px}
.err{padding:16px;color:#f88}
</style></head><body>
<div id="list"></div>
<div id="view"><div id="term"></div>
<div id="bar"><button onclick="location.reload()">↩</button><input id="in" placeholder="escribe y Enter" autocapitalize="off" autocorrect="off"><button onclick="send('')">^C</button></div></div>
<script>
const token=new URLSearchParams(location.search).get('token')||'';
const q='?token='+encodeURIComponent(token);
let ws,term;
function send(d){if(ws&&ws.readyState===1)ws.send(d)}
async function load(){
  const l=document.getElementById('list');
  try{
    const r=await fetch('/api/terminals'+q);
    if(!r.ok){l.innerHTML='<div class=err>Token inválido o daemon sin sesión.</div>';return}
    const ts=await r.json();
    l.innerHTML='<h3>Terminales</h3>';
    if(!ts.length)l.innerHTML+='<div class=err>No hay terminales abiertos.</div>';
    ts.forEach(t=>{const b=document.createElement('button');b.textContent=(t.title||t.id)+'  ·  '+(t.cwd||'');b.onclick=()=>attach(t.id);l.appendChild(b)});
  }catch(e){l.innerHTML='<div class=err>No se pudo conectar.</div>'}
}
function attach(id){
  document.getElementById('list').style.display='none';
  const v=document.getElementById('view');v.style.display='flex';
  term=new Terminal({fontSize:12,convertEol:false,cursorBlink:true});
  term.open(document.getElementById('term'));
  ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws/'+id+q);
  ws.onmessage=e=>term.write(e.data);
  ws.onclose=()=>term.write('\r\n[desconectado]\r\n');
  term.onData(d=>send(d));
  const inp=document.getElementById('in');
  inp.onkeydown=e=>{if(e.key==='Enter'){send(inp.value+'\r');inp.value='';e.preventDefault()}};
}
load();
</script></body></html>"#;
