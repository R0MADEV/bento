use std::fs;
use std::path::{Path, PathBuf};

pub fn existing_worktree_file(worktree: &str, relative: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute() {
        return Err("file path must be relative to the worktree".into());
    }

    let root = fs::canonicalize(worktree).map_err(|error| error.to_string())?;
    let candidate =
        fs::canonicalize(root.join(relative_path)).map_err(|error| error.to_string())?;
    if !candidate.starts_with(&root) {
        return Err("file path escapes the worktree".into());
    }
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, PathBuf) {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("bento-safe-path-{}-{nonce}", std::process::id()));
        let outside = root.with_extension("outside");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("inside.txt"), "inside").unwrap();
        fs::write(&outside, "outside").unwrap();
        (root, outside)
    }

    #[test]
    fn accepts_an_existing_file_inside_the_worktree() {
        let (root, outside) = fixture();
        let resolved = existing_worktree_file(root.to_str().unwrap(), "inside.txt").unwrap();
        assert_eq!(resolved, fs::canonicalize(root.join("inside.txt")).unwrap());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(outside);
    }

    #[test]
    fn rejects_parent_traversal_and_absolute_paths() {
        let (root, outside) = fixture();
        let parent_escape = format!("../{}", outside.file_name().unwrap().to_string_lossy());
        assert!(existing_worktree_file(root.to_str().unwrap(), &parent_escape).is_err());
        assert!(existing_worktree_file(root.to_str().unwrap(), outside.to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(outside);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_that_points_outside_the_worktree() {
        use std::os::unix::fs::symlink;

        let (root, outside) = fixture();
        symlink(&outside, root.join("link.txt")).unwrap();
        assert!(existing_worktree_file(root.to_str().unwrap(), "link.txt").is_err());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(outside);
    }
}
