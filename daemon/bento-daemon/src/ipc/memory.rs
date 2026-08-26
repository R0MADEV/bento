//! La mitad `memory.*` del dispatch IPC: las memorias del proyecto que el
//! panel de escritorio guarda en su SQLite. Van solo por este socket, que es
//! local: por HTTP no se exponen — ver docs/remote-exposure.md.

use serde_json::json;

use super::{fail, ok, Request};

/// Atiende un comando `memory.*`. `cmd` ya se sabe que empieza por `memory.`;
/// lo desconocido responde como cualquier otro comando desconocido.
pub(crate) fn dispatch(cmd: &str, req: &Request, send: &impl Fn(String)) {
    let data_dir = match bento_memory::data_dir() {
        Ok(directory) => directory,
        Err(error) => return send(fail(&req.id, error)),
    };
    match cmd {
        "memory.list" => match &req.cwd {
            Some(cwd) => match bento_memory::memory_list(&data_dir, cwd.clone()) {
                Ok(entries) => send(ok(&req.id, json!(entries))),
                Err(e) => send(fail(&req.id, e)),
            },
            None => send(fail(&req.id, "cwd (project path) required".into())),
        },

        "memory.list_all" => match bento_memory::memory_list_all(&data_dir) {
            Ok(entries) => send(ok(&req.id, json!(entries))),
            Err(e) => send(fail(&req.id, e)),
        },

        // `data` es el título, `content` el resumen y `context` el detalle.
        "memory.create" => match (&req.cwd, &req.data) {
            (Some(cwd), Some(title)) => {
                let kind = req.agent.clone().unwrap_or_else(|| "note".into());
                let entry = bento_memory::new_entry(
                    cwd,
                    &kind,
                    title,
                    req.content.as_deref().unwrap_or_default(),
                    req.context.as_deref().unwrap_or_default(),
                    "cli",
                );
                match entry.and_then(|entry| bento_memory::memory_create(&data_dir, entry)) {
                    Ok(entry) => send(ok(&req.id, json!(entry))),
                    Err(e) => send(fail(&req.id, e)),
                }
            }
            _ => send(fail(&req.id, "cwd (project path) and data (title) required".into())),
        },

        "memory.remove" => match (&req.cwd, &req.path) {
            (Some(cwd), Some(id)) => {
                match bento_memory::memory_remove(&data_dir, cwd.clone(), id.clone()) {
                    Ok(removed) => send(ok(&req.id, json!({ "removed": removed }))),
                    Err(e) => send(fail(&req.id, e)),
                }
            }
            _ => send(fail(&req.id, "cwd (project path) and path (id) required".into())),
        },

        other => send(fail(&req.id, format!("unknown command: {other}"))),
    }
}
