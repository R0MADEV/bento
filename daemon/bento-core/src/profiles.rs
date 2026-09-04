//! Los perfiles de terminal: cómo se llama cada uno y con qué shell abre.
//!
//! Vivían solo en el navegador del escritorio, así que desde el móvil no había
//! forma de abrir una terminal con tu shell. Aquí quedan en `~/.bento`, junto
//! al resto de lo que comparten los tres clientes. Los campos de aspecto
//! (tema, tamaño de letra) viajan con el perfil pero solo los mira quien pinta
//! con ellos: la TUI hereda los del terminal que la hospeda.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub shell: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
}

fn profiles_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".bento").join("terminal-profiles.json"))
}

/// Los perfiles de un fichero. Uno ilegible o corrupto es "no hay ninguno": el
/// coste de equivocarse es abrir con el shell por defecto.
///
/// La ruta va por parámetro para que un test no tenga que mover `HOME`, que es
/// global y los pone a competir entre ellos.
pub fn list_in(path: &std::path::Path) -> Vec<Profile> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<Profile>>(&raw).ok())
        .unwrap_or_default()
}

/// Reemplaza la lista entera, que es como la edita quien la edita.
pub fn save_in(path: &std::path::Path, profiles: &[Profile]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string(profiles).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

pub fn list() -> Vec<Profile> {
    profiles_path().map(|path| list_in(&path)).unwrap_or_default()
}

pub fn save(profiles: &[Profile]) -> Result<(), String> {
    let path = profiles_path().ok_or_else(|| "no home dir".to_string())?;
    save_in(&path, profiles)
}

/// El shell de un perfil. Que el cliente mande el id y no el shell es lo que
/// evita que por HTTP se pueda pedir la ejecución de cualquier cosa.
pub fn shell_of(id: &str) -> Option<String> {
    list()
        .into_iter()
        .find(|profile| profile.id == id)
        .map(|profile| profile.shell)
        .filter(|shell| !shell.is_empty())
}
