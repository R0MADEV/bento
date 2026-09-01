//! Running a review: starting it, following the daemon's stream, stopping it,
//! and filing what it produced. Split out of `mod.rs`, which had grown past
//! the size budget while this panel gained its report column and its history.

use serde_json::{json, Value};

use super::{batch_heading, new_run_id, ReviewEvent, ReviewState, ReviewView};
use crate::review_stream;

impl ReviewState {
    pub(super) fn start_run(&mut self) {
        self.output.clear();
        self.session_id = None;
        self.session_agent = None;
        let agents = self.review_agents();
        let mut body = json!({
            "id": "1", "cmd": "review.run", "cwd": self.cwd, "base": self.base,
            "context": self.context, "agents": agents,
        });
        if let Some(branch) = &self.branch {
            body["branch"] = json!(branch);
        }
        self.begin_stream(body, true);
    }

    pub(super) fn start_ask(&mut self) {
        let question = std::mem::take(&mut self.input);
        self.output.push_str(&format!("\n\n---\n\n**Pregunta:** {question}\n\n"));
        let body = json!({
            "id": "1", "cmd": "review.ask", "cwd": self.cwd, "base": self.base,
            "agent": self.agent, "question": question,
        });
        self.begin_stream(body, false);
    }

    fn begin_stream(&mut self, body: Value, is_run: bool) {
        let (rx, task) = review_stream::spawn_review_stream(body);
        self.stream_rx = Some(rx);
        self.stream_task = Some(task);
        self.running = true;
        self.is_run_stream = is_run;
        self.last_progress.clear();
        self.scroll = 0;
        // New for every run: the saves this one makes share it, and the next
        // review gets its own so both survive.
        self.run_id = Some(new_run_id());
        // Stays in Browse: the report goes to the drawer beside the files
        // rather than replacing the panel, so the rail and the file list are
        // still there while it runs.
        self.view = ReviewView::Browse;
        self.open_drawer();
    }

    pub(in crate::tui) fn handle_stream_event(&mut self, event: ReviewEvent) {
        match event {
            ReviewEvent::Content(text) => self.output.push_str(&text),
            ReviewEvent::Progress(msg) => {
                // run_review()'s own "[SESSION:agent:id]" sentinel, already
                // stripped of its brackets by classify_review_chunk — keep
                // it so a finished run's checkpoint can resume that session.
                if let Some((agent, id)) = msg.strip_prefix("SESSION:").and_then(|rest| rest.split_once(':')) {
                    self.session_agent = Some(agent.to_string());
                    self.session_id = Some(id.to_string());
                }
                // A multi-agent run streams every report into one buffer. The
                // sentinels are the only place that says where one pass ends
                // and the next begins, so they become headings instead of
                // being dropped after the progress line.
                if let Some(heading) = batch_heading(&msg) {
                    self.output.push_str(&heading);
                }
                // A failure is the answer, not progress: kept in the report
                // so it is still on screen once the run stops. Everything else
                // is noise the moment the report exists.
                if let Some(reason) = msg.strip_prefix("error: ") {
                    self.output.push_str(&format!("\n\n**La review falló:** {reason}\n"));
                }
                self.last_progress = msg;
            }
            ReviewEvent::Done => {
                self.running = false;
                self.stream_rx = None;
                self.stream_task = None;
                if self.is_run_stream && !self.output.trim().is_empty() {
                    self.save_checkpoint();
                }
            }
        }
    }

    /// Fire-and-forget: persists the just-finished run as a checkpoint so a
    /// later `a` (ask) has something to resume — mirrors what the web
    /// panel's own JS does after each batch, via the same `review.*`
    /// checkpoint storage (`review.checkpoint_save`, a thin IPC wrapper
    /// around the same save the web panel's `PUT /api/review/checkpoint`
    /// uses).
    fn save_checkpoint(&self) {
        let body = json!({
            "id": "1", "cmd": "review.checkpoint_save", "cwd": self.cwd, "base": self.base,
            "content": self.output, "session_id": self.session_id, "agent": self.session_agent,
            "run_id": self.run_id, "branch": self.branch,
        });
        tokio::spawn(async move {
            let _ = crate::request_data(body).await;
        });
    }
}

impl ReviewState {
    /// Stops the review. Aborting the task drops its TcpStream, which closes
    /// the connection, which is what the daemon reads as "cancel this run" —
    /// so the agents are killed rather than left running for a stream nobody
    /// is reading.
    ///
    /// The daemon notices on its next write, so an agent that has been silent
    /// for a while keeps going until it says something. Better than the old
    /// behaviour, which was to never stop at all.
    pub(super) fn cancel_run(&mut self) {
        if let Some(task) = self.stream_task.take() {
            task.abort();
        }
        self.stream_rx = None;
        self.running = false;
        self.output.push_str("\n\n*(cancelado)*\n");
    }

    /// What the rail's action button does, which depends on what the button
    /// currently says: starting a second run from a button labelled "Parar"
    /// duplicates the work and the billing.
    pub(in crate::tui) fn toggle_run(&mut self) {
        if self.running {
            self.cancel_run();
            return;
        }
        self.start_run();
    }

    /// The agents this run should use, as the daemon's comma-separated list.
    /// Without compare it is just the primary; with it, every extra pass that
    /// is set — repeats included, since asking one agent for several passes
    /// is a deliberate choice and not a mistake to correct.
    pub(super) fn review_agents(&self) -> String {
        if !self.compare {
            return self.agent.clone();
        }
        let mut agents = vec![self.agent.clone()];
        agents.extend([&self.secondary, &self.tertiary].into_iter().flatten().cloned());
        agents.join(",")
    }
}
