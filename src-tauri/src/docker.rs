// Shared Docker plumbing (used by the Docker panel and the DB panel) plus the
// container-management commands: list, start/stop/restart, logs.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

// macOS GUI apps don't inherit the shell PATH, so `docker` may not be on PATH.
// Resolve it through a login shell (Unix only; returns None on Windows).
fn login_shell_output(cmd: &str) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = Command::new(shell).arg("-lc").arg(cmd).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

// The docker executable: bare `docker` when it's on PATH (Linux/Windows GUI apps
// inherit it), else the path resolved via a login shell (the macOS case).
pub fn docker_bin() -> Option<String> {
    let on_path = Command::new("docker")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if on_path {
        return Some("docker".into());
    }
    let path = login_shell_output("command -v docker")?;
    let path = path.trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

pub fn docker_output(args: &[&str]) -> Option<String> {
    let bin = docker_bin()?;
    let out = Command::new(bin).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

// Container names/ids from docker are alphanumeric plus _-. — reject anything
// else before using one in a command.
pub fn is_safe_container(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

// These shell out to docker, which can take seconds (restart stops + starts the
// container). They're `async` + run on a blocking pool so the UI thread never
// freezes while waiting.

#[tauri::command]
pub async fn docker_list() -> String {
    tauri::async_runtime::spawn_blocking(|| {
        docker_output(&["ps", "-a", "--format", "{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Ports}}|{{.Label \"com.docker.compose.project\"}}"]).unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

fn docker_action(action: &str, id: &str) -> Result<(), String> {
    if !is_safe_container(id) {
        return Err("contenedor inválido".into());
    }
    let bin = docker_bin().ok_or("docker no encontrado")?;
    let out = Command::new(bin)
        .args([action, id])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

async fn run_action(action: &'static str, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || docker_action(action, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_start(id: String) -> Result<(), String> {
    run_action("start", id).await
}

#[tauri::command]
pub async fn docker_stop(id: String) -> Result<(), String> {
    run_action("stop", id).await
}

#[tauri::command]
pub async fn docker_restart(id: String) -> Result<(), String> {
    run_action("restart", id).await
}

#[tauri::command]
pub async fn docker_logs(id: String, tail: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_container(&id) {
            return Err("contenedor inválido".to_string());
        }
        let bin = docker_bin().ok_or("docker no encontrado")?;
        let tail = tail.to_string();
        let out = Command::new(bin)
            .args(["logs", "--tail", &tail, &id])
            .output()
            .map_err(|e| e.to_string())?;
        // docker writes container logs to both stdout and stderr; show both.
        let mut combined = String::from_utf8_lossy(&out.stdout).to_string();
        combined.push_str(&String::from_utf8_lossy(&out.stderr));
        Ok(combined)
    })
    .await
    .map_err(|e| e.to_string())?
}

// --- Live logs: `docker logs -f` streamed to the frontend via events ---

// Running follow processes, keyed by container, so they can be stopped.
#[derive(Default)]
pub struct LogStreams(Mutex<HashMap<String, Child>>);

fn pipe_lines(reader: impl Read + Send + 'static, app: AppHandle, event: String) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let _ = app.emit(&event, format!("{}\n", line));
        }
    });
}

#[tauri::command]
pub fn docker_logs_follow(
    id: String,
    tail: u32,
    app: AppHandle,
    state: tauri::State<LogStreams>,
) -> Result<(), String> {
    if !is_safe_container(&id) {
        return Err("contenedor inválido".into());
    }
    // Replace any existing stream for this container.
    if let Some(mut child) = state.0.lock().unwrap().remove(&id) {
        let _ = child.kill();
    }
    let bin = docker_bin().ok_or("docker no encontrado")?;
    let tail = tail.to_string();
    let mut child = Command::new(bin)
        .args(["logs", "-f", "--tail", &tail, &id])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let event = format!("docker-logs-{}", id);
    if let Some(o) = child.stdout.take() {
        pipe_lines(o, app.clone(), event.clone());
    }
    if let Some(e) = child.stderr.take() {
        pipe_lines(e, app.clone(), event.clone());
    }
    state.0.lock().unwrap().insert(id, child);
    Ok(())
}

#[tauri::command]
pub fn docker_logs_stop(id: String, state: tauri::State<LogStreams>) -> Result<(), String> {
    if let Some(mut child) = state.0.lock().unwrap().remove(&id) {
        let _ = child.kill();
    }
    Ok(())
}

// --- Exec terminal: argv to open a shell inside a container (run in a PTY) ---

#[tauri::command]
pub fn docker_exec_argv(container: String) -> Result<Vec<String>, String> {
    if !is_safe_container(&container) {
        return Err("contenedor inválido".into());
    }
    let bin = docker_bin().ok_or("docker no encontrado")?;
    // Prefer bash (Tab completion via readline); fall back to sh when it's absent.
    Ok(vec![
        bin,
        "exec".into(),
        "-it".into(),
        container,
        "sh".into(),
        "-c".into(),
        "command -v bash >/dev/null 2>&1 && exec bash || exec sh".into(),
    ])
}

// --- docker-compose isolation: per-worktree override with remapped subnet + container names ---

struct ComposeService {
    name: String,
    ip: String,
    container_name: Option<String>,
}

#[derive(serde::Serialize)]
pub struct ServiceUrl {
    pub service: String,
    pub url: String,
}

#[derive(serde::Serialize)]
pub struct IsolateResult {
    pub subnet: String,
    pub urls: Vec<ServiceUrl>,
}

// Parse a docker-compose.yml and return (network_name, subnet_prefix, services).
// subnet_prefix: "10.189.4" (without the .0/24 part).
fn parse_compose_info(content: &str) -> Option<(String, String, Vec<ComposeService>)> {
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

// Inspect a running container to get the ports it listens on internally.
// Tries ExposedPorts first; falls back to /proc/net/tcp6 + /proc/net/tcp
// Query docker inspect for the actual host port bound to an internal port of a
// running container. Returns None if the container is not running or has no binding.
fn get_actual_host_port(container_name: &str, internal_port: u16) -> Option<u16> {
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
fn get_exposed_ports(container_name: &str) -> Vec<u16> {
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
fn get_vite_base_path(container_name: &str) -> Option<String> {
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
fn probe_http_path(host_port: u16) -> String {
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

fn get_docker_used_subnets() -> Vec<String> {
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
fn get_sibling_override_subnets(worktree_path: &str) -> Vec<String> {
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

fn find_free_subnet_prefix(base_prefix: &str, worktree_path: &str) -> Option<String> {
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

fn ensure_global_gitignore(pattern: &str) {
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
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs `docker compose up -d` in the given worktree directory.
#[tauri::command]
pub async fn docker_compose_up(worktree_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let compose_file = format!("{}/docker-compose.yml", worktree_path);
        if !std::path::Path::new(&compose_file).exists() {
            return Err("no-compose".into());
        }
        let bin = match docker_bin() {
            Some(b) => b,
            None => return Err("docker not found".into()),
        };
        let out = Command::new(&bin)
            .args(["compose", "up", "-d", "--remove-orphans"])
            .current_dir(&worktree_path)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs `docker compose down` in the given worktree directory to stop and remove
/// the containers, networks, and anonymous volumes created for that task.
/// Silently succeeds if there is no compose file or Docker is not available.
#[tauri::command]
pub async fn docker_compose_down(worktree_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let compose_file = format!("{}/docker-compose.yml", worktree_path);
        if !std::path::Path::new(&compose_file).exists() {
            return Ok(()); // no compose project — nothing to do
        }
        let bin = match docker_bin() {
            Some(b) => b,
            None => return Ok(()), // docker not available
        };
        // `docker compose` (v2 plugin) preferred; fall back to `docker-compose` (v1).
        let out = Command::new(&bin)
            .args(["compose", "down", "--remove-orphans"])
            .current_dir(&worktree_path)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            // "no configuration file provided" means nothing was running — not an error.
            if !err.contains("no configuration file") {
                return Err(err);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Stream `docker compose logs -f` for all services; emits to event `docker-compose-logs-<dir>`.
#[tauri::command]
pub fn docker_compose_logs_follow(
    worktree_path: String,
    tail: u32,
    app: AppHandle,
    state: tauri::State<LogStreams>,
) -> Result<(), String> {
    let key = format!("compose:{}", worktree_path);
    if let Some(mut child) = state.0.lock().unwrap().remove(&key) {
        let _ = child.kill();
    }
    let bin = docker_bin().ok_or("docker no encontrado")?;
    let tail_s = tail.to_string();
    let mut child = Command::new(&bin)
        .args(["compose", "logs", "-f", "--tail", &tail_s])
        .current_dir(&worktree_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let dir = std::path::Path::new(&worktree_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "compose".into());
    let event = format!("docker-compose-logs-{}", dir);
    if let Some(o) = child.stdout.take() {
        pipe_lines(o, app.clone(), event.clone());
    }
    if let Some(e) = child.stderr.take() {
        pipe_lines(e, app, event);
    }
    state.0.lock().unwrap().insert(key, child);
    Ok(())
}

#[tauri::command]
pub fn docker_compose_logs_stop(
    worktree_path: String,
    state: tauri::State<LogStreams>,
) -> Result<(), String> {
    let key = format!("compose:{}", worktree_path);
    if let Some(mut child) = state.0.lock().unwrap().remove(&key) {
        let _ = child.kill();
    }
    Ok(())
}
