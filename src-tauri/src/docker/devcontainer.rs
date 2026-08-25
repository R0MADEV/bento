//! Los comandos del devcontainer. Las recetas, el parcheo de JSON y el
//! descubrimiento de puertos viven en `bento_docker::devcontainer`.

pub use bento_docker::devcontainer::*;

use crate::docker::*;
use bento_docker::devcontainer::skip_worktree;
use bento_docker::subnet::ensure_global_gitignore;
use bento_docker::subnet::find_free_subnet_prefix;
use bento_docker::port_probe::pairs_to_urls;
use bento_docker::compose_yaml::isolate_compose_yaml;
use bento_docker::compose_yaml::first_subnet_prefix;
use bento_docker::devcontainer::find_devcontainer_dirs;
use bento_docker::port_probe::ServiceUrl;
use bento_docker::port_probe::stable_port_offset;
use bento_docker::compose_yaml::valid_project_key;
use bento_docker::isolate::IsolateResult;
use bento_docker::devcontainer::recipe::{
    create_recipe_dir, git_file_is_tracked, overlay_recipe_detailed, read_recipe_state,
    recipe_files, recipe_preview, run_recipe_git, write_recipe_state,
};
use bento_docker::devcontainer::json_patch::wire_recipe_into_devcontainer;
use bento_docker::devcontainer::env_ports::write_bento_env;

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
    tauri::async_runtime::spawn_blocking(move || {
        create_recipe_dir(&recipes_dir, &project_key)
    })
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

