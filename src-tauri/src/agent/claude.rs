use super::adapter::{AgentAdapter, ParsedLine};
use serde_json::Value;

#[derive(Default)]
pub struct ClaudeAdapter;

impl AgentAdapter for ClaudeAdapter {
    fn parse_line(&self, line: &str) -> ParsedLine {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return ParsedLine::Ignore;
        };
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        if event_type == "system" {
            if let Some(id) = value.get("session_id").and_then(Value::as_str) {
                return ParsedLine::SessionId(id.to_string());
            }
        }
        if event_type == "result" {
            return if value.get("is_error").and_then(Value::as_bool) == Some(true) {
                ParsedLine::Error(
                    value.get("error").and_then(Value::as_str).unwrap_or("agent error").to_string(),
                )
            } else {
                ParsedLine::Done
            };
        }
        if let Some(parts) = value
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        {
            let text: String = parts
                .iter()
                .filter_map(|p| {
                    if p.get("type").and_then(Value::as_str) == Some("text") {
                        p.get("text").and_then(Value::as_str)
                    } else {
                        None
                    }
                })
                .collect();
            if !text.is_empty() {
                return ParsedLine::Chunk(text);
            }
            if let Some(tool) = parts
                .iter()
                .find(|p| p.get("type").and_then(Value::as_str) == Some("tool_use"))
            {
                let name = tool.get("name").and_then(Value::as_str).unwrap_or("tool");
                let path = tool
                    .get("input")
                    .and_then(|i| {
                        i.get("file_path")
                            .or_else(|| i.get("path"))
                            .or_else(|| i.get("pattern"))
                    })
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let desc = if path.is_empty() {
                    name.to_string()
                } else {
                    format!("{name}: {path}")
                };
                return ParsedLine::ToolUse(desc);
            }
        }
        ParsedLine::Ignore
    }
}
