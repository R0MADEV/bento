use super::*;


#[derive(serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct BackupStatus {
    available: bool,
    different: Option<bool>,
    hash: Option<String>,
    short: Option<String>,
    subject: Option<String>,
}

#[derive(serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct BackupEntry {
    reference: String,
    hash: String,
    short: String,
    subject: String,
    #[ts(type = "number")]
    created_at: u64,
}

pub(super) fn backup_ref_for(path: &str) -> Result<String, String> {
    Ok(format!("refs/bento/backups/{}", current_branch(path)?))
}

pub(super) fn create_history_backup(path: &str) -> Result<String, String> {
    let backup_ref = backup_ref_for(path)?;
    git_output(path, &["update-ref", &backup_ref, "HEAD"])?;
    let branch = current_branch(path)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let history_ref = format!("refs/bento/history/{branch}/{stamp}");
    git_output(path, &["update-ref", &history_ref, "HEAD"])?;

    // Keep the history bounded per branch.
    let prefix = format!("refs/bento/history/{branch}");
    if let Ok(refs) = git_output(
        path,
        &[
            "for-each-ref",
            "--sort=-refname",
            "--format=%(refname)",
            &prefix,
        ],
    ) {
        for old_ref in refs.lines().skip(20) {
            let _ = git_output(path, &["update-ref", "-d", old_ref]);
        }
    }
    Ok(backup_ref)
}

// Describes the latest automatic backup for the current branch.
#[tauri::command]
pub async fn git_backup_status(path: String) -> Result<BackupStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let backup_ref = backup_ref_for(&path)?;
        let hash = match git_output(&path, &["rev-parse", "--verify", &backup_ref]) {
            Ok(value) => value.trim().to_string(),
            Err(_) => {
                return Ok(BackupStatus {
                    available: false,
                    different: None,
                    hash: None,
                    short: None,
                    subject: None,
                })
            }
        };
        let head = git_output(&path, &["rev-parse", "HEAD"])?
            .trim()
            .to_string();
        let subject = git_output(&path, &["log", "-1", "--format=%s", &backup_ref])?
            .trim()
            .to_string();
        Ok(BackupStatus {
            available: true,
            different: Some(hash != head),
            short: Some(hash.chars().take(7).collect()),
            hash: Some(hash),
            subject: Some(subject),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// Lists the bounded automatic backup history, newest first.
// Format: ref<US>hash<US>short<US>subject. Creation time is encoded in ref.
#[tauri::command]
pub async fn git_backup_list(path: String) -> Result<Vec<BackupEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let branch = current_branch(&path)?;
        let prefix = format!("refs/bento/history/{branch}");
        let raw = git_output(
            &path,
            &[
                "for-each-ref",
                "--sort=-refname",
                "--format=%(refname)\x1f%(objectname)\x1f%(objectname:short)\x1f%(subject)",
                &prefix,
            ],
        )?;
        Ok(raw
            .lines()
            .filter_map(|line| {
                let mut parts = line.split('\x1f');
                let reference = parts.next()?.to_string();
                let hash = parts.next()?.to_string();
                let short = parts.next()?.to_string();
                let subject = parts.next().unwrap_or_default().to_string();
                let created_at = reference.rsplit('/').next()?.parse::<u64>().ok()?;
                Some(BackupEntry {
                    reference,
                    hash,
                    short,
                    subject,
                    created_at,
                })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_backup_diff(path: String, target: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let branch = current_branch(&path)?;
        let prefix = format!("refs/bento/history/{branch}/");
        if !target.starts_with(&prefix) {
            return Err("invalid backup reference".into());
        }
        git_output(&path, &["diff", "--no-ext-diff", &target, "HEAD"])
    })
    .await
    .map_err(|e| e.to_string())?
}

// Swaps HEAD with the automatic backup. A clean worktree is required so no
// uncommitted work can be lost; swapping the ref makes the operation reversible.
#[tauri::command]
pub async fn git_restore_backup(path: String, target: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !git_output(&path, &["status", "--porcelain"])?
            .trim()
            .is_empty()
        {
            return Err("cannot restore backup with uncommitted changes".into());
        }
        if resolve_git_dir(&path).join("rebase-merge").exists() {
            return Err("cannot restore backup during an active rebase".into());
        }
        let backup_ref = backup_ref_for(&path)?;
        let branch = current_branch(&path)?;
        let history_prefix = format!("refs/bento/history/{branch}/");
        let target_ref = target.unwrap_or_else(|| backup_ref.clone());
        if target_ref != backup_ref && !target_ref.starts_with(&history_prefix) {
            return Err("invalid backup reference".into());
        }
        let target_hash = git_output(&path, &["rev-parse", "--verify", &target_ref])?
            .trim()
            .to_string();
        let current = git_output(&path, &["rev-parse", "HEAD"])?
            .trim()
            .to_string();
        // Preserve the state being left as another history entry.
        create_history_backup(&path)?;
        git_output(&path, &["update-ref", &backup_ref, &current])?;
        git_output(&path, &["reset", "--hard", &target_hash]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;

    #[test]
    fn history_backup_points_to_pre_operation_head() {
        let repo = repo("backup");
        commit_file(&repo.0, "one\n", "first");
        let original = run(&repo.0, &["rev-parse", "HEAD"]);
        let backup_ref = create_history_backup(repo.0.to_str().unwrap()).unwrap();
        commit_file(&repo.0, "two\n", "second");
        let saved = run(&repo.0, &["rev-parse", &backup_ref]);
        assert_eq!(saved.trim(), original.trim());
        let history = run(
            &repo.0,
            &["for-each-ref", "--format=%(refname)", "refs/bento/history"],
        );
        assert_eq!(history.lines().count(), 1);
    }
}
