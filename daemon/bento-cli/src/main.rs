//! bento — CLI client for the bento-daemon. Talks the same line-delimited JSON
//! protocol over localhost TCP.

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

fn addr() -> String {
    std::env::var("BENTO_DAEMON_ADDR").unwrap_or_else(|_| "127.0.0.1:7877".into())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(error) = run(&args).await {
        eprintln!("bento: {error}");
        std::process::exit(1);
    }
}

async fn run(args: &[String]) -> std::io::Result<()> {
    match args.first().map(String::as_str) {
        Some("daemon") if args.get(1).map(String::as_str) == Some("status") => {
            request(json!({ "id": "1", "cmd": "daemon.status" })).await
        }
        Some("terminals") => request(json!({ "id": "1", "cmd": "terminals.list" })).await,
        Some("open") => {
            let mut body = json!({ "id": "1", "cmd": "terminal.open" });
            if let Some(cwd) = flag(args, "--cwd") {
                body["cwd"] = json!(cwd);
            }
            request(body).await
        }
        Some("attach") => match args.get(1) {
            Some(id) => attach(id).await,
            None => {
                eprintln!("usage: bento attach <pty_id>");
                Ok(())
            }
        },
        _ => {
            print_help();
            Ok(())
        }
    }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

/// Send one request and print the single response line.
async fn request(body: Value) -> std::io::Result<()> {
    let mut stream = TcpStream::connect(addr()).await?;
    stream.write_all(body.to_string().as_bytes()).await?;
    stream.write_all(b"\n").await?;
    let (read_half, _write) = stream.into_split();
    let mut lines = BufReader::new(read_half).lines();
    if let Some(line) = lines.next_line().await? {
        println!("{line}");
    }
    Ok(())
}

/// Attach to a terminal: stream its output to stdout and forward stdin lines as
/// input. Line-based for now; full raw-mode interactivity comes in a later phase.
async fn attach(id: &str) -> std::io::Result<()> {
    let stream = TcpStream::connect(addr()).await?;
    let (read_half, mut write_half) = stream.into_split();
    let subscribe = json!({ "id": "1", "cmd": "terminal.subscribe", "pty_id": id }).to_string();
    write_half.write_all(subscribe.as_bytes()).await?;
    write_half.write_all(b"\n").await?;

    tokio::spawn(async move {
        let mut lines = BufReader::new(read_half).lines();
        let mut stdout = tokio::io::stdout();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match value.get("event").and_then(Value::as_str) {
                Some("terminal.output") => {
                    if let Some(data) = value.get("data").and_then(Value::as_str) {
                        let _ = stdout.write_all(data.as_bytes()).await;
                        let _ = stdout.flush().await;
                    }
                }
                Some("terminal.exit") => break,
                _ => {}
            }
        }
    });

    let mut stdin = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = stdin.next_line().await? {
        let write =
            json!({ "cmd": "terminal.write", "pty_id": id, "data": format!("{line}\r") }).to_string();
        write_half.write_all(write.as_bytes()).await?;
        write_half.write_all(b"\n").await?;
    }
    Ok(())
}

fn print_help() {
    eprintln!("bento — control terminals through the bento-daemon");
    eprintln!();
    eprintln!("USAGE:");
    eprintln!("  bento daemon status        show daemon status");
    eprintln!("  bento terminals            list open terminals");
    eprintln!("  bento open [--cwd <dir>]   open a new terminal");
    eprintln!("  bento attach <pty_id>      attach to a terminal (stdin/stdout)");
    eprintln!();
    eprintln!("env: BENTO_DAEMON_ADDR (default 127.0.0.1:7877)");
}
