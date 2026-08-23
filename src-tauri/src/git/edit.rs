use super::*;
use super::backup::create_history_backup;


// Resolves a rebase conflict by checking out one side and staging the result.
// `side` must be "ours" or "theirs".
#[tauri::command]
pub async fn git_resolve_conflict(path: String, file: String, side: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bin = git_bin().ok_or_else(|| "git not found".to_string())?;
        let flag = if side == "theirs" {
            "--theirs"
        } else {
            "--ours"
        };
        let co = Command::new(&bin)
            .arg("-C")
            .arg(&path)
            .arg("checkout")
            .arg(flag)
            .arg("--")
            .arg(&file)
            .output()
            .map_err(|e| e.to_string())?;
        if !co.status.success() {
            return Err(String::from_utf8_lossy(&co.stderr).trim().to_string());
        }
        let add = Command::new(&bin)
            .arg("-C")
            .arg(&path)
            .arg("add")
            .arg("--")
            .arg(&file)
            .output()
            .map_err(|e| e.to_string())?;
        if !add.status.success() {
            return Err(String::from_utf8_lossy(&add.stderr).trim().to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Stages specific files (used after manually resolving conflicts in an editor).
#[tauri::command]
pub async fn git_add_files(
    path: String,
    files: Vec<String>,
) -> Result<(), crate::command_error::CommandError> {
    tauri::async_runtime::spawn_blocking(move || add_files_blocking(&path, &files))
        .await
        .map_err(|e| crate::command_error::CommandError::runtime(e.to_string()))?
        .map_err(crate::command_error::CommandError::git)
}

fn add_files_blocking(path: &str, files: &[String]) -> Result<(), String> {
    // Validate using canonical paths, but pass the original relative paths
    // to Git. Absolute canonical paths are rejected by Git when the
    // worktree itself was reached through a symlink (notably /var ->
    // /private/var on macOS), even though the file is inside the worktree.
    for file in files {
        crate::git_paths::existing_worktree_file(path, file)?;
    }
    let bin = git_bin().ok_or_else(|| "git not found".to_string())?;
    for attempt in 0..=30 {
        let mut cmd = Command::new(&bin);
        cmd.arg("-C").arg(path).arg("add").arg("--");
        for file in files {
            cmd.arg(file);
        }
        let out = cmd.output().map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(());
        }
        let error = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let index_is_busy = error.contains("index.lock") && error.contains("File exists");
        if !index_is_busy || attempt == 30 {
            return Err(error);
        }
        // A status/rebase command may briefly own the shared worktree index.
        // Never delete its lock: wait for the owner and retry only this known
        // transient error.
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    unreachable!()
}

// Reads a file from a worktree — used by the inline conflict resolver.
#[tauri::command]
pub async fn git_read_file(
    path: String,
    file: String,
) -> Result<String, crate::command_error::CommandError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let safe_path = crate::git_paths::existing_worktree_file(&path, &file)?;
        fs::read_to_string(safe_path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| crate::command_error::CommandError::runtime(e.to_string()))?
    .map_err(crate::command_error::CommandError::git)
}

// Writes resolved content back to a worktree file — used by the inline conflict resolver.
#[tauri::command]
pub async fn git_write_file(
    path: String,
    file: String,
    content: String,
) -> Result<(), crate::command_error::CommandError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let safe_path = crate::git_paths::existing_worktree_file(&path, &file)?;
        fs::write(safe_path, content).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| crate::command_error::CommandError::runtime(e.to_string()))?
    .map_err(crate::command_error::CommandError::git)
}

// Resets HEAD to `target` (e.g. "origin/main").
// mode: "soft" | "mixed" (default) | "hard"
#[tauri::command]
pub async fn git_reset(path: String, target: String, mode: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_history_backup(&path)?;
        let flag = match mode.as_deref().unwrap_or("mixed") {
            "soft" => "--soft",
            "hard" => "--hard",
            _ => "--mixed",
        };
        let bin = git_bin().ok_or_else(|| "git not found".to_string())?;
        let out = Command::new(&bin)
            .arg("-C")
            .arg(&path)
            .arg("reset")
            .arg(flag)
            .arg(&target)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(())
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
        #[cfg(target_os = "macos")]
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        #[cfg(target_os = "linux")]
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        #[cfg(target_os = "windows")]
        Command::new("explorer.exe")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
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
    fn stages_validated_relative_worktree_files() {
        let repo = repo("add-files");
        fs::write(repo.0.join("file.txt"), "resolved\n").unwrap();
        add_files_blocking(repo.0.to_str().unwrap(), &["file.txt".into()]).unwrap();
        assert_eq!(
            run(&repo.0, &["diff", "--cached", "--name-only"]).trim(),
            "file.txt"
        );
    }

    #[test]
    fn waits_for_a_transient_git_index_lock_before_staging() {
        let repo = repo("add-files-lock");
        fs::write(repo.0.join("file.txt"), "resolved\n").unwrap();
        let lock = repo.0.join(".git/index.lock");
        fs::write(&lock, "busy").unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            fs::remove_file(lock).unwrap();
        });

        add_files_blocking(repo.0.to_str().unwrap(), &["file.txt".into()]).unwrap();
        release.join().unwrap();
        assert_eq!(
            run(&repo.0, &["diff", "--cached", "--name-only"]).trim(),
            "file.txt"
        );
    }
}
