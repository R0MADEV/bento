//! bento-core — pure PTY/agent management shared by the daemon, the CLI and
//! (later) the Tauri app. No Tauri dependencies: output is delivered over a
//! broadcast channel instead of window events.

pub mod profiles;
mod pty;

pub use pty::{OpenOptions, PtyEvent, PtyInfo, PtyManager};
