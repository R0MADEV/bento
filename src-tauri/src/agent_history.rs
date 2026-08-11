// Agent scrollback (large, optional) lives in files under
// ~/.config/bento/agent-history/, keyed by the panel's storage scope, so it never
// competes with localStorage's small resume metadata for the ~5-10 MB browser
// quota. Mirrors herdr's separate session-history.json. Content is a JSON array
// of per-agent snapshot strings.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};

fn history_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no home dir".to_string())?;
    let dir = PathBuf::from(home)
        .join(".config")
        .join("bento")
        .join("agent-history");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// A readable, collision-free filename for a storage scope. The scope can hold
// slashes/colons (worktree paths), so sanitize to ASCII and append a stable hash
// (DefaultHasher uses fixed keys → deterministic across runs) to avoid two scopes
// mapping to the same file.
fn scope_filename(scope: &str) -> String {
    let mut hasher = DefaultHasher::new();
    scope.hash(&mut hasher);
    let hash = hasher.finish();
    let safe: String = scope
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-') { c } else { '_' })
        .collect();
    let start = safe.len().saturating_sub(48); // safe is ASCII → byte index == char boundary
    format!("{}-{hash:016x}.json", &safe[start..])
}

#[tauri::command]
pub fn agent_history_load(scope: String) -> Result<String, String> {
    let path = history_dir()?.join(scope_filename(&scope));
    load_history(&path)
}

#[tauri::command]
pub fn agent_history_save(scope: String, content: String) -> Result<(), String> {
    // Reject malformed payloads before touching disk.
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|error| format!("invalid agent history: {error}"))?;
    let path = history_dir()?.join(scope_filename(&scope));
    save_history(&path, &content)
}

#[tauri::command]
pub fn agent_history_clear(scope: String) -> Result<(), String> {
    let path = history_dir()?.join(scope_filename(&scope));
    let _ = fs::remove_file(path);
    Ok(())
}

fn load_history(path: &Path) -> Result<String, String> {
    if let Ok(content) = fs::read_to_string(path) {
        if serde_json::from_str::<serde_json::Value>(&content).is_ok() {
            return Ok(content);
        }
    }
    Ok("[]".to_string())
}

// Atomic write: temp file + rename, so a crash mid-write never corrupts the file.
fn save_history(path: &Path, content: &str) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_filename_is_deterministic_and_safe() {
        let scope = "bento.agents.wt:/Users/x/Desktop/konect-nixon";
        let a = scope_filename(scope);
        let b = scope_filename(scope);
        assert_eq!(a, b, "must be stable across calls");
        assert!(a.ends_with(".json"));
        assert!(!a.contains('/') && !a.contains(':'), "no path separators in filename");
    }

    #[test]
    fn distinct_scopes_get_distinct_files() {
        assert_ne!(
            scope_filename("bento.agents"),
            scope_filename("bento.agents.wt:/a/b"),
        );
    }

    #[test]
    fn saves_and_loads_roundtrip() {
        let dir = std::env::temp_dir().join(format!("bento-agent-history-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("h.json");
        save_history(&path, r#"["scrollback-a","scrollback-b"]"#).unwrap();
        assert_eq!(load_history(&path).unwrap(), r#"["scrollback-a","scrollback-b"]"#);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_or_corrupt_file_loads_empty() {
        let dir = std::env::temp_dir().join(format!("bento-agent-history-corrupt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("h.json");
        assert_eq!(load_history(&path).unwrap(), "[]");
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(load_history(&path).unwrap(), "[]");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
