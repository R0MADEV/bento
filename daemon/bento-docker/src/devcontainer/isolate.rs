//! La orquestación de "preparar un devcontainer aislado": elegir el
//! `.devcontainer`, reescribir su compose, aplicar la receta del proyecto y
//! publicar los puertos. Sin UI: la usan el desktop, el daemon y el CLI.

use crate::*;
use crate::compose_yaml::{first_subnet_prefix, isolate_compose_yaml};
use crate::isolate::IsolateResult;
use crate::port_probe::{pairs_to_urls, stable_port_offset, ServiceUrl};
use crate::subnet::{ensure_global_gitignore, find_free_subnet_prefix};
use super::env_ports::write_bento_env;
use super::json_patch::wire_recipe_into_devcontainer;
use super::recipe::{
    git_file_is_tracked, overlay_recipe_detailed, read_recipe_state, recipe_files,
    write_recipe_state,
};
use super::{find_devcontainer_dirs, skip_worktree, RecipeApplyResult};

/// Elige el `.devcontainer` sobre el que operar. Sin selección explícita solo
/// vale cuando hay exactamente uno: preparar el equivocado reescribe ficheros.
pub fn resolve_devcontainer_dir(
    worktree_path: &str,
    requested: Option<String>,
) -> Result<String, String> {
    let candidates = find_devcontainer_dirs(worktree_path);
    match requested {
        Some(selected) if candidates.contains(&selected) => Ok(selected),
        Some(_) => Err("invalid-devcontainer".into()),
        None if candidates.len() == 1 => Ok(candidates[0].clone()),
        None if candidates.is_empty() => Err("no-devcontainer".into()),
        None => Err("multiple-devcontainers".into()),
    }
}

