use crate::remote::RemoteControl;
use bento_core::{OpenOptions, PtyEvent, PtyManager};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    id: Option<String>,
    cmd: String,
    #[serde(default)]
    pty_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    shell: Option<String>,
    #[serde(default)]
    command: Option<Vec<String>>,
    #[serde(default)]
    env: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    rows: Option<u16>,
    #[serde(default)]
    cols: Option<u16>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    token: Option<String>,
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

    let mut lines = BufReader::new(read_half).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Request>(&line) {
            Ok(request) => dispatch(request, &manager, &remote, &out),
            Err(error) => {
                let _ = out.send(json!({"ok": false, "error": format!("bad request: {error}")}).to_string());
            }
        }
    }

    drop(out);
    let _ = writer.await;
    Ok(())
}

fn ok(id: &Option<String>, data: Value) -> String {
    json!({ "id": id, "ok": true, "data": data }).to_string()
}

fn fail(id: &Option<String>, message: String) -> String {
    json!({ "id": id, "ok": false, "error": message }).to_string()
}

fn dispatch(req: Request, manager: &PtyManager, remote: &RemoteControl, out: &mpsc::UnboundedSender<String>) {
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

        "terminal.open" => {
            let opts = OpenOptions {
                id: req.pty_id.clone(),
                shell: req.shell.clone(),
                command: req.command.clone(),
                cwd: req.cwd.clone(),
                env: req.env.clone().map(|m| m.into_iter().collect()).unwrap_or_default(),
                rows: req.rows.unwrap_or(0),
                cols: req.cols.unwrap_or(0),
                ..Default::default()
            };
            match manager.open(opts) {
                Ok((id, reattached)) => send(ok(&req.id, json!({ "pty_id": id, "reattached": reattached }))),
                Err(error) => send(fail(&req.id, error)),
            }
        }

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

        "remote.start" => {
            let port = req.port.unwrap_or(7879);
            let remote = remote.clone();
            let manager = manager.clone();
            let token = req.token.clone();
            let out = out.clone();
            let id = req.id.clone();
            tokio::spawn(async move {
                match remote.start(manager, port, token).await {
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

        other => send(fail(&req.id, format!("unknown command: {other}"))),
    }
}
