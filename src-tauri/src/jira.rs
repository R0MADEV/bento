// Jira connection config (site, email, API token) stored in
// ~/.config/bento/jira.json with 0600 perms — it holds a secret token, so it
// must never be world-readable. API calls themselves go through `http_request`.

use std::fs;
use std::path::PathBuf;

#[derive(serde::Serialize, serde::Deserialize, Default)]
pub struct JiraConfig {
    pub site: String,
    pub email: String,
    pub token: String,
}

fn config_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no home dir".to_string())?;
    let dir = PathBuf::from(home).join(".config").join("bento");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("jira.json"))
}

#[tauri::command]
pub fn jira_config_get() -> Result<JiraConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(JiraConfig::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn jira_config_set(site: String, email: String, token: String) -> Result<(), String> {
    let path = config_path()?;
    let json = serde_json::to_string_pretty(&JiraConfig { site, email, token }).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    // Restrict to the owner: the file holds an API token.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}
