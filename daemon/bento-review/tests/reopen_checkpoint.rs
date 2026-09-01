//! Reopening and deleting a saved review, through the real store path.
//!
//! Its own test binary so it can point `HOME` at a temp directory without
//! racing the unit tests: `store_dir` reads `HOME` at call time. Inside the
//! binary the tests still share a process, so `HOME` is set once and each test
//! works under its own `cwd` instead — setting it per test raced, and which
//! store a test saw depended on who won.
//!
//! The unit tests cover the scan on its own. What these cover is the wiring,
//! which is what was broken: every client now stamps a run id, and both
//! reopening and deleting only ever looked at the runless path.

use std::sync::OnceLock;

use bento_review::checkpoints::{delete_checkpoint, get_checkpoint, save_checkpoint, Checkpoint};

/// One temp `HOME` for the whole binary, set before any test reads it.
fn home() {
    static HOME: OnceLock<()> = OnceLock::new();
    HOME.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("bento-store-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("HOME", &dir);
    });
}

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
    home();
    let cwd = "/repo-reopen";
    save_checkpoint(&checkpoint(cwd, "feat/x", Some("run-1"), "2026-08-27T09:00:00Z")).unwrap();
    save_checkpoint(&checkpoint(cwd, "feat/x", Some("run-2"), "2026-08-27T10:00:00Z")).unwrap();

    let found = get_checkpoint(cwd, "feat/x").expect("the desktop has to find what it saved");
    assert_eq!(found.run_id.as_deref(), Some("run-2"), "the newest run of that branch");
    assert!(found.session_id.is_some(), "and it can still be asked a follow-up");

    assert!(get_checkpoint(cwd, "never-reviewed").is_none());
}

#[test]
fn deleting_a_review_removes_the_run_it_names() {
    home();
    let cwd = "/repo-delete";
    save_checkpoint(&checkpoint(cwd, "main", Some("run-1"), "2026-08-27T09:00:00Z")).unwrap();
    save_checkpoint(&checkpoint(cwd, "main", Some("run-2"), "2026-08-27T10:00:00Z")).unwrap();

    delete_checkpoint(cwd, "main", Some("run-2")).unwrap();
    assert_eq!(
        get_checkpoint(cwd, "main").unwrap().run_id.as_deref(),
        Some("run-1"),
        "the other run stays",
    );

    delete_checkpoint(cwd, "main", Some("run-1")).unwrap();
    assert!(get_checkpoint(cwd, "main").is_none(), "and now there is none left");
}

#[test]
fn deleting_without_a_run_id_still_removes_the_old_entry() {
    home();
    let cwd = "/repo-legacy";
    save_checkpoint(&checkpoint(cwd, "main", None, "2026-08-27T09:00:00Z")).unwrap();
    delete_checkpoint(cwd, "main", None).unwrap();

    assert!(get_checkpoint(cwd, "main").is_none());
}