/// Deja el worktree listo para el "Reopen in Container" de VS Code con un stack
/// aislado, y luego calca encima la receta opcional del proyecto. El
/// devcontainer puede estar a cualquier profundidad; sin directorio de recetas
/// se hace igualmente el aislamiento genérico del compose.
pub fn isolate_devcontainer(
    worktree_path: &str,
    recipes_dir: Option<&str>,
    project_key: &str,
    devcontainer_dir: Option<String>,
    allow_tracked: bool,
) -> Result<IsolateResult, String> {
    let candidates = find_devcontainer_dirs(worktree_path);
    if candidates.is_empty() {
        return Err("no-devcontainer".into());
    }
    let devcontainer_dir = resolve_devcontainer_dir(worktree_path, devcontainer_dir)?;
    let compose_relative = format!("{devcontainer_dir}/docker-compose.yml");
    let compose_path = Path::new(worktree_path).join(&compose_relative);
    if !compose_path.is_file() {
        return Err("no-devcontainer".into());
    }

    let worktree_dir = Path::new(worktree_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("worktree")
        .to_string();

    let content = std::fs::read_to_string(&compose_path).map_err(|error| error.to_string())?;
    let result_subnet = if already_isolated(&content, &worktree_dir) {
        // Idempotente: si este worktree ya estaba aislado no se vuelven a
        // desplazar subred ni puertos, solo se informa del estado actual.
        first_subnet_prefix(&content)
            .map(|prefix| format!("{prefix}.0/24"))
            .unwrap_or_default()
    } else {
        let subnet = rewrite_compose(worktree_path, &compose_path, &content, &worktree_dir)?;
        skip_worktree(worktree_path, &compose_relative);
        subnet
    };

    // La receta va a propósito después del aislamiento: es una capa genérica de
    // ficheros, no una segunda fuente de los ficheros del proyecto.
    let mut recipe = recipes_dir
        .filter(|directory| !directory.trim().is_empty())
        .map(|directory| {
            overlay_recipe_detailed(directory, project_key, worktree_path, allow_tracked)
        });
    let applied = recipe
        .as_ref()
        .map(|result| result.applied.clone())
        .unwrap_or_default();
    for relative in &applied {
        if !git_file_is_tracked(worktree_path, relative) {
            ensure_global_gitignore(&format!("/{relative}"));
        }
    }
    let wiring_errors = wire_recipe_into_devcontainer(
        worktree_path,
        &devcontainer_dir,
        &recipe_files_present(worktree_path, recipes_dir, project_key),
    );
    skip_worktree(
        worktree_path,
        &format!("{devcontainer_dir}/devcontainer.json"),
    );
    let final_compose =
        std::fs::read_to_string(&compose_path).map_err(|error| error.to_string())?;
    let pairs = write_bento_env(worktree_path, &devcontainer_dir, &final_compose);
    if let Some(result) = recipe.as_mut() {
        result.devcontainer_dir = devcontainer_dir.clone();
        result.errors.extend(wiring_errors);
        write_recipe_state(worktree_path, &devcontainer_dir, result);
    }

    Ok(IsolateResult {
        subnet: result_subnet,
        urls: pairs_to_urls(&pairs),
        recipe,
    })
}

/// El estado de la última receta aplicada sobre un devcontainer del worktree.
pub fn devcontainer_recipe_status(
    worktree_path: &str,
    devcontainer_dir: Option<String>,
) -> Result<Option<RecipeApplyResult>, String> {
    let selected = resolve_devcontainer_dir(worktree_path, devcontainer_dir)?;
    Ok(read_recipe_state(worktree_path, &selected))
}

/// Lee el mapa de puertos de `.devcontainer/.env` (lo escribe
/// `isolate_devcontainer`) y devuelve URLs navegables. Barato y de solo
/// lectura: sirve para volver a enseñar las URLs de una tarea ya preparada.
pub fn devcontainer_urls(
    worktree_path: &str,
    devcontainer_dir: Option<String>,
) -> Result<Vec<ServiceUrl>, String> {
    let candidates = find_devcontainer_dirs(worktree_path);
    let devcontainer_dir = match devcontainer_dir {
        Some(path) if candidates.contains(&path) => path,
        Some(_) => return Err("invalid-devcontainer".into()),
        None => candidates
            .into_iter()
            .next()
            .ok_or_else(|| "no-devcontainer".to_string())?,
    };
    let env_path = Path::new(worktree_path).join(devcontainer_dir).join(".env");
    let content =
        std::fs::read_to_string(&env_path).map_err(|_| "no-devcontainer".to_string())?;
    let pairs: Vec<(u16, u16)> = content
        .lines()
        .filter_map(|line| {
            let (container, host) = line.strip_prefix("BENTO_HOST_")?.split_once('=')?;
            Some((container.parse().ok()?, host.parse().ok()?))
        })
        .collect();
    if pairs.is_empty() {
        return Err("no-devcontainer".into());
    }
    Ok(pairs_to_urls(&pairs))
}

fn already_isolated(content: &str, worktree_dir: &str) -> bool {
    let target = format!("name: {worktree_dir}");
    content
        .lines()
        .any(|line| line.starts_with("name:") && line.trim_end() == target)
}

/// Reescribe el compose del devcontainer con nombre, subred y puertos propios.
/// Devuelve la subred asignada (vacía si Docker la asigna él solo).
fn rewrite_compose(
    worktree_path: &str,
    compose_path: &Path,
    content: &str,
    worktree_dir: &str,
) -> Result<String, String> {
    // Solo se remapea la subred cuando es explícita; si no, Docker asigna una
    // red por defecto sin solapes y basta con aislar nombre y puertos.
    let (subnet_remap, port_offset, subnet) = match first_subnet_prefix(content) {
        Some(old_prefix) => {
            let new_prefix = find_free_subnet_prefix(&old_prefix, worktree_path)
                .ok_or("no free subnet available in range")?;
            let offset = third_octet(&new_prefix)
                .saturating_sub(third_octet(&old_prefix))
                .max(1);
            let subnet = format!("{new_prefix}.0/24");
            (Some((old_prefix, new_prefix)), offset, subnet)
        }
        None => (None, stable_port_offset(worktree_dir), String::new()),
    };

    let remap = subnet_remap
        .as_ref()
        .map(|(old, new)| (old.as_str(), new.as_str()));
    let (new_content, _) = isolate_compose_yaml(
        content,
        worktree_dir,
        remap,
        port_offset,
        main_repo_gitdir(worktree_path).as_deref(),
    );
    std::fs::write(compose_path, new_content).map_err(|error| error.to_string())?;
    Ok(subnet)
}

fn third_octet(prefix: &str) -> u16 {
    prefix.rsplit('.').next().unwrap_or("0").parse().unwrap_or(0)
}

/// El `.git` de un worktree apunta fuera de su propio directorio, así que hay
/// que montar el gitdir del repo principal dentro del contenedor.
fn main_repo_gitdir(worktree_path: &str) -> Option<String> {
    let content = std::fs::read_to_string(Path::new(worktree_path).join(".git")).ok()?;
    let gitdir = content
        .lines()
        .find_map(|line| line.strip_prefix("gitdir:").map(|rest| rest.trim().to_string()))?;
    Path::new(&gitdir)
        .parent()
        .and_then(Path::parent)
        .and_then(Path::to_str)
        .map(String::from)
}

/// Los ficheros de la receta que de verdad están calcados en el worktree.
fn recipe_files_present(
    worktree_path: &str,
    recipes_dir: Option<&str>,
    project_key: &str,
) -> Vec<String> {
    let Some(directory) = recipes_dir else {
        return Vec::new();
    };
    recipe_files(directory, project_key)
        .unwrap_or_default()
        .into_iter()
        .filter(|(source, relative)| {
            std::fs::read(source).ok()
                == std::fs::read(Path::new(worktree_path).join(relative)).ok()
        })
        .map(|(_, relative)| relative)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::*;

    fn devcontainer_fixture(name: &str, relative: &str) -> PathBuf {
        let worktree = temporary_directory(name);
        let directory = worktree.join(relative);
        init_test_git_repo(&worktree);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("devcontainer.json"), "{\n  \"dockerComposeFile\": \"docker-compose.yml\"\n}").unwrap();
        std::fs::write(directory.join("docker-compose.yml"), SAMPLE_NO_SUBNET).unwrap();
        worktree
    }

    #[test]
    fn resolving_without_candidates_reports_no_devcontainer() {
        let worktree = temporary_directory("resolve-empty");
        std::fs::create_dir_all(&worktree).unwrap();
        assert_eq!(
            resolve_devcontainer_dir(worktree.to_str().unwrap(), None),
            Err("no-devcontainer".into())
        );
        let _ = std::fs::remove_dir_all(worktree);
    }

    #[test]
    fn resolving_several_candidates_needs_an_explicit_choice() {
        let worktree = devcontainer_fixture("resolve-many", "apps/api/.devcontainer");
        let second = worktree.join("apps/web/.devcontainer");
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(second.join("devcontainer.json"), "{}").unwrap();
        let path = worktree.to_str().unwrap();
        assert_eq!(resolve_devcontainer_dir(path, None), Err("multiple-devcontainers".into()));
        assert_eq!(resolve_devcontainer_dir(path, Some("nope".into())), Err("invalid-devcontainer".into()));
        assert_eq!(
            resolve_devcontainer_dir(path, Some("apps/web/.devcontainer".into())).unwrap(),
            "apps/web/.devcontainer"
        );
        let _ = std::fs::remove_dir_all(worktree);
    }

    #[test]
    fn isolating_names_the_stack_publishes_ports_and_repeats_clean() {
        let worktree = devcontainer_fixture("isolate-once", "apps/api/.devcontainer");
        let path = worktree.to_str().unwrap();
        let first = isolate_devcontainer(path, None, "project", None, false).unwrap();
        let compose = std::fs::read_to_string(worktree.join("apps/api/.devcontainer/docker-compose.yml")).unwrap();
        let worktree_dir = worktree.file_name().unwrap().to_str().unwrap();

        assert!(compose.contains(&format!("name: {worktree_dir}")), "{compose}");
        assert!(first.recipe.is_none());
        assert_eq!(devcontainer_urls(path, None).unwrap(), first.urls);
        assert!(!first.urls.is_empty());

        // Segunda pasada: ni el compose ni los puertos se mueven.
        let second = isolate_devcontainer(path, None, "project", None, false).unwrap();
        assert_eq!(
            compose,
            std::fs::read_to_string(worktree.join("apps/api/.devcontainer/docker-compose.yml")).unwrap()
        );
        assert_eq!(second.urls, first.urls);
        let _ = std::fs::remove_dir_all(worktree);
    }

    #[test]
    fn urls_without_a_prepared_environment_report_no_devcontainer() {
        let worktree = devcontainer_fixture("urls-missing", ".devcontainer");
        assert_eq!(
            devcontainer_urls(worktree.to_str().unwrap(), None),
            Err("no-devcontainer".into())
        );
        let _ = std::fs::remove_dir_all(worktree);
    }

    #[test]
    fn recipe_status_is_empty_until_a_recipe_is_applied() {
        let worktree = devcontainer_fixture("status-empty", ".devcontainer");
        assert!(devcontainer_recipe_status(worktree.to_str().unwrap(), None).unwrap().is_none());
        let _ = std::fs::remove_dir_all(worktree);
    }
}
