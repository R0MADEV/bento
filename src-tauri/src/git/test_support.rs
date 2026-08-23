#![cfg(test)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::fs;

pub(crate) struct TestRepo(pub(crate) PathBuf);

impl Drop for TestRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn repo(name: &str) -> TestRepo {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path =
        std::env::temp_dir().join(format!("bento-{name}-{}-{stamp}", std::process::id()));
    fs::create_dir_all(&path).unwrap();
    run(&path, &["init", "-q"]);
    run(&path, &["config", "user.email", "bento-tests@example.com"]);
    run(&path, &["config", "user.name", "Bento Tests"]);
    TestRepo(path)
}

pub(crate) fn run(path: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).to_string()
}

pub(crate) fn commit_file(path: &Path, content: &str, message: &str) {
    fs::write(path.join("file.txt"), content).unwrap();
    run(path, &["add", "file.txt"]);
    run(path, &["commit", "-qm", message]);
}
