//! El dispatch de subcomandos: qué hace `bento <algo>`. Cada rama traduce
//! argumentos a una petición al daemon; el transporte está en `main`.

use serde_json::{json, Value};

use crate::{attach, current_dir_string, flag, print_help, print_text, request, request_data, stream_review, tui};
use crate::service::{daemon_install, daemon_start, daemon_uninstall};

mod docker;

pub(crate) async fn run(args: &[String]) -> std::io::Result<()> {
    match args.first().map(String::as_str) {
        None => tui::run().await,
        Some("daemon") => match args.get(1).map(String::as_str) {
            Some("status")    => request(json!({ "id": "1", "cmd": "daemon.status" })).await,
            Some("start")     => daemon_start().await,
            Some("install")   => daemon_install(),
            Some("uninstall") => daemon_uninstall(),
            _ => { print_help(); Ok(()) }
        },
        Some("agent") => match args.get(1).map(String::as_str) {
            Some("run") => {
                let rest = &args[2..];
                let cmd = build_agent_open_cmd(rest);
                let pty_id = request_data(cmd).await?;
                let id = pty_id.get("pty_id").and_then(Value::as_str).unwrap_or("?");
                println!("agent started: {id}");
                if flag(rest, "--attach").is_some() || rest.contains(&"--attach".to_string()) {
                    attach::attach(id).await?;
                }
                Ok(())
            }
            Some("list") => request(json!({ "id": "1", "cmd": "terminals.list" })).await,
            Some("attach") => match args.get(2) {
                Some(id) => attach::attach(id).await,
                None => { eprintln!("usage: bento agent attach <id>"); Ok(()) }
            },
            _ => { print_help(); Ok(()) }
        },
        Some("tasks") => match args.get(1).map(String::as_str) {
            // `bento tasks --cwd X` es listar con opciones, no un subcomando.
            None | Some("list") | Some("--cwd") => {
                let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                let data = request_data(json!({ "id": "1", "cmd": "tasks.list", "cwd": cwd })).await?;
                print_tasks(&data);
                Ok(())
            }
            Some("new") => match args.get(2) {
                Some(name) => {
                    let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                    let base = flag(args, "--base").unwrap_or_else(|| "main".to_string());
                    request(json!({ "id": "1", "cmd": "tasks.create", "cwd": cwd, "base": base, "data": name })).await
                }
                None => { eprintln!("usage: bento tasks new <nombre> [--base <rama>]"); Ok(()) }
            },
            Some("rm") => match args.get(2) {
                Some(path) => {
                    let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                    let force = args.iter().any(|a| a == "--force");
                    request(json!({ "id": "1", "cmd": "tasks.remove", "cwd": cwd, "path": path, "force": force })).await
                }
                None => { eprintln!("usage: bento tasks rm <ruta> [--force]"); Ok(()) }
            },
            Some("commit") => match args.get(2) {
                Some(message) => {
                    let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                    let amend = args.iter().any(|a| a == "--amend");
                    request(json!({ "id": "1", "cmd": "tasks.commit", "cwd": cwd, "data": message, "force": amend })).await
                }
                None => { eprintln!("usage: bento tasks commit <mensaje> [--amend]"); Ok(()) }
            },
            Some("sync") => {
                let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                let data = request_data(json!({ "id": "1", "cmd": "tasks.sync", "cwd": cwd })).await?;
                print_text(data.as_str().unwrap_or_default());
                Ok(())
            }
            Some("rebase") => match args.get(2).map(String::as_str) {
                Some("status") => {
                    let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                    let data = request_data(json!({ "id": "1", "cmd": "tasks.rebase_status", "cwd": cwd })).await?;
                    print_rebase_status(&data);
                    Ok(())
                }
                Some("continue") => {
                    let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                    let data = request_data(json!({ "id": "1", "cmd": "tasks.rebase_continue", "cwd": cwd })).await?;
                    print_text(data.as_str().unwrap_or_default());
                    Ok(())
                }
                Some("abort") => {
                    let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                    request(json!({ "id": "1", "cmd": "tasks.rebase_abort", "cwd": cwd })).await
                }
                Some(base) => {
                    let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                    request(json!({ "id": "1", "cmd": "tasks.rebase", "cwd": cwd, "base": base })).await
                }
                None => { eprintln!("usage: bento tasks rebase <rama base>|status|continue|abort"); Ok(()) }
            },
            Some("backups") => {
                let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                let data = request_data(json!({ "id": "1", "cmd": "tasks.backups", "cwd": cwd })).await?;
                print_backups(&data);
                Ok(())
            }
            Some("restore") => {
                let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                let mut body = json!({ "id": "1", "cmd": "tasks.restore", "cwd": cwd });
                if let Some(reference) = args.get(2).filter(|a| !a.starts_with("--")) {
                    body["data"] = json!(reference);
                }
                request(body).await
            }
            Some("push") => {
                let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                let force = args.iter().any(|a| a == "--force");
                let data = request_data(json!({ "id": "1", "cmd": "tasks.push", "cwd": cwd, "force": force })).await?;
                print_text(data.as_str().unwrap_or_default());
                Ok(())
            }
            _ => { print_help(); Ok(()) }
        },

        Some("docker") => docker::run(args).await,

        Some("terminals") => request(json!({ "id": "1", "cmd": "terminals.list" })).await,
        Some("review") => match args.get(1).map(String::as_str) {
            Some("branches") => {
                let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                request(json!({ "id": "1", "cmd": "review.branches", "cwd": cwd })).await
            }
            Some("prs") => {
                let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                request(json!({ "id": "1", "cmd": "review.prs", "cwd": cwd })).await
            }
            Some("files") => {
                let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                let base = flag(args, "--base").unwrap_or_else(|| "main".to_string());
                request(json!({ "id": "1", "cmd": "review.files", "cwd": cwd, "base": base })).await
            }
            Some("file") => match args.get(2) {
                Some(path) => {
                    let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                    let base = flag(args, "--base").unwrap_or_else(|| "main".to_string());
                    let data = request_data(json!({ "id": "1", "cmd": "review.file", "cwd": cwd, "base": base, "path": path })).await?;
                    print_text(data.as_str().unwrap_or_default());
                    Ok(())
                }
                None => { eprintln!("usage: bento review file <path> [--cwd <dir>] [--base <ref>]"); Ok(()) }
            },
            Some("ask") => match args.get(2) {
                Some(question) => {
                    let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                    let base = flag(args, "--base").unwrap_or_else(|| "main".to_string());
                    let agent = flag(args, "--agent").unwrap_or_else(|| "claude".to_string());
                    stream_review(json!({
                        "id": "1", "cmd": "review.ask", "cwd": cwd, "base": base, "agent": agent, "question": question,
                    })).await
                }
                None => { eprintln!("usage: bento review ask <question> [--cwd <dir>] [--base <ref>] [--agent claude|codex|opencode]"); Ok(()) }
            },
            Some("run") => {
                let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                let base = flag(args, "--base").unwrap_or_else(|| "main".to_string());
                let mut body = json!({
                    "id": "1", "cmd": "review.run", "cwd": cwd, "base": base,
                    "context": flag(args, "--context").unwrap_or_default(),
                    "agents": flag(args, "--agents").unwrap_or_default(),
                });
                if let Some(branch) = flag(args, "--branch") {
                    body["branch"] = json!(branch);
                }
                stream_review(body).await
            }
            Some("pr") => match args.get(2).map(String::as_str) {
                Some("diff") => match args.get(3).and_then(|s| s.parse::<u64>().ok()) {
                    Some(pr) => {
                        let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                        let data = request_data(json!({ "id": "1", "cmd": "review.pr_diff", "cwd": cwd, "pr": pr })).await?;
                        print_text(data.as_str().unwrap_or_default());
                        Ok(())
                    }
                    None => { eprintln!("usage: bento review pr diff <number>"); Ok(()) }
                },
                Some("comments") => match args.get(3).and_then(|s| s.parse::<u64>().ok()) {
                    Some(pr) => {
                        let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                        request(json!({ "id": "1", "cmd": "review.pr_comments", "cwd": cwd, "pr": pr })).await
                    }
                    None => { eprintln!("usage: bento review pr comments <number>"); Ok(()) }
                },
                Some("comment") => match (args.get(3).and_then(|s| s.parse::<u64>().ok()), args.get(4)) {
                    (Some(pr), Some(text)) => {
                        let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                        request(json!({ "id": "1", "cmd": "review.pr_comment_add", "cwd": cwd, "pr": pr, "data": text })).await
                    }
                    _ => { eprintln!("usage: bento review pr comment <number> <text>"); Ok(()) }
                },
                Some("comment-update") => match (
                    args.get(3).and_then(|s| s.parse::<u64>().ok()),
                    args.get(4).and_then(|s| s.parse::<u64>().ok()),
                    args.get(5),
                ) {
                    (Some(id), Some(pr), Some(text)) => {
                        let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                        request(json!({ "id": "1", "cmd": "review.pr_comment_update", "cwd": cwd, "pr": pr, "comment_id": id, "data": text })).await
                    }
                    _ => { eprintln!("usage: bento review pr comment-update <comment_id> <pr_number> <text>"); Ok(()) }
                },
                Some("comment-delete") => match (
                    args.get(3).and_then(|s| s.parse::<u64>().ok()),
                    args.get(4).and_then(|s| s.parse::<u64>().ok()),
                ) {
                    (Some(id), Some(pr)) => {
                        let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                        request(json!({ "id": "1", "cmd": "review.pr_comment_delete", "cwd": cwd, "pr": pr, "comment_id": id })).await
                    }
                    _ => { eprintln!("usage: bento review pr comment-delete <comment_id> <pr_number>"); Ok(()) }
                },
                Some("submit") => match (args.get(3).and_then(|s| s.parse::<u64>().ok()), args.get(4)) {
                    (Some(pr), Some(event)) => {
                        let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                        let mut body = json!({ "id": "1", "cmd": "review.pr_submit", "cwd": cwd, "pr": pr, "event": event });
                        if let Some(text) = args.get(5) {
                            body["data"] = json!(text);
                        }
                        request(body).await
                    }
                    _ => { eprintln!("usage: bento review pr submit <number> <approve|request-changes|comment> [text]"); Ok(()) }
                },
                _ => { print_help(); Ok(()) }
            },
            _ => { print_help(); Ok(()) }
        },
        Some("open") => {
            let mut body = json!({ "id": "1", "cmd": "terminal.open" });
            if let Some(cwd) = flag(args, "--cwd") {
                body["cwd"] = json!(cwd);
            }
            request(body).await
        }
        Some("attach") => match args.get(1) {
            Some(id) => attach::attach(id).await,
            None => {
                eprintln!("usage: bento attach <pty_id>");
                Ok(())
            }
        },
        _ => {
            print_help();
            Ok(())
        }
    }
}

