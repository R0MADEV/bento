use std::fs;
use std::io::Write;
use std::path::PathBuf;

fn history_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no home dir".to_string())?;
    let dir = PathBuf::from(home).join(".config").join("bento");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("chat-history.json"))
}

#[tauri::command]
pub fn chat_history_load() -> Result<String, String> {
    let path = history_path()?;
    load_history(&path)
}

#[tauri::command]
pub fn chat_history_save(content: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|error| format!("invalid chat history: {error}"))?;
    save_history(&history_path()?, &content)
}

fn load_history(path: &std::path::Path) -> Result<String, String> {
    for candidate in [path.to_path_buf(), path.with_extension("json.bak")] {
        if let Ok(content) = fs::read_to_string(candidate) {
            if serde_json::from_str::<serde_json::Value>(&content).is_ok() {
                return Ok(content);
            }
        }
    }
    Ok("[]".to_string())
}

fn save_history(path: &std::path::Path, content: &str) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let mut file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    if path.exists() {
        fs::copy(path, &backup).map_err(|error| error.to_string())?;
    }
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{load_history, save_history};

    fn path(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let directory = std::env::temp_dir().join(format!(
            "bento-chat-history-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        (directory.join("chat-history.json"), directory)
    }

    #[test]
    fn saves_and_loads_valid_history() {
        let (history, directory) = path("roundtrip");
        save_history(&history, r#"{"version":2,"conversations":{}}"#).unwrap();
        assert_eq!(
            load_history(&history).unwrap(),
            r#"{"version":2,"conversations":{}}"#
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn falls_back_to_the_last_valid_backup() {
        let (history, directory) = path("backup");
        save_history(&history, r#"[{"role":"user","content":"first"}]"#).unwrap();
        save_history(&history, r#"[{"role":"user","content":"second"}]"#).unwrap();
        std::fs::write(&history, "broken").unwrap();
        assert!(load_history(&history).unwrap().contains("first"));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
