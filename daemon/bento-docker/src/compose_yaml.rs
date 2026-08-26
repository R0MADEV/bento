use crate::*;
use super::port_probe::ServiceUrl;


pub struct ComposeService {
    pub name: String,
    pub ip: String,
    pub container_name: Option<String>,
}

// Parse a docker-compose.yml and return (network_name, subnet_prefix, services).
// subnet_prefix: "10.189.4" (without the .0/24 part).
pub fn parse_compose_info(content: &str) -> Option<(String, String, Vec<ComposeService>)> {

    #[derive(PartialEq)]
    enum Section {
        Other,
        Services,
        Networks,
    }

    let mut section = Section::Other;
    let mut current_service: Option<String> = None;
    let mut current_container_name: Option<String> = None;
    let mut services: Vec<ComposeService> = vec![];
    let mut subnet_prefix: Option<String> = None;
    let mut network_name: Option<String> = None;

    for line in content.lines() {
        // Top-level section key: non-indented, non-empty, ends with ':'
        if !line.starts_with(' ')
            && !line.starts_with('\t')
            && line.ends_with(':')
            && !line.starts_with('#')
        {
            let key = line.trim_end_matches(':').trim();
            section = match key {
                "services" => Section::Services,
                "networks" => Section::Networks,
                _ => Section::Other,
            };
            current_service = None;
            current_container_name = None;
            continue;
        }

        match section {
            Section::Services => {
                if line.starts_with("  ") && !line.starts_with("   ") {
                    let t = line.trim();
                    if t.ends_with(':') {
                        current_service = Some(t.trim_end_matches(':').to_string());
                        current_container_name = None;
                    }
                } else if let Some(ref svc_name) = current_service.clone() {
                    let t = line.trim();
                    if let Some(rest) = t.strip_prefix("ipv4_address:") {
                        services.push(ComposeService {
                            name: svc_name.clone(),
                            ip: rest.trim().to_string(),
                            container_name: current_container_name.clone(),
                        });
                    } else if let Some(rest) = t.strip_prefix("container_name:") {
                        current_container_name = Some(rest.trim().to_string());
                    }
                }
            }
            Section::Networks => {
                if line.starts_with("  ") && !line.starts_with("   ") {
                    let t = line.trim();
                    if t.ends_with(':') && network_name.is_none() {
                        network_name = Some(t.trim_end_matches(':').to_string());
                    }
                } else {
                    // Subnet can appear as "subnet: x" or "- subnet: x" (YAML list item)
                    let t = line.trim();
                    let subnet_val = t
                        .strip_prefix("subnet:")
                        .or_else(|| t.strip_prefix("- subnet:"));
                    if let Some(rest) = subnet_val {
                        if let Some(without_mask) = rest.trim().split('/').next() {
                            let parts: Vec<&str> = without_mask.split('.').collect();
                            if parts.len() == 4 && subnet_prefix.is_none() {
                                subnet_prefix =
                                    Some(format!("{}.{}.{}", parts[0], parts[1], parts[2]));
                            }
                        }
                    }
                }
            }
            Section::Other => {}
        }
    }

    Some((network_name?, subnet_prefix?, services))
}

