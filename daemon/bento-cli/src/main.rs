//! bento — CLI client for the bento-daemon. Talks the same line-delimited JSON
//! protocol over localhost TCP.

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

pub(crate) fn addr() -> String {
    std::env::var("BENTO_DAEMON_ADDR").unwrap_or_else(|_| "127.0.0.1:7877".into())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(error) = commands::run(&args).await {
        eprintln!("bento: {error}");
        std::process::exit(1);
    }
}

mod attach;
mod commands;
mod review_stream;
mod service;
mod tui;

pub(crate) fn current_dir_string() -> String {
    std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default()
}

/// Prints raw text (as opposed to a JSON value) to stdout. A downstream
/// pipe closing early (`bento review pr diff N | head`) makes the next
/// write fail with a broken-pipe error — `println!` panics on that by
/// default, so write directly and exit quietly instead, matching how
/// well-behaved Unix text tools handle it.
pub(crate) fn print_text(s: &str) {
    use std::io::Write;
    if let Err(e) = write!(std::io::stdout(), "{s}") {
        if e.kind() != std::io::ErrorKind::BrokenPipe {
            eprintln!("bento: {e}");
        }
        std::process::exit(0);
    }
}

pub(crate) fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

/// Send one request and print the single response line.
pub(crate) async fn request(body: Value) -> std::io::Result<()> {
    let response = request_data(body).await?;
    println!("{response}");
    Ok(())
}

/// Send a streaming request (`review.run`/`review.ask`): drain the shared
/// `review_stream` connection, printing content to stdout and progress/error
/// sentinels to stderr, until it signals `Done`.
pub(crate) async fn stream_review(body: Value) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt as _;
    let (mut rx, _handle) = review_stream::spawn_review_stream(body);
    let mut stdout = tokio::io::stdout();
    while let Some(event) = rx.recv().await {
        match event {
            review_stream::ReviewEvent::Content(text) => {
                let _ = stdout.write_all(text.as_bytes()).await;
                let _ = stdout.flush().await;
            }
            review_stream::ReviewEvent::Progress(msg) => eprintln!("{msg}"),
            review_stream::ReviewEvent::Done => break,
        }
    }
    println!();
    Ok(())
}

/// Send one request and return the `data` field of the response.
pub(crate) async fn request_data(body: Value) -> std::io::Result<Value> {
    let mut stream = TcpStream::connect(addr()).await?;
    stream.write_all(body.to_string().as_bytes()).await?;
    stream.write_all(b"\n").await?;
    let (read_half, _write) = stream.into_split();
    let mut lines = BufReader::new(read_half).lines();
    if let Some(line) = lines.next_line().await? {
        let v: Value = serde_json::from_str(&line)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        if v.get("ok").and_then(Value::as_bool) == Some(false) {
            let msg = v.get("error").and_then(Value::as_str).unwrap_or("daemon error");
            return Err(std::io::Error::other(msg));
        }
        return Ok(v.get("data").cloned().unwrap_or(Value::Null));
    }
    Ok(Value::Null)
}

pub(crate) fn print_help() {
    eprintln!("bento — control terminals through the bento-daemon");
    eprintln!();
    eprintln!("USAGE:");
    eprintln!("  bento                      open the terminal panel (no args)");
    eprintln!("  bento daemon status        show daemon status");
    eprintln!("  bento daemon start         start the daemon in the background");
    eprintln!("  bento daemon install       register daemon as a login service");
    eprintln!("  bento daemon uninstall     remove the login service");
    eprintln!("  bento terminals            list open terminals");
    eprintln!("  bento open [--cwd <dir>]   open a new terminal");
    eprintln!("  bento attach <pty_id>      attach to a terminal (stdin/stdout)");
    eprintln!("  bento review branches [--cwd <dir>]   list recent branches (default: cwd)");
    eprintln!("  bento review prs [--cwd <dir>]        list open PRs (needs gh)");
    eprintln!("  bento review files [--cwd <dir>] [--base <ref>]   files changed vs base (default: main)");
    eprintln!("  bento review file <path> [--cwd <dir>] [--base <ref>]   diff for a single file vs base");
    eprintln!("  bento review pr diff <number> [--cwd <dir>]       PR diff (needs gh)");
    eprintln!("  bento review pr comments <number> [--cwd <dir>]   PR comments/reviews (needs gh)");
    eprintln!("  bento review pr comment <number> <text>           add a PR comment (needs gh)");
    eprintln!("  bento review pr comment-update <comment_id> <number> <text>   edit a comment (needs gh)");
    eprintln!("  bento review pr comment-delete <comment_id> <number>          delete a comment (needs gh)");
    eprintln!("  bento review pr submit <number> <approve|request-changes|comment> [text]   submit a review (needs gh)");
    eprintln!("  bento review ask <question> [--cwd <dir>] [--base <ref>] [--agent <name>]   ask about a saved review (runs a real AI agent)");
    eprintln!("  bento review run [--cwd <dir>] [--base <ref>] [--branch <ref>] [--context <text>] [--agents claude,codex,opencode]   run a full AI code review (runs real AI agents)");
    eprintln!();
    eprintln!("env: BENTO_DAEMON_ADDR (default 127.0.0.1:7877)");
}