/// Build a `terminal.open` IPC command for a given agent and flags.
/// - `claude --message <msg>` → `["claude", "-p", "<msg>"]`
/// - `codex  --message <msg>` → `["codex", "-a", "full-auto", "-q", "<msg>"]`
/// - other   --message <msg>` → `["<agent>", "<msg>"]`
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

// ── IPC helpers ───────────────────────────────────────────────────────────────



/// Un contenedor por línea, con el proyecto de compose al que pertenece.
/// Parados y corriendo juntos: saber qué se ha caído es la mitad de la razón
/// para mirar esto desde fuera.
/// Una tarea por línea: rama, qué lleva sin commitear y cómo va respecto a su
/// upstream. Lo que quieres ver de un vistazo antes de entrar en ninguna.
fn print_tasks(data: &Value) {
    let tasks = data.as_array().map(Vec::as_slice).unwrap_or_default();
    if tasks.is_empty() {
        println!("(sin tareas)");
        return;
    }
    for task in tasks {
        let branch = task.get("branch").and_then(Value::as_str).unwrap_or("(sin rama)");
        let path = task.get("path").and_then(Value::as_str).unwrap_or("");
        let status = task.get("status");
        let count = |key: &str| status.and_then(|s| s.get(key)).and_then(Value::as_u64).unwrap_or(0);
        let pending = match count("total") {
            0 => "limpio".to_string(),
            _ => format!("{}±  {}?", count("staged") + count("unstaged"), count("untracked")),
        };
        let upstream = task.get("upstream");
        let state = upstream.and_then(|u| u.get("state")).and_then(Value::as_str).unwrap_or("");
        let ahead = upstream.and_then(|u| u.get("ahead")).and_then(Value::as_u64).unwrap_or(0);
        let behind = upstream.and_then(|u| u.get("behind")).and_then(Value::as_u64).unwrap_or(0);
        let sync = match state {
            "synced" => "al día".to_string(),
            "unpublished" => "sin publicar".to_string(),
            _ => format!("{state} ↑{ahead} ↓{behind}"),
        };
        println!("{branch:<34} {pending:<14} {sync:<20} {path}");
    }
}



