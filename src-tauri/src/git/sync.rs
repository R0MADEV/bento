use super::*;
use super::backup::create_history_backup;


// Sync a worktree against origin/<base>: fetch, then optionally merge or rebase.
// `mode` is one of "fetch", "merge", "rebase".
// `autostash`: stash before merge/rebase and pop after (asked by the user beforehand).
#[tauri::command]
pub async fn git_sync(
    path: String,
    base: String,
    mode: String,
    autostash: Option<bool>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_branch(&base) {
            return Err(format!("unsafe base branch: {base}"));
        }
        let fetched = git_output(&path, &["fetch", "origin"])?;
        let target = format!("origin/{base}");
        let do_stash = autostash.unwrap_or(false);
        match mode.as_str() {
            "fetch" => Ok(if fetched.trim().is_empty() {
                "Fetch completado".into()
            } else {
                fetched
            }),
            "merge" => {
                if do_stash {
                    git_output(&path, &["stash"])?;
                }
                let result = git_output(&path, &["merge", &target]);
                if do_stash {
                    let _ = git_output(&path, &["stash", "pop"]);
                }
                result
            }
            "rebase" => {
                create_history_backup(&path)?;
                let extra: &[&str] = if do_stash { &["--autostash"] } else { &[] };
                let mut args = vec!["rebase"];
                args.extend_from_slice(extra);
                args.push(&target);
                git_output(&path, &args)
            }
            other => Err(format!("modo desconocido: {other}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_push(path: String, force_with_lease: Option<bool>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bin = git_bin().ok_or_else(|| "git not found".to_string())?;

        let branch = git_output(&path, &["rev-parse", "--abbrev-ref", "HEAD"])
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if branch.is_empty() || branch == "HEAD" {
            return Err("cannot push: detached HEAD".into());
        }

        let has_upstream = git_output(
            &path,
            &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        )
        .is_ok();

        let mut cmd = Command::new(&bin);
        cmd.arg("-C").arg(&path).arg("push");
        if !has_upstream {
            cmd.args(["-u", "origin", &branch]);
        } else if force_with_lease.unwrap_or(false) {
            cmd.arg("--force-with-lease");
        }
        let out = cmd.output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct UpstreamStatus {
    branch: String,
    upstream: Option<String>,
    has_upstream: bool,
    state: String,
    ahead: u32,
    behind: u32,
}

#[tauri::command]
pub async fn git_upstream_status(path: String) -> Result<UpstreamStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let branch = current_branch(&path)?;
        let upstream = match git_output(
            &path,
            &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        ) {
            Ok(value) => value.trim().to_string(),
            Err(_) => {
                return Ok(UpstreamStatus {
                    branch,
                    upstream: None,
                    has_upstream: false,
                    state: "unpublished".into(),
                    ahead: 0,
                    behind: 0,
                })
            }
        };
        let counts = git_output(
            &path,
            &["rev-list", "--left-right", "--count", "@{u}...HEAD"],
        )?;
        let mut parts = counts.split_whitespace();
        let behind = parts
            .next()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0);
        let ahead = parts
            .next()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0);
        let state = if ahead > 0 && behind > 0 {
            "diverged"
        } else if behind > 0 {
            "behind"
        } else if ahead > 0 {
            "ahead"
        } else {
            "synced"
        };
        Ok(UpstreamStatus {
            branch,
            upstream: Some(upstream),
            has_upstream: true,
            state: state.into(),
            ahead,
            behind,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct FetchInfo {
    #[ts(type = "number")]
    fetched_at: u64,
}

#[tauri::command]
pub async fn git_fetch_info(path: String) -> Result<FetchInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let raw_path = git_output(&path, &["rev-parse", "--git-path", "FETCH_HEAD"])?;
        let fetch_path = Path::new(raw_path.trim());
        let absolute = if fetch_path.is_absolute() {
            fetch_path.to_path_buf()
        } else {
            Path::new(&path).join(fetch_path)
        };
        let modified = fs::metadata(absolute)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        Ok(FetchInfo {
            fetched_at: modified,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// Returns "<behind>\t<ahead>" matching the format parseAheadBehind expects.
#[tauri::command]
pub async fn git_ahead_behind(path: String, base: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_branch(&base) {
            return Err(format!("unsafe base branch: {base}"));
        }
        let target = format!("origin/{base}");
        git_output(
            &path,
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("{target}...HEAD"),
            ],
        )
    })
    .await
    .map_err(|e| e.to_string())?
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;

    #[test]
    fn force_with_lease_rejects_a_remote_changed_by_someone_else() {
        let repo = repo("lease");
        commit_file(&repo.0, "initial\n", "initial");
        let remote = repo.0.join("remote.git");
        let collab = repo.0.join("collab");
        let init = Command::new("git")
            .args(["init", "--bare", "-q"])
            .arg(&remote)
            .output()
            .unwrap();
        assert!(init.status.success());
        run(
            &repo.0,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        run(&repo.0, &["push", "-u", "origin", "HEAD"]);

        let clone = Command::new("git")
            .arg("clone")
            .arg("-q")
            .arg(&remote)
            .arg(&collab)
            .output()
            .unwrap();
        assert!(
            clone.status.success(),
            "{}",
            String::from_utf8_lossy(&clone.stderr)
        );
        run(&collab, &["config", "user.email", "collab@example.com"]);
        run(&collab, &["config", "user.name", "Collaborator"]);
        fs::write(collab.join("file.txt"), "remote change\n").unwrap();
        run(&collab, &["add", "file.txt"]);
        run(&collab, &["commit", "-qm", "remote change"]);
        run(&collab, &["push", "-q"]);

        fs::write(repo.0.join("file.txt"), "local rewrite\n").unwrap();
        run(&repo.0, &["add", "file.txt"]);
        run(&repo.0, &["commit", "-qm", "local rewrite"]);
        let push = Command::new("git")
            .arg("-C")
            .arg(&repo.0)
            .args(["push", "--force-with-lease"])
            .output()
            .unwrap();
        assert!(
            !push.status.success(),
            "force-with-lease unexpectedly overwrote a changed remote"
        );
    }
}
