use super::adapter::{AgentAdapter, ParsedLine};

pub struct CustomAdapter;

impl AgentAdapter for CustomAdapter {
    fn parse_line(&self, line: &str) -> ParsedLine {
        // Custom executables emit arbitrary output; treat each non-empty line as a chunk.
        if line.is_empty() {
            ParsedLine::Ignore
        } else {
            ParsedLine::Chunk(line.to_string())
        }
    }
}
