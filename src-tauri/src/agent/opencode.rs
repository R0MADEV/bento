use super::adapter::{AgentAdapter, ParsedLine};
use serde_json::Value;

pub struct OpenCodeAdapter;

impl AgentAdapter for OpenCodeAdapter {
    fn parse_line(&self, line: &str) -> ParsedLine {
        // opencode run --format json (v1.18+) emits one JSON object per line.
        // {"type":"text","sessionID":"ses_...","part":{"text":"Hello"}}
        // {"type":"step_finish","sessionID":"ses_...","part":{"reason":"stop",...}}
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return ParsedLine::Ignore;
        };

        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");

        // Session ID available on every event; capture it for session continuation.
        if let Some(id) = value.get("sessionID").and_then(Value::as_str) {
            if event_type == "step_finish" {
                let reason = value
                    .get("part")
                    .and_then(|p| p.get("reason"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if reason == "stop" {
                    return ParsedLine::SessionId(id.to_string());
                }
                return ParsedLine::Ignore;
            }
        }

        if event_type == "text" {
            if let Some(text) = value
                .get("part")
                .and_then(|p| p.get("text"))
                .and_then(Value::as_str)
            {
                if !text.is_empty() {
                    return ParsedLine::Chunk(text.to_string());
                }
            }
        }

        ParsedLine::Ignore
    }
}
