use super::*;
use super::backup::create_history_backup;


#[derive(serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct RebaseStatus {
    active: bool,
    sha: Option<String>,
    short: Option<String>,
    subject: Option<String>,
    body: Option<String>,
    branch: Option<String>,
    current: Option<u32>,
    total: Option<u32>,
    conflicts: Vec<String>,
}

// Writes a temp shell script that copies its first argument to our prepared todo file.
// Used as GIT_SEQUENCE_EDITOR so git uses our todo instead of opening $EDITOR.
fn write_sequence_editor_script(
    todo_content: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let pid = std::process::id();
    let todo_path = std::env::temp_dir().join(format!("bento-rebase-todo-{pid}.txt"));
    let extension = if cfg!(windows) { "cmd" } else { "sh" };
    let script_path = std::env::temp_dir().join(format!("bento-rebase-editor-{pid}.{extension}"));

    fs::write(&todo_path, todo_content).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let script = format!(
        "@echo off\r\ncopy /Y \"{}\" \"%~1\" >NUL\r\n",
        todo_path.display()
    );
    #[cfg(not(windows))]
    let script = format!("#!/bin/sh\ncp '{}' \"$1\"\n", todo_path.display());
    fs::write(&script_path, &script).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }

    Ok((todo_path, script_path))
}

fn sequence_editor_command(path: &Path, windows: bool) -> String {
    let raw = path.to_string_lossy();
    let normalized = if windows {
        raw.replace('\\', "/")
    } else {
        raw.into_owned()
    };
    // Git executes GIT_SEQUENCE_EDITOR through a POSIX-style shell, including
    // Git for Windows. Single-quote the executable and escape embedded quotes.
    format!("'{}'", normalized.replace('\'', "'\"'\"'"))
}

