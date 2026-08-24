use std::path::PathBuf;
use std::time::Duration;

// Claude and Codex report their exact session_id through the Bento socket (their
// herdr hooks, keyed by HERDR_PANE_ID) — see agent_socket.rs. Only OpenCode has
// no such hook, so its session is located on disk by creation time: a brand-new
// row is *created* right after launch, while another agent already running in the
// same directory only gets *modified*, so matching on creation time is unambiguous.

// Tolerate small filesystem/clock skew between the UI clock and DB timestamps.
const SINCE_SKEW: Duration = Duration::from_secs(3);

/// Removes the Codex thread-writer lock for a session so `codex resume` can
/// proceed. Codex writes ~/.codex/thread-writer-locks/<id>.lock when a session
/// is active and never removes it if the process is killed externally (e.g.
/// Bento closes the PTY). Without this, the next `codex resume` call fails with
/// "thread already has an active writer".
#[tauri::command]
pub fn agent_codex_clear_lock(session_id: String) {
    let Ok(home) = std::env::var("HOME") else { return };
    let lock = PathBuf::from(home)
        .join(".codex/thread-writer-locks")
        .join(format!("{session_id}.lock"));
    let _ = std::fs::remove_file(lock);
}

/// Returns true if a Codex rollout for this session exists on disk. Codex only
/// writes the rollout on the first message, so a just-launched (or empty) session
/// may not exist yet — checking avoids `codex resume <id>` failing hard with
/// "No saved session found with ID". Codex stores rollouts under
/// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl (uuid = session id).
#[tauri::command]
pub fn agent_codex_session_exists(session_id: String) -> bool {
    let Ok(home) = std::env::var("HOME") else {
        return false;
    };
    let root = PathBuf::from(home).join(".codex/sessions");
    codex_dir_has_session(&root, &session_id, 0)
}

fn codex_dir_has_session(dir: &std::path::Path, session_id: &str, depth: usize) -> bool {
    // sessions/YYYY/MM/DD/rollout-*.jsonl → 4 levels is enough; bound the walk.
    if depth > 4 {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if codex_dir_has_session(&path, session_id, depth + 1) {
                return true;
            }
        } else if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.contains(session_id))
        {
            return true;
        }
    }
    false
}

/// Encodes a cwd the way Claude Code names its project folder under
/// ~/.claude/projects: every `/` and `.` becomes `-` (the leading slash too, so
/// `/Users/x` → `-Users-x`). Do NOT strip the leading slash.
fn claude_project_dir(home: &str, cwd: &str) -> PathBuf {
    let encoded = cwd.replace(['/', '.'], "-");
    PathBuf::from(home).join(".claude/projects").join(encoded)
}

/// Returns true if the Claude session file still exists on disk.
/// Used before attempting `--resume` to avoid "No conversation found" errors.
#[tauri::command]
pub fn agent_claude_session_exists(cwd: String, session_id: String) -> bool {
    let Ok(home) = std::env::var("HOME") else {
        return false;
    };
    claude_project_dir(&home, &cwd)
        .join(format!("{session_id}.jsonl"))
        .exists()
}

/// Newest OpenCode session created at/after `since_ms` for a directory.
/// OpenCode stores sessions in ~/.local/share/opencode/opencode.db (SQLite;
/// `time_created` is epoch millis). Resume: `opencode --session <id>`.
#[tauri::command]
pub fn agent_find_opencode_session(cwd: String, since_ms: u64, exclude: Vec<String>) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let db_path = PathBuf::from(&home).join(".local/share/opencode/opencode.db");

    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;

    let floor = since_ms.saturating_sub(SINCE_SKEW.as_millis() as u64);
    let mut stmt = conn.prepare(
        "SELECT id FROM session \
         WHERE directory = ?1 AND time_archived IS NULL AND time_created >= ?2 \
         ORDER BY time_created DESC LIMIT 20",
    ).ok()?;
    // Collect (bounded by LIMIT 20) so the borrow of stmt/conn ends before we
    // scan for the first unclaimed id.
    let ids: Vec<String> = stmt
        .query_map(rusqlite::params![cwd, floor], |row| row.get::<_, String>(0))
        .ok()?
        .flatten()
        .collect();
    ids.into_iter().find(|id| !exclude.contains(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Guards the exact bug that broke resume for hours: Claude names its project
    // folder by replacing every `/` AND `.` with `-`, keeping the leading slash
    // (so it becomes a leading `-`). Stripping the leading slash pointed lookups
    // at a nonexistent folder → "session not found" → fresh session on resume.
    #[test]
    fn claude_project_dir_encodes_like_claude() {
        assert_eq!(
            claude_project_dir("/home/x", "/Users/romangomez"),
            PathBuf::from("/home/x/.claude/projects/-Users-romangomez"),
        );
    }

    #[test]
    fn claude_project_dir_replaces_dots_too() {
        // macOS temp: /var/folders/wq/b7t.ffxd/T → -var-folders-wq-b7t-ffxd-T
        assert_eq!(
            claude_project_dir("/h", "/var/folders/wq/b7t.ffxd/T"),
            PathBuf::from("/h/.claude/projects/-var-folders-wq-b7t-ffxd-T"),
        );
    }

    #[test]
    fn claude_project_dir_keeps_leading_dash_not_stripped() {
        // The leading slash must survive as a leading dash — the original bug.
        let dir = claude_project_dir("/h", "/Users/x/Desktop/roma/bento");
        assert_eq!(
            dir.file_name().unwrap().to_str().unwrap(),
            "-Users-x-Desktop-roma-bento",
        );
    }

    #[test]
    fn codex_session_found_by_uuid_in_nested_rollout_filename() {
        let tmp = std::env::temp_dir().join(format!("bento-codex-{}", std::process::id()));
        let day = tmp.join("2026/08/10");
        std::fs::create_dir_all(&day).unwrap();
        let id = "029da883-ba90-4730-a76b-7a2ecfe4168c";
        std::fs::write(day.join(format!("rollout-2026-08-10T12-00-00-{id}.jsonl")), b"{}").unwrap();

        assert!(codex_dir_has_session(&tmp, id, 0));
        assert!(!codex_dir_has_session(&tmp, "deadbeef-0000-0000-0000-000000000000", 0));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn codex_session_missing_dir_is_false_not_panic() {
        assert!(!codex_dir_has_session(
            &PathBuf::from("/no/such/codex/sessions"),
            "any-id",
            0,
        ));
    }
}
