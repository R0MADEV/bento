use super::*;
use super::backup::{backup_ref_for, create_history_backup};


// Validates that a commit message is non-empty (trust boundary: frontend input).
fn is_valid_message(msg: &str) -> bool {
    !msg.trim().is_empty()
}

fn apply_selected_patch(path: &str, patch: &str) -> Result<(), String> {
    if patch.trim().is_empty() || !patch.contains("diff --git ") {
        return Err("selected patch is empty or invalid".into());
    }
    if patch.len() > 16 * 1024 * 1024 {
        return Err("selected patch is too large".into());
    }
    // Clear the index only; working-tree contents are preserved. This ensures
    // unrelated staged paths cannot leak into the partial commit.
    git_output(path, &["reset", "--mixed", "HEAD"])?;
    let bin = git_bin().ok_or_else(|| "git not found".to_string())?;
    let mut child = Command::new(&bin)
        .arg("-C")
        .arg(path)
        .arg("apply")
        .arg("--cached")
        .arg("--unidiff-zero")
        .arg("--whitespace=nowarn")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .as_mut()
        .ok_or("could not open git apply stdin")?
        .write_all(patch.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let _ = git_output(path, &["reset", "--mixed", "HEAD"]);
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

// `files`: stage only specific paths; if empty/None, stages everything.
// `amend`: if true, amends the last commit. An empty `message` keeps the original message (--no-edit).
#[tauri::command]
pub async fn git_commit(
    path: String,
    message: String,
    amend: Option<bool>,
    files: Option<Vec<String>>,
    patch: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let do_amend = amend.unwrap_or(false);
        if !do_amend && !is_valid_message(&message) {
            return Err("commit message cannot be empty".into());
        }

        let selected = files.as_ref().filter(|items| !items.is_empty());
        if let Some(ref selected_patch) = patch {
            apply_selected_patch(&path, selected_patch)?;
        } else if let Some(items) = selected {
            // Intent-to-add makes new files known to `commit --only`; --only
            // then ignores every unrelated path already present in the index.
            let mut args = vec!["add", "-N", "--"];
            args.extend(items.iter().map(String::as_str));
            git_output(&path, &args)?;
        } else {
            git_output(&path, &["add", "-A"])?;
        }

        let mut commit_args = vec!["commit"];
        if do_amend {
            commit_args.push("--amend");
        }
        if is_valid_message(&message) {
            commit_args.extend(["-m", &message]);
        } else {
            commit_args.push("--no-edit");
        }
        if patch.is_none() {
            if let Some(items) = selected {
                commit_args.push("--only");
                commit_args.push("--");
                commit_args.extend(items.iter().map(String::as_str));
            }
        }
        let result = git_output(&path, &commit_args);
        if result.is_err() && patch.is_some() {
            let _ = git_output(&path, &["reset", "--mixed", "HEAD"]);
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

// Adds the selected working-tree changes to an existing task commit by creating
// a fixup commit and immediately autosquashing it over origin/<base>.
#[tauri::command]
pub async fn git_fixup(
    path: String,
    target: String,
    base: String,
    files: Option<Vec<String>>,
    patch: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_branch(&base) {
            return Err(format!("unsafe base branch: {base}"));
        }
        if target.len() < 7 || !target.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("invalid target commit".into());
        }

        let base_ref = format!("origin/{base}");
        git_output(&path, &["rev-parse", "--verify", &base_ref])?;
        let range = format!("{base_ref}..HEAD");
        let branch_commits = git_output(&path, &["rev-list", &range])?;
        if !branch_commits.lines().any(|hash| hash == target) {
            return Err("target commit is not part of this task branch".into());
        }

        create_history_backup(&path)?;

        let selected = files.as_ref().filter(|items| !items.is_empty());
        if let Some(ref selected_patch) = patch {
            apply_selected_patch(&path, selected_patch)?;
        } else if let Some(items) = selected {
            let mut args = vec!["add", "-N", "--"];
            args.extend(items.iter().map(String::as_str));
            git_output(&path, &args)?;
        } else {
            git_output(&path, &["add", "-A"])?;
        }

        let fixup_arg = format!("--fixup={target}");
        let mut commit_args = vec!["commit", fixup_arg.as_str()];
        if patch.is_none() {
            if let Some(items) = selected {
                commit_args.push("--only");
                commit_args.push("--");
                commit_args.extend(items.iter().map(String::as_str));
            }
        }
        if let Err(error) = git_output(&path, &commit_args) {
            if patch.is_some() {
                let _ = git_output(&path, &["reset", "--mixed", "HEAD"]);
            }
            return Err(format!(
                "{error}\n\nNo se creó el fixup; los cambios siguen en el worktree."
            ));
        }

        let bin = git_bin().ok_or_else(|| "git not found".to_string())?;
        let out = Command::new(&bin)
            .arg("-C")
            .arg(&path)
            .arg("rebase")
            .arg("-i")
            .arg("--autosquash")
            .arg("--autostash")
            .arg(&base_ref)
            .env("GIT_SEQUENCE_EDITOR", "true")
            .env("GIT_EDITOR", "true")
            .output()
            .map_err(|e| e.to_string())?;

        let rebase_dir = resolve_git_dir(&path).join("rebase-merge");
        if rebase_dir.exists() {
            return Ok("paused".into());
        }
        if !out.status.success() {
            // The fixup commit exists but no recoverable rebase is active.
            // Return to the pre-operation commit with --mixed so every file
            // change remains available in the worktree.
            let backup_ref = backup_ref_for(&path)?;
            let _ = git_output(&path, &["reset", "--mixed", &backup_ref]);
            return Err(format!(
                "{}\n\nEl fixup se revirtió automáticamente y los cambios siguen en el worktree.",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok("completed".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_branch_rename(path: String, new_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_branch(&new_name) {
            return Err(format!("unsafe branch name: {new_name}"));
        }
        git_output(&path, &["branch", "-m", &new_name]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;

    #[test]
    fn partial_patch_stages_only_the_selected_hunk() {
        let repo = repo("partial");
        let original = (1..=12).map(|n| format!("line {n}\n")).collect::<String>();
        commit_file(&repo.0, &original, "base");
        let changed = original
            .replace("line 1\n", "changed one\n")
            .replace("line 12\n", "changed twelve\n");
        fs::write(repo.0.join("file.txt"), changed).unwrap();
        let diff = run(&repo.0, &["diff", "--unified=0"]);
        let second_hunk = diff
            .match_indices("@@")
            .nth(2)
            .map(|(index, _)| index)
            .unwrap();
        let selected = &diff[..second_hunk];
        apply_selected_patch(repo.0.to_str().unwrap(), selected).unwrap();
        let staged = run(&repo.0, &["diff", "--cached"]);
        let unstaged = run(&repo.0, &["diff"]);
        assert!(staged.contains("changed one"));
        assert!(!staged.contains("changed twelve"));
        assert!(unstaged.contains("changed twelve"));
    }

    #[test]
    fn autosquash_integrates_fixup_into_selected_commit() {
        let repo = repo("autosquash");
        commit_file(&repo.0, "root\n", "root");
        run(&repo.0, &["branch", "base"]);
        commit_file(&repo.0, "target\n", "target commit");
        let target = run(&repo.0, &["rev-parse", "HEAD"]);
        fs::write(repo.0.join("other.txt"), "later\n").unwrap();
        run(&repo.0, &["add", "other.txt"]);
        run(&repo.0, &["commit", "-qm", "later commit"]);
        fs::write(repo.0.join("file.txt"), "target with fix\n").unwrap();
        run(&repo.0, &["add", "file.txt"]);
        run(&repo.0, &["commit", &format!("--fixup={}", target.trim())]);

        let out = Command::new("git")
            .arg("-C")
            .arg(&repo.0)
            .args(["rebase", "-i", "--autosquash", "base"])
            .env("GIT_SEQUENCE_EDITOR", "true")
            .env("GIT_EDITOR", "true")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            run(&repo.0, &["rev-list", "--count", "base..HEAD"]).trim(),
            "2"
        );
        assert_eq!(
            fs::read_to_string(repo.0.join("file.txt")).unwrap(),
            "target with fix\n"
        );
        assert!(!run(&repo.0, &["log", "--format=%s", "base..HEAD"]).contains("fixup!"));
    }
}
