use std::fs;
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
    if !path.exists() {
        return Ok("[]".to_string());
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_history_save(content: String) -> Result<(), String> {
    fs::write(history_path()?, content).map_err(|e| e.to_string())
}
