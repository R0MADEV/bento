use super::*;
use super::compose_yaml::*;
use super::port_probe::*;
use super::subnet::*;
use super::isolate::IsolateResult;

pub(crate) mod recipe;
pub(crate) mod json_patch;
pub(crate) mod env_ports;
pub(crate) mod commands;

pub use commands::*;

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
fn find_devcontainer_dirs(worktree: &str) -> Vec<String> {
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
fn find_devcontainer_dir(worktree: &str) -> Option<String> {
    find_devcontainer_dirs(worktree).into_iter().next()
}

/// Marks a file as `--skip-worktree` in the worktree's git index so local edits
/// (our compose rewrite) never show up in status or land in the branch.
fn skip_worktree(worktree_path: &str, file: &str) {
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
    use crate::docker::test_support::*;

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
}
