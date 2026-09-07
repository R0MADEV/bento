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
        if Command::new(&found).arg(path).spawn().is_ok() {
            return Ok(());
        }
    }
    Command::new(fallback())
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
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
    fn a_binary_that_is_not_installed_is_not_found() {
        assert_eq!(super::which("un-editor-que-no-existe-42"), None);
    }
}
