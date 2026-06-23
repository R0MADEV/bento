// API keys for the AI providers, stored in the OS keychain (never plaintext on disk).
// bento manages them here and injects them as env vars into terminals (see pty.rs);
// lexis then reads them from process.env unchanged.

const SERVICE: &str = "bento-ai";

// Providers bento knows about. The env var lexis reads is <PROVIDER>_API_KEY.
pub const PROVIDERS: [&str; 5] = ["deepseek", "groq", "gemini", "openai", "anthropic"];

pub fn env_var(provider: &str) -> String {
    format!("{}_API_KEY", provider.to_uppercase())
}

fn entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, provider).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_key_set(provider: String, key: String) -> Result<(), String> {
    entry(&provider)?.set_password(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_key_delete(provider: String) -> Result<(), String> {
    match entry(&provider)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// Which providers currently have a key stored (for the settings UI). Never returns
// the secrets themselves.
#[tauri::command]
pub fn ai_key_list() -> Vec<String> {
    PROVIDERS
        .iter()
        .filter(|p| entry(p).and_then(|e| e.get_password().map_err(|e| e.to_string())).is_ok())
        .map(|p| p.to_string())
        .collect()
}

// (provider, key) pairs for every stored key — used by pty.rs to inject env vars.
pub fn all_keys() -> Vec<(String, String)> {
    PROVIDERS
        .iter()
        .filter_map(|p| {
            let key = entry(p).ok()?.get_password().ok()?;
            Some((p.to_string(), key))
        })
        .collect()
}
