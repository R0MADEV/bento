//! Comandos de recomendación de commit. La lógica vive en
//! `bento_review::recommend`, compartida con el daemon y el CLI.

pub use bento_review::recommend::CommitRecommendation;

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_recommend_commits(
    path: String,
    base: String,
    files: Vec<String>,
) -> Result<Vec<CommitRecommendation>, String> {
    blocking(move || bento_review::recommend::recommend_commits(&path, &base, &files)).await
}

#[tauri::command]
pub async fn git_blame_recommend(
    path: String,
    base: String,
    patch: String,
) -> Result<Vec<CommitRecommendation>, String> {
    blocking(move || bento_review::recommend::blame_recommend(&path, &base, &patch)).await
}
