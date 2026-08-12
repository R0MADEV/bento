use super::adapter::{parse_json_line, AgentAdapter, ParsedLine};
use super::codex::CodexAdapter;
use super::custom::CustomAdapter;
use super::opencode::OpenCodeAdapter;
use super::{build_agent_invocation, safe_prefix, AgentInvocation};
use std::path::Path;

fn args_of(inv: &AgentInvocation) -> Vec<String> {
    inv.args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
}

#[test]
fn claude_command_streams_json_and_restricts_tools_in_review() {
    let inv = build_agent_invocation("claude", "PROMPT", Path::new("/repo"), Some("sess"), true).unwrap();
    assert_eq!(inv.program, "claude");
    assert_eq!(
        args_of(&inv),
        vec![
            "-p", "PROMPT", "--output-format", "stream-json", "--verbose",
            "--resume", "sess", "--allowedTools", "Read,Glob,Grep",
        ]
    );
}

#[test]
fn claude_command_without_session_or_review() {
    let inv = build_agent_invocation("claude", "P", Path::new("/repo"), None, false).unwrap();
    assert_eq!(args_of(&inv), vec!["-p", "P", "--output-format", "stream-json", "--verbose"]);
}

#[test]
fn opencode_command_passes_dir_prompt_and_session() {
    let inv = build_agent_invocation("opencode", "P", Path::new("/repo"), Some("s"), false).unwrap();
    assert_eq!(inv.program, "opencode");
    assert_eq!(
        args_of(&inv),
        vec!["run", "--format", "json", "--dir", "/repo", "P", "--session", "s"]
    );
}

#[test]
fn codex_resume_puts_session_and_prompt_last() {
    let inv = build_agent_invocation("codex", "P", Path::new("/repo"), Some("s"), false).unwrap();
    assert_eq!(inv.program, "codex");
    assert_eq!(
        args_of(&inv),
        vec!["exec", "--sandbox", "read-only", "--cd", "/repo", "resume", "--json", "--skip-git-repo-check", "s", "P"]
    );
}

#[test]
fn codex_without_session_appends_prompt_after_flags() {
    let inv = build_agent_invocation("codex", "P", Path::new("/repo"), None, false).unwrap();
    assert_eq!(
        args_of(&inv),
        vec!["exec", "--sandbox", "read-only", "--cd", "/repo", "--json", "--skip-git-repo-check", "P"]
    );
}

#[test]
fn unknown_agent_is_rejected() {
    assert!(build_agent_invocation("foo", "P", Path::new("/repo"), None, false).is_err());
}

