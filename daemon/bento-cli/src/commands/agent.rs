//! `bento agent`: lanzar un agente en su PTY, listar los que hay abiertos,
//! engancharse a uno, y ver o retomar las sesiones que dejó en disco.

use serde_json::{json, Value};

use crate::{attach, current_dir_string, flag, print_help, request, request_data};

pub(crate) async fn run(args: &[String]) -> std::io::Result<()> {
    match args.get(1).map(String::as_str) {
        Some("run") => {
            let rest = &args[2..];
            let pty_id = request_data(build_agent_open_cmd(rest)).await?;
            let id = pty_id.get("pty_id").and_then(Value::as_str).unwrap_or("?");
            println!("agent started: {id}");
            if rest.contains(&"--attach".to_string()) {
                attach::attach(id).await?;
            }
            Ok(())
        }
        Some("list") => request(json!({ "id": "1", "cmd": "terminals.list" })).await,
        Some("attach") => match args.get(2) {
            Some(id) => attach::attach(id).await,
            None => { eprintln!("usage: bento agent attach <id>"); Ok(()) }
        },
        // Las sesiones se leen del disco (cada agente las deja en su sitio),
        // así que esto no pasa por el daemon; retomar una sí, que abre un PTY.
        Some("sessions") => {
            let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
            print_sessions(&bento_sessions::list(&cwd));
            Ok(())
        }
        Some("resume") => match (args.get(2), args.get(3)) {
            (Some(agent), Some(session)) => resume_session(args, agent, session).await,
            _ => { eprintln!("usage: bento agent resume <claude|codex|opencode> <id> [--cwd <dir>] [--attach]"); Ok(()) }
        },
        _ => { print_help(); Ok(()) }
    }
}

/// Retoma una sesión de agente en su propio PTY. El comando lo arma
/// `bento_sessions`, que sabe cómo lo llama cada agente (y de paso quita el
/// lock que Codex se deja puesto).
async fn resume_session(args: &[String], agent: &str, session: &str) -> std::io::Result<()> {
    let command = match bento_sessions::resume_command(agent, session) {
        Ok(command) => command,
        Err(error) => { eprintln!("bento: {error}"); return Ok(()) }
    };
    let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
    let body = json!({ "id": "1", "cmd": "terminal.open", "command": command, "cwd": cwd });
    let opened = request_data(body).await?;
    let pty_id = opened.get("pty_id").and_then(Value::as_str).unwrap_or("?");
    println!("resumed {agent} session {session}: {pty_id}");
    if args.contains(&"--attach".to_string()) {
        attach::attach(pty_id).await?;
    }
    Ok(())
}

/// Una sesión por línea: qué agente, cuándo se tocó por última vez y su id, que
/// es lo que hay que copiar para `bento agent resume`.
fn print_sessions(sessions: &[bento_sessions::Session]) {
    if sessions.is_empty() {
        println!("(sin sesiones que retomar)");
        return;
    }
    for session in sessions {
        println!("{:<10} {:<20} {}", session.agent, ago(session.updated_at), session.id);
    }
}

/// Cuánto hace, en corto. Sin fecha exacta: para elegir sesión basta con saber
/// si fue hace un rato o la semana pasada.
fn ago(updated_at: u64) -> String {
    if updated_at == 0 {
        return "?".into();
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0);
    let minutes = now.saturating_sub(updated_at) / 60_000;
    match minutes {
        0 => "ahora mismo".into(),
        1..=59 => format!("hace {minutes} min"),
        60..=1439 => format!("hace {} h", minutes / 60),
        _ => format!("hace {} d", minutes / 1440),
    }
}

/// El `terminal.open` que abre un agente, según sus flags:
///
/// - `claude --message <msg>` → `["claude", "-p", "<msg>"]`
/// - `codex  --message <msg>` → `["codex", "-a", "full-auto", "-q", "<msg>"]`
/// - cualquier otro `--message <msg>` → `["<agente>", "<msg>"]`
fn build_agent_open_cmd(args: &[String]) -> Value {
    let agent = args.first().map(String::as_str).unwrap_or("claude");
    let cwd = flag(args, "--cwd");
    let message = flag(args, "--message");

    let command: Vec<String> = match (agent, message.as_deref()) {
        ("claude", Some(msg)) => vec!["claude".into(), "-p".into(), msg.into()],
        ("codex",  Some(msg)) => vec!["codex".into(), "-a".into(), "full-auto".into(), "-q".into(), msg.into()],
        (name,     Some(msg)) => vec![name.into(), msg.into()],
        (name,     None)      => vec![name.into()],
    };

    let mut body = json!({ "id": "1", "cmd": "terminal.open", "command": command });
    if let Some(c) = cwd {
        body["cwd"] = json!(c);
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_run_claude_interactive() {
        let args = ["claude".to_string(), "--cwd".to_string(), "/home/x".to_string()];
        let cmd = build_agent_open_cmd(&args);
        assert_eq!(cmd["cmd"].as_str(), Some("terminal.open"));
        assert_eq!(cmd["command"], json!(["claude"]));
        assert_eq!(cmd["cwd"].as_str(), Some("/home/x"));
    }

    #[test]
    fn agent_run_claude_with_message_uses_print_flag() {
        let args = [
            "claude".to_string(), "--cwd".to_string(), "/proj".to_string(),
            "--message".to_string(), "fix the bug".to_string(),
        ];
        let cmd = build_agent_open_cmd(&args);
        assert_eq!(cmd["command"], json!(["claude", "-p", "fix the bug"]));
        assert_eq!(cmd["cwd"].as_str(), Some("/proj"));
    }

    #[test]
    fn agent_run_codex_with_message_uses_full_auto() {
        let args = [
            "codex".to_string(),
            "--message".to_string(), "add tests".to_string(),
        ];
        let cmd = build_agent_open_cmd(&args);
        assert_eq!(cmd["command"], json!(["codex", "-a", "full-auto", "-q", "add tests"]));
        assert!(cmd["cwd"].is_null());
    }

    #[test]
    fn agent_run_unknown_agent_passes_message_as_arg() {
        let args = [
            "opencode".to_string(),
            "--message".to_string(), "hello".to_string(),
        ];
        let cmd = build_agent_open_cmd(&args);
        assert_eq!(cmd["command"], json!(["opencode", "hello"]));
    }

    #[test]
    fn agent_run_no_cwd_omits_field() {
        let args = ["claude".to_string()];
        let cmd = build_agent_open_cmd(&args);
        assert!(cmd["cwd"].is_null());
    }
}
