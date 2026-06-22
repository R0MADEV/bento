#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod pty;
mod traffic_lights;

use std::sync::Arc;

// Descarga HTTP desde el backend Rust: evita los límites del WebView con
// ficheros grandes (la API de iptv-org pesa decenas de MB).
#[tauri::command]
async fn http_get(url: String) -> Result<String, String> {
    let res = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    res.text().await.map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Arc::new(pty::PtyManager::default()))
        .invoke_handler(tauri::generate_handler![
            http_get,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            traffic_lights::set_traffic_lights_visible,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