#[test]
fn parses_claude_session_and_done_without_repeating_result_text() {
    assert!(
        matches!(parse_json_line(r#"{"type":"system","session_id":"s1"}"#, "claude"), ParsedLine::SessionId(id) if id == "s1")
    );
    assert!(matches!(
        parse_json_line(
            r#"{"type":"result","is_error":false,"result":"answer"}"#,
            "claude"
        ),
        ParsedLine::Done
    ));
}

#[test]
fn ignores_unparseable_claude_lines() {
    assert!(matches!(
        parse_json_line("not json", "claude"),
        ParsedLine::Ignore
    ));
}

#[test]
fn safe_prefix_never_splits_utf8() {
    assert_eq!(safe_prefix("aé", 2), "a");
    assert_eq!(safe_prefix("aé", 3), "aé");
}

// ── OpenCode adapter (--format json, v1.18+) ────────────────────────────────

#[test]
fn opencode_text_event_emits_chunk() {
    let line = r#"{"type":"text","timestamp":1,"sessionID":"ses_abc","part":{"id":"p1","type":"text","text":"Hello"}}"#;
    assert!(matches!(OpenCodeAdapter.parse_line(line), ParsedLine::Chunk(t) if t == "Hello"));
}

#[test]
fn opencode_step_finish_stop_emits_session_id() {
    let line = r#"{"type":"step_finish","timestamp":2,"sessionID":"ses_abc","part":{"id":"p2","reason":"stop","type":"step-finish"}}"#;
    assert!(
        matches!(OpenCodeAdapter.parse_line(line), ParsedLine::SessionId(id) if id == "ses_abc")
    );
}

#[test]
fn opencode_step_finish_non_stop_is_ignored() {
    let line = r#"{"type":"step_finish","sessionID":"ses_abc","part":{"reason":"tool_use","type":"step-finish"}}"#;
    assert!(matches!(
        OpenCodeAdapter.parse_line(line),
        ParsedLine::Ignore
    ));
}

#[test]
fn opencode_step_start_is_ignored() {
    let line = r#"{"type":"step_start","sessionID":"ses_abc","part":{"type":"step-start"}}"#;
    assert!(matches!(
        OpenCodeAdapter.parse_line(line),
        ParsedLine::Ignore
    ));
}

#[test]
fn opencode_non_json_line_is_ignored() {
    assert!(matches!(
        OpenCodeAdapter.parse_line("plain text"),
        ParsedLine::Ignore
    ));
}

#[test]
fn opencode_empty_text_part_is_ignored() {
    let line = r#"{"type":"text","sessionID":"ses_abc","part":{"text":""}}"#;
    assert!(matches!(
        OpenCodeAdapter.parse_line(line),
        ParsedLine::Ignore
    ));
}

#[test]
fn opencode_tool_event_emits_review_evidence() {
    let line = r#"{"type":"tool_use","sessionID":"ses_abc","part":{"type":"tool","tool":"read","state":{"input":{"filePath":"src/main.ts"}}}}"#;
    assert!(
        matches!(OpenCodeAdapter.parse_line(line), ParsedLine::ToolUse(t) if t == "read: src/main.ts")
    );
}

// ── Codex adapter (codex exec --json, v0.146+) ──────────────────────────────

#[test]
fn codex_thread_started_emits_session_id() {
    let line = r#"{"type":"thread.started","thread_id":"019fc494-e9b5-71e1-87d5-7f79bf7c5ccc"}"#;
    assert!(
        matches!(CodexAdapter.parse_line(line), ParsedLine::SessionId(id) if id == "019fc494-e9b5-71e1-87d5-7f79bf7c5ccc")
    );
}

#[test]
fn codex_agent_message_emits_chunk() {
    let line = r#"{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Hello!"}}"#;
    assert!(matches!(CodexAdapter.parse_line(line), ParsedLine::Chunk(t) if t == "Hello!"));
}

#[test]
fn codex_command_execution_emits_review_evidence() {
    let line = r#"{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"rg createReview src"}}"#;
    assert!(
        matches!(CodexAdapter.parse_line(line), ParsedLine::ToolUse(t) if t == "Command: rg createReview src")
    );
}

#[test]
fn codex_turn_completed_emits_done() {
    let line = r#"{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":5}}"#;
    assert!(matches!(CodexAdapter.parse_line(line), ParsedLine::Done));
}

#[test]
fn codex_hook_error_item_is_ignored() {
    let line = r#"{"type":"item.completed","item":{"id":"item_0","type":"error","message":"hook warning"}}"#;
    assert!(matches!(CodexAdapter.parse_line(line), ParsedLine::Ignore));
}

#[test]
fn codex_turn_started_is_ignored() {
    assert!(matches!(
        CodexAdapter.parse_line(r#"{"type":"turn.started"}"#),
        ParsedLine::Ignore
    ));
}

#[test]
fn codex_empty_agent_message_is_ignored() {
    let line = r#"{"type":"item.completed","item":{"type":"agent_message","text":""}}"#;
    assert!(matches!(CodexAdapter.parse_line(line), ParsedLine::Ignore));
}

// ── Custom adapter ───────────────────────────────────────────────────────────

#[test]
fn custom_non_empty_line_becomes_chunk() {
    assert!(
        matches!(CustomAdapter.parse_line("any output"), ParsedLine::Chunk(t) if t == "any output")
    );
}

#[test]
fn custom_empty_line_is_ignored() {
    assert!(matches!(CustomAdapter.parse_line(""), ParsedLine::Ignore));
}
