use crate::*;
use super::*;

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
pub fn wire_recipe_into_devcontainer(
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

#[cfg(test)]
mod tests {
    use super::*;
    

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
}
