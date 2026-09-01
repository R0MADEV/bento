//! Reopening a saved review, through the real store path.
//!
//! Its own test binary so it can point `HOME` at a temp directory without
//! racing the unit tests: `store_dir` reads `HOME` at call time.
//!
//! The unit tests cover the scan on its own. What this one covers is the
//! wiring — `get_checkpoint` reaching that scan — which is exactly what was
//! broken: the desktop wrote every review under a run id and then asked for
//! `(cwd, base)`, which only ever looked at the runless path and found
//! nothing.

use bento_review::checkpoints::{get_checkpoint, save_checkpoint, Checkpoint};

fn checkpoint(cwd: &str, base: &str, run: Option<&str>, saved: &str) -> Checkpoint {
    Checkpoint {
        cwd: cwd.into(),
        base: base.into(),
        content: format!("report {saved}"),
        saved_at: saved.into(),
        session_id: Some("sess-1".into()),
        session_agent: Some("claude".into()),
        branch: None,
        commit: None,
        run_id: run.map(String::from),
    }
}

#[test]
fn a_review_saved_with_a_run_id_can_be_reopened_by_branch() {
    let home = std::env::temp_dir().join(format!("bento-reopen-home-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);

    save_checkpoint(&checkpoint("/repo", "feat/x", Some("run-1"), "2026-08-27T09:00:00Z")).unwrap();
    save_checkpoint(&checkpoint("/repo", "feat/x", Some("run-2"), "2026-08-27T10:00:00Z")).unwrap();

    let found = get_checkpoint("/repo", "feat/x").expect("the desktop has to find what it saved");
    assert_eq!(found.run_id.as_deref(), Some("run-2"), "the newest run of that branch");
    assert!(found.session_id.is_some(), "and it can still be asked a follow-up");

    assert!(get_checkpoint("/repo", "never-reviewed").is_none());
    let _ = std::fs::remove_dir_all(home);
}
