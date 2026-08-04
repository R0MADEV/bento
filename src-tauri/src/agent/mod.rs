use std::collections::HashMap;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use futures::future::join_all;
use serde::Deserialize;
use tauri::{Emitter, State, Window};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;
use uuid::Uuid;

mod adapter;
mod claude;
mod codex;
mod custom;
mod opencode;
#[cfg(test)]
mod tests;

const AGENT_TIMEOUT: Duration = Duration::from_secs(120);
const REVIEW_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_OUTPUT: usize = 4 * 1024 * 1024;
const MAX_STDERR: usize = 64 * 1024;
const MAX_LINE: usize = 512 * 1024;
const MAX_PRE_CANCELLED: usize = 1024;
const WAIT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
struct AgentState {
    processes: HashMap<String, ProcessHandle>,
    cancelled: HashMap<String, Instant>,
    started: HashMap<String, Instant>,
    shutting_down: bool,
}

struct ProcessHandle {
    cancel_tx: oneshot::Sender<()>,
    done_rx: oneshot::Receiver<()>,
}

#[derive(Clone, Default)]
pub struct AgentManager {
    state: Arc<Mutex<AgentState>>,
}

#[derive(Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct StartAgentArgs {
    pub request_id: String,
    pub agent: String,
    pub message: String,
    #[serde(default)]
    pub history: Vec<Message>,
    pub project_path: String,
    pub session_id: Option<String>,
    pub custom_executable: Option<String>,
    pub custom_args: Option<Vec<String>>,
    #[serde(default)]
    pub review: bool,
    #[serde(default)]
    pub cleanup_project_path: bool,
}

#[tauri::command]
pub async fn start_agent(
    window: Window,
    state: State<'_, AgentManager>,
    args: StartAgentArgs,
) -> Result<(), String> {
    let request_id =
        Uuid::parse_str(&args.request_id).map_err(|_| "invalid request_id".to_string())?;
    let root = Path::new(&args.project_path)
        .canonicalize()
        .map_err(|e| format!("invalid project_path: {e}"))?;
    if !root.is_dir() {
        return Err("project_path is not a directory".into());
    }
    if args.review && args.agent == "custom" {
        return Err("custom agents are disabled in review mode".into());
    }
    let prompt = if args.session_id.is_some() {
        args.message.clone()
    } else {
        build_prompt(&args.message, &args.history)
    };
    let mut command = match args.agent.as_str() {
        "claude" => {
            let mut command = Command::new("claude");
            command
                .arg("-p")
                .arg(&prompt)
                .arg("--output-format")
                .arg("stream-json")
                .arg("--verbose");
            if let Some(session_id) = args.session_id.as_deref() {
                command.arg("--resume").arg(session_id);
            }
            if args.review {
                command.arg("--allowedTools").arg("Read,Glob,Grep");
            }
            command
        }
        "opencode" => {
            let mut command = Command::new("opencode");
            command
                .args(["run", "--format", "json", "--dir"])
                .arg(&root)
                .arg(&prompt);
            if let Some(session_id) = args.session_id.as_deref() {
                command.arg("--session").arg(session_id);
            }
            command
        }
        "codex" => {
            let mut command = Command::new("codex");
            command
                .args(["exec", "--sandbox", "read-only", "--cd"])
                .arg(&root);
            if let Some(session_id) = args.session_id.as_deref() {
                command
                    .arg("resume")
                    .args(["--json", "--skip-git-repo-check"])
                    .arg(session_id)
                    .arg(&prompt);
            } else {
                command
                    .args(["--json", "--skip-git-repo-check"])
                    .arg(&prompt);
            }
            command
        }
        "custom" => {
            let executable = args
                .custom_executable
                .as_deref()
                .ok_or("custom executable is required")?;
            let resolved = resolve_executable(executable)
                .ok_or_else(|| format!("executable not found: {executable}"))?;
            let mut command = Command::new(resolved);
            if let Some(custom_args) = args.custom_args.as_ref() {
                command.args(custom_args);
            }
            command.arg(&prompt);
            command
        }
        other => return Err(format!("unsupported agent: {other}")),
    };
    command.current_dir(&root);
    set_process_group(&mut command);
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let (done_tx, done_rx) = oneshot::channel();
    {
        let mut agent_state = state
            .state
            .lock()
            .map_err(|_| "agent state poisoned".to_string())?;
        if agent_state.shutting_down {
            return Err("agent manager is shutting down".into());
        }
        let now = Instant::now();
        agent_state
            .cancelled
            .retain(|_, timestamp| now.duration_since(*timestamp) < Duration::from_secs(60));
        agent_state
            .started
            .retain(|_, timestamp| now.duration_since(*timestamp) < Duration::from_secs(60));
        if agent_state
            .cancelled
            .remove(&request_id.to_string())
            .is_some()
        {
            return Ok(());
        }
        if agent_state.processes.contains_key(&request_id.to_string()) {
            return Err("duplicate request_id".into());
        }
        agent_state.started.insert(request_id.to_string(), now);
        agent_state
            .processes
            .insert(request_id.to_string(), ProcessHandle { cancel_tx, done_rx });
    }
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            state
                .state
                .lock()
                .ok()
                .map(|mut value| value.processes.remove(&request_id.to_string()));
            return Err(format!("could not start agent: {error}"));
        }
    };

    let manager = state.inner().clone();
    let id = request_id.to_string();
    let agent = args.agent.clone();
    let cleanup_path = args.cleanup_project_path.then_some(root.clone());
    let timeout = if args.review { REVIEW_TIMEOUT } else { AGENT_TIMEOUT };
    tokio::spawn(async move {
        run_agent(window, id.clone(), agent, child, cancel_rx, timeout).await;
        if let Some(path) = cleanup_path {
            let _ = crate::review::release_managed_context_path(&path);
        }
        let _ = done_tx.send(());
        manager
            .state
            .lock()
            .ok()
            .map(|mut value| value.processes.remove(&id));
    });
    Ok(())
}

