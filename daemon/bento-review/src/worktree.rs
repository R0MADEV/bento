//! El worktree aislado en el que corre una review: crear uno para una rama,
//! espejar en él lo que hay sin commitear, dejarlo de solo lectura mientras el
//! agente mira, y soltarlo al terminar. Y el snapshot con el que se comprueba
//! que el repo no cambió por debajo mientras duraba.
//!
//! Compartido: hasta ahora solo lo tenía la app de escritorio, así que una
//! review desde el TUI o desde el móvil corría sobre el árbol de trabajo vivo.

use std::collections::{hash_map::DefaultHasher, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};


/// Un sufijo distinto por worktree: dos reviews de la misma rama a la vez no
/// pueden compartir carpeta. Nanosegundos + el id del proceso basta y evita
/// arrastrar `uuid` a esta crate.
fn unique_suffix() -> String {
    // El reloj no basta: dos llamadas seguidas pueden caer en el mismo
    // nanosegundo y acabar peleándose por la misma carpeta.
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{nanos:x}-{}-{n}", std::process::id())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewBranchContext {
    pub path: String,
    pub commit: String,
    pub latest_commit: String,
    pub managed: bool,
    pub stale: bool,
}

static BRANCH_CONTEXT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();


/// `git` en el repo indicado, con su stderr como error.
pub fn git_output(repo: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn valid_reference(reference: &str) -> bool {
    !reference.is_empty()
        && reference.len() <= 2_000
        && !reference.starts_with('-')
        && !reference.contains('\0')
        && !reference.contains("..")
}

fn resolve_commit(repo: &Path, reference: &str) -> Result<String, String> {
    if !valid_reference(reference) {
        return Err("invalid review reference".into());
    }
    git_output(
        repo,
        &["rev-parse", "--verify", &format!("{reference}^{{commit}}")],
    )
    .map(|value| value.trim().to_string())
}

fn common_git_dir(repo: &Path) -> Result<PathBuf, String> {
    let raw = git_output(repo, &["rev-parse", "--git-common-dir"])?;
    let path = PathBuf::from(raw.trim());
    let path = if path.is_absolute() {
        path
    } else {
        repo.join(path)
    };
    path.canonicalize().map_err(|error| error.to_string())
}

fn managed_context_path(repo: &Path, reference: &str) -> Result<PathBuf, String> {
    let mut hasher = DefaultHasher::new();
    common_git_dir(repo)?.hash(&mut hasher);
    reference.hash(&mut hasher);
    Ok(std::env::temp_dir().join(format!("bento-review-context-{:016x}-{}", hasher.finish(), unique_suffix())))
}

#[cfg(unix)]
pub fn set_review_worktree_writable(path: &Path, writable: bool) -> Result<(), String> {
    let mode = if writable { "u+w" } else { "a-w" };
    let status = Command::new("chmod")
        .args(["-R", mode])
        .arg(path)
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("chmod failed for {}", path.display())) }
}

#[cfg(not(unix))]
pub fn set_review_worktree_writable(_path: &Path, _writable: bool) -> Result<(), String> { Ok(()) }

pub fn is_managed_review_worktree(path: &Path) -> bool {
    path.parent() == Some(std::env::temp_dir().as_path())
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("bento-review-context-"))
}

pub fn normalize_review_path(relative: &str) -> Result<String, String> {
    if relative.starts_with('/') || relative.contains('\0') || relative.contains('\\') {
        return Err("finding path must be relative".into());
    }
    let mut parts = Vec::new();
    for segment in relative.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            if parts.pop().is_none() {
                return Err("finding path escapes repository".into());
            }
        } else {
            parts.push(segment);
        }
    }
    if parts.is_empty() {
        return Err("finding path must point to a file".into());
    }
    Ok(parts.join("/"))
}

