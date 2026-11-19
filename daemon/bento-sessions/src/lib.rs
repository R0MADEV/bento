//! Las sesiones de los agentes: dónde las guarda cada uno, cuáles se pueden
//! reanudar y con qué orden, más el scrollback que Bento conserva aparte. Sin
//! UI y sin tauri: lo usan el panel de agentes, el daemon y el CLI.

use std::path::{Path, PathBuf};

use serde::Serialize;

mod registry;
mod running;
mod scrollback;
pub use registry::{load_records, registry_path, resumable_in_place, resume_command, resume_folder, resume_line, resume_line_for_shell, save_records, updated_record, verified_resume_line, AgentRecord};
pub use running::{running_agent, RunningAgent};
pub use scrollback::{chat_load, chat_save, history_clear, history_load, history_save};

/// Margen para el desfase entre el reloj de quien lanza el agente y las marcas
/// de tiempo del disco.
const SINCE_SKEW_MS: u64 = 3_000;

/// Una sesión que se puede reanudar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub agent: String,
    pub id: String,
    /// Última modificación en milisegundos desde epoch; 0 si no se pudo leer.
    pub updated_at: u64,
}

fn home() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(PathBuf::from)
}

/// Cómo llama Claude Code a la carpeta del proyecto dentro de
/// ~/.claude/projects: cada `/` y cada `.` pasan a ser `-`, la barra inicial
/// incluida (`/Users/x` → `-Users-x`). La barra inicial NO se quita.
fn claude_project_dir(root: &Path, cwd: &str) -> PathBuf {
    root.join("projects").join(cwd.replace(['/', '.'], "-"))
}

/// Where Claude keeps its data: `CLAUDE_CONFIG_DIR` when set, else ~/.claude.
fn claude_root(home: &Path, config_dir: Option<&str>) -> PathBuf {
    config_dir.map_or_else(|| home.join(".claude"), PathBuf::from)
}

fn modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

/// Si el fichero de la sesión de Claude sigue en disco. Se comprueba antes de
/// `--resume` para no chocar con un "No conversation found".
pub fn claude_session_exists(cwd: &str, session_id: &str, config_dir: Option<&str>) -> bool {
    let Some(home) = home() else { return false };
    claude_project_dir(&claude_root(&home, config_dir), cwd)
        .join(format!("{session_id}.jsonl"))
        .exists()
}

/// The folder a Claude conversation is filed under, wherever that is. Claude
/// files it by the folder it is working in, which is not always the one its
/// terminal was opened in, and `--resume` only finds it from that folder.
pub fn claude_session_folder(session_id: &str, config_dir: Option<&str>) -> Option<String> {
    claude_session_folder_in(&claude_root(&home()?, config_dir), session_id)
}

fn claude_session_folder_in(root: &Path, session_id: &str) -> Option<String> {
    use std::io::BufRead;

    if !running::is_safe_id(session_id) {
        return None;
    }
    let transcript = std::fs::read_dir(root.join("projects"))
        .ok()?
        .flatten()
        .map(|project| project.path().join(format!("{session_id}.jsonl")))
        .find(|path| path.is_file())?;
    let project = transcript.parent()?.to_path_buf();
    // Each line records the folder it was written in; the one this project
    // folder is named after is the one to resume from.
    std::io::BufReader::new(std::fs::File::open(&transcript).ok()?)
        .lines()
        .map_while(Result::ok)
        .find_map(|line| {
            let entry: serde_json::Value = serde_json::from_str(&line).ok()?;
            let cwd = entry.get("cwd")?.as_str()?;
            (claude_project_dir(root, cwd) == project).then(|| cwd.to_string())
        })
}

/// Las sesiones de Claude de un directorio, de la más reciente a la más vieja.
pub fn claude_sessions(cwd: &str, config_dir: Option<&str>) -> Vec<Session> {
    let Some(home) = home() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(claude_project_dir(&claude_root(&home, config_dir), cwd)) else {
        return Vec::new();
    };
    let mut sessions: Vec<Session> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let id = path.file_stem()?.to_str()?.to_string();
            (path.extension()?.to_str()? == "jsonl").then(|| Session {
                agent: "claude".into(),
                id,
                updated_at: modified_ms(&path),
            })
        })
        .collect();
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions
}

