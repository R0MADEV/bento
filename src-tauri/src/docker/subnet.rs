use super::*;


pub(super) fn get_docker_used_subnets() -> Vec<String> {
    let bin = match docker_bin() {
        Some(b) => b,
        None => return vec![],
    };
    let ids = match Command::new(&bin).args(["network", "ls", "-q"]).output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return vec![],
    };
    let mut subnets = vec![];
    for id in ids.lines().map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(out) = Command::new(&bin)
            .args([
                "network",
                "inspect",
                "--format",
                "{{range .IPAM.Config}}{{.Subnet}}|{{end}}",
                id,
            ])
            .output()
        {
            for part in String::from_utf8_lossy(&out.stdout).split('|') {
                let s = part.trim().to_string();
                if !s.is_empty() {
                    subnets.push(s);
                }
            }
        }
    }
    subnets
}

// Scan sibling directories for existing override files to avoid assigning the
// same subnet to two worktrees that haven't started their Docker stack yet.
pub(super) fn get_sibling_override_subnets(worktree_path: &str) -> Vec<String> {
    let parent = match std::path::Path::new(worktree_path).parent() {
        Some(p) => p,
        None => return vec![],
    };
    let mut subnets = vec![];
    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            let override_file = entry.path().join("docker-compose.override.yml");
            if override_file
                == std::path::Path::new(worktree_path).join("docker-compose.override.yml")
            {
                continue; // skip the worktree we're about to write
            }
            if let Ok(content) = std::fs::read_to_string(override_file) {
                for line in content.lines() {
                    if let Some(rest) = line.trim().strip_prefix("subnet:") {
                        subnets.push(rest.trim().to_string());
                    }
                }
            }
        }
    }
    subnets
}

pub(super) fn find_free_subnet_prefix(base_prefix: &str, worktree_path: &str) -> Option<String> {
    let parts: Vec<&str> = base_prefix.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let base_third: u8 = parts[2].parse().ok()?;
    let prefix16 = format!("{}.{}", parts[0], parts[1]);

    let mut used = get_docker_used_subnets();
    used.extend(get_sibling_override_subnets(worktree_path));

    for delta in 1u8..=50 {
        let new_third = base_third.checked_add(delta)?;
        let candidate = format!("{}.{}", prefix16, new_third);
        let candidate_subnet = format!("{}.0/24", candidate);
        let in_use = used.iter().any(|s| {
            let s = s.trim();
            s == candidate_subnet || s.starts_with(&format!("{}.", candidate))
        });
        if !in_use {
            return Some(candidate);
        }
    }
    None
}

pub(super) fn ensure_global_gitignore(pattern: &str) {
    let path = login_shell_output("git config --global core.excludesFile")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            let home = std::env::var("HOME").unwrap_or_default();
            format!("{}/.config/git/ignore", home)
        });
    if path.is_empty() {
        return;
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == pattern) {
        return;
    }
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(pattern);
    content.push('\n');
    let _ = std::fs::write(&path, content);
}
