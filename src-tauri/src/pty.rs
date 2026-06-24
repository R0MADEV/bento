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

/// Drains as much valid UTF-8 as possible from `pending`, returning it and
/// keeping any incomplete trailing multi-byte sequence for the next read.
/// PTY reads can split a multi-byte char across the 4096-byte buffer boundary;
/// decoding each chunk lossily would corrupt box-drawing/Unicode glyphs, which
/// shows up as flicker/tremble in TUIs (vim, top, catunes).
fn drain_utf8(pending: &mut Vec<u8>) -> String {
    let valid = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        // Leading invalid byte (genuine garbage, not a split): drop it so we
        // don't stall forever waiting for a continuation that won't come.
        Err(e) if e.valid_up_to() == 0 && e.error_len().is_some() => {
            pending.remove(0);
            0
        }
        Err(e) => e.valid_up_to(),
    };
    let rest = pending.split_off(valid);
    String::from_utf8(std::mem::replace(pending, rest)).unwrap()
}

#[cfg(test)]
mod tests {
    use super::drain_utf8;

    #[test]
    fn returns_complete_ascii() {
        let mut p = b"hello".to_vec();
        assert_eq!(drain_utf8(&mut p), "hello");
        assert!(p.is_empty());
    }

    #[test]
    fn keeps_split_multibyte_char() {
        // "─" is 0xE2 0x94 0x80; arrives split across two reads.
        let mut p = vec![0xE2, 0x94];
        assert_eq!(drain_utf8(&mut p), "");
        assert_eq!(p, vec![0xE2, 0x94]);

        p.push(0x80);
        assert_eq!(drain_utf8(&mut p), "─");
        assert!(p.is_empty());
    }

    #[test]
    fn emits_valid_prefix_and_keeps_partial_tail() {
        // "a" + first two bytes of "─"
        let mut p = vec![b'a', 0xE2, 0x94];
        assert_eq!(drain_utf8(&mut p), "a");
        assert_eq!(p, vec![0xE2, 0x94]);
    }
}

#[tauri::command]
pub fn pty_spawn(
    id: String,
    shell: String,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    // When set, run this argv directly (e.g. `docker exec -it <c> sh`) instead of
    // the user's login shell — used by the Docker panel's exec terminal.
    command: Option<Vec<String>>,
    state: tauri::State<Arc<PtyManager>>,
    app: AppHandle,
) -> Result<(), String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = match command.filter(|c| !c.is_empty()) {
        Some(argv) => {
            let mut c = CommandBuilder::new(&argv[0]);
            for arg in &argv[1..] {
                c.arg(arg);
            }
            c
        }
        None => {
            // Usa el shell por defecto del usuario ($SHELL) para que cargue su config
            // (zsh/bash con prompt, git, autocompletado). Fallback al pasado por el front.
            let user_shell = std::env::var("SHELL").unwrap_or(shell);
            let mut c = CommandBuilder::new(&user_shell);
            // Login + interactivo: carga ~/.zprofile, ~/.zshrc, etc.
            if !cfg!(target_os = "windows") {
                c.arg("-l");
            }
            c
        }
    };
    cmd.env("TERM", "xterm-256color");

    // Restore the saved cwd if it still exists (so a reopened terminal lands where
    // it was), else start in the user's home like a normal terminal.
    let start_dir = cwd
        .filter(|d| !d.is_empty() && std::path::Path::new(d).is_dir())
        .or_else(dirs_home);
    if let Some(dir) = start_dir {
        cmd.cwd(dir);
    }

    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let id_clone = id.clone();
    let app_clone = app.clone();

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        // Holds bytes of a multi-byte char split across reads (see drain_utf8).
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let data = drain_utf8(&mut pending);
                    if !data.is_empty() {
                        let _ = app_clone.emit(&format!("pty-output-{}", id_clone), data);
                    }
                }
            }
        }
        // EOF: the shell exited (e.g. the user typed `exit`); tell the frontend
        // so it can close the panel instead of leaving a dead terminal.
        let _ = app_clone.emit(&format!("pty-exit-{}", id_clone), ());
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
