//! Review logic shared by the desktop app (`src-tauri`), the daemon's phone
//! remote and the `bento` CLI/TUI. Until now each of them carried its own
//! copy — the prompt existed twice, once in Rust and once in TypeScript
//! (`src/core/ai/techReview.ts`), and the two had already drifted.

pub mod agents;
pub mod backup;
pub mod branches;
pub mod checkpoints;
pub mod commit;
pub mod diff;
pub mod edit;
pub mod log;
pub mod engine;
pub mod lexis;
pub mod reports;
pub mod snapshot;
pub mod stream;
pub mod pr;
pub mod prompt;
pub mod rebase;
pub mod report;
pub mod recommend;
pub mod status;
pub mod store;
#[cfg(test)]
pub mod test_support;

pub mod sync;
pub mod tasks;
pub mod vcs;
pub mod viewed;
pub mod worktree;
pub mod worktrees;

pub use prompt::{build_review_prompt, build_synthesis_prompt, ReviewPromptFile, ReviewPromptInput};