/// Dónde se ha quedado un rebase: el commit, cuántos van y qué está en
/// conflicto. Es lo primero que quieres saber cuando git para.
fn print_rebase_status(data: &Value) {
    if data.get("active").and_then(Value::as_bool) != Some(true) {
        println!("(sin rebase en curso)");
        return;
    }
    let field = |key: &str| data.get(key).and_then(Value::as_str).unwrap_or("");
    let num = |key: &str| data.get(key).and_then(Value::as_u64);
    match (num("current"), num("total")) {
        (Some(current), Some(total)) => println!("rebase {current}/{total} sobre {}", field("branch")),
        _ => println!("rebase en curso sobre {}", field("branch")),
    }
    println!("parado en {} {}", field("short"), field("subject"));
    let conflicts = data.get("conflicts").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    if conflicts.is_empty() {
        println!("sin conflictos — `bento tasks rebase continue` para seguir");
        return;
    }
    println!("en conflicto:");
    for file in conflicts {
        println!("  {}", file.as_str().unwrap_or(""));
    }
}

/// Los respaldos automáticos de la rama, del más reciente al más viejo.
fn print_backups(data: &Value) {
    let entries = data.as_array().map(Vec::as_slice).unwrap_or_default();
    if entries.is_empty() {
        println!("(sin respaldos)");
        return;
    }
    for entry in entries {
        let field = |key: &str| entry.get(key).and_then(Value::as_str).unwrap_or("");
        println!("{:<10} {:<52} {}", field("short"), field("subject"), field("reference"));
    }
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
