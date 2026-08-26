use crate::*;
use super::*;

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
pub fn write_bento_env(
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

#[cfg(test)]
mod tests {
    use super::*;
    
    use crate::test_support::*;

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
