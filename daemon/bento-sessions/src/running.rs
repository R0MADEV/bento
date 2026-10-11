//! Which agent is running in a terminal right now, and which session it is on.
//!
//! Read from the process itself (its argv, its environment and what it leaves
//! on disk) instead of from what the user typed: an alias (`claude20`), a
//! completed suggestion or a command from history launch the same agent but
//! never spell its name.

use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningAgent {
    pub agent: String,
    pub session_id: Option<String>,
    /// `CLAUDE_CONFIG_DIR` the agent runs with: the account it must resume in.
    pub config_dir: Option<String>,
    /// Folder the agent was launched from: where its session must resume.
    pub cwd: Option<String>,
}

const AGENTS: [&str; 3] = ["claude", "codex", "opencode"];

/// The agent a process is, from its argv. Looks past an interpreter
/// (`node /opt/homebrew/bin/codex`) to the script it runs.
pub fn agent_from_argv(argv: &[String]) -> Option<&'static str> {
    argv.iter().take(2).find_map(|arg| {
        let base = arg.rsplit('/').next().unwrap_or(arg);
        let name = base.strip_suffix(".js").unwrap_or(base);
        AGENTS.iter().copied().find(|agent| *agent == name)
    })
}

/// `CLAUDE_CONFIG_DIR` out of a process environment (`KEY=value` entries).
pub fn config_dir_from_env(env: &[String]) -> Option<String> {
    env.iter()
        .find_map(|entry| entry.strip_prefix("CLAUDE_CONFIG_DIR="))
        .filter(|dir| !dir.is_empty())
        .map(str::to_string)
}

/// The session id in Claude's `<config>/sessions/<pid>.json`.
pub fn claude_session_id(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let id = value.get("sessionId")?.as_str()?;
    is_safe_id(id).then(|| id.to_string())
}

/// The session id of the rollout a Codex process has open, from `lsof -Fn`.
/// Rollouts are `rollout-<timestamp>-<uuid>.jsonl`, the uuid being the id.
pub fn codex_session_id(lsof_output: &str) -> Option<String> {
    const UUID_LEN: usize = 36;
    lsof_output.lines().find_map(|line| {
        let path = line.strip_prefix('n')?;
        let file = path.rsplit('/').next()?;
        let stem = file.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
        let id = stem.get(stem.len().checked_sub(UUID_LEN)?..)?;
        is_safe_id(id).then(|| id.to_string())
    })
}

/// Ids end up in a command line (`claude --resume <id>`), so only plain ones.
pub(crate) fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && !id.starts_with('-') && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The agent running as `pid` (a terminal's foreground process), if any.
/// OpenCode leaves no per-process trace, so its session stays `None`.
pub fn running_agent(pid: u32, argv: &[String], env: &[String], cwd: Option<String>) -> Option<RunningAgent> {
    let agent = agent_from_argv(argv)?;
    let config_dir = config_dir_from_env(env);
    let session_id = match agent {
        "claude" => crate::home()
            .map(|home| crate::claude_root(&home, config_dir.as_deref()))
            .and_then(|root| std::fs::read_to_string(root.join(format!("sessions/{pid}.json"))).ok())
            .and_then(|json| claude_session_id(&json)),
        "codex" => std::process::Command::new("lsof")
            .args(["-a", "-g", &pid.to_string(), "-Fn"])
            .output()
            .ok()
            .and_then(|out| codex_session_id(&String::from_utf8_lossy(&out.stdout))),
        _ => None,
    };
    Some(RunningAgent { agent: agent.to_string(), session_id, config_dir, cwd })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn detects_an_agent_by_its_binary() {
        assert_eq!(agent_from_argv(&args(&["claude"])), Some("claude"));
        assert_eq!(agent_from_argv(&args(&["/Users/x/.local/bin/claude", "--resume", "abc"])), Some("claude"));
        assert_eq!(agent_from_argv(&args(&["opencode"])), Some("opencode"));
    }

    #[test]
    fn detects_an_agent_run_through_an_interpreter() {
        assert_eq!(agent_from_argv(&args(&["node", "/opt/homebrew/bin/codex"])), Some("codex"));
        assert_eq!(agent_from_argv(&args(&["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js"])), Some("codex"));
    }

    #[test]
    fn ignores_anything_else() {
        assert_eq!(agent_from_argv(&args(&["-zsh"])), None);
        assert_eq!(agent_from_argv(&args(&["vim", "claude.md"])), None);
        assert_eq!(agent_from_argv(&[]), None);
    }

    // The folder the agent was launched from: where its session must resume.
    #[test]
    fn reports_the_folder_the_agent_runs_in() {
        let agent = running_agent(u32::MAX, &args(&["opencode"]), &[], Some("/Users/x/repo".into())).unwrap();
        assert_eq!(agent.cwd.as_deref(), Some("/Users/x/repo"));
        assert_eq!(running_agent(u32::MAX, &args(&["-zsh"]), &[], Some("/Users/x".into())), None);
    }

    #[test]
    fn reads_the_claude_config_dir_from_the_environment() {
        let env = args(&["HOME=/Users/x", "CLAUDE_CONFIG_DIR=/Users/x/.claude-pro"]);
        assert_eq!(config_dir_from_env(&env).as_deref(), Some("/Users/x/.claude-pro"));
        assert_eq!(config_dir_from_env(&args(&["HOME=/Users/x"])), None);
        assert_eq!(config_dir_from_env(&args(&["CLAUDE_CONFIG_DIR="])), None);
    }

    #[test]
    fn reads_the_claude_session_from_its_pid_file() {
        let json = r#"{"pid":66044,"sessionId":"d20b7ada-88c8-4ee7-b4f1-78de4afbfe8c","cwd":"/repo"}"#;
        assert_eq!(claude_session_id(json).as_deref(), Some("d20b7ada-88c8-4ee7-b4f1-78de4afbfe8c"));
        assert_eq!(claude_session_id(r#"{"sessionId":"; rm -rf ~"}"#), None);
        assert_eq!(claude_session_id("not json"), None);
    }

    #[test]
    fn reads_the_codex_session_from_its_open_rollout() {
        let lsof = "p123\nn/Users/x/.codex/log/codex-tui.log\np124\nn/Users/x/.codex/sessions/2026/10/03/rollout-2026-10-03T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl\n";
        assert_eq!(codex_session_id(lsof).as_deref(), Some("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"));
        assert_eq!(codex_session_id("p1\nn/dev/ttys001\n"), None);
    }
}
