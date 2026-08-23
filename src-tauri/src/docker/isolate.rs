use super::compose_yaml::*;
use super::port_probe::*;
use super::subnet::*;
use super::devcontainer::RecipeApplyResult;


#[derive(serde::Serialize)]
pub struct IsolateResult {
    pub subnet: String,
    pub urls: Vec<ServiceUrl>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipe: Option<RecipeApplyResult>,
}

/// Generates a `docker-compose.override.yml` in the worktree that remaps the
/// network subnet, container names, and exposes ports so the stack can run
/// alongside the main repo stack without conflicts.
///
/// Ports are assigned with the formula: 20000 + subnet_offset×100 + ip_last_octet.
/// Exposed ports are discovered by inspecting the main stack's running containers.
///
/// Returns "no-compose" error if no docker-compose.yml found (treat as no-op).
#[tauri::command]
pub async fn docker_compose_isolate(worktree_path: String) -> Result<IsolateResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let compose_path = format!("{}/docker-compose.yml", worktree_path);
        if !std::path::Path::new(&compose_path).exists() {
            return Err("no-compose".into());
        }

        let content = std::fs::read_to_string(&compose_path).map_err(|e| e.to_string())?;
        let (network_name, old_prefix, services) =
            parse_compose_info(&content).ok_or("could not parse compose network info")?;

        if services.is_empty() {
            return Err("no services with static IPs found".into());
        }

        let worktree_dir = std::path::Path::new(&worktree_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("worktree")
            .to_string();

        // If this is a git worktree, the .git entry is a file pointing to the
        // main repo's .git dir. We expose that dir as a volume so git inside
        // containers can resolve the gitdir pointer (needed for yarn install).
        let git_file = format!("{}/.git", worktree_path);
        let git_volume_line = if std::path::Path::new(&git_file).is_file() {
            std::fs::read_to_string(&git_file)
                .ok()
                .and_then(|c| {
                    c.lines()
                        .find_map(|l| l.strip_prefix("gitdir:").map(|s| s.trim().to_string()))
                })
                .and_then(|gitdir| {
                    std::path::Path::new(&gitdir)
                        .parent() // worktrees/
                        .and_then(|p| p.parent()) // .git/
                        .and_then(|p| p.to_str())
                        .map(|main_git| format!("      - {}:{}:ro\n", main_git, main_git))
                })
        } else {
            None
        };

        // Reuse the subnet already assigned to this worktree if the override
        // exists — avoids regenerating a new subnet (and thus new ports) every
        // time the button is clicked while containers are running.
        let override_path_check = format!("{}/docker-compose.override.yml", worktree_path);
        let existing_prefix = std::fs::read_to_string(&override_path_check)
            .ok()
            .and_then(|c| {
                c.lines().find_map(|l| {
                    let t = l.trim();
                    let s = t
                        .strip_prefix("- subnet:")
                        .or_else(|| t.strip_prefix("subnet:"))?;
                    let without_mask = s.trim().split('/').next()?;
                    let parts: Vec<&str> = without_mask.split('.').collect();
                    if parts.len() == 4 {
                        Some(format!("{}.{}.{}", parts[0], parts[1], parts[2]))
                    } else {
                        None
                    }
                })
            });

        let new_prefix = match existing_prefix {
            Some(p) => p,
            None => find_free_subnet_prefix(&old_prefix, &worktree_path)
                .ok_or("no free subnet available in range")?,
        };
        let new_subnet = format!("{}.0/24", new_prefix);

        let base_third: u16 = old_prefix
            .split('.')
            .nth(2)
            .unwrap_or("0")
            .parse()
            .unwrap_or(0);
        let new_third: u16 = new_prefix
            .split('.')
            .nth(2)
            .unwrap_or("0")
            .parse()
            .unwrap_or(0);
        let subnet_offset = new_third.saturating_sub(base_third);

        let mut yaml = format!(
            "networks:\n  {}:\n    ipam:\n      config:\n        - subnet: {}\n\nservices:\n",
            network_name, new_subnet
        );

        let mut urls: Vec<ServiceUrl> = vec![];

        for svc in &services {
            let last_octet_str = svc.ip.rsplit('.').next().unwrap_or("0");
            let last_octet: u16 = last_octet_str.parse().unwrap_or(0);
            let new_ip = format!("{}.{}", new_prefix, last_octet_str);
            let new_container = format!("{}-{}", worktree_dir, svc.name);

            // Port base for this service: 20000 + offset×100 + last_octet
            let host_port_base = 20000 + subnet_offset * 100 + last_octet;

            // Discover internal ports by inspecting the main stack container
            let exposed = svc
                .container_name
                .as_deref()
                .map(get_exposed_ports)
                .unwrap_or_default();

            yaml.push_str(&format!(
                "  {}:\n    container_name: {}\n",
                svc.name, new_container
            ));

            if !exposed.is_empty() {
                // Detect URL base path using the WORKTREE container (new_container),
                // not the main stack container — the worktree one is the running instance.
                // 1. Vite config detection (reads base from vite.config.{ts,js})
                // 2. HTTP probe on the primary mapped port (generic fallback)
                let actual_first_port =
                    get_actual_host_port(&new_container, exposed[0]).unwrap_or(host_port_base);
                let url_base = get_vite_base_path(&new_container)
                    .or_else(|| {
                        let p = probe_http_path(actual_first_port);
                        if p.is_empty() {
                            None
                        } else {
                            Some(p)
                        }
                    })
                    .unwrap_or_default();
                yaml.push_str("    ports:\n");
                for (i, &internal_port) in exposed.iter().enumerate() {
                    // Prefer the actual running port; fall back to computed port
                    let host_port = get_actual_host_port(&new_container, internal_port)
                        .unwrap_or(host_port_base + i as u16);
                    yaml.push_str(&format!("      - \"{}:{}\"\n", host_port, internal_port));
                    urls.push(ServiceUrl {
                        service: svc.name.clone(),
                        url: format!("http://localhost:{}{}", host_port, url_base),
                    });
                }
            }

            if let Some(ref vol) = git_volume_line {
                yaml.push_str("    volumes:\n");
                yaml.push_str(vol);
            }

            yaml.push_str(&format!(
                "    networks:\n      {}:\n        ipv4_address: {}\n",
                network_name, new_ip
            ));
        }

        let override_path = format!("{}/docker-compose.override.yml", worktree_path);
        std::fs::write(&override_path, yaml).map_err(|e| e.to_string())?;

        ensure_global_gitignore("docker-compose.override.yml");

        Ok(IsolateResult {
            subnet: new_subnet,
            urls,
            recipe: None,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
