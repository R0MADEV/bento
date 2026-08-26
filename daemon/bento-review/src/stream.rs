//! Reading the daemon's review stream back into events.
//!
//! The daemon flattens a review into one text stream with control markers in
//! `[BRACKETS]`; every client has to turn that back into events. Parsing it
//! lived in the CLI, so the desktop app would have had to copy it — and a
//! second copy of a wire format is how the two stop agreeing on it.

/// One line of the daemon's review stream, told apart from report text.
#[derive(Debug, PartialEq, Eq)]
pub enum StreamLine {
    /// Stage `index` of `total` starting, with the stage's own label.
    Batch { index: usize, total: usize, label: String },
    /// The final verification pass.
    Synthesis,
    /// The session that can be resumed to ask follow-up questions.
    Session { agent: String, id: String },
    /// What the agent is doing right now.
    Tool(String),
    Error(String),
    Done,
    /// Report text, to be shown as-is.
    Text(String),
}

/// Classifies one line. Anything unrecognised is report text: a marker that
/// gained a field must not silently vanish from the report.
pub fn parse_stream_line(line: &str) -> StreamLine {
    if line == "[SYNTHESIS]" {
        return StreamLine::Synthesis;
    }
    if line == "[DONE]" {
        return StreamLine::Done;
    }
    if let Some(rest) = bracketed(line, "[BATCH:") {
        // "index/total:label" — the label may contain colons of its own, so
        // only the counts are split off.
        if let Some((counts, label)) = rest.split_once(':') {
            if let Some((index, total)) = counts.split_once('/') {
                if let (Ok(index), Ok(total)) = (index.parse(), total.parse()) {
                    return StreamLine::Batch { index, total, label: label.to_string() };
                }
            }
        }
        return StreamLine::Text(line.to_string());
    }
    if let Some(rest) = bracketed(line, "[SESSION:") {
        if let Some((agent, id)) = rest.split_once(':') {
            return StreamLine::Session { agent: agent.to_string(), id: id.to_string() };
        }
        return StreamLine::Text(line.to_string());
    }
    if let Some(message) = line.strip_prefix("[ERROR] ") {
        return StreamLine::Error(message.to_string());
    }
    // Tools are progress, not report: they show what the agent is looking at
    // without ending up in the review text.
    if let Some(tool) = line.strip_prefix("[TOOL] ") {
        return StreamLine::Tool(tool.to_string());
    }
    StreamLine::Text(line.to_string())
}

/// The body of a `[PREFIX…]` marker, if the line is one.
fn bracketed<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    line.strip_prefix(prefix)?.strip_suffix(']')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_batch_marker_carries_its_counts_and_label() {
        assert_eq!(
            parse_stream_line("[BATCH:1/3:Agente 1/3 (claude)]"),
            StreamLine::Batch { index: 1, total: 3, label: "Agente 1/3 (claude)".into() }
        );
    }

    #[test]
    fn a_label_with_colons_survives_intact() {
        // Only the counts are split off; the label is whatever follows.
        assert_eq!(
            parse_stream_line("[BATCH:1/2:algo: con dos puntos]"),
            StreamLine::Batch { index: 1, total: 2, label: "algo: con dos puntos".into() }
        );
    }

    #[test]
    fn the_session_marker_splits_agent_from_id() {
        assert_eq!(
            parse_stream_line("[SESSION:codex:sess-9]"),
            StreamLine::Session { agent: "codex".into(), id: "sess-9".into() }
        );
    }

    #[test]
    fn synthesis_done_tools_and_errors_are_recognised() {
        assert_eq!(parse_stream_line("[SYNTHESIS]"), StreamLine::Synthesis);
        assert_eq!(parse_stream_line("[DONE]"), StreamLine::Done);
        assert_eq!(parse_stream_line("[TOOL] Read foo.rs"), StreamLine::Tool("Read foo.rs".into()));
        assert_eq!(parse_stream_line("[ERROR] se rompió"), StreamLine::Error("se rompió".into()));
    }

    #[test]
    fn report_text_is_left_alone() {
        assert_eq!(parse_stream_line("**Veredicto:** fail"), StreamLine::Text("**Veredicto:** fail".into()));
    }

    #[test]
    fn a_line_that_merely_looks_like_a_marker_stays_in_the_report() {
        // A finding can quote one. Swallowing it would drop it from the report.
        assert_eq!(
            parse_stream_line("[BATCH: esto no son cuentas]"),
            StreamLine::Text("[BATCH: esto no son cuentas]".into())
        );
    }
}
