//! Each analysis written to its own Markdown file, for the final verifier to
//! read whole.
//!
//! Handing the verifier the text inline meant truncating every analysis to fit
//! one prompt, so it judged on cut-off material. As files it reads all of it,
//! and can go back over any part with its own tools.
//!
//! They live in a temporary directory, never inside the repository: an
//! untracked `.md` appearing mid-review is exactly what `snapshot` reports as
//! "the repo changed", and the review would accuse itself.

use std::path::{Path, PathBuf};

/// Where one run's analyses are kept. Dropping it removes them.
pub struct ReportDir {
    dir: PathBuf,
}

impl ReportDir {
    /// Creates the directory for this run. `id` only has to be unique among
    /// concurrent runs.
    pub fn new(id: &str) -> std::io::Result<Self> {
        let dir = std::env::temp_dir().join(format!("bento-review-{id}"));
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    /// Writes one analysis and returns its path. The label is used for the
    /// file name so the verifier can tell whose analysis it is opening.
    pub fn write(&self, index: usize, label: &str, report: &str) -> std::io::Result<PathBuf> {
        let path = self.dir.join(format!("analisis-{index}-{}.md", slug(label)));
        std::fs::write(&path, report)?;
        Ok(path)
    }

    pub fn path(&self) -> &Path {
        &self.dir
    }
}

impl Drop for ReportDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A label like "Agente 1/3 (opencode)" is not a file name. Kept readable
/// rather than hashed, because the verifier is told to open these by name.
fn slug(label: &str) -> String {
    let cleaned: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches('-').to_string();
    let mut out = String::with_capacity(trimmed.len());
    let mut last_dash = false;
    for c in trimmed.chars() {
        if c == '-' && last_dash {
            continue;
        }
        last_dash = c == '-';
        out.push(c);
    }
    out.chars().take(40).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_analysis_is_written_whole_and_can_be_read_back() {
        let dir = ReportDir::new("test-entero").unwrap();
        // Longer than the old 8_000-character budget: the point of files is
        // that nothing is cut.
        let long = "hallazgo\n".repeat(5_000);

        let path = dir.write(1, "Agente 1/3 (opencode)", &long).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), long);
    }

    #[test]
    fn the_file_name_says_whose_analysis_it_is() {
        let dir = ReportDir::new("test-nombre").unwrap();
        let path = dir.write(2, "Agente 2/3 (codex)", "x").unwrap();

        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("analisis-2-"), "{name}");
        assert!(name.contains("codex"), "{name}");
        assert!(name.ends_with(".md"), "{name}");
    }

    #[test]
    fn the_reports_never_land_inside_the_repository() {
        // An untracked file appearing in the repo is what `snapshot` reports
        // as a mid-review change; the review would flag its own scratch files.
        let dir = ReportDir::new("test-fuera").unwrap();
        assert!(dir.path().starts_with(std::env::temp_dir()));
    }

    #[test]
    fn dropping_the_run_takes_its_files_with_it() {
        let path = {
            let dir = ReportDir::new("test-limpieza").unwrap();
            dir.write(1, "uno", "x").unwrap();
            dir.path().to_path_buf()
        };
        assert!(!path.exists(), "los ficheros de una review terminada no se quedan por ahí");
    }

    #[test]
    fn two_runs_do_not_share_a_directory() {
        let a = ReportDir::new("test-uno").unwrap();
        let b = ReportDir::new("test-dos").unwrap();
        assert_ne!(a.path(), b.path());
    }
}
