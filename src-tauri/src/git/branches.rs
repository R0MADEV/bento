use super::*;


#[tauri::command]
pub async fn git_default_branch(repo: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Try origin/HEAD first.
        if let Ok(out) = git_output(
            &repo,
            &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        ) {
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
pub async fn git_remote_branches(repo: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_git_repo(&repo) {
            return Err("not a git repository".into());
        }
        let raw = git_output(
            &repo,
            &[
                "for-each-ref",
                "--format=%(refname:short)",
                "refs/remotes/origin",
            ],
        )?;
        Ok(raw
            .lines()
            .filter_map(|line| line.strip_prefix("origin/"))
            .filter(|branch| *branch != "HEAD" && is_safe_branch(branch))
            .map(str::to_string)
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Lists branches from ALL remotes with full remote/branch format (e.g. "daimoxd/feat/foo").
#[tauri::command]
pub async fn git_all_remote_branches(repo: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_git_repo(&repo) {
            return Err("not a git repository".into());
        }
        let raw = git_output(
            &repo,
            &["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
        )?;
        Ok(raw
            .lines()
            .filter(|line| !line.ends_with("/HEAD") && is_safe_branch(line))
            .map(str::to_string)
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn parse_review_branches(local: &str, remote: &str) -> Vec<String> {
    let mut branches = Vec::new();
    for branch in local.lines().chain(remote.lines()) {
        let branch = branch.trim();
        if branch.is_empty()
            || branch == "HEAD"
            || branch.ends_with("/HEAD")
            || !is_safe_branch(branch)
            || branches.iter().any(|existing| existing == branch)
        {
            continue;
        }
        branches.push(branch.to_string());
    }
    branches
}

/// Branches available for review: local task/worktree branches first, followed
/// by fully-qualified remote branches such as `origin/main`.

#[tauri::command]
pub async fn git_review_branches(repo: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_git_repo(&repo) {
            return Err("not a git repository".into());
        }
        let local = git_output(
            &repo,
            &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        )?;
        let remote = git_output(
            &repo,
            &["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
        )?;
        Ok(parse_review_branches(&local, &remote))
    })
    .await
    .map_err(|error| error.to_string())?
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;

    #[test]
    fn review_branches_include_local_tasks_and_qualified_remotes() {
        let branches = parse_review_branches(
            "main\nfeat/NIXON-501\n",
            "origin/HEAD\norigin/main\nupstream/release\n",
        );
        assert_eq!(branches, vec![
            "main",
            "feat/NIXON-501",
            "origin/main",
            "upstream/release",
        ]);
    }
}
