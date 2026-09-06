//! Qué comentarios de un PR das por resueltos. Al lado de los ficheros ya
//! revisados y por el mismo motivo: la marca es tuya —GitHub no tiene dónde
//! guardarla para un comentario suelto— pero tiene que seguirte de un cliente
//! a otro. Vivía en el `localStorage` del escritorio, así que la CLI y el
//! móvil no la veían, y la del escritorio se iba al limpiar el navegador.

use std::path::{Path, PathBuf};

use crate::store::{entry_path, read_list, store_dir, write_list};

const STORE: &str = "review-resolved";

fn resolved_path(dir: &Path, cwd: &str, pr: u64) -> PathBuf {
    entry_path(dir, cwd, &pr.to_string())
}

pub fn get_in(dir: &Path, cwd: &str, pr: u64) -> Vec<u64> {
    read_list(&resolved_path(dir, cwd, pr))
        .iter()
        .filter_map(|id| id.parse().ok())
        .collect()
}

pub fn set_in(dir: &Path, cwd: &str, pr: u64, ids: &[u64]) -> Result<(), String> {
    let values: Vec<String> = ids.iter().map(u64::to_string).collect();
    write_list(dir, &resolved_path(dir, cwd, pr), &values)
}

pub fn get(cwd: &str, pr: u64) -> Vec<u64> {
    store_dir(STORE).map(|dir| get_in(&dir, cwd, pr)).unwrap_or_default()
}

pub fn set(cwd: &str, pr: u64, ids: &[u64]) -> Result<(), String> {
    let dir = store_dir(STORE).ok_or_else(|| "no home dir".to_string())?;
    set_in(&dir, cwd, pr, ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bento-resolved-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn nothing_is_resolved_before_anything_is_marked() {
        assert!(get_in(&temp_dir("vacio"), "/repo", 291).is_empty());
    }

    #[test]
    fn what_was_marked_comes_back() {
        let dir = temp_dir("ida-y-vuelta");
        set_in(&dir, "/repo", 291, &[7, 9]).unwrap();
        assert_eq!(get_in(&dir, "/repo", 291), vec![7, 9]);
    }

    #[test]
    fn each_pr_of_each_project_is_kept_apart() {
        // Dos PRs del mismo repo numeran sus comentarios por su cuenta.
        let dir = temp_dir("separado");
        set_in(&dir, "/repo", 291, &[7]).unwrap();
        set_in(&dir, "/repo", 288, &[9]).unwrap();
        set_in(&dir, "/otro", 291, &[11]).unwrap();
        assert_eq!(get_in(&dir, "/repo", 291), vec![7]);
        assert_eq!(get_in(&dir, "/repo", 288), vec![9]);
        assert_eq!(get_in(&dir, "/otro", 291), vec![11]);
    }

    #[test]
    fn unmarking_the_last_one_forgets_the_pr() {
        let dir = temp_dir("olvido");
        set_in(&dir, "/repo", 291, &[7]).unwrap();
        set_in(&dir, "/repo", 291, &[]).unwrap();
        assert!(get_in(&dir, "/repo", 291).is_empty());
    }

    #[test]
    fn a_corrupt_file_reads_as_nothing_resolved() {
        let dir = temp_dir("corrupto");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(resolved_path(&dir, "/repo", 291), "{ roto").unwrap();
        assert!(get_in(&dir, "/repo", 291).is_empty());
    }
}
