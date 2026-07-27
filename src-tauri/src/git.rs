// Git worktree commands for the parallel tasks panel.
// Follows the same patterns as docker.rs: login-shell PATH resolution,
// spawn_blocking for all blocking I/O, input validation at trust boundaries.

use std::path::Path;
use std::process::Command;

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
    if path.is_empty() { None } else { Some(path) }
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

// Accepts [A-Za-z0-9._/-], rejects `..` and spaces.
fn is_safe_branch(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
}

fn is_git_repo(path: &str) -> bool {
    git_output(path, &["rev-parse", "--git-dir"]).is_ok()
}

#[tauri::command]
pub async fn git_worktree_list(repo: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Prune stale worktree refs (folders deleted manually without `git worktree remove`).
        let _ = git_output(&repo, &["worktree", "prune"]);
        git_output(&repo, &["worktree", "list", "--porcelain"])
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_output(&path, &["status", "--porcelain"])
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_default_branch(repo: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Try origin/HEAD first.
        if let Ok(out) = git_output(&repo, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
            let branch = out.trim().trim_start_matches("origin/").to_string();
            if !branch.is_empty() {
                return Ok(branch);
            }
        }
        // Fall back to checking for `main`, then `master`.
        if git_output(&repo, &["rev-parse", "--verify", "main"]).is_ok() {
            return Ok("main".into());
        }
        Ok("master".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_worktree_add(
    repo: String,
    path: String,
    branch: String,
    base: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_git_repo(&repo) {
            return Err("not a git repository".into());
        }
        if !is_safe_branch(&branch) {
            return Err(format!("unsafe branch name: {branch}"));
        }
        if !is_safe_branch(&base) {
            return Err(format!("unsafe base branch: {base}"));
        }
        if Path::new(&path).exists() {
            return Err(format!("path already exists: {path}"));
        }
        git_output(&repo, &["worktree", "add", &path, "-b", &branch, &base])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_worktree_remove(repo: String, path: String, force: bool, branch: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bin = git_bin().ok_or_else(|| "git not found".to_string())?;

        let try_remove = |extra_force: bool| -> Result<(), String> {
            let mut cmd = Command::new(&bin);
            cmd.arg("-C").arg(&repo).arg("worktree").arg("remove");
            if force || extra_force {
                cmd.arg("--force");
            }
            cmd.arg(&path);
            let out = cmd.output().map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            Ok(())
        };

        match try_remove(false) {
            Ok(()) => {}
            Err(e) if e.contains("not a working tree") => {
                // The .git file inside the worktree is missing/broken.
                // Repair the link so git can locate the metadata, then retry.
                let _ = git_output(&repo, &["worktree", "repair", &path]);
                try_remove(true)?;
            }
            Err(e) => return Err(e),
        }

        // Delete the branch too — the task is gone, the branch should follow.
        if let Some(b) = branch {
            if is_safe_branch(&b) {
                // -D: force-delete regardless of merge status (user confirmed deletion).
                let _ = git_output(&repo, &["branch", "-D", &b]);
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Sync a worktree against origin/<base>: fetch, then optionally merge or rebase.
// `mode` is one of "fetch", "merge", "rebase".
#[tauri::command]
pub async fn git_sync(path: String, base: String, mode: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_branch(&base) {
            return Err(format!("unsafe base branch: {base}"));
        }
        let fetched = git_output(&path, &["fetch", "origin"])?;
        let target = format!("origin/{base}");
        match mode.as_str() {
            "fetch" => Ok(if fetched.trim().is_empty() { "Fetch completado".into() } else { fetched }),
            "merge" => git_output(&path, &["merge", &target]),
            "rebase" => git_output(&path, &["rebase", &target]),
            other => Err(format!("modo desconocido: {other}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_diff(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Show all uncommitted changes (staged + unstaged) relative to HEAD.
        git_output(&path, &["diff", "HEAD"])
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_in_editor(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        for editor in &["cursor", "code"] {
            if let Some(found) = login_shell_output(&format!("command -v {editor}")) {
                let bin_path = found.trim().to_string();
                if !bin_path.is_empty() && Command::new(&bin_path).arg(&path).spawn().is_ok() {
                    return Ok(());
                }
            }
        }
        Command::new("open").arg(&path).spawn().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
