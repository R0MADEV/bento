use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Clone, Debug, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    devcontainer_recipes_dir: Option<String>,
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "e2e")]
    if let Some(directory) = std::env::var_os("BENTO_E2E_CONFIG_DIR") {
        return Ok(PathBuf::from(directory).join("settings.json"));
    }
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("settings.json"))
        .map_err(|error| error.to_string())
}

fn load_settings_path(path: &Path) -> Result<AppSettings, String> {
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn save_settings_path(path: &Path, settings: &AppSettings) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "invalid settings path".to_string())?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let raw = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, raw).map_err(|error| error.to_string())?;
    if cfg!(windows) && path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn settings_get(app: tauri::AppHandle) -> Result<AppSettings, String> {
    load_settings_path(&settings_path(&app)?)
}

#[tauri::command]
pub fn settings_set(app: tauri::AppHandle, settings: AppSettings) -> Result<(), String> {
    save_settings_path(&settings_path(&app)?, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_settings(name: &str) -> (PathBuf, PathBuf) {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "bento-settings-{name}-{}-{nonce}",
            std::process::id()
        ));
        (directory.join("settings.json"), directory)
    }

    #[test]
    fn missing_file_loads_default_settings() {
        let (path, _) = temporary_settings("default");
        assert_eq!(load_settings_path(&path).unwrap(), AppSettings::default());
    }

    #[test]
    fn recipes_directory_is_persisted_in_settings_file() {
        let (path, directory) = temporary_settings("recipes");
        let settings = AppSettings {
            devcontainer_recipes_dir: Some("/repos/bento-recipes".into()),
        };
        save_settings_path(&path, &settings).unwrap();
        assert_eq!(load_settings_path(&path).unwrap(), settings);
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("devcontainerRecipesDir"));
        let _ = fs::remove_dir_all(directory);
    }
}
