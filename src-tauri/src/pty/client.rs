//! El cliente del daemon: conectar, reenviar su salida al frontend, y
//! arrancar o reemplazar el proceso del daemon cuando hace falta. Aquí no hay
//! comandos de Tauri, solo la conversación con el daemon.

// Terminals live in the bento-daemon (out-of-process) so they survive the app
// closing and can be shared with the CLI and the phone. This module is a thin
// client: it forwards the pty_* commands to the daemon over a single localhost
// connection and re-emits the daemon's output as the `pty-output-<id>` /
// `pty-exit-<id>` events the frontend already listens on.
//!
// `terminal.open` is request/response so `pty_spawn` learns whether it reattached
// to an existing terminal — the caller must then not replay a launch command.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use super::output_batch::{OutputBatch, BATCH_CAP};
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
    /// Serializes connect attempts: the app-startup connect and any command
    /// racing in via `ensure_connected` must not both kill+respawn the daemon
    /// concurrently, or whichever's server lands on the loser's daemon dies
    /// with it (this is why the remote/phone server used to silently die at
    /// startup even though it briefly logged as started).
    connect_lock: tokio::sync::Mutex<()>,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self {
            addr: std::env::var("BENTO_DAEMON_ADDR").unwrap_or_else(|_| "127.0.0.1:7877".into()),
            tx: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            counter: AtomicU64::new(0),
            app: Arc::new(Mutex::new(None)),
            connect_lock: tokio::sync::Mutex::new(()),
        }
    }
}

impl PtyManager {
    /// Connect to the daemon and start forwarding its output to the frontend.
    /// Reuses the daemon already running — whoever started it, CLI or app — so
    /// its terminals and phone server carry on; it is replaced only when its
    /// binary was rebuilt since it started. Safe to call again after a
    /// disconnect — replaces the old connection.
    pub async fn connect(&self, app: AppHandle) -> Result<(), String> {
        let _guard = self.connect_lock.lock().await;
        self.connect_locked(app).await
    }

