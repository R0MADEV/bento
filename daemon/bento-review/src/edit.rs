//! Editar el worktree: resolver un conflicto, stagear ficheros, leer y escribir
//! un fichero y resetear HEAD. Sin UI: lo usan el panel, el daemon y el CLI.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::backup::create_history_backup;
use crate::vcs::{git_bin, git_cmd};

/// La ruta llega del cliente: solo vale una relativa que exista y que, ya
/// resuelta (symlinks incluidos), siga dentro del worktree.
pub fn existing_worktree_file(worktree: &str, relative: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute() {
        return Err("file path must be relative to the worktree".into());
    }

    let root = fs::canonicalize(worktree).map_err(|error| error.to_string())?;
    let candidate =
        fs::canonicalize(root.join(relative_path)).map_err(|error| error.to_string())?;
    if !candidate.starts_with(&root) {
        return Err("file path escapes the worktree".into());
    }
    Ok(candidate)
}

/// Resuelve un conflicto de rebase quedándose con un lado y stageando el
/// resultado. `side` es "ours" o "theirs".
pub fn resolve_conflict(cwd: &str, file: &str, side: &str) -> Result<(), String> {
    let flag = if side == "theirs" { "--theirs" } else { "--ours" };
    git_cmd(cwd, &["checkout", flag, "--", file])?;
    git_cmd(cwd, &["add", "--", file])?;
    Ok(())
}

/// Stagea ficheros concretos (lo que se usa tras resolver conflictos a mano).
pub fn add_files(cwd: &str, files: &[String]) -> Result<(), String> {
    // Se validan con la ruta canónica, pero a git se le pasan las relativas
    // originales: las absolutas canónicas las rechaza cuando al worktree se
    // llegó por un symlink (en macOS /var -> /private/var), aunque el fichero
    // esté dentro.
    for file in files {
        existing_worktree_file(cwd, file)?;
    }
    let bin = git_bin()?;
    for attempt in 0..=30 {
        let mut cmd = Command::new(&bin);
        cmd.arg("-C").arg(cwd).arg("add").arg("--");
        for file in files {
            cmd.arg(file);
        }
        let out = cmd.output().map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(());
        }
        let error = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let index_is_busy = error.contains("index.lock") && error.contains("File exists");
        if !index_is_busy || attempt == 30 {
            return Err(error);
        }
        // Un status o un rebase pueden tener el índice compartido un instante.
        // Nunca borrar su lock: esperar al dueño y reintentar solo este error
        // pasajero.
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    unreachable!()
}

pub fn read_file(cwd: &str, file: &str) -> Result<String, String> {
    let safe_path = existing_worktree_file(cwd, file)?;
    fs::read_to_string(safe_path).map_err(|e| e.to_string())
}

pub fn write_file(cwd: &str, file: &str, content: &str) -> Result<(), String> {
    let safe_path = existing_worktree_file(cwd, file)?;
    fs::write(safe_path, content).map_err(|e| e.to_string())
}

/// Resetea HEAD a `target` (por ejemplo "origin/main"). `mode` es "soft",
/// "mixed" (por defecto) o "hard"; antes se guarda un respaldo del historial.
pub fn reset(cwd: &str, target: &str, mode: Option<&str>) -> Result<(), String> {
    create_history_backup(cwd)?;
    let flag = match mode.unwrap_or("mixed") {
        "soft" => "--soft",
        "hard" => "--hard",
        _ => "--mixed",
    };
    git_cmd(cwd, &["reset", flag, target]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::*;

    fn fixture() -> (PathBuf, PathBuf) {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("bento-safe-path-{}-{nonce}", std::process::id()));
        let outside = root.with_extension("outside");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("inside.txt"), "inside").unwrap();
        fs::write(&outside, "outside").unwrap();
        (root, outside)
    }

    #[test]
    fn accepts_an_existing_file_inside_the_worktree() {
        let (root, outside) = fixture();
        let resolved = existing_worktree_file(root.to_str().unwrap(), "inside.txt").unwrap();
        assert_eq!(resolved, fs::canonicalize(root.join("inside.txt")).unwrap());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(outside);
    }

    #[test]
    fn rejects_parent_traversal_and_absolute_paths() {
        let (root, outside) = fixture();
        let parent_escape = format!("../{}", outside.file_name().unwrap().to_string_lossy());
        assert!(existing_worktree_file(root.to_str().unwrap(), &parent_escape).is_err());
        assert!(existing_worktree_file(root.to_str().unwrap(), outside.to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(outside);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_that_points_outside_the_worktree() {
        use std::os::unix::fs::symlink;

        let (root, outside) = fixture();
        symlink(&outside, root.join("link.txt")).unwrap();
        assert!(existing_worktree_file(root.to_str().unwrap(), "link.txt").is_err());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(outside);
    }

    #[test]
    fn stages_validated_relative_worktree_files() {
        let repo = repo("add-files");
        fs::write(repo.0.join("file.txt"), "resolved\n").unwrap();
        add_files(repo.0.to_str().unwrap(), &["file.txt".into()]).unwrap();
        assert_eq!(
            run(&repo.0, &["diff", "--cached", "--name-only"]).trim(),
            "file.txt"
        );
    }

    #[test]
    fn waits_for_a_transient_git_index_lock_before_staging() {
        let repo = repo("add-files-lock");
        fs::write(repo.0.join("file.txt"), "resolved\n").unwrap();
        let lock = repo.0.join(".git/index.lock");
        fs::write(&lock, "busy").unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            fs::remove_file(lock).unwrap();
        });

        add_files(repo.0.to_str().unwrap(), &["file.txt".into()]).unwrap();
        release.join().unwrap();
        assert_eq!(
            run(&repo.0, &["diff", "--cached", "--name-only"]).trim(),
            "file.txt"
        );
    }

    #[test]
    fn writing_a_file_outside_the_worktree_is_refused() {
        let repo = repo("write-escape");
        assert!(write_file(repo.0.to_str().unwrap(), "../escaped.txt", "nope").is_err());
    }

    #[test]
    fn resolving_a_conflict_keeps_the_chosen_side_and_stages_it() {
        let repo = repo("resolve");
        commit_file(&repo.0, "base\n", "base");
        run(&repo.0, &["checkout", "-qb", "other"]);
        commit_file(&repo.0, "theirs\n", "theirs");
        run(&repo.0, &["checkout", "-q", "-"]);
        commit_file(&repo.0, "ours\n", "ours");
        let merge = Command::new("git")
            .arg("-C")
            .arg(&repo.0)
            .args(["merge", "other"])
            .output()
            .unwrap();
        assert!(!merge.status.success(), "the merge should have conflicted");

        resolve_conflict(repo.0.to_str().unwrap(), "file.txt", "theirs").unwrap();
        assert_eq!(
            fs::read_to_string(repo.0.join("file.txt")).unwrap(),
            "theirs\n"
        );
        assert_eq!(
            run(&repo.0, &["diff", "--cached", "--name-only"]).trim(),
            "file.txt"
        );
    }
}
