//! Review logic shared by the desktop app (`src-tauri`), the daemon's phone
//! remote and the `bento` CLI/TUI. Until now each of them carried its own
//! copy — the prompt existed twice, once in Rust and once in TypeScript
//! (`src/core/ai/techReview.ts`), and the two had already drifted.

pub mod agents;
pub mod checkpoints;
pub mod diff;
pub mod engine;
pub mod pr;
pub mod prompt;
pub mod vcs;

pub use prompt::{build_review_prompt, build_synthesis_prompt, ReviewPromptFile, ReviewPromptInput};
