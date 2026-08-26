//! Running the coding agents (`claude`, `codex`, `opencode`, or any custom
//! executable): how each one is invoked and how its JSON stream is read.
//!
//! Both codebases had their own version of this and each knew things the
//! other didn't — the desktop restricted Claude's tools during a review and
//! resolved executables outside PATH, the daemon read Claude's streaming
//! deltas and Codex's `session_meta`. This is the union.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// Los agentes que hay, como tipo. Existe para que TypeScript lo herede
/// generado: si aquí aparece uno nuevo, el panel deja de compilar hasta que le
/// dé una etiqueta.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../src/generated/bindings/"))]
#[serde(rename_all = "lowercase")]
pub enum AgentId {
    Claude,
    Codex,
    Opencode,
    /// Un ejecutable propio que configura quien lo usa.
    Custom,
}

/// Un agente que Bento sabe lanzar: su identificador y cómo se llama en la
/// interfaz.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Agent {
    pub id: &'static str,
    pub label: &'static str,
}

/// Los agentes soportados, en el orden en que se ofrecen. Es la única lista:
/// el panel, el TUI y el móvil la sacan de aquí, y `invocation` tiene que saber
/// lanzar a todos (lo comprueba un test).
pub const AGENTS: [Agent; 3] = [
    Agent { id: "claude", label: "Claude" },
    Agent { id: "codex", label: "Codex" },
    Agent { id: "opencode", label: "OpenCode" },
];

/// Los identificadores, para quien solo necesite elegir uno.
pub fn ids() -> Vec<&'static str> {
    AGENTS.iter().map(|agent| agent.id).collect()
}

/// Si es un agente de la lista. Lo que no lo es puede seguir lanzándose como
/// ejecutable propio, pero no se ofrece.
pub fn is_known(id: &str) -> bool {
    AGENTS.iter().any(|agent| agent.id == id)
}

/// Cómo se llama en la interfaz. Lo desconocido se queda con su propio id, que
/// dice más que un nombre inventado.
pub fn label(id: &str) -> &str {
    AGENTS
        .iter()
        .find(|agent| agent.id == id)
        .map(|agent| agent.label)
        .unwrap_or(id)
}

/// El siguiente de la lista, para ir rotando con una tecla.
pub fn next_id(current: &str) -> &'static str {
    let index = AGENTS.iter().position(|agent| agent.id == current).unwrap_or(0);
    AGENTS[(index + 1) % AGENTS.len()].id
}

/// What one line of an agent's output means.
#[derive(Debug, PartialEq)]
pub enum AgentEvent {
    /// Text for the user.
    Chunk(String),
    /// The agent used a tool — progress, and evidence of what it looked at.
    ToolUse(String),
    /// The session id, for resuming this conversation later.
    SessionId(String),
    Error(String),
    Done,
    Ignore,
}

/// How to launch an agent. `program` is a bare command name; resolve it with
/// [`resolve_executable`] when PATH can't be trusted (a GUI app on macOS, a
/// daemon started as a login service).
#[derive(Debug)]
pub struct Invocation {
    pub program: String,
    pub args: Vec<String>,
}

/// Builds the argv for one agent run. `review` puts the agent in read-only
/// mode where it has one: without it a review can edit the code it is meant
/// to be reviewing.
pub fn invocation(
    agent: &str,
    prompt: &str,
    cwd: &str,
    session_id: Option<&str>,
    review: bool,
) -> Result<Invocation, String> {
    let owned = |parts: &[&str]| parts.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    match agent {
        "claude" => {
            let mut args = owned(&["-p", prompt, "--output-format", "stream-json", "--verbose"]);
            if let Some(session_id) = session_id {
                args.extend(owned(&["--resume", session_id]));
            }
            if review {
                args.extend(owned(&["--allowedTools", "Read,Glob,Grep"]));
            }
            Ok(Invocation { program: "claude".into(), args })
        }
        "opencode" => {
            let mut args = owned(&["run", "--format", "json", "--dir", cwd, prompt]);
            if let Some(session_id) = session_id {
                args.extend(owned(&["--session", session_id]));
            }
            if review {
                args.extend(owned(&["--agent", "plan"]));
            }
            Ok(Invocation { program: "opencode".into(), args })
        }
        // codex is read-only through its own sandbox flag, review or not.
        "codex" => {
            let mut args = owned(&["exec", "--sandbox", "read-only", "--cd", cwd]);
            match session_id {
                Some(session_id) => args.extend(owned(&["resume", "--json", "--skip-git-repo-check", session_id, prompt])),
                None => args.extend(owned(&["--json", "--skip-git-repo-check", prompt])),
            }
            Ok(Invocation { program: "codex".into(), args })
        }
        other => Err(format!("unsupported agent: {other}")),
    }
}

