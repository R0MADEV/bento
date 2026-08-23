use super::*;
use super::compose_yaml::*;
use super::port_probe::*;
use super::subnet::*;
use super::isolate::IsolateResult;


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

fn recipe_files(recipes_dir: &str, project_key: &str) -> Result<Vec<(PathBuf, String)>, String> {
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

fn git_file_is_tracked(worktree: &str, relative: &str) -> bool {
    Command::new("git")
        .args(["ls-files", "--error-unmatch", "--", relative])
        .current_dir(worktree)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn recipe_preview(recipes_dir: Option<&str>, project_key: &str, worktree: &str) -> RecipePreview {
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

fn overlay_recipe_detailed(
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

/// Appends `&& <hook>` to a devcontainer.json `postCreateCommand` string, so bento's
/// setup runs after the project's own postCreate. Idempotent. Returns `Err` if the
/// key is missing or isn't a string — never corrupts the file.
fn add_postcreate_hook_to_devcontainer_json(json: &str, hook: &str) -> Result<String, String> {
    if json.contains(hook) {
        return Ok(json.to_string()); // already chained — idempotent
    }
    let key = "\"postCreateCommand\"";
    let key_pos = json.find(key).ok_or("postCreateCommand not found")?;
    let colon_rel = json[key_pos + key.len()..]
        .find(':')
        .ok_or("malformed postCreateCommand")?;
    let after_colon = key_pos + key.len() + colon_rel + 1;
    let trimmed = json[after_colon..].trim_start();
    let value_start = json.len() - json[after_colon..].len() + (json[after_colon..].len() - trimmed.len());
    let rest = trimmed
        .strip_prefix('"')
        .ok_or("postCreateCommand is not a string")?;
    let end_rel = rest.find('"').ok_or("unterminated string")?;
    let existing = &rest[..end_rel];
    let value_end = value_start + 1 + end_rel + 1;
    let replacement = format!("\"{} && {}\"", existing, hook);
    Ok(format!("{}{}{}", &json[..value_start], replacement, &json[value_end..]))
}

/// Adds `override_file` to a devcontainer.json `dockerComposeFile` value, turning a
/// string into an array (or appending to an existing array). Idempotent. Returns
/// `Err` if the key is missing or the value is neither a string nor an array — never
/// corrupts the file. Handles plain JSON (devcontainer.json is JSONC, but the common
/// case has no comments around this key).
fn add_override_to_devcontainer_json(json: &str, override_file: &str) -> Result<String, String> {
    if json.contains(override_file) {
        return Ok(json.to_string()); // already referenced — idempotent
    }
    let key = "\"dockerComposeFile\"";
    let key_pos = json.find(key).ok_or("dockerComposeFile not found")?;
    let colon_rel = json[key_pos + key.len()..]
        .find(':')
        .ok_or("malformed dockerComposeFile")?;
    let after_colon = key_pos + key.len() + colon_rel + 1;
    let trimmed = json[after_colon..].trim_start();
    let value_start = json.len() - json[after_colon..].len() + (json[after_colon..].len() - trimmed.len());

    if let Some(rest) = trimmed.strip_prefix('"') {
        let end_rel = rest.find('"').ok_or("unterminated string")?;
        let base = &rest[..end_rel];
        let value_end = value_start + 1 + end_rel + 1; // both quotes
        let replacement = format!("[\"{}\", \"{}\"]", base, override_file);
        Ok(format!("{}{}{}", &json[..value_start], replacement, &json[value_end..]))
    } else if trimmed.starts_with('[') {
        let end_rel = trimmed.find(']').ok_or("unterminated array")?;
        let close = value_start + end_rel; // position of ']'
        let inner = json[value_start + 1..close].trim();
        let insert = if inner.is_empty() {
            format!("\"{}\"", override_file)
        } else {
            format!("{}, \"{}\"", inner, override_file)
        };
        Ok(format!("{}[{}]{}", &json[..value_start], insert, &json[close + 1..]))
    } else {
        Err("dockerComposeFile is neither a string nor an array".into())
    }
}

/// Wires recipe files belonging to the discovered devcontainer into its JSON.
fn wire_recipe_into_devcontainer(
    worktree_path: &str,
    devcontainer_dir: &str,
    applied: &[String],
) -> Vec<String> {
    let mut errors = Vec::new();
    let json_relative = format!("{devcontainer_dir}/devcontainer.json");
    let json_path = Path::new(worktree_path).join(&json_relative);
    let Ok(original) = std::fs::read_to_string(&json_path) else {
        return vec![format!("cannot read {json_relative}")];
    };
    let mut json = original.clone();
    let override_path = format!("{devcontainer_dir}/docker-compose.override.yml");
    if applied.iter().any(|path| path == &override_path) {
        match add_override_to_devcontainer_json(&json, "docker-compose.override.yml") {
            Ok(updated) => json = updated,
            Err(error) => errors.push(format!("{json_relative}: {error}")),
        }
    }
    let postcreate_path = format!("{devcontainer_dir}/bento-postcreate.sh");
    if applied.iter().any(|path| path == &postcreate_path) {
        let hook = format!("bash {postcreate_path}");
        match add_postcreate_hook_to_devcontainer_json(&json, &hook) {
            Ok(updated) => json = updated,
            Err(error) => errors.push(format!("{json_relative}: {error}")),
        }
    }
    if json != original {
        match std::fs::write(&json_path, json) {
            Ok(_) => skip_worktree(worktree_path, &json_relative),
            Err(error) => errors.push(format!("{json_relative}: {error}")),
        }
    }
    errors
}

fn write_recipe_state(worktree_path: &str, devcontainer_dir: &str, result: &RecipeApplyResult) {
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

fn read_recipe_state(worktree_path: &str, devcontainer_dir: &str) -> Option<RecipeApplyResult> {
    let env_path = Path::new(worktree_path).join(devcontainer_dir).join(".env");
    let content = std::fs::read_to_string(env_path).ok()?;
    let encoded = content.lines().find_map(|line| line.strip_prefix("BENTO_RECIPE_STATE_HEX="))?;
    let raw = hex::decode(encoded).ok()?;
    serde_json::from_slice(&raw).ok()
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

/// Extracts published `(containerPort, hostPort)` pairs from a compose's `ports:`.
fn published_port_pairs(content: &str) -> Vec<(u16, u16)> {
    let mut out = vec![];
    let mut in_ports = false;
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.trim_end() == "ports:" {
            in_ports = true;
            continue;
        }
        if in_ports && !trimmed.starts_with('-') {
            in_ports = false;
        }
        if in_ports {
            if let Some((host, container, _)) = parse_port_mapping(trimmed) {
                if let Ok(c) = container.parse::<u16>() {
                    out.push((c, host));
                }
            }
        }
    }
    out
}

/// Finds `${BENTO_HOST_<N>}` container ports referenced in a file (e.g. an override
/// that wires a service by port). bento allocates a host port for each.
fn referenced_bento_hosts(content: &str) -> Vec<u16> {
    let mut out = vec![];
    for part in content.split("BENTO_HOST_").skip(1) {
        let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
        if let Ok(n) = digits.parse::<u16>() {
            if !out.contains(&n) {
                out.push(n);
            }
        }
    }
    out
}

/// Writes the isolated host-port map to `.devcontainer/.env` (auto-loaded by Compose)
/// so the compose/override can build per-worktree URLs via `${BENTO_HOST_*}`. Records
/// the base compose's remapped ports and allocates a fresh host port for any
/// `${BENTO_HOST_<N>}` the override references but the base doesn't publish (e.g.
/// keycloak). Reuses prior allocations (idempotent) and preserves non-BENTO lines.
fn write_bento_env(
    worktree_path: &str,
    devcontainer_dir: &str,
    compose: &str,
) -> Vec<(u16, u16)> {
    let env_path = Path::new(worktree_path).join(devcontainer_dir).join(".env");
    let existing = std::fs::read_to_string(&env_path).unwrap_or_default();
    let kept: Vec<String> = existing
        .lines()
        .filter(|l| !l.starts_with("BENTO_HOST_") && !l.trim().is_empty())
        .map(str::to_string)
        .collect();
    let prior: Vec<(u16, u16)> = existing
        .lines()
        .filter_map(|l| {
            let (n, h) = l.strip_prefix("BENTO_HOST_")?.split_once('=')?;
            Some((n.parse().ok()?, h.parse().ok()?))
        })
        .collect();

    let mut pairs = published_port_pairs(compose);
    let override_content = std::fs::read_to_string(
        Path::new(worktree_path)
            .join(devcontainer_dir)
            .join("docker-compose.override.yml"),
    )
    .unwrap_or_default();
    let mut next = pairs.iter().map(|(_, h)| *h).max().unwrap_or(20000) + 1;
    for n in referenced_bento_hosts(&override_content) {
        if pairs.iter().any(|(c, _)| *c == n) {
            continue;
        }
        if let Some((_, h)) = prior.iter().find(|(c, _)| *c == n) {
            pairs.push((n, *h));
        } else {
            while pairs.iter().any(|(_, h)| *h == next) {
                next += 1;
            }
            pairs.push((n, next));
            next += 1;
        }
    }

    let mut lines = kept;
    for (c, h) in &pairs {
        lines.push(format!("BENTO_HOST_{}={}", c, h));
    }
    if !lines.is_empty() {
        let _ = std::fs::write(&env_path, lines.join("\n") + "\n");
    }
    pairs
}

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

fn create_recipe_dir(recipes_dir: &str, project_key: &str) -> Result<String, String> {
    if recipes_dir.trim().is_empty() || !valid_project_key(project_key) {
        return Err("invalid recipe path".into());
    }
    let project_dir = Path::new(recipes_dir).join(project_key);
    let devcontainer_dir = project_dir.join(".devcontainer");
    std::fs::create_dir_all(&devcontainer_dir)
        .map_err(|error| error.to_string())?;
    Ok(project_dir.to_string_lossy().into_owned())
}

fn run_recipe_git(recipes_dir: &str, action: &str, message: Option<&str>) -> Result<String, String> {
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

        let mut first = overlay_recipe_detailed(recipes.to_str().unwrap(), "project", worktree.to_str().unwrap(), false);
        first.devcontainer_dir = "apps/api/.devcontainer".into();
        assert!(wire_recipe_into_devcontainer(worktree.to_str().unwrap(), &first.devcontainer_dir, &first.applied).is_empty());
        write_bento_env(worktree.to_str().unwrap(), &first.devcontainer_dir, &isolated);
        write_recipe_state(worktree.to_str().unwrap(), &first.devcontainer_dir, &first);

        let json = std::fs::read_to_string(devcontainer.join("devcontainer.json")).unwrap();
        assert!(json.contains("docker-compose.override.yml"), "{json}");
        assert!(json.contains("bash apps/api/.devcontainer/bento-postcreate.sh"), "{json}");
        assert_eq!(read_recipe_state(worktree.to_str().unwrap(), &first.devcontainer_dir).unwrap().project_key, "project");

        let second = overlay_recipe_detailed(recipes.to_str().unwrap(), "project", worktree.to_str().unwrap(), false);
        assert!(second.applied.is_empty());
        assert_eq!(second.skipped.len(), 2);
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

    #[test]
    fn override_json_string_to_array() {
        let json = "{\n  \"name\": \"x\",\n  \"dockerComposeFile\": \"docker-compose.yml\",\n  \"service\": \"app\"\n}";
        let out = add_override_to_devcontainer_json(json, "docker-compose.override.yml").unwrap();
        assert!(
            out.contains("[\"docker-compose.yml\", \"docker-compose.override.yml\"]"),
            "{out}"
        );
        assert!(out.contains("\"service\": \"app\""), "{out}");
    }

    #[test]
    fn override_json_is_idempotent() {
        let json = "{\"dockerComposeFile\": [\"docker-compose.yml\", \"docker-compose.override.yml\"]}";
        let out = add_override_to_devcontainer_json(json, "docker-compose.override.yml").unwrap();
        assert_eq!(out, json);
    }

    #[test]
    fn override_json_appends_to_array() {
        let json = "{\"dockerComposeFile\": [\"docker-compose.yml\"]}";
        let out = add_override_to_devcontainer_json(json, "docker-compose.override.yml").unwrap();
        assert!(out.contains("\"docker-compose.yml\", \"docker-compose.override.yml\""), "{out}");
    }

    #[test]
    fn override_json_errors_when_key_missing() {
        assert!(add_override_to_devcontainer_json("{\"service\": \"app\"}", "o.yml").is_err());
    }

    #[test]
    fn postcreate_hook_chains_string() {
        let json = "{\n  \"postCreateCommand\": \"bash x.sh\",\n  \"service\": \"app\"\n}";
        let out = add_postcreate_hook_to_devcontainer_json(json, "bash .devcontainer/bento-postcreate.sh").unwrap();
        assert!(out.contains("\"bash x.sh && bash .devcontainer/bento-postcreate.sh\""), "{out}");
        assert!(out.contains("\"service\": \"app\""), "{out}");
    }

    #[test]
    fn postcreate_hook_is_idempotent() {
        let json = "{\"postCreateCommand\": \"bash x.sh && bash .devcontainer/bento-postcreate.sh\"}";
        assert_eq!(
            add_postcreate_hook_to_devcontainer_json(json, "bash .devcontainer/bento-postcreate.sh").unwrap(),
            json
        );
    }

    #[test]
    fn postcreate_hook_errors_when_missing() {
        assert!(add_postcreate_hook_to_devcontainer_json("{\"x\": 1}", "h").is_err());
    }

    #[test]
    fn published_port_pairs_reads_ports() {
        let (isolated, _) = isolate_compose_yaml(
            SAMPLE,
            "wt",
            Some(("10.189.20", "10.189.21")),
            1,
            None,
        );
        assert!(published_port_pairs(&isolated).contains(&(8108, 20100)), "{isolated}");
    }

    #[test]
    fn referenced_bento_hosts_finds_refs() {
        let ov = "services:\n  keycloak:\n    ports:\n      - \"${BENTO_HOST_8080:-8080}:8080\"\n";
        assert_eq!(referenced_bento_hosts(ov), vec![8080]);
    }
}
