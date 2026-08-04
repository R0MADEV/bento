use super::adapter::{AgentAdapter, ParsedLine};
use serde_json::Value;

pub struct CodexAdapter;

impl AgentAdapter for CodexAdapter {
    fn parse_line(&self, line: &str) -> ParsedLine {
        // codex exec --json (v0.146+) emits one JSON object per line.
        // {"type":"thread.started","thread_id":"019fc..."}
        // {"type":"item.completed","item":{"type":"agent_message","text":"Hello!"}}
        // {"type":"item.completed","item":{"type":"error","message":"..."}}  ← hook warnings; ignore
        // {"type":"turn.completed","usage":{...}}
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return ParsedLine::Ignore;
        };

        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");

        if event_type == "thread.started" {
            if let Some(id) = value.get("thread_id").and_then(Value::as_str) {
                return ParsedLine::SessionId(id.to_string());
            }
        }

        if event_type == "turn.completed" {
            return ParsedLine::Done;
        }

        if event_type == "item.completed" {
            if let Some(item) = value.get("item") {
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
                if item_type == "agent_message" {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            return ParsedLine::Chunk(text.to_string());
                        }
                    }
                }
                // item_type == "error" are hook/config warnings, not LLM errors — ignore
            }
        }

        ParsedLine::Ignore
    }
}
