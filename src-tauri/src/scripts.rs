// Discover script files in the folders the user points at (scattered scripts),
// so the Scripts panel can list them and run them.

use std::fs;
use std::io::Read;
use std::path::Path;

#[derive(serde::Serialize)]
pub struct ScriptFile {
    name: String,
    path: String,
    dir: String,
}

const SCRIPT_EXTS: &[&str] = &["sh", "bash", "zsh", "fish", "py", "js", "rb", "pl"];
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "vendor", ".next"];

fn starts_with_shebang(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else { return false };
    let mut buf = [0u8; 2];
    file.read_exact(&mut buf).is_ok() && &buf == b"#!"
}

fn is_script(path: &Path) -> bool {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if SCRIPT_EXTS.contains(&ext.to_lowercase().as_str()) {
            return true;
        }
    }
    // Extensionless but executable + shebang (real scripts, not binaries).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = path.metadata() {
            if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
                return starts_with_shebang(path);
            }
        }
    }
    false
}

fn walk(dir: &Path, base: &str, depth: usize, out: &mut Vec<ScriptFile>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk(&path, base, depth - 1, out);
        } else if is_script(&path) {
            out.push(ScriptFile {
                name,
                path: path.to_string_lossy().to_string(),
                dir: base.to_string(),
            });
        }
    }
}

#[tauri::command]
pub fn list_scripts(dirs: Vec<String>) -> Vec<ScriptFile> {
    let mut out = Vec::new();
    for dir in &dirs {
        let path = Path::new(dir);
        if path.is_dir() {
            walk(path, dir, 5, &mut out);
        }
    }
    out
}
