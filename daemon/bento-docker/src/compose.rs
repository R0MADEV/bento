//! Docker Compose: levantar y parar un proyecto, y leer del fichero lo que
//! hace falta para hablar de él.

use std::process::Command;

use crate::docker_bin;

/// `docker compose up -d` en ese directorio.
pub fn up(dir: &str) -> Result<String, String> {
    run(dir, &["compose", "up", "-d"])
}

/// `docker compose down`.
pub fn down(dir: &str) -> Result<String, String> {
    run(dir, &["compose", "down"])
}

fn run(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(docker_bin().ok_or("docker no encontrado")?)
        .current_dir(dir)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
