//! Lo que hace el panel de Docker sin nada de interfaz: encontrar el binario,
//! listar contenedores, arrancarlos, pararlos y leer sus logs.
//!
//! Compartido por la app de escritorio, el daemon (móvil) y el CLI: hasta
//! ahora vivía solo dentro de la app.

use std::process::Command;

use serde::Serialize;

pub mod compose;

/// Un contenedor tal y como lo cuenta `docker ps`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../src/generated/bindings/"))]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: String,
    pub project: String,
}

impl Container {
    pub fn is_running(&self) -> bool {
        self.state == "running"
    }
}

/// El formato con el que pedimos la lista: un campo por columna, separados por
/// `|`, para no tener que parsear la tabla que dibuja docker.
const PS_FORMAT: &str = "{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Ports}}|{{.Label \"com.docker.compose.project\"}}";

/// macOS no pasa el PATH del shell a las apps con interfaz, así que un docker
/// de Homebrew es invisible para la app aunque esté instalado. Se resuelve una
/// vez por proceso.
/// Ejecuta algo en un shell de login, que es la única forma de ver el PATH
/// real desde una app con interfaz en macOS.
pub fn login_shell_output(cmd: &str) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = Command::new(shell).arg("-lc").arg(cmd).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

pub fn docker_bin() -> Option<String> {
    let on_path = Command::new("docker")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if on_path {
        return Some("docker".into());
    }
    let path = login_shell_output("command -v docker")?.trim().to_string();
    if path.is_empty() { None } else { Some(path) }
}

pub fn docker_output(args: &[&str]) -> Option<String> {
    let out = Command::new(docker_bin()?).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Los nombres e ids de docker son alfanuméricos más `_-.`; cualquier otra
/// cosa se rechaza antes de que llegue a un comando.
///
/// El guion inicial importa: docker no deja que un nombre empiece por `-`, y
/// nosotros tampoco, porque `docker stop --volumes` no para nada — lo lee como
/// una opción.
pub fn is_safe_container(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// Convierte la salida de `docker ps` en contenedores. Puro: sin esto, cada
/// cliente parsea el mismo texto a su manera.
pub fn parse_containers(raw: &str) -> Vec<Container> {
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut parts = line.split('|').map(str::trim);
            let mut next = || parts.next().unwrap_or("").to_string();
            Container {
                id: next(),
                name: next(),
                image: next(),
                state: next(),
                status: next(),
                ports: next(),
                project: next(),
            }
        })
        .collect()
}

/// Todos los contenedores, corriendo o no.
pub fn list() -> Vec<Container> {
    parse_containers(&docker_output(&["ps", "-a", "--format", PS_FORMAT]).unwrap_or_default())
}

/// Arranca, para o reinicia un contenedor. Son lentas (reiniciar es parar y
/// arrancar), así que quien llame decide en qué hilo.
pub fn action(action: &str, id: &str) -> Result<(), String> {
    if !matches!(action, "start" | "stop" | "restart") {
        return Err(format!("acción inválida: {action}"));
    }
    if !is_safe_container(id) {
        return Err("contenedor inválido".into());
    }
    let out = Command::new(docker_bin().ok_or("docker no encontrado")?)
        .args([action, id])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Las últimas `tail` líneas de log. Docker escribe en stdout y en stderr, y
/// las dos son log del contenedor.
pub fn logs(id: &str, tail: u32) -> Result<String, String> {
    if !is_safe_container(id) {
        return Err("contenedor inválido".into());
    }
    let out = Command::new(docker_bin().ok_or("docker no encontrado")?)
        .args(["logs", "--tail", &tail.to_string(), id])
        .output()
        .map_err(|e| e.to_string())?;
    let mut combined = String::from_utf8_lossy(&out.stdout).to_string();
    combined.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok(combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PS: &str = "abc123|web|nginx:latest|running|Up 2 hours|0.0.0.0:8080->80/tcp|mi-proyecto\ndef456|db|postgres:16|exited|Exited (0) 1 hour ago||mi-proyecto\n";

    #[test]
    fn each_column_lands_in_its_field() {
        let containers = parse_containers(PS);
        assert_eq!(containers.len(), 2);
        assert_eq!(containers[0].name, "web");
        assert_eq!(containers[0].image, "nginx:latest");
        assert_eq!(containers[0].ports, "0.0.0.0:8080->80/tcp");
        assert_eq!(containers[0].project, "mi-proyecto");
    }

    #[test]
    fn only_running_containers_count_as_running() {
        let containers = parse_containers(PS);
        assert!(containers[0].is_running());
        assert!(!containers[1].is_running());
    }

    #[test]
    fn a_container_without_ports_or_project_still_parses() {
        let containers = parse_containers("abc|solo|img|running|Up||\n");
        assert_eq!(containers[0].ports, "");
        assert_eq!(containers[0].project, "");
    }

    #[test]
    fn empty_output_is_no_containers() {
        assert!(parse_containers("").is_empty());
        assert!(parse_containers("\n  \n").is_empty());
    }

    #[test]
    fn a_container_name_cannot_smuggle_anything() {
        assert!(is_safe_container("mi-app_1.2"));
        assert!(!is_safe_container("mi app"));
        assert!(!is_safe_container("app;rm -rf /"));
        assert!(!is_safe_container("--volumes"));
        assert!(!is_safe_container(""));
    }

    #[test]
    fn only_the_three_lifecycle_actions_are_allowed() {
        // `rm` borraría el contenedor: no entra por aquí.
        assert!(action("rm", "web").is_err());
        assert!(action("exec", "web").is_err());
    }
}
