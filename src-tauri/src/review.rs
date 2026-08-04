use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use tokio::process::Command as AsyncCommand;
static BRANCH_CONTEXT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewBranchContext {
    path: String,
    commit: String,
    latest_commit: String,
    managed: bool,
    stale: bool,
}

fn git_output(repo: &Path, args: &[&str]) -> Result<String, String> {
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

fn worktree_for_local_branch(repo: &Path, reference: &str, commit: &str) -> Option<PathBuf> {
    let expected_branch = format!("refs/heads/{reference}");
    let raw = git_output(repo, &["worktree", "list", "--porcelain"]).ok()?;
    raw.split("\n\n").find_map(|record| {
        let mut path = None;
        let mut head = None;
        let mut branch = None;
        for line in record.lines() {
            if let Some(value) = line.strip_prefix("worktree ") {
                path = Some(PathBuf::from(value));
            } else if let Some(value) = line.strip_prefix("HEAD ") {
                head = Some(value);
            } else if let Some(value) = line.strip_prefix("branch ") {
                branch = Some(value);
            }
        }
        (head == Some(commit) && branch == Some(expected_branch.as_str()))
            .then_some(path)
            .flatten()
    })
}

fn managed_context_path(repo: &Path, reference: &str) -> Result<PathBuf, String> {
    let mut hasher = DefaultHasher::new();
    common_git_dir(repo)?.hash(&mut hasher);
    reference.hash(&mut hasher);
    Ok(std::env::temp_dir().join(format!("bento-review-context-{:016x}", hasher.finish())))
}

#[cfg(unix)]
fn set_managed_writable(path: &Path, writable: bool) {
    let mode = if writable { "u+w" } else { "a-w" };
    let _ = Command::new("chmod").args(["-R", mode]).arg(path).status();
}

#[cfg(not(unix))]
fn set_managed_writable(_path: &Path, _writable: bool) {}

fn prepare_branch_context(
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

    if let Some(path) = worktree_for_local_branch(&repo, reference, &commit) {
        return Ok(ReviewBranchContext {
            path: path.to_string_lossy().to_string(),
            commit,
            latest_commit,
            managed: false,
            stale,
        });
    }

    let path = managed_context_path(&repo, reference)?;
    let path_text = path.to_string_lossy().to_string();
    if path.exists() {
        let existing_commit = git_output(&path, &["rev-parse", "HEAD"])
            .map(|value| value.trim().to_string())
            .map_err(|_| "managed review worktree is invalid")?;
        if existing_commit != commit {
            set_managed_writable(&path, true);
            let result = git_output(&path, &["checkout", "--detach", &commit]);
            set_managed_writable(&path, false);
            result?;
        }
    } else {
        let _ = git_output(&repo, &["worktree", "prune"]);
        git_output(&repo, &["worktree", "add", "--detach", &path_text, &commit])?;
        set_managed_writable(&path, false);
    }
    Ok(ReviewBranchContext {
        path: path_text,
        commit,
        latest_commit,
        managed: true,
        stale,
    })
}

#[tauri::command]
pub async fn review_branch_context_prepare(
    repo_path: String,
    reference: String,
    commit: Option<String>,
) -> Result<ReviewBranchContext, String> {
    tokio::task::spawn_blocking(move || {
        prepare_branch_context(&repo_path, &reference, commit.as_deref(), false)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn review_branch_context_update(
    repo_path: String,
    reference: String,
) -> Result<ReviewBranchContext, String> {
    tokio::task::spawn_blocking(move || prepare_branch_context(&repo_path, &reference, None, false))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn review_branch_context_check(
    repo_path: String,
    reference: String,
    commit: String,
) -> Result<ReviewBranchContext, String> {
    tokio::task::spawn_blocking(move || {
        prepare_branch_context(&repo_path, &reference, Some(&commit), true)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn review_branch_context_release(
    repo_path: String,
    reference: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || release_branch_context(&repo_path, &reference))
        .await
        .map_err(|error| error.to_string())?
}

fn release_branch_context(repo_path: &str, reference: &str) -> Result<(), String> {
    let repo = PathBuf::from(repo_path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let _guard = BRANCH_CONTEXT_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "review branch context state poisoned")?;
    let path = managed_context_path(&repo, reference)?;
    if !path.exists() {
        let _ = git_output(&repo, &["worktree", "prune"]);
        return Ok(());
    }
    let path_text = path.to_string_lossy().to_string();
    set_managed_writable(&path, true);
    git_output(&repo, &["worktree", "remove", "--force", &path_text])?;
    Ok(())
}

pub(crate) fn release_managed_context_path(path: &Path) -> Result<(), String> {
    let valid_path = path.parent() == Some(std::env::temp_dir().as_path())
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("bento-review-context-"));
    if !valid_path {
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
    set_managed_writable(path, true);
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

#[tauri::command]
pub async fn review_validate_finding_path(
    repo_path: String,
    relative: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        validate_finding_path(
            &PathBuf::from(repo_path)
                .canonicalize()
                .map_err(|e| e.to_string())?,
            &relative,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

fn validate_finding_path(repo_root: &Path, relative: &str) -> Result<(), String> {
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
    let candidate = repo_root.join(parts.join("/"));
    if candidate.exists() {
        let root = repo_root.canonicalize().map_err(|e| e.to_string())?;
        let resolved = candidate.canonicalize().map_err(|e| e.to_string())?;
        if !resolved.starts_with(root) {
            return Err("finding path escapes repository".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        prepare_branch_context, release_branch_context, release_managed_context_path,
        validate_finding_path,
    };
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use uuid::Uuid;

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
            std::env::temp_dir().join(format!("bento-review-branch-test-{}", Uuid::new_v4()));
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
        assert!(validate_finding_path(Path::new("/tmp/repo"), "../secret").is_err());
        assert!(validate_finding_path(Path::new("/tmp/repo"), "/secret").is_err());
    }

    #[test]
    fn reuses_an_existing_worktree_for_the_selected_local_branch() {
        let repo = test_repo();
        let context = prepare_branch_context(repo.to_str().unwrap(), "main", None, false).unwrap();

        assert!(!context.managed);
        assert_eq!(
            PathBuf::from(context.path).canonicalize().unwrap(),
            repo.canonicalize().unwrap()
        );
        assert_eq!(context.commit, git(&repo, &["rev-parse", "HEAD"]));
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
        release_managed_context_path(Path::new(&updated.path)).unwrap();
        assert!(!Path::new(&updated.path).exists());
        assert!(release_managed_context_path(&repo).is_err());
        std::fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn fetches_remote_updates_without_moving_the_pinned_context() {
        let root = std::env::temp_dir().join(format!("bento-review-fetch-test-{}", Uuid::new_v4()));
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

        release_branch_context(reviewer.to_str().unwrap(), "origin/review").unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tauri::command]
pub async fn review_lexis_context(path: String, question: String) -> Result<String, String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        AsyncCommand::new("lexis")
            .args([
                "ask", "--path", &path, "--lang", "en", "--depth", "2", "--topk", "5", &question,
            ])
            .output(),
    )
    .await
    .map_err(|_| "lexis context timeout".to_string())?
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Ok(String::new());
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(text.chars().take(12_000).collect())
}

#[tauri::command]
pub async fn review_snapshot(repo_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let repo = PathBuf::from(repo_path)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let mut input = git_output(&repo, &["diff", "HEAD", "--binary"])?;
        input.push_str(&git_output(&repo, &["status", "--porcelain"])?);
        input.push_str(&git_output(&repo, &["ls-files"])?);
        let untracked = git_output(&repo, &["ls-files", "--others", "--exclude-standard"])?;
        for file in untracked.lines().filter(|line| !line.is_empty()) {
            input.push_str(file);
            input.push_str(&fs::read_to_string(repo.join(file)).unwrap_or_default());
        }
        let mut hasher = DefaultHasher::new();
        input.hash(&mut hasher);
        Ok(format!("{:016x}", hasher.finish()))
    })
    .await
    .map_err(|e| e.to_string())?
}
