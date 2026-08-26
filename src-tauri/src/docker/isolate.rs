//! El comando que aísla la tarea. Todo lo que decide (subred, override de
//! compose, puertos) vive en `bento_docker::isolate`, compartido con el daemon
//! y el CLI.

pub use bento_docker::isolate::IsolateResult;

#[tauri::command]
pub async fn docker_compose_isolate(worktree_path: String) -> Result<IsolateResult, String> {
    tauri::async_runtime::spawn_blocking(move || bento_docker::isolate::isolate(&worktree_path))
        .await
        .map_err(|e| e.to_string())?
}
