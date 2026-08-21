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
        Some("daemon") => match args.get(1).map(String::as_str) {
            Some("status")    => request(json!({ "id": "1", "cmd": "daemon.status" })).await,
            Some("start")     => daemon_start().await,
            Some("install")   => daemon_install(),
            Some("uninstall") => daemon_uninstall(),
            _ => { print_help(); Ok(()) }
        },
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
    std::io::Error::new(std::io::ErrorKind::Other, msg)
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

// ── IPC helpers ───────────────────────────────────────────────────────────────

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
    eprintln!("  bento daemon start         start the daemon in the background");
    eprintln!("  bento daemon install       register daemon as a login service");
    eprintln!("  bento daemon uninstall     remove the login service");
    eprintln!("  bento terminals            list open terminals");
    eprintln!("  bento open [--cwd <dir>]   open a new terminal");
    eprintln!("  bento attach <pty_id>      attach to a terminal (stdin/stdout)");
    eprintln!();
    eprintln!("env: BENTO_DAEMON_ADDR (default 127.0.0.1:7877)");
}
