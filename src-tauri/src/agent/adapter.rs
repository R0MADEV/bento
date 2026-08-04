use serde_json::Value;

pub enum ParsedLine {
    Chunk(String),
    ToolUse(String),
    SessionId(String),
    Done,
    Error(String),
    Ignore,
}

#[allow(dead_code)]
pub struct StreamResult {
    pub session_id: Option<String>,
    pub stderr: String,
}

pub trait AgentAdapter: Send + Sync {
    fn parse_line(&self, line: &str) -> ParsedLine;
}

#[allow(dead_code)]
pub struct GenericAdapter {
    pub agent: String,
}

impl AgentAdapter for GenericAdapter {
    fn parse_line(&self, line: &str) -> ParsedLine {
        parse_json_line(line, &self.agent)
    }
}

#[allow(dead_code)]
pub fn parse_json_line(line: &str, agent: &str) -> ParsedLine {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return if agent == "claude" {
            ParsedLine::Ignore
        } else {
            ParsedLine::Chunk(line.to_string())
        };
    };
    if value.get("type").and_then(Value::as_str) == Some("system") {
        if let Some(id) = value.get("session_id").and_then(Value::as_str) {
            return ParsedLine::SessionId(id.to_string());
        }
    }
    if value.get("type").and_then(Value::as_str) == Some("result") {
        return if value.get("is_error").and_then(Value::as_bool) == Some(true) {
            ParsedLine::Error(
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("agent error")
                    .to_string(),
            )
        } else {
            ParsedLine::Done
        };
    }
    let text = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<String>()
        })
        .or_else(|| {
            ["text", "content", "delta"]
                .iter()
                .find_map(|key| value.get(*key).and_then(Value::as_str).map(str::to_string))
        });
    text.filter(|text| !text.is_empty())
        .map_or(ParsedLine::Ignore, ParsedLine::Chunk)
}
