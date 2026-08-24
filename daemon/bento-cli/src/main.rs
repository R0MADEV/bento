//! bento — CLI client for the bento-daemon. Talks the same line-delimited JSON
//! protocol over localhost TCP.

mod attach;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

pub(crate) fn addr() -> String {
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
        Some("daemon") => match args.get(1).map(String::as_str) {
            Some("status")    => request(json!({ "id": "1", "cmd": "daemon.status" })).await,
            Some("start")     => daemon_start().await,
            Some("install")   => daemon_install(),
            Some("uninstall") => daemon_uninstall(),
            _ => { print_help(); Ok(()) }
        },
        Some("agent") => match args.get(1).map(String::as_str) {
            Some("run") => {
                let rest = &args[2..];
                let cmd = build_agent_open_cmd(rest);
                let pty_id = request_data(cmd).await?;
                let id = pty_id.get("pty_id").and_then(Value::as_str).unwrap_or("?");
                println!("agent started: {id}");
                if flag(rest, "--attach").is_some() || rest.contains(&"--attach".to_string()) {
                    attach::attach(id).await?;
                }
                Ok(())
            }
            Some("list") => request(json!({ "id": "1", "cmd": "terminals.list" })).await,
            Some("attach") => match args.get(2) {
                Some(id) => attach::attach(id).await,
                None => { eprintln!("usage: bento agent attach <id>"); Ok(()) }
            },
            _ => { print_help(); Ok(()) }
        },
        Some("terminals") => request(json!({ "id": "1", "cmd": "terminals.list" })).await,
        Some("review") => match args.get(1).map(String::as_str) {
            Some("branches") => {
                let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                request(json!({ "id": "1", "cmd": "review.branches", "cwd": cwd })).await
            }
            _ => { print_help(); Ok(()) }
        },
        Some("open") => {
            let mut body = json!({ "id": "1", "cmd": "terminal.open" });
            if let Some(cwd) = flag(args, "--cwd") {
                body["cwd"] = json!(cwd);
            }
            request(body).await
        }
        Some("attach") => match args.get(1) {
            Some(id) => attach::attach(id).await,
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

fn current_dir_string() -> String {
    std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default()
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

// ── Daemon lifecycle ──────────────────────────────────────────────────────────

/// Start the daemon in the background if it is not already running.
async fn daemon_start() -> std::io::Result<()> {
    if TcpStream::connect(addr()).await.is_ok() {
        println!("bento-daemon is already running on {}", addr());
        return Ok(());
    }
    let bin = daemon_binary()
        .ok_or_else(|| io_err("bento-daemon binary not found next to bento"))?;

    spawn_detached(&bin)?;

    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if TcpStream::connect(addr()).await.is_ok() {
            println!("bento-daemon started on {}", addr());
            return Ok(());
        }
    }
    eprintln!("bento-daemon spawned but not yet responding — check /tmp/bento-daemon.log");
    Ok(())
}

// ── Auto-start registration ───────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn daemon_install() -> std::io::Result<()> {
    let bin = daemon_binary()
        .ok_or_else(|| io_err("bento-daemon binary not found next to bento"))?;
    let home = home_dir()?;
    let agents_dir = home.join("Library/LaunchAgents");
    std::fs::create_dir_all(&agents_dir)?;
    let plist_path = agents_dir.join("dev.bento.daemon.plist");
    std::fs::write(&plist_path, macos_plist(bin.to_str().unwrap()))?;
    let ok = std::process::Command::new("launchctl")
        .args(["load", "-w", plist_path.to_str().unwrap()])
        .status()?
        .success();
    if ok {
        println!("bento-daemon installed — starts at login");
        println!("  plist:  {}", plist_path.display());
        println!("  binary: {}", bin.display());
        println!("  log:    /tmp/bento-daemon.log");
    } else {
        eprintln!("launchctl load failed — plist written but daemon may not have loaded");
        eprintln!("  try: launchctl load -w {}", plist_path.display());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn daemon_uninstall() -> std::io::Result<()> {
    let home = home_dir()?;
    let plist_path = home.join("Library/LaunchAgents/dev.bento.daemon.plist");
    if !plist_path.exists() {
        println!("bento-daemon is not installed (no plist found)");
        return Ok(());
    }
    let _ = std::process::Command::new("launchctl")
        .args(["unload", "-w", plist_path.to_str().unwrap()])
        .status();
    std::fs::remove_file(&plist_path)?;
    println!("bento-daemon uninstalled — will not start at login");
    Ok(())
}

#[cfg(target_os = "linux")]
fn daemon_install() -> std::io::Result<()> {
    let bin = daemon_binary()
        .ok_or_else(|| io_err("bento-daemon binary not found next to bento"))?;
    let home = home_dir()?;
    let service_dir = home.join(".config/systemd/user");
    std::fs::create_dir_all(&service_dir)?;
    let service_path = service_dir.join("bento-daemon.service");
    std::fs::write(&service_path, linux_service(bin.to_str().unwrap()))?;
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .status();
    let ok = std::process::Command::new("systemctl")
        .args(["--user", "enable", "--now", "bento-daemon"])
        .status()?
        .success();
    if ok {
        println!("bento-daemon installed — starts at login (systemd user)");
        println!("  service: {}", service_path.display());
    } else {
        eprintln!("systemctl enable failed — service file written but daemon may not have started");
        eprintln!("  try: systemctl --user enable --now bento-daemon");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn daemon_uninstall() -> std::io::Result<()> {
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "disable", "--now", "bento-daemon"])
        .status();
    let home = home_dir()?;
    let service_path = home.join(".config/systemd/user/bento-daemon.service");
    if service_path.exists() {
        std::fs::remove_file(&service_path)?;
    }
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .status();
    println!("bento-daemon uninstalled");
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn daemon_install() -> std::io::Result<()> {
    Err(io_err("auto-start not supported on this OS — start the daemon manually with: bento daemon start"))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn daemon_uninstall() -> std::io::Result<()> {
    Err(io_err("auto-start not supported on this OS"))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Locate the bento-daemon binary next to the current CLI binary.
fn daemon_binary() -> Option<std::path::PathBuf> {
    let name = if cfg!(windows) { "bento-daemon.exe" } else { "bento-daemon" };
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = dir.join(name);
    candidate.exists().then_some(candidate)
}

fn home_dir() -> std::io::Result<std::path::PathBuf> {
    std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .map_err(|_| io_err("HOME is not set"))
}

fn io_err(msg: &str) -> std::io::Error {
    std::io::Error::other(msg)
}

/// Spawn `bin` detached so it keeps running after the CLI exits.
fn spawn_detached(bin: &std::path::Path) -> std::io::Result<()> {
    let mut cmd = std::process::Command::new(bin);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn()?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_plist(bin: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.bento.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>{bin}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/bento-daemon.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/bento-daemon.log</string>
</dict>
</plist>
"#
    )
}

#[cfg(target_os = "linux")]
fn linux_service(bin: &str) -> String {
    format!(
        "[Unit]\nDescription=Bento Daemon\n\n[Service]\nExecStart={bin}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n"
    )
}

// ── Agent commands ────────────────────────────────────────────────────────────

/// Build a `terminal.open` IPC command for a given agent and flags.
/// - `claude --message <msg>` → `["claude", "-p", "<msg>"]`
/// - `codex  --message <msg>` → `["codex", "-a", "full-auto", "-q", "<msg>"]`
/// - other   --message <msg>` → `["<agent>", "<msg>"]`
fn build_agent_open_cmd(args: &[String]) -> Value {
    let agent = args.first().map(String::as_str).unwrap_or("claude");
    let cwd = flag(args, "--cwd");
    let message = flag(args, "--message");

    let command: Vec<String> = match (agent, message.as_deref()) {
        ("claude", Some(msg)) => vec!["claude".into(), "-p".into(), msg.into()],
        ("codex",  Some(msg)) => vec!["codex".into(), "-a".into(), "full-auto".into(), "-q".into(), msg.into()],
        (name,     Some(msg)) => vec![name.into(), msg.into()],
        (name,     None)      => vec![name.into()],
    };

    let mut body = json!({ "id": "1", "cmd": "terminal.open", "command": command });
    if let Some(c) = cwd {
        body["cwd"] = json!(c);
    }
    body
}

// ── IPC helpers ───────────────────────────────────────────────────────────────

/// Send one request and print the single response line.
async fn request(body: Value) -> std::io::Result<()> {
    let response = request_data(body).await?;
    println!("{response}");
    Ok(())
}

/// Send one request and return the `data` field of the response.
async fn request_data(body: Value) -> std::io::Result<Value> {
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

fn print_help() {
    eprintln!("bento — control terminals through the bento-daemon");
    eprintln!();
    eprintln!("USAGE:");
    eprintln!("  bento daemon status        show daemon status");
    eprintln!("  bento daemon start         start the daemon in the background");
    eprintln!("  bento daemon install       register daemon as a login service");
    eprintln!("  bento daemon uninstall     remove the login service");
    eprintln!("  bento terminals            list open terminals");
    eprintln!("  bento open [--cwd <dir>]   open a new terminal");
    eprintln!("  bento attach <pty_id>      attach to a terminal (stdin/stdout)");
    eprintln!("  bento review branches [--cwd <dir>]   list recent branches (default: cwd)");
    eprintln!();
    eprintln!("env: BENTO_DAEMON_ADDR (default 127.0.0.1:7877)");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_run_claude_interactive() {
        let args = ["claude".to_string(), "--cwd".to_string(), "/home/x".to_string()];
        let cmd = build_agent_open_cmd(&args);
        assert_eq!(cmd["cmd"].as_str(), Some("terminal.open"));
        assert_eq!(cmd["command"], json!(["claude"]));
        assert_eq!(cmd["cwd"].as_str(), Some("/home/x"));
    }

    #[test]
    fn agent_run_claude_with_message_uses_print_flag() {
        let args = [
            "claude".to_string(), "--cwd".to_string(), "/proj".to_string(),
            "--message".to_string(), "fix the bug".to_string(),
        ];
        let cmd = build_agent_open_cmd(&args);
        assert_eq!(cmd["command"], json!(["claude", "-p", "fix the bug"]));
        assert_eq!(cmd["cwd"].as_str(), Some("/proj"));
    }

    #[test]
    fn agent_run_codex_with_message_uses_full_auto() {
        let args = [
            "codex".to_string(),
            "--message".to_string(), "add tests".to_string(),
        ];
        let cmd = build_agent_open_cmd(&args);
        assert_eq!(cmd["command"], json!(["codex", "-a", "full-auto", "-q", "add tests"]));
        assert!(cmd["cwd"].is_null());
    }

    #[test]
    fn agent_run_unknown_agent_passes_message_as_arg() {
        let args = [
            "opencode".to_string(),
            "--message".to_string(), "hello".to_string(),
        ];
        let cmd = build_agent_open_cmd(&args);
        assert_eq!(cmd["command"], json!(["opencode", "hello"]));
    }

    #[test]
    fn agent_run_no_cwd_omits_field() {
        let args = ["claude".to_string()];
        let cmd = build_agent_open_cmd(&args);
        assert!(cmd["cwd"].is_null());
    }
}
