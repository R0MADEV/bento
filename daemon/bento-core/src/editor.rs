//! Abrir un fichero en el editor del usuario.
//!
//! Lo tenía sólo el escritorio; la CLI hace lo mismo desde el panel de review,
//! así que la decisión —qué editor y en qué orden— vive aquí y no repetida en
//! cada cliente.

use std::process::Command;

/// Abre el fichero en el primer editor que encuentre, y si no hay ninguno, con
/// lo que el sistema use para ese tipo de fichero.
pub fn open(path: &str) -> Result<(), String> {
    for editor in ["cursor", "code"] {
        let Some(found) = which(editor) else { continue };
        if spawn_reaped(Command::new(&found).arg(path)).is_ok() {
            return Ok(());
        }
    }
    spawn_reaped(Command::new(fallback()).arg(path))
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Launches without blocking and waits on a thread: launchers like `code` or
/// `open` exit right away, and a dropped Child would linger as a zombie.
fn spawn_reaped(command: &mut Command) -> std::io::Result<u32> {
    let mut child = command.spawn()?;
    let pid = child.id();
    std::thread::spawn(move || child.wait());
    Ok(pid)
}

/// Con qué abre el sistema lo que no sabe abrir de otra forma.
fn fallback() -> &'static str {
    match std::env::consts::OS {
        "macos" => "open",
        "windows" => "explorer.exe",
        _ => "xdg-open",
    }
}

/// Dónde está un ejecutable, preguntándoselo a una shell de login: los
/// editores se instalan en rutas que sólo están en el PATH del usuario, no en
/// el de una aplicación lanzada desde el Finder.
fn which(binary: &str) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = Command::new(shell).arg("-lc").arg(format!("command -v {binary}")).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_system_has_something_to_open_with() {
        // Sin editor instalado se abre con lo del sistema; quedarse sin nada
        // que ejecutar sería no abrir nada y no decirlo.
        assert!(!super::fallback().is_empty());
    }

    #[test]
    fn a_launched_editor_is_reaped_when_it_exits() {
        // `kill -0` still succeeds on an unreaped zombie, so this catches a dropped Child.
        let pid = super::spawn_reaped(&mut std::process::Command::new("true")).unwrap();
        let is_alive = || {
            std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        };
        let reaped = (0..50).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(20));
            !is_alive()
        });
        assert!(reaped, "editor launcher {pid} left as a zombie");
    }

    #[test]
    fn a_binary_that_is_not_installed_is_not_found() {
        assert_eq!(super::which("un-editor-que-no-existe-42"), None);
    }
}
