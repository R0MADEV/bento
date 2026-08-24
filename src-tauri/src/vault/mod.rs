//! Los comandos del vault. Todo lo que cifra vive en `crypto`.

mod crypto;

pub use crypto::VaultState;
use crypto::{derive_key, new_id, UnlockedVault, VaultEntry, VaultEntryPublic};

use rand::RngCore;
use crypto::{read_and_decrypt, vault_path, write_vault};


#[tauri::command]
pub fn vault_exists() -> bool {
    vault_path().map(|p| p.exists()).unwrap_or(false)
}

#[tauri::command]
pub fn vault_is_unlocked(state: tauri::State<VaultState>) -> bool {
    state.0.lock().unwrap().is_some()
}

#[tauri::command]
pub fn vault_setup(password: String, state: tauri::State<VaultState>) -> Result<(), String> {
    if password.len() < 4 {
        return Err("La contraseña maestra debe tener al menos 4 caracteres.".to_string());
    }
    let mut kdf_salt = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut kdf_salt);
    let key = derive_key(&password, &kdf_salt)?;
    write_vault(&key, &kdf_salt, &[])?;
    *state.0.lock().unwrap() = Some(UnlockedVault {
        key,
        kdf_salt: kdf_salt.to_vec(),
        entries: vec![],
    });
    Ok(())
}

#[tauri::command]
pub fn vault_unlock(
    password: String,
    state: tauri::State<VaultState>,
) -> Result<Vec<VaultEntryPublic>, String> {
    let (entries, key, kdf_salt) = read_and_decrypt(&password)?;
    let public: Vec<VaultEntryPublic> = entries.iter().map(|e| e.into()).collect();
    *state.0.lock().unwrap() = Some(UnlockedVault {
        key,
        kdf_salt,
        entries,
    });
    Ok(public)
}

#[tauri::command]
pub fn vault_lock(state: tauri::State<VaultState>) {
    *state.0.lock().unwrap() = None;
}

#[tauri::command]
pub fn vault_list(state: tauri::State<VaultState>) -> Result<Vec<VaultEntryPublic>, String> {
    let guard = state.0.lock().unwrap();
    let vault = guard.as_ref().ok_or("Vault bloqueado.")?;
    Ok(vault.entries.iter().map(|e| e.into()).collect())
}

#[tauri::command]
pub fn vault_add(
    service: String,
    username: String,
    password: String,
    url: String,
    notes: String,
    state: tauri::State<VaultState>,
) -> Result<VaultEntryPublic, String> {
    let mut guard = state.0.lock().unwrap();
    let vault = guard.as_mut().ok_or("Vault bloqueado.")?;
    let entry = VaultEntry {
        id: new_id(),
        service,
        username,
        password,
        url,
        notes,
    };
    let public = VaultEntryPublic::from(&entry);
    vault.entries.push(entry);
    write_vault(&vault.key, &vault.kdf_salt, &vault.entries)?;
    Ok(public)
}

#[tauri::command]
pub fn vault_delete(id: String, state: tauri::State<VaultState>) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    let vault = guard.as_mut().ok_or("Vault bloqueado.")?;
    let before = vault.entries.len();
    vault.entries.retain(|e| e.id != id);
    if vault.entries.len() == before {
        return Err(format!("Entrada '{}' no encontrada.", id));
    }
    write_vault(&vault.key, &vault.kdf_salt, &vault.entries)
}

#[tauri::command]
pub fn vault_verify_password(password: String) -> bool {
    read_and_decrypt(&password).is_ok()
}

#[tauri::command]
pub fn vault_get_password(id: String, state: tauri::State<VaultState>) -> Result<String, String> {
    let guard = state.0.lock().unwrap();
    let vault = guard.as_ref().ok_or("Vault bloqueado.")?;
    vault
        .entries
        .iter()
        .find(|e| e.id == id)
        .map(|e| e.password.clone())
        .ok_or_else(|| "Entrada no encontrada.".to_string())
}

#[tauri::command]
pub fn vault_update(
    id: String,
    service: String,
    username: String,
    password: String,
    url: String,
    notes: String,
    state: tauri::State<VaultState>,
) -> Result<VaultEntryPublic, String> {
    let mut guard = state.0.lock().unwrap();
    let vault = guard.as_mut().ok_or("Vault bloqueado.")?;
    let entry = vault
        .entries
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or("Entrada no encontrada.")?;
    entry.service = service;
    entry.username = username;
    if !password.is_empty() {
        entry.password = password;
    }
    entry.url = url;
    entry.notes = notes;
    let public = VaultEntryPublic::from(&*entry);
    write_vault(&vault.key, &vault.kdf_salt, &vault.entries)?;
    Ok(public)
}

// ---- unit tests ----
