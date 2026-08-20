use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use sysinfo::{Pid, System};
use tokio::sync::broadcast;

/// How to open a PTY. If `command` is set it is run directly (argv); otherwise
/// the user's login shell (or `shell`) is started interactively.
#[derive(Default, Clone)]
pub struct OpenOptions {
    /// Caller-provided id. When set it is used verbatim (so the Tauri app and the
    /// CLI can address the same terminal by the same id); otherwise one is generated.
    pub id: Option<String>,
    pub shell: Option<String>,
    pub command: Option<Vec<String>>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub rows: u16,
    pub cols: u16,
    pub title: Option<String>,
}

/// A moment in a terminal's life: a chunk of output, or the process exiting.
#[derive(Clone, Debug)]
pub enum PtyEvent {
    Output(String),
    Exit(Option<i32>),
}

/// Public metadata about an open terminal.
#[derive(Clone, Debug)]
pub struct PtyInfo {
    pub id: String,
    pub title: String,
    pub cwd: String,
}

struct Instance {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    tx: broadcast::Sender<PtyEvent>,
    title: String,
    cwd: String,
}

/// Manages the lifetime of every PTY. Cheap to clone (shared internally).
#[derive(Clone, Default)]
pub struct PtyManager {
    instances: Arc<Mutex<HashMap<String, Instance>>>,
    counter: Arc<AtomicU64>,
}

// Bounded so a slow subscriber can't grow memory without limit; a lagging
// subscriber loses the oldest output (RecvError::Lagged) rather than blocking.
const OUTPUT_BUFFER: usize = 2048;

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open a PTY, spawn its process, and start streaming its output to
    /// subscribers. Returns the new terminal id.
    pub fn open(&self, opts: OpenOptions) -> Result<String, String> {
        let rows = if opts.rows == 0 { 24 } else { opts.rows };
        let cols = if opts.cols == 0 { 80 } else { opts.cols };
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let mut cmd = match opts.command.as_ref().filter(|c| !c.is_empty()) {
            Some(argv) => {
                let mut c = CommandBuilder::new(&argv[0]);
                for arg in &argv[1..] {
                    c.arg(arg);
                }
                c
            }
            None => {
                let shell = opts
                    .shell
                    .clone()
                    .or_else(|| std::env::var("SHELL").ok())
                    .unwrap_or_else(default_shell);
                let mut c = CommandBuilder::new(&shell);
                if !cfg!(windows) {
                    c.arg("-l");
                }
                c
            }
        };
        cmd.env("TERM", "xterm-256color");
        for (key, value) in &opts.env {
            cmd.env(key, value);
        }
        let start_dir = opts
            .cwd
            .clone()
            .map(|d| match d.strip_prefix("~/") {
                Some(rest) => dirs_home().map(|home| format!("{home}/{rest}")).unwrap_or(d),
                None => d,
            })
            .filter(|d| !d.is_empty() && std::path::Path::new(d).is_dir())
            .or_else(dirs_home);
        if let Some(dir) = start_dir.as_ref() {
            cmd.cwd(dir);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

        let id = match opts.id {
            Some(id) if !id.is_empty() => {
                if self.instances.lock().unwrap().contains_key(&id) {
                    return Err(format!("terminal id already in use: {id}"));
                }
                id
            }
            _ => format!("pty-{}", self.counter.fetch_add(1, Ordering::SeqCst) + 1),
        };
        let (tx, _rx) = broadcast::channel(OUTPUT_BUFFER);
        let cwd = start_dir.unwrap_or_default();
        let title = opts.title.unwrap_or_else(|| id.clone());

        self.instances.lock().unwrap().insert(
            id.clone(),
            Instance {
                writer,
                master: pair.master,
                child,
                tx: tx.clone(),
                title,
                cwd,
            },
        );

        // Blocking read loop on its own thread; forwards output to subscribers.
        let manager = self.clone();
        let reader_id = id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        let text = drain_utf8(&mut pending);
                        if !text.is_empty() {
                            let _ = tx.send(PtyEvent::Output(text));
                        }
                    }
                }
            }
            let code = manager.reap(&reader_id);
            let _ = tx.send(PtyEvent::Exit(code));
        });

        Ok(id)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let mut guard = self.instances.lock().unwrap();
        let instance = guard.get_mut(id).ok_or("pty not found")?;
        instance
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        instance.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let guard = self.instances.lock().unwrap();
        let instance = guard.get(id).ok_or("pty not found")?;
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

    pub fn close(&self, id: &str) -> Result<(), String> {
        match self.instances.lock().unwrap().remove(id) {
            Some(instance) => {
                terminate_instance(instance);
                Ok(())
            }
            None => Err("pty not found".into()),
        }
    }

    pub fn list(&self) -> Vec<PtyInfo> {
        self.instances
            .lock()
            .unwrap()
            .iter()
            .map(|(id, instance)| PtyInfo {
                id: id.clone(),
                title: instance.title.clone(),
                cwd: instance.cwd.clone(),
            })
            .collect()
    }

    pub fn subscribe(&self, id: &str) -> Option<broadcast::Receiver<PtyEvent>> {
        self.instances
            .lock()
            .unwrap()
            .get(id)
            .map(|instance| instance.tx.subscribe())
    }

    pub fn kill_all(&self) {
        let instances: Vec<Instance> = self
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

    // The reader thread calls this on EOF: drop the instance and reap its child.
    fn reap(&self, id: &str) -> Option<i32> {
        let instance = self.instances.lock().unwrap().remove(id);
        instance.and_then(|mut i| i.child.wait().ok().map(|status| status.exit_code() as i32))
    }
}

fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".into()
    } else {
        "/bin/sh".into()
    }
}

fn dirs_home() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
}

fn terminate_instance(mut instance: Instance) {
    if let Some(pid) = instance.child.process_id() {
        terminate_process_tree(pid);
    }
    let _ = instance.child.kill();
    let _ = instance.child.wait();
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
        // Agents may ignore SIGTERM; SIGKILL guarantees their memory is released.
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

    for pid in tree.into_iter().rev() {
        // SAFETY: handles are checked and closed; PROCESS_TERMINATE is minimal.
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid.as_u32());
            if !handle.is_null() {
                TerminateProcess(handle, 1);
                CloseHandle(handle);
            }
        }
    }
}

/// Drains as much valid UTF-8 as possible from `pending`, keeping any incomplete
/// trailing multi-byte sequence for the next read (PTY reads can split a glyph
/// across the buffer boundary).
fn drain_utf8(pending: &mut Vec<u8>) -> String {
    let valid = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
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
    use super::*;

    #[test]
    fn drain_utf8_keeps_split_multibyte() {
        let mut p = vec![0xE2, 0x94];
        assert_eq!(drain_utf8(&mut p), "");
        assert_eq!(p, vec![0xE2, 0x94]);
        p.push(0x80);
        assert_eq!(drain_utf8(&mut p), "─");
        assert!(p.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn open_streams_output_then_exits() {
        let manager = PtyManager::new();
        let id = manager
            .open(OpenOptions {
                // Sleep first so subscribe() runs before any output is produced.
                command: Some(vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "sleep 0.2; printf hello".into(),
                ]),
                ..Default::default()
            })
            .unwrap();
        let mut rx = manager.subscribe(&id).expect("subscribe");

        let mut got = String::new();
        loop {
            match rx.recv().await {
                Ok(PtyEvent::Output(text)) => got.push_str(&text),
                Ok(PtyEvent::Exit(_)) => break,
                Err(_) => break,
            }
        }
        assert!(got.contains("hello"), "unexpected output: {got:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn lists_and_closes_terminals() {
        let manager = PtyManager::new();
        let id = manager
            .open(OpenOptions {
                command: Some(vec!["/bin/sh".into(), "-c".into(), "sleep 5".into()]),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(manager.list().len(), 1);
        manager.close(&id).unwrap();
        assert!(manager.list().is_empty());
        assert!(manager.close(&id).is_err());
    }
}
