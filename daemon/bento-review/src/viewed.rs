//! Which files you have already reviewed, per project and ref. Kept on disk
//! next to the checkpoints so the mark survives a refresh, a restart, and the
//! client you happened to use.

use std::path::{Path, PathBuf};

use crate::store::{entry_path, read_list, store_dir, write_list};

const STORE: &str = "review-viewed";

pub fn viewed_path(dir: &Path, cwd: &str, reference: &str) -> PathBuf {
    entry_path(dir, cwd, reference)
}

/// The files marked as reviewed. Anything unreadable or corrupt reads as
/// "nothing reviewed" — the cost of being wrong is re-reading a diff.
pub fn get_in(dir: &Path, cwd: &str, reference: &str) -> Vec<String> {
    read_list(&viewed_path(dir, cwd, reference))
}

/// Replaces the list for this ref. An empty list removes the file instead of
/// leaving an orphan behind.
pub fn set_in(dir: &Path, cwd: &str, reference: &str, paths: &[String]) -> Result<(), String> {
    write_list(dir, &viewed_path(dir, cwd, reference), paths)
}

pub fn get(cwd: &str, reference: &str) -> Vec<String> {
    store_dir(STORE).map(|dir| get_in(&dir, cwd, reference)).unwrap_or_default()
}

pub fn set(cwd: &str, reference: &str, paths: &[String]) -> Result<(), String> {
    let dir = store_dir(STORE).ok_or_else(|| "no home dir".to_string())?;
    set_in(&dir, cwd, reference, paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bento-viewed-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn nothing_is_reviewed_before_anything_is_saved() {
        assert!(get_in(&temp_dir("vacio"), "/repo", "main").is_empty());
    }

    #[test]
    fn what_was_marked_comes_back() {
        let dir = temp_dir("ida-y-vuelta");
        set_in(&dir, "/repo", "main", &["src/a.rs".to_string(), "src/b.rs".to_string()]).unwrap();
        assert_eq!(get_in(&dir, "/repo", "main"), vec!["src/a.rs", "src/b.rs"]);
    }

    #[test]
    fn each_project_and_ref_is_kept_apart() {
        let dir = temp_dir("separado");
        set_in(&dir, "/repo", "main", &["a".to_string()]).unwrap();
        set_in(&dir, "/repo", "feat/x", &["b".to_string()]).unwrap();
        set_in(&dir, "/otro", "main", &["c".to_string()]).unwrap();
        assert_eq!(get_in(&dir, "/repo", "main"), vec!["a"]);
        assert_eq!(get_in(&dir, "/repo", "feat/x"), vec!["b"]);
        assert_eq!(get_in(&dir, "/otro", "main"), vec!["c"]);
    }

    #[test]
    fn saving_an_empty_list_forgets_the_ref() {
        // Desmarcar el último archivo no debe dejar un fichero huérfano.
        let dir = temp_dir("olvido");
        set_in(&dir, "/repo", "main", &["a".to_string()]).unwrap();
        set_in(&dir, "/repo", "main", &[]).unwrap();
        assert!(get_in(&dir, "/repo", "main").is_empty());
        assert!(!viewed_path(&dir, "/repo", "main").exists());
    }

    #[test]
    fn a_corrupt_file_reads_as_nothing_reviewed() {
        // Un fichero roto no puede tumbar el panel: peor caso, se re-revisa.
        let dir = temp_dir("corrupto");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(viewed_path(&dir, "/repo", "main"), "{ esto no es json").unwrap();
        assert!(get_in(&dir, "/repo", "main").is_empty());
    }
}
