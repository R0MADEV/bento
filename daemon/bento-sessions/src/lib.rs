//! Las sesiones de los agentes: dónde las guarda cada uno, cuáles se pueden
//! reanudar y con qué orden, más el scrollback que Bento conserva aparte. Sin
//! UI y sin tauri: lo usan el panel de agentes, el daemon y el CLI.

use std::path::{Path, PathBuf};

use serde::Serialize;

mod scrollback;
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
fn claude_project_dir(home: &Path, cwd: &str) -> PathBuf {
    home.join(".claude/projects").join(cwd.replace(['/', '.'], "-"))
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
pub fn claude_session_exists(cwd: &str, session_id: &str) -> bool {
    let Some(home) = home() else { return false };
    claude_project_dir(&home, cwd)
        .join(format!("{session_id}.jsonl"))
        .exists()
}

/// Las sesiones de Claude de un directorio, de la más reciente a la más vieja.
pub fn claude_sessions(cwd: &str) -> Vec<Session> {
    let Some(home) = home() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(claude_project_dir(&home, cwd)) else {
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
pub fn list(cwd: &str) -> Vec<Session> {
    let mut sessions = claude_sessions(cwd);
    sessions.extend(opencode_sessions(cwd));
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions
}

/// Con qué comando se retoma una sesión. Cada agente lo llama a su manera.
pub fn resume_command(agent: &str, session_id: &str) -> Result<Vec<String>, String> {
    // El guion inicial es lo que importa: `--dangerously-skip-permissions` pasa
    // el filtro de caracteres y el agente lo leería como opción, no como id.
    let is_safe_id = !session_id.is_empty()
        && !session_id.starts_with('-')
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'));
    if !is_safe_id {
        return Err(format!("id de sesión inválido: {session_id}"));
    }
    match agent {
        "claude" => Ok(vec!["claude".into(), "--resume".into(), session_id.into()]),
        "codex" => {
            codex_clear_lock(session_id);
            Ok(vec!["codex".into(), "resume".into(), session_id.into()])
        }
        "opencode" => Ok(vec!["opencode".into(), "--session".into(), session_id.into()]),
        other => Err(format!("agente desconocido: {other}")),
    }
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
            claude_project_dir(Path::new("/home/x"), "/Users/romangomez"),
            PathBuf::from("/home/x/.claude/projects/-Users-romangomez"),
        );
        // Temporales de macOS: /var/folders/wq/b7t.ffxd/T
        assert_eq!(
            claude_project_dir(Path::new("/h"), "/var/folders/wq/b7t.ffxd/T"),
            PathBuf::from("/h/.claude/projects/-var-folders-wq-b7t-ffxd-T"),
        );
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

    #[test]
    fn resuming_names_the_flag_each_agent_understands() {
        assert_eq!(
            resume_command("claude", "abc-123").unwrap(),
            vec!["claude", "--resume", "abc-123"]
        );
        assert_eq!(
            resume_command("opencode", "ses_1").unwrap(),
            vec!["opencode", "--session", "ses_1"]
        );
        assert_eq!(
            resume_command("codex", "abc").unwrap(),
            vec!["codex", "resume", "abc"]
        );
    }

    #[test]
    fn an_unknown_agent_or_a_forged_session_id_is_refused() {
        // El id llega de fuera y acaba en una línea de comandos.
        assert!(resume_command("claude", "").is_err());
        assert!(resume_command("claude", "--dangerously-skip-permissions").is_err());
        assert!(resume_command("claude", "a b").is_err());
        assert!(resume_command("gemini", "abc").is_err());
    }
}
