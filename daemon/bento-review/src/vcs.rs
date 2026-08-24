//! The `git`/`gh` side of a review: validation of client-supplied refs and
//! paths, the changed-file list and the per-file/PR diffs. Written once here
//! because the desktop app, the daemon (phone remote) and the CLI all need
//! exactly these operations — including `is_safe_branch`, which used to exist
//! in both codebases, so a hardening fix in one never reached the other.

use std::process::Command;
use std::sync::OnceLock;

use serde_json::{json, Value};

use crate::diff::parse_diff_name_status;

/// macOS GUI apps don't inherit the shell PATH, so a Homebrew-installed
/// `git`/`gh` is invisible to a double-clicked app — resolve it through a
/// login shell once and cache it. On the daemon/CLI the first check hits.
fn resolve_bin(name: &'static str, cache: &'static OnceLock<Option<String>>) -> Option<String> {
    cache
        .get_or_init(|| {
            let on_path = Command::new(name)
                .arg("--version")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if on_path {
                return Some(name.to_string());
            }
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
            let out = Command::new(shell).arg("-lc").arg(format!("command -v {name}")).output().ok()?;
            if !out.status.success() {
                return None;
            }
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if path.is_empty() { None } else { Some(path) }
        })
        .clone()
}

fn git_bin() -> Result<String, String> {
    static GIT: OnceLock<Option<String>> = OnceLock::new();
    resolve_bin("git", &GIT).ok_or_else(|| "git not found".to_string())
}

fn gh_bin() -> Result<String, String> {
    static GH: OnceLock<Option<String>> = OnceLock::new();
    resolve_bin("gh", &GH).ok_or_else(|| "gh not found".to_string())
}

