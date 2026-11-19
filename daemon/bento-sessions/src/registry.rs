//! The agents Bento knows about, kept on disk by the daemon. The app, the CLI
//! and the phone all read the same ones, and a restarted daemon brings them back.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::running::is_safe_id;
use crate::RunningAgent;

/// The agent last seen in a terminal, and what it takes to resume it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecord {
    pub pty_id: String,
    pub title: String,
    pub agent: String,
    pub session_id: Option<String>,
    /// `CLAUDE_CONFIG_DIR` it ran with: the account to resume it in.
    pub config_dir: Option<String>,
    /// Folder it was launched from: where its session lives.
    pub cwd: Option<String>,
    pub branch: Option<String>,
}

impl AgentRecord {
    /// A record for an agent that is about to be brought back in `cwd`, not
    /// one read from the registry: it has no terminal yet.
    pub fn to_resume(agent: &str, session_id: Option<String>, config_dir: Option<String>, cwd: String) -> Self {
        Self {
            pty_id: String::new(),
            title: String::new(),
            agent: agent.to_string(),
            session_id,
            config_dir,
            cwd: Some(cwd),
            branch: None,
        }
    }
}

/// What a terminal's record becomes after looking at what runs in it now.
/// `None` is a terminal that never ran an agent.
pub fn updated_record(
    previous: Option<&AgentRecord>,
    pty_id: &str,
    title: &str,
    running: Option<RunningAgent>,
) -> Option<AgentRecord> {
    let Some(running) = running else {
        return previous.map(|record| AgentRecord { title: title.to_string(), ..record.clone() });
    };
    let same_agent = previous.filter(|record| record.agent == running.agent);
    Some(AgentRecord {
        pty_id: pty_id.to_string(),
        title: title.to_string(),
        session_id: running.session_id.or_else(|| same_agent.and_then(|record| record.session_id.clone())),
        config_dir: running.config_dir,
        cwd: running.cwd.or_else(|| previous.and_then(|record| record.cwd.clone())),
        branch: same_agent.and_then(|record| record.branch.clone()),
        agent: running.agent,
    })
}

pub fn registry_path() -> Result<PathBuf, String> {
    Ok(crate::scrollback::config_dir()?.join("agents.json"))
}

/// The saved agents. A missing or broken file is no agents: it must never keep
/// the daemon from starting.
pub fn load_records(path: &Path) -> Vec<AgentRecord> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

pub fn save_records(path: &Path, records: &[AgentRecord]) -> Result<(), String> {
    let content = serde_json::to_string(records).map_err(|error| error.to_string())?;
    crate::scrollback::save(path, &content, false)
}

fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// The words that bring an agent back, on `session_id` when there is one: the
/// one place that knows how each agent calls it. `None` for anything that is
/// not a known agent, and a session that is not a plain id is left out: these
/// words end up in a command line, so nothing from outside may run as code.
fn resume_argv(agent: &str, session_id: Option<&str>) -> Option<Vec<String>> {
    let flag = match agent {
        "claude" => "--resume",
        "codex" => "resume",
        "opencode" => "--session",
        _ => return None,
    };
    let mut argv = vec![agent.to_string()];
    if let Some(id) = session_id.filter(|id| is_safe_id(id)) {
        argv.extend([flag.to_string(), id.to_string()]);
    }
    Some(argv)
}

/// `resume_argv` as a line to type into a shell, in the account Claude ran with.
pub fn resume_line(agent: &str, session_id: Option<&str>, config_dir: Option<&str>) -> Option<String> {
    let command = resume_argv(agent, session_id)?.join(" ");
    let account = config_dir.filter(|_| agent == "claude");
    Some(match account {
        Some(dir) => format!("CLAUDE_CONFIG_DIR={} {command}", shell_quote(dir)),
        None => command,
    })
}

