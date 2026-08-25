use crate::*;


#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct ServiceUrl {
    pub service: String,
    pub url: String,
}

// Inspect a running container to get the ports it listens on internally.
// Tries ExposedPorts first; falls back to /proc/net/tcp6 + /proc/net/tcp
// Query docker inspect for the actual host port bound to an internal port of a
// running container. Returns None if the container is not running or has no binding.
pub fn get_actual_host_port(container_name: &str, internal_port: u16) -> Option<u16> {
    let bin = docker_bin()?;
    let format = "{{json .HostConfig.PortBindings}}";
    let out = Command::new(&bin)
        .args(["inspect", "--format", format, container_name])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // Parse: {"3000/tcp":[{"HostIp":"","HostPort":"20231"}], ...}
    let key = format!("{}/tcp", internal_port);
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get(&key)?
        .as_array()?
        .first()?
        .get("HostPort")?
        .as_str()?
        .parse()
        .ok()
}

// for images that listen on ports without declaring EXPOSE in their Dockerfile.
pub fn get_exposed_ports(container_name: &str) -> Vec<u16> {
    let bin = match docker_bin() {
        Some(b) => b,
        None => return vec![],
    };
    let out = match Command::new(&bin)
        .args([
            "inspect",
            "--format",
            "{{json .Config.ExposedPorts}}",
            container_name,
        ])
        .output()
    {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => return vec![],
    };
    let mut ports = vec![];
    for part in out.split('"') {
        let stripped = part
            .strip_suffix("/tcp")
            .or_else(|| part.strip_suffix("/udp"));
        if let Some(port_str) = stripped {
            if let Ok(p) = port_str.parse::<u16>() {
                ports.push(p);
            }
        }
    }
    if !ports.is_empty() {
        return ports;
    }

    // Fallback: parse LISTEN entries from /proc/net/tcp6 and /proc/net/tcp.
    // State 0A = LISTEN; local_address format is {ip_hex}:{port_hex}.
    let mut proc_ports: Vec<u16> = vec![];
    for proc_file in &["/proc/net/tcp6", "/proc/net/tcp"] {
        let raw = Command::new(&bin)
            .args(["exec", container_name, "cat", proc_file])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        for line in raw.lines().skip(1) {
            let mut cols = line.split_whitespace();
            let _sl = cols.next();
            let local = match cols.next() {
                Some(v) => v,
                None => continue,
            };
            cols.next(); // remote_address
            let state = match cols.next() {
                Some(v) => v,
                None => continue,
            };
            if state != "0A" {
                continue;
            }
            if let Some(port_hex) = local.rsplit(':').next() {
                if let Ok(p) = u16::from_str_radix(port_hex, 16) {
                    // Skip ephemeral ports (>= 32768) — these are HMR sockets,
                    // random kernel-assigned ports, etc., not real service ports.
                    if p > 0 && p < 32768 && !proc_ports.contains(&p) {
                        proc_ports.push(p);
                    }
                }
            }
        }
    }
    proc_ports
}

// Read the Vite base path from a running container.
// Finds the Vite process working directory via /proc/<pid>/cwd, then reads
// vite.config.{ts,js} from there and extracts the `base` option.
// Returns Some("/brand/") etc. when found, None otherwise.
pub fn get_vite_base_path(container_name: &str) -> Option<String> {
    let bin = docker_bin()?;
    // Find the PID of the running Vite process.
    let pgrep_out = Command::new(&bin)
        .args([
            "exec",
            container_name,
            "pgrep",
            "-f",
            "node_modules/.bin/vite",
        ])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let pid = String::from_utf8_lossy(&pgrep_out.stdout)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(String::from)?;
    // Resolve the working directory of that process.
    let cwd_out = Command::new(&bin)
        .args([
            "exec",
            container_name,
            "readlink",
            &format!("/proc/{}/cwd", pid),
        ])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let cwd = String::from_utf8_lossy(&cwd_out.stdout).trim().to_string();
    if cwd.is_empty() {
        return None;
    }
    // Try vite.config.ts then vite.config.js from the working directory.
    for config_name in &["vite.config.ts", "vite.config.js"] {
        let config_path = format!("{}/{}", cwd, config_name);
        let cat_out = Command::new(&bin)
            .args(["exec", container_name, "cat", &config_path])
            .output()
            .ok()
            .filter(|o| o.status.success());
        let content = match cat_out {
            Some(o) => String::from_utf8_lossy(&o.stdout).to_string(),
            None => continue,
        };
        for line in content.lines() {
            let t = line.trim();
            // Match: const base = '/brand/';  or  base: '/brand/',
            let rest = if let Some(r) = t.strip_prefix("const base = ") {
                r
            } else if let Some(r) = t.strip_prefix("base:") {
                r.trim()
            } else {
                continue;
            };
            let path = rest
                .trim()
                .trim_end_matches([',', ';'])
                .trim_matches(|c: char| c == '\'' || c == '"');
            if !path.is_empty() && path.starts_with('/') && path != "/" {
                return Some(path.to_string());
            }
        }
    }
    None
}

