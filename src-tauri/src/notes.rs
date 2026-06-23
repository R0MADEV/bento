// Notes are plain .md files in ~/.config/bento/notes/. Portable (open them in
// any editor), git-versionable, importable from Notion/Obsidian exports.

use std::fs;
use std::path::PathBuf;

fn notes_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no home dir".to_string())?;
    let dir = PathBuf::from(home).join(".config").join("bento").join("notes");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// Only a plain .md filename is allowed — reject path traversal.
fn safe_path(dir: &PathBuf, name: &str) -> Result<PathBuf, String> {
    let invalid = name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..");
    if invalid {
        return Err("invalid note name".into());
    }
    let path = dir.join(name);
    if path.parent() != Some(dir.as_path()) {
        return Err("invalid note path".into());
    }
    Ok(path)
}

#[derive(serde::Serialize)]
pub struct NoteFile {
    name: String,
    content: String,
}

#[tauri::command]
pub fn notes_list() -> Result<Vec<NoteFile>, String> {
    let dir = notes_dir()?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        let content = fs::read_to_string(&path).unwrap_or_default();
        out.push(NoteFile { name: name.to_string(), content });
    }
    Ok(out)
}

#[tauri::command]
pub fn notes_write(name: String, content: String) -> Result<(), String> {
    let path = safe_path(&notes_dir()?, &name)?;
    fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notes_delete(name: String) -> Result<(), String> {
    let path = safe_path(&notes_dir()?, &name)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
