use std::fs;
use tauri::Manager;

// The workspace is persisted as an opaque JSON blob: the frontend owns the
// schema (see src/core/session/savedState.ts) and its migrations. Here we only
// do durable, atomic file I/O with a backup — validity means "parseable JSON".

fn workspace_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    #[cfg(feature = "e2e")]
    if let Some(directory) = std::env::var_os("BENTO_E2E_CONFIG_DIR") {
        return Ok(std::path::PathBuf::from(directory).join("workspace.json"));
    }
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("workspace.json"))
        .map_err(|error| error.to_string())
}

fn backup_path(path: &std::path::Path) -> std::path::PathBuf {
    path.with_extension("json.bak")
}

fn read_workspace(path: &std::path::Path) -> Result<serde_json::Value, String> {
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn load_workspace_path(path: &std::path::Path) -> Result<Option<serde_json::Value>, String> {
    if !path.exists() {
        return if backup_path(path).exists() {
            read_workspace(&backup_path(path)).map(Some)
        } else {
            Ok(None)
        };
    }
    match read_workspace(path) {
        Ok(state) => Ok(Some(state)),
        Err(primary_error) => match read_workspace(&backup_path(path)) {
            Ok(state) => Ok(Some(state)),
            Err(backup_error) => Err(format!(
                "workspace is invalid ({primary_error}); backup is unavailable ({backup_error})"
            )),
        },
    }
}

fn save_workspace_path(path: &std::path::Path, state: &serde_json::Value) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "invalid workspace path".to_string())?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    if path.exists() && read_workspace(path).is_ok() {
        fs::copy(path, backup_path(path)).map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, raw).map_err(|error| error.to_string())?;
    if cfg!(windows) && path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn workspace_load(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = workspace_path(&app)?;
    load_workspace_path(&path)
}

#[tauri::command]
pub fn workspace_save(app: tauri::AppHandle, state: serde_json::Value) -> Result<(), String> {
    let path = workspace_path(&app)?;
    save_workspace_path(&path, &state)
}

#[tauri::command]
pub fn workspace_reset(app: tauri::AppHandle) -> Result<(), String> {
    let path = workspace_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temporary_workspace(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "bento-workspace-{name}-{}-{nonce}",
            std::process::id()
        ));
        (directory.join("workspace.json"), directory)
    }

    #[test]
    fn save_keeps_the_previous_valid_workspace_as_backup() {
        let (path, directory) = temporary_workspace("backup");
        save_workspace_path(&path, &json!({ "schemaVersion": 2, "layout": "first" })).unwrap();
        save_workspace_path(&path, &json!({ "schemaVersion": 2, "layout": "second" })).unwrap();
        assert_eq!(read_workspace(&backup_path(&path)).unwrap()["layout"], "first");
        assert_eq!(read_workspace(&path).unwrap()["layout"], "second");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn load_recovers_from_a_corrupt_primary_file() {
        let (path, directory) = temporary_workspace("recovery");
        save_workspace_path(&path, &json!({ "schemaVersion": 2, "layout": "recoverable" })).unwrap();
        fs::copy(&path, backup_path(&path)).unwrap();
        fs::write(&path, b"{broken").unwrap();
        let recovered = load_workspace_path(&path).unwrap().unwrap();
        assert_eq!(recovered["layout"], "recoverable");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn missing_workspace_loads_none() {
        let (path, directory) = temporary_workspace("missing");
        assert!(load_workspace_path(&path).unwrap().is_none());
        let _ = fs::remove_dir_all(directory);
    }
}