/// The folder to reopen an agent in. For Claude it is the one its conversation
/// is filed under, which is where `--resume` finds it; otherwise (and when the
/// conversation can't be found) the folder it was running in.
pub fn resume_folder(record: &AgentRecord) -> Option<String> {
    let filed_under = match (record.agent.as_str(), record.session_id.as_deref()) {
        ("claude", Some(id)) => crate::claude_session_folder(id, record.config_dir.as_deref()),
        _ => None,
    };
    filed_under.or_else(|| record.cwd.clone())
}

/// The record's session when it can still be resumed: `--resume` on one that
/// is gone fails with "No conversation found".
fn resumable_session(record: &AgentRecord) -> Option<&str> {
    session_on_disk(record, &resume_folder(record).unwrap_or_default())
}

/// The session to continue when the agent runs in the record's own folder
/// with no shell to take it elsewhere, as a review's follow-up question does:
/// only one that is filed under that folder.
pub fn resumable_in_place(record: &AgentRecord) -> Option<String> {
    session_on_disk(record, record.cwd.as_deref().unwrap_or_default()).map(str::to_string)
}

/// The record's session when it is a plain id still on disk, Claude's under `folder`.
fn session_on_disk<'a>(record: &'a AgentRecord, folder: &str) -> Option<&'a str> {
    let config_dir = record.config_dir.as_deref();
    let is_on_disk = |id: &str| match record.agent.as_str() {
        "claude" => crate::claude_session_exists(folder, id, config_dir),
        "codex" => crate::codex_session_exists(id),
        _ => true,
    };
    let session = record.session_id.as_deref().filter(|id| is_safe_id(id) && is_on_disk(id));
    // Codex leaves its writer lock behind when killed from outside, and then
    // refuses to resume the thread.
    let codex_session = session.filter(|_| record.agent == "codex");
    if let Some(id) = codex_session {
        crate::codex_clear_lock(id);
    }
    session
}

/// `resume_line` for a record, resuming only a session that is still on disk.
pub fn verified_resume_line(record: &AgentRecord) -> Option<String> {
    resume_line(&record.agent, resumable_session(record), record.config_dir.as_deref())
}

/// The command for someone who asked for that very session, as
/// `bento agent resume` does: unlike `verified_resume_line`, it refuses
/// instead of quietly starting the agent on an empty conversation.
pub fn resume_command(record: &AgentRecord) -> Result<Vec<String>, String> {
    let id = record.session_id.as_deref().unwrap_or_default();
    if !is_safe_id(id) {
        return Err(format!("id de sesión inválido: {id}"));
    }
    let Some(argv) = resume_argv(&record.agent, Some(id)) else {
        return Err(format!("agente desconocido: {}", record.agent));
    };
    if resumable_session(record).is_none() {
        return Err(format!("no hay ninguna sesión guardada de {} con el id {id}", record.agent));
    }
    Ok(argv)
}

/// What to type to bring an agent back in a shell sitting in `shell_dir`: its
/// `verified_resume_line`, going first to the folder the session resumes from
/// when the shell is somewhere else.
pub fn resume_line_for_shell(record: &AgentRecord, shell_dir: &str) -> Option<String> {
    let line = verified_resume_line(record)?;
    Some(from_folder(line, resume_folder(record).as_deref(), shell_dir))
}

