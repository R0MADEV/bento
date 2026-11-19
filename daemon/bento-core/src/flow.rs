//! Backpressure between a terminal and the clients drawing it.
//!
//! A client that opts in reports how much output it has already painted; while
//! any of them is too far behind, the terminal's reader stops pulling from the
//! PTY, so the program blocks on its own writes instead of the backlog piling
//! up in the client's memory (a fast producer used to queue >1 GB in the UI).

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// Unacked output past which the reader pauses.
pub(crate) const HIGH_WATERMARK: usize = 1024 * 1024;
/// Unacked output under which a paused reader resumes.
pub(crate) const LOW_WATERMARK: usize = 256 * 1024;
/// A client that stops acking (hung, gone without closing) must not freeze the
/// terminal for everyone else: after this, the reader moves on anyway.
pub(crate) const STALL_TIMEOUT: Duration = Duration::from_secs(5);

/// Unacked output per flow-controlled client of one terminal.
pub(crate) struct FlowControl {
    high: usize,
    low: usize,
    timeout: Duration,
    state: Mutex<State>,
    caught_up: Condvar,
}

#[derive(Default)]
struct State {
    next_client: u64,
    unacked: HashMap<u64, usize>,
}

impl State {
    fn any_above(&self, mark: usize) -> bool {
        self.unacked.values().any(|&pending| pending > mark)
    }
}

impl Default for FlowControl {
    fn default() -> Self {
        Self::new(HIGH_WATERMARK, LOW_WATERMARK, STALL_TIMEOUT)
    }
}

impl FlowControl {
    pub(crate) fn new(high: usize, low: usize, timeout: Duration) -> Self {
        Self { high, low, timeout, state: Mutex::default(), caught_up: Condvar::new() }
    }

    pub(crate) fn register(&self) -> u64 {
        let mut state = self.state.lock().unwrap();
        state.next_client += 1;
        let client = state.next_client;
        state.unacked.insert(client, 0);
        client
    }

    pub(crate) fn unregister(&self, client: u64) {
        self.state.lock().unwrap().unacked.remove(&client);
        self.caught_up.notify_all();
    }

    /// `amount` more output went to `client`.
    pub(crate) fn sent(&self, client: u64, amount: usize) {
        if let Some(pending) = self.state.lock().unwrap().unacked.get_mut(&client) {
            *pending += amount;
        }
    }

    /// `client` painted `amount` of what it was sent.
    pub(crate) fn ack(&self, client: u64, amount: usize) {
        if let Some(pending) = self.state.lock().unwrap().unacked.get_mut(&client) {
            *pending = pending.saturating_sub(amount);
        }
        self.caught_up.notify_all();
    }

    /// Blocks the reader while a client is past the high mark, until every
    /// client is back under the low one (or the stall timeout runs out).
    pub(crate) fn wait_for_clients(&self) {
        let state = self.state.lock().unwrap();
        if !state.any_above(self.high) {
            return;
        }
        let deadline = Instant::now() + self.timeout;
        let mut state = state;
        while state.any_above(self.low) {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                // Whatever is still unacked is presumed lost (painted by no one):
                // start over so it can't stall every chunk after this one.
                state.unacked.values_mut().for_each(|pending| *pending = 0);
                return;
            };
            state = self.caught_up.wait_timeout(state, left).unwrap().0;
        }
    }
}

/// One client's seat on a terminal's flow control; leaving it (drop) releases
/// a reader that was waiting on this client.
pub struct FlowClient {
    flow: Arc<FlowControl>,
    client: u64,
}

impl FlowClient {
    pub(crate) fn join(flow: Arc<FlowControl>) -> Self {
        let client = flow.register();
        Self { flow, client }
    }

    /// Output went out to this client, in UTF-16 units (what the JS side counts).
    pub fn sent(&self, amount: usize) {
        self.flow.sent(self.client, amount);
    }

    pub fn ack(&self, amount: usize) {
        self.flow.ack(self.client, amount);
    }
}

impl Drop for FlowClient {
    fn drop(&mut self) {
        self.flow.unregister(self.client);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    const HIGH: usize = 100;
    const LOW: usize = 20;

    fn gate(timeout_ms: u64) -> Arc<FlowControl> {
        Arc::new(FlowControl::new(HIGH, LOW, Duration::from_millis(timeout_ms)))
    }

    /// Runs `wait_for_clients` on a thread and reports how long it blocked.
    fn wait_in_background(flow: &Arc<FlowControl>) -> std::thread::JoinHandle<Duration> {
        let flow = flow.clone();
        std::thread::spawn(move || {
            let start = Instant::now();
            flow.wait_for_clients();
            start.elapsed()
        })
    }

    #[test]
    fn a_terminal_without_flow_clients_never_waits() {
        let flow = gate(5_000);
        let start = Instant::now();
        flow.wait_for_clients();
        assert!(start.elapsed() < Duration::from_millis(50));
    }

    #[test]
    fn a_client_below_the_high_mark_does_not_pause_the_reader() {
        let flow = gate(5_000);
        let client = flow.register();
        flow.sent(client, HIGH);
        let start = Instant::now();
        flow.wait_for_clients();
        assert!(start.elapsed() < Duration::from_millis(50));
    }

    #[test]
    fn a_client_too_far_behind_pauses_the_reader_until_it_catches_up() {
        let flow = gate(5_000);
        let client = flow.register();
        flow.sent(client, HIGH + 1);
        let waiter = wait_in_background(&flow);

        std::thread::sleep(Duration::from_millis(100));
        // Back under HIGH but still above LOW: hysteresis keeps it paused.
        flow.ack(client, HIGH + 1 - LOW - 1);
        std::thread::sleep(Duration::from_millis(100));
        assert!(!waiter.is_finished(), "resumed before reaching the low mark");

        flow.ack(client, 1);
        let blocked = waiter.join().unwrap();
        assert!(blocked >= Duration::from_millis(200));
        assert!(blocked < Duration::from_secs(2));
    }

    #[test]
    fn a_client_that_leaves_releases_the_reader() {
        let flow = gate(5_000);
        let client = flow.register();
        flow.sent(client, HIGH * 10);
        let waiter = wait_in_background(&flow);

        std::thread::sleep(Duration::from_millis(50));
        flow.unregister(client);

        assert!(waiter.join().unwrap() < Duration::from_secs(2));
    }

    #[test]
    fn a_client_that_stops_acking_cannot_freeze_the_terminal_forever() {
        let flow = gate(150);
        let client = flow.register();
        flow.sent(client, HIGH * 10);

        let blocked = wait_in_background(&flow).join().unwrap();

        assert!(blocked >= Duration::from_millis(150));
        assert!(blocked < Duration::from_secs(2));
    }

    #[test]
    fn output_never_acked_is_forgiven_after_a_stall() {
        // Output that reached no listener is never acked; counting it forever
        // would stall every later chunk for the whole timeout.
        let flow = gate(150);
        let client = flow.register();
        flow.sent(client, HIGH * 10);
        flow.wait_for_clients();

        flow.sent(client, HIGH);
        let start = Instant::now();
        flow.wait_for_clients();

        assert!(start.elapsed() < Duration::from_millis(50));
    }

    #[test]
    fn acking_more_than_was_sent_does_not_underflow() {
        let flow = gate(5_000);
        let client = flow.register();
        flow.sent(client, 10);
        flow.ack(client, 1_000);
        flow.sent(client, HIGH);
        let start = Instant::now();
        flow.wait_for_clients();
        assert!(start.elapsed() < Duration::from_millis(50));
    }
}
