//! Los comandos de review que expone la app: checkpoints, prompts y el
//! contexto de rama. La lógica vive en `worktree` y en la crate compartida
//! `bento-review`.

pub mod run;
mod worktree;

use std::path::PathBuf;

pub(crate) use worktree::{is_managed_review_worktree, set_review_worktree_writable};
use worktree::ReviewBranchContext;
pub(crate) use worktree::release_managed_context_path;
use worktree::prepare_branch_context;

#[tauri::command]
pub fn review_checkpoint_save(
    cwd: String,
    base: String,
    content: String,
    branch: Option<String>,
    commit: Option<String>,
    session_id: Option<String>,
    session_agent: Option<String>,
    // Which run this belongs to, so the saves one review makes as it goes
    // land on one entry and a later review of the same branch keeps both.
    run_id: Option<String>,
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
        run_id,
    })
}

#[tauri::command]
/// The review to reopen: the run named, or the newest of that branch when the
/// caller does not name one — which is all this app could ask for before it
/// could list them.
pub fn review_checkpoint_get(
    cwd: String,
    base: String,
    run_id: Option<String>,
) -> Option<bento_review::checkpoints::Checkpoint> {
    match run_id {
        Some(run) => bento_review::checkpoints::get_run(&cwd, &base, &run),
        None => bento_review::checkpoints::get_checkpoint(&cwd, &base),
    }
}

/// Los perfiles de terminal, del almacén que comparte con el daemon: el shell
/// que eliges aquí es con el que abre el móvil.
#[tauri::command]
pub fn terminal_profiles_get() -> Vec<bento_core::profiles::Profile> {
    bento_core::profiles::list()
}

#[tauri::command]
pub fn terminal_profiles_set(profiles: Vec<bento_core::profiles::Profile>) -> Result<(), String> {
    bento_core::profiles::save(&profiles)
}

/// Los archivos ya revisados de un proyecto y una rama, del almacén que
/// comparten el daemon y la CLI: marcarlos en un cliente y seguir en otro.
#[tauri::command]
pub fn review_viewed_get(cwd: String, base: String) -> Vec<String> {
    bento_review::viewed::get(&cwd, &base)
}

#[tauri::command]
pub fn review_viewed_set(cwd: String, base: String, paths: Vec<String>) -> Result<(), String> {
    bento_review::viewed::set(&cwd, &base, &paths)
}

/// Las conversaciones de un PR con su marca de resuelto, la de GitHub: la ve
/// todo el equipo, a diferencia de una nota que cada cliente se guarde.
#[tauri::command]
pub fn review_pr_threads(cwd: String, pr: u64) -> Result<serde_json::Value, String> {
    bento_review::threads::review_threads(&cwd, pr)
}

/// Resuelve la conversación de un comentario, o la reabre. Por el comentario,
/// que es lo que conoce el panel: GitHub resuelve hilos, no comentarios.
#[tauri::command]
pub fn review_pr_thread_resolve(cwd: String, pr: u64, comment_id: u64, resolved: bool) -> Result<(), String> {
    let threads = bento_review::threads::review_threads(&cwd, pr)?;
    let thread = bento_review::threads::thread_of(&threads, comment_id)
        .ok_or_else(|| "ese comentario no está en ningún hilo".to_string())?;
    bento_review::threads::set_thread_resolved(&cwd, &thread, resolved)
}

#[tauri::command]
pub fn review_checkpoints_list(cwd: String) -> Vec<bento_review::checkpoints::CheckpointMeta> {
    bento_review::checkpoints::list_checkpoint_metas(&cwd)
}

/// Naming the run is what makes this reach a review saved today: every client
/// stamps one, and without it only the runless entry was ever removed.
#[tauri::command]
pub fn review_checkpoint_delete(cwd: String, base: String, run_id: Option<String>) -> Result<(), String> {
    bento_review::checkpoints::delete_checkpoint(&cwd, &base, run_id.as_deref())
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
