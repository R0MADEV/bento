// Shared Docker plumbing (used by the Docker panel and the DB panel) plus the
// container-management commands: list, start/stop/restart, logs.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipe: Option<RecipeApplyResult>,
}

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
fn isolate_compose_yaml(
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
fn parse_port_mapping(item: &str) -> Option<(u16, String, bool)> {
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
fn first_subnet_prefix(content: &str) -> Option<String> {
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

/// Deterministic per-worktree port offset (1..=90) for projects without a custom
/// subnet — FNV-1a so it's stable across runs without Date/random.
fn stable_port_offset(seed: &str) -> u16 {
    let mut h: u32 = 2166136261;
    for b in seed.bytes() {
        h = (h ^ b as u32).wrapping_mul(16777619);
    }
    1 + (h % 90) as u16
}

/// Builds browsable localhost URLs from `(containerPort, hostPort)` pairs — every
/// isolated port (base compose + override), so bento lists the frontend/backend/etc.
fn pairs_to_urls(pairs: &[(u16, u16)]) -> Vec<ServiceUrl> {
    pairs
        .iter()
        .map(|(c, h)| ServiceUrl {
            service: format!("port {}", c),
            url: format!("http://localhost:{}", h),
        })
        .collect()
}

fn relative_path_string(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn valid_project_key(project_key: &str) -> bool {
    let key = Path::new(project_key);
    !project_key.is_empty()
        && key.components().count() == 1
        && matches!(key.components().next(), Some(Component::Normal(_)))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory(name: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "bento-docker-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    const SAMPLE: &str = "name: nixon_devcontainer
services:
  app:
    volumes:
      - ..:/workspace:cached
    networks:
      nixon-network:
        ipv4_address: 10.189.20.10
  typesense:
    ports:
      - \"8108:8108\"
    networks:
      nixon-network:
        ipv4_address: 10.189.20.6
networks:
  nixon-network:
    ipam:
      config:
        - subnet: 10.189.20.0/24
";

    // A generic devcontainer compose with NO custom subnet, but a fixed
    // container_name and a published port — both must still be isolated.
    const SAMPLE_NO_SUBNET: &str = "services:
  web:
    image: nginx
    container_name: web
    ports:
      - \"3000:3000\"
";

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

    fn init_test_git_repo(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "bento@example.test"],
            vec!["config", "user.name", "Bento Test"],
        ] {
            assert!(Command::new("git").args(args).current_dir(path).status().unwrap().success());
        }
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

    #[test]
    fn stable_port_offset_is_deterministic_and_bounded() {
        let a = stable_port_offset("konect-nixon-nixon-459");
        assert_eq!(a, stable_port_offset("konect-nixon-nixon-459"));
        assert!((1..=90).contains(&a));
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

    #[test]
    fn pairs_to_urls_builds_localhost_urls() {
        let urls = pairs_to_urls(&[(8108, 20100), (3000, 20104)]);
        assert_eq!(urls.len(), 2);
        assert_eq!(urls[0].url, "http://localhost:20100");
        assert_eq!(urls[1].url, "http://localhost:20104");
    }
}
