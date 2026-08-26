#![cfg(test)]

use std::path::{Path, PathBuf};
use std::process::Command;

pub(crate) fn temporary_directory(name: &str) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "bento-docker-{name}-{}-{nonce}",
        std::process::id()
    ))
}

pub(crate) const SAMPLE: &str = "name: nixon_devcontainer
services:
  app:
    volumes:
      - ..:/workspace:cached
    networks:
      nixon-network:
        ipv4_address: 10.189.20.10
  typesense:
    ports:
      - \"8108:8108\"
    networks:
      nixon-network:
        ipv4_address: 10.189.20.6
networks:
  nixon-network:
    ipam:
      config:
        - subnet: 10.189.20.0/24
";

// A generic devcontainer compose with NO custom subnet, but a fixed
// container_name and a published port — both must still be isolated.
pub(crate) const SAMPLE_NO_SUBNET: &str = "services:
  web:
    image: nginx
    container_name: web
    ports:
      - \"3000:3000\"
";

pub(crate) fn init_test_git_repo(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "bento@example.test"],
        vec!["config", "user.name", "Bento Test"],
    ] {
        assert!(Command::new("git").args(args).current_dir(path).status().unwrap().success());
    }
}