    async fn connect_locked(&self, app: AppHandle) -> Result<(), String> {
        *self.app.lock().unwrap() = Some(app.clone());

        self.start_daemon_unless_current().await;
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
            let mut reader = BufReader::with_capacity(BATCH_CAP, read_half);
            let mut batch = OutputBatch::default();
            let mut line = String::new();
            loop {
                // Whatever is already in the socket buffer joins the batch; it
                // goes out once the buffer runs dry, so no latency is added.
                let nothing_waiting = reader.buffer().is_empty();
                if batch.is_full() || nothing_waiting {
                    flush_output(&app, &mut batch);
                }
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(event) = value.get("event").and_then(Value::as_str) {
                    if event != "terminal.output" {
                        // Output that came first must paint first (an exit closes the panel).
                        flush_output(&app, &mut batch);
                    }
                    match event {
                        "terminal.output" => {
                            if let (Some(id), Some(data)) = (
                                value.get("pty_id").and_then(Value::as_str),
                                value.get("data").and_then(Value::as_str),
                            ) {
                                batch.push(id, data);
                            }
                        }
                        "terminal.title" => {
                            if let (Some(id), Some(title)) = (
                                value.get("pty_id").and_then(Value::as_str),
                                value.get("title").and_then(Value::as_str),
                            ) {
                                let _ = app.emit(&format!("pty-title-{id}"), title.to_string());
                            }
                        }
                        "terminal.size" => {
                            if let (Some(id), Some(rows), Some(cols)) = (
                                value.get("pty_id").and_then(Value::as_str),
                                value.get("rows").and_then(Value::as_u64),
                                value.get("cols").and_then(Value::as_u64),
                            ) {
                                let _ = app.emit(&format!("pty-size-{id}"), json!({ "rows": rows, "cols": cols }));
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
            flush_output(&app, &mut batch);
            // Daemon disconnected — clear tx so the next request auto-reconnects.
            *tx_slot.lock().unwrap() = None;
        });
        Ok(())
    }

    /// Leave a current daemon alone; stop an outdated one; start one when none
    /// is answering.
    async fn start_daemon_unless_current(&self) {
        match decide(&probe(&self.addr).await) {
            Action::Reuse => return,
            Action::Replace { pid } => stop_daemon(&self.addr, pid).await,
            Action::Start => {}
        }
        spawn_daemon();
        wait_until(&self.addr, true).await;
    }

    /// Reconnect to the daemon if the connection is gone. No-op when already connected.
    /// Guarded by the same lock as `connect` so a command racing in while the
    /// app-startup connect is still in flight waits for it instead of also
    /// kill+respawning the daemon (see `connect_lock` doc comment).
    pub(super) async fn ensure_connected(&self) -> Result<(), String> {
        let _guard = self.connect_lock.lock().await;
        if self.tx.lock().unwrap().is_none() {
            let app = self
                .app
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "bento-daemon not initialized".to_string())?;
            self.connect_locked(app).await?;
        }
        Ok(())
    }

    /// Fire a command with no reply (write/resize/close/subscribe).
    pub(super) fn send(&self, line: String) -> Result<(), String> {
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

    /// Send a command and await its reply. Auto-reconnects if the daemon died.
    pub(super) async fn request(&self, mut command: Value) -> Result<Value, String> {
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

fn flush_output(app: &AppHandle, batch: &mut OutputBatch) {
    for (id, data) in batch.take() {
        let _ = app.emit(&format!("pty-output-{id}"), data);
    }
}

/// What a look at the daemon's port found.
#[derive(Debug, PartialEq)]
enum Probe {
    /// Nothing is listening.
    Absent,
    /// Something is listening but did not answer `daemon.status` in time.
    NoReply,
    /// Its `daemon.status`.
    Answered(Value),
}

#[derive(Debug, PartialEq)]
enum Action {
    Reuse,
    Replace { pid: Option<u32> },
    Start,
}

/// Reuse a daemon that speaks this app's protocol on a current binary. Replace
/// one running a rebuilt binary, another protocol, or too old to say. A daemon
/// that is slow to answer is never replaced: it may be busy, and replacing it
/// would take the user's terminals with it.
fn decide(probe: &Probe) -> Action {
    let status = match probe {
        Probe::Absent => return Action::Start,
        Probe::NoReply => return Action::Reuse,
        Probe::Answered(status) => status,
    };
    let is_stale = status.get("stale").and_then(Value::as_bool).unwrap_or(true);
    let protocol = status.get("protocol").and_then(Value::as_u64);
    let speaks_our_protocol = protocol == Some(u64::from(bento_core::daemon_process::PROTOCOL));
    if !is_stale && speaks_our_protocol {
        return Action::Reuse;
    }
    let pid = status.get("pid").and_then(Value::as_u64).and_then(|pid| u32::try_from(pid).ok());
    Action::Replace { pid }
}

/// Ask the daemon on `addr` for its status, giving a busy one a few chances.
async fn probe(addr: &str) -> Probe {
    for _ in 0..3 {
        let Ok(mut stream) = TcpStream::connect(addr).await else { return Probe::Absent };
        let ask = async {
            stream.write_all(b"{\"id\":\"status\",\"cmd\":\"daemon.status\"}\n").await.ok()?;
            let line = BufReader::new(&mut stream).lines().next_line().await.ok()??;
            serde_json::from_str::<Value>(&line).ok()?.get("data").cloned()
        };
        if let Ok(Some(status)) = tokio::time::timeout(Duration::from_secs(2), ask).await {
            return Probe::Answered(status);
        }
    }
    Probe::NoReply
}

/// Ask the daemon to exit and wait for its port to free; kill that one process
/// if it will not go. Its terminals go with it: they are its child processes.
async fn stop_daemon(addr: &str, pid: Option<u32>) {
    if let Ok(mut stream) = TcpStream::connect(addr).await {
        let _ = stream.write_all(b"{\"id\":\"stop\",\"cmd\":\"daemon.shutdown\"}\n").await;
    }
    if wait_until(addr, false).await {
        return;
    }
    let Some(pid) = pid else {
        eprintln!("bento: the old daemon did not stop and did not say its pid");
        return;
    };
    kill_process(pid);
    wait_until(addr, false).await;
}

fn kill_process(pid: u32) {
    #[cfg(unix)]
    let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).status();
    #[cfg(windows)]
    let _ = std::process::Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).status();
}

/// Poll for up to four seconds until the daemon is answering (or has
/// stopped answering); reports whether it got there.
async fn wait_until(addr: &str, answering: bool) -> bool {
    for _ in 0..40 {
        if TcpStream::connect(addr).await.is_ok() == answering {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// Launch the daemon detached, so it keeps serving the CLI and the phone after
/// the app quits.
fn spawn_daemon() {
    let Some(binary) = daemon_binary() else {
        eprintln!("bento: bento-daemon binary not found");
        return;
    };
    match bento_core::daemon_process::spawn_detached(std::process::Command::new(binary)) {
        // Reap it if it exits while the app is still open, so it does not
        // linger as a zombie; once the app quits, launchd/init adopts it.
        Ok(mut child) => {
            std::thread::spawn(move || child.wait());
        }
        Err(error) => eprintln!("bento: could not start bento-daemon ({error})"),
    }
}

/// Locate the bento-daemon binary: explicit override → bundled sidecar → dev workspace.
/// Tauri's `externalBin` staging needs the `-<target-triple>` suffix on the
/// source file (see `scripts/build-daemon-sidecar.mjs`) to disambiguate
/// multi-arch builds, but strips it when copying into the final per-platform
/// bundle — so the packaged binary sits right next to the app executable
/// under the plain name, same as `name` below.
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
    // El del árbol de desarrollo primero, cuando existe. Al lado del ejecutable
    // hay una copia que solo se refresca al empaquetar (el sidecar), así que en
    // desarrollo se quedaba vieja y la app resucitaba ese daemon: recompilabas,
    // reiniciabas, y seguías hablando con el de hace tres horas. En una app
    // instalada esta ruta no existe y manda la copia de al lado, que es la buena.
    if let Some(dev) = dev_daemon(dir, name) {
        return Some(dev);
    }
    let bundled = dir.join(name);
    bundled.exists().then_some(bundled)
}

/// `<repo>/src-tauri/target/<profile>/` → `<repo>/daemon/target/<profile>/`.
fn dev_daemon(dir: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use bento_core::daemon_process::PROTOCOL;

    fn status(body: Value) -> Probe {
        Probe::Answered(body)
    }

    #[test]
    fn a_current_daemon_is_reused() {
        let probe = status(json!({ "stale": false, "protocol": PROTOCOL, "pid": 7 }));
        assert_eq!(decide(&probe), Action::Reuse);
    }

    #[test]
    fn a_daemon_running_a_rebuilt_binary_is_replaced() {
        let probe = status(json!({ "stale": true, "protocol": PROTOCOL, "pid": 7 }));
        assert_eq!(decide(&probe), Action::Replace { pid: Some(7) });
    }

    /// A daemon started from another build (the CLI's, say) is not stale by
    /// its own binary, but it may not understand what this app sends.
    #[test]
    fn a_daemon_speaking_another_protocol_is_replaced() {
        let probe = status(json!({ "stale": false, "protocol": PROTOCOL - 1, "pid": 7 }));
        assert_eq!(decide(&probe), Action::Replace { pid: Some(7) });
    }

    /// Daemons from before `stale`/`protocol` existed cannot say, and they are old code.
    #[test]
    fn a_daemon_that_cannot_tell_is_replaced() {
        assert_eq!(decide(&status(json!({ "terminals": 2 }))), Action::Replace { pid: None });
    }

    /// Slow is not dead: a busy daemon holds the user's terminals.
    #[test]
    fn a_daemon_that_does_not_answer_in_time_is_left_alone() {
        assert_eq!(decide(&Probe::NoReply), Action::Reuse);
    }

    #[test]
    fn with_no_daemon_one_is_started() {
        assert_eq!(decide(&Probe::Absent), Action::Start);
    }
}
