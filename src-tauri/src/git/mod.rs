// Git worktree commands for the parallel tasks panel.
// Follows the same patterns as docker.rs: login-shell PATH resolution,
// spawn_blocking for all blocking I/O, input validation at trust boundaries.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

pub(crate) mod worktree;
pub(crate) mod branches;
pub(crate) mod status;
pub(crate) mod backup;
pub(crate) mod commit;
pub(crate) mod log;
pub(crate) mod pr;
pub(crate) mod sync;
pub(crate) mod rebase;
pub(crate) mod recommend;
pub(crate) mod edit;
#[cfg(test)]
pub(crate) mod test_support;

// macOS GUI apps don't inherit the shell PATH, so `git` may not be on PATH.
fn login_shell_output(cmd: &str) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = Command::new(shell).arg("-lc").arg(cmd).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

fn git_bin() -> Option<String> {
    let on_path = Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if on_path {
        return Some("git".into());
    }
    let path = login_shell_output("command -v git")?;
    let path = path.trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

fn git_output(repo: &str, args: &[&str]) -> Result<String, String> {
    let bin = git_bin().ok_or_else(|| "git not found".to_string())?;
    let out = Command::new(&bin)
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

// Accepts [A-Za-z0-9._/-], rejects `..` and spaces. Shared with the daemon and
// the CLI (`bento-review`): this used to be a second copy, so hardening it on
// one side left the other unprotected.
use bento_review::vcs::is_safe_branch;

fn is_git_repo(path: &str) -> bool {
    git_output(path, &["rev-parse", "--git-dir"]).is_ok()
}

fn current_branch(path: &str) -> Result<String, String> {
    let branch = git_output(path, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    if branch.is_empty() || branch == "HEAD" || !is_safe_branch(&branch) {
        return Err("cannot operate on detached HEAD".into());
    }
    Ok(branch)
}

fn resolve_commit_reference(repo: &str, reference: &str) -> Result<String, String> {
    if !is_safe_branch(reference) {
        return Err(format!("unsafe reference: {reference}"));
    }
    let resolve = |repo: &str, reference: &str| {
        let candidates = [
            format!("refs/heads/{reference}"),
            format!("refs/remotes/{reference}"),
            reference.to_string(),
        ];
        for candidate in candidates {
            if let Ok(value) = git_output(repo, &["rev-parse", "--verify", &format!("{candidate}^{{commit}}")]) {
                return Ok(value.trim().to_string());
            }
        }
        Err(format!("unknown reference: {reference}"))
    };

    if let Ok(commit) = resolve(repo, reference) {
        return Ok(commit);
    }

    let _ = git_output(repo, &["fetch", "--all", "--prune"]);
    if let Ok(commit) = resolve(repo, reference) {
        return Ok(commit);
    }

    Err(format!("unknown reference: {reference}"))
}

fn diff_between_refs(repo: &str, base: &str, target: &str) -> Result<String, String> {
    let base_commit = resolve_commit_reference(repo, base)?;
    let target_commit = resolve_commit_reference(repo, target)?;
    git_output(repo, &["diff", &format!("{base_commit}...{target_commit}")])
}

#[tauri::command]
pub async fn git_current_branch(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || current_branch(&path))
        .await
        .map_err(|e| e.to_string())?
}

// Resolves the real git directory for both regular repos and worktrees.
// In a worktree, `.git` is a FILE containing "gitdir: <real-path>"; we read it.
fn resolve_git_dir(path: &str) -> std::path::PathBuf {
    let git_path = Path::new(path).join(".git");
    if git_path.is_file() {
        if let Ok(content) = fs::read_to_string(&git_path) {
            if let Some(gitdir) = content.trim().strip_prefix("gitdir: ") {
                return std::path::PathBuf::from(gitdir.trim());
            }
        }
    }
    git_path
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;

    #[test]
    fn diff_between_refs_resolves_commit_ids_before_diffing() {
        let repo = repo("ref-diff");
        commit_file(&repo.0, "base\n", "base");
        run(&repo.0, &["branch", "origin/base"]);
        run(&repo.0, &["checkout", "-qb", "origin/feature"]);
        commit_file(&repo.0, "feature\n", "feature");

        let diff = diff_between_refs(repo.0.to_str().unwrap(), "origin/base", "origin/feature").unwrap();
        assert!(diff.contains("diff --git a/file.txt b/file.txt"), "{diff}");
        assert!(diff.contains("+feature"), "{diff}");
    }
}
