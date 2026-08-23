use super::*;


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

// Diff between any two git refs (e.g. "origin/main" vs "origin/feat/foo").
#[tauri::command]
pub async fn git_ref_diff(path: String, base: String, target: String) -> Result<String, String> {
    if !is_safe_branch(&base) {
        return Err(format!("unsafe base: {base}"));
    }
    if !is_safe_branch(&target) {
        return Err(format!("unsafe target: {target}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        if !is_git_repo(&path) {
            return Err("not a git repository".into());
        }
        diff_between_refs(&path, &base, &target)
    })
    .await
    .map_err(|e| e.to_string())?
}

// Resolves a git ref to its full SHA.
#[tauri::command]
pub async fn git_rev_parse(path: String, reference: String) -> Result<String, String> {
    if reference.starts_with('-') {
        return Err(format!("invalid git reference: {reference}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        if !is_git_repo(&path) {
            return Err("not a git repository".into());
        }
        git_output(&path, &["rev-parse", &reference]).map(|s| s.trim().to_string())
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


#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;

    #[test]
    fn parses_typed_commit_log() {
        let commits = parse_commit_log("abcdef\x1fabc\x1fSubject\x1fnow\x1fAda\n".into());
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].hash, "abcdef");
        assert_eq!(commits[0].subject, "Subject");
        assert_eq!(commits[0].author, "Ada");
    }
}
