mod docker;
mod memory;
mod review;
mod tasks;

use crate::remote::RemoteControl;
use bento_core::{OpenOptions, PtyEvent, PtyManager};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

#[derive(Deserialize)]
pub(crate) struct Request {
    #[serde(default)]
    pub(crate) id: Option<String>,
    pub(crate) cmd: String,
    #[serde(default)]
    pub(crate) pty_id: Option<String>,
    #[serde(default)]
    pub(crate) cwd: Option<String>,
    #[serde(default)]
    pub(crate) shell: Option<String>,
    #[serde(default)]
    pub(crate) command: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) env: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    pub(crate) data: Option<String>,
    #[serde(default)]
    pub(crate) paths: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) force: Option<bool>,
    #[serde(default)]
    pub(crate) rows: Option<u16>,
    #[serde(default)]
    pub(crate) cols: Option<u16>,
    #[serde(default)]
    pub(crate) port: Option<u16>,
    #[serde(default)]
    pub(crate) token: Option<String>,
    #[serde(default)]
    pub(crate) use_tailscale: Option<bool>,
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(default)]
    pub(crate) herdr_socket: Option<String>,
    #[serde(default)]
    pub(crate) base: Option<String>,
    #[serde(default)]
    pub(crate) pr: Option<u64>,
    #[serde(default)]
    pub(crate) comment_id: Option<u64>,
    #[serde(default)]
    pub(crate) event: Option<String>,
    #[serde(default)]
    pub(crate) question: Option<String>,
    #[serde(default)]
    pub(crate) agent: Option<String>,
    #[serde(default)]
    pub(crate) branch: Option<String>,
    #[serde(default)]
    pub(crate) context: Option<String>,
    #[serde(default)]
    pub(crate) agents: Option<String>,
    #[serde(default)]
    pub(crate) content: Option<String>,
    #[serde(default)]
    pub(crate) session_id: Option<String>,
    #[serde(default)]
    pub(crate) path: Option<String>,
    #[serde(default)]
    pub(crate) recipes_dir: Option<String>,
}

pub async fn serve(addr: &str, manager: PtyManager, remote: RemoteControl) -> std::io::Result<()> {
    let listener = TcpListener::bind(addr).await?;
    eprintln!("bento-daemon listening on {addr}");
    loop {
        let (socket, _) = listener.accept().await?;
        let manager = manager.clone();
        let remote = remote.clone();
        tokio::spawn(async move {
            let _ = handle_conn(socket, manager, remote).await;
        });
    }
}

async fn handle_conn(socket: TcpStream, manager: PtyManager, remote: RemoteControl) -> std::io::Result<()> {
    let (read_half, mut write_half) = socket.into_split();

    let (out, mut out_rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(line) = out_rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err()
                || write_half.write_all(b"\n").await.is_err()
            {
                break;
            }
        }
    });

    // Tracks the background task actually running an agent subprocess for
    // review.run/review.ask on this connection (not the small forwarding
    // task) — aborted when the connection ends so a client disconnecting
    // (including the TUI's explicit cancel, which just drops its socket)
    // stops the real, possibly billed, agent process instead of leaving it
    // to finish unseen. Requires the spawned Command to be
    // `.kill_on_drop(true)` (see review/mod.rs, review/ask.rs) — aborting a
    // tokio task alone does not kill a child process by default.
    let mut review_tasks: Vec<tokio::task::JoinHandle<()>> = Vec::new();

    let mut lines = BufReader::new(read_half).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Request>(&line) {
            Ok(request) => dispatch(request, &manager, &remote, &out, &mut review_tasks),
            Err(error) => {
                let _ = out.send(json!({"ok": false, "error": format!("bad request: {error}")}).to_string());
            }
        }
    }

    for task in review_tasks {
        task.abort();
    }
    drop(out);
    let _ = writer.await;
    Ok(())
}

pub(crate) fn ok(id: &Option<String>, data: Value) -> String {
    json!({ "id": id, "ok": true, "data": data }).to_string()
}

pub(crate) fn fail(id: &Option<String>, message: String) -> String {
    json!({ "id": id, "ok": false, "error": message }).to_string()
}

/// Spawns a task that forwards a review stream (`ask()`/`run_review()`) to
/// the client as `review.output` events, finishing with `review.done`.
/// `[DONE]` is those functions' own end-of-stream sentinel — swallowed here
/// since the client already gets an explicit `review.done` event right after.
pub(crate) fn spawn_review_stream(out: mpsc::UnboundedSender<String>) -> tokio::sync::mpsc::Sender<String> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(64);
    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            if chunk == "[DONE]" { continue; }
            let _ = out.send(json!({ "event": "review.output", "data": chunk }).to_string());
        }
        let _ = out.send(json!({ "event": "review.done" }).to_string());
    });
    tx
}

