//! The daemon's side of the agent registry: it watches what runs in each
//! terminal, keeps the record on disk and, when it starts, reopens the agents
//! that were running. Living here rather than in a client is what makes the
//! app, the CLI and the phone see and resume the same agents.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use bento_core::{OpenOptions, PtyEvent, PtyInfo, PtyManager};
use bento_sessions::{load_records, registry_path, resume_folder, save_records, updated_record, verified_resume_line, AgentRecord};

const PROBE_EVERY: Duration = Duration::from_secs(4);
/// How long a restored shell gets to print its prompt before the resume line is
/// typed anyway.
const SHELL_READY_TIMEOUT: Duration = Duration::from_secs(5);
const AFTER_PROMPT: Duration = Duration::from_millis(150);

fn records() -> &'static Mutex<Vec<AgentRecord>> {
    static RECORDS: OnceLock<Mutex<Vec<AgentRecord>>> = OnceLock::new();
    RECORDS.get_or_init(Mutex::default)
}

/// The agent last seen in a terminal, if it ever ran one.
pub fn of(pty_id: &str) -> Option<AgentRecord> {
    records().lock().ok()?.iter().find(|record| record.pty_id == pty_id).cloned()
}

/// A terminal as every client lists it: with an agent, the folder and branch
/// are the agent's, not the ones the terminal was born in.
pub fn describe(info: &PtyInfo) -> serde_json::Value {
    let record = of(&info.id);
    let agent_cwd = record.as_ref().and_then(|record| record.cwd.clone());
    serde_json::json!({
        "pty_id": info.id,
        "title": info.title,
        "cwd": agent_cwd.unwrap_or_else(|| info.cwd.clone()),
        "agent": record.as_ref().map(|record| record.agent.clone()),
        "branch": record.and_then(|record| record.branch),
    })
}

/// Reopens the agents that were running when the daemon last stopped, each in
/// its own terminal (same id, so a client that remembers it reattaches instead
/// of opening a second one) and on its own session.
pub fn restore(manager: &PtyManager) {
    let Ok(path) = registry_path() else { return };
    let saved = load_records(&path);
    if let Ok(mut current) = records().lock() {
        *current = saved.clone();
    }
    for record in saved {
        let opts = OpenOptions {
            id: Some(record.pty_id.clone()),
            title: Some(record.title.clone()),
            // Where its conversation lives, which `--resume` needs to find it.
            cwd: resume_folder(&record),
            ..Default::default()
        };
        let Ok((id, reattached)) = manager.open(opts) else { continue };
        if reattached {
            continue;
        }
        let Some(line) = verified_resume_line(&record) else { continue };
        tokio::spawn(type_when_ready(manager.clone(), id, line));
    }
}

/// Types `line` once the shell has printed its prompt: typed any earlier, a
/// shell that clears its input while starting would lose it.
async fn type_when_ready(manager: PtyManager, id: String, line: String) {
    if let Some(mut output) = manager.subscribe(&id) {
        let first_output = async {
            while let Ok(event) = output.recv().await {
                if matches!(event, PtyEvent::Output(_)) {
                    break;
                }
            }
        };
        let _ = tokio::time::timeout(SHELL_READY_TIMEOUT, first_output).await;
        tokio::time::sleep(AFTER_PROMPT).await;
    }
    let _ = manager.write(&id, &format!("{line}\r"));
}

/// Keeps the registry in step with what the terminals are running.
pub fn watch(manager: PtyManager) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(PROBE_EVERY).await;
            let manager = manager.clone();
            // Off the runtime: it reads the process table and runs lsof and git.
            let _ = tokio::task::spawn_blocking(move || refresh(&manager)).await;
        }
    });
}

fn refresh(manager: &PtyManager) {
    let Ok(previous) = records().lock().map(|current| current.clone()) else { return };
    // A terminal that is gone (closed, or its shell exited) drops its record.
    let next: Vec<AgentRecord> = manager
        .list()
        .iter()
        .filter_map(|pty| {
            let running = manager
                .foreground_process(&pty.id)
                .and_then(|process| bento_sessions::running_agent(process.pid, &process.argv, &process.env, process.cwd.clone()));
            let before = previous.iter().find(|record| record.pty_id == pty.id);
            let mut record = updated_record(before, &pty.id, &pty.title, running)?;
            record.branch = record.cwd.as_deref().and_then(|cwd| bento_review::vcs::current_branch(cwd).ok());
            Some(record)
        })
        .collect();
    if next == previous {
        return;
    }
    if let Ok(path) = registry_path() {
        if let Err(error) = save_records(&path, &next) {
            eprintln!("bento-daemon: could not save the agents: {error}");
        }
    }
    if let Ok(mut current) = records().lock() {
        *current = next;
    }
}
