//! `bento notes …`: los ficheros `.md` de `~/.config/bento/notes`.

use serde_json::{json, Value};

use crate::{print_text, request, request_data};

pub(crate) async fn run(args: &[String]) -> std::io::Result<()> {
    match args.get(1).map(String::as_str) {
        None | Some("list") | Some("ls") => {
            let data = request_data(json!({ "id": "1", "cmd": "notes.list" })).await?;
            let notes = data.as_array().map(Vec::as_slice).unwrap_or_default();
            if notes.is_empty() {
                println!("(sin notas)");
            }
            for note in notes {
                let name = note.get("name").and_then(Value::as_str).unwrap_or_default();
                let lines = note.get("content").and_then(Value::as_str).unwrap_or_default().lines().count();
                println!("{name:<40} {lines} líneas");
            }
            Ok(())
        }
        Some("read") | Some("cat") => match args.get(2) {
            Some(name) => {
                let data = request_data(json!({ "id": "1", "cmd": "notes.read", "path": name })).await?;
                print_text(data.as_str().unwrap_or_default());
                Ok(())
            }
            None => { eprintln!("usage: bento notes read <nombre.md>"); Ok(()) }
        },
        // El contenido llega por stdin: una nota es texto largo, no un argumento.
        Some("write") => match args.get(2) {
            Some(name) => {
                let mut content = String::new();
                std::io::Read::read_to_string(&mut std::io::stdin(), &mut content)?;
                request(json!({ "id": "1", "cmd": "notes.write", "path": name, "data": content })).await
            }
            None => { eprintln!("usage: bento notes write <nombre.md> < fichero"); Ok(()) }
        },
        Some("rm") | Some("delete") => match args.get(2) {
            Some(name) => request(json!({ "id": "1", "cmd": "notes.delete", "path": name })).await,
            None => { eprintln!("usage: bento notes rm <nombre.md>"); Ok(()) }
        },
        _ => { crate::print_help(); Ok(()) }
    }
}
