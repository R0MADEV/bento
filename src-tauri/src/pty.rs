//! Terminals live in the bento-daemon (out-of-process) so they survive the app
//! closing and can be shared with the CLI and the phone. This module is a thin
//! client: it forwards the pty_* commands to the daemon over a single localhost
//! connection and re-emits the daemon's output as the `pty-output-<id>` /
//! `pty-exit-<id>` events the frontend already listens on.
//!
//! `terminal.open` is request/response so `pty_spawn` learns whether it reattached
//! to an existing terminal — the caller must then not replay a launch command.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};

pub struct PtyManager {
    addr: String,
    tx: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    counter: AtomicU64,
    /// Stored so `ensure_connected` can reconnect without needing an AppHandle parameter.
    app: Arc<Mutex<Option<AppHandle>>>,
    /// Child handle of the daemon we spawned — used to kill it on shutdown.
    daemon_child: Arc<Mutex<Option<std::process::Child>>>,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self {
            addr: std::env::var("BENTO_DAEMON_ADDR").unwrap_or_else(|_| "127.0.0.1:7877".into()),
            tx: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            counter: AtomicU64::new(0),
            app: Arc::new(Mutex::new(None)),
            daemon_child: Arc::new(Mutex::new(None)),
        }
    }
}

impl PtyManager {
    /// Connect to the daemon and start forwarding its output to the frontend.
    /// Always kills any running daemon first so the freshly compiled binary is used.
    /// Safe to call again after a disconnect — replaces the old connection.
    pub async fn connect(&self, app: AppHandle) -> Result<(), String> {
        *self.app.lock().unwrap() = Some(app.clone());

        // Kill any daemon we started in this session.
        if let Some(mut child) = self.daemon_child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        // Kill any orphaned daemon from a previous session.
        kill_existing_daemon();
        // Brief pause so the port is freed before we try to bind again.
        tokio::time::sleep(Duration::from_millis(300)).await;

        if let Some(child) = spawn_daemon() {
            *self.daemon_child.lock().unwrap() = Some(child);
        }
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if TcpStream::connect(&self.addr).await.is_ok() {
                break;
            }
        }
        let stream = TcpStream::connect(&self.addr)
            .await
            .map_err(|e| e.to_string())?;
        let (read_half, mut write_half) = stream.into_split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        *self.tx.lock().unwrap() = Some(tx);

        tauri::async_runtime::spawn(async move {
            while let Some(line) = rx.recv().await {
                if write_half.write_all(line.as_bytes()).await.is_err()
                    || write_half.write_all(b"\n").await.is_err()
                {
                    break;
                }
            }
        });

