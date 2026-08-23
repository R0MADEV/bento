use super::*;


#[derive(serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct WorktreeInfo {
    path: String,
    branch: Option<String>,
    head: String,
    bare: bool,
}

fn parse_worktrees(raw: &str) -> Vec<WorktreeInfo> {
    // Git for Windows may emit CRLF even when stdout is captured through a
    // pipe. Normalize record separators before splitting porcelain blocks.
    raw.replace("\r\n", "\n")
        .trim()
        .split("\n\n")
        .filter_map(|block| {
            let mut path = None;
            let mut head = None;
            let mut branch = None;
            let mut bare = false;
            for line in block.lines() {
                if let Some(value) = line.strip_prefix("worktree ") {
                    path = Some(value.to_string());
                }
                if let Some(value) = line.strip_prefix("HEAD ") {
                    head = Some(value.to_string());
                }
                if let Some(value) = line.strip_prefix("branch refs/heads/") {
                    branch = Some(value.to_string());
                }
                if line == "bare" {
                    bare = true;
                }
            }
            if bare {
                return None;
            }
            Some(WorktreeInfo {
                path: path?,
                head: head?,
                branch,
                bare,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn git_worktree_list(repo: String) -> Result<Vec<WorktreeInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Prune stale worktree refs (folders deleted manually without `git worktree remove`).
        let _ = git_output(&repo, &["worktree", "prune"]);
        git_output(&repo, &["worktree", "list", "--porcelain"]).map(|raw| parse_worktrees(&raw))
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
pub async fn git_worktree_remove(
    repo: String,
    path: String,
    force: bool,
    branch: Option<String>,
) -> Result<(), String> {
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


#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;

    #[test]
    fn parses_typed_worktrees_and_ignores_bare_entries() {
        let raw = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /bare\nHEAD def456\nbare\n";
        let worktrees = parse_worktrees(raw);
        assert_eq!(worktrees.len(), 1);
        assert_eq!(worktrees[0].path, "/repo");
        assert_eq!(worktrees[0].branch.as_deref(), Some("main"));
        assert!(!worktrees[0].bare);
    }

    #[test]
    fn parses_windows_crlf_worktree_records() {
        let raw = "worktree C:\\repo\r\nHEAD abc123\r\nbranch refs/heads/main\r\n\r\nworktree C:\\repo task\r\nHEAD def456\r\nbranch refs/heads/task/e2e\r\n";
        let worktrees = parse_worktrees(raw);
        assert_eq!(worktrees.len(), 2);
        assert_eq!(worktrees[0].path, "C:\\repo");
        assert_eq!(worktrees[1].path, "C:\\repo task");
        assert_eq!(worktrees[1].branch.as_deref(), Some("task/e2e"));
    }
}
