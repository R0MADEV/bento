//! Los comandos de terminal que expone la app. El PTY real vive en el daemon
//! (`bento-core`); esto solo habla con él a través de `client`.

mod client;

pub use client::{kill_all, PtyManager};

use std::sync::Arc;

use serde_json::{json, Value};

#[tauri::command]
pub async fn pty_spawn(
    id: String,
    #[allow(unused_variables)] shell: String,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    command: Option<Vec<String>>,
    title: Option<String>,
    state: tauri::State<'_, Arc<PtyManager>>,
    agent_socket: tauri::State<'_, Arc<crate::agent::socket::AgentSocket>>,
) -> Result<bool, String> {
    let socket_path = agent_socket.socket_path.clone();
    let manager = state.inner().clone();
    let env = json!({
        "HERDR_ENV": "1",
        "HERDR_SOCKET_PATH": socket_path,
        "HERDR_PANE_ID": id,
    });
    let open = json!({
        "cmd": "terminal.open",
        "pty_id": id,
        "title": title,
        "command": command,
        "cwd": cwd,
        "rows": rows,
        "cols": cols,
        "env": env,
    });
    let data = manager.request(open).await?;
    let reattached = data.get("reattached").and_then(Value::as_bool).unwrap_or(false);
    manager.send(json!({ "cmd": "terminal.subscribe", "pty_id": id }).to_string())?;
    Ok(reattached)
}

#[tauri::command]
pub fn pty_set_title(id: String, title: String, state: tauri::State<Arc<PtyManager>>) -> Result<(), String> {
    state.send(json!({ "cmd": "terminal.set_title", "pty_id": id, "title": title }).to_string())
}

#[derive(serde::Serialize)]
pub struct PtyInfo {
    pub id: String,
    pub title: String,
    pub cwd: String,
}

#[tauri::command]
pub async fn pty_list(state: tauri::State<'_, Arc<PtyManager>>) -> Result<Vec<PtyInfo>, String> {
    let data = state.request(json!({ "cmd": "terminals.list" })).await?;
    let list = data.as_array().cloned().unwrap_or_default();
    Ok(list.into_iter().map(|v| PtyInfo {
        id:    v.get("pty_id").and_then(Value::as_str).unwrap_or("").to_string(),
        title: v.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
        cwd:   v.get("cwd").and_then(Value::as_str).unwrap_or("").to_string(),
    }).collect())
}

#[tauri::command]
pub fn pty_write(id: String, data: String, state: tauri::State<Arc<PtyManager>>) -> Result<(), String> {
    state.send(json!({ "cmd": "terminal.write", "pty_id": id, "data": data }).to_string())
}

#[tauri::command]
pub fn pty_resize(id: String, rows: u16, cols: u16, state: tauri::State<Arc<PtyManager>>) -> Result<(), String> {
    state.send(json!({ "cmd": "terminal.resize", "pty_id": id, "rows": rows, "cols": cols }).to_string())
}

#[tauri::command]
pub fn pty_kill(id: String, state: tauri::State<Arc<PtyManager>>) -> Result<(), String> {
    state.send(json!({ "cmd": "terminal.close", "pty_id": id }).to_string())
}

#[derive(serde::Serialize)]
pub struct RemoteStatus {
    pub running: bool,
    pub url: Option<String>,
    pub token: Option<String>,
    pub addr: Option<String>,
}

#[tauri::command]
pub async fn remote_start(
    port: Option<u16>,
    token: Option<String>,
    use_tailscale: Option<bool>,
    state: tauri::State<'_, Arc<PtyManager>>,
    agent_socket: tauri::State<'_, Arc<crate::agent::socket::AgentSocket>>,
) -> Result<RemoteStatus, String> {
    let socket_path = agent_socket.socket_path.clone();
    let data = state.request(json!({ "cmd": "remote.start", "port": port.unwrap_or(7879), "token": token, "use_tailscale": use_tailscale.unwrap_or(false), "herdr_socket": socket_path })).await?;
    Ok(RemoteStatus {
        running: data.get("running").and_then(Value::as_bool).unwrap_or(true),
        url:   data.get("url").and_then(Value::as_str).map(String::from),
        token: data.get("token").and_then(Value::as_str).map(String::from),
        addr:  data.get("addr").and_then(Value::as_str).map(String::from),
    })
}

#[tauri::command]
pub async fn remote_stop(state: tauri::State<'_, Arc<PtyManager>>) -> Result<(), String> {
    state.request(json!({ "cmd": "remote.stop" })).await.map(|_| ())
}

#[tauri::command]
pub async fn remote_status(state: tauri::State<'_, Arc<PtyManager>>) -> Result<RemoteStatus, String> {
    let data = state.request(json!({ "cmd": "remote.status" })).await?;
    Ok(RemoteStatus {
        running: data.get("running").and_then(Value::as_bool).unwrap_or(false),
        url:   data.get("url").and_then(Value::as_str).map(String::from),
        token: data.get("token").and_then(Value::as_str).map(String::from),
        addr:  data.get("addr").and_then(Value::as_str).map(String::from),
    })
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

#[tauri::command]
pub fn tailscale_detect() -> Option<String> {
    let output = std::process::Command::new(tailscale_binary())
        .args(["ip", "-4"])
        .output()
        .ok()?;
    let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() && !ip.is_empty() { Some(ip) } else { None }
}
