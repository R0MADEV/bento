use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{Arc, Mutex};

/// Removes leftover /tmp/bento-agent-*.sock files from previous runs. A socket is
/// stale if nothing is listening (connect refused); sockets of other live Bento
/// instances still accept a connection and are left untouched.
fn sweep_stale_sockets(current: &str) {
    let Ok(entries) = std::fs::read_dir("/tmp") else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let is_bento_socket = name.starts_with("bento-agent-") && name.ends_with(".sock");
        if !is_bento_socket || path.to_string_lossy() == current {
            continue;
        }
        if UnixStream::connect(&path).is_err() {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Shared state: maps HERDR_PANE_ID → agent_session_id
pub struct AgentSocket {
    pub socket_path: String,
    sessions: Arc<Mutex<HashMap<String, String>>>,
}

impl AgentSocket {
    pub fn get_session(&self, pane_id: &str) -> Option<String> {
        self.sessions.lock().ok()?.get(pane_id).cloned()
    }
}

/// Starts the Unix socket server in a background thread and returns the shared
/// state. Call once at app startup; inject socket_path + pane_id into every
/// agent PTY so existing herdr hooks can report their session ID back here.
pub fn start(app_handle: &tauri::AppHandle) -> Arc<AgentSocket> {
    let _ = app_handle; // used for future extensibility
    let socket_path = format!("/tmp/bento-agent-{}.sock", std::process::id());

    let _ = std::fs::remove_file(&socket_path);
    let sessions: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));

    let state = Arc::new(AgentSocket {
        socket_path: socket_path.clone(),
        sessions: sessions.clone(),
    });

    let listener = match UnixListener::bind(&socket_path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("bento agent socket: failed to bind {socket_path}: {e}");
            return state;
        }
    };

    sweep_stale_sockets(&socket_path);

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let sessions = sessions.clone();
            std::thread::spawn(move || {
                // Bound the read so a client that connects but never sends a full
                // line can't pin this thread open forever (thread exhaustion).
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
                let mut reader = BufReader::new(&stream);
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    return;
                }
                let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
                    return;
                };
                let request_id = msg
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if msg.get("method").and_then(|v| v.as_str())
                    == Some("pane.report_agent_session")
                {
                    if let Some(params) = msg.get("params") {
                        let pane_id = params
                            .get("pane_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let session_id = params
                            .get("agent_session_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if !pane_id.is_empty() && !session_id.is_empty() {
                            if let Ok(mut map) = sessions.lock() {
                                map.insert(pane_id, session_id);
                            }
                        }
                    }
                }
                let response =
                    format!("{{\"id\":\"{request_id}\",\"result\":{{}}}}\n");
                let _ = stream.write_all(response.as_bytes());
            });
        }
    });

    state
}

#[tauri::command]
pub fn agent_get_session(
    pane_id: String,
    state: tauri::State<Arc<AgentSocket>>,
) -> Option<String> {
    state.get_session(&pane_id)
}

#[tauri::command]
pub fn agent_socket_path(state: tauri::State<Arc<AgentSocket>>) -> String {
    state.socket_path.clone()
}