/// Finds an executable when PATH alone won't do — a macOS GUI app doesn't
/// inherit the shell's PATH, and agents install into per-user directories.
pub fn resolve_executable(executable: &str) -> Option<PathBuf> {
    let path = Path::new(executable);
    if path.is_absolute() {
        return is_executable(path).then(|| path.to_path_buf());
    }
    let mut candidates: Vec<PathBuf> = std::env::split_paths(&std::env::var("PATH").unwrap_or_default())
        .map(|dir| dir.join(executable))
        .collect();
    if let Ok(home) = std::env::var("HOME") {
        candidates.extend([
            PathBuf::from(&home).join(".local/bin").join(executable),
            PathBuf::from(&home).join("bin").join(executable),
            PathBuf::from(&home).join(".opencode/bin").join(executable),
            PathBuf::from("/opt/homebrew/bin").join(executable),
            PathBuf::from("/usr/local/bin").join(executable),
        ]);
    }
    candidates.into_iter().find(|candidate| is_executable(candidate))
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
        && matches!(path.extension().and_then(|ext| ext.to_str()), Some("exe" | "cmd" | "bat"))
}

/// Reads one agent's output stream. Stateful because Claude can report the
/// same text twice — as streaming deltas and again in the final assistant
/// message — so once deltas have been seen the final message is dropped.
pub struct AgentParser {
    agent: String,
    saw_delta: bool,
}

impl AgentParser {
    pub fn new(agent: &str) -> Self {
        Self { agent: agent.to_string(), saw_delta: false }
    }

    pub fn parse_line(&mut self, line: &str) -> AgentEvent {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            // Only a custom executable is expected to emit non-JSON; for the
            // built-ins a stray line is noise (a warning, a banner).
            return match self.agent.as_str() {
                "claude" | "codex" | "opencode" => AgentEvent::Ignore,
                _ if line.is_empty() => AgentEvent::Ignore,
                _ => AgentEvent::Chunk(line.to_string()),
            };
        };
        match self.agent.as_str() {
            "claude" => self.parse_claude(&value),
            "codex" => parse_codex(&value),
            "opencode" => parse_opencode(&value),
            _ if line.is_empty() => AgentEvent::Ignore,
            _ => AgentEvent::Chunk(line.to_string()),
        }
    }

    fn parse_claude(&mut self, value: &Value) -> AgentEvent {
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        if event_type == "system" {
            if let Some(id) = value.get("session_id").and_then(Value::as_str) {
                return AgentEvent::SessionId(id.to_string());
            }
            return AgentEvent::Ignore;
        }
        if event_type == "result" {
            let failed = value.get("is_error").and_then(Value::as_bool) == Some(true);
            if !failed {
                return AgentEvent::Done;
            }
            let message = value.get("error").and_then(Value::as_str).unwrap_or("agent error");
            return AgentEvent::Error(message.to_string());
        }
        if event_type == "content_block_delta" {
            let text = value.get("delta").and_then(|d| d.get("text")).and_then(Value::as_str).unwrap_or("");
            if text.is_empty() {
                return AgentEvent::Ignore;
            }
            self.saw_delta = true;
            return AgentEvent::Chunk(text.to_string());
        }
        let Some(parts) = value.get("message").and_then(|m| m.get("content")).and_then(Value::as_array) else {
            return AgentEvent::Ignore;
        };
        let text: String = parts
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect();
        if !text.is_empty() {
            // Already streamed as deltas — emitting it again would duplicate
            // the whole answer.
            return if self.saw_delta { AgentEvent::Ignore } else { AgentEvent::Chunk(text) };
        }
        let Some(tool) = parts.iter().find(|p| p.get("type").and_then(Value::as_str) == Some("tool_use")) else {
            return AgentEvent::Ignore;
        };
        let name = tool.get("name").and_then(Value::as_str).unwrap_or("tool");
        let target = tool
            .get("input")
            .and_then(|i| i.get("file_path").or_else(|| i.get("path")).or_else(|| i.get("pattern")))
            .and_then(Value::as_str)
            .unwrap_or("");
        AgentEvent::ToolUse(describe_tool(name, target))
    }
}

