use super::*;


#[derive(serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct GitStatus {
    raw: String,
    staged: u32,
    unstaged: u32,
    untracked: u32,
    total: u32,
}

fn parse_status(raw: String) -> GitStatus {
    let mut staged = 0;
    let mut unstaged = 0;
    let mut untracked = 0;
    let mut total = 0;
    for line in raw.lines().filter(|line| !line.trim().is_empty()) {
        total += 1;
        let bytes = line.as_bytes();
        let x = bytes.first().copied().unwrap_or(b' ');
        let y = bytes.get(1).copied().unwrap_or(b' ');
        if x == b'?' && y == b'?' {
            untracked += 1;
        } else {
            if x != b' ' {
                staged += 1;
            }
            if y != b' ' {
                unstaged += 1;
            }
        }
    }
    GitStatus {
        raw,
        staged,
        unstaged,
        untracked,
        total,
    }
}

fn append_untracked_diffs(path: &str, combined: &mut String) -> Result<(), String> {
    let untracked = git_output(path, &["ls-files", "--others", "--exclude-standard"])?;
    let bin = git_bin().ok_or_else(|| "git not found".to_string())?;
    let null_file = if cfg!(windows) { "NUL" } else { "/dev/null" };
    for file in untracked.lines().filter(|line| !line.is_empty()) {
        let out = Command::new(&bin)
            .arg("-C")
            .arg(path)
            .arg("diff")
            .arg("--no-index")
            .arg("--src-prefix=a/")
            .arg("--dst-prefix=b/")
            .arg("--")
            .arg(null_file)
            .arg(file)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.code() == Some(0) || out.status.code() == Some(1) {
            combined.push_str(&String::from_utf8_lossy(&out.stdout));
        } else {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    }
    Ok(())
}

fn collect_worktree_diff(path: &str) -> Result<String, String> {
    let mut combined = git_output(path, &["diff", "--no-ext-diff", "HEAD"])?;
    append_untracked_diffs(path, &mut combined)?;
    Ok(combined)
}

fn collect_review_worktree_diff(path: &str, base: &str) -> Result<String, String> {
    if !is_safe_branch(base) {
        return Err(format!("unsafe base: {base}"));
    }
    let mut combined = git_output(path, &["diff", "--no-ext-diff", base, "--"])?;
    append_untracked_diffs(path, &mut combined)?;
    Ok(combined)
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_output(&path, &["status", "--porcelain"]).map(parse_status)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct RewritePreflight {
    branch: String,
    base: String,
    dirty: bool,
    operation: String,
    upstream: String,
    published_commits: u32,
    protected_base: bool,
    signing: bool,
    hooks: Vec<String>,
}

// Read-only safety report used before rewriting task history. The frontend can
// explain every risk before invoking rebase/fixup instead of discovering it
// after Git has already started the operation.
#[tauri::command]
pub async fn git_rewrite_preflight(path: String, base: String) -> Result<RewritePreflight, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_branch(&base) {
            return Err(format!("unsafe base branch: {base}"));
        }
        let branch = current_branch(&path)?;
        let dirty = !git_output(&path, &["status", "--porcelain"])?
            .trim()
            .is_empty();
        let git_dir = resolve_git_dir(&path);
        let operation =
            if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
                "rebase"
            } else if git_dir.join("MERGE_HEAD").exists() {
                "merge"
            } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
                "cherry-pick"
            } else if git_dir.join("REVERT_HEAD").exists() {
                "revert"
            } else {
                ""
            };
        let upstream = git_output(
            &path,
            &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        )
        .unwrap_or_default()
        .trim()
        .to_string();
        let published_commits = if upstream.is_empty() {
            0
        } else {
            let range = format!("origin/{base}..@{{u}}");
            git_output(&path, &["rev-list", "--count", &range])
                .ok()
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(0)
        };
        let hooks = ["pre-rebase", "pre-commit", "commit-msg"]
            .iter()
            .filter(|name| git_dir.join("hooks").join(name).exists())
            .map(|name| name.to_string())
            .collect::<Vec<_>>();
        let signing = git_output(&path, &["config", "--bool", "commit.gpgsign"])
            .map(|value| value.trim() == "true")
            .unwrap_or(false);
        let protected_base = branch == base || matches!(branch.as_str(), "main" | "master");
        Ok(RewritePreflight {
            branch,
            base,
            dirty,
            operation: operation.into(),
            upstream,
            published_commits,
            protected_base,
            signing,
            hooks,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_diff(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || collect_worktree_diff(&path))
        .await
        .map_err(|e| e.to_string())?
}

// Accumulated diff of all commits on the current branch vs <base> (three-dot range).
#[tauri::command]
pub async fn git_branch_diff(path: String, base: String) -> Result<String, String> {
    if !is_safe_branch(&base) {
        return Err(format!("unsafe base branch: {base}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        if !is_git_repo(&path) {
            return Err("not a git repository".into());
        }
        // Try local ref first, fall back to origin/ prefix for remote-only branches.
        // The original error is preserved so transient failures are not silently swallowed.
        match git_output(&path, &["diff", &format!("{base}...HEAD")]) {
            Ok(out) => Ok(out),
            Err(first_err) => git_output(&path, &["diff", &format!("origin/{base}...HEAD")])
                .map_err(|_| first_err),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Diff from `base` to the current worktree, including committed, staged,
/// unstaged and untracked changes.

#[tauri::command]
pub async fn git_review_worktree_diff(path: String, base: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_git_repo(&path) {
            return Err("not a git repository".into());
        }
        collect_review_worktree_diff(&path, &base)
    })
    .await
    .map_err(|error| error.to_string())?
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;

    #[test]
    fn review_worktree_diff_includes_committed_uncommitted_and_untracked_changes() {
        let repo = repo("review-worktree-diff");
        commit_file(&repo.0, "base\n", "base");
        let base = run(&repo.0, &["branch", "--show-current"]).trim().to_string();
        run(&repo.0, &["checkout", "-qb", "feat/task"]);
        commit_file(&repo.0, "committed\n", "task commit");
        fs::write(repo.0.join("file.txt"), "working\n").unwrap();
        fs::write(repo.0.join("new.txt"), "untracked\n").unwrap();

        let diff = collect_review_worktree_diff(repo.0.to_str().unwrap(), &base).unwrap();
        assert!(diff.contains("diff --git a/file.txt b/file.txt"), "{diff}");
        assert!(diff.contains("+working"), "{diff}");
        assert!(diff.contains("diff --git a/new.txt b/new.txt"), "{diff}");
        assert!(diff.contains("+untracked"), "{diff}");
    }

    #[test]
    fn worktree_diff_includes_untracked_files_without_staging_them() {
        let repo = repo("untracked");
        commit_file(&repo.0, "base\n", "base");
        fs::write(repo.0.join("new.txt"), "new content\n").unwrap();
        let diff = collect_worktree_diff(repo.0.to_str().unwrap()).unwrap();
        assert!(diff.contains("diff --git a/new.txt b/new.txt"));
        assert!(diff.contains("+new content"));
        assert_eq!(run(&repo.0, &["status", "--short"]).trim(), "?? new.txt");
    }

    #[test]
    fn rewrite_preflight_reports_dirty_published_signing_and_hooks() {
        let repo = repo("preflight");
        commit_file(&repo.0, "root\n", "root");
        run(&repo.0, &["branch", "-M", "main"]);
        run(&repo.0, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        run(&repo.0, &["checkout", "-qb", "task"]);
        commit_file(&repo.0, "task\n", "task commit");
        run(&repo.0, &["branch", "published", "HEAD"]);
        run(&repo.0, &["branch", "--set-upstream-to=published"]);
        run(&repo.0, &["config", "commit.gpgsign", "true"]);
        let hooks = resolve_git_dir(repo.0.to_str().unwrap()).join("hooks");
        fs::write(hooks.join("pre-rebase"), "#!/bin/sh\n").unwrap();
        fs::write(repo.0.join("dirty.txt"), "dirty\n").unwrap();

        let report = tauri::async_runtime::block_on(git_rewrite_preflight(
            repo.0.to_string_lossy().to_string(),
            "main".into(),
        ))
        .unwrap();
        assert!(report.dirty);
        assert_eq!(report.published_commits, 1);
        assert!(report.signing);
        assert!(report.hooks.contains(&"pre-rebase".to_string()));
    }

    #[test]
    fn parses_typed_status_counts_and_preserves_porcelain() {
        let raw = " M a.txt\nM  b.txt\nMM c.txt\n?? d.txt\n".to_string();
        let status = parse_status(raw.clone());
        assert_eq!(status.raw, raw);
        assert_eq!(
            (
                status.staged,
                status.unstaged,
                status.untracked,
                status.total
            ),
            (2, 2, 1, 4)
        );
    }
}