        let pending = self.pending.clone();
        let tx_slot = self.tx.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(read_half).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(event) = value.get("event").and_then(Value::as_str) {
                    match event {
                        "terminal.output" => {
                            if let (Some(id), Some(data)) = (
                                value.get("pty_id").and_then(Value::as_str),
                                value.get("data").and_then(Value::as_str),
                            ) {
                                let _ = app.emit(&format!("pty-output-{id}"), data.to_string());
                            }
                        }
                        "terminal.exit" => {
                            if let Some(id) = value.get("pty_id").and_then(Value::as_str) {
                                let _ = app.emit(&format!("pty-exit-{id}"), ());
                            }
                        }
                        _ => {}
                    }
                } else if let Some(id) = value.get("id").and_then(Value::as_str) {
                    if let Some(sender) = pending.lock().unwrap().remove(id) {
                        let _ = sender.send(value);
                    }
                }
            }
            // Daemon disconnected — clear tx so the next request auto-reconnects.
            *tx_slot.lock().unwrap() = None;
        });
        Ok(())
    }

    /// Reconnect to the daemon if the connection is gone. No-op when already connected.
    async fn ensure_connected(&self) -> Result<(), String> {
        if self.tx.lock().unwrap().is_none() {
            let app = self
                .app
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "bento-daemon not initialized".to_string())?;
            self.connect(app).await?;
        }
        Ok(())
    }

    /// Fire a command with no reply (write/resize/close/subscribe).
    fn send(&self, line: String) -> Result<(), String> {
        let result = self
            .tx
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("bento-daemon not connected (is it running?)")?
            .send(line);
        if result.is_err() {
            *self.tx.lock().unwrap() = None;
        }
        result.map_err(|_| "bento-daemon disconnected".to_string())
    }

    /// Kill the daemon process. Reliable even if the IPC channel is gone.
    pub fn send_shutdown(&self) {
        if let Some(mut child) = self.daemon_child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        } else {
            // Fallback: daemon was started by a previous session.
            kill_existing_daemon();
        }
    }

    /// Send a command and await its reply. Auto-reconnects if the daemon died.
    async fn request(&self, mut command: Value) -> Result<Value, String> {
        self.ensure_connected().await?;
        let id = format!("r{}", self.counter.fetch_add(1, Ordering::SeqCst));
        command["id"] = json!(id);
        let (send, recv) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), send);
        self.send(command.to_string())?;
        match tokio::time::timeout(Duration::from_secs(5), recv).await {
            Ok(Ok(value)) => {
                if value.get("ok").and_then(Value::as_bool) == Some(true) {
                    Ok(value.get("data").cloned().unwrap_or(Value::Null))
                } else {
                    Err(value
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("daemon error")
                        .to_string())
                }
            }
            _ => {
                self.pending.lock().unwrap().remove(&id);
                Err("bento-daemon did not respond".into())
            }
        }
    }
}

/// Terminals live in the daemon, so app shutdown no longer kills them.
pub fn kill_all(_manager: &PtyManager) {}

/// Kill any running bento-daemon process.
fn kill_existing_daemon() {
    let _ = std::process::Command::new("pkill").args(["-f", "bento-daemon"]).output();
}

/// Launch the daemon and return the child handle so we can kill it on shutdown.
fn spawn_daemon() -> Option<std::process::Child> {
    daemon_binary().and_then(|b| std::process::Command::new(b).spawn().ok())
}

/// Locate the bento-daemon binary: explicit override → bundled → dev workspace.
fn daemon_binary() -> Option<std::path::PathBuf> {
    let name = if cfg!(windows) { "bento-daemon.exe" } else { "bento-daemon" };
    if let Ok(explicit) = std::env::var("BENTO_DAEMON_BIN") {
        let path = std::path::PathBuf::from(explicit);
        if path.exists() {
            return Some(path);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let bundled = dir.join(name);
    if bundled.exists() {
        return Some(bundled);
    }
    // Dev layout: <repo>/src-tauri/target/<profile>/ → <repo>/daemon/target/<profile>/
    let profile = dir.file_name()?.to_string_lossy().into_owned();
    let candidate = dir
        .parent()? // .../src-tauri/target
        .parent()? // .../src-tauri
        .parent()? // .../<repo>
        .join("daemon")
        .join("target")
        .join(profile)
        .join(name);
    candidate.exists().then_some(candidate)
}

#[tauri::command]
pub async fn pty_spawn(
    id: String,
    #[allow(unused_variables)] shell: String,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    command: Option<Vec<String>>,
    state: tauri::State<'_, Arc<PtyManager>>,
    agent_socket: tauri::State<'_, Arc<crate::agent_socket::AgentSocket>>,
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
) -> Result<RemoteStatus, String> {
    let data = state.request(json!({ "cmd": "remote.start", "port": port.unwrap_or(7879), "token": token, "use_tailscale": use_tailscale.unwrap_or(false) })).await?;
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
#[tauri::command]
pub fn tailscale_detect() -> Option<String> {
    let output = std::process::Command::new("tailscale")
        .args(["ip", "-4"])
        .output()
        .ok()?;
    let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() && !ip.is_empty() { Some(ip) } else { None }
}