fn dispatch(req: Request, manager: &PtyManager, remote: &RemoteControl, out: &mpsc::UnboundedSender<String>, review_tasks: &mut Vec<tokio::task::JoinHandle<()>>) {
    let send = |line: String| { let _ = out.send(line); };
    match req.cmd.as_str() {
        "daemon.status" => send(ok(&req.id, json!({ "terminals": manager.list().len() }))),

        "terminals.list" => {
            let list: Vec<Value> = manager
                .list()
                .into_iter()
                .map(|info| json!({ "pty_id": info.id, "title": info.title, "cwd": info.cwd }))
                .collect();
            send(ok(&req.id, json!(list)));
        }

        // Las notas son ficheros del usuario: se leen y escriben por este
        // socket, que es local. Por HTTP no van — ver docs/remote-exposure.md.
        "notes.list" => match bento_notes::list() {
            Ok(notes) => send(ok(&req.id, json!(notes))),
            Err(e) => send(fail(&req.id, e)),
        },

        "notes.read" => match &req.path {
            Some(name) => match bento_notes::read(name) {
                Ok(content) => send(ok(&req.id, json!(content))),
                Err(e) => send(fail(&req.id, e)),
            },
            None => send(fail(&req.id, "path (note name) required".into())),
        },

        "notes.write" => match (&req.path, &req.data) {
            (Some(name), Some(content)) => match bento_notes::write(name, content) {
                Ok(()) => send(ok(&req.id, Value::Null)),
                Err(e) => send(fail(&req.id, e)),
            },
            _ => send(fail(&req.id, "path (note name) and data (content) required".into())),
        },

        "notes.delete" => match &req.path {
            Some(name) => match bento_notes::delete(name) {
                Ok(()) => send(ok(&req.id, Value::Null)),
                Err(e) => send(fail(&req.id, e)),
            },
            None => send(fail(&req.id, "path (note name) required".into())),
        },

        "projects.list" => send(ok(&req.id, json!(crate::remote::inventory::list_projects(manager)))),

        "terminal.open" => {
            let opts = OpenOptions {
                id: req.pty_id.clone(),
                title: req.title.clone(),
                shell: req.shell.clone(),
                command: req.command.clone(),
                cwd: req.cwd.clone(),
                env: req.env.clone().map(|m| m.into_iter().collect()).unwrap_or_default(),
                rows: req.rows.unwrap_or(0),
                cols: req.cols.unwrap_or(0),
            };
            match manager.open(opts) {
                Ok((id, reattached)) => send(ok(&req.id, json!({ "pty_id": id, "reattached": reattached }))),
                Err(error) => send(fail(&req.id, error)),
            }
        }

        "terminal.set_title" => match (&req.pty_id, &req.title) {
            (Some(id), Some(title)) => { manager.set_title(id, title); send(ok(&req.id, Value::Null)) }
            _ => send(fail(&req.id, "pty_id and title required".into())),
        },

        "terminal.write" => match (&req.pty_id, &req.data) {
            (Some(id), Some(data)) => match manager.write(id, data) {
                Ok(()) => send(ok(&req.id, Value::Null)),
                Err(error) => send(fail(&req.id, error)),
            },
            _ => send(fail(&req.id, "pty_id and data required".into())),
        },

        "terminal.resize" => match &req.pty_id {
            Some(id) => match manager.resize(id, req.rows.unwrap_or(24), req.cols.unwrap_or(80)) {
                Ok(()) => send(ok(&req.id, Value::Null)),
                Err(error) => send(fail(&req.id, error)),
            },
            None => send(fail(&req.id, "pty_id required".into())),
        },

        "terminal.close" => match &req.pty_id {
            Some(id) => match manager.close(id) {
                Ok(()) => send(ok(&req.id, Value::Null)),
                Err(error) => send(fail(&req.id, error)),
            },
            None => send(fail(&req.id, "pty_id required".into())),
        },

        "terminal.subscribe" => match &req.pty_id {
            Some(id) => match manager.subscribe(id) {
                Some(mut rx) => {
                    if let Some(scrollback) = manager.scrollback(id) {
                        if !scrollback.is_empty() {
                            send(json!({ "event": "terminal.output", "pty_id": id, "data": scrollback }).to_string());
                        }
                    }
                    send(ok(&req.id, json!({ "subscribed": id })));
                    let out = out.clone();
                    let pty_id = id.clone();
                    tokio::spawn(async move {
                        loop {
                            match rx.recv().await {
                                Ok(PtyEvent::Output(text)) => {
                                    let _ = out.send(
                                        json!({ "event": "terminal.output", "pty_id": pty_id, "data": text }).to_string(),
                                    );
                                }
                                Ok(PtyEvent::TitleChanged(_)) => {}
                                Ok(PtyEvent::Exit(code)) => {
                                    let _ = out.send(
                                        json!({ "event": "terminal.exit", "pty_id": pty_id, "code": code }).to_string(),
                                    );
                                    break;
                                }
                                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => break,
                                Err(_) => break,
                            }
                        }
                    });
                }
                None => send(fail(&req.id, "pty not found".into())),
            },
            None => send(fail(&req.id, "pty_id required".into())),
        },

        cmd if cmd.starts_with("tasks.") => tasks::dispatch(cmd, &req, &send),

        cmd if cmd.starts_with("docker.") => docker::dispatch(cmd, &req, &send),

        cmd if cmd.starts_with("memory.") => memory::dispatch(cmd, &req, &send),

        cmd if cmd.starts_with("review.") => review::dispatch(cmd, &req, &send, out, review_tasks),

        "remote.start" => {
            let port = req.port.unwrap_or(7879);
            let remote = remote.clone();
            let manager = manager.clone();
            let token = req.token.clone();
            let use_tailscale = req.use_tailscale.unwrap_or(false);
            let herdr_socket = req.herdr_socket.clone();
            let out = out.clone();
            let id = req.id.clone();
            tokio::spawn(async move {
                match remote.start(manager, port, token, use_tailscale, herdr_socket).await {
                    Ok(info) => { let _ = out.send(ok(&id, serde_json::to_value(&info).unwrap_or(Value::Null))); }
                    Err(e) => { let _ = out.send(fail(&id, e)); }
                }
            });
        }

        "remote.stop" => {
            remote.stop();
            send(ok(&req.id, json!({ "running": false })));
        }

        "remote.status" => {
            let info = remote.status();
            send(ok(&req.id, serde_json::to_value(&info).unwrap_or(Value::Null)));
        }

        "daemon.shutdown" => {
            send(ok(&req.id, json!({})));
            tokio::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_millis(30)).await;
                std::process::exit(0);
            });
        }

        other => send(fail(&req.id, format!("unknown command: {other}"))),
    }
}
