use crate::*;
use crate::compose_yaml::*;

pub mod recipe;
pub mod json_patch;
pub mod env_ports;


#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeFilePreview {
    pub path: String,
    pub action: String,
    pub tracked: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipePreview {
    pub project_key: String,
    pub recipe_dir: Option<String>,
    pub recipe_exists: bool,
    pub devcontainer_dirs: Vec<String>,
    pub files: Vec<RecipeFilePreview>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeApplyResult {
    pub project_key: String,
    pub recipe_dir: String,
    pub devcontainer_dir: String,
    pub applied: Vec<String>,
    pub skipped: Vec<String>,
    pub errors: Vec<String>,
    pub applied_at: u64,
}

/// Finds every `.devcontainer` containing a `devcontainer.json`, ordered by depth
/// and then lexically. Paths are relative to the worktree.
pub fn find_devcontainer_dirs(worktree: &str) -> Vec<String> {
    let root = Path::new(worktree);
    let mut pending = vec![root.to_path_buf()];
    let mut found = Vec::<PathBuf>::new();
    while let Some(directory) = pending.pop() {
        let Ok(read_dir) = std::fs::read_dir(&directory) else {
            continue;
        };
        let mut entries: Vec<_> = read_dir.filter_map(Result::ok).collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries.into_iter().rev() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                if entry.file_name() != ".git" {
                    pending.push(entry.path());
                }
            } else if file_type.is_file()
                && entry.file_name() == "devcontainer.json"
                && entry.path().parent().and_then(Path::file_name).and_then(|name| name.to_str()) == Some(".devcontainer")
            {
                if let Some(relative) = entry.path().parent().and_then(|parent| parent.strip_prefix(root).ok()) {
                    found.push(relative.to_path_buf());
                }
            }
        }
    }
    found.sort_by(|left, right| {
        left.components()
            .count()
            .cmp(&right.components().count())
            .then_with(|| left.cmp(right))
    });
    found.iter().map(|path| relative_path_string(path)).collect()
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn find_devcontainer_dir(worktree: &str) -> Option<String> {
    find_devcontainer_dirs(worktree).into_iter().next()
}

/// Marks a file as `--skip-worktree` in the worktree's git index so local edits
/// (our compose rewrite) never show up in status or land in the branch.
pub fn skip_worktree(worktree_path: &str, file: &str) {
    let git = login_shell_output("command -v git")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "git".into());
    let _ = Command::new(&git)
        .args(["update-index", "--skip-worktree", file])
        .current_dir(worktree_path)
        .output();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::*;
    use crate::test_support::*;

    #[test]
    fn finds_root_devcontainer_directory() {
        let worktree = temporary_directory("find-root");
        let directory = worktree.join(".devcontainer");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("devcontainer.json"), "{}").unwrap();
        assert_eq!(
            find_devcontainer_dir(worktree.to_str().unwrap()).as_deref(),
            Some(".devcontainer")
        );
        let _ = std::fs::remove_dir_all(worktree);
    }

    #[test]
    fn finds_nested_devcontainer_directory() {
        let worktree = temporary_directory("find-nested");
        let directory = worktree.join("apps/foo/.devcontainer");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("devcontainer.json"), "{}").unwrap();
        assert_eq!(
            find_devcontainer_dir(worktree.to_str().unwrap()).as_deref(),
            Some("apps/foo/.devcontainer")
        );
        let _ = std::fs::remove_dir_all(worktree);
    }

    #[test]
    fn finds_all_devcontainers_in_stable_order() {
        let worktree = temporary_directory("find-multiple");
        for relative in ["apps/web/.devcontainer", ".devcontainer", "apps/api/.devcontainer"] {
            let directory = worktree.join(relative);
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join("devcontainer.json"), "{}").unwrap();
        }
        assert_eq!(find_devcontainer_dirs(worktree.to_str().unwrap()), vec![
            ".devcontainer", "apps/api/.devcontainer", "apps/web/.devcontainer",
        ]);
        let _ = std::fs::remove_dir_all(worktree);
    }

    #[test]
    fn recipe_pipeline_is_idempotent_for_nested_devcontainer() {
        let root = temporary_directory("pipeline");
        let worktree = root.join("worktree");
        let recipes = root.join("recipes");
        let devcontainer = worktree.join("apps/api/.devcontainer");
        init_test_git_repo(&worktree);
        std::fs::create_dir_all(&devcontainer).unwrap();
        std::fs::write(devcontainer.join("devcontainer.json"), r#"{
  "dockerComposeFile": "docker-compose.yml",
  "postCreateCommand": "bash setup.sh"
}"#).unwrap();
        let (isolated, _) = isolate_compose_yaml(SAMPLE_NO_SUBNET, "task-1", None, 2, None);
        std::fs::write(devcontainer.join("docker-compose.yml"), &isolated).unwrap();
        let recipe_devcontainer = recipes.join("project/apps/api/.devcontainer");
        std::fs::create_dir_all(&recipe_devcontainer).unwrap();
        std::fs::write(recipe_devcontainer.join("docker-compose.override.yml"), "services:\n  web:\n    environment:\n      LOCAL: 1\n").unwrap();
        std::fs::write(recipe_devcontainer.join("bento-postcreate.sh"), "#!/bin/sh\ntrue\n").unwrap();

        let mut first = recipe::overlay_recipe_detailed(recipes.to_str().unwrap(), "project", worktree.to_str().unwrap(), false);
        first.devcontainer_dir = "apps/api/.devcontainer".into();
        assert!(json_patch::wire_recipe_into_devcontainer(worktree.to_str().unwrap(), &first.devcontainer_dir, &first.applied).is_empty());
        env_ports::write_bento_env(worktree.to_str().unwrap(), &first.devcontainer_dir, &isolated);
        recipe::write_recipe_state(worktree.to_str().unwrap(), &first.devcontainer_dir, &first);

        let json = std::fs::read_to_string(devcontainer.join("devcontainer.json")).unwrap();
        assert!(json.contains("docker-compose.override.yml"), "{json}");
        assert!(json.contains("bash apps/api/.devcontainer/bento-postcreate.sh"), "{json}");
        assert_eq!(recipe::read_recipe_state(worktree.to_str().unwrap(), &first.devcontainer_dir).unwrap().project_key, "project");

        let second = recipe::overlay_recipe_detailed(recipes.to_str().unwrap(), "project", worktree.to_str().unwrap(), false);
        assert!(second.applied.is_empty());
        assert_eq!(second.skipped.len(), 2);
        let _ = std::fs::remove_dir_all(root);
    }
}
