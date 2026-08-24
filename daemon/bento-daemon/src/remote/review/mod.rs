mod ask;
mod checkpoints;
mod parse;
mod prompt;

pub use ask::ask_handler;
pub use checkpoints::{
    delete_checkpoint_handler, get_checkpoint_handler,
    list_checkpoints_handler, put_checkpoint_handler,
};

pub use parse::parse_diff_name_status;
#[allow(unused_imports)]
pub use parse::{DiffEntry, parse_diff_stat};

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Json, Response},
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

use super::{Auth, RemoteState, authorized};
use prompt::{build_review_prompt, build_synthesis_prompt};

// ── Query param structs ───────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ReviewQuery {
    pub token: Option<String>,
    pub cwd: Option<String>,
    pub base: Option<String>,
    pub branch: Option<String>,
    pub context: Option<String>,
    pub agents: Option<String>,
}

#[derive(Deserialize)]
pub struct ReviewFileQuery {
    pub token: Option<String>,
    pub cwd: Option<String>,
    pub base: Option<String>,
    pub path: Option<String>,
}

#[derive(Deserialize)]
pub struct PrQuery {
    pub token: Option<String>,
    pub cwd: Option<String>,
    pub pr: Option<u64>,
}

#[derive(Deserialize)]
pub struct PrCommentBody {
    pub body: String,
    #[allow(dead_code)]
    pub file: Option<String>,
    #[allow(dead_code)]
    pub line: Option<u64>,
}

#[derive(Deserialize)]
pub struct PrSubmitBody {
    pub event: String,
    pub body: Option<String>,
}

// ── Shell helpers ─────────────────────────────────────────────────────────────

