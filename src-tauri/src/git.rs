// Git worktree commands for the parallel tasks panel.
// Follows the same patterns as docker.rs: login-shell PATH resolution,
// spawn_blocking for all blocking I/O, input validation at trust boundaries.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct WorktreeInfo {
    path: String,
    branch: Option<String>,
    head: String,
    bare: bool,
}

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

#[derive(serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct CommitEntry {
    hash: String,
    short: String,
    subject: String,
    date: String,
    author: String,
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct CommitFile {
    status: String,
    paths: Vec<String>,
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct CommitRecommendation {
    hash: String,
    score: u32,
    files: Vec<String>,
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

#[derive(serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct FetchInfo {
    #[ts(type = "number")]
    fetched_at: u64,
}

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

#[derive(serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct PrCheck {
    name: Option<String>,
    context: Option<String>,
    conclusion: Option<String>,
    state: Option<String>,
    status: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct PrStatus {
    state: String,
    title: String,
    url: String,
    #[ts(type = "number")]
    number: u64,
    base_ref_name: Option<String>,
    is_draft: Option<bool>,
    mergeable: Option<String>,
    review_decision: Option<String>,
    #[serde(default)]
    status_check_rollup: Vec<PrCheck>,
}

// macOS GUI apps don't inherit the shell PATH, so `git` may not be on PATH.
fn login_shell_output(cmd: &str) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = Command::new(shell).arg("-lc").arg(cmd).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

fn git_bin() -> Option<String> {
    let on_path = Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if on_path {
        return Some("git".into());
    }
    let path = login_shell_output("command -v git")?;
    let path = path.trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

fn git_output(repo: &str, args: &[&str]) -> Result<String, String> {
    let bin = git_bin().ok_or_else(|| "git not found".to_string())?;
    let out = Command::new(&bin)
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
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

fn parse_commit_log(raw: String) -> Vec<CommitEntry> {
    raw.lines()
        .filter_map(|line| {
            let mut fields = line.split('\x1f');
            Some(CommitEntry {
                hash: fields.next()?.to_string(),
                short: fields.next().unwrap_or_default().to_string(),
                subject: fields.next().unwrap_or_default().to_string(),
                date: fields.next().unwrap_or_default().to_string(),
                author: fields.next().unwrap_or_default().to_string(),
            })
        })
        .collect()
}

// Accepts [A-Za-z0-9._/-], rejects `..` and spaces.
fn is_safe_branch(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
}

fn is_git_repo(path: &str) -> bool {
    git_output(path, &["rev-parse", "--git-dir"]).is_ok()
}

fn current_branch(path: &str) -> Result<String, String> {
    let branch = git_output(path, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    if branch.is_empty() || branch == "HEAD" || !is_safe_branch(&branch) {
        return Err("cannot operate on detached HEAD".into());
    }
    Ok(branch)
}

#[tauri::command]
pub async fn git_current_branch(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || current_branch(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn backup_ref_for(path: &str) -> Result<String, String> {
    Ok(format!("refs/bento/backups/{}", current_branch(path)?))
}

fn create_history_backup(path: &str) -> Result<String, String> {
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

fn collect_worktree_diff(path: &str) -> Result<String, String> {
    let mut combined = git_output(path, &["diff", "--no-ext-diff", "HEAD"])?;
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
    Ok(combined)
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
pub async fn git_status(path: String) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_output(&path, &["status", "--porcelain"]).map(parse_status)
    })
    .await
    .map_err(|e| e.to_string())?
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
        // Try local ref first, fall back to origin/ prefix for remote-only branches
        let result = git_output(&path, &["diff", &format!("{base}...HEAD")]);
        if result.is_ok() {
            return result;
        }
        git_output(&path, &["diff", &format!("origin/{base}...HEAD")])
    })
    .await
    .map_err(|e| e.to_string())?
}

// Validates that a commit message is non-empty (trust boundary: frontend input).
fn is_valid_message(msg: &str) -> bool {
    !msg.trim().is_empty()
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

// Returns newline-separated entries: "<hash>\x1f<short>\x1f<subject>\x1f<date>\x1f<author>"
#[tauri::command]
pub async fn git_log(
    path: String,
    limit: u32,
    no_merges: Option<bool>,
) -> Result<Vec<CommitEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let n = limit.clamp(1, 200).to_string();
        let mut args = vec![
            "log".to_string(),
            format!("-{n}"),
            "--format=%H\x1f%h\x1f%s\x1f%ad\x1f%an".to_string(),
            "--date=relative".to_string(),
        ];
        if no_merges.unwrap_or(false) {
            args.push("--no-merges".to_string());
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        git_output(&path, &refs).map(parse_commit_log)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_graph(path: String, base: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_branch(&base) {
            return Err(format!("unsafe base branch: {base}"));
        }
        let base_ref = format!("origin/{base}");
        git_output(
            &path,
            &[
                "log",
                "--graph",
                "--decorate",
                "--oneline",
                "--date-order",
                "--boundary",
                "-100",
                &base_ref,
                "HEAD",
            ],
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

// Returns every non-merge commit owned by the task branch, in the same
// oldest-to-newest order used by `git rebase -i origin/<base>`.
#[tauri::command]
pub async fn git_rebase_log(path: String, base: String) -> Result<Vec<CommitEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_branch(&base) {
            return Err(format!("unsafe base branch: {base}"));
        }
        let target = format!("origin/{base}");
        let range = format!("{target}..HEAD");
        git_output(
            &path,
            &[
                "log",
                "--reverse",
                "--no-merges",
                "--format=%H\x1f%h\x1f%s\x1f%ad\x1f%an",
                "--date=relative",
                &range,
            ],
        )
        .map(parse_commit_log)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_merge_log(path: String, base: String) -> Result<Vec<CommitEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_branch(&base) {
            return Err(format!("unsafe base branch: {base}"));
        }
        let range = format!("origin/{base}..HEAD");
        git_output(
            &path,
            &[
                "log",
                "--reverse",
                "--merges",
                "--format=%H\x1f%h\x1f%s\x1f%ad\x1f%an",
                "--date=relative",
                &range,
            ],
        )
        .map(parse_commit_log)
    })
    .await
    .map_err(|e| e.to_string())?
}

// Returns typed PR metadata or null if no PR / gh is unavailable.
#[tauri::command]
pub async fn git_pr_status(path: String) -> Result<Option<PrStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = Command::new("gh")
            .current_dir(&path)
            .args(["pr", "view", "--json", "state,title,url,number,baseRefName,isDraft,mergeable,reviewDecision,statusCheckRollup"])
            .output();
        let Ok(out) = out else { return Ok(None); };
        if !out.status.success() || out.stdout.is_empty() { return Ok(None); }
        serde_json::from_slice::<PrStatus>(&out.stdout).map(Some).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Diff between any two git refs (e.g. "origin/main" vs "origin/feat/foo").
#[tauri::command]
pub async fn git_ref_diff(path: String, base: String, target: String) -> Result<String, String> {
    if !is_safe_branch(&base) { return Err(format!("unsafe base: {base}")); }
    if !is_safe_branch(&target) { return Err(format!("unsafe target: {target}")); }
    tauri::async_runtime::spawn_blocking(move || {
        if !is_git_repo(&path) { return Err("not a git repository".into()); }
        git_output(&path, &["diff", &format!("{base}...{target}")])
    })
    .await
    .map_err(|e| e.to_string())?
}

// Returns basic PR info (number, title, url) for any branch via gh CLI.
#[tauri::command]
pub async fn gh_pr_view_branch(path: String, branch: String) -> Result<Option<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = Command::new("gh")
            .current_dir(&path)
            .args(["pr", "view", &branch, "--json", "number,title,url"])
            .output();
        let Ok(out) = out else { return Ok(None); };
        if !out.status.success() || out.stdout.is_empty() { return Ok(None); }
        serde_json::from_slice::<serde_json::Value>(&out.stdout).map(Some).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Posts a comment on the PR and returns its URL.
#[tauri::command]
pub async fn gh_pr_comment(path: String, branch: String, body: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = Command::new("gh")
            .current_dir(&path)
            .args(["pr", "comment", &branch, "--body", &body, "--json", "url", "--jq", ".url"])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
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

#[tauri::command]
pub async fn git_create_pr(path: String, base: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_branch(&base) {
            return Err(format!("unsafe base branch: {base}"));
        }
        let out = Command::new("gh")
            .current_dir(&path)
            .args(["pr", "create", "--fill", "--base", &base])
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
        }
        // Fallback: return compare URL so the frontend can open it in the browser.
        if let Ok(remote) = git_output(&path, &["remote", "get-url", "origin"]) {
            let remote = remote.trim().trim_end_matches(".git").to_string();
            let branch =
                git_output(&path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
            let branch = branch.trim().to_string();
            if !remote.is_empty() && !branch.is_empty() {
                return Ok(format!("{remote}/compare/{base}...{branch}?expand=1"));
            }
        }
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Resolves the real git directory for both regular repos and worktrees.
// In a worktree, `.git` is a FILE containing "gitdir: <real-path>"; we read it.
fn resolve_git_dir(path: &str) -> std::path::PathBuf {
    let git_path = Path::new(path).join(".git");
    if git_path.is_file() {
        if let Ok(content) = fs::read_to_string(&git_path) {
            if let Some(gitdir) = content.trim().strip_prefix("gitdir: ") {
                return std::path::PathBuf::from(gitdir.trim());
            }
        }
    }
    git_path
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

// Lists files changed in a commit: returns lines of "<status>\t<file>" (M, A, D, R…).
#[tauri::command]
pub async fn git_show_files(path: String, hash: String) -> Result<Vec<CommitFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_output(
            &path,
            &["diff-tree", "--no-commit-id", "-r", "--name-status", &hash],
        )
        .map(|raw| {
            raw.lines()
                .filter_map(|line| {
                    let mut fields = line.split('\t');
                    let status = fields.next()?.to_string();
                    let paths = fields.map(str::to_string).collect::<Vec<_>>();
                    if paths.is_empty() {
                        None
                    } else {
                        Some(CommitFile { status, paths })
                    }
                })
                .collect()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// Shows the patch introduced by one commit, optionally limited to one file.
#[tauri::command]
pub async fn git_show_commit_diff(
    path: String,
    hash: String,
    file: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = vec![
            "show",
            "--format=",
            "--find-renames",
            "--no-ext-diff",
            &hash,
            "--",
        ];
        if let Some(ref file_path) = file {
            args.push(file_path);
        }
        git_output(&path, &args)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_show_file(path: String, hash: String, file: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if hash.len() < 7 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("invalid commit hash".into());
        }
        let spec = format!("{hash}:{file}");
        match git_output(&path, &["show", &spec]) {
            Ok(content) => Ok(content),
            Err(_) => {
                // Deleted files only exist in the commit's first parent.
                let parent_spec = format!("{hash}^:{file}");
                git_output(&path, &["show", &parent_spec])
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// Scores task commits by how often they appear in the selected files' history.
// Format: full-hash<US>score<US>comma-separated-files
#[tauri::command]
pub async fn git_recommend_commits(
    path: String,
    base: String,
    files: Vec<String>,
) -> Result<Vec<CommitRecommendation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_branch(&base) {
            return Err(format!("unsafe base branch: {base}"));
        }
        let range = format!("origin/{base}..HEAD");
        let mut scores = std::collections::HashMap::<String, (u32, Vec<String>)>::new();
        for file in files.iter().take(200) {
            let history =
                git_output(&path, &["log", "--format=%H", &range, "--", file]).unwrap_or_default();
            for hash in history.lines() {
                let entry = scores.entry(hash.to_string()).or_insert((0, Vec::new()));
                entry.0 += 1;
                if !entry.1.contains(file) {
                    entry.1.push(file.clone());
                }
            }
        }
        let mut rows: Vec<_> = scores.into_iter().collect();
        rows.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
        Ok(rows
            .into_iter()
            .map(|(hash, (score, files))| CommitRecommendation { hash, score, files })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Attributes the original line ranges touched by an incoming patch to task
// commits using git blame. Same output format as git_recommend_commits.
#[tauri::command]
pub async fn git_blame_recommend(
    path: String,
    base: String,
    patch: String,
) -> Result<Vec<CommitRecommendation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_branch(&base) {
            return Err(format!("unsafe base branch: {base}"));
        }
        if patch.len() > 16 * 1024 * 1024 {
            return Err("patch is too large".into());
        }
        let range = format!("origin/{base}..HEAD");
        let allowed: std::collections::HashSet<String> = git_output(&path, &["rev-list", &range])?
            .lines()
            .map(str::to_string)
            .collect();
        let mut current_file = String::new();
        let mut ranges = Vec::<(String, u32, u32)>::new();
        for line in patch.lines() {
            if let Some(rest) = line.strip_prefix("diff --git a/") {
                current_file = rest.split(" b/").next().unwrap_or("").to_string();
            } else if line.starts_with("@@ -") && !current_file.is_empty() {
                let old_spec = line
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("")
                    .trim_start_matches('-');
                let mut values = old_spec.split(',');
                let start = values
                    .next()
                    .and_then(|v| v.parse::<u32>().ok())
                    .unwrap_or(1)
                    .max(1);
                let count = values
                    .next()
                    .and_then(|v| v.parse::<u32>().ok())
                    .unwrap_or(1)
                    .max(1);
                ranges.push((current_file.clone(), start, start.saturating_add(count - 1)));
            }
        }

        let mut scores = std::collections::HashMap::<String, (u32, Vec<String>)>::new();
        for (file, start, end) in ranges.into_iter().take(500) {
            let line_range = format!("{start},{end}");
            let blame = git_output(
                &path,
                &[
                    "blame",
                    "--line-porcelain",
                    "-L",
                    &line_range,
                    "HEAD",
                    "--",
                    &file,
                ],
            )
            .unwrap_or_default();
            for line in blame.lines() {
                let hash = line.split_whitespace().next().unwrap_or("");
                if line.len() >= 41 && hash.len() == 40 && allowed.contains(hash) {
                    let entry = scores.entry(hash.to_string()).or_insert((0, Vec::new()));
                    entry.0 += 1;
                    if !entry.1.contains(&file) {
                        entry.1.push(file.clone());
                    }
                }
            }
        }
        let mut rows: Vec<_> = scores.into_iter().collect();
        rows.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
        Ok(rows
            .into_iter()
            .map(|(hash, (score, files))| CommitRecommendation { hash, score, files })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

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
    use std::path::{Path, PathBuf};

    struct TestRepo(PathBuf);

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn repo(name: &str) -> TestRepo {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("bento-{name}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        run(&path, &["init", "-q"]);
        run(&path, &["config", "user.email", "bento-tests@example.com"]);
        run(&path, &["config", "user.name", "Bento Tests"]);
        TestRepo(path)
    }

    fn run(path: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    fn commit_file(path: &Path, content: &str, message: &str) {
        fs::write(path.join("file.txt"), content).unwrap();
        run(path, &["add", "file.txt"]);
        run(path, &["commit", "-qm", message]);
    }

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

    #[test]
    fn quotes_windows_sequence_editor_for_gits_shell() {
        let path = Path::new(r"C:\Users\Runner Admin\Temp\bento-rebase-editor.cmd");
        assert_eq!(
            sequence_editor_command(path, true),
            "'C:/Users/Runner Admin/Temp/bento-rebase-editor.cmd'"
        );
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

    #[test]
    fn parses_typed_commit_log() {
        let commits = parse_commit_log("abcdef\x1fabc\x1fSubject\x1fnow\x1fAda\n".into());
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].hash, "abcdef");
        assert_eq!(commits[0].subject, "Subject");
        assert_eq!(commits[0].author, "Ada");
    }
}