fn from_folder(line: String, folder: Option<&str>, shell_dir: &str) -> String {
    let elsewhere = folder.filter(|folder| !folder.is_empty() && *folder != shell_dir);
    match elsewhere {
        Some(folder) => format!("cd {} && {line}", shell_quote(folder)),
        None => line,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn running(agent: &str, session: Option<&str>, cwd: Option<&str>) -> RunningAgent {
        RunningAgent {
            agent: agent.into(),
            session_id: session.map(Into::into),
            config_dir: None,
            cwd: cwd.map(Into::into),
        }
    }

    fn record(agent: &str, session: Option<&str>) -> AgentRecord {
        AgentRecord {
            pty_id: "pty-1".into(),
            title: "Agent 1".into(),
            agent: agent.into(),
            session_id: session.map(Into::into),
            config_dir: None,
            cwd: Some("/repo".into()),
            branch: None,
        }
    }

    #[test]
    fn a_plain_shell_has_no_record() {
        assert_eq!(updated_record(None, "pty-1", "Agent 1", None), None);
    }

    #[test]
    fn an_agent_seen_for_the_first_time_is_recorded() {
        let seen = updated_record(None, "pty-1", "Agent 1", Some(running("claude", Some("s1"), Some("/repo")))).unwrap();
        assert_eq!(seen, record("claude", Some("s1")));
    }

    // Back at the shell the last agent stays, so it is resumed after a restart.
    #[test]
    fn the_last_agent_is_kept_while_the_terminal_is_just_the_shell() {
        let before = record("claude", Some("s1"));
        assert_eq!(updated_record(Some(&before), "pty-1", "Agent 1", None), Some(before));
    }

    #[test]
    fn a_renamed_terminal_keeps_its_agent() {
        let before = record("claude", Some("s1"));
        let after = updated_record(Some(&before), "pty-1", "deitu", None).unwrap();
        assert_eq!(after.title, "deitu");
        assert_eq!(after.session_id.as_deref(), Some("s1"));
    }

    #[test]
    fn another_agent_in_the_same_terminal_replaces_the_record() {
        let before = record("claude", Some("s1"));
        let after = updated_record(Some(&before), "pty-1", "Agent 1", Some(running("opencode", None, Some("/other")))).unwrap();
        assert_eq!(after.agent, "opencode");
        assert_eq!(after.session_id, None);
        assert_eq!(after.cwd.as_deref(), Some("/other"));
    }

    // The probe can't always read a session (OpenCode) or a folder: keep them.
    #[test]
    fn what_the_probe_cannot_read_is_not_forgotten() {
        let before = record("claude", Some("s1"));
        let after = updated_record(Some(&before), "pty-1", "Agent 1", Some(running("claude", None, None))).unwrap();
        assert_eq!(after, before);
    }

    #[test]
    fn a_new_session_of_the_same_agent_is_followed() {
        let before = record("claude", Some("s1"));
        let after = updated_record(Some(&before), "pty-1", "Agent 1", Some(running("claude", Some("s2"), Some("/repo")))).unwrap();
        assert_eq!(after.session_id.as_deref(), Some("s2"));
    }

    #[test]
    fn records_survive_a_round_trip_through_disk() {
        let dir = std::env::temp_dir().join(format!("bento-registry-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agents.json");
        let records = vec![record("claude", Some("s1")), record("codex", None)];
        save_records(&path, &records).unwrap();
        assert_eq!(load_records(&path), records);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_or_broken_file_is_no_agents_rather_than_a_crash() {
        let dir = std::env::temp_dir().join(format!("bento-registry-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(load_records(&dir.join("nope.json")), Vec::new());
        std::fs::write(dir.join("agents.json"), b"{ not json").unwrap();
        assert_eq!(load_records(&dir.join("agents.json")), Vec::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn each_agent_resumes_with_its_own_command() {
        assert_eq!(resume_line("claude", Some("abc-1"), None).as_deref(), Some("claude --resume abc-1"));
        assert_eq!(resume_line("codex", Some("abc-1"), None).as_deref(), Some("codex resume abc-1"));
        assert_eq!(resume_line("opencode", Some("ses_1"), None).as_deref(), Some("opencode --session ses_1"));
    }

    #[test]
    fn without_a_session_the_agent_just_starts() {
        assert_eq!(resume_line("claude", None, None).as_deref(), Some("claude"));
        assert_eq!(resume_line("codex", None, None).as_deref(), Some("codex"));
    }

    #[test]
    fn claude_resumes_in_the_account_it_ran_with() {
        assert_eq!(
            resume_line("claude", Some("abc-1"), Some("/Users/x/.claude-pro")).as_deref(),
            Some("CLAUDE_CONFIG_DIR='/Users/x/.claude-pro' claude --resume abc-1"),
        );
        assert_eq!(
            resume_line("claude", None, Some("/tmp/it's here")).as_deref(),
            Some("CLAUDE_CONFIG_DIR='/tmp/it'\\''s here' claude"),
        );
    }

    // A session only resumes from the folder it is filed under, and the shell
    // the line is typed into may be sitting somewhere else.
    #[test]
    fn the_command_first_moves_the_shell_to_the_agents_folder() {
        let agent = record("opencode", Some("ses_1"));
        assert_eq!(resume_line_for_shell(&agent, "/elsewhere").as_deref(), Some("cd '/repo' && opencode --session ses_1"));
        assert_eq!(resume_line_for_shell(&agent, "/repo").as_deref(), Some("opencode --session ses_1"));
    }

    #[test]
    fn the_folder_is_quoted_for_the_shell() {
        assert_eq!(from_folder("codex".into(), Some("/tmp/it's here"), "/repo"), "cd '/tmp/it'\\''s here' && codex");
        assert_eq!(from_folder("codex".into(), None, "/repo"), "codex");
    }

    #[test]
    fn there_is_no_command_for_something_that_is_not_an_agent() {
        assert_eq!(resume_line_for_shell(&record("vim", None), "/repo"), None);
    }

    // The app, the daemon and `bento agent resume` all start from these words,
    // so an agent comes back the same way whoever brings it back.
    #[test]
    fn every_way_of_resuming_names_the_flag_each_agent_understands() {
        let words = |agent, session| resume_argv(agent, session).map(|argv| argv.join(" "));
        assert_eq!(words("claude", Some("abc-123")).as_deref(), Some("claude --resume abc-123"));
        assert_eq!(words("codex", Some("abc")).as_deref(), Some("codex resume abc"));
        assert_eq!(words("opencode", Some("ses_1")).as_deref(), Some("opencode --session ses_1"));
        assert_eq!(words("claude", None).as_deref(), Some("claude"));
        assert_eq!(words("gemini", Some("abc")), None);
    }

    #[test]
    fn an_explicit_resume_gives_the_command_to_run() {
        let asked = AgentRecord::to_resume("opencode", Some("ses_1".into()), None, "/repo".into());
        assert_eq!(resume_command(&asked).unwrap(), vec!["opencode", "--session", "ses_1"]);
    }

    // The id comes from outside and ends up in a command line. The leading dash
    // is what matters: `--dangerously-skip-permissions` passes the character
    // filter and the agent would read it as an option, not as an id.
    #[test]
    fn an_explicit_resume_refuses_what_it_cannot_resume() {
        let asked = |agent: &str, session: &str| AgentRecord::to_resume(agent, Some(session.into()), None, "/repo".into());
        assert!(resume_command(&asked("claude", "")).is_err());
        assert!(resume_command(&asked("claude", "--dangerously-skip-permissions")).is_err());
        assert!(resume_command(&asked("claude", "a b")).is_err());
        assert!(resume_command(&asked("gemini", "abc")).is_err());
        assert!(resume_command(&AgentRecord::to_resume("opencode", None, None, "/repo".into())).is_err());
        // A session that is not on disk would only start an empty conversation.
        assert!(resume_command(&asked("claude", "bento-test-no-such-session")).is_err());
    }

    // Run with no shell around it, as a review's follow-up question is, an
    // agent can only continue a session filed under the folder it runs in.
    #[test]
    fn a_session_continues_in_place_only_when_it_is_there() {
        let here = |agent: &str, session: &str| AgentRecord::to_resume(agent, Some(session.into()), None, "/repo".into());
        assert_eq!(resumable_in_place(&here("opencode", "ses_1")).as_deref(), Some("ses_1"));
        assert_eq!(resumable_in_place(&here("claude", "bento-test-no-such-session")), None);
        assert_eq!(resumable_in_place(&here("codex", "bento-test-no-such-session")), None);
        assert_eq!(resumable_in_place(&here("opencode", "--help")), None);
    }

    // The line is typed into a shell: nothing from the file may run as code.
    #[test]
    fn a_forged_record_cannot_inject_a_command() {
        assert_eq!(resume_line("claude", Some("x; rm -rf ~"), None).as_deref(), Some("claude"));
        assert_eq!(resume_line("claude; rm -rf ~", None, None), None);
        assert_eq!(resume_line("vim", Some("abc"), None), None);
    }
}