/// Prepares a devcontainer worktree so VS Code's "Reopen in Container" starts an
/// isolated stack, then mirrors the optional project recipe over the worktree.
/// The devcontainer can live at any depth; without a recipes directory this still
/// performs the generic compose isolation.
#[tauri::command]
pub async fn devcontainer_isolate(
    worktree_path: String,
    recipes_dir: Option<String>,
    project_key: String,
    devcontainer_dir: Option<String>,
    allow_tracked: Option<bool>,
) -> Result<IsolateResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let candidates = find_devcontainer_dirs(&worktree_path);
        if candidates.is_empty() {
            return Err("no-devcontainer".into());
        }
        let devcontainer_dir = match devcontainer_dir {
            Some(selected) if candidates.contains(&selected) => selected,
            Some(_) => return Err("invalid-devcontainer".into()),
            None if candidates.len() == 1 => candidates[0].clone(),
            None => return Err("multiple-devcontainers".into()),
        };
        let compose_relative = format!("{devcontainer_dir}/docker-compose.yml");
        let compose_path = Path::new(&worktree_path).join(&compose_relative);
        if !compose_path.is_file() {
            return Err("no-devcontainer".into());
        }

        let worktree_dir = std::path::Path::new(&worktree_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("worktree")
            .to_string();

        let content = std::fs::read_to_string(&compose_path).map_err(|e| e.to_string())?;

        // Idempotent: if this worktree was already isolated (name == worktree dir),
        // don't shift subnet/ports again — just report the current state.
        let target_name = format!("name: {}", worktree_dir);
        let already = content
            .lines()
            .any(|l| l.starts_with("name:") && l.trim_end() == target_name);
        let result_subnet = if already {
            first_subnet_prefix(&content)
                .map(|p| format!("{}.0/24", p))
                .unwrap_or_default()
        } else {
            // Remap the custom subnet when present; otherwise Docker auto-assigns a
            // non-overlapping default network, so only name + ports need isolating.
            let (subnet_remap, port_offset, subnet) = match first_subnet_prefix(&content) {
                Some(old_prefix) => {
                    let new_prefix = find_free_subnet_prefix(&old_prefix, &worktree_path)
                        .ok_or("no free subnet available in range")?;
                    let base_third: u16 = old_prefix
                        .rsplit('.')
                        .next()
                        .unwrap_or("0")
                        .parse()
                        .unwrap_or(0);
                    let new_third: u16 = new_prefix
                        .rsplit('.')
                        .next()
                        .unwrap_or("0")
                        .parse()
                        .unwrap_or(0);
                    let offset = new_third.saturating_sub(base_third).max(1);
                    let subnet = format!("{}.0/24", new_prefix);
                    (Some((old_prefix, new_prefix)), offset, subnet)
                }
                None => (None, stable_port_offset(&worktree_dir), String::new()),
            };

            // Mount the main repo's gitdir into the container. A worktree's `.git`
            // file points outside its own directory, which would otherwise be absent.
            let git_mount = std::fs::read_to_string(Path::new(&worktree_path).join(".git"))
                .ok()
                .and_then(|c| {
                    c.lines()
                        .find_map(|l| l.strip_prefix("gitdir:").map(|s| s.trim().to_string()))
                })
                .and_then(|gitdir| {
                    Path::new(&gitdir)
                        .parent()
                        .and_then(|p| p.parent())
                        .and_then(|p| p.to_str())
                        .map(String::from)
                });

            let remap_ref = subnet_remap.as_ref().map(|(o, n)| (o.as_str(), n.as_str()));
            let (new_content, _) = isolate_compose_yaml(
                &content,
                &worktree_dir,
                remap_ref,
                port_offset,
                git_mount.as_deref(),
            );
            std::fs::write(&compose_path, new_content).map_err(|e| e.to_string())?;
            skip_worktree(&worktree_path, &compose_relative);
            subnet
        };

        // Recipes intentionally run after isolation: they are a generic filesystem
        // overlay, not a second source of project files.
        let mut recipe = recipes_dir
            .as_deref()
            .filter(|directory| !directory.trim().is_empty())
            .map(|directory| overlay_recipe_detailed(
                directory, &project_key, &worktree_path, allow_tracked.unwrap_or(false)
            ));
        let applied = recipe.as_ref().map(|result| result.applied.clone()).unwrap_or_default();
        for relative in &applied {
            if !git_file_is_tracked(&worktree_path, relative) {
                ensure_global_gitignore(&format!("/{relative}"));
            }
        }
        let recipe_files_present = recipes_dir.as_deref().map(|directory| {
            recipe_files(directory, &project_key).unwrap_or_default().into_iter()
                .filter(|(source, relative)| {
                    std::fs::read(source).ok()
                        == std::fs::read(Path::new(&worktree_path).join(relative)).ok()
                })
                .map(|(_, relative)| relative)
                .collect::<Vec<_>>()
        }).unwrap_or_default();
        let wiring_errors = wire_recipe_into_devcontainer(
            &worktree_path,
            &devcontainer_dir,
            &recipe_files_present,
        );
        skip_worktree(
            &worktree_path,
            &format!("{devcontainer_dir}/devcontainer.json"),
        );
        let final_compose = std::fs::read_to_string(&compose_path).map_err(|e| e.to_string())?;
        let pairs = write_bento_env(&worktree_path, &devcontainer_dir, &final_compose);
        if let Some(result) = recipe.as_mut() {
            result.devcontainer_dir = devcontainer_dir.clone();
            result.errors.extend(wiring_errors);
            write_recipe_state(&worktree_path, &devcontainer_dir, result);
        }

        Ok(IsolateResult {
            subnet: result_subnet,
            urls: pairs_to_urls(&pairs),
            recipe,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn devcontainer_recipe_status(
    worktree_path: String,
    devcontainer_dir: Option<String>,
) -> Result<Option<RecipeApplyResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let candidates = find_devcontainer_dirs(&worktree_path);
        let selected = match devcontainer_dir {
            Some(path) if candidates.contains(&path) => path,
            Some(_) => return Err("invalid-devcontainer".into()),
            None if candidates.len() == 1 => candidates[0].clone(),
            None if candidates.is_empty() => return Err("no-devcontainer".into()),
            None => return Err("multiple-devcontainers".into()),
        };
        Ok(read_recipe_state(&worktree_path, &selected))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Reads the `.devcontainer/.env` host-port map (written by `devcontainer_isolate`)
/// and returns browsable localhost URLs. Cheap + read-only — used to re-display a
/// prepared task's URLs without re-isolating. Returns "no-devcontainer" if absent.
#[tauri::command]
pub async fn devcontainer_urls(
    worktree_path: String,
    devcontainer_dir: Option<String>,
) -> Result<Vec<ServiceUrl>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let candidates = find_devcontainer_dirs(&worktree_path);
        let devcontainer_dir = match devcontainer_dir {
            Some(path) if candidates.contains(&path) => path,
            Some(_) => return Err("invalid-devcontainer".into()),
            None => candidates.into_iter().next().ok_or_else(|| "no-devcontainer".to_string())?,
        };
        let env_path = Path::new(&worktree_path).join(devcontainer_dir).join(".env");
        let content = std::fs::read_to_string(&env_path).map_err(|_| "no-devcontainer".to_string())?;
        let pairs: Vec<(u16, u16)> = content
            .lines()
            .filter_map(|l| {
                let (n, h) = l.strip_prefix("BENTO_HOST_")?.split_once('=')?;
                Some((n.parse().ok()?, h.parse().ok()?))
            })
            .collect();
        if pairs.is_empty() {
            return Err("no-devcontainer".into());
        }
        Ok(pairs_to_urls(&pairs))
    })
    .await
    .map_err(|e| e.to_string())?
}
