//! Las notas: ficheros `.md` sueltos en `~/.config/bento/notes/`. Portables
//! (se abren con cualquier editor), versionables con git e importables desde
//! Notion u Obsidian. Sin UI: las usan el desktop, el daemon y el CLI.

use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct NoteFile {
    pub name: String,
    pub content: String,
}

/// El directorio de notas, creándolo si hace falta.
pub fn notes_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no home dir".to_string())?;
    let directory = PathBuf::from(home).join(".config").join("bento").join("notes");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

/// Solo se admite un nombre de fichero `.md` pelado: nada de recorrer rutas.
/// Es la frontera de confianza — el nombre llega del panel, del socket o del CLI.
pub fn safe_path(directory: &Path, name: &str) -> Result<PathBuf, String> {
    let invalid = name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.starts_with('.');
    if invalid {
        return Err("invalid note name".into());
    }
    let path = directory.join(name);
    if path.parent() != Some(directory) {
        return Err("invalid note path".into());
    }
    Ok(path)
}

/// Todas las notas del directorio, con su contenido. Lo que no sea `.md` se
/// ignora: el directorio es del usuario y puede tener cualquier cosa.
pub fn list_in(directory: &Path) -> Result<Vec<NoteFile>, String> {
    let mut notes = Vec::new();
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("md") {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        notes.push(NoteFile {
            name: name.to_string(),
            content: fs::read_to_string(&path).unwrap_or_default(),
        });
    }
    notes.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(notes)
}

pub fn list() -> Result<Vec<NoteFile>, String> {
    list_in(&notes_dir()?)
}

pub fn read(name: &str) -> Result<String, String> {
    let path = safe_path(&notes_dir()?, name)?;
    fs::read_to_string(path).map_err(|error| error.to_string())
}

pub fn write(name: &str, content: &str) -> Result<(), String> {
    let path = safe_path(&notes_dir()?, name)?;
    fs::write(path, content).map_err(|error| error.to_string())
}

pub fn delete(name: &str) -> Result<(), String> {
    let path = safe_path(&notes_dir()?, name)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
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
        let path = std::env::temp_dir().join(format!("bento-notes-{name}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn a_note_name_cannot_escape_its_directory() {
        let directory = temporary_directory("safe");
        for name in ["", "..", "../evil.md", "sub/evil.md", "sub\\evil.md", ".hidden.md"] {
            assert!(safe_path(&directory, name).is_err(), "aceptó {name:?}");
        }
        assert_eq!(
            safe_path(&directory, "nota.md").unwrap(),
            directory.join("nota.md")
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn listing_only_returns_markdown_sorted_by_name() {
        let directory = temporary_directory("list");
        fs::write(directory.join("b.md"), "segunda").unwrap();
        fs::write(directory.join("a.md"), "primera").unwrap();
        fs::write(directory.join("ignorada.txt"), "no").unwrap();
        let notes = list_in(&directory).unwrap();
        assert_eq!(
            notes.iter().map(|note| note.name.as_str()).collect::<Vec<_>>(),
            vec!["a.md", "b.md"]
        );
        assert_eq!(notes[0].content, "primera");
        let _ = fs::remove_dir_all(directory);
    }
}