/// Quita el lock del escritor de hilos de Codex para que `codex resume` pueda
/// seguir. Codex escribe ~/.codex/thread-writer-locks/<id>.lock cuando la
/// sesión está viva y no lo borra si lo matan desde fuera (por ejemplo, Bento
/// cerrando el PTY). Sin esto, el siguiente `codex resume` falla con "thread
/// already has an active writer".
pub fn codex_clear_lock(session_id: &str) {
    let Some(home) = home() else { return };
    let lock = home
        .join(".codex/thread-writer-locks")
        .join(format!("{session_id}.lock"));
    let _ = std::fs::remove_file(lock);
}

/// Si existe en disco el rollout de esa sesión de Codex. Codex solo lo escribe
/// con el primer mensaje, así que una sesión recién lanzada (o vacía) puede no
/// estar todavía: comprobarlo evita que `codex resume <id>` falle con "No saved
/// session found with ID". Los rollouts van en
/// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl (uuid = id).
pub fn codex_session_exists(session_id: &str) -> bool {
    let Some(home) = home() else { return false };
    dir_has_session(&home.join(".codex/sessions"), session_id, 0)
}

fn dir_has_session(dir: &Path, session_id: &str, depth: usize) -> bool {
    // sessions/YYYY/MM/DD/rollout-*.jsonl → con 4 niveles basta; se acota el
    // recorrido para no barrer medio disco si la estructura cambia.
    if depth > 4 {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if dir_has_session(&path, session_id, depth + 1) {
                return true;
            }
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.contains(session_id))
        {
            return true;
        }
    }
    false
}

fn opencode_db() -> Option<PathBuf> {
    let path = home()?.join(".local/share/opencode/opencode.db");
    path.exists().then_some(path)
}

fn opencode_query(sql: &str, params: &[&dyn rusqlite::ToSql]) -> Option<Vec<(String, u64)>> {
    let connection = rusqlite::Connection::open_with_flags(
        opencode_db()?,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let mut statement = connection.prepare(sql).ok()?;
    let rows = statement
        .query_map(params, |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1).unwrap_or(0) as u64))
        })
        .ok()?
        .flatten()
        .collect();
    Some(rows)
}

/// La sesión de OpenCode más reciente creada en o después de `since_ms` para un
/// directorio. Claude y Codex dicen su id por el socket de Bento (sus hooks de
/// herdr); OpenCode no tiene hook, así que la suya se localiza por fecha de
/// creación: una sesión nueva se *crea* justo después de lanzarla, mientras que
/// otro agente ya en marcha en el mismo directorio solo se *modifica*.
pub fn find_opencode_session(cwd: &str, since_ms: u64, exclude: &[String]) -> Option<String> {
    let floor = since_ms.saturating_sub(SINCE_SKEW_MS);
    let rows = opencode_query(
        "SELECT id, time_created FROM session \
         WHERE directory = ?1 AND time_archived IS NULL AND time_created >= ?2 \
         ORDER BY time_created DESC LIMIT 20",
        rusqlite::params![cwd, floor],
    )?;
    rows.into_iter()
        .map(|(id, _)| id)
        .find(|id| !exclude.contains(id))
}

/// Las sesiones de OpenCode de un directorio, de la más reciente a la más vieja.
pub fn opencode_sessions(cwd: &str) -> Vec<Session> {
    opencode_query(
        "SELECT id, time_updated FROM session \
         WHERE directory = ?1 AND time_archived IS NULL \
         ORDER BY time_updated DESC LIMIT 50",
        rusqlite::params![cwd],
    )
    .unwrap_or_default()
    .into_iter()
    .map(|(id, updated_at)| Session { agent: "opencode".into(), id, updated_at })
    .collect()
}