fn git_cmd(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .args([&["-C", cwd], args].concat())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Like git_cmd but accepts exit code 1 (used by `git diff --no-index` which exits 1 when files differ).
fn git_cmd_exit1_ok(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    let code = out.status.code().unwrap_or(2);
    if code <= 1 {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn untracked_files(cwd: &str) -> Vec<String> {
    git_cmd(cwd, &["ls-files", "--others", "--exclude-standard"])
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

fn diff_no_index(cwd: &str, path: &str) -> String {
    git_cmd_exit1_ok(cwd, &["diff", "--no-index", "--", "/dev/null", path])
        .unwrap_or_default()
}

fn gh_cmd(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("gh")
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

/// A client-supplied git ref used as a `git diff` argument. Rejects flag-injection
/// (`--upload-pack=...`) and range syntax (`..`), matching the desktop equivalent
/// (`src-tauri/src/git.rs::is_safe_branch`).
fn is_safe_branch(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
}

/// A client-supplied file path used to read file contents off disk. Rejects
/// absolute paths and `..` segments so it can't escape `cwd`.
fn is_safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.split('/').any(|seg| seg == "..")
}

// ── /api/review (SSE) ─────────────────────────────────────────────────────────

pub async fn review_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<ReviewQuery>,
) -> Response {
    let auth = Auth { token: q.token };
    if !authorized(&state, &auth) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd {
        Some(c) if !c.is_empty() => c,
        _ => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let base = q.base.unwrap_or_else(|| "main".into());
    if !is_safe_branch(&base) {
        return (StatusCode::BAD_REQUEST, "unsafe base").into_response();
    }
    let branch = q.branch.filter(|s| !s.is_empty());
    if let Some(ref br) = branch {
        if !is_safe_branch(br) {
            return (StatusCode::BAD_REQUEST, "unsafe branch").into_response();
        }
    }
    let context = q.context.unwrap_or_default();
    let agents = parse_agents(q.agents.as_deref().unwrap_or(""));

    let (tx, rx) = tokio::sync::mpsc::channel::<String>(64);
    tokio::spawn(async move {
        run_review(cwd, base, branch, context, agents, tx).await;
    });

    let stream = tokio_stream::wrappers::ReceiverStream::new(rx)
        .map(|chunk| -> Result<axum::body::Bytes, std::convert::Infallible> {
            let encoded = serde_json::to_string(&chunk).unwrap_or_else(|_| "\"\"".to_string());
            Ok(axum::body::Bytes::from(format!("data: {}\n\n", encoded)))
        });

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("X-Accel-Buffering", "no")
        .body(Body::from_stream(stream))
        .unwrap()
}

fn parse_agents(raw: &str) -> Vec<String> {
    let filtered: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|s| matches!(*s, "claude" | "opencode" | "codex"))
        .map(String::from)
        .collect();
    if filtered.is_empty() { vec!["claude".to_string()] } else { filtered }
}

async fn run_review(cwd: String, base: String, branch: Option<String>, context: String, agents: Vec<String>, tx: tokio::sync::mpsc::Sender<String>) {
    let send = |msg: String| {
        let tx = tx.clone();
        async move { let _ = tx.send(msg).await; }
    };

    // When a specific branch is given, diff that branch vs base (committed changes only).
    // Otherwise diff the working tree vs base and also include untracked files.
    let diff_out = if let Some(ref br) = branch {
        let range = format!("{}..{}", base, br);
        match tokio::process::Command::new("git")
            .args(["-C", &cwd, "diff", &range])
            .output()
            .await
        {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
            Ok(o) => {
                send(format!("[ERROR] git diff falló: {}", String::from_utf8_lossy(&o.stderr).trim())).await;
                return;
            }
            Err(e) => { send(format!("[ERROR] no se pudo ejecutar git: {e}")).await; return; }
        }
    } else {
        let tracked_diff = match tokio::process::Command::new("git")
            .args(["-C", &cwd, "diff", &base])
            .output()
            .await
        {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
            Ok(o) => {
                send(format!("[ERROR] git diff falló: {}", String::from_utf8_lossy(&o.stderr).trim())).await;
                return;
            }
            Err(e) => { send(format!("[ERROR] no se pudo ejecutar git: {e}")).await; return; }
        };

        let cwd_clone = cwd.clone();
        let untracked_diff = tokio::task::spawn_blocking(move || {
            untracked_files(&cwd_clone)
                .into_iter()
                .map(|p| diff_no_index(&cwd_clone, &p))
                .filter(|d| !d.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .await
        .unwrap_or_default();

        if untracked_diff.is_empty() { tracked_diff } else { format!("{tracked_diff}\n{untracked_diff}") }
    };

    if diff_out.trim().is_empty() {
        send("[ERROR] No hay cambios respecto a la rama base.".into()).await;
        return;
    }

    let is_multi_agent = agents.len() > 1;
    let mut reports: Vec<(String, String)> = Vec::new();

    if is_multi_agent {
        let total = agents.len();
        for (i, agent) in agents.iter().enumerate() {
            send(format!("[BATCH:{}/{}]", i + 1, total)).await;
            let review_prompt = build_review_prompt(&cwd, &base, &diff_out, &context);
            match run_agent_collecting(agent, &cwd, &review_prompt, &tx).await {
                Some((report, _)) => reports.push((format!("Agente {}/{} ({})", i + 1, total, agent), report)),
                None => { send(format!("[ERROR] {} no encontrado o falló", agent)).await; return; }
            }
        }
        if reports.len() >= 2 {
            send("[SYNTHESIS]".into()).await;
            let truncated: Vec<(String, String)> = reports.iter()
                .map(|(l, r)| (l.clone(), r.chars().take(8_000).collect()))
                .collect();
            let refs: Vec<(&str, &str)> = truncated.iter().map(|(l, r)| (l.as_str(), r.as_str())).collect();
            let synthesis = build_synthesis_prompt(
                &refs,
                "Escribe el informe final directamente, sin preámbulo. Empieza con:\n\n## Corrección y lógica",
            );
            let last_agent = agents.last().unwrap();
            match run_agent_collecting(last_agent, &cwd, &synthesis, &tx).await {
                None => { send("[ERROR] síntesis falló".into()).await; return; }
                Some((_, sid)) => {
                    if let Some(id) = sid {
                        send(format!("[SESSION:{}:{}]", last_agent, id)).await;
                    }
                }
            }
        }
    } else {
        let agent = &agents[0];
        let file_diffs = parse::split_diff_into_file_diffs(&diff_out);
        let batches = parse::batch_file_diffs(file_diffs, 60_000);
        let total = batches.len();
        let mut last_session_id: Option<String> = None;
        for (i, batch_diff) in batches.into_iter().enumerate() {
            let label = format!("Batch {}/{}", i + 1, total);
            send(format!("[BATCH:{}/{}]", i + 1, total)).await;
            let review_prompt = build_review_prompt(&cwd, &base, &batch_diff, &context);
            match run_agent_collecting(agent, &cwd, &review_prompt, &tx).await {
                Some((report, sid)) => {
                    if let Some(id) = sid { last_session_id = Some(id); }
                    reports.push((label, report));
                }
                None => { send(format!("[ERROR] {} no encontrado o falló", agent)).await; return; }
            }
        }
        if total > 1 {
            send("[SYNTHESIS]".into()).await;
            let truncated: Vec<(String, String)> = reports.iter()
                .map(|(l, r)| (l.clone(), r.chars().take(8_000).collect()))
                .collect();
            let refs: Vec<(&str, &str)> = truncated.iter().map(|(l, r)| (l.as_str(), r.as_str())).collect();
            let synthesis = build_synthesis_prompt(
                &refs,
                "Escribe el informe final directamente, sin preámbulo. Empieza con:\n\n## Corrección y lógica",
            );
            match run_agent_collecting(agent, &cwd, &synthesis, &tx).await {
                None => { send("[ERROR] síntesis falló".into()).await; return; }
                Some((_, sid)) => {
                    if let Some(id) = sid { last_session_id = Some(id); }
                }
            }
        }
        if let Some(id) = last_session_id {
            send(format!("[SESSION:{}:{}]", agent, id)).await;
        }
    }

    send("[DONE]".into()).await;
}

// Returns (collected_text, session_id). session_id is Some only for the synthesis/last agent.
pub(super) async fn run_agent_collecting(
    agent: &str,
    cwd: &str,
    prompt: &str,
    tx: &tokio::sync::mpsc::Sender<String>,
) -> Option<(String, Option<String>)> {
    match agent {
        "opencode" => run_opencode_collecting(cwd, prompt, tx).await,
        "codex" => run_codex_collecting(cwd, prompt, tx).await,
        _ => run_claude_collecting(prompt, tx).await,
    }
}

async fn run_opencode_collecting(
    cwd: &str,
    prompt: &str,
    tx: &tokio::sync::mpsc::Sender<String>,
) -> Option<(String, Option<String>)> {
    let launch_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let mut child = tokio::process::Command::new("opencode")
        .args(["run", "--format", "json", "--dir", cwd, prompt])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    let stdout = child.stdout.take()?;
    let mut collected = String::new();

    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match tokio::time::timeout(
            std::time::Duration::from_secs(300),
            lines.next_line(),
        ).await {
            Ok(Ok(Some(line))) => {
                let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                let event_type = val.get("type").and_then(serde_json::Value::as_str).unwrap_or("");
                if event_type != "text" { continue; }
                let text = val
                    .get("part")
                    .and_then(|p| p.get("text"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                if text.is_empty() { continue; }
                if tx.send(text.to_string()).await.is_err() {
                    let _ = child.kill().await;
                    return None;
                }
                collected.push_str(text);
            }
            Ok(Ok(None)) => break,
            Ok(Err(_)) | Err(_) => {
                let _ = child.kill().await;
                return None;
            }
        }
    }
    let _ = child.wait().await;
    let session_id = find_opencode_session(cwd, launch_ms).await;
    Some((collected, session_id))
}

async fn find_opencode_session(cwd: &str, since_ms: u64) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let db = std::path::PathBuf::from(home).join(".local/share/opencode/opencode.db");
    let query = format!(
        "SELECT id FROM session WHERE directory='{}' AND time_created>{} ORDER BY time_created DESC LIMIT 1",
        cwd.replace('\'', "''"),
        since_ms
    );
    let out = tokio::process::Command::new("sqlite3")
        .args([db.to_str()?, &query])
        .output()
        .await
        .ok()?;
    if !out.status.success() { return None; }
    let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if id.is_empty() { None } else { Some(id) }
}

async fn run_codex_collecting(
    cwd: &str,
    prompt: &str,
    tx: &tokio::sync::mpsc::Sender<String>,
) -> Option<(String, Option<String>)> {
    let mut child = tokio::process::Command::new("codex")
        .args(["exec", "--sandbox", "read-only", "--cd", cwd, "--json", "--skip-git-repo-check", prompt])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    let stdout = child.stdout.take()?;
    let mut collected = String::new();
    let mut session_id: Option<String> = None;

    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match tokio::time::timeout(
            std::time::Duration::from_secs(300),
            lines.next_line(),
        ).await {
            Ok(Ok(Some(line))) => {
                let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                let event_type = val.get("type").and_then(serde_json::Value::as_str).unwrap_or("");

                if event_type == "session_meta" {
                    if let Some(id) = val.get("payload").and_then(|p| p.get("id")).and_then(serde_json::Value::as_str) {
                        session_id = Some(id.to_string());
                    }
                    continue;
                }

                if event_type != "item.completed" { continue; }
                let Some(item) = val.get("item") else { continue };
                let item_type = item.get("type").and_then(serde_json::Value::as_str).unwrap_or("");
                if item_type != "agent_message" { continue; }
                let text = item.get("text").and_then(serde_json::Value::as_str).unwrap_or("");
                if text.is_empty() { continue; }
                if tx.send(text.to_string()).await.is_err() {
                    let _ = child.kill().await;
                    return None;
                }
                collected.push_str(text);
            }
            Ok(Ok(None)) => break,
            Ok(Err(_)) | Err(_) => {
                let _ = child.kill().await;
                return None;
            }
        }
    }
    let _ = child.wait().await;
    Some((collected, session_id))
}

async fn run_claude_collecting(
    prompt: &str,
    tx: &tokio::sync::mpsc::Sender<String>,
) -> Option<(String, Option<String>)> {
    let mut child = tokio::process::Command::new("claude")
        .args(["-p", prompt, "--output-format", "stream-json", "--verbose"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    let stdout = child.stdout.take()?;
    let mut collected = String::new();
    let mut session_id: Option<String> = None;

    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match tokio::time::timeout(
            std::time::Duration::from_secs(300),
            lines.next_line(),
        ).await {
            Ok(Ok(Some(line))) => {
                let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                let event_type = val.get("type").and_then(serde_json::Value::as_str).unwrap_or("");

                // Capture session ID from the init system event
                if event_type == "system" {
                    if val.get("subtype").and_then(serde_json::Value::as_str) == Some("init") {
                        if let Some(id) = val.get("session_id").and_then(serde_json::Value::as_str) {
                            session_id = Some(id.to_string());
                        }
                    }
                    continue;
                }

                // Streaming deltas — primary source of live text
                if event_type == "content_block_delta" {
                    let text = val
                        .get("delta")
                        .and_then(|d| d.get("text"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("");
                    if text.is_empty() { continue; }
                    if tx.send(text.to_string()).await.is_err() {
                        let _ = child.kill().await;
                        return None;
                    }
                    collected.push_str(text);
                    continue;
                }

                // Final assistant message — fallback if no deltas were received
                if event_type == "assistant" && collected.is_empty() {
                    let Some(content) = val
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(|c| c.as_array())
                    else { continue };
                    for block in content {
                        let is_text = block.get("type").and_then(serde_json::Value::as_str) == Some("text");
                        let text = block.get("text").and_then(serde_json::Value::as_str).unwrap_or("");
                        if !is_text || text.is_empty() { continue; }
                        if tx.send(text.to_string()).await.is_err() {
                            let _ = child.kill().await;
                            return None;
                        }
                        collected.push_str(text);
                    }
                }
            }
            Ok(Ok(None)) => break, // EOF
            Ok(Err(_)) | Err(_) => {
                let _ = child.kill().await;
                return None;
            }
        }
    }
    let _ = child.wait().await;
    Some((collected, session_id))
}

// ── /api/review/files ─────────────────────────────────────────────────────────

pub async fn review_files_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<ReviewFileQuery>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let base = q.base.unwrap_or_else(|| "main".into());
    if !is_safe_branch(&base) {
        return (StatusCode::BAD_REQUEST, "unsafe base").into_response();
    }

    let name_status = match git_cmd(&cwd, &["diff", "--name-status", &base]) {
        Ok(o) => o,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };
    let numstat = git_cmd(&cwd, &["diff", "--numstat", &base]).unwrap_or_default();

    let entries = parse_diff_name_status(&name_status);
    let stats: std::collections::HashMap<String, (i64, i64)> = numstat
        .lines()
        .filter_map(|l| {
            let mut p = l.splitn(3, '\t');
            let a: i64 = p.next()?.parse().unwrap_or(0);
            let d: i64 = p.next()?.parse().unwrap_or(0);
            let path = p.next()?.trim().to_string();
            Some((path, (a, d)))
        })
        .collect();

    let mut list: Vec<_> = entries
        .into_iter()
        .map(|e| {
            let (added, deleted) = stats.get(&e.path).copied().unwrap_or((0, 0));
            let mut v = json!({ "status": e.status, "path": e.path, "added": added, "deleted": deleted });
            if let Some(old) = e.old_path { v["old_path"] = json!(old); }
            v
        })
        .collect();

    // Append untracked (new) files not visible to `git diff`
    for path in untracked_files(&cwd) {
        list.push(json!({ "status": "A", "path": path, "added": 0, "deleted": 0 }));
    }

    Json(list).into_response()
}

// ── /api/review/file ──────────────────────────────────────────────────────────

pub async fn review_file_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<ReviewFileQuery>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let path = match q.path.filter(|s| !s.is_empty()) {
        Some(p) => p,
        None => return (StatusCode::BAD_REQUEST, "missing path").into_response(),
    };
    if !is_safe_relative_path(&path) {
        return (StatusCode::BAD_REQUEST, "unsafe path").into_response();
    }
    let base = q.base.unwrap_or_else(|| "main".into());
    if !is_safe_branch(&base) {
        return (StatusCode::BAD_REQUEST, "unsafe base").into_response();
    }

    let diff = git_cmd(&cwd, &["diff", &base, "--", &path]).unwrap_or_default();
    if !diff.is_empty() {
        return (StatusCode::OK, [("content-type", "text/plain")], diff).into_response();
    }
    // Untracked new file — show as fully-added diff
    let new_diff = diff_no_index(&cwd, &path);
    (StatusCode::OK, [("content-type", "text/plain")], new_diff).into_response()
}

// ── /api/review/prs ───────────────────────────────────────────────────────────

pub async fn review_prs_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<PrQuery>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    match gh_cmd(&cwd, &["pr", "list", "--state", "open", "--json", "number,title,url,headRefName,author"]) {
        Ok(json_str) => (StatusCode::OK, [("content-type", "application/json")], json_str).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ── /api/review/pr/diff ───────────────────────────────────────────────────────

pub async fn review_pr_diff_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<PrQuery>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let pr = match q.pr {
        Some(n) => n.to_string(),
        None => return (StatusCode::BAD_REQUEST, "missing pr").into_response(),
    };
    match gh_cmd(&cwd, &["pr", "diff", &pr]) {
        Ok(diff) => (StatusCode::OK, [("content-type", "text/plain")], diff).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ── /api/review/pr/comments ───────────────────────────────────────────────────

pub async fn review_pr_comments_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<PrQuery>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let pr = match q.pr {
        Some(n) => n.to_string(),
        None => return (StatusCode::BAD_REQUEST, "missing pr").into_response(),
    };
    match gh_cmd(&cwd, &["pr", "view", &pr, "--json", "comments,reviews"]) {
        Ok(json_str) => (StatusCode::OK, [("content-type", "application/json")], json_str).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ── /api/review/pr/comment (POST) ────────────────────────────────────────────

pub async fn review_pr_add_comment_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<PrQuery>,
    axum::Json(body): axum::Json<PrCommentBody>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let pr = match q.pr {
        Some(n) => n.to_string(),
        None => return (StatusCode::BAD_REQUEST, "missing pr").into_response(),
    };
    match gh_cmd(&cwd, &["pr", "comment", &pr, "--body", &body.body]) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ── PR comment ownership check ────────────────────────────────────────────────

/// Compares a comment's `issue_url` (as returned by the GitHub API) against the
/// PR number the client claims to be editing, so a valid token for one PR can't
/// be used to edit/delete a comment on an unrelated issue/PR in the same repo.
fn issue_url_matches_pr(issue_url: &str, pr: u64) -> bool {
    issue_url.trim().ends_with(&format!("/issues/{pr}"))
}

fn comment_belongs_to_pr(cwd: &str, id: u64, pr: u64) -> Result<bool, String> {
    let endpoint = format!("repos/{{owner}}/{{repo}}/issues/comments/{id}");
    let issue_url = gh_cmd(cwd, &["api", &endpoint, "--jq", ".issue_url"])?;
    Ok(issue_url_matches_pr(&issue_url, pr))
}

// ── /api/review/pr/comment/:id (PUT) ─────────────────────────────────────────

pub async fn review_pr_update_comment_handler(
    State(state): State<Arc<RemoteState>>,
    Path(id): Path<u64>,
    Query(q): Query<PrQuery>,
    axum::Json(body): axum::Json<PrCommentBody>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let pr = match q.pr {
        Some(n) => n,
        None => return (StatusCode::BAD_REQUEST, "missing pr").into_response(),
    };
    match comment_belongs_to_pr(&cwd, id, pr) {
        Ok(true) => {}
        Ok(false) => return (StatusCode::FORBIDDEN, "comment does not belong to pr").into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
    let endpoint = format!("repos/{{owner}}/{{repo}}/issues/comments/{id}");
    match gh_cmd(&cwd, &["api", &endpoint, "-X", "PATCH", "-f", &format!("body={}", body.body)]) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ── /api/review/pr/comment/:id (DELETE) ──────────────────────────────────────

pub async fn review_pr_delete_comment_handler(
    State(state): State<Arc<RemoteState>>,
    Path(id): Path<u64>,
    Query(q): Query<PrQuery>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let pr = match q.pr {
        Some(n) => n,
        None => return (StatusCode::BAD_REQUEST, "missing pr").into_response(),
    };
    match comment_belongs_to_pr(&cwd, id, pr) {
        Ok(true) => {}
        Ok(false) => return (StatusCode::FORBIDDEN, "comment does not belong to pr").into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
    let endpoint = format!("repos/{{owner}}/{{repo}}/issues/comments/{id}");
    match gh_cmd(&cwd, &["api", &endpoint, "-X", "DELETE"]) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ── /api/review/pr/submit (POST) ─────────────────────────────────────────────

pub async fn review_pr_submit_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<PrQuery>,
    axum::Json(body): axum::Json<PrSubmitBody>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    let pr = match q.pr {
        Some(n) => n.to_string(),
        None => return (StatusCode::BAD_REQUEST, "missing pr").into_response(),
    };
    let event_flag = match body.event.to_uppercase().as_str() {
        "APPROVE" => "--approve",
        "REQUEST_CHANGES" => "--request-changes",
        _ => "--comment",
    };
    let mut args = vec!["pr", "review", &pr, event_flag];
    let comment_body;
    if let Some(ref b) = body.body {
        comment_body = b.clone();
        args.extend_from_slice(&["--body", &comment_body]);
    }
    match gh_cmd(&cwd, &args) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ── /api/review/branches ──────────────────────────────────────────────────────

/// Shared by the HTTP `/api/review/branches` handler and the daemon's
/// lightweight IPC socket (`review.branches`), which has no HTTP/axum
/// layer to go through — the actual work here never touched `RemoteState`
/// or `authorized()` in the first place (those are the network-exposed
/// phone-remote server's own concerns).
pub(crate) fn list_branches(cwd: &str) -> Vec<String> {
    git_cmd(
        cwd,
        &["branch", "--sort=-committerdate", "--format=%(refname:short)"],
    )
    .unwrap_or_default()
    .lines()
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .take(20)
    .map(String::from)
    .collect()
}

pub async fn review_branches_handler(
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<PrQuery>,
) -> impl IntoResponse {
    if !authorized(&state, &Auth { token: q.token }) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let cwd = match q.cwd.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return (StatusCode::BAD_REQUEST, "missing cwd").into_response(),
    };
    Json(list_branches(&cwd)).into_response()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_safe_branch ─────────────────────────────────────────────────────────

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

    // ── is_safe_relative_path ─────────────────────────────────────────────────

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

    // ── issue_url_matches_pr ──────────────────────────────────────────────────

    #[test]
    fn issue_url_matches_pr_accepts_matching_pr() {
        assert!(issue_url_matches_pr(
            "https://api.github.com/repos/acme/widget/issues/42",
            42
        ));
    }

    #[test]
    fn issue_url_matches_pr_rejects_other_pr() {
        assert!(!issue_url_matches_pr(
            "https://api.github.com/repos/acme/widget/issues/42",
            41
        ));
        assert!(!issue_url_matches_pr(
            "https://api.github.com/repos/acme/widget/issues/423",
            42
        ));
    }
}
