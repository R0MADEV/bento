use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use tokio::process::Command as AsyncCommand;
use uuid::Uuid;

static ACTIVE_REVIEWS: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();

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

#[tauri::command]
pub async fn review_worktree_create(
    repo_path: String,
    review_id: String,
    reference: Option<String>,
    include_working_tree: bool,
) -> Result<String, String> {
    let id = Uuid::parse_str(&review_id).map_err(|_| "invalid review id")?;
    tokio::task::spawn_blocking(move || {
        let repo = PathBuf::from(repo_path)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let root = git_output(&repo, &["rev-parse", "--show-toplevel"])?
            .trim()
            .to_string();
        let root = PathBuf::from(root)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let active = ACTIVE_REVIEWS.get_or_init(|| Mutex::new(std::collections::HashSet::new()));
        {
            let mut reviews = active.lock().map_err(|_| "review state poisoned")?;
            let root_key = root.to_string_lossy().to_string();
            if !reviews.insert(root_key) {
                return Err("a review is already active for this repository".into());
            }
        }
        let worktree = std::env::temp_dir().join(format!("bento-review-{id}"));
        if worktree.exists() {
            remove_active(&root);
            return Err("review worktree already exists".into());
        }
        let worktree_text = worktree.to_string_lossy().to_string();
        let reference = reference.unwrap_or_else(|| "HEAD".to_string());
        if reference.starts_with('-') {
            remove_active(&root);
            return Err("invalid git reference".into());
        }
        if let Err(error) = git_output(
            &root,
            &["rev-parse", "--verify", &format!("{reference}^{{commit}}")],
        ) {
            remove_active(&root);
            return Err(error);
        }
        if let Err(error) = git_output(
            &root,
            &["worktree", "add", "--detach", &worktree_text, &reference],
        ) {
            remove_active(&root);
            return Err(error);
        }
        if include_working_tree {
            if let Err(error) = populate(&root, &worktree) {
                let _ = Command::new("git")
                    .args(["worktree", "remove", "--force", &worktree_text])
                    .current_dir(&root)
                    .status();
                remove_active(&root);
                return Err(error);
            }
        }
        #[cfg(unix)]
        if let Err(error) = Command::new("chmod")
            .args(["-R", "a-w", &worktree_text])
            .status()
            .map_err(|e| e.to_string())
        {
            let _ = Command::new("git")
                .args(["worktree", "remove", "--force", &worktree_text])
                .current_dir(&root)
                .status();
            remove_active(&root);
            return Err(error);
        }
        Ok(worktree_text)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn populate(repo: &Path, worktree: &Path) -> Result<(), String> {
    let patch = git_output(repo, &["diff", "HEAD", "--binary"])?;
    if !patch.is_empty() {
        let mut child = Command::new("git")
            .args(["apply", "--no-index", "-"])
            .current_dir(worktree)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            stdin
                .write_all(patch.as_bytes())
                .map_err(|e| e.to_string())?;
        }
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
    }
    let untracked = git_output(repo, &["ls-files", "--others", "--exclude-standard"])?;
    for file in untracked.lines().filter(|line| !line.is_empty()) {
        let source = repo.join(file);
        let target = worktree.join(file);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?
        }
        fs::copy(source, target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn review_worktree_remove(repo_path: String, worktree: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let repo = PathBuf::from(repo_path)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let path = PathBuf::from(&worktree);
        let valid_name = path.parent() == Some(std::env::temp_dir().as_path())
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("bento-review-"));
        if !valid_name {
            return Err("invalid review worktree path".into());
        }
        if !path.exists() {
            remove_active(&repo);
            return Ok(());
        }
        #[cfg(unix)]
        {
            let _ = Command::new("chmod")
                .args(["-R", "u+w", &worktree])
                .status();
        }
        let output = Command::new("git")
            .args(["worktree", "remove", "--force", &worktree])
            .current_dir(&repo)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        remove_active(&repo);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn remove_active(repo: &Path) {
    if let Some(active) = ACTIVE_REVIEWS.get() {
        if let Ok(mut reviews) = active.lock() {
            reviews.remove(&repo.to_string_lossy().to_string());
        }
    }
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
    use super::validate_finding_path;
    use std::path::Path;

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        assert!(validate_finding_path(Path::new("/tmp/repo"), "../secret").is_err());
        assert!(validate_finding_path(Path::new("/tmp/repo"), "/secret").is_err());
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
