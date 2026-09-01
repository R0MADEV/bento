//! A review saved by a client that can't run git — the phone's browser, the
//! CLI over the socket — still has to remember which branch and which commit
//! it was made against. Its own test binary because it moves `HOME`.

use std::sync::OnceLock;

use bento_review::checkpoints::{get_checkpoint, save_checkpoint, Checkpoint};
// `test_support` is gated behind `cfg(test)` on the lib, so a test binary
// builds its own throwaway repos.
fn git(path: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {:?}: {}", args, String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn home() -> &'static std::path::PathBuf {
    static HOME: OnceLock<std::path::PathBuf> = OnceLock::new();
    HOME.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("bento-stamped-home-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("HOME", &dir);
        dir
    })
}

fn repo_with_a_commit(name: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("bento-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    git(&path, &["init", "-q"]);
    git(&path, &["config", "user.email", "bento-tests@example.com"]);
    git(&path, &["config", "user.name", "Bento Tests"]);
    std::fs::write(path.join("a.txt"), "uno").unwrap();
    git(&path, &["add", "."]);
    git(&path, &["commit", "-qm", "uno"]);
    path
}

fn checkpoint(cwd: &str) -> Checkpoint {
    Checkpoint {
        cwd: cwd.into(),
        base: "main".into(),
        content: "informe".into(),
        saved_at: "2026-09-01T10:00:00Z".into(),
        run_id: Some("run-1".into()),
        branch: None,
        commit: None,
        session_id: None,
        session_agent: None,
    }
}

#[test]
fn a_checkpoint_saved_without_metadata_gets_the_branch_and_sha_of_its_repo() {
    let _ = home();
    let repo = repo_with_a_commit("stamped-save");
    let cwd = repo.to_string_lossy().to_string();
    git(&repo, &["checkout", "-qb", "feat/desde-el-movil"]);

    save_checkpoint(&checkpoint(&cwd)).expect("guardar");

    let saved = get_checkpoint(&cwd, "main").expect("la review guardada");
    assert_eq!(saved.branch.as_deref(), Some("feat/desde-el-movil"));
    assert_eq!(
        saved.commit,
        Some(git(&repo, &["rev-parse", "HEAD"]).trim().to_string())
    );
}

#[test]
fn what_the_client_already_knew_is_not_overwritten() {
    let _ = home();
    let repo = repo_with_a_commit("stamped-keep");
    let cwd = repo.to_string_lossy().to_string();

    let mut cp = checkpoint(&cwd);
    cp.branch = Some("feat/lo-que-revisó".into());
    cp.commit = Some("0123456789abcdef0123456789abcdef01234567".into());
    save_checkpoint(&cp).expect("guardar");

    let saved = get_checkpoint(&cwd, "main").expect("la review guardada");
    assert_eq!(saved.branch.as_deref(), Some("feat/lo-que-revisó"));
    assert_eq!(
        saved.commit.as_deref(),
        Some("0123456789abcdef0123456789abcdef01234567")
    );
}
