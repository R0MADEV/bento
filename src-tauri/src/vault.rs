// Vault: encrypted credential storage using Argon2 (key derivation) + AES-256-GCM.
// The master password is never stored — only used to derive the encryption key.
// File: ~/.config/bento/vault.json (0600 perms).

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use argon2::{Argon2, Params};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};

// ---- types ----

#[derive(Serialize, Deserialize, Clone)]
pub struct VaultEntry {
    pub id: String,
    pub service: String,
    pub username: String,
    pub password: String, // plaintext only while in memory; encrypted at rest
    pub url: String,
    pub notes: String,
}

// Public entry sent to frontend — password is always hidden.
#[derive(Serialize, Clone)]
pub struct VaultEntryPublic {
    pub id: String,
    pub service: String,
    pub username: String,
    pub url: String,
    pub notes: String,
}

impl From<&VaultEntry> for VaultEntryPublic {
    fn from(e: &VaultEntry) -> Self {
        Self {
            id: e.id.clone(),
            service: e.service.clone(),
            username: e.username.clone(),
            url: e.url.clone(),
            notes: e.notes.clone(),
        }
    }
}

// Stored on disk: salt + nonce + ciphertext (all base64).
#[derive(Serialize, Deserialize)]
struct VaultFile {
    salt: String,
    nonce: String,
    ciphertext: String,
}

// In-memory unlocked state held in Tauri managed state.
pub struct VaultState(pub Mutex<Option<UnlockedVault>>);

pub struct UnlockedVault {
    pub key: [u8; 32],
    pub kdf_salt: Vec<u8>, // key-derivation salt — fixed per vault, stored in file
    pub entries: Vec<VaultEntry>,
}

// ---- pure helpers (unit-testable) ----

pub fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let params = Params::new(65536, 3, 1, Some(32)).map_err(|e| e.to_string())?;
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = [0u8; 32];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| e.to_string())?;
    Ok(key)
}

pub fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| e.to_string())?;
    Ok((nonce_bytes.to_vec(), ciphertext))
}

pub fn decrypt(key: &[u8; 32], nonce_bytes: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "Contraseña maestra incorrecta.".to_string())
}

pub fn new_id() -> String {
    let mut bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

// ---- filesystem helpers ----

fn vault_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no home dir".to_string())?;
    let dir = PathBuf::from(home).join(".config").join("bento");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("vault.json"))
}

// kdf_salt is the Argon2 salt used to derive `key` — must be stored unchanged so
// we can re-derive the same key on the next unlock. Only the AES-GCM nonce rotates.
fn write_vault(key: &[u8; 32], kdf_salt: &[u8], entries: &[VaultEntry]) -> Result<(), String> {
    let plaintext = serde_json::to_vec(entries).map_err(|e| e.to_string())?;
    let (nonce, ciphertext) = encrypt(key, &plaintext)?;
    let file = VaultFile {
        salt: B64.encode(kdf_salt),
        nonce: B64.encode(&nonce),
        ciphertext: B64.encode(&ciphertext),
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    let path = vault_path()?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn read_and_decrypt(password: &str) -> Result<(Vec<VaultEntry>, [u8; 32], Vec<u8>), String> {
    let path = vault_path()?;
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let file: VaultFile = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let kdf_salt = B64.decode(&file.salt).map_err(|e| e.to_string())?;
    let key = derive_key(password, &kdf_salt)?;
    let nonce = B64.decode(&file.nonce).map_err(|e| e.to_string())?;
    let ct = B64.decode(&file.ciphertext).map_err(|e| e.to_string())?;
    let plaintext = decrypt(&key, &nonce, &ct)?;
    let entries: Vec<VaultEntry> = serde_json::from_slice(&plaintext).map_err(|e| e.to_string())?;
    Ok((entries, key, kdf_salt))
}

// ---- Tauri commands ----

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_key_is_deterministic() {
        let salt = b"testsalt_testsalt_testsalt_tests";
        let k1 = derive_key("password", salt).unwrap();
        let k2 = derive_key("password", salt).unwrap();
        assert_eq!(k1, k2);
    }

    #[test]
    fn different_passwords_give_different_keys() {
        let salt = b"testsalt_testsalt_testsalt_tests";
        let k1 = derive_key("abc", salt).unwrap();
        let k2 = derive_key("xyz", salt).unwrap();
        assert_ne!(k1, k2);
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let salt = b"testsalt_testsalt_testsalt_tests";
        let key = derive_key("master", salt).unwrap();
        let plaintext = b"super secret password";
        let (nonce, ct) = encrypt(&key, plaintext).unwrap();
        let recovered = decrypt(&key, &nonce, &ct).unwrap();
        assert_eq!(recovered, plaintext);
    }

    #[test]
    fn wrong_key_fails_decryption() {
        let salt = b"testsalt_testsalt_testsalt_tests";
        let key1 = derive_key("correct", salt).unwrap();
        let key2 = derive_key("wrong", salt).unwrap();
        let (nonce, ct) = encrypt(&key1, b"secret").unwrap();
        assert!(decrypt(&key2, &nonce, &ct).is_err());
    }
}