/// Rewrites a devcontainer's `docker-compose.yml` text so a worktree gets an
/// isolated stack. Generic — it only touches what a given compose declares:
/// - a unique top-level `name:` (compose project) — always;
/// - a fixed `container_name:` gets worktree-prefixed (container names are global);
/// - static IPs + subnet remapped only when `subnet` is `Some((old, new))`;
/// - published host ports remapped as `20000 + port_offset*100 + index`.
///
/// Editing the base (vs a `docker-compose.override.yml`) is required because
/// compose-merge only *appends* `ports:`, so it can never move a project's fixed
/// host ports. Returns the new YAML and the remapped host URLs.
pub fn isolate_compose_yaml(
    content: &str,
    project_name: &str,
    subnet: Option<(&str, &str)>,
    port_offset: u16,
    git_mount: Option<&str>,
) -> (String, Vec<ServiceUrl>) {
    let old_ip_prefix = subnet.map(|(old, _)| format!("{}.", old));

    let mut out = String::with_capacity(content.len() + 32);
    let mut urls: Vec<ServiceUrl> = vec![];
    let mut in_ports = false;
    let mut port_index: u16 = 0;
    let mut name_set = false;
    let mut git_injected = false;

    for line in content.lines() {
        // Top-level project name (column 0). Replace the first one we see.
        if !name_set && line.starts_with("name:") {
            out.push_str(&format!("name: {}\n", project_name));
            name_set = true;
            continue;
        }

        let trimmed = line.trim_start();
        let indent = &line[..line.len() - trimmed.len()];

        if trimmed.trim_end() == "ports:" {
            in_ports = true;
            out.push_str(line);
            out.push('\n');
            continue;
        }
        // A non-list line at any indent ends the current ports block.
        if in_ports && !trimmed.starts_with('-') {
            in_ports = false;
        }

        // The workspace bind (`- ..:/workspace`) mounts the worktree, whose `.git`
        // is a file pointing to the MAIN repo's gitdir. Mount that gitdir at the
        // same absolute path so git works inside the container (else "not a git
        // repository"). Same trick the plain-compose isolate uses.
        if let Some(git) = git_mount {
            if !git_injected && trimmed.starts_with("- ..:") {
                out.push_str(line);
                out.push('\n');
                out.push_str(&format!("{}- {}:{}\n", indent, git, git));
                git_injected = true;
                continue;
            }
        }

        // Explicit container_name collides across projects (names are global) —
        // prefix it with the worktree so it stays unique.
        if let Some(rest) = trimmed.strip_prefix("container_name:") {
            out.push_str(&format!(
                "{}container_name: {}-{}\n",
                indent,
                project_name,
                rest.trim()
            ));
            continue;
        }

        // Static IP + subnet remap only when the compose declares a custom subnet.
        if let (Some((_, new_prefix)), Some(old_ip)) = (subnet, old_ip_prefix.as_deref()) {
            if let Some(rest) = trimmed.strip_prefix("ipv4_address:") {
                if let Some(octet) = rest.trim().strip_prefix(old_ip) {
                    out.push_str(&format!("{}ipv4_address: {}.{}\n", indent, new_prefix, octet));
                    continue;
                }
            }
            let is_dashed = trimmed.starts_with("- subnet:");
            if let Some(rest) = trimmed
                .strip_prefix("- subnet:")
                .or_else(|| trimmed.strip_prefix("subnet:"))
            {
                let mask = rest.trim().split('/').nth(1).unwrap_or("24");
                let dash = if is_dashed { "- " } else { "" };
                out.push_str(&format!("{}{}subnet: {}.0/{}\n", indent, dash, new_prefix, mask));
                continue;
            }
        }

        // Published host port inside a ports: block.
        if in_ports {
            if let Some((_, container, quoted)) = parse_port_mapping(trimmed) {
                let new_host = 20000 + port_offset * 100 + port_index;
                port_index += 1;
                let q = if quoted { "\"" } else { "" };
                out.push_str(&format!("{}- {}{}:{}{}\n", indent, q, new_host, container, q));
                urls.push(ServiceUrl {
                    service: format!("port {}", container),
                    url: format!("http://localhost:{}", new_host),
                });
                continue;
            }
        }

        out.push_str(line);
        out.push('\n');
    }

    if !name_set {
        out.insert_str(0, &format!("name: {}\n", project_name));
    }

    (out, urls)
}

/// Parses a compose `ports:` list item like `- "8108:8108"` into
/// `(host_port, container_port, was_quoted)`. Returns `None` for anything that is
/// not a plain `HOST:CONTAINER` numeric mapping (e.g. `host_ip:host:container`).
pub fn parse_port_mapping(item: &str) -> Option<(u16, String, bool)> {
    let rest = item.strip_prefix('-')?.trim();
    let quoted = rest.starts_with('"');
    let inner = rest.trim_matches('"');
    let mut parts = inner.split(':');
    let host = parts.next()?.trim();
    let container = parts.next()?.trim();
    // Reject host_ip:host:container and any other non `HOST:CONTAINER` shape.
    if parts.next().is_some() {
        return None;
    }
    let host_port: u16 = host.parse().ok()?;
    container.parse::<u16>().ok()?;
    Some((host_port, container.to_string(), quoted))
}

