//! Where per-project state is filed on disk. One naming scheme for every
//! store under `~/.bento`, so a project+ref pair always lands on the same
//! file no matter who writes it.

use std::path::PathBuf;

/// Stable FNV-1a 64-bit — no extra dependency for what is just a filename.
pub fn fnv1a(s: &str) -> String {
    let mut h: u64 = 14695981039346656037;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    format!("{:016x}", h)
}

/// `~/.bento/<name>`, the directory a store lives in.
pub fn store_dir(name: &str) -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".bento").join(name))
}

/// The file holding the state for `(cwd, reference)` inside `dir`.
pub fn entry_path(dir: &std::path::Path, cwd: &str, reference: &str) -> PathBuf {
    dir.join(format!("{}.json", fnv1a(&format!("{cwd}:{reference}"))))
}