// Generic HTTP probe: connects to localhost:host_port, sends GET /, reads the
// response status and Location header. Returns the usable path:
//   - 200 → "/"
//   - 3xx + Location → the redirect path
//   - anything else (timeout, 404, hang) → ""
// Used as fallback when no Vite process is detected.
pub fn probe_http_path(host_port: u16) -> String {
    use std::io::{BufRead, BufReader, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;

    let addr: SocketAddr = match format!("127.0.0.1:{}", host_port).parse() {
        Ok(a) => a,
        Err(_) => return String::new(),
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return String::new();
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));

    let request = format!(
        "GET / HTTP/1.1\r\nHost: localhost:{}\r\nConnection: close\r\n\r\n",
        host_port
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return String::new();
    }

    let mut reader = BufReader::new(&stream);
    let mut status_line = String::new();
    if reader.read_line(&mut status_line).is_err() {
        return String::new();
    }
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    if status == 200 {
        return "/".to_string();
    }
    if matches!(status, 301 | 302 | 307 | 308) {
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                break;
            }
            if let Some(loc) = trimmed.strip_prefix("Location:") {
                let loc = loc.trim();
                if loc.starts_with('/') {
                    return loc.to_string();
                }
                let after_scheme = loc
                    .strip_prefix("http://")
                    .or_else(|| loc.strip_prefix("https://"))
                    .unwrap_or("");
                if let Some(slash_idx) = after_scheme.find('/') {
                    return after_scheme[slash_idx..].to_string();
                }
            }
            line.clear();
        }
    }
    String::new()
}

/// Builds browsable localhost URLs from `(containerPort, hostPort)` pairs — every
/// isolated port (base compose + override), so bento lists the frontend/backend/etc.
pub fn pairs_to_urls(pairs: &[(u16, u16)]) -> Vec<ServiceUrl> {
    pairs
        .iter()
        .map(|(c, h)| ServiceUrl {
            service: format!("port {}", c),
            url: format!("http://localhost:{}", h),
        })
        .collect()
}

/// Deterministic per-worktree port offset (1..=90) for projects without a custom
/// subnet — FNV-1a so it's stable across runs without Date/random.
pub fn stable_port_offset(seed: &str) -> u16 {
    let mut h: u32 = 2166136261;
    for b in seed.bytes() {
        h = (h ^ b as u32).wrapping_mul(16777619);
    }
    1 + (h % 90) as u16
}


#[cfg(test)]
mod tests {
    use super::*;
    
    

    #[test]
    fn stable_port_offset_is_deterministic_and_bounded() {
        let a = stable_port_offset("konect-nixon-nixon-459");
        assert_eq!(a, stable_port_offset("konect-nixon-nixon-459"));
        assert!((1..=90).contains(&a));
    }

    #[test]
    fn pairs_to_urls_builds_localhost_urls() {
        let urls = pairs_to_urls(&[(8108, 20100), (3000, 20104)]);
        assert_eq!(urls.len(), 2);
        assert_eq!(urls[0].url, "http://localhost:20100");
        assert_eq!(urls[1].url, "http://localhost:20104");
    }
}
