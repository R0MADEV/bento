//! Los comandos de review que expone la app: checkpoints, prompts y el
//! contexto de rama. La lógica vive en `worktree` y en la crate compartida
//! `bento-review`.

pub mod run;
mod worktree;

use std::collections::{hash_map::DefaultHasher, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use tokio::process::Command as AsyncCommand;

pub(crate) use worktree::{is_managed_review_worktree, set_review_worktree_writable};
use worktree::ReviewBranchContext;
pub(crate) use worktree::release_managed_context_path;
use worktree::{git_output, normalize_review_path, prepare_branch_context, validate_finding_path};

#[tauri::command]
pub fn review_checkpoint_save(
    cwd: String,
    base: String,
    content: String,
    branch: Option<String>,
    commit: Option<String>,
    session_id: Option<String>,
    session_agent: Option<String>,
) -> Result<(), String> {
    if content.trim().is_empty() {
        return Err("empty checkpoint".into());
    }
    bento_review::checkpoints::save_checkpoint(&bento_review::checkpoints::Checkpoint {
        cwd,
        base,
        content,
        saved_at: bento_review::checkpoints::now_iso8601(),
        session_id,
        session_agent,
        branch,
        commit,
    })
}

#[tauri::command]
pub fn review_checkpoint_get(cwd: String, base: String) -> Option<bento_review::checkpoints::Checkpoint> {
    bento_review::checkpoints::get_checkpoint(&cwd, &base)
}

#[tauri::command]
pub fn review_checkpoints_list(cwd: String) -> Vec<bento_review::checkpoints::CheckpointMeta> {
    bento_review::checkpoints::list_checkpoint_metas(&cwd)
}

#[tauri::command]
pub fn review_checkpoint_delete(cwd: String, base: String) -> Result<(), String> {
    bento_review::checkpoints::delete_checkpoint(&cwd, &base)
}

/// El documento de la review, con quién falló y con quién se sigue hablando.
/// Todo vive en `bento_review::report`, compartido con el daemon y el CLI.
#[tauri::command]
pub fn review_build_document(
    meta: bento_review::report::ReviewDocumentMeta,
    runs: Vec<bento_review::report::ReviewRun>,
) -> String {
    bento_review::report::build_document(&meta, &runs)
}

#[tauri::command]
pub fn review_follow_up_session(
    runs: Vec<bento_review::report::ReviewRun>,
    count: usize,
) -> bento_review::report::FollowUpSession {
    bento_review::report::follow_up_session(&runs, count)
}

/// Lo primero que lee el agente: de dónde sale el cambio y qué ficheros toca.
#[tauri::command]
pub fn review_build_overview(input: bento_review::report::OverviewInput) -> String {
    bento_review::report::build_overview(&input)
}

/// Si un fallo del agente merece un reintento. La lista de fallos pasajeros
/// estaba duplicada en TypeScript y ya había divergido.
#[tauri::command]
pub fn review_is_retryable(message: String) -> bool {
    bento_review::agents::is_retryable(&message)
}


#[tauri::command]
pub async fn review_branch_context_prepare(
    repo_path: String,
    reference: String,
    commit: Option<String>,
) -> Result<ReviewBranchContext, String> {
    tokio::task::spawn_blocking(move || {
        prepare_branch_context(&repo_path, &reference, commit.as_deref(), false)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn review_branch_context_update(
    repo_path: String,
    reference: String,
) -> Result<ReviewBranchContext, String> {
    tokio::task::spawn_blocking(move || prepare_branch_context(&repo_path, &reference, None, false))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn review_branch_context_check(
    repo_path: String,
    reference: String,
    commit: String,
) -> Result<ReviewBranchContext, String> {
    tokio::task::spawn_blocking(move || {
        prepare_branch_context(&repo_path, &reference, Some(&commit), true)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn review_branch_context_release(
    path: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || release_managed_context_path(&PathBuf::from(path)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn review_validate_finding_path(
    repo_path: String,
    relative: String,
    deleted_files: Vec<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let allowed_deleted = deleted_files.into_iter().filter_map(|path| normalize_review_path(&path).ok()).collect::<HashSet<_>>();
        validate_finding_path(
            &PathBuf::from(repo_path)
                .canonicalize()
                .map_err(|e| e.to_string())?,
            &relative,
            &allowed_deleted,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn review_lexis_context(path: String, question: String) -> Result<String, String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        AsyncCommand::new("lexis")
            .args([
                "ask", "--path", &path, "--lang", "en", "--depth", "2", "--topk", "5", &question,
            ])
            .output(),
    )
    .await
    .map_err(|_| "lexis context timeout".to_string())?
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Ok(String::new());
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(text.chars().take(12_000).collect())
}

#[tauri::command]
pub async fn review_snapshot(repo_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let repo = PathBuf::from(repo_path)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let mut input = git_output(&repo, &["diff", "HEAD", "--binary"])?;
        input.push_str(&git_output(&repo, &["status", "--porcelain"])?);
        input.push_str(&git_output(&repo, &["ls-files"])?);
        let untracked = git_output(&repo, &["ls-files", "--others", "--exclude-standard"])?;
        for file in untracked.lines().filter(|line| !line.is_empty()) {
            input.push_str(file);
            input.push_str(&fs::read_to_string(repo.join(file)).unwrap_or_default());
        }
        let mut hasher = DefaultHasher::new();
        input.hash(&mut hasher);
        Ok(format!("{:016x}", hasher.finish()))
    })
    .await
    .map_err(|e| e.to_string())?
}
