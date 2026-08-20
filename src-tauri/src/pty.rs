//! Terminals live in the bento-daemon (out-of-process) so they survive the app
//! closing and can be shared with the CLI and the phone. This module is a thin
//! client: it forwards the pty_* commands to the daemon over a single localhost
//! connection and re-emits the daemon's output as the `pty-output-<id>` /
//! `pty-exit-<id>` events the frontend already listens on.

use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

pub struct PtyManager {
    addr: String,
    tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self {
            addr: std::env::var("BENTO_DAEMON_ADDR").unwrap_or_else(|_| "127.0.0.1:7877".into()),
            tx: Mutex::new(None),
        }
    }
}

impl PtyManager {
    /// Connect to the daemon and start forwarding its output to the frontend.
    /// Starts the daemon automatically if it isn't running yet. Call once at startup.
    pub async fn connect(&self, app: AppHandle) -> Result<(), String> {
        if TcpStream::connect(&self.addr).await.is_err() {
            spawn_daemon();
            for _ in 0..40 {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                if TcpStream::connect(&self.addr).await.is_ok() {
                    break;
                }
            }
        }
        let stream = TcpStream::connect(&self.addr)
            .await
            .map_err(|e| e.to_string())?;
        let (read_half, mut write_half) = stream.into_split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        *self.tx.lock().unwrap() = Some(tx);

        // Single writer task: serialises every outgoing command onto the socket.
        tauri::async_runtime::spawn(async move {
            while let Some(line) = rx.recv().await {
                if write_half.write_all(line.as_bytes()).await.is_err()
                    || write_half.write_all(b"\n").await.is_err()
                {
                    break;
                }
            }
        });

        // Reader task: turn daemon events into the Tauri events the UI expects.
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(read_half).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                match value.get("event").and_then(Value::as_str) {
                    Some("terminal.output") => {
                        if let (Some(id), Some(data)) = (
                            value.get("pty_id").and_then(Value::as_str),
                            value.get("data").and_then(Value::as_str),
                        ) {
                            let _ = app.emit(&format!("pty-output-{id}"), data.to_string());
                        }
                    }
                    Some("terminal.exit") => {
                        if let Some(id) = value.get("pty_id").and_then(Value::as_str) {
                            let _ = app.emit(&format!("pty-exit-{id}"), ());
                        }
                    }
                    _ => {}
                }
            }
        });
        Ok(())
    }

    fn send(&self, line: String) -> Result<(), String> {
        self.tx
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("bento-daemon not connected (is it running?)")?
            .send(line)
            .map_err(|_| "bento-daemon disconnected".to_string())
    }
}

/// Terminals live in the daemon, so app shutdown no longer kills them — they keep
/// running and can be reattached from the CLI, the phone, or a reopened app.
pub fn kill_all(_manager: &PtyManager) {}

/// Launch the daemon as a detached process (it outlives the app, so terminals
/// survive closing it). Best-effort: if the binary can't be found, connect()
/// simply reports the daemon isn't reachable.
fn spawn_daemon() {
    if let Some(binary) = daemon_binary() {
        let _ = std::process::Command::new(binary).spawn();
    }
}

/// Locate the bento-daemon binary: an explicit override, bundled next to the app
/// (production), or the dev workspace target (debug/release).
fn daemon_binary() -> Option<std::path::PathBuf> {
    let name = if cfg!(windows) {
        "bento-daemon.exe"
    } else {
        "bento-daemon"
    };
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
    // Dev layout: <repo>/src-tauri/target/<profile>/  ->  <repo>/daemon/target/<profile>/
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
pub fn pty_spawn(
    id: String,
    // Kept for API compatibility; the daemon resolves $SHELL like the app did.
    #[allow(unused_variables)] shell: String,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    command: Option<Vec<String>>,
    state: tauri::State<Arc<PtyManager>>,
    agent_socket: tauri::State<Arc<crate::agent_socket::AgentSocket>>,
) -> Result<(), String> {
    let env = json!({
        "HERDR_ENV": "1",
        "HERDR_SOCKET_PATH": agent_socket.socket_path,
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
    state.send(open.to_string())?;
    state.send(json!({ "cmd": "terminal.subscribe", "pty_id": id }).to_string())
}

#[tauri::command]
pub fn pty_write(
    id: String,
    data: String,
    state: tauri::State<Arc<PtyManager>>,
) -> Result<(), String> {
    state.send(json!({ "cmd": "terminal.write", "pty_id": id, "data": data }).to_string())
}

#[tauri::command]
pub fn pty_resize(
    id: String,
    rows: u16,
    cols: u16,
    state: tauri::State<Arc<PtyManager>>,
) -> Result<(), String> {
    state.send(json!({ "cmd": "terminal.resize", "pty_id": id, "rows": rows, "cols": cols }).to_string())
}

#[tauri::command]
pub fn pty_kill(id: String, state: tauri::State<Arc<PtyManager>>) -> Result<(), String> {
    state.send(json!({ "cmd": "terminal.close", "pty_id": id }).to_string())
}
