//! bento-daemon — background process that owns terminals/agents and exposes
//! them over a localhost line-delimited JSON protocol. The CLI and the Tauri
//! app and the phone HTTP server all connect here.

mod agents;
mod ipc;
mod remote;

use bento_core::PtyManager;
use remote::RemoteControl;

/// Keeps the computer from going to sleep on its own while the daemon runs:
/// asleep, the agents stop and the phone can no longer reach them. Putting it
/// to sleep by hand, or closing the lid, still works. `caffeinate -w` waits
/// for this process and ends with it, however it dies, so nothing is left
/// holding the machine awake.
#[cfg(target_os = "macos")]
fn stay_awake() {
    use std::process::{Command, Stdio};
    let spawned = Command::new("/usr/bin/caffeinate")
        .args(["-i", "-w", &std::process::id().to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    if let Err(error) = spawned {
        eprintln!("bento-daemon: the computer may go to sleep (caffeinate: {error})");
    }
}

#[cfg(not(target_os = "macos"))]
fn stay_awake() {}

#[tokio::main]
async fn main() {
    let addr = std::env::var("BENTO_DAEMON_ADDR").unwrap_or_else(|_| "127.0.0.1:7877".into());
    let manager = PtyManager::new();
    let remote = RemoteControl::default();

    // Opt-in via env for the manual / test workflow:
    //   BENTO_REMOTE_ADDR=0.0.0.0:7879 BENTO_REMOTE_TOKEN=mytoken bento-daemon
    if let Ok(remote_addr) = std::env::var("BENTO_REMOTE_ADDR") {
        let port: u16 = remote_addr.split(':').next_back()
            .and_then(|p| p.parse().ok())
            .unwrap_or(7879);
        let token = std::env::var("BENTO_REMOTE_TOKEN").ok();
        match remote.start(manager.clone(), port, token, false).await {
            Ok(info) => eprintln!("bento-daemon phone token: {}", info.token),
            Err(e) => eprintln!("bento-daemon remote: {e}"),
        }
    }

    // Only once the address is ours: a second daemon that fails to bind must
    // not resume the agents the first one is already running.
    let listener = match ipc::bind(&addr).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("bento-daemon: {error}");
            std::process::exit(1);
        }
    };
    stay_awake();
    agents::restore(&manager);
    agents::watch(manager.clone());

    if let Err(error) = ipc::serve(listener, manager, remote).await {
        eprintln!("bento-daemon: {error}");
        std::process::exit(1);
    }
}
