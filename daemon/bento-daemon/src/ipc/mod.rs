mod docker;
mod review;
mod tasks;

use crate::remote::RemoteControl;
use bento_core::{OpenOptions, PtyEvent, PtyManager};
use serde::Deserialize;
use std::sync::Arc;
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
    pub(crate) flow: Option<bool>,
    /// `terminal.ack`: output painted, in UTF-16 units.
    #[serde(default)]
    pub(crate) chars: Option<u64>,
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
    /// Which review run a checkpoint belongs to, so its incremental saves land
    /// on one entry and two runs of the same branch keep both.
    #[serde(default)]
    pub(crate) run_id: Option<String>,
    #[serde(default)]
    pub(crate) session_id: Option<String>,
    #[serde(default)]
    pub(crate) path: Option<String>,
    #[serde(default)]
    pub(crate) recipes_dir: Option<String>,
    #[serde(default)]
    pub(crate) limit: Option<u32>,
    /// La línea del fichero nuevo sobre la que se comenta, para
    /// `review.pr_inline_comment`.
    #[serde(default)]
    pub(crate) line: Option<u64>,
    /// La primera de un comentario a varias líneas, como el que se deja
    /// arrastrando en GitHub. `bento_review` ya sabía anclarlo; el socket no
    /// lo dejaba pasar, así que sólo se podía comentar una línea suelta.
    #[serde(default)]
    pub(crate) start_line: Option<u64>,
    /// Si un hilo queda resuelto o se reabre, para `review.pr_thread_resolve`.
    #[serde(default)]
    pub(crate) resolved: Option<bool>,
}

pub async fn bind(addr: &str) -> std::io::Result<TcpListener> {
    let listener = TcpListener::bind(addr).await?;
    eprintln!("bento-daemon listening on {addr}");
    Ok(listener)
}

