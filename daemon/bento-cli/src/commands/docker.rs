//! `bento docker …`: contenedores y entornos de desarrollo aislados.

use serde_json::{json, Value};

use crate::{current_dir_string, flag, print_help, print_text, request, request_data};

pub(crate) async fn run(args: &[String]) -> std::io::Result<()> {
    match args.get(1).map(String::as_str) {
        None | Some("ps") | Some("list") => {
            let data = request_data(json!({ "id": "1", "cmd": "docker.list" })).await?;
            print_containers(&data);
            Ok(())
        }
        Some("logs") => match args.get(2) {
            Some(container) => {
                let tail = flag(args, "--tail").and_then(|t| t.parse::<u64>().ok()).unwrap_or(200);
                let data = request_data(json!({ "id": "1", "cmd": "docker.logs", "data": container, "rows": tail })).await?;
                print_text(data.as_str().unwrap_or_default());
                Ok(())
            }
            None => { eprintln!("usage: bento docker logs <contenedor> [--tail <n>]"); Ok(()) }
        },
        Some(action @ ("start" | "stop" | "restart")) => match args.get(2) {
            Some(container) => request(json!({ "id": "1", "cmd": format!("docker.{action}"), "data": container })).await,
            None => { eprintln!("usage: bento docker {action} <contenedor>"); Ok(()) }
        },

        // Aísla el docker-compose.yml del worktree (subred, nombres y puertos
        // propios) para que su stack conviva con el del repo principal.
        Some("isolate") => {
            let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
            let data = request_data(json!({ "id": "1", "cmd": "docker.isolate", "cwd": cwd })).await?;
            print_isolate(&data);
            Ok(())
        }

        Some("devcontainers") => {
            let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
            let data = request_data(json!({ "id": "1", "cmd": "docker.devcontainers", "cwd": cwd })).await?;
            let dirs = data.as_array().map(Vec::as_slice).unwrap_or_default();
            if dirs.is_empty() {
                println!("(sin devcontainers)");
            }
            for dir in dirs {
                println!("{}", dir.as_str().unwrap_or_default());
            }
            Ok(())
        }

        Some("prepare") => {
            let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
            let body = json!({
                "id": "1",
                "cmd": "docker.devcontainer_isolate",
                "cwd": cwd,
                "data": flag(args, "--project").unwrap_or_default(),
                "recipes_dir": flag(args, "--recipes"),
                "path": flag(args, "--devcontainer"),
                "force": args.iter().any(|arg| arg == "--allow-tracked"),
            });
            let data = request_data(body).await?;
            print_isolate(&data);
            print_recipe(&data);
            Ok(())
        }

        Some("urls") => {
            let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
            let data = request_data(json!({
                "id": "1", "cmd": "docker.devcontainer_urls",
                "cwd": cwd, "path": flag(args, "--devcontainer"),
            })).await?;
            print_urls(&data);
            Ok(())
        }

        Some("recipe") => match args.get(2).map(String::as_str) {
            Some("status") => {
                let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                let data = request_data(json!({
                    "id": "1", "cmd": "docker.recipe_status",
                    "cwd": cwd, "path": flag(args, "--devcontainer"),
                })).await?;
                if data.is_null() {
                    println!("(sin receta aplicada)");
                    return Ok(());
                }
                print_recipe_result(&data);
                Ok(())
            }
            Some("preview") => {
                let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                let data = request_data(json!({
                    "id": "1", "cmd": "docker.recipe_preview", "cwd": cwd,
                    "data": flag(args, "--project").unwrap_or_default(),
                    "recipes_dir": flag(args, "--recipes"),
                })).await?;
                print_preview(&data);
                Ok(())
            }
            _ => { eprintln!("usage: bento docker recipe status|preview [--project <key>] [--recipes <dir>]"); Ok(()) }
        },

        _ => { print_help(); Ok(()) }
    }
}

fn print_containers(data: &Value) {
    let containers = data.as_array().map(Vec::as_slice).unwrap_or_default();
    if containers.is_empty() {
        println!("(sin contenedores)");
        return;
    }
    for container in containers {
        let field = |key: &str| container.get(key).and_then(Value::as_str).unwrap_or("");
        let mark = if field("state") == "running" { "●" } else { "○" };
        println!(
            "{mark} {:<26} {:<26} {:<22} {}",
            field("name"), field("image"), field("status"), field("project"),
        );
    }
}

fn print_isolate(data: &Value) {
    match data.get("subnet").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(subnet) => println!("subred: {subnet}"),
        None => println!("subred: (la asigna Docker)"),
    }
    print_urls(data.get("urls").unwrap_or(&Value::Null));
}

fn print_urls(data: &Value) {
    let urls = data.as_array().map(Vec::as_slice).unwrap_or_default();
    if urls.is_empty() {
        println!("(sin puertos publicados)");
        return;
    }
    for entry in urls {
        let field = |key: &str| entry.get(key).and_then(Value::as_str).unwrap_or("");
        println!("{:<20} {}", field("service"), field("url"));
    }
}

fn print_recipe(data: &Value) {
    let Some(recipe) = data.get("recipe").filter(|value| !value.is_null()) else {
        return;
    };
    print_recipe_result(recipe);
}

fn print_recipe_result(recipe: &Value) {
    let list = |key: &str| {
        recipe.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default()
            .iter().filter_map(Value::as_str).collect::<Vec<_>>()
    };
    println!("receta: {}", recipe.get("projectKey").and_then(Value::as_str).unwrap_or("?"));
    for (label, key) in [("aplicado", "applied"), ("omitido", "skipped"), ("error", "errors")] {
        for entry in list(key) {
            println!("  {label}: {entry}");
        }
    }
}

fn print_preview(data: &Value) {
    let exists = data.get("recipeExists").and_then(Value::as_bool).unwrap_or(false);
    println!(
        "receta {}: {}",
        if exists { "encontrada" } else { "ausente" },
        data.get("recipeDir").and_then(Value::as_str).unwrap_or("(sin directorio)"),
    );
    for file in data.get("files").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
        let field = |key: &str| file.get(key).and_then(Value::as_str).unwrap_or("");
        let tracked = if file.get("tracked").and_then(Value::as_bool).unwrap_or(false) { " (versionado)" } else { "" };
        println!("  {:<10} {}{tracked}", field("action"), field("path"));
    }
    for warning in data.get("warnings").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
        println!("  aviso: {}", warning.as_str().unwrap_or_default());
    }
}
