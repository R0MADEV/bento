// Shared Docker plumbing (used by the Docker panel and the DB panel) plus the
// container-management commands: list, start/stop/restart, logs.

use std::process::Command;

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
    let on_path = Command::new("docker").arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
    if on_path {
        return Some("docker".into());
    }
    let path = login_shell_output("command -v docker")?;
    let path = path.trim().to_string();
    if path.is_empty() { None } else { Some(path) }
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
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

#[tauri::command]
pub fn docker_list() -> String {
    docker_output(&["ps", "-a", "--format", "{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Ports}}"]).unwrap_or_default()
}

fn docker_action(action: &str, id: &str) -> Result<(), String> {
    if !is_safe_container(id) {
        return Err("contenedor inválido".into());
    }
    let bin = docker_bin().ok_or("docker no encontrado")?;
    let out = Command::new(bin).args([action, id]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn docker_start(id: String) -> Result<(), String> {
    docker_action("start", &id)
}

#[tauri::command]
pub fn docker_stop(id: String) -> Result<(), String> {
    docker_action("stop", &id)
}

#[tauri::command]
pub fn docker_restart(id: String) -> Result<(), String> {
    docker_action("restart", &id)
}

#[tauri::command]
pub fn docker_logs(id: String, tail: u32) -> Result<String, String> {
    if !is_safe_container(&id) {
        return Err("contenedor inválido".into());
    }
    let bin = docker_bin().ok_or("docker no encontrado")?;
    let tail = tail.to_string();
    let out = Command::new(bin).args(["logs", "--tail", &tail, &id]).output().map_err(|e| e.to_string())?;
    // docker writes container logs to both stdout and stderr; show both.
    let mut combined = String::from_utf8_lossy(&out.stdout).to_string();
    combined.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok(combined)
}
