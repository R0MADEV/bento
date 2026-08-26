//! Repos de verdad para los tests que tocan git: crearlos, commitear en ellos
//! y borrarlos al salir. Vino del lado de la app cuando su lógica se movió aquí.


use std::path::{Path, PathBuf};
use std::process::Command;
use std::fs;

pub struct TestRepo(pub PathBuf);

impl Drop for TestRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn repo(name: &str) -> TestRepo {
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

pub fn run(path: &Path, args: &[&str]) -> String {
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

pub fn commit_file(path: &Path, content: &str, message: &str) {
    fs::write(path.join("file.txt"), content).unwrap();
    run(path, &["add", "file.txt"]);
    run(path, &["commit", "-qm", message]);
}
