//! `bento memory …`: las memorias que el panel guarda en el SQLite de la app.

use serde_json::{json, Value};

use crate::{current_dir_string, flag, request_data};

pub(crate) async fn run(args: &[String]) -> std::io::Result<()> {
    match args.get(1).map(String::as_str) {
        None | Some("list") | Some("ls") => {
            let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
            let data = request_data(json!({ "id": "1", "cmd": "memory.list", "cwd": cwd })).await?;
            print_entries(&data);
            Ok(())
        }
        Some("all") => {
            let data = request_data(json!({ "id": "1", "cmd": "memory.list_all" })).await?;
            print_entries(&data);
            Ok(())
        }
        Some("add") => match args.get(2) {
            Some(title) => {
                let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                let data = request_data(json!({
                    "id": "1", "cmd": "memory.create", "cwd": cwd, "data": title,
                    "agent": flag(args, "--kind").unwrap_or_else(|| "note".into()),
                    "content": flag(args, "--summary").unwrap_or_default(),
                    "context": flag(args, "--details").unwrap_or_default(),
                })).await?;
                println!("{}", data.get("id").and_then(Value::as_str).unwrap_or("?"));
                Ok(())
            }
            None => { eprintln!("usage: bento memory add <título> [--summary <texto>] [--kind decision|fact|task|note]"); Ok(()) }
        },
        Some("rm") | Some("delete") => match args.get(2) {
            Some(id) => {
                let cwd = flag(args, "--cwd").unwrap_or_else(current_dir_string);
                let data = request_data(json!({ "id": "1", "cmd": "memory.remove", "cwd": cwd, "path": id })).await?;
                let removed = data.get("removed").and_then(Value::as_bool).unwrap_or(false);
                println!("{}", if removed { "borrada" } else { "(no existía)" });
                Ok(())
            }
            None => { eprintln!("usage: bento memory rm <id>"); Ok(()) }
        },
        _ => { crate::print_help(); Ok(()) }
    }
}

/// Una memoria por línea: tipo, título y de qué proyecto es. Lo que quieres ver
/// antes de decidir cuál abrir entera.
fn print_entries(data: &Value) {
    let entries = data.as_array().map(Vec::as_slice).unwrap_or_default();
    if entries.is_empty() {
        println!("(sin memorias)");
        return;
    }
    for entry in entries {
        let field = |key: &str| entry.get(key).and_then(Value::as_str).unwrap_or("");
        let title = match field("title") {
            "" => field("summary"),
            title => title,
        };
        println!(
            "{:<9} {:<52} {}",
            field("kind"),
            title.chars().take(52).collect::<String>(),
            field("projectPath"),
        );
    }
}
