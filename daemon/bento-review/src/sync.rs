//! Sincronizar con origin: traer, mezclar o rebasear, y saber cuánto te has
//! alejado. Sin UI: lo usan el panel, el daemon y el CLI.

use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::backup::create_history_backup;
use crate::tasks::upstream_of;
use crate::vcs::{current_branch, git_cmd, is_safe_branch};

/// Sincroniza un worktree contra `origin/<base>`: primero fetch, y luego merge
/// o rebase si toca. `mode` es "fetch", "merge" o "rebase"; `autostash` guarda
/// lo que haya sin commitear antes y lo devuelve después (se pregunta antes).
pub fn sync(cwd: &str, base: &str, mode: &str, autostash: bool) -> Result<String, String> {
    if !is_safe_branch(base) {
        return Err(format!("unsafe base branch: {base}"));
    }
    let fetched = git_cmd(cwd, &["fetch", "origin"])?;
    let target = format!("origin/{base}");
    match mode {
        "fetch" => Ok(if fetched.trim().is_empty() {
            "Fetch completado".into()
        } else {
            fetched
        }),
        "merge" => {
            if autostash {
                git_cmd(cwd, &["stash"])?;
            }
            let result = git_cmd(cwd, &["merge", &target]);
            if autostash {
                let _ = git_cmd(cwd, &["stash", "pop"]);
            }
            result
        }
        "rebase" => {
            create_history_backup(cwd)?;
            let mut args = vec!["rebase"];
            if autostash {
                args.push("--autostash");
            }
            args.push(&target);
            git_cmd(cwd, &args)
        }
        other => Err(format!("modo desconocido: {other}")),
    }
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../src/generated/bindings/"))]
#[serde(rename_all = "camelCase")]
pub struct UpstreamStatus {
    pub branch: String,
    pub upstream: Option<String>,
    pub has_upstream: bool,
    pub state: String,
    pub ahead: u32,
    pub behind: u32,
}

pub fn upstream_status(cwd: &str) -> Result<UpstreamStatus, String> {
    let branch = current_branch(cwd)?;
    let upstream = upstream_of(cwd);
    Ok(UpstreamStatus {
        branch,
        has_upstream: upstream.name.is_some(),
        upstream: upstream.name,
        state: upstream.state,
        ahead: upstream.ahead,
        behind: upstream.behind,
    })
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../src/generated/bindings/"))]
#[serde(rename_all = "camelCase")]
pub struct FetchInfo {
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub fetched_at: u64,
}

/// Cuándo fue el último fetch, mirando la fecha de FETCH_HEAD.
pub fn fetch_info(cwd: &str) -> Result<FetchInfo, String> {
    let raw_path = git_cmd(cwd, &["rev-parse", "--git-path", "FETCH_HEAD"])?;
    let fetch_path = Path::new(raw_path.trim());
    let absolute = if fetch_path.is_absolute() {
        fetch_path.to_path_buf()
    } else {
        Path::new(cwd).join(fetch_path)
    };
    let fetched_at = fs::metadata(absolute)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    Ok(FetchInfo { fetched_at })
}

/// Devuelve "<behind>\t<ahead>", el formato que espera `parse_ahead_behind`.
pub fn ahead_behind(cwd: &str, base: &str) -> Result<String, String> {
    if !is_safe_branch(base) {
        return Err(format!("unsafe base branch: {base}"));
    }
    git_cmd(
        cwd,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("origin/{base}...HEAD"),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::*;
    use std::process::Command;

    #[test]
    fn an_unknown_mode_and_an_unsafe_base_are_refused() {
        let repo = repo("sync-args");
        commit_file(&repo.0, "base\n", "base");
        let cwd = repo.0.to_str().unwrap();
        assert!(sync(cwd, "main", "reset", false).is_err());
        assert!(sync(cwd, "--exec=evil", "fetch", false).is_err());
        assert!(ahead_behind(cwd, "main; rm -rf /").is_err());
    }

    #[test]
    fn upstream_status_reports_unpublished_until_a_branch_is_pushed() {
        let repo = repo("upstream");
        commit_file(&repo.0, "base\n", "base");
        let status = upstream_status(repo.0.to_str().unwrap()).unwrap();
        assert!(!status.has_upstream);
        assert_eq!(status.state, "unpublished");
        assert_eq!(status.upstream, None);
    }

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
        run(&repo.0, &["remote", "add", "origin", remote.to_str().unwrap()]);
        run(&repo.0, &["push", "-u", "origin", "HEAD"]);

        let clone = Command::new("git")
            .arg("clone")
            .arg("-q")
            .arg(&remote)
            .arg(&collab)
            .output()
            .unwrap();
        assert!(clone.status.success(), "{}", String::from_utf8_lossy(&clone.stderr));
        run(&collab, &["config", "user.email", "collab@example.com"]);
        run(&collab, &["config", "user.name", "Collaborator"]);
        std::fs::write(collab.join("file.txt"), "remote change\n").unwrap();
        run(&collab, &["add", "file.txt"]);
        run(&collab, &["commit", "-qm", "remote change"]);
        run(&collab, &["push", "-q"]);

        std::fs::write(repo.0.join("file.txt"), "local rewrite\n").unwrap();
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