pub fn git_cmd(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(git_bin()?)
        .args([&["-C", cwd], args].concat())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Like `git_cmd` but accepts exit code 1 (`git diff --no-index` exits 1 when
/// the files differ, which is the normal case here).
pub fn git_cmd_exit1_ok(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(git_bin()?)
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.code().unwrap_or(2) <= 1 {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

pub fn gh_cmd(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(gh_bin()?)
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("gh not found: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// A client-supplied git ref used as a `git diff` argument. Rejects
/// flag-injection (`--upload-pack=...`) and range syntax (`..`).
pub fn is_safe_branch(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
}

/// A client-supplied file path used to read file contents off disk. Rejects
/// absolute paths and `..` segments so it can't escape `cwd`.
pub fn is_safe_relative_path(path: &str) -> bool {
    !path.is_empty() && !path.starts_with('/') && !path.split('/').any(|seg| seg == "..")
}

pub fn untracked_files(cwd: &str) -> Vec<String> {
    git_cmd(cwd, &["ls-files", "--others", "--exclude-standard"])
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

/// A whole-file diff for a path git doesn't track yet.
pub fn diff_no_index(cwd: &str, path: &str) -> String {
    git_cmd_exit1_ok(cwd, &["diff", "--no-index", "--", "/dev/null", path]).unwrap_or_default()
}

/// The most recently committed-to branches, newest first.
pub fn list_branches(cwd: &str) -> Vec<String> {
    git_cmd(cwd, &["branch", "--sort=-committerdate", "--format=%(refname:short)"])
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .take(20)
        .map(String::from)
        .collect()
}

/// Pure merge of `git diff --name-status` entries with their `--numstat`
/// add/delete counts (matched by path — numstat can omit a path entirely,
/// e.g. for binary files, so entries default to 0/0), plus untracked files
/// appended as additions. Split out from `list_files` so the merge logic
/// itself is testable without shelling out to git.
pub fn build_file_list(name_status: &str, numstat: &str, untracked: &[String]) -> Vec<Value> {
    let stats: std::collections::HashMap<String, (i64, i64)> = numstat
        .lines()
        .filter_map(|l| {
            let mut p = l.splitn(3, '\t');
            let a: i64 = p.next()?.parse().unwrap_or(0);
            let d: i64 = p.next()?.parse().unwrap_or(0);
            Some((p.next()?.trim().to_string(), (a, d)))
        })
        .collect();

    let mut list: Vec<_> = parse_diff_name_status(name_status)
        .into_iter()
        .map(|e| {
            let (added, deleted) = stats.get(&e.path).copied().unwrap_or((0, 0));
            let mut v = json!({ "status": e.status, "path": e.path, "added": added, "deleted": deleted });
            if let Some(old) = e.old_path {
                v["old_path"] = json!(old);
            }
            v
        })
        .collect();

    for path in untracked {
        list.push(json!({ "status": "A", "path": path, "added": 0, "deleted": 0 }));
    }
    list
}

/// Every file changed against `base`, untracked files included. `base` is
/// validated here, not at the transport layer, so every caller gets the same
/// flag-injection protection regardless of how it arrived.
pub fn list_files(cwd: &str, base: &str) -> Result<Vec<Value>, String> {
    if !is_safe_branch(base) {
        return Err("unsafe base".into());
    }
    let name_status = git_cmd(cwd, &["diff", "--name-status", base])?;
    let numstat = git_cmd(cwd, &["diff", "--numstat", base]).unwrap_or_default();
    Ok(build_file_list(&name_status, &numstat, &untracked_files(cwd)))
}

/// The whole change under review: a branch against `base` (committed work
/// only), or the working tree against `base` plus anything untracked — the
/// case where you review before committing, which is most of them.
pub fn review_diff(cwd: &str, base: &str, branch: Option<&str>) -> Result<String, String> {
    if !is_safe_branch(base) {
        return Err("rama base inválida".into());
    }
    if let Some(branch) = branch {
        if !is_safe_branch(branch) {
            return Err("rama inválida".into());
        }
        return git_cmd(cwd, &["diff", &format!("{base}..{branch}")]);
    }
    let tracked = git_cmd(cwd, &["diff", base])?;
    let untracked = untracked_files(cwd)
        .iter()
        .map(|path| diff_no_index(cwd, path))
        .filter(|d| !d.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if untracked.is_empty() {
        return Ok(tracked);
    }
    Ok(format!("{tracked}\n{untracked}"))
}

/// The diff for a single file vs `base` (tracked change, or a fully-added
/// diff for an untracked file).
pub fn file_diff(cwd: &str, path: &str, base: &str) -> Result<String, String> {
    if !is_safe_relative_path(path) {
        return Err("ruta insegura".into());
    }
    if !is_safe_branch(base) {
        return Err("rama insegura".into());
    }
    let diff = git_cmd(cwd, &["diff", base, "--", path]).unwrap_or_default();
    if !diff.is_empty() {
        return Ok(diff);
    }
    Ok(diff_no_index(cwd, path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn is_safe_branch_accepts_normal_names() {
        assert!(is_safe_branch("main"));
        assert!(is_safe_branch("feat/mobile-review-diff"));
        assert!(is_safe_branch("release-1.2.3"));
    }

    #[test]
    fn is_safe_branch_rejects_flag_injection() {
        assert!(!is_safe_branch("--upload-pack=touch /tmp/pwned"));
        assert!(!is_safe_branch("-oProxyCommand=x"));
    }

    #[test]
    fn is_safe_branch_rejects_range_syntax_and_empty() {
        assert!(!is_safe_branch("main..evil"));
        assert!(!is_safe_branch(""));
    }

    #[test]
    fn is_safe_relative_path_accepts_normal_paths() {
        assert!(is_safe_relative_path("src/main.rs"));
        assert!(is_safe_relative_path("file.txt"));
    }

    #[test]
    fn is_safe_relative_path_rejects_absolute_and_traversal() {
        assert!(!is_safe_relative_path("/etc/passwd"));
        assert!(!is_safe_relative_path("../../etc/passwd"));
        assert!(!is_safe_relative_path("src/../../etc/passwd"));
        assert!(!is_safe_relative_path(""));
    }

    #[test]
    fn build_file_list_matches_stats_to_entries_by_path() {
        let list = build_file_list("M\tfoo.rs\n", "3\t1\tfoo.rs\n", &[]);
        assert_eq!(list, vec![json!({ "status": "M", "path": "foo.rs", "added": 3, "deleted": 1 })]);
    }

    #[test]
    fn build_file_list_includes_old_path_for_renames() {
        let list = build_file_list("R100\told.rs\tnew.rs\n", "0\t0\tnew.rs\n", &[]);
        assert_eq!(
            list,
            vec![json!({ "status": "R", "path": "new.rs", "added": 0, "deleted": 0, "old_path": "old.rs" })]
        );
    }

    #[test]
    fn build_file_list_defaults_missing_numstat_to_zero() {
        // Binary files (or a stat line git omits for other reasons) have no
        // numstat entry — the file should still show up, just with 0/0.
        let list = build_file_list("M\tfoo.bin\n", "", &[]);
        assert_eq!(list, vec![json!({ "status": "M", "path": "foo.bin", "added": 0, "deleted": 0 })]);
    }

    #[test]
    fn build_file_list_appends_untracked_files_as_added() {
        let list = build_file_list("", "", &["new_file.rs".to_string()]);
        assert_eq!(list, vec![json!({ "status": "A", "path": "new_file.rs", "added": 0, "deleted": 0 })]);
    }

    #[test]
    fn list_files_rejects_an_unsafe_base() {
        assert!(list_files("/tmp", "--upload-pack=x").is_err());
    }

    #[test]
    fn file_diff_rejects_an_unsafe_path_or_base() {
        assert!(file_diff("/tmp", "../../etc/passwd", "main").is_err());
        assert!(file_diff("/tmp", "src/a.rs", "main..evil").is_err());
    }
}