fn describe_tool(name: &str, target: &str) -> String {
    if target.is_empty() {
        return name.to_string();
    }
    format!("{name}: {}", target.chars().take(500).collect::<String>())
}

/// `codex exec --json` (v0.146+), one JSON object per line.
fn parse_codex(value: &Value) -> AgentEvent {
    let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    if event_type == "thread.started" {
        if let Some(id) = value.get("thread_id").and_then(Value::as_str) {
            return AgentEvent::SessionId(id.to_string());
        }
    }
    if event_type == "session_meta" {
        if let Some(id) = value.get("payload").and_then(|p| p.get("id")).and_then(Value::as_str) {
            return AgentEvent::SessionId(id.to_string());
        }
    }
    if event_type == "turn.completed" {
        return AgentEvent::Done;
    }
    if event_type != "item.completed" {
        return AgentEvent::Ignore;
    }
    let Some(item) = value.get("item") else { return AgentEvent::Ignore };
    match item.get("type").and_then(Value::as_str).unwrap_or("") {
        "agent_message" => match item.get("text").and_then(Value::as_str).unwrap_or("") {
            "" => AgentEvent::Ignore,
            text => AgentEvent::Chunk(text.to_string()),
        },
        "command_execution" => match item.get("command").and_then(Value::as_str).unwrap_or("") {
            "" => AgentEvent::Ignore,
            command => AgentEvent::ToolUse(describe_tool("Command", command)),
        },
        // `error` items are hook/config warnings, not the model failing.
        _ => AgentEvent::Ignore,
    }
}

/// `opencode run --format json` (v1.18+), one JSON object per line.
fn parse_opencode(value: &Value) -> AgentEvent {
    let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    let part = value.get("part");
    if event_type == "step_finish" {
        let finished = part.and_then(|p| p.get("reason")).and_then(Value::as_str) == Some("stop");
        let id = value.get("sessionID").and_then(Value::as_str).unwrap_or("");
        return match (finished, id.is_empty()) {
            (true, false) => AgentEvent::SessionId(id.to_string()),
            _ => AgentEvent::Ignore,
        };
    }
    if event_type == "text" {
        let text = part.and_then(|p| p.get("text")).and_then(Value::as_str).unwrap_or("");
        if !text.is_empty() {
            return AgentEvent::Chunk(text.to_string());
        }
    }
    let part_type = part.and_then(|p| p.get("type")).and_then(Value::as_str).unwrap_or("");
    if event_type != "tool_use" && part_type != "tool" {
        return AgentEvent::Ignore;
    }
    let name = part
        .and_then(|p| p.get("tool").or_else(|| p.get("name")))
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let target = part
        .and_then(|p| p.get("state"))
        .and_then(|s| s.get("input"))
        .and_then(|input| {
            ["filePath", "file_path", "path", "pattern", "command"]
                .iter()
                .find_map(|key| input.get(*key).and_then(Value::as_str))
        })
        .unwrap_or("");
    AgentEvent::ToolUse(describe_tool(name, target))
}


// ── Running one agent ────────────────────────────────────────────────────────

