//! A fingerprint of the repository's working state.
//!
//! Taken before and after a review: if it changed, the findings point at line
//! numbers that have since moved, and saying so is the difference between a
//! stale report and a wrong one. Lives here rather than in the desktop app so
//! the CLI and the phone client can warn about it too.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use crate::worktree::git_output;

/// Hashes the working tree: the diff against HEAD, the porcelain status, the
/// tracked file list, and the contents of untracked files — which no git
/// command reports, and which a review can very much be about.
pub fn snapshot(repo_path: &str) -> Result<String, String> {
    let repo: PathBuf = Path::new(repo_path).canonicalize().map_err(|e| e.to_string())?;
    let mut input = git_output(&repo, &["diff", "HEAD", "--binary"])?;
    input.push_str(&git_output(&repo, &["status", "--porcelain"])?);
    input.push_str(&git_output(&repo, &["ls-files"])?);
    let untracked = git_output(&repo, &["ls-files", "--others", "--exclude-standard"])?;
    for file in untracked.lines().filter(|line| !line.is_empty()) {
        input.push_str(file);
        input.push_str(&std::fs::read_to_string(repo.join(file)).unwrap_or_default());
    }
    let mut hasher = DefaultHasher::new();
    input.hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| {
            Command::new("git").args(args).current_dir(dir.path()).output().unwrap();
        };
        run(&["init"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(dir.path().join("uno.txt"), "hola").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "uno"]);
        dir
    }

    #[test]
    fn an_untouched_repository_hashes_the_same_twice() {
        let dir = repo();
        let path = dir.path().to_str().unwrap();
        assert_eq!(snapshot(path).unwrap(), snapshot(path).unwrap());
    }

    #[test]
    fn editing_a_tracked_file_changes_the_hash() {
        let dir = repo();
        let path = dir.path().to_str().unwrap();
        let before = snapshot(path).unwrap();

        std::fs::write(dir.path().join("uno.txt"), "adios").unwrap();

        assert_ne!(snapshot(path).unwrap(), before);
    }

    #[test]
    fn a_new_untracked_file_changes_the_hash_too() {
        // git status alone would notice the name; the contents are hashed as
        // well, because a review can be about a file that was never added.
        let dir = repo();
        let path = dir.path().to_str().unwrap();
        let before = snapshot(path).unwrap();

        std::fs::write(dir.path().join("dos.txt"), "nuevo").unwrap();

        assert_ne!(snapshot(path).unwrap(), before);
    }

    #[test]
    fn editing_an_untracked_file_changes_the_hash() {
        let dir = repo();
        let path = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("dos.txt"), "uno").unwrap();
        let before = snapshot(path).unwrap();

        std::fs::write(dir.path().join("dos.txt"), "dos").unwrap();

        assert_ne!(snapshot(path).unwrap(), before);
    }

    #[test]
    fn a_path_that_is_not_a_repository_reports_an_error() {
        assert!(snapshot("/no/existe/en/absoluto").is_err());
    }
}
