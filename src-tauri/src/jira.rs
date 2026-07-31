// Jira accounts config stored in ~/.config/bento/jira_accounts.json (0600).
// Supports multiple accounts; each has a unique id derived from the site URL.
// Legacy single-account jira.json is migrated on first read.

use std::fs;
use std::path::PathBuf;

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
pub struct JiraAccount {
    pub id: String,
    pub site: String,
    pub email: String,
    pub token: String,
}

fn bento_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no home dir".to_string())?;
    let dir = PathBuf::from(home).join(".config").join("bento");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn accounts_path() -> Result<PathBuf, String> {
    Ok(bento_dir()?.join("jira_accounts.json"))
}

/// Derive a stable id from the site URL (e.g. "https://acme.atlassian.net" → "acme.atlassian.net").
pub fn account_id(site: &str) -> String {
    site.trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_lowercase()
}

fn write_accounts(path: &PathBuf, accounts: &[JiraAccount]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(accounts).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Read all accounts. Migrates the legacy single-account jira.json if present.
fn read_accounts() -> Result<Vec<JiraAccount>, String> {
    let dir = bento_dir()?;
    let new_path = dir.join("jira_accounts.json");

    if new_path.exists() {
        let raw = fs::read_to_string(&new_path).map_err(|e| e.to_string())?;
        return serde_json::from_str(&raw).map_err(|e| e.to_string());
    }

    // Migrate legacy format.
    let legacy_path = dir.join("jira.json");
    if legacy_path.exists() {
        #[derive(serde::Deserialize)]
        struct Legacy { site: String, email: String, token: String }
        let raw = fs::read_to_string(&legacy_path).map_err(|e| e.to_string())?;
        if let Ok(leg) = serde_json::from_str::<Legacy>(&raw) {
            if !leg.site.is_empty() {
                let account = JiraAccount {
                    id: account_id(&leg.site),
                    site: leg.site,
                    email: leg.email,
                    token: leg.token,
                };
                let accounts = vec![account];
                write_accounts(&new_path, &accounts)?;
                let _ = fs::remove_file(&legacy_path);
                return Ok(accounts);
            }
        }
    }

    Ok(vec![])
}

// ---- Tauri commands ----

#[tauri::command]
pub fn jira_accounts_get() -> Result<Vec<JiraAccount>, String> {
    read_accounts()
}

#[tauri::command]
pub fn jira_account_set(site: String, email: String, token: String) -> Result<JiraAccount, String> {
    let path = accounts_path()?;
    let mut accounts = read_accounts()?;
    let id = account_id(&site);
    let account = JiraAccount { id: id.clone(), site, email, token };
    if let Some(existing) = accounts.iter_mut().find(|a| a.id == id) {
        *existing = account.clone();
    } else {
        accounts.push(account.clone());
    }
    write_accounts(&path, &accounts)?;
    Ok(account)
}

#[tauri::command]
pub fn jira_account_delete(id: String) -> Result<(), String> {
    let path = accounts_path()?;
    let mut accounts = read_accounts()?;
    let before = accounts.len();
    accounts.retain(|a| a.id != id);
    if accounts.len() == before {
        return Err(format!("account '{}' not found", id));
    }
    write_accounts(&path, &accounts)
}

// ---- unit tests (pure logic, no filesystem) ----

#[cfg(test)]
mod tests {
    use super::account_id;

    #[test]
    fn id_strips_scheme_and_slash() {
        assert_eq!(account_id("https://acme.atlassian.net/"), "acme.atlassian.net");
    }

    #[test]
    fn id_strips_http() {
        assert_eq!(account_id("http://self-hosted.example.com"), "self-hosted.example.com");
    }

    #[test]
    fn id_is_lowercase() {
        assert_eq!(account_id("https://ACME.atlassian.net"), "acme.atlassian.net");
    }

    #[test]
    fn id_already_clean() {
        assert_eq!(account_id("acme.atlassian.net"), "acme.atlassian.net");
    }
}