/// A single line longer than this means the agent is emitting something we
/// don't understand (or a runaway); stop rather than buffer it.
const MAX_LINE: usize = 1 << 20;
/// Total text a single run may produce.
const MAX_OUTPUT: usize = 8 << 20;
/// How long to wait for the next line before giving the run up for dead.
const LINE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Un fallo transitorio (límite de peticiones, red, el proceso muriéndose) se
/// puede reintentar; un timeout no, porque significa que el trabajo no cabía
/// en la ventana y repetirlo quema otra. Misma regla que usa el desktop en
/// `isRetryableReviewError`.
pub fn is_retryable(message: &str) -> bool {
    let lower = message.to_lowercase();
    if lower.contains("timeout") || lower.contains("timed out") {
        return false;
    }
    ["rate limit", "rate-limit", "too many requests", "429", "overloaded", "529", "503", "502",
     "connection", "econnreset", "network", "socket hang up", "temporar", "exited with an error"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// Runs an agent to completion, streaming its text through `tx` as it
/// arrives, and returns the whole text plus the session id for resuming.
/// `None` means the agent could not be launched, failed, or the receiver
/// went away.
///
/// The child is spawned with `kill_on_drop`: if this future is cancelled —
/// the TUI's review being stopped, an HTTP client disconnecting — the real
/// subprocess must die with it, which tokio does NOT do by default. Without
/// it a cancelled review keeps running, and billing, unseen.
pub async fn run_collecting(
    agent: &str,
    cwd: &str,
    prompt: &str,
    session_id: Option<&str>,
    review: bool,
    tx: &tokio::sync::mpsc::Sender<String>,
) -> Option<(String, Option<String>)> {
    run_collecting_with_tools(agent, cwd, prompt, session_id, review, tx, &mut |_| {}).await
}

/// Igual, pero avisando de cada herramienta que usa el agente: es lo único que
/// se ve mientras piensa, y la evidencia de qué miró para decir lo que dice.
#[allow(clippy::too_many_arguments)]
pub async fn run_collecting_with_tools(
    agent: &str,
    cwd: &str,
    prompt: &str,
    session_id: Option<&str>,
    review: bool,
    tx: &tokio::sync::mpsc::Sender<String>,
    on_tool: &mut (dyn FnMut(String) + Send),
) -> Option<(String, Option<String>)> {
    let inv = invocation(agent, prompt, cwd, session_id, review).ok()?;
    let program = resolve_executable(&inv.program)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(inv.program);

    let launched_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let mut child = tokio::process::Command::new(program)
        .current_dir(cwd)
        .args(&inv.args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;

    let mut parser = AgentParser::new(agent);
    let mut collected = String::new();
    let mut session = session_id.map(String::from);

    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stdout).lines();
    loop {
        let line = match tokio::time::timeout(LINE_TIMEOUT, lines.next_line()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => break,
            Ok(Err(_)) | Err(_) => {
                let _ = child.kill().await;
                return None;
            }
        };
        if line.len() > MAX_LINE {
            let _ = child.kill().await;
            return None;
        }
        match parser.parse_line(&line) {
            AgentEvent::Chunk(text) => {
                collected.push_str(&text);
                if collected.len() > MAX_OUTPUT || tx.send(text).await.is_err() {
                    let _ = child.kill().await;
                    return None;
                }
            }
            AgentEvent::SessionId(id) => session = Some(id),
            AgentEvent::Error(_) => {
                let _ = child.kill().await;
                return None;
            }
            AgentEvent::ToolUse(tool) => on_tool(tool),
            AgentEvent::Done | AgentEvent::Ignore => {}
        }
    }
    let _ = child.wait().await;

    if agent == "opencode" && session.is_none() {
        session = find_opencode_session(cwd, launched_ms).await;
    }
    Some((collected, session))
}

/// opencode doesn't always report its session id on stdout, so fall back to
/// the newest session its local database recorded for this directory.
pub async fn find_opencode_session(cwd: &str, since_ms: u64) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let db = std::path::PathBuf::from(home).join(".local/share/opencode/opencode.db");
    let query = format!(
        "SELECT id FROM session WHERE directory='{}' AND time_created>{} ORDER BY time_created DESC LIMIT 1",
        cwd.replace('\'', "''"),
        since_ms
    );
    let out = tokio::process::Command::new("sqlite3")
        .args([db.to_str()?, &query])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if id.is_empty() { None } else { Some(id) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args_of(inv: &Invocation) -> Vec<&str> {
        inv.args.iter().map(String::as_str).collect()
    }

    fn parse(agent: &str, line: &str) -> AgentEvent {
        AgentParser::new(agent).parse_line(line)
    }

    // ── Invocación ────────────────────────────────────────────────────────────

    #[test]
    fn claude_streams_json_and_restricts_tools_in_review() {
        let inv = invocation("claude", "PROMPT", "/repo", Some("sess"), true).unwrap();
        assert_eq!(inv.program, "claude");
        assert_eq!(args_of(&inv), vec![
            "-p", "PROMPT", "--output-format", "stream-json", "--verbose",
            "--resume", "sess", "--allowedTools", "Read,Glob,Grep",
        ]);
    }

    #[test]
    fn claude_without_session_or_review() {
        let inv = invocation("claude", "P", "/repo", None, false).unwrap();
        assert_eq!(args_of(&inv), vec!["-p", "P", "--output-format", "stream-json", "--verbose"]);
    }

    #[test]
    fn opencode_passes_dir_prompt_session_and_review_mode() {
        let inv = invocation("opencode", "P", "/repo", Some("s"), false).unwrap();
        assert_eq!(inv.program, "opencode");
        assert_eq!(args_of(&inv), vec!["run", "--format", "json", "--dir", "/repo", "P", "--session", "s"]);
        let review = invocation("opencode", "P", "/repo", Some("s"), true).unwrap();
        assert_eq!(args_of(&review), vec!["run", "--format", "json", "--dir", "/repo", "P", "--session", "s", "--agent", "plan"]);
    }

    #[test]
    fn codex_resume_puts_session_and_prompt_last() {
        let inv = invocation("codex", "P", "/repo", Some("s"), false).unwrap();
        assert_eq!(inv.program, "codex");
        assert_eq!(args_of(&inv), vec![
            "exec", "--sandbox", "read-only", "--cd", "/repo",
            "resume", "--json", "--skip-git-repo-check", "s", "P",
        ]);
    }

    #[test]
    fn codex_without_session_appends_prompt_after_flags() {
        let inv = invocation("codex", "P", "/repo", None, false).unwrap();
        assert_eq!(args_of(&inv), vec![
            "exec", "--sandbox", "read-only", "--cd", "/repo", "--json", "--skip-git-repo-check", "P",
        ]);
    }

    #[test]
    fn unknown_agent_is_rejected() {
        assert!(invocation("foo", "P", "/repo", None, false).is_err());
    }

    // ── Claude ────────────────────────────────────────────────────────────────

    #[test]
    fn claude_system_event_carries_the_session_id() {
        assert!(matches!(parse("claude", r#"{"type":"system","session_id":"s1"}"#), AgentEvent::SessionId(id) if id == "s1"));
        assert!(matches!(parse("claude", r#"{"type":"system","subtype":"init","session_id":"s2"}"#), AgentEvent::SessionId(id) if id == "s2"));
    }

    #[test]
    fn claude_result_is_done_without_repeating_its_text() {
        assert!(matches!(parse("claude", r#"{"type":"result","is_error":false,"result":"answer"}"#), AgentEvent::Done));
    }

    #[test]
    fn claude_result_with_error_reports_it() {
        assert!(matches!(parse("claude", r#"{"type":"result","is_error":true,"error":"boom"}"#), AgentEvent::Error(e) if e == "boom"));
    }

    #[test]
    fn claude_assistant_message_emits_its_text() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hola"}]}}"#;
        assert!(matches!(parse("claude", line), AgentEvent::Chunk(t) if t == "Hola"));
    }

    #[test]
    fn claude_streaming_delta_emits_its_text() {
        // El daemon leía deltas y el desktop no: al unificar, los dos.
        let line = r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"parcial"}}"#;
        assert!(matches!(parse("claude", line), AgentEvent::Chunk(t) if t == "parcial"));
    }

    #[test]
    fn claude_assistant_message_is_skipped_after_deltas() {
        // Con deltas ya emitidos, el mensaje final repetiría el mismo texto.
        let mut parser = AgentParser::new("claude");
        assert!(matches!(parser.parse_line(r#"{"type":"content_block_delta","delta":{"text":"Ho"}}"#), AgentEvent::Chunk(_)));
        assert!(matches!(parser.parse_line(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hola"}]}}"#), AgentEvent::Ignore));
    }

    #[test]
    fn claude_tool_use_is_reported_with_its_target() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"src/a.rs"}}]}}"#;
        assert!(matches!(parse("claude", line), AgentEvent::ToolUse(t) if t == "Read: src/a.rs"));
    }

    #[test]
    fn claude_ignores_unparseable_lines() {
        assert!(matches!(parse("claude", "not json"), AgentEvent::Ignore));
    }

    // ── OpenCode ──────────────────────────────────────────────────────────────

    #[test]
    fn opencode_text_event_emits_chunk() {
        let line = r#"{"type":"text","sessionID":"ses_abc","part":{"type":"text","text":"Hello"}}"#;
        assert!(matches!(parse("opencode", line), AgentEvent::Chunk(t) if t == "Hello"));
    }

    #[test]
    fn opencode_step_finish_stop_emits_session_id() {
        let line = r#"{"type":"step_finish","sessionID":"ses_abc","part":{"reason":"stop","type":"step-finish"}}"#;
        assert!(matches!(parse("opencode", line), AgentEvent::SessionId(id) if id == "ses_abc"));
    }

    #[test]
    fn opencode_step_finish_without_stop_is_ignored() {
        let line = r#"{"type":"step_finish","sessionID":"ses_abc","part":{"reason":"tool","type":"step-finish"}}"#;
        assert!(matches!(parse("opencode", line), AgentEvent::Ignore));
    }

    #[test]
    fn opencode_tool_event_reports_its_target() {
        let line = r#"{"type":"tool_use","part":{"type":"tool","tool":"grep","state":{"input":{"pattern":"foo"}}}}"#;
        assert!(matches!(parse("opencode", line), AgentEvent::ToolUse(t) if t == "grep: foo"));
    }

    // ── Codex ─────────────────────────────────────────────────────────────────

    #[test]
    fn codex_thread_started_emits_session_id() {
        assert!(matches!(parse("codex", r#"{"type":"thread.started","thread_id":"019fc"}"#), AgentEvent::SessionId(id) if id == "019fc"));
    }

    #[test]
    fn codex_session_meta_also_emits_session_id() {
        // La forma que leía el daemon; el desktop solo leía thread.started.
        let line = r#"{"type":"session_meta","payload":{"id":"sess-42"}}"#;
        assert!(matches!(parse("codex", line), AgentEvent::SessionId(id) if id == "sess-42"));
    }

    #[test]
    fn codex_agent_message_emits_chunk() {
        let line = r#"{"type":"item.completed","item":{"type":"agent_message","text":"Hi"}}"#;
        assert!(matches!(parse("codex", line), AgentEvent::Chunk(t) if t == "Hi"));
    }

    #[test]
    fn codex_turn_completed_is_done() {
        assert!(matches!(parse("codex", r#"{"type":"turn.completed","usage":{}}"#), AgentEvent::Done));
    }

    #[test]
    fn codex_item_error_is_ignored_because_it_is_a_hook_warning() {
        let line = r#"{"type":"item.completed","item":{"type":"error","message":"hook failed"}}"#;
        assert!(matches!(parse("codex", line), AgentEvent::Ignore));
    }

    // ── Ejecutables desconocidos ──────────────────────────────────────────────

    #[test]
    fn a_transient_failure_is_worth_retrying() {
        assert!(is_retryable("rate limit exceeded"));
        assert!(is_retryable("Error 529 overloaded"));
        assert!(is_retryable("socket hang up"));
        assert!(is_retryable("agent exited with an error"));
    }

    #[test]
    fn every_agent_on_the_list_can_actually_be_launched() {
        // La lista y el `match` de `invocation` no pueden separarse: ofrecer un
        // agente que luego no se sabe lanzar es peor que no ofrecerlo.
        for agent in AGENTS {
            let built = invocation(agent.id, "prompt", "/tmp", None, false);
            assert!(built.is_ok(), "{} no se sabe lanzar", agent.id);
            assert_eq!(built.unwrap().program, agent.id);
        }
        assert!(invocation("gemini", "prompt", "/tmp", None, false).is_err());
    }

    #[test]
    fn the_label_falls_back_to_the_id_and_the_list_knows_its_own() {
        assert_eq!(label("claude"), "Claude");
        assert_eq!(label("opencode"), "OpenCode");
        assert_eq!(label("gemini"), "gemini");
        assert!(is_known("codex"));
        assert!(!is_known("gemini"));
        assert_eq!(ids(), vec!["claude", "codex", "opencode"]);
    }

    #[test]
    fn cycling_goes_round_the_list_and_comes_back() {
        assert_eq!(next_id("claude"), "codex");
        assert_eq!(next_id("codex"), "opencode");
        assert_eq!(next_id("opencode"), "claude");
        // Algo que no está en la lista empieza por el principio.
        assert_eq!(next_id("gemini"), "codex");
    }

    #[test]
    fn a_timeout_is_not() {
        // Un timeout significa que el trabajo no cabía en la ventana:
        // repetirlo quema otra igual.
        assert!(!is_retryable("agent timeout"));
        assert!(!is_retryable("request timed out"));
    }

    #[test]
    fn an_unknown_failure_is_not_retried_either() {
        assert!(!is_retryable("invalid api key"));
        assert!(!is_retryable(""));
    }

    #[test]
    fn a_custom_agent_treats_every_non_empty_line_as_text() {
        assert!(matches!(parse("mi-cli", "salida suelta"), AgentEvent::Chunk(t) if t == "salida suelta"));
        assert!(matches!(parse("mi-cli", ""), AgentEvent::Ignore));
    }
}
