use super::*;


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

// Returns PR info for any branch via gh CLI.
#[tauri::command]
pub async fn gh_pr_view_branch(
    path: String,
    branch: String,
) -> Result<Option<serde_json::Value>, String> {
    if !is_safe_branch(&branch) {
        return Err(format!("unsafe branch: {branch}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let out = Command::new("gh")
            .current_dir(&path)
            .args([
                "pr",
                "view",
                &branch,
                "--json",
                "number,title,url,body,state,mergedAt,statusCheckRollup,reviewDecision",
            ])
            .output();
        let Ok(out) = out else {
            return Ok(None);
        };
        if !out.status.success() || out.stdout.is_empty() {
            return Ok(None);
        }
        serde_json::from_slice::<serde_json::Value>(&out.stdout)
            .map(Some)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn gh_pr_diff_number(
    path: String,
    pr_number: i64,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = Command::new("gh")
            .current_dir(&path)
            .args(["pr", "diff", &pr_number.to_string(), "--color=never"])
            .output();
        let Ok(out) = out else {
            return Ok(String::new());
        };
        if !out.status.success() {
            return Ok(String::new());
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Fetches PR discussion: general comments + review submissions (with body).
#[tauri::command]
pub async fn gh_pr_list_discussion(
    path: String,
    pr_number: i64,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let comments = std::process::Command::new("gh")
            .current_dir(&path)
            .args([
                "api",
                "--paginate",
                &format!("repos/{{owner}}/{{repo}}/issues/{}/comments", pr_number),
            ])
            .output()
            .ok()
            .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok())
            .unwrap_or(serde_json::Value::Array(vec![]));
        let reviews = std::process::Command::new("gh")
            .current_dir(&path)
            .args([
                "api",
                &format!("repos/{{owner}}/{{repo}}/pulls/{}/reviews", pr_number),
            ])
            .output()
            .ok()
            .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok())
            .unwrap_or(serde_json::Value::Array(vec![]));
        Ok(serde_json::json!({ "comments": comments, "reviews": reviews }))
    })
    .await
    .map_err(|e| e.to_string())?
}

// Posts a comment on the PR and returns its URL.
#[tauri::command]
pub async fn gh_pr_comment(path: String, branch: String, body: String) -> Result<String, String> {
    if !is_safe_branch(&branch) {
        return Err(format!("unsafe branch: {branch}"));
    }
    if body.len() > 65_536 {
        return Err("comment body exceeds maximum length".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Resolve PR number from branch so we can use the REST API (gh pr comment
        // does not support --json/--jq, but gh api returns html_url).
        let num_out = Command::new("gh")
            .current_dir(&path)
            .args(["pr", "view", &branch, "--json", "number", "--jq", ".number"])
            .output()
            .map_err(|e| e.to_string())?;
        if !num_out.status.success() {
            return Err(String::from_utf8_lossy(&num_out.stderr).trim().to_string());
        }
        let pr_number = String::from_utf8_lossy(&num_out.stdout).trim().to_string();
        let endpoint = format!("repos/{{owner}}/{{repo}}/issues/{pr_number}/comments");
        let out = Command::new("gh")
            .current_dir(&path)
            .args([
                "api",
                "--method",
                "POST",
                &endpoint,
                "-f",
                &format!("body={body}"),
                "--jq",
                ".html_url",
            ])
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

// Posts an inline review comment on a specific file+line via gh api.
#[tauri::command]
pub async fn gh_pr_inline_comment(
    path: String,
    pr_number: u64,
    commit_id: String,
    file: String,
    line: u64,
    start_line: Option<u64>,
    body: String,
) -> Result<String, String> {
    if line == 0 {
        return Err("line must be >= 1".into());
    }
    if body.len() > 65_536 {
        return Err("comment body exceeds maximum length".into());
    }
    let is_valid_sha = !commit_id.is_empty()
        && commit_id.len() <= 40
        && commit_id.chars().all(|c| c.is_ascii_hexdigit());
    if !is_valid_sha {
        return Err(format!("invalid commit SHA: {commit_id}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        if !is_git_repo(&path) {
            return Err("not a git repository".into());
        }
        let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/{pr_number}/comments");
        let mut args = vec![
            "api".to_string(),
            endpoint,
            "-f".to_string(),
            format!("body={body}"),
            "-f".to_string(),
            format!("commit_id={commit_id}"),
            "-f".to_string(),
            format!("path={file}"),
            "-F".to_string(),
            format!("line={line}"),
            "-f".to_string(),
            "side=RIGHT".to_string(),
        ];
        if let Some(sl) = start_line {
            if sl < line {
                args.extend([
                    "-F".to_string(),
                    format!("start_line={sl}"),
                    "-f".to_string(),
                    "start_side=RIGHT".to_string(),
                ]);
            }
        }
        args.extend(["--jq".to_string(), ".html_url".to_string()]);
        let out = Command::new("gh")
            .current_dir(&path)
            .args(&args)
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

// Returns open pull requests for the repo (up to 30).
#[tauri::command]
pub async fn gh_pr_list_open(path: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = Command::new("gh")
            .current_dir(&path)
            .args([
                "pr",
                "list",
                "--json",
                "number,title,author,headRefName,baseRefName,url",
                "--limit",
                "30",
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        serde_json::from_slice::<serde_json::Value>(&out.stdout).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Edits an existing PR review comment.
#[tauri::command]
pub async fn gh_pr_update_comment(
    path: String,
    comment_id: u64,
    body: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/comments/{comment_id}");
        let out = Command::new("gh")
            .current_dir(&path)
            .args([
                "api",
                "--method",
                "PATCH",
                &endpoint,
                "-f",
                &format!("body={body}"),
            ])
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

// Deletes a PR review comment.
#[tauri::command]
pub async fn gh_pr_delete_comment(path: String, comment_id: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/comments/{comment_id}");
        let out = Command::new("gh")
            .current_dir(&path)
            .args(["api", "--method", "DELETE", &endpoint])
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

// Replies to an existing PR review comment thread.
#[tauri::command]
pub async fn gh_pr_reply_comment(
    path: String,
    comment_id: u64,
    body: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/comments/{comment_id}/replies");
        let out = Command::new("gh")
            .current_dir(&path)
            .args([
                "api",
                "--method",
                "POST",
                &endpoint,
                "-f",
                &format!("body={body}"),
                "--jq",
                ".html_url",
            ])
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

// Returns all inline review comments for a PR as a JSON array.
#[tauri::command]
pub async fn gh_pr_list_comments(
    path: String,
    pr_number: u64,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/{pr_number}/comments");
        let out = Command::new("gh")
            .current_dir(&path)
            .args(["api", "--paginate", &endpoint])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        serde_json::from_slice::<serde_json::Value>(&out.stdout).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Submits a pull request review (APPROVE / REQUEST_CHANGES / COMMENT).
#[tauri::command]
pub async fn gh_pr_submit_review(
    path: String,
    pr_number: u64,
    event: String,
    body: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let valid_events = ["APPROVE", "REQUEST_CHANGES", "COMMENT"];
        if !valid_events.contains(&event.as_str()) {
            return Err(format!("invalid review event: {event}"));
        }
        let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/{pr_number}/reviews");
        let out = Command::new("gh")
            .current_dir(&path)
            .args([
                "api",
                "--method",
                "POST",
                &endpoint,
                "-f",
                &format!("event={event}"),
                "-f",
                &format!("body={body}"),
                "--jq",
                ".html_url",
            ])
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
