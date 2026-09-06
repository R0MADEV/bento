//! Where per-project state is filed on disk. One naming scheme for every
//! store under `~/.bento`, so a project+ref pair always lands on the same
//! file no matter who writes it.

use std::path::PathBuf;

/// Stable FNV-1a 64-bit — no extra dependency for what is just a filename.
pub fn fnv1a(s: &str) -> String {
    let mut h: u64 = 14695981039346656037;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    format!("{:016x}", h)
}

/// `~/.bento/<name>`, the directory a store lives in.
pub fn store_dir(name: &str) -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".bento").join(name))
}

/// The file holding the state for `(cwd, reference)` inside `dir`.
pub fn entry_path(dir: &std::path::Path, cwd: &str, reference: &str) -> PathBuf {
    dir.join(format!("{}.json", fnv1a(&format!("{cwd}:{reference}"))))
}

/// Una lista guardada por proyecto y referencia. Lo que sea ilegible o esté
/// corrupto se lee como lista vacía: el coste de equivocarse es volver a
/// marcar, y un fichero roto no puede tumbar el panel.
pub fn read_list(path: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

/// La reemplaza. Una lista vacía borra el fichero en vez de dejar un huérfano.
pub fn write_list(dir: &std::path::Path, path: &std::path::Path, values: &[String]) -> Result<(), String> {
    if values.is_empty() {
        return match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string(values).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}
