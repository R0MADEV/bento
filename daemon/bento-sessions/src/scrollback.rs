//! Lo que los agentes dejan escrito: el scrollback de cada panel y el historial
//! del chat. Van a ficheros bajo ~/.config/bento/ y no a localStorage, que tiene
//! 5-10 MB para todo y esto los llenaría solo.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};

fn config_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no home dir".to_string())?;
    let dir = PathBuf::from(home).join(".config").join("bento");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn history_dir() -> Result<PathBuf, String> {
    let dir = config_dir()?.join("agent-history");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

/// Un nombre de fichero legible y sin colisiones para un ámbito. El ámbito
/// puede llevar barras o dos puntos (rutas de worktree), así que se pasa a
/// ASCII y se le pega un hash estable (`DefaultHasher` usa claves fijas) para
/// que dos ámbitos distintos no acaben en el mismo fichero.
fn scope_filename(scope: &str) -> String {
    let mut hasher = DefaultHasher::new();
    scope.hash(&mut hasher);
    let hash = hasher.finish();
    let safe: String = scope
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-') { c } else { '_' })
        .collect();
    let start = safe.len().saturating_sub(48); // safe es ASCII → el índice cae en un límite de carácter
    format!("{}-{hash:016x}.json", &safe[start..])
}

pub fn history_load(scope: &str) -> Result<String, String> {
    load(&history_dir()?.join(scope_filename(scope)), &[])
}

pub fn history_save(scope: &str, content: &str) -> Result<(), String> {
    check_json(content, "agent history")?;
    save(&history_dir()?.join(scope_filename(scope)), content, false)
}

pub fn history_clear(scope: &str) -> Result<(), String> {
    let _ = fs::remove_file(history_dir()?.join(scope_filename(scope)));
    Ok(())
}

fn chat_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("chat-history.json"))
}

pub fn chat_load() -> Result<String, String> {
    let path = chat_path()?;
    let backup = path.with_extension("json.bak");
    load(&path, &[backup])
}

pub fn chat_save(content: &str) -> Result<(), String> {
    check_json(content, "chat history")?;
    save(&chat_path()?, content, true)
}

/// Payload malformado se rechaza antes de tocar el disco.
fn check_json(content: &str, what: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(content)
        .map(|_| ())
        .map_err(|error| format!("invalid {what}: {error}"))
}

/// Lo que haya, o `[]`: un fichero roto no debe dejar el panel sin arrancar.
fn load(path: &Path, fallbacks: &[PathBuf]) -> Result<String, String> {
    for candidate in std::iter::once(path).chain(fallbacks.iter().map(PathBuf::as_path)) {
        if let Ok(content) = fs::read_to_string(candidate) {
            if serde_json::from_str::<serde_json::Value>(&content).is_ok() {
                return Ok(content);
            }
        }
    }
    Ok("[]".to_string())
}

/// Escritura atómica: fichero temporal y rename, para que una caída a mitad no
/// deje el historial corrupto. Con `keep_backup` se guarda además la copia
/// anterior, que es de donde tira `chat_load` si la buena se rompe.
fn save(path: &Path, content: &str, keep_backup: bool) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let mut file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
    file.write_all(content.as_bytes()).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    if keep_backup && path.exists() {
        fs::copy(path, path.with_extension("json.bak")).map_err(|error| error.to_string())?;
    }
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("bento-{name}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_scope_always_maps_to_the_same_safe_filename() {
        let scope = "bento.agents.wt:/Users/x/Desktop/konect-nixon";
        let name = scope_filename(scope);
        assert_eq!(name, scope_filename(scope), "tiene que ser estable");
        assert!(name.ends_with(".json"));
        assert!(!name.contains('/') && !name.contains(':'), "nada de separadores");
        assert_ne!(scope_filename("bento.agents"), scope_filename("bento.agents.wt:/a/b"));
    }

    #[test]
    fn saving_and_loading_a_history_round_trips() {
        let dir = temp_dir("scrollback-roundtrip");
        let path = dir.join("h.json");
        save(&path, r#"["scrollback-a","scrollback-b"]"#, false).unwrap();
        assert_eq!(load(&path, &[]).unwrap(), r#"["scrollback-a","scrollback-b"]"#);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_missing_or_corrupt_file_loads_empty() {
        let dir = temp_dir("scrollback-corrupt");
        let path = dir.join("h.json");
        assert_eq!(load(&path, &[]).unwrap(), "[]");
        fs::write(&path, "not json").unwrap();
        assert_eq!(load(&path, &[]).unwrap(), "[]");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_broken_chat_history_falls_back_to_the_last_good_backup() {
        let dir = temp_dir("scrollback-backup");
        let path = dir.join("chat-history.json");
        save(&path, r#"[{"role":"user","content":"first"}]"#, true).unwrap();
        save(&path, r#"[{"role":"user","content":"second"}]"#, true).unwrap();
        fs::write(&path, "broken").unwrap();
        let loaded = load(&path, &[path.with_extension("json.bak")]).unwrap();
        assert!(loaded.contains("first"), "{loaded}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn malformed_content_never_reaches_disk() {
        assert!(check_json("not json", "agent history").is_err());
        assert!(check_json(r#"{"ok":true}"#, "agent history").is_ok());
    }
}
