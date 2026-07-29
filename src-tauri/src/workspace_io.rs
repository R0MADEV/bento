use std::collections::HashMap;
use std::fs;
use tauri::Manager;

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSession {
    id: String,
    name: String,
    project_path: Option<String>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    #[serde(default = "workspace_schema_version")]
    schema_version: u32,
    sessions: Vec<WorkspaceSession>,
    active_id: Option<String>,
    #[serde(default)]
    layouts: HashMap<String, serde_json::Value>,
}

fn workspace_schema_version() -> u32 {
    1
}

fn validate_workspace(state: WorkspaceState) -> Result<WorkspaceState, String> {
    if state.schema_version != workspace_schema_version() {
        return Err(format!(
            "unsupported workspace schema version: {}",
            state.schema_version
        ));
    }
    Ok(state)
}

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

fn read_workspace(path: &std::path::Path) -> Result<WorkspaceState, String> {
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let state = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    validate_workspace(state)
}

fn load_workspace_path(path: &std::path::Path) -> Result<Option<WorkspaceState>, String> {
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

fn save_workspace_path(path: &std::path::Path, state: &WorkspaceState) -> Result<(), String> {
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
pub fn workspace_load(app: tauri::AppHandle) -> Result<Option<WorkspaceState>, String> {
    let path = workspace_path(&app)?;
    load_workspace_path(&path)
}

#[tauri::command]
pub fn workspace_save(app: tauri::AppHandle, state: WorkspaceState) -> Result<(), String> {
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

    #[test]
    fn workspace_contract_uses_frontend_field_names() {
        let state = WorkspaceState {
            schema_version: workspace_schema_version(),
            sessions: vec![WorkspaceSession {
                id: "session-1".into(),
                name: "Session 1".into(),
                project_path: Some("/repo".into()),
            }],
            active_id: Some("session-1".into()),
            layouts: HashMap::new(),
        };
        let value = serde_json::to_value(state).unwrap();
        assert_eq!(value["activeId"], "session-1");
        assert_eq!(value["sessions"][0]["projectPath"], "/repo");
    }

    fn state(name: &str) -> WorkspaceState {
        WorkspaceState {
            schema_version: workspace_schema_version(),
            sessions: vec![WorkspaceSession {
                id: "session-1".into(),
                name: name.into(),
                project_path: None,
            }],
            active_id: Some("session-1".into()),
            layouts: HashMap::new(),
        }
    }

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
        save_workspace_path(&path, &state("first")).unwrap();
        save_workspace_path(&path, &state("second")).unwrap();
        assert_eq!(
            read_workspace(&backup_path(&path)).unwrap().sessions[0].name,
            "first"
        );
        assert_eq!(read_workspace(&path).unwrap().sessions[0].name, "second");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn load_recovers_from_a_corrupt_primary_file() {
        let (path, directory) = temporary_workspace("recovery");
        save_workspace_path(&path, &state("recoverable")).unwrap();
        fs::copy(&path, backup_path(&path)).unwrap();
        fs::write(&path, b"{broken").unwrap();
        let recovered = load_workspace_path(&path).unwrap().unwrap();
        assert_eq!(recovered.sessions[0].name, "recoverable");
        let _ = fs::remove_dir_all(directory);
    }
}