/// Todo lo que se puede reanudar en un directorio, lo más reciente primero.
/// Codex no queda fuera por capricho: sus rollouts no guardan el directorio, así
/// que no hay forma de saber cuáles son de aquí.
pub fn list(cwd: &str, claude_config_dir: Option<&str>) -> Vec<Session> {
    let mut sessions = claude_sessions(cwd, claude_config_dir);
    sessions.extend(opencode_sessions(cwd));
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_claude_project_dir_is_encoded_the_way_claude_names_it() {
        // El fallo que rompió el resume durante horas: la barra inicial
        // sobrevive como guion. Quitarla apuntaba a una carpeta inexistente →
        // "session not found" → sesión nueva al reanudar.
        assert_eq!(
            claude_project_dir(Path::new("/home/x/.claude"), "/Users/romangomez"),
            PathBuf::from("/home/x/.claude/projects/-Users-romangomez"),
        );
        // Temporales de macOS: /var/folders/wq/b7t.ffxd/T
        assert_eq!(
            claude_project_dir(Path::new("/h/.claude"), "/var/folders/wq/b7t.ffxd/T"),
            PathBuf::from("/h/.claude/projects/-var-folders-wq-b7t-ffxd-T"),
        );
    }

    // Un alias como `CLAUDE_CONFIG_DIR=~/.claude-pro claude` guarda las
    // sesiones en esa carpeta, no en ~/.claude.
    #[test]
    fn the_claude_root_follows_its_config_dir() {
        let home = Path::new("/home/x");
        assert_eq!(claude_root(home, Some("/home/x/.claude-pro")), PathBuf::from("/home/x/.claude-pro"));
        assert_eq!(claude_root(home, None), PathBuf::from("/home/x/.claude"));
    }

    #[test]
    fn claude_sessions_are_listed_from_its_config_dir() {
        let root = std::env::temp_dir().join(format!("bento-claude-{}", std::process::id()));
        let project = claude_project_dir(&root, "/repo/app");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("abc-123.jsonl"), b"{}").unwrap();

        let sessions = claude_sessions("/repo/app", root.to_str());
        let ids: Vec<&str> = sessions.iter().map(|session| session.id.as_str()).collect();
        assert_eq!(ids, ["abc-123"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    // Claude files a conversation under the folder it is working in, which is
    // not always the one its terminal was opened in: looking only there found
    // nothing and the agent came back as a new, empty conversation.
    #[test]
    fn a_claude_session_is_found_in_whatever_folder_it_was_filed_under() {
        let root = std::env::temp_dir().join(format!("bento-claude-folder-{}", std::process::id()));
        let project = claude_project_dir(&root, "/repo/app");
        std::fs::create_dir_all(&project).unwrap();
        let lines = concat!(
            r#"{"type":"summary","summary":"x"}"#, "\n",
            r#"{"type":"user","cwd":"/somewhere/else","message":{}}"#, "\n",
            r#"{"type":"user","cwd":"/repo/app","message":{}}"#, "\n",
        );
        std::fs::write(project.join("abc-123.jsonl"), lines).unwrap();

        assert_eq!(claude_session_folder_in(&root, "abc-123").as_deref(), Some("/repo/app"));
        assert_eq!(claude_session_folder_in(&root, "missing-1"), None);
        // The id ends up in a path: nothing that could walk out of the folder.
        assert_eq!(claude_session_folder_in(&root, "../abc-123"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_codex_session_is_found_by_uuid_in_a_nested_rollout_filename() {
        let tmp = std::env::temp_dir().join(format!("bento-codex-{}", std::process::id()));
        let day = tmp.join("2026/08/10");
        std::fs::create_dir_all(&day).unwrap();
        let id = "029da883-ba90-4730-a76b-7a2ecfe4168c";
        std::fs::write(day.join(format!("rollout-2026-08-10T12-00-00-{id}.jsonl")), b"{}").unwrap();

        assert!(dir_has_session(&tmp, id, 0));
        assert!(!dir_has_session(&tmp, "deadbeef-0000-0000-0000-000000000000", 0));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_missing_sessions_dir_is_false_and_not_a_panic() {
        assert!(!dir_has_session(Path::new("/no/such/codex/sessions"), "any-id", 0));
    }
}
