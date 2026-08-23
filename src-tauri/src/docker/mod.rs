// Shared Docker plumbing (used by the Docker panel and the DB panel) plus the
// container-management commands: list, start/stop/restart, logs.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub(crate) mod compose_yaml;
pub(crate) mod port_probe;
pub(crate) mod subnet;
pub(crate) mod isolate;
pub(crate) mod devcontainer;
#[cfg(test)]
pub(crate) mod test_support;

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
