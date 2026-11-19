use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use sysinfo::{Pid, ProcessRefreshKind, System, UpdateKind};
use tokio::sync::broadcast;

use crate::output::{drain_utf8, push_scrollback};
use crate::process_tree::terminate_process_tree;

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
    TitleChanged(String),
    /// The terminal changed size: every client draws it at this one.
    Resized { rows: u16, cols: u16 },
}

/// Public metadata about an open terminal.
#[derive(Clone, Debug)]
pub struct PtyInfo {
    pub id: String,
    pub title: String,
    pub cwd: String,
}

/// The process a terminal is running in the foreground.
#[derive(Clone, Debug)]
pub struct ForegroundProcess {
    pub pid: u32,
    pub argv: Vec<String>,
    pub env: Vec<String>,
    pub cwd: Option<String>,
}

struct Instance {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    tx: broadcast::Sender<PtyEvent>,
    // Recent output, replayed to a client that (re)attaches so it isn't blank.
    scrollback: Arc<Mutex<Vec<u8>>>,
    /// The modes the program has on (mouse, alternate screen…): the replay alone
    /// rarely still holds the switch, so a late client is told separately.
    modes: Arc<Mutex<crate::modes::Modes>>,
    /// Clients that ack what they paint; the reader waits on the slowest.
    flow: Arc<crate::flow::FlowControl>,
    title: String,
    cwd: String,
    /// (rows, cols). One size for every client: the last one to ask sets it.
    size: (u16, u16),
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

/// Cómo se llama una terminal recién abierta. Quien la abre puede decirlo —el
/// escritorio manda el nombre del panel o del agente—, y si no, vale más el
/// directorio en el que está que su identificador: `bento` dice dónde estás,
/// `pty-19` y `pty-mobile-233d02e8` no dicen nada.
/// Variables that mark a process as living inside someone else's session: a
/// herdr pane, or a shell that Claude Code is running. A Bento terminal is
/// neither, so they must not leak in when Bento itself was started from one —
/// with Claude Code's, every `claude` in Bento would take itself for a child of
/// that session and stop saving its conversation. Settings such as
/// `CLAUDE_CONFIG_DIR` are the user's choice and stay.
fn is_foreign_session_var(key: &str) -> bool {
    let is_herdr_pane = key.starts_with("HERDR_");
    let is_claude_code_session = key == "CLAUDECODE" || key == "CLAUDE_PID" || key.starts_with("CLAUDE_CODE_");
    is_herdr_pane || is_claude_code_session
}

/// A generated id that no terminal is using. A restored terminal keeps the id
/// it had, so the counter alone could hand out one that is already taken.
fn next_free_id(counter: &AtomicU64, is_taken: impl Fn(&str) -> bool) -> String {
    loop {
        let id = format!("pty-{}", counter.fetch_add(1, Ordering::SeqCst) + 1);
        if !is_taken(&id) {
            return id;
        }
    }
}

fn default_title(requested: Option<String>, cwd: &str, id: &str) -> String {
    if let Some(title) = requested.filter(|t| !t.trim().is_empty()) {
        return title;
    }
    std::path::Path::new(cwd)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| id.to_string())
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open a PTY, spawn its process, and start streaming its output to
    /// subscribers. Returns `(id, reattached)`: if `opts.id` names a terminal that
    /// is already open it is returned as-is (`reattached = true`) without spawning
    /// again — the caller must then NOT replay a launch command onto it.
    pub fn set_title(&self, id: &str, title: &str) {
        let tx = {
            let mut guard = self.instances.lock().unwrap();
            if let Some(instance) = guard.get_mut(id) {
                instance.title = title.to_string();
                Some(instance.tx.clone())
            } else {
                None
            }
        };
        if let Some(tx) = tx {
            let _ = tx.send(PtyEvent::TitleChanged(title.to_string()));
        }
    }

    pub fn open(&self, opts: OpenOptions) -> Result<(String, bool), String> {
        if let Some(id) = opts.id.as_deref().filter(|id| !id.is_empty()) {
            let mut guard = self.instances.lock().unwrap();
            if let Some(instance) = guard.get_mut(id) {
                if let Some(title) = &opts.title {
                    instance.title = title.clone();
                }
                return Ok((id.to_string(), true));
            }
        }
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
        for (key, _) in std::env::vars().filter(|(key, _)| is_foreign_session_var(key)) {
            cmd.env_remove(key);
        }
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

        let id = opts
            .id
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| next_free_id(&self.counter, |id| self.instances.lock().unwrap().contains_key(id)));
        let (tx, _rx) = broadcast::channel(OUTPUT_BUFFER);
        let scrollback = Arc::new(Mutex::new(Vec::<u8>::new()));
        let modes = Arc::new(Mutex::new(crate::modes::Modes::default()));
        let flow = Arc::new(crate::flow::FlowControl::default());
        let cwd = start_dir.unwrap_or_default();
        let title = default_title(opts.title, &cwd, &id);

