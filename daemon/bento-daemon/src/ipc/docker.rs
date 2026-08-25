//! La mitad `docker.*` del dispatch IPC: contenedores, aislamiento de compose y
//! devcontainers. Listar y leer logs va también por HTTP (móvil); arrancar,
//! parar y preparar entornos, solo por este socket, que es local —
//! ver docs/remote-exposure.md.

use serde_json::{json, Value};

use super::{fail, ok, Request};

/// Atiende un comando `docker.*`. `cmd` ya se sabe que empieza por `docker.`;
/// lo desconocido responde como cualquier otro comando desconocido.
pub(crate) fn dispatch(cmd: &str, req: &Request, send: &impl Fn(String)) {
    match cmd {
        "docker.list" => send(ok(&req.id, json!(bento_docker::list()))),

        "docker.logs" => match &req.data {
            Some(id) => match bento_docker::logs(id, req.rows.unwrap_or(200) as u32) {
                Ok(logs) => send(ok(&req.id, json!(logs))),
                Err(e) => send(fail(&req.id, e)),
            },
            None => send(fail(&req.id, "data (container) required".into())),
        },

        "docker.start" | "docker.stop" | "docker.restart" => match &req.data {
            Some(id) => {
                let action = cmd.trim_start_matches("docker.");
                match bento_docker::action(action, id) {
                    Ok(()) => send(ok(&req.id, Value::Null)),
                    Err(e) => send(fail(&req.id, e)),
                }
            }
            None => send(fail(&req.id, "data (container) required".into())),
        },

        // Aislar el compose de un worktree para que su stack conviva con el del
        // repo principal. `cwd` es el worktree.
        "docker.isolate" => match &req.cwd {
            Some(worktree) => match bento_docker::isolate::isolate(worktree) {
                Ok(result) => send(ok(&req.id, json!(result))),
                Err(e) => send(fail(&req.id, e)),
            },
            None => send(fail(&req.id, "cwd (worktree) required".into())),
        },

        "docker.devcontainers" => match &req.cwd {
            Some(worktree) => send(ok(
                &req.id,
                json!(bento_docker::devcontainer::find_devcontainer_dirs(worktree)),
            )),
            None => send(fail(&req.id, "cwd (worktree) required".into())),
        },

        // `path` es el `.devcontainer` elegido; sin él solo vale si hay uno.
        "docker.devcontainer_isolate" => match &req.cwd {
            Some(worktree) => {
                let project_key = req.data.clone().unwrap_or_default();
                if !bento_docker::compose_yaml::valid_project_key(&project_key) {
                    return send(fail(&req.id, "invalid project key".into()));
                }
                match bento_docker::devcontainer::isolate::isolate_devcontainer(
                    worktree,
                    req.recipes_dir.as_deref(),
                    &project_key,
                    req.path.clone(),
                    req.force.unwrap_or(false),
                ) {
                    Ok(result) => send(ok(&req.id, json!(result))),
                    Err(e) => send(fail(&req.id, e)),
                }
            }
            None => send(fail(&req.id, "cwd (worktree) required".into())),
        },

        "docker.devcontainer_urls" => match &req.cwd {
            Some(worktree) => {
                match bento_docker::devcontainer::isolate::devcontainer_urls(
                    worktree,
                    req.path.clone(),
                ) {
                    Ok(urls) => send(ok(&req.id, json!(urls))),
                    Err(e) => send(fail(&req.id, e)),
                }
            }
            None => send(fail(&req.id, "cwd (worktree) required".into())),
        },

        "docker.recipe_status" => match &req.cwd {
            Some(worktree) => {
                match bento_docker::devcontainer::isolate::devcontainer_recipe_status(
                    worktree,
                    req.path.clone(),
                ) {
                    Ok(status) => send(ok(&req.id, json!(status))),
                    Err(e) => send(fail(&req.id, e)),
                }
            }
            None => send(fail(&req.id, "cwd (worktree) required".into())),
        },

        "docker.recipe_preview" => match &req.cwd {
            Some(worktree) => {
                let project_key = req.data.clone().unwrap_or_default();
                if !std::path::Path::new(worktree).is_dir() {
                    return send(fail(&req.id, "invalid worktree".into()));
                }
                if !bento_docker::compose_yaml::valid_project_key(&project_key) {
                    return send(fail(&req.id, "invalid project key".into()));
                }
                send(ok(
                    &req.id,
                    json!(bento_docker::devcontainer::recipe::recipe_preview(
                        req.recipes_dir.as_deref(),
                        &project_key,
                        worktree,
                    )),
                ))
            }
            None => send(fail(&req.id, "cwd (worktree) required".into())),
        },

        other => send(fail(&req.id, format!("unknown command: {other}"))),
    }
}
