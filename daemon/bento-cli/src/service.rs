//! Arrancar el daemon y registrarlo como servicio de sesión, que es lo único
//! que cambia de verdad entre macOS, Linux y Windows.

use tokio::net::TcpStream;

use crate::addr;

pub(crate) async fn daemon_start() -> std::io::Result<()> {
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
pub(crate) fn daemon_install() -> std::io::Result<()> {
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
pub(crate) fn daemon_uninstall() -> std::io::Result<()> {
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
pub(crate) fn daemon_install() -> std::io::Result<()> {
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
pub(crate) fn daemon_uninstall() -> std::io::Result<()> {
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
pub(crate) fn daemon_install() -> std::io::Result<()> {
    Err(io_err("auto-start not supported on this OS — start the daemon manually with: bento daemon start"))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) fn daemon_uninstall() -> std::io::Result<()> {
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
