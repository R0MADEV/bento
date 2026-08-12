use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use sysinfo::{Pid, System};
use tauri::{AppHandle, Emitter};

struct PtyInstance {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    instances: Mutex<HashMap<String, PtyInstance>>,
}

#[cfg(unix)]
fn terminate_process_tree(root: u32) {
    let session = Pid::from_u32(root);
    let members = |system: &System| -> Vec<i32> {
        system
            .processes()
            .iter()
            .filter_map(|(pid, process)| {
                (process.session_id() == Some(session)).then_some(pid.as_u32() as i32)
            })
            .collect()
    };

    let system = System::new_all();
    for pid in members(&system) {
        // SAFETY: the PID comes from the current system process snapshot.
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    std::thread::sleep(std::time::Duration::from_millis(150));
    let system = System::new_all();
    for pid in members(&system) {
        // Agents may handle/ignore SIGHUP and SIGTERM; SIGKILL guarantees that
        // closing their owning terminal actually releases their memory.
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }
}

#[cfg(windows)]
fn terminate_process_tree(root: u32) {
    use std::ffi::c_void;

    type Handle = *mut c_void;
    const PROCESS_TERMINATE: u32 = 0x0001;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> Handle;
        fn TerminateProcess(process: Handle, exit_code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    let system = System::new_all();
    let mut tree = vec![Pid::from_u32(root)];
    loop {
        let before = tree.len();
        for (pid, process) in system.processes() {
            if process
                .parent()
                .is_some_and(|parent| tree.contains(&parent))
                && !tree.contains(pid)
            {
                tree.push(*pid);
            }
        }
        if tree.len() == before {
            break;
        }
    }

    // Children first so they cannot survive after their parent disappears.
    for pid in tree.into_iter().rev() {
        // SAFETY: handles are checked and closed, and PROCESS_TERMINATE is the
        // minimum access required for this operation.
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid.as_u32());
            if !handle.is_null() {
                TerminateProcess(handle, 1);
                CloseHandle(handle);
            }
        }
    }
}

fn terminate_instance(mut instance: PtyInstance) {
    if let Some(pid) = instance.child.process_id() {
        terminate_process_tree(pid);
    }
    let _ = instance.child.kill();
    let _ = instance.child.wait();
}

pub fn kill_all(manager: &PtyManager) {
    let instances: Vec<PtyInstance> = manager
        .instances
        .lock()
        .unwrap()
        .drain()
        .map(|(_, instance)| instance)
        .collect();
    for instance in instances {
        terminate_instance(instance);
    }
}

fn dirs_home() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
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

    #[cfg(unix)]
    #[test]
    fn terminating_a_pty_kills_its_whole_session() {
        use super::{terminate_instance, PtyInstance};
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "sleep 30 & wait"]);
        let child = pair.slave.spawn_command(command).unwrap();
        let pid = child.process_id().unwrap();
        let writer = pair.master.take_writer().unwrap();

        terminate_instance(PtyInstance {
            writer,
            master: pair.master,
            child,
        });

        // Signal 0 only checks existence; ESRCH proves the session leader was
        // killed and reaped rather than merely detached from the UI.
        let exists = unsafe { libc::kill(pid as i32, 0) } == 0;
        assert!(!exists, "PTY process {pid} survived termination");
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
    agent_socket: tauri::State<Arc<crate::agent_socket::AgentSocket>>,
    app: AppHandle,
) -> Result<(), String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
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
            // Use the user's default shell ($SHELL) so it loads their config
            // (zsh/bash with prompt, git, autocompletion). Fall back to the one passed by the front.
            let user_shell = std::env::var("SHELL").unwrap_or(shell);
            let mut c = CommandBuilder::new(&user_shell);
            // Login + interactive: loads ~/.zprofile, ~/.zshrc, etc.
            if !cfg!(target_os = "windows") {
                c.arg("-l");
            }
            c
        }
    };
    cmd.env("TERM", "xterm-256color");
    // Inject herdr-compatible env vars so existing agent hooks (Claude, Codex,
    // OpenCode) can report their session ID back to Bento's socket server.
    cmd.env("HERDR_ENV", "1");
    cmd.env("HERDR_SOCKET_PATH", &agent_socket.socket_path);
    cmd.env("HERDR_PANE_ID", &id);

    // Restore the saved cwd if it still exists (so a reopened terminal lands where
    // it was), else start in the user's home like a normal terminal.
    // Expand leading ~ so display paths saved by the frontend work correctly.
    let start_dir = cwd
        .map(|d| {
            if d.starts_with("~/") {
                dirs_home().map(|h| h + &d[1..]).unwrap_or(d)
            } else {
                d
            }
        })
        .filter(|d| !d.is_empty() && std::path::Path::new(d.as_str()).is_dir())
        .or_else(dirs_home);
    if let Some(dir) = start_dir {
        cmd.cwd(dir);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let id_clone = id.clone();
    let app_clone = app.clone();

    state.instances.lock().unwrap().insert(
        id.clone(),
        PtyInstance {
            writer,
            master: pair.master,
            child,
        },
    );

    let manager = state.inner().clone();
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
        let instance = manager.instances.lock().unwrap().remove(&id_clone);
        if let Some(instance) = instance {
            terminate_instance(instance);
        }
        let _ = app_clone.emit(&format!("pty-exit-{}", id_clone), ());
    });

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
    instance
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
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
    instance
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(id: String, state: tauri::State<Arc<PtyManager>>) -> Result<(), String> {
    let instance = state.instances.lock().unwrap().remove(&id);
    if let Some(instance) = instance {
        terminate_instance(instance);
    }
    Ok(())
}
