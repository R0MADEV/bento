//! bento-daemon — background process that owns terminals/agents and exposes
//! them over a localhost line-delimited JSON protocol. The CLI and (later) the
//! Tauri app and the phone HTTP server all connect here.

mod ipc;
mod remote;

use bento_core::PtyManager;

#[tokio::main]
async fn main() {
    let addr = std::env::var("BENTO_DAEMON_ADDR").unwrap_or_else(|_| "127.0.0.1:7877".into());
    let manager = PtyManager::new();

    // Phone remote server (opt-in): set BENTO_REMOTE_ADDR, e.g. 0.0.0.0:7879.
    if let Ok(remote_addr) = std::env::var("BENTO_REMOTE_ADDR") {
        let token =
            std::env::var("BENTO_REMOTE_TOKEN").unwrap_or_else(|_| remote::generate_token());
        eprintln!("bento-daemon phone token: {token}");
        let manager = manager.clone();
        tokio::spawn(async move {
            if let Err(error) = remote::serve(&remote_addr, manager, token).await {
                eprintln!("bento-daemon remote: {error}");
            }
        });
    }

    if let Err(error) = ipc::serve(&addr, manager).await {
        eprintln!("bento-daemon: {error}");
        std::process::exit(1);
    }
}