#[tauri::command]
pub async fn cancel_agent(
    state: State<'_, AgentManager>,
    request_id: String,
) -> Result<(), String> {
    if Uuid::parse_str(&request_id).is_err() {
        return Ok(());
    }
    let handle = {
        let mut agent_state = state
            .state
            .lock()
            .map_err(|_| "agent state poisoned".to_string())?;
        let handle = agent_state.processes.remove(&request_id);
        if handle.is_none()
            && !agent_state.shutting_down
            && !agent_state.started.contains_key(&request_id)
            && agent_state.cancelled.len() < MAX_PRE_CANCELLED
        {
            agent_state
                .cancelled
                .insert(request_id.clone(), Instant::now());
        }
        handle
    };
    if let Some(handle) = handle {
        handle.cancel_tx.send(()).ok();
        let _ = tokio::time::timeout(WAIT_TIMEOUT + Duration::from_secs(5), handle.done_rx).await;
    }
    Ok(())
}

pub async fn cancel_all(manager: &AgentManager) {
    let cancellations = manager
        .state
        .lock()
        .ok()
        .map(|mut state| {
            state.shutting_down = true;
            state
                .processes
                .drain()
                .map(|(_, handle)| handle)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let waits = cancellations.into_iter().map(|handle| async move {
        handle.cancel_tx.send(()).ok();
        let _ = tokio::time::timeout(WAIT_TIMEOUT + Duration::from_secs(5), handle.done_rx).await;
    });
    join_all(waits).await;
}

fn build_prompt(message: &str, history: &[Message]) -> String {
    let mut prompt = String::new();
    for item in history.iter().rev().take(20).rev() {
        prompt.push_str(&item.role);
        prompt.push_str(": ");
        prompt.push_str(&item.content);
        prompt.push('\n');
    }
    prompt.push_str("user: ");
    prompt.push_str(message);
    prompt
}

fn resolve_executable(executable: &str) -> Option<std::path::PathBuf> {
    let path = Path::new(executable);
    if path.is_absolute() {
        return is_executable(path).then(|| path.to_path_buf());
    }
    std::env::split_paths(&std::env::var("PATH").unwrap_or_default())
        .map(|dir| dir.join(executable))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    path.is_file()
        && matches!(
            path.extension().and_then(|ext| ext.to_str()),
            Some("exe" | "cmd" | "bat")
        )
}

async fn run_agent(
    window: Window,
    id: String,
    agent: String,
    mut child: Child,
    mut cancel: oneshot::Receiver<()>,
    timeout: Duration,
) {
    let terminal = Arc::new(AtomicBool::new(false));
    let Some(stdout) = child.stdout.take() else {
        emit_error_once(&terminal, &window, &id, "claude stdout unavailable");
        return;
    };
    let Some(stderr) = child.stderr.take() else {
        emit_error_once(&terminal, &window, &id, "claude stderr unavailable");
        return;
    };
    let parser: Box<dyn adapter::AgentAdapter> = match agent.as_str() {
        "claude" => Box::new(claude::ClaudeAdapter),
        "opencode" => Box::new(opencode::OpenCodeAdapter),
        "codex" => Box::new(codex::CodexAdapter),
        _ => Box::new(custom::CustomAdapter),
    };
    let mut out = BufReader::new(stdout).lines();
    let mut err = BufReader::new(stderr).lines();
    let mut stderr_text = String::new();
    let mut session_id = None;
    let mut output_size = 0usize;
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let mut out_done = false;
    let mut err_done = false;

    loop {
        if out_done && err_done {
            break;
        }
        tokio::select! {
            _ = &mut cancel => { kill_process_group(&mut child, false).await; return }
            _ = &mut deadline => { kill_process_group(&mut child, true).await; emit_error_once(&terminal, &window, &id, "agent timeout"); return }
            line = out.next_line(), if !out_done => match line {
                Ok(Some(line)) => {
                    if line.len() > MAX_LINE {
                        kill_process_group(&mut child, true).await;
                        emit_error_once(&terminal, &window, &id, "agent output line too large");
                        return;
                    }
                    match parser.parse_line(&line) {
                        adapter::ParsedLine::SessionId(sid) => session_id = Some(sid),
                        adapter::ParsedLine::Chunk(text) => {
                            output_size += text.len();
                            if output_size > MAX_OUTPUT { kill_process_group(&mut child, true).await; emit_error_once(&terminal, &window, &id, "agent output too large"); return }
                            window.emit(&format!("agent://chunk:{id}"), serde_json::json!({ "text": text })).ok();
                        }
                        adapter::ParsedLine::ToolUse(tool) => {
                            window.emit(&format!("agent://tool:{id}"), serde_json::json!({ "tool": tool })).ok();
                        }
                        adapter::ParsedLine::Error(message) => emit_error_once(&terminal, &window, &id, &message),
                        adapter::ParsedLine::Done | adapter::ParsedLine::Ignore => {}
                    }
                }
                Ok(None) => out_done = true,
                Err(e) => { kill_process_group(&mut child, true).await; emit_error_once(&terminal, &window, &id, &e.to_string()); return }
            },
            line = err.next_line(), if !err_done => match line {
                Ok(Some(line)) => { if stderr_text.len() < MAX_STDERR { stderr_text.push_str(safe_prefix(&line, MAX_STDERR - stderr_text.len())); stderr_text.push('\n'); } }
                Ok(None) => err_done = true,
                Err(_) => err_done = true,
            },
        }
    }
    let status = match tokio::time::timeout(WAIT_TIMEOUT, child.wait()).await {
        Ok(status) => status,
        Err(_) => {
            kill_process_group(&mut child, true).await;
            emit_error_once(
                &terminal,
                &window,
                &id,
                "agent process did not exit after kill",
            );
            return;
        }
    };
    if !status.map(|s| s.success()).unwrap_or(false) {
        emit_error_once(
            &terminal,
            &window,
            &id,
            if stderr_text.is_empty() {
                "agent exited with an error"
            } else {
                &stderr_text
            },
        );
        return;
    }
    if terminal
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        window
            .emit(
                &format!("agent://done:{id}"),
                serde_json::json!({ "session_id": session_id }),
            )
            .ok();
    }
}

fn safe_prefix(text: &str, max_bytes: usize) -> &str {
    let mut end = 0;
    for (index, character) in text.char_indices() {
        let next = index + character.len_utf8();
        if next > max_bytes {
            break;
        }
        end = next
    }
    &text[..end]
}

fn emit_error_once(terminal: &AtomicBool, window: &Window, id: &str, message: &str) {
    if terminal
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        window
            .emit(
                &format!("agent://error:{id}"),
                serde_json::json!({ "message": message }),
            )
            .ok();
    }
}

#[cfg(unix)]
fn set_process_group(command: &mut Command) {
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn set_process_group(_: &mut Command) {}

async fn kill_process_group(child: &mut Child, force: bool) {
    #[cfg(unix)]
    if let Some(id) = child.id() {
        let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
        unsafe {
            libc::kill(-(id as i32), signal);
        }
    }
    if force {
        child.kill().await.ok();
    }
    if tokio::time::timeout(WAIT_TIMEOUT, child.wait())
        .await
        .is_err()
        && !force
    {
        #[cfg(unix)]
        if let Some(id) = child.id() {
            unsafe {
                libc::kill(-(id as i32), libc::SIGKILL);
            }
        }
        child.kill().await.ok();
        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    }
}