pub async fn serve(listener: TcpListener, manager: PtyManager, remote: RemoteControl) -> std::io::Result<()> {
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

    // One output forwarder per terminal on this connection. The desktop
    // subscribes again for every panel that shows an already-open terminal, and
    // a second forwarder would repeat every chunk to the same client.
    let mut subscribed = Subscriptions::new();

    let mut lines = BufReader::new(read_half).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Request>(&line) {
            Ok(request) => dispatch(request, &manager, &remote, &out, &mut review_tasks, &mut subscribed),
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

/// Terminals this connection already forwards, with its flow seat when it
/// asked for flow control.
pub(crate) type Subscriptions = std::collections::HashMap<String, Option<Arc<bento_core::FlowClient>>>;

fn dispatch(req: Request, manager: &PtyManager, remote: &RemoteControl, out: &mpsc::UnboundedSender<String>, review_tasks: &mut Vec<tokio::task::JoinHandle<()>>, subscribed: &mut Subscriptions) {
    let send = |line: String| { let _ = out.send(line); };
    match req.cmd.as_str() {
        "daemon.status" => send(ok(&req.id, json!({ "terminals": manager.list().len() }))),

        "terminals.list" => {
            let list: Vec<Value> = manager.list().iter().map(crate::agents::describe).collect();
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
                Ok((id, reattached)) => {
                    // A brand-new terminal reusing a dead one's id needs a new
                    // forwarder, so the old subscription must not block it.
                    if !reattached { subscribed.remove(&id); }
                    send(ok(&req.id, json!({ "pty_id": id, "reattached": reattached })))
                }
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

        "terminal.ack" => {
            let flow = req.pty_id.as_ref().and_then(|id| subscribed.get(id)).and_then(Option::as_ref);
            if let (Some(flow), Some(chars)) = (flow, req.chars) {
                flow.ack(chars as usize);
            }
        }

        "terminal.resize" => match &req.pty_id {
            Some(id) => match manager.resize(id, req.rows.unwrap_or(24), req.cols.unwrap_or(80)) {
                Ok(()) => send(ok(&req.id, Value::Null)),
                Err(error) => send(fail(&req.id, error)),
            },
            None => send(fail(&req.id, "pty_id required".into())),
        },

        // Which agent the terminal is running and on which session, so the app
        // can resume it after a restart. Null while it's just the shell.
        "terminal.agent" => match &req.pty_id {
            // Off the socket loop: it reads the process table and may run lsof.
            Some(id) => {
                let (manager, out, id, req_id) = (manager.clone(), out.clone(), id.clone(), req.id.clone());
                tokio::task::spawn_blocking(move || {
                    let agent = manager
                        .foreground_process(&id)
                        .and_then(|process| bento_sessions::running_agent(process.pid, &process.argv, &process.env, process.cwd.clone()));
                    let _ = out.send(ok(&req_id, json!(agent)));
                });
            }
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
            // Already forwarding this terminal to this client: a second
            // forwarder would send every chunk twice, and replaying the
            // scrollback would repaint it on the panels already showing it.
            Some(id) if subscribed.contains_key(id) => send(ok(&req.id, json!({ "subscribed": id, "duplicate": true }))),
            Some(id) => match manager.subscribe(id) {
                Some(mut rx) => {
                    let flow = req.flow.unwrap_or(false).then(|| manager.flow_client(id)).flatten().map(Arc::new);
                    subscribed.insert(id.clone(), flow.clone());
                    // The size the terminal has now, which may be another
                    // client's: this one draws at it until it claims its own.
                    // Before the replay, which only makes sense at that size.
                    if let Some((rows, cols)) = manager.size(id) {
                        send(json!({ "event": "terminal.size", "pty_id": id, "rows": rows, "cols": cols }).to_string());
                    }
                    if let Some(scrollback) = manager.scrollback(id) {
                        if !scrollback.is_empty() {
                            if let Some(flow) = &flow { flow.sent(scrollback.encode_utf16().count()) }
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
                                    if let Some(flow) = &flow { flow.sent(text.encode_utf16().count()) }
                                    // The connection is gone: stop, so its flow seat
                                    // is released instead of pausing the terminal.
                                    let line = json!({ "event": "terminal.output", "pty_id": pty_id, "data": text }).to_string();
                                    if out.send(line).is_err() { break }
                                }
                                // Renombrar desde un cliente tiene que verse en
                                // los otros: el HTTP ya lo mandaba y por aquí se
                                // tiraba, así que el escritorio no se enteraba.
                                Ok(PtyEvent::TitleChanged(title)) => {
                                    let _ = out.send(
                                        json!({ "event": "terminal.title", "pty_id": pty_id, "title": title }).to_string(),
                                    );
                                }
                                Ok(PtyEvent::Resized { rows, cols }) => {
                                    let _ = out.send(
                                        json!({ "event": "terminal.size", "pty_id": pty_id, "rows": rows, "cols": cols }).to_string(),
                                    );
                                }
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


        cmd if cmd.starts_with("review.") => review::dispatch(cmd, &req, &send, out, review_tasks),

        "remote.start" => {
            let port = req.port.unwrap_or(7879);
            let remote = remote.clone();
            let manager = manager.clone();
            let token = req.token.clone();
            let use_tailscale = req.use_tailscale.unwrap_or(false);
            let out = out.clone();
            let id = req.id.clone();
            tokio::spawn(async move {
                match remote.start(manager, port, token, use_tailscale).await {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn request(body: Value) -> Request {
        serde_json::from_value(body).expect("request")
    }

    /// The desktop subscribes on every `pty_spawn`, so the same connection asks
    /// for the same terminal once per panel showing it. Each extra forwarder
    /// used to repeat every chunk, which painted the shell's echo two or three
    /// times over itself.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_connection_subscribed_twice_receives_each_chunk_once() {
        let manager = PtyManager::default();
        let remote = RemoteControl::default();
        let (id, _) = manager
            .open(OpenOptions {
                command: Some(vec!["/bin/echo".into(), "MARCA".into()]),
                ..OpenOptions::default()
            })
            .expect("pty");
        let (out, mut out_rx) = mpsc::unbounded_channel();
        let mut review_tasks = Vec::new();
        let mut subscribed = Subscriptions::new();

        for _ in 0..2 {
            dispatch(
                request(json!({ "cmd": "terminal.subscribe", "pty_id": id })),
                &manager,
                &remote,
                &out,
                &mut review_tasks,
                &mut subscribed,
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(600));

        let mut marks = 0;
        while let Ok(line) = out_rx.try_recv() {
            let event: Value = serde_json::from_str(&line).expect("json");
            if event.get("event").and_then(Value::as_str) == Some("terminal.output") {
                marks += event.get("data").and_then(Value::as_str).unwrap_or("").matches("MARCA").count();
            }
        }
        let _ = manager.close(&id);

        assert_eq!(marks, 1, "the output reached the connection {marks} times");
    }

    fn drain_output(out_rx: &mut mpsc::UnboundedReceiver<String>) -> usize {
        let mut chars = 0;
        while let Ok(line) = out_rx.try_recv() {
            let event: Value = serde_json::from_str(&line).expect("json");
            if event.get("event").and_then(Value::as_str) == Some("terminal.output") {
                chars += event.get("data").and_then(Value::as_str).unwrap_or("").encode_utf16().count();
            }
        }
        chars
    }

    /// A program that floods the terminal used to queue everything in the
    /// desktop's webview (>1 GB). With flow control the daemon stops reading
    /// until the client acks what it painted.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_flow_client_that_does_not_ack_stops_the_flood() {
        let manager = PtyManager::default();
        let remote = RemoteControl::default();
        let (id, _) = manager
            .open(OpenOptions {
                command: Some(vec!["/bin/sh".into(), "-c".into(), "head -c 8000000 /dev/zero | tr '\\0' a".into()]),
                ..OpenOptions::default()
            })
            .expect("pty");
        let (out, mut out_rx) = mpsc::unbounded_channel();
        let mut review_tasks = Vec::new();
        let mut subscribed = Subscriptions::new();
        let mut run = |body: Value| dispatch(request(body), &manager, &remote, &out, &mut review_tasks, &mut subscribed);

        run(json!({ "cmd": "terminal.subscribe", "pty_id": id, "flow": true }));
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        let unacked = drain_output(&mut out_rx);

        run(json!({ "cmd": "terminal.ack", "pty_id": id, "chars": unacked }));
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let after_ack = drain_output(&mut out_rx);
        let _ = manager.close(&id);

        assert!(unacked > 0, "no output at all");
        assert!(unacked < 2_000_000, "{unacked} chars sent without any ack");
        assert!(after_ack > 0, "the ack did not resume the terminal");
    }
}
