use crate::*;
use super::*;

pub fn recipe_files(recipes_dir: &str, project_key: &str) -> Result<Vec<(PathBuf, String)>, String> {
    if !valid_project_key(project_key) {
        return Err("invalid project key".into());
    }
    let recipe_root = Path::new(recipes_dir).join(project_key);
    if !recipe_root.is_dir() {
        return Ok(vec![]);
    }
    let mut pending = vec![recipe_root.clone()];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        let read_dir = std::fs::read_dir(&directory)
            .map_err(|error| format!("{}: {error}", directory.display()))?;
        let mut entries: Vec<_> = read_dir
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries.into_iter().rev() {
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if file_type.is_symlink() {
                return Err(format!("recipe symlinks are not supported: {}", entry.path().display()));
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(&recipe_root)
                    .map(relative_path_string)
                    .map_err(|error| error.to_string())?;
                files.push((entry.path(), relative));
            }
        }
    }
    files.sort_by(|left, right| left.1.cmp(&right.1));
    Ok(files)
}

pub fn git_file_is_tracked(worktree: &str, relative: &str) -> bool {
    Command::new("git")
        .args(["ls-files", "--error-unmatch", "--", relative])
        .current_dir(worktree)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

pub fn recipe_preview(recipes_dir: Option<&str>, project_key: &str, worktree: &str) -> RecipePreview {
    let devcontainer_dirs = find_devcontainer_dirs(worktree);
    let mut warnings = Vec::new();
    if devcontainer_dirs.len() > 1 {
        warnings.push("multiple-devcontainers".into());
    }
    let Some(recipes_dir) = recipes_dir.filter(|path| !path.trim().is_empty()) else {
        return RecipePreview {
            project_key: project_key.into(), recipe_dir: None, recipe_exists: false,
            devcontainer_dirs, files: vec![], warnings,
        };
    };
    let recipe_dir = Path::new(recipes_dir).join(project_key);
    let recipe_exists = recipe_dir.is_dir();
    let mut files = Vec::new();
    match recipe_files(recipes_dir, project_key) {
        Ok(recipe_files) => for (source, relative) in recipe_files {
            let destination = Path::new(worktree).join(&relative);
            let tracked = git_file_is_tracked(worktree, &relative);
            let action = if !destination.exists() {
                "create"
            } else if std::fs::read(&source).ok() == std::fs::read(&destination).ok() {
                "unchanged"
            } else if tracked {
                "overwrite-tracked"
            } else {
                "overwrite"
            };
            files.push(RecipeFilePreview { path: relative, action: action.into(), tracked });

            if files.last().map(|file| file.path.ends_with("docker-compose.override.yml")).unwrap_or(false) {
                let valid = std::fs::read_to_string(&source)
                    .map(|content| content.lines().any(|line| line.trim_end() == "services:"))
                    .unwrap_or(false);
                if !valid {
                    warnings.push(format!("invalid-compose-override:{}", files.last().unwrap().path));
                }
            }
        },
        Err(error) => warnings.push(error),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for (source, relative) in recipe_files(recipes_dir, project_key).unwrap_or_default() {
            if relative.ends_with("bento-postcreate.sh")
                && source.metadata().map(|m| m.permissions().mode() & 0o111 == 0).unwrap_or(false)
            {
                warnings.push(format!("postcreate-not-executable:{relative}"));
            }
        }
    }
    RecipePreview {
        project_key: project_key.into(),
        recipe_dir: Some(recipe_dir.to_string_lossy().into_owned()),
        recipe_exists,
        devcontainer_dirs,
        files,
        warnings,
    }
}

/// Mirrors every regular file in `<recipes_dir>/<project_key>` into the worktree.
/// Paths are returned relative to the worktree, using `/` on every platform.
#[cfg_attr(not(test), allow(dead_code))]
fn overlay_recipe(recipes_dir: &str, project_key: &str, worktree: &str) -> Vec<String> {
    let mut applied = Vec::new();
    for (source, relative) in recipe_files(recipes_dir, project_key).unwrap_or_default() {
        let destination = Path::new(worktree).join(&relative);
        let copied = destination
            .parent()
            .and_then(|parent| std::fs::create_dir_all(parent).ok())
            .and_then(|_| std::fs::copy(&source, &destination).ok());
        if copied.is_some() {
            applied.push(relative);
        }
    }
    applied
}

pub fn overlay_recipe_detailed(
    recipes_dir: &str,
    project_key: &str,
    worktree: &str,
    allow_tracked: bool,
) -> RecipeApplyResult {
    let recipe_dir = Path::new(recipes_dir).join(project_key);
    let mut result = RecipeApplyResult {
        project_key: project_key.into(),
        recipe_dir: recipe_dir.to_string_lossy().into_owned(),
        devcontainer_dir: String::new(),
        applied: vec![], skipped: vec![], errors: vec![],
        applied_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(),
    };
    let files = match recipe_files(recipes_dir, project_key) {
        Ok(files) => files,
        Err(error) => { result.errors.push(error); return result; }
    };
    for (source, relative) in files {
        let destination = Path::new(worktree).join(&relative);
        let tracked = git_file_is_tracked(worktree, &relative);
        if tracked && destination.exists() && !allow_tracked
            && std::fs::read(&source).ok() != std::fs::read(&destination).ok()
        {
            result.skipped.push(relative);
            continue;
        }
        if destination.exists() && std::fs::read(&source).ok() == std::fs::read(&destination).ok() {
            result.skipped.push(relative);
            continue;
        }
        let copy_result = destination
            .parent()
            .ok_or_else(|| "invalid destination".to_string())
            .and_then(|parent| std::fs::create_dir_all(parent).map_err(|e| e.to_string()))
            .and_then(|_| std::fs::copy(&source, &destination).map_err(|e| e.to_string()));
        match copy_result {
            Ok(_) => {
                if tracked { skip_worktree(worktree, &relative); }
                result.applied.push(relative);
            }
            Err(error) => result.errors.push(format!("{relative}: {error}")),
        }
    }
    result
}

pub fn write_recipe_state(worktree_path: &str, devcontainer_dir: &str, result: &RecipeApplyResult) {
    let env_path = Path::new(worktree_path).join(devcontainer_dir).join(".env");
    let existing = std::fs::read_to_string(&env_path).unwrap_or_default();
    let mut lines: Vec<&str> = existing
        .lines()
        .filter(|line| !line.starts_with("BENTO_RECIPE_STATE_HEX="))
        .collect();
    let Ok(json) = serde_json::to_string(result) else { return };
    let state = format!("BENTO_RECIPE_STATE_HEX={}", hex::encode(json));
    lines.push(&state);
    let _ = std::fs::write(env_path, lines.join("\n") + "\n");
}

pub fn read_recipe_state(worktree_path: &str, devcontainer_dir: &str) -> Option<RecipeApplyResult> {
    let env_path = Path::new(worktree_path).join(devcontainer_dir).join(".env");
    let content = std::fs::read_to_string(env_path).ok()?;
    let encoded = content.lines().find_map(|line| line.strip_prefix("BENTO_RECIPE_STATE_HEX="))?;
    let raw = hex::decode(encoded).ok()?;
    serde_json::from_slice(&raw).ok()
}

pub fn create_recipe_dir(recipes_dir: &str, project_key: &str) -> Result<String, String> {
    if recipes_dir.trim().is_empty() || !valid_project_key(project_key) {
        return Err("invalid recipe path".into());
    }
    let project_dir = Path::new(recipes_dir).join(project_key);
    let devcontainer_dir = project_dir.join(".devcontainer");
    std::fs::create_dir_all(&devcontainer_dir)
        .map_err(|error| error.to_string())?;
    Ok(project_dir.to_string_lossy().into_owned())
}

pub fn run_recipe_git(recipes_dir: &str, action: &str, message: Option<&str>) -> Result<String, String> {
    let root = Path::new(recipes_dir);
    if !root.is_dir() {
        return Err("recipes directory does not exist".into());
    }
    let run = |args: &[&str]| -> Result<String, String> {
        let output = Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    };
    match action {
        "init" => run(&["init"]),
        "status" => run(&["status", "--short", "--branch"]),
        "pull" => run(&["pull", "--ff-only"]),
        "push" => run(&["push"]),
        "commit" => {
            let message = message.map(str::trim).filter(|value| !value.is_empty())
                .ok_or_else(|| "commit message is required".to_string())?;
            run(&["add", "-A"])?;
            run(&["commit", "-m", message])
        }
        _ => Err("unsupported recipe git action".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::*;
use crate::compose_yaml::*;
    use crate::test_support::*;

    #[test]
    fn recipe_overlay_mirrors_files_and_creates_parent_directories() {
        let root = temporary_directory("overlay");
        let recipes = root.join("recipes");
        let worktree = root.join("worktree");
        let project = recipes.join("konect-nixon");
        std::fs::create_dir_all(project.join("apps/foo/.devcontainer")).unwrap();
        std::fs::write(project.join(".env"), "APP_ENV=local\n").unwrap();
        std::fs::write(
            project.join("apps/foo/.devcontainer/x"),
            "nested recipe\n",
        )
        .unwrap();

        let applied = overlay_recipe(
            recipes.to_str().unwrap(),
            "konect-nixon",
            worktree.to_str().unwrap(),
        );

        assert_eq!(applied, vec![".env", "apps/foo/.devcontainer/x"]);
        assert_eq!(
            std::fs::read_to_string(worktree.join(".env")).unwrap(),
            "APP_ENV=local\n"
        );
        assert_eq!(
            std::fs::read_to_string(worktree.join("apps/foo/.devcontainer/x")).unwrap(),
            "nested recipe\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn preview_marks_tracked_overwrites_and_apply_requires_permission() {
        let root = temporary_directory("tracked-preview");
        let worktree = root.join("worktree");
        let recipes = root.join("recipes");
        init_test_git_repo(&worktree);
        std::fs::write(worktree.join("config.local"), "project\n").unwrap();
        assert!(Command::new("git").args(["add", "config.local"]).current_dir(&worktree).status().unwrap().success());
        assert!(Command::new("git").args(["commit", "-qm", "base"]).current_dir(&worktree).status().unwrap().success());
        std::fs::create_dir_all(recipes.join("project")).unwrap();
        std::fs::write(recipes.join("project/config.local"), "recipe\n").unwrap();

        let preview = recipe_preview(Some(recipes.to_str().unwrap()), "project", worktree.to_str().unwrap());
        assert_eq!(preview.files[0].action, "overwrite-tracked");
        assert!(preview.files[0].tracked);

        let denied = overlay_recipe_detailed(recipes.to_str().unwrap(), "project", worktree.to_str().unwrap(), false);
        assert!(denied.applied.is_empty());
        assert_eq!(denied.skipped, vec!["config.local"]);
        assert_eq!(std::fs::read_to_string(worktree.join("config.local")).unwrap(), "project\n");

        let allowed = overlay_recipe_detailed(recipes.to_str().unwrap(), "project", worktree.to_str().unwrap(), true);
        assert_eq!(allowed.applied, vec!["config.local"]);
        assert_eq!(std::fs::read_to_string(worktree.join("config.local")).unwrap(), "recipe\n");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn creates_recipe_scaffold_and_initializes_version_control() {
        let root = temporary_directory("recipe-create");
        let recipes = root.join("recipes");
        let created = create_recipe_dir(recipes.to_str().unwrap(), "company--api").unwrap();
        assert!(Path::new(&created).join(".devcontainer").is_dir());
        assert!(create_recipe_dir(recipes.to_str().unwrap(), "../escape").is_err());
        run_recipe_git(recipes.to_str().unwrap(), "init", None).unwrap();
        assert!(recipes.join(".git").is_dir());
        let status = run_recipe_git(recipes.to_str().unwrap(), "status", None).unwrap();
        assert!(status.starts_with("##"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn recipe_rejects_symbolic_links() {
        use std::os::unix::fs::symlink;
        let root = temporary_directory("recipe-symlink");
        let project = root.join("recipes/project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(root.join("secret"), "outside\n").unwrap();
        symlink(root.join("secret"), project.join("linked-secret")).unwrap();
        let error = recipe_files(root.join("recipes").to_str().unwrap(), "project").unwrap_err();
        assert!(error.contains("symlinks are not supported"), "{error}");
        let _ = std::fs::remove_dir_all(root);
    }
}
