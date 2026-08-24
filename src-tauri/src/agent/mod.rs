use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::future::join_all;
use serde::Deserialize;
use tauri::{State, Window};
use tokio::process::Command;
use tokio::sync::oneshot;
use uuid::Uuid;

pub mod chat_history;
pub mod history;
mod run;
pub mod sessions;
pub mod socket;

use run::{run_agent, set_process_group};

// How each agent is invoked and how its output is parsed lives in
// `bento-review`, shared with the daemon (phone remote) and the CLI.
use bento_review::agents::{invocation as agent_invocation, resolve_executable};

const AGENT_TIMEOUT: Duration = Duration::from_secs(120);
// A review is now one full-change analysis per agent (it reads files via tools),
// so a single call legitimately needs longer than the old 5-minute cap.
const REVIEW_TIMEOUT: Duration = Duration::from_secs(1200);
pub(super) const MAX_OUTPUT: usize = 4 * 1024 * 1024;
pub(super) const MAX_STDERR: usize = 64 * 1024;
pub(super) const MAX_LINE: usize = 512 * 1024;
const MAX_PRE_CANCELLED: usize = 1024;
pub(super) const WAIT_TIMEOUT: Duration = Duration::from_secs(10);

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
    let mut command = if args.agent == "custom" {
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
    } else {
        let invocation = agent_invocation(
            &args.agent,
            &prompt,
            &root.to_string_lossy(),
            args.session_id.as_deref(),
            args.review,
        )?;
        // Resolved rather than run by bare name: a GUI app on macOS doesn't
        // inherit the shell PATH, and the agents install into per-user dirs.
        let program = resolve_executable(&invocation.program)
            .ok_or_else(|| format!("executable not found: {}", invocation.program))?;
        let mut command = Command::new(program);
        command.args(invocation.args);
        command
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
    let review_worktree = if args.review && crate::review::is_managed_review_worktree(&root) {
        crate::review::set_review_worktree_writable(&root, false)?;
        Some(root.clone())
    } else {
        None
    };
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            if let Some(path) = review_worktree.as_ref() {
                let _ = crate::review::set_review_worktree_writable(path, true);
            }
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
        if let Some(path) = review_worktree.as_ref() {
            let _ = crate::review::set_review_worktree_writable(path, true);
        }
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
