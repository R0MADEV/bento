//! El bucle que lee la salida de un agente: eventos al frontend, límites de
//! tamaño, timeout y matar el grupo de procesos al cancelar.

use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use std::time::Duration;

use tauri::{Emitter, Window};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;

use bento_review::agents::{AgentEvent, AgentParser};

use super::{MAX_LINE, MAX_OUTPUT, MAX_STDERR, WAIT_TIMEOUT};

pub(super) async fn run_agent(
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
    let mut parser = AgentParser::new(&agent);
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
                        AgentEvent::SessionId(sid) => session_id = Some(sid),
                        AgentEvent::Chunk(text) => {
                            output_size += text.len();
                            if output_size > MAX_OUTPUT { kill_process_group(&mut child, true).await; emit_error_once(&terminal, &window, &id, "agent output too large"); return }
                            window.emit(&format!("agent://chunk:{id}"), serde_json::json!({ "text": text })).ok();
                        }
                        AgentEvent::ToolUse(tool) => {
                            window.emit(&format!("agent://tool:{id}"), serde_json::json!({ "tool": tool })).ok();
                        }
                        AgentEvent::Error(message) => emit_error_once(&terminal, &window, &id, &message),
                        AgentEvent::Done | AgentEvent::Ignore => {}
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
pub(super) fn set_process_group(command: &mut Command) {
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
pub(super) fn set_process_group(_: &mut Command) {}

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

#[cfg(test)]
mod tests {
    use super::safe_prefix;

    #[test]
    fn safe_prefix_never_splits_utf8() {
        assert_eq!(safe_prefix("aé", 2), "a");
        assert_eq!(safe_prefix("aé", 3), "aé");
    }
}
