//! bento-daemon — background process that owns terminals/agents and exposes
//! them over a localhost line-delimited JSON protocol. The CLI and (later) the
//! Tauri app and the phone HTTP server all connect here.

mod ipc;

use bento_core::PtyManager;

#[tokio::main]
async fn main() {
    let addr = std::env::var("BENTO_DAEMON_ADDR").unwrap_or_else(|_| "127.0.0.1:7877".into());
    let manager = PtyManager::new();
    if let Err(error) = ipc::serve(&addr, manager).await {
        eprintln!("bento-daemon: {error}");
        std::process::exit(1);
    }
}
