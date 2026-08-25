//! La mitad `tasks.*` del dispatch IPC: los worktrees, sus commits, el rebase
//! interactivo y los backups. Leer va también por HTTP (móvil); escribir, solo
//! por este socket, que es local — ver docs/remote-exposure.md.

use serde_json::{json, Value};

use super::{fail, ok, Request};

/// Atiende un comando `tasks.*`. `cmd` ya se sabe que empieza por `tasks.`;
/// lo desconocido responde como cualquier otro comando desconocido.
pub(crate) fn dispatch(cmd: &str, req: &Request, send: &impl Fn(String)) {
    match cmd {
        "tasks.list" => match &req.cwd {
            Some(cwd) => send(ok(&req.id, json!(bento_review::tasks::list(cwd)))),
            None => send(fail(&req.id, "cwd required".into())),
        },

        "tasks.create" => match (&req.cwd, &req.base, &req.data) {
            (Some(cwd), Some(base), Some(name)) => match bento_review::tasks::create(cwd, name, base) {
                Ok(path) => send(ok(&req.id, json!({ "path": path }))),
                Err(e) => send(fail(&req.id, e)),
            },
            _ => send(fail(&req.id, "cwd, base and data (name) required".into())),
        },

        "tasks.remove" => match (&req.cwd, &req.path) {
            (Some(cwd), Some(path)) => match bento_review::tasks::remove(cwd, path, req.force.unwrap_or(false)) {
                Ok(()) => send(ok(&req.id, Value::Null)),
                Err(e) => send(fail(&req.id, e)),
            },
            _ => send(fail(&req.id, "cwd and path required".into())),
        },

        "tasks.commit" => match (&req.cwd, &req.data) {
            (Some(cwd), Some(message)) => match bento_review::tasks::commit(cwd, message, req.force.unwrap_or(false)) {
                Ok(()) => send(ok(&req.id, Value::Null)),
                Err(e) => send(fail(&req.id, e)),
            },
            _ => send(fail(&req.id, "cwd and data (message) required".into())),
        },

        "tasks.sync" => match &req.cwd {
            Some(cwd) => match bento_review::tasks::sync(cwd) {
                Ok(out) => send(ok(&req.id, json!(out))),
                Err(e) => send(fail(&req.id, e)),
            },
            None => send(fail(&req.id, "cwd required".into())),
        },

        "tasks.push" => match &req.cwd {
            Some(cwd) => match bento_review::tasks::push(cwd, req.force.unwrap_or(false)) {
                Ok(out) => send(ok(&req.id, json!(out))),
                Err(e) => send(fail(&req.id, e)),
            },
            None => send(fail(&req.id, "cwd required".into())),
        },

        "tasks.rebase" => match (&req.cwd, &req.base) {
            (Some(cwd), Some(base)) => {
                // Sin plan explícito, todo `pick`: rebasar sin reordenar.
                let todo = match &req.paths {
                    Some(lines) if !lines.is_empty() => Ok(lines.clone()),
                    _ => bento_review::rebase::plain_todo(cwd, base),
                };
                match todo.and_then(|todo| bento_review::rebase::start(cwd, base, &todo)) {
                    Ok(()) => send(ok(&req.id, Value::Null)),
                    Err(e) => send(fail(&req.id, e)),
                }
            }
            _ => send(fail(&req.id, "cwd and base required".into())),
        },

        "tasks.rebase_status" => match &req.cwd {
            Some(cwd) => match bento_review::rebase::status(cwd) {
                Ok(status) => send(ok(&req.id, json!(status))),
                Err(e) => send(fail(&req.id, e)),
            },
            None => send(fail(&req.id, "cwd required".into())),
        },

        "tasks.rebase_continue" => match &req.cwd {
            Some(cwd) => match bento_review::rebase::continue_rebase(cwd) {
                Ok(out) => send(ok(&req.id, json!(out))),
                Err(e) => send(fail(&req.id, e)),
            },
            None => send(fail(&req.id, "cwd required".into())),
        },

        "tasks.rebase_abort" => match &req.cwd {
            Some(cwd) => match bento_review::rebase::abort(cwd) {
                Ok(()) => send(ok(&req.id, Value::Null)),
                Err(e) => send(fail(&req.id, e)),
            },
            None => send(fail(&req.id, "cwd required".into())),
        },

        // Leer el estado y el historial: sirve igual desde el móvil que desde
        // el CLI, y no escribe nada.
        "tasks.status" => match &req.cwd {
            Some(cwd) => match bento_review::status::status(cwd) {
                Ok(status) => send(ok(&req.id, json!(status))),
                Err(e) => send(fail(&req.id, e)),
            },
            None => send(fail(&req.id, "cwd required".into())),
        },

        "tasks.diff" => match &req.cwd {
            Some(cwd) => {
                let diff = match &req.base {
                    Some(base) => bento_review::status::review_worktree_diff(cwd, base),
                    None => bento_review::status::worktree_diff(cwd),
                };
                match diff {
                    Ok(out) => send(ok(&req.id, json!(out))),
                    Err(e) => send(fail(&req.id, e)),
                }
            }
            None => send(fail(&req.id, "cwd required".into())),
        },

        "tasks.log" => match &req.cwd {
            Some(cwd) => match bento_review::log::log(cwd, req.limit.unwrap_or(30), false) {
                Ok(entries) => send(ok(&req.id, json!(entries))),
                Err(e) => send(fail(&req.id, e)),
            },
            None => send(fail(&req.id, "cwd required".into())),
        },

        "tasks.upstream" => match &req.cwd {
            Some(cwd) => match bento_review::sync::upstream_status(cwd) {
                Ok(status) => send(ok(&req.id, json!(status))),
                Err(e) => send(fail(&req.id, e)),
            },
            None => send(fail(&req.id, "cwd required".into())),
        },

        "tasks.backups" => match &req.cwd {
            Some(cwd) => match bento_review::backup::list(cwd) {
                Ok(list) => send(ok(&req.id, json!(list))),
                Err(e) => send(fail(&req.id, e)),
            },
            None => send(fail(&req.id, "cwd required".into())),
        },

        "tasks.restore" => match &req.cwd {
            Some(cwd) => match bento_review::backup::restore(cwd, req.data.clone()) {
                Ok(()) => send(ok(&req.id, Value::Null)),
                Err(e) => send(fail(&req.id, e)),
            },
            None => send(fail(&req.id, "cwd required".into())),
        },
        other => send(fail(&req.id, format!("unknown command: {other}"))),
    }
}
