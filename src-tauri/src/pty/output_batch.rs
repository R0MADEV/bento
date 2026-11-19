//! Terminal output waiting to be handed to the webview, merged per terminal.
//!
//! Every event the webview gets is a JavaScript evaluation (Tauri evaluates
//! payloads under 8 KB inline, channels included), and a flooding program used
//! to arrive as thousands of 4 KB chunks a second, piling up garbage faster
//! than WebKit collected it. Chunks already waiting in the socket are merged
//! and emitted as one event per terminal.

/// Flush at this size even if more is waiting, so a flood still paints steadily.
pub(super) const BATCH_CAP: usize = 256 * 1024;

#[derive(Default)]
pub(super) struct OutputBatch {
    /// (pty id, output) in the order each terminal first showed up.
    pending: Vec<(String, String)>,
    size: usize,
}

impl OutputBatch {
    pub(super) fn push(&mut self, id: &str, data: &str) {
        self.size += data.len();
        match self.pending.iter_mut().find(|(pending_id, _)| pending_id == id) {
            Some((_, output)) => output.push_str(data),
            None => self.pending.push((id.to_string(), data.to_string())),
        }
    }

    pub(super) fn is_full(&self) -> bool {
        self.size >= BATCH_CAP
    }

    pub(super) fn take(&mut self) -> Vec<(String, String)> {
        self.size = 0;
        std::mem::take(&mut self.pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_of_one_terminal_merge_in_order() {
        let mut batch = OutputBatch::default();
        batch.push("a", "hel");
        batch.push("a", "lo");
        assert_eq!(batch.take(), vec![("a".to_string(), "hello".to_string())]);
    }

    #[test]
    fn each_terminal_keeps_its_own_output_in_first_seen_order() {
        let mut batch = OutputBatch::default();
        batch.push("b", "1");
        batch.push("a", "2");
        batch.push("b", "3");
        assert_eq!(
            batch.take(),
            vec![("b".to_string(), "13".to_string()), ("a".to_string(), "2".to_string())]
        );
    }

    #[test]
    fn taking_empties_the_batch() {
        let mut batch = OutputBatch::default();
        batch.push("a", "x");
        batch.take();
        assert!(batch.take().is_empty());
        assert!(!batch.is_full());
    }

    #[test]
    fn it_is_full_once_it_holds_the_cap() {
        let mut batch = OutputBatch::default();
        batch.push("a", &"x".repeat(BATCH_CAP - 1));
        assert!(!batch.is_full());
        batch.push("a", "x");
        assert!(batch.is_full());
    }
}