// Starts an interactive rebase over origin/<base>. `todo_lines` are the rebase instructions
// (e.g. ["pick abc1234 Fix login", "drop def5678 Bad commit"]).
// If git stops at an `edit` step this returns Ok(()) — check git_rebase_status afterwards.
#[tauri::command]
pub async fn git_rebase_start(
    path: String,
    base: String,
    todo_lines: Vec<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_branch(&base) {
            return Err(format!("unsafe base branch: {base}"));
        }
        if todo_lines.is_empty() {
            return Err("nothing to rebase".into());
        }
        let target = format!("origin/{base}");
        git_output(&path, &["rev-parse", "--verify", &target])?;
        let range = format!("{target}..HEAD");
        let allowed_hashes = git_output(&path, &["rev-list", "--no-merges", &range])?;
        for line in &todo_lines {
            if line.contains('\n') || line.contains('\r') {
                return Err("invalid rebase instruction".into());
            }
            let mut parts = line.split_whitespace();
            let action = parts.next().unwrap_or("");
            let hash = parts.next().unwrap_or("");
            if !matches!(action, "pick" | "edit" | "squash" | "fixup" | "drop")
                || hash.len() < 7
                || !hash.chars().all(|c| c.is_ascii_hexdigit())
                || !allowed_hashes.lines().any(|allowed| allowed == hash)
            {
                return Err("rebase instruction contains an invalid action or commit".into());
            }
        }
        create_history_backup(&path)?;
        let todo_content = todo_lines.join("\n") + "\n";
        let (todo_path, script_path) = write_sequence_editor_script(&todo_content)?;
        let sequence_editor = sequence_editor_command(&script_path, cfg!(windows));

        let bin = git_bin().ok_or_else(|| "git not found".to_string())?;
        let out = Command::new(&bin)
            .arg("-C")
            .arg(&path)
            .arg("rebase")
            .arg("-i")
            .arg("--autostash")
            .arg(&target)
            .env("GIT_SEQUENCE_EDITOR", sequence_editor)
            .env("GIT_EDITOR", "true") // suppress editor prompts for squash messages
            .output()
            .map_err(|e| e.to_string())?;

        let _ = fs::remove_file(&todo_path);
        let _ = fs::remove_file(&script_path);

        // Check for pause BEFORE checking exit code: git may exit 0 or non-0 when paused.
        let rebase_dir = resolve_git_dir(&path).join("rebase-merge");
        if rebase_dir.exists() {
            return Ok(());
        }

        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_rebase_preserve_merges(path: String, base: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_branch(&base) {
            return Err(format!("unsafe base branch: {base}"));
        }
        let target = format!("origin/{base}");
        git_output(&path, &["rev-parse", "--verify", &target])?;
        create_history_backup(&path)?;
        let bin = git_bin().ok_or_else(|| "git not found".to_string())?;
        let out = Command::new(&bin)
            .arg("-C")
            .arg(&path)
            .arg("rebase")
            .arg("--rebase-merges")
            .arg("--autostash")
            .arg(&target)
            .env("GIT_EDITOR", "true")
            .output()
            .map_err(|e| e.to_string())?;
        if resolve_git_dir(&path).join("rebase-merge").exists() {
            return Ok("paused".into());
        }
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok("completed".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Continues after an `edit` pause. Returns "paused" if git stopped at another edit step.
#[tauri::command]
pub async fn git_rebase_continue(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bin = git_bin().ok_or_else(|| "git not found".to_string())?;
        let out = Command::new(&bin)
            .arg("-C")
            .arg(&path)
            .arg("rebase")
            .arg("--continue")
            .env("GIT_EDITOR", "true")
            .output()
            .map_err(|e| e.to_string())?;

        // Same pattern as git_rebase_start: check directory before exit code.
        let rebase_dir = resolve_git_dir(&path).join("rebase-merge");
        if rebase_dir.exists() {
            return Ok("paused".into());
        }

        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_rebase_abort(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_output(&path, &["rebase", "--abort"]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Turns the commit currently paused by an interactive `edit` into worktree
// changes. The user can then create two or more partial commits and continue.
#[tauri::command]
pub async fn git_rebase_split(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rebase_dir = resolve_git_dir(&path).join("rebase-merge");
        if !rebase_dir.exists() {
            return Err("no interactive rebase is active".into());
        }
        if !git_output(&path, &["status", "--porcelain"])?
            .trim()
            .is_empty()
        {
            return Err("resolve or commit the current worktree changes before splitting".into());
        }
        git_output(&path, &["reset", "--mixed", "HEAD^"]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Returns JSON with rebase state. Includes `conflicts` array (unmerged files) when paused at a conflict.
#[tauri::command]
pub async fn git_rebase_status(path: String) -> Result<RebaseStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rebase_dir = resolve_git_dir(&path).join("rebase-merge");
        if !rebase_dir.exists() {
            return Ok(RebaseStatus {
                active: false,
                sha: None,
                short: None,
                subject: None,
                body: None,
                branch: None,
                current: None,
                total: None,
                conflicts: Vec::new(),
            });
        }
        // Use HEAD directly — more reliable than stopped-sha (not always written by git).
        let sha = git_output(&path, &["rev-parse", "HEAD"])
            .unwrap_or_default()
            .trim()
            .to_string();
        let short = sha.chars().take(7).collect::<String>();
        let head_name = fs::read_to_string(rebase_dir.join("head-name"))
            .unwrap_or_default()
            .trim()
            .trim_start_matches("refs/heads/")
            .to_string();
        let current = fs::read_to_string(rebase_dir.join("msgnum"))
            .unwrap_or_default()
            .trim()
            .parse::<u32>()
            .unwrap_or(0);
        let total = fs::read_to_string(rebase_dir.join("end"))
            .unwrap_or_default()
            .trim()
            .parse::<u32>()
            .unwrap_or(0);
        // Full commit message: subject + body (separated by blank line in git output)
        let full_msg = git_output(&path, &["log", "--format=%B", "-1"])
            .unwrap_or_default()
            .trim()
            .to_string();
        let subject = full_msg.lines().next().unwrap_or("").to_string();
        let body = full_msg.lines().skip(2).collect::<Vec<_>>().join("\n");

        // Detect conflicting files: porcelain status lines where both sides are non-clean (UU, AA, DD, AU, UA, DU, UD).
        let status_out = git_output(&path, &["status", "--porcelain"]).unwrap_or_default();
        let conflicts: Vec<String> = status_out
            .lines()
            .filter(|l| {
                l.len() >= 2 && matches!(&l[..2], "UU" | "AA" | "DD" | "AU" | "UA" | "DU" | "UD")
            })
            .map(|l| l[3..].trim().to_string())
            .collect();

        Ok(RebaseStatus {
            active: true,
            sha: Some(sha),
            short: Some(short),
            subject: Some(subject),
            body: Some(body),
            branch: Some(head_name),
            current: Some(current),
            total: Some(total),
            conflicts,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;

    #[test]
    fn conflicted_rebase_can_be_aborted_without_losing_the_original_head() {
        let repo = repo("abort");
        commit_file(&repo.0, "shared\n", "root");
        let base_branch = run(&repo.0, &["rev-parse", "--abbrev-ref", "HEAD"]);
        run(&repo.0, &["branch", "task"]);
        commit_file(&repo.0, "base version\n", "base change");
        run(&repo.0, &["checkout", "-q", "task"]);
        commit_file(&repo.0, "task version\n", "task change");
        let original_head = run(&repo.0, &["rev-parse", "HEAD"]);
        let rebase = Command::new("git")
            .arg("-C")
            .arg(&repo.0)
            .args(["rebase", base_branch.trim()])
            .output()
            .unwrap();
        assert!(!rebase.status.success());
        assert!(resolve_git_dir(repo.0.to_str().unwrap())
            .join("rebase-merge")
            .exists());
        run(&repo.0, &["rebase", "--abort"]);
        assert_eq!(
            run(&repo.0, &["rev-parse", "HEAD"]).trim(),
            original_head.trim()
        );
        assert_eq!(
            fs::read_to_string(repo.0.join("file.txt")).unwrap(),
            "task version\n"
        );
    }

    #[test]
    fn split_rebase_returns_paused_commit_to_the_worktree() {
        let repo = repo("split");
        commit_file(&repo.0, "root\n", "root");
        run(&repo.0, &["branch", "base"]);
        commit_file(&repo.0, "changed\n", "change to split");
        let commit = run(&repo.0, &["rev-parse", "HEAD"]);
        let todo = format!("edit {} change to split\n", commit.trim());
        let (todo_path, script_path) = write_sequence_editor_script(&todo).unwrap();
        let out = Command::new("git")
            .arg("-C")
            .arg(&repo.0)
            .args(["rebase", "-i", "base"])
            .env("GIT_SEQUENCE_EDITOR", &script_path)
            .env("GIT_EDITOR", "true")
            .output()
            .unwrap();
        let _ = fs::remove_file(todo_path);
        let _ = fs::remove_file(script_path);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(resolve_git_dir(repo.0.to_str().unwrap())
            .join("rebase-merge")
            .exists());

        tauri::async_runtime::block_on(git_rebase_split(repo.0.to_string_lossy().to_string()))
            .unwrap();
        let status = run(&repo.0, &["status", "--short"]);
        assert!(status.contains("file.txt"));
        assert_eq!(
            fs::read_to_string(repo.0.join("file.txt")).unwrap(),
            "changed\n"
        );
        run(&repo.0, &["rebase", "--abort"]);
    }

    #[test]
    fn quotes_windows_sequence_editor_for_gits_shell() {
        let path = Path::new(r"C:\Users\Runner Admin\Temp\bento-rebase-editor.cmd");
        assert_eq!(
            sequence_editor_command(path, true),
            "'C:/Users/Runner Admin/Temp/bento-rebase-editor.cmd'"
        );
    }
}
