//! Los comandos del devcontainer. Toda la lógica —recetas, parcheo de JSON,
//! aislamiento y descubrimiento de puertos— vive en `bento_docker::devcontainer`.

pub use bento_docker::devcontainer::*;

use bento_docker::compose_yaml::valid_project_key;
use bento_docker::devcontainer::isolate::{
    devcontainer_urls as read_devcontainer_urls, isolate_devcontainer,
};
use bento_docker::devcontainer::recipe::{create_recipe_dir, recipe_preview, run_recipe_git};
use bento_docker::isolate::IsolateResult;
use bento_docker::port_probe::ServiceUrl;
use std::path::Path;

#[tauri::command]
pub async fn devcontainer_recipe_preview(
    worktree_path: String,
    recipes_dir: Option<String>,
    project_key: String,
) -> Result<RecipePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !Path::new(&worktree_path).is_dir() {
            return Err("invalid worktree".into());
        }
        if !valid_project_key(&project_key) {
            return Err("invalid project key".into());
        }
        Ok(recipe_preview(recipes_dir.as_deref(), &project_key, &worktree_path))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn devcontainer_recipe_create(
    recipes_dir: String,
    project_key: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || create_recipe_dir(&recipes_dir, &project_key))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn devcontainer_recipe_git(
    recipes_dir: String,
    action: String,
    message: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_recipe_git(&recipes_dir, &action, message.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn devcontainer_isolate(
    worktree_path: String,
    recipes_dir: Option<String>,
    project_key: String,
    devcontainer_dir: Option<String>,
    allow_tracked: Option<bool>,
) -> Result<IsolateResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        isolate_devcontainer(
            &worktree_path,
            recipes_dir.as_deref(),
            &project_key,
            devcontainer_dir,
            allow_tracked.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn devcontainer_recipe_status(
    worktree_path: String,
    devcontainer_dir: Option<String>,
) -> Result<Option<RecipeApplyResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        bento_docker::devcontainer::isolate::devcontainer_recipe_status(
            &worktree_path,
            devcontainer_dir,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn devcontainer_urls(
    worktree_path: String,
    devcontainer_dir: Option<String>,
) -> Result<Vec<ServiceUrl>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_devcontainer_urls(&worktree_path, devcontainer_dir)
    })
    .await
    .map_err(|error| error.to_string())?
}