pub fn validate_finding_path(repo_root: &Path, relative: &str, allowed_deleted: &HashSet<String>) -> Result<(), String> {
    let normalized = normalize_review_path(relative)?;
    let candidate = repo_root.join(&normalized);
    let root = repo_root.canonicalize().map_err(|e| e.to_string())?;
    if let Ok(resolved) = candidate.canonicalize() {
        if resolved.starts_with(&root) && resolved.is_file() {
            return Ok(());
        }
    }
    if allowed_deleted.contains(&normalized) {
        return Ok(());
    }
    Err("finding path must reference an existing file or deleted path".into())
}

fn remove_review_worktree_entry(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

fn copy_review_worktree_entry(source: &Path, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::copy(source, destination).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn sync_review_worktree_snapshot(source: &Path, destination: &Path) -> Result<(), String> {
    let output = Command::new("git")
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .current_dir(source)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let bytes = output.stdout;
    let mut index = 0;
    while index < bytes.len() {
        if index + 3 > bytes.len() || bytes[index + 2] != b' ' {
            return Err("unexpected review worktree status format".into());
        }
        let x = bytes[index];
        let y = bytes[index + 1];
        index += 3;

        let path_end = bytes[index..]
            .iter()
            .position(|byte| *byte == 0)
            .ok_or("unexpected review worktree status format")?
            + index;
        let source_path = String::from_utf8(bytes[index..path_end].to_vec()).map_err(|error| error.to_string())?;
        index = path_end + 1;

        let target_path = if x == b'R' || x == b'C' {
            let new_end = bytes[index..]
                .iter()
                .position(|byte| *byte == 0)
                .ok_or("unexpected review worktree status format")?
                + index;
            let new_path = String::from_utf8(bytes[index..new_end].to_vec()).map_err(|error| error.to_string())?;
            index = new_end + 1;
            if x == b'R' {
                let old_target = destination.join(&source_path);
                remove_review_worktree_entry(&old_target)?;
            }
            new_path
        } else {
            source_path
        };

        if x == b'D' || y == b'D' {
            remove_review_worktree_entry(&destination.join(&target_path))?;
            continue;
        }

        let source_entry = source.join(&target_path);
        let destination_entry = destination.join(&target_path);
        copy_review_worktree_entry(&source_entry, &destination_entry)?;
    }

    Ok(())
}

pub fn prepare_branch_context(
    repo_path: &str,
    reference: &str,
    pinned_commit: Option<&str>,
    fetch: bool,
) -> Result<ReviewBranchContext, String> {
    let repo = PathBuf::from(repo_path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !valid_reference(reference) {
        return Err("invalid review reference".into());
    }
    let _guard = BRANCH_CONTEXT_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "review branch context state poisoned")?;
    if fetch && !git_output(&repo, &["remote"])?.trim().is_empty() {
        git_output(&repo, &["fetch", "--all", "--prune"])?;
    }
    let latest_commit = resolve_commit(&repo, reference)?;
    let commit = match pinned_commit {
        Some(value) => resolve_commit(&repo, value)?,
        None => latest_commit.clone(),
    };
    let stale = commit != latest_commit;
    let path = managed_context_path(&repo, reference)?;
    let path_text = path.to_string_lossy().to_string();
    let _ = git_output(&repo, &["worktree", "prune"]);
    git_output(&repo, &["worktree", "add", "--detach", &path_text, &commit])?;
    sync_review_worktree_snapshot(&repo, &path)?;
    set_review_worktree_writable(&path, false)?;
    Ok(ReviewBranchContext {
        path: path_text,
        commit,
        latest_commit,
        managed: true,
        stale,
    })
}



pub fn release_managed_context_path(path: &Path) -> Result<(), String> {
    if !is_managed_review_worktree(path) {
        return Err("invalid managed review worktree path".into());
    }
    if !path.exists() {
        return Ok(());
    }
    let _guard = BRANCH_CONTEXT_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "review branch context state poisoned")?;
    if !path.exists() {
        return Ok(());
    }
    let common_dir = common_git_dir(path)?;
    let path_text = path.to_string_lossy().to_string();
    set_review_worktree_writable(path, true)?;
    let output = Command::new("git")
        .arg(format!("--git-dir={}", common_dir.to_string_lossy()))
        .args(["worktree", "remove", "--force", &path_text])
        .current_dir(std::env::temp_dir())
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::unique_suffix;
    use super::{
        prepare_branch_context, release_managed_context_path, validate_finding_path,
    };
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    
    fn git(repo: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn test_repo() -> PathBuf {
        let repo =
            std::env::temp_dir().join(format!("bento-review-branch-test-{}", unique_suffix()));
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Bento Test"]);
        git(&repo, &["config", "user.email", "bento@example.test"]);
        std::fs::write(repo.join("file.txt"), "one\n").unwrap();
        git(&repo, &["add", "file.txt"]);
        git(&repo, &["commit", "-m", "initial"]);
        repo
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        let repo = test_repo();
        let allowed_deleted = HashSet::new();
        assert!(validate_finding_path(&repo, "../secret", &allowed_deleted).is_err());
        assert!(validate_finding_path(&repo, "/secret", &allowed_deleted).is_err());
        assert!(validate_finding_path(&repo, "", &allowed_deleted).is_err());
        assert!(validate_finding_path(&repo, ".", &allowed_deleted).is_err());
        assert!(validate_finding_path(&repo, "src/no-existe.ts", &allowed_deleted).is_err());
        std::fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn accepts_existing_files_only() {
        let repo = test_repo();
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::write(repo.join("src").join("file.ts"), "ok").unwrap();
        let allowed_deleted = HashSet::new();
        assert!(validate_finding_path(&repo, "src/file.ts", &allowed_deleted).is_ok());
        assert!(validate_finding_path(&repo, "src", &allowed_deleted).is_err());
        std::fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn accepts_deleted_files_when_allowed() {
        let repo = test_repo();
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::write(repo.join("src").join("deleted.ts"), "gone").unwrap();
        std::fs::remove_file(repo.join("src").join("deleted.ts")).unwrap();
        let allowed_deleted = HashSet::from(["src/deleted.ts".to_string()]);
        assert!(validate_finding_path(&repo, "src/deleted.ts", &allowed_deleted).is_ok());
        assert!(validate_finding_path(&repo, "src/fake.ts", &allowed_deleted).is_err());
        std::fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn creates_unique_worktrees_for_the_same_branch() {
        let repo = test_repo();
        let first = prepare_branch_context(repo.to_str().unwrap(), "main", None, false).unwrap();
        let second = prepare_branch_context(repo.to_str().unwrap(), "main", None, false).unwrap();

        assert!(first.managed);
        assert!(second.managed);
        assert_ne!(first.path, second.path);
        assert!(Path::new(&first.path).exists());
        assert!(Path::new(&second.path).exists());
        assert_eq!(first.commit, git(&repo, &["rev-parse", "HEAD"]));
        release_managed_context_path(Path::new(&first.path)).unwrap();
        release_managed_context_path(Path::new(&second.path)).unwrap();
        std::fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn keeps_a_detached_branch_context_pinned_until_it_is_updated() {
        let repo = test_repo();
        let first_commit = git(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["branch", "origin-review"]);
        let first =
            prepare_branch_context(repo.to_str().unwrap(), "origin-review", None, false).unwrap();
        assert!(first.managed);
        assert_eq!(
            git(Path::new(&first.path), &["rev-parse", "HEAD"]),
            first_commit
        );

        std::fs::write(repo.join("file.txt"), "two\n").unwrap();
        git(&repo, &["add", "file.txt"]);
        git(&repo, &["commit", "-m", "new remote commit"]);
        let latest_commit = git(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["branch", "-f", "origin-review", &latest_commit]);

        let pinned = prepare_branch_context(
            repo.to_str().unwrap(),
            "origin-review",
            Some(&first_commit),
            false,
        )
        .unwrap();
        assert!(pinned.stale);
        assert_eq!(pinned.latest_commit, latest_commit);
        assert_eq!(
            git(Path::new(&pinned.path), &["rev-parse", "HEAD"]),
            first_commit
        );

        let updated =
            prepare_branch_context(repo.to_str().unwrap(), "origin-review", None, false).unwrap();
        assert_eq!(
            git(Path::new(&updated.path), &["rev-parse", "HEAD"]),
            latest_commit
        );
        release_managed_context_path(Path::new(&first.path)).unwrap();
        release_managed_context_path(Path::new(&pinned.path)).unwrap();
        release_managed_context_path(Path::new(&updated.path)).unwrap();
        assert!(!Path::new(&updated.path).exists());
        assert!(release_managed_context_path(&repo).is_err());
        std::fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn fetches_remote_updates_without_moving_the_pinned_context() {
        let root = std::env::temp_dir().join(format!("bento-review-fetch-test-{}", unique_suffix()));
        let remote = root.join("origin.git");
        let developer = root.join("developer");
        let reviewer = root.join("reviewer");
        std::fs::create_dir_all(&remote).unwrap();
        git(&remote, &["init", "--bare"]);
        std::fs::create_dir_all(&developer).unwrap();
        git(&developer, &["init", "-b", "main"]);
        git(&developer, &["config", "user.name", "Bento Test"]);
        git(&developer, &["config", "user.email", "bento@example.test"]);
        std::fs::write(developer.join("file.txt"), "one\n").unwrap();
        git(&developer, &["add", "file.txt"]);
        git(&developer, &["commit", "-m", "initial"]);
        git(
            &developer,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&developer, &["push", "-u", "origin", "main"]);
        git(&developer, &["branch", "review"]);
        git(&developer, &["push", "origin", "review"]);
        git(
            &root,
            &[
                "clone",
                remote.to_str().unwrap(),
                reviewer.to_str().unwrap(),
            ],
        );

        let first =
            prepare_branch_context(reviewer.to_str().unwrap(), "origin/review", None, false)
                .unwrap();
        git(&developer, &["checkout", "review"]);
        std::fs::write(developer.join("file.txt"), "two\n").unwrap();
        git(&developer, &["add", "file.txt"]);
        git(&developer, &["commit", "-m", "review update"]);
        git(&developer, &["push", "origin", "review"]);

        let checked = prepare_branch_context(
            reviewer.to_str().unwrap(),
            "origin/review",
            Some(&first.commit),
            true,
        )
        .unwrap();
        assert!(checked.stale);
        assert_ne!(checked.latest_commit, first.commit);
        assert_eq!(
            git(Path::new(&checked.path), &["rev-parse", "HEAD"]),
            first.commit
        );

        release_managed_context_path(Path::new(&first.path)).unwrap();
        release_managed_context_path(Path::new(&checked.path)).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mirrors_local_uncommitted_changes_into_the_review_worktree() {
        let repo = test_repo();
        std::fs::write(repo.join("file.txt"), "updated\n").unwrap();
        std::fs::write(repo.join("new.txt"), "untracked\n").unwrap();
        std::fs::write(repo.join("removed.txt"), "gone\n").unwrap();
        git(&repo, &["add", "removed.txt"]);
        git(&repo, &["commit", "-m", "add removed target"]);
        std::fs::remove_file(repo.join("removed.txt")).unwrap();

        let context = prepare_branch_context(repo.to_str().unwrap(), "main", None, false).unwrap();
        assert_eq!(std::fs::read_to_string(Path::new(&context.path).join("file.txt")).unwrap(), "updated\n");
        assert_eq!(std::fs::read_to_string(Path::new(&context.path).join("new.txt")).unwrap(), "untracked\n");
        assert!(!Path::new(&context.path).join("removed.txt").exists());
        release_managed_context_path(Path::new(&context.path)).unwrap();
        std::fs::remove_dir_all(repo).unwrap();
    }
}