        {
            let mut guard = self.instances.lock().unwrap();
            if guard.contains_key(&id) {
                // Lost a race with a concurrent open of the same id: keep the first.
                drop(guard);
                let mut child = child;
                let _ = child.kill();
                let _ = child.wait();
                return Ok((id, true));
            }
            guard.insert(
                id.clone(),
                Instance {
                    writer,
                    master: pair.master,
                    child,
                    tx: tx.clone(),
                    scrollback: scrollback.clone(),
                    modes: modes.clone(),
                    flow: flow.clone(),
                    title,
                    cwd,
                    size: (rows, cols),
                },
            );
        }

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
                            push_scrollback(&scrollback, text.as_bytes());
                            modes.lock().unwrap().feed(text.as_bytes());
                            let _ = tx.send(PtyEvent::Output(text));
                            flow.wait_for_clients();
                        }
                    }
                }
            }
            let code = manager.reap(&reader_id);
            let _ = tx.send(PtyEvent::Exit(code));
        });

        Ok((id, false))
    }

    /// Recent output for a terminal, so a (re)attaching client can be primed.
    pub fn scrollback(&self, id: &str) -> Option<String> {
        self.instances
            .lock()
            .unwrap()
            .get(id)
            .map(|instance| {
                let modes = instance.modes.lock().unwrap().restore();
                let recent = instance.scrollback.lock().unwrap();
                format!("{modes}{}", String::from_utf8_lossy(&recent))
            })
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
        let mut guard = self.instances.lock().unwrap();
        let instance = guard.get_mut(id).ok_or("pty not found")?;
        // Same size: no SIGWINCH, so a client can ask as often as it likes.
        if instance.size == (rows, cols) {
            return Ok(());
        }
        instance
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        instance.size = (rows, cols);
        let _ = instance.tx.send(PtyEvent::Resized { rows, cols });
        Ok(())
    }

    /// The terminal's current (rows, cols).
    pub fn size(&self, id: &str) -> Option<(u16, u16)> {
        self.instances.lock().unwrap().get(id).map(|instance| instance.size)
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

    /// The process in the terminal's foreground (the shell, or whatever it is
    /// running): its pid, argv, environment and working directory.
    pub fn foreground_process(&self, id: &str) -> Option<ForegroundProcess> {
        let leader = self.instances.lock().unwrap().get(id)?.master.process_group_leader()?;
        let pid = Pid::from_u32(u32::try_from(leader).ok()?);
        let mut system = System::new();
        // refresh_process alone loads none of argv, the environment or the cwd.
        let kind = ProcessRefreshKind::new()
            .with_cmd(UpdateKind::Always)
            .with_environ(UpdateKind::Always)
            .with_cwd(UpdateKind::Always);
        system.refresh_process_specifics(pid, kind);
        let process = system.process(pid)?;
        Some(ForegroundProcess {
            pid: pid.as_u32(),
            argv: process.cmd().to_vec(),
            env: process.environ().to_vec(),
            cwd: process.cwd().map(|dir| dir.to_string_lossy().into_owned()),
        })
    }

    /// A flow-controlled seat on the terminal: report what was sent and acked
    /// through it, and the reader pauses while this client is too far behind.
    pub fn flow_client(&self, id: &str) -> Option<crate::FlowClient> {
        let flow = self.instances.lock().unwrap().get(id)?.flow.clone();
        Some(crate::FlowClient::join(flow))
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

#[cfg(test)]
mod tests {
    use super::*;

    // Bento launched from inside herdr inherits its pane variables; passing them
    // on would make `herdr` (and its agent hooks) treat a Bento terminal as one
    // of herdr's own panes.
    #[test]
    fn another_multiplexers_pane_variables_are_not_inherited() {
        assert!(is_foreign_session_var("HERDR_ENV"));
        assert!(is_foreign_session_var("HERDR_SOCKET_PATH"));
        assert!(is_foreign_session_var("HERDR_PANE_ID"));
        assert!(!is_foreign_session_var("HOME"));
        assert!(!is_foreign_session_var("CLAUDE_CONFIG_DIR"));
    }

    // Bento opened from a shell that Claude Code is running inherits the marks
    // of that session. With them, every `claude` started in a Bento terminal
    // takes itself for a child of it and stops saving its conversation.
    #[test]
    fn the_marks_of_a_claude_code_session_are_not_inherited() {
        assert!(is_foreign_session_var("CLAUDECODE"));
        assert!(is_foreign_session_var("CLAUDE_PID"));
        assert!(is_foreign_session_var("CLAUDE_CODE_CHILD_SESSION"));
        assert!(is_foreign_session_var("CLAUDE_CODE_SESSION_ID"));
        assert!(is_foreign_session_var("CLAUDE_CODE_MESSAGING_SOCKET"));
        // Settings, not session marks: the user's own choice, kept.
        assert!(!is_foreign_session_var("CLAUDE_CONFIG_DIR"));
        assert!(!is_foreign_session_var("CLAUDE_EFFORT"));
    }

    // A restored agent keeps the id it had ("pty-1"), and the counter starts
    // over with the daemon: handing that id out again made the new terminal
    // silently become the restored one.
    #[test]
    fn a_generated_id_skips_the_ones_already_taken() {
        let counter = AtomicU64::new(0);
        let taken = ["pty-1", "pty-2"];
        assert_eq!(next_free_id(&counter, |id| taken.contains(&id)), "pty-3");
        assert_eq!(next_free_id(&counter, |_| false), "pty-4");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn open_streams_output_then_exits() {
        let manager = PtyManager::new();
        let (id, _) = manager
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
                Ok(PtyEvent::TitleChanged(_) | PtyEvent::Resized { .. }) => {}
                Err(_) => break,
            }
        }
        assert!(got.contains("hello"), "unexpected output: {got:?}");
    }

    // Every client draws the terminal at the size the daemon reports, so a
    // resize has to reach all of them. An unchanged one must reach nobody: a
    // TUI would repaint its whole screen (into every scrollback) for nothing.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_resize_is_announced_to_the_clients_only_when_the_size_changes() {
        let manager = PtyManager::new();
        let (id, _) = manager
            .open(OpenOptions {
                command: Some(vec!["/bin/sleep".into(), "5".into()]),
                rows: 24,
                cols: 80,
                ..Default::default()
            })
            .unwrap();
        let mut events = manager.subscribe(&id).unwrap();
        assert_eq!(manager.size(&id), Some((24, 80)));

        manager.resize(&id, 24, 80).unwrap();
        manager.resize(&id, 30, 100).unwrap();

        assert_eq!(manager.size(&id), Some((30, 100)));
        let first = events.recv().await.unwrap();
        assert!(matches!(first, PtyEvent::Resized { rows: 30, cols: 100 }), "got {first:?}");
        let _ = manager.close(&id);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reopening_an_id_reattaches_and_keeps_scrollback() {
        let manager = PtyManager::new();
        let (id, reattached) = manager
            .open(OpenOptions {
                id: Some("term-1".into()),
                command: Some(vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "printf marker; sleep 5".into(),
                ]),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(id, "term-1");
        assert!(!reattached, "first open is a fresh terminal");
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        // Reopening the same id returns the SAME terminal (no second process).
        let (again, reattached) = manager
            .open(OpenOptions {
                id: Some("term-1".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(again, "term-1");
        assert!(reattached, "second open reattaches");
        assert_eq!(manager.list().len(), 1);

        // Scrollback carries the earlier output so a reattaching client isn't blank.
        let scrollback = manager.scrollback("term-1").unwrap();
        assert!(scrollback.contains("marker"), "scrollback: {scrollback:?}");
        manager.close("term-1").unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn lists_and_closes_terminals() {
        let manager = PtyManager::new();
        let (id, _) = manager
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

#[cfg(test)]
mod title_tests {
    use super::default_title;

    #[test]
    fn a_terminal_is_named_after_the_folder_it_opens_in() {
        // `pty-19` y `pty-mobile-233d02e8` no dicen nada; el directorio sí.
        assert_eq!(default_title(None, "/Users/quien/Desktop/roma/bento", "pty-19"), "bento");
    }

    #[test]
    fn what_the_client_asked_for_wins() {
        assert_eq!(default_title(Some("Claude".into()), "/repo", "pty-19"), "Claude");
        // Un nombre en blanco es no haber pedido nada.
        assert_eq!(default_title(Some("  ".into()), "/repo", "pty-19"), "repo");
    }

    #[test]
    fn with_no_folder_to_borrow_from_it_keeps_its_id() {
        assert_eq!(default_title(None, "", "pty-19"), "pty-19");
        assert_eq!(default_title(None, "/", "pty-19"), "pty-19");
    }
}