/// First `/24` subnet prefix declared in a compose (`10.189.20` from
/// `10.189.20.0/24`), or `None` when it relies on the default network.
pub fn first_subnet_prefix(content: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let t = line.trim();
        let s = t
            .strip_prefix("- subnet:")
            .or_else(|| t.strip_prefix("subnet:"))?;
        let without_mask = s.trim().split('/').next()?;
        let parts: Vec<&str> = without_mask.split('.').collect();
        (parts.len() == 4).then(|| format!("{}.{}.{}", parts[0], parts[1], parts[2]))
    })
}

pub fn relative_path_string(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

pub fn valid_project_key(project_key: &str) -> bool {
    let key = Path::new(project_key);
    !project_key.is_empty()
        && key.components().count() == 1
        && matches!(key.components().next(), Some(Component::Normal(_)))
}


#[cfg(test)]
mod tests {
    use super::*;
    
    use crate::test_support::*;

    #[test]
    fn isolates_name_subnet_ips_and_ports() {
        let (out, urls) = isolate_compose_yaml(
            SAMPLE,
            "konect-nixon-nixon-459",
            Some(("10.189.20", "10.189.21")),
            1,
            None,
        );
        assert!(out.contains("name: konect-nixon-nixon-459"), "{out}");
        assert!(!out.contains("name: nixon_devcontainer"), "{out}");
        assert!(out.contains("ipv4_address: 10.189.21.10"), "{out}");
        assert!(out.contains("ipv4_address: 10.189.21.6"), "{out}");
        assert!(out.contains("- subnet: 10.189.21.0/24"), "{out}");
        assert!(out.contains("- \"20100:8108\""), "{out}");
        assert!(!out.contains("8108:8108"), "{out}");
        assert_eq!(urls.len(), 1);
        assert_eq!(urls[0].url, "http://localhost:20100");
    }

    #[test]
    fn adds_name_when_missing() {
        let src = "services:\n  app:\n    image: x\n";
        let (out, _) = isolate_compose_yaml(src, "proj-1", None, 5, None);
        assert!(out.starts_with("name: proj-1\n"), "{out}");
    }

    #[test]
    fn isolates_without_custom_subnet() {
        let (out, urls) = isolate_compose_yaml(SAMPLE_NO_SUBNET, "proj", None, 7, None);
        assert!(out.starts_with("name: proj\n"), "{out}");
        // fixed container_name gets worktree-prefixed so it stays globally unique
        assert!(out.contains("container_name: proj-web"), "{out}");
        // port remapped with offset 7 -> 20000 + 700 + 0
        assert!(out.contains("- \"20700:3000\""), "{out}");
        assert!(!out.contains("\"3000:3000\""), "{out}");
        assert_eq!(urls[0].url, "http://localhost:20700");
    }

    #[test]
    fn mounts_main_git_dir_once() {
        let (out, _) = isolate_compose_yaml(
            SAMPLE,
            "wt",
            Some(("10.189.20", "10.189.21")),
            1,
            Some("/repo/.git"),
        );
        assert!(out.contains("- ..:/workspace:cached"), "{out}");
        assert!(out.contains("- /repo/.git:/repo/.git"), "{out}");
        assert_eq!(out.matches("/repo/.git:/repo/.git").count(), 1, "{out}");
    }

    #[test]
    fn parses_simple_port_mapping() {
        assert_eq!(
            parse_port_mapping("- \"8108:8108\""),
            Some((8108, "8108".into(), true))
        );
        assert_eq!(
            parse_port_mapping("- 5540:5540"),
            Some((5540, "5540".into(), false))
        );
    }

    #[test]
    fn skips_non_numeric_or_triple_port() {
        assert_eq!(parse_port_mapping("- \"127.0.0.1:8108:8108\""), None);
        assert_eq!(parse_port_mapping("- ../.env:/x"), None);
    }

    #[test]
    fn first_subnet_prefix_optional() {
        assert_eq!(first_subnet_prefix(SAMPLE).as_deref(), Some("10.189.20"));
        assert_eq!(first_subnet_prefix(SAMPLE_NO_SUBNET), None);
    }
}
