use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

struct PtyInstance {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

#[derive(Default)]
pub struct PtyManager {
    instances: Mutex<HashMap<String, PtyInstance>>,
}

fn dirs_home() -> Option<String> {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok()
}

#[tauri::command]
pub fn pty_spawn(
    id: String,
    shell: String,
    rows: u16,
    cols: u16,
    state: tauri::State<Arc<PtyManager>>,
    app: AppHandle,
) -> Result<(), String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    // Usa el shell por defecto del usuario ($SHELL) para que cargue su config
    // (zsh/bash con prompt, git, autocompletado). Fallback al pasado por el front.
    let user_shell = std::env::var("SHELL").unwrap_or(shell);

    let mut cmd = CommandBuilder::new(&user_shell);
    // Login + interactivo: carga ~/.zprofile, ~/.zshrc, etc.
    if !cfg!(target_os = "windows") {
        cmd.arg("-l");
    }
    cmd.env("TERM", "xterm-256color");
    // Arranca en el home del usuario, como una terminal normal
    if let Some(home) = dirs_home() {
        cmd.cwd(home);
    }

    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let id_clone = id.clone();
    let app_clone = app.clone();

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit(&format!("pty-output-{}", id_clone), data);
                }
            }
        }
    });

    state.instances.lock().unwrap().insert(
        id,
        PtyInstance { writer, master: pair.master },
    );

    Ok(())
}

#[tauri::command]
pub fn pty_write(
    id: String,
    data: String,
    state: tauri::State<Arc<PtyManager>>,
) -> Result<(), String> {
    let mut instances = state.instances.lock().unwrap();
    let instance = instances.get_mut(&id).ok_or("PTY not found")?;
    instance.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    id: String,
    rows: u16,
    cols: u16,
    state: tauri::State<Arc<PtyManager>>,
) -> Result<(), String> {
    let instances = state.instances.lock().unwrap();
    let instance = instances.get(&id).ok_or("PTY not found")?;
    instance.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(id: String, state: tauri::State<Arc<PtyManager>>) -> Result<(), String> {
    state.instances.lock().unwrap().remove(&id);
    Ok(())
}
