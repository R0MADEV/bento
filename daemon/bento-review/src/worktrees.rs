//! Los worktrees de un repo: dónde están, en qué rama y sobre qué commit.
//! Es lo que el panel de tareas llama "tareas", y lo que hace falta para poder
//! preguntar desde el móvil "¿en qué anda cada rama?".

use serde::Serialize;

use crate::vcs::git_cmd;

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../src/generated/bindings/"))]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub bare: bool,
}


pub fn parse_worktrees(raw: &str) -> Vec<WorktreeInfo> {
    // Git for Windows may emit CRLF even when stdout is captured through a
    // pipe. Normalize record separators before splitting porcelain blocks.
    raw.replace("\r\n", "\n")
        .trim()
        .split("\n\n")
        .filter_map(|block| {
            let mut path = None;
            let mut head = None;
            let mut branch = None;
            let mut bare = false;
            for line in block.lines() {
                if let Some(value) = line.strip_prefix("worktree ") {
                    path = Some(value.to_string());
                }
                if let Some(value) = line.strip_prefix("HEAD ") {
                    head = Some(value.to_string());
                }
                if let Some(value) = line.strip_prefix("branch refs/heads/") {
                    branch = Some(value.to_string());
                }
                if line == "bare" {
                    bare = true;
                }
            }
            if bare {
                return None;
            }
            Some(WorktreeInfo {
                path: path?,
                head: head?,
                branch,
                bare,
            })
        })
        .collect()
}

/// Los worktrees de `cwd`, limpiando antes las referencias muertas (carpetas
/// borradas a mano sin `git worktree remove`).
pub fn list(cwd: &str) -> Vec<WorktreeInfo> {
    let _ = git_cmd(cwd, &["worktree", "prune"]);
    git_cmd(cwd, &["worktree", "list", "--porcelain"])
        .map(|raw| parse_worktrees(&raw))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PORCELAIN: &str = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo/tarea\nHEAD def456\nbranch refs/heads/feat/x\n\n";

    #[test]
    fn reads_each_worktree_with_its_branch() {
        let list = parse_worktrees(PORCELAIN);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[1].path, "/repo/tarea");
        assert_eq!(list[1].branch.as_deref(), Some("feat/x"));
    }

    #[test]
    fn a_detached_worktree_has_no_branch() {
        let list = parse_worktrees("worktree /repo\nHEAD abc123\ndetached\n\n");
        assert!(list[0].branch.is_none());
    }

    #[test]
    fn a_bare_repo_entry_is_not_a_worktree() {
        let raw = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /bare\nHEAD def456\nbare\n";
        let list = parse_worktrees(raw);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].path, "/repo");
        assert!(!list[0].bare);
    }

    #[test]
    fn windows_crlf_records_parse_too() {
        // Git for Windows escribe CRLF aunque la salida vaya por una tubería,
        // y una ruta puede llevar espacios.
        let raw = "worktree C:\\repo\r\nHEAD abc123\r\nbranch refs/heads/main\r\n\r\nworktree C:\\repo task\r\nHEAD def456\r\nbranch refs/heads/task/e2e\r\n";
        let list = parse_worktrees(raw);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].path, "C:\\repo");
        assert_eq!(list[1].path, "C:\\repo task");
        assert_eq!(list[1].branch.as_deref(), Some("task/e2e"));
    }

    #[test]
    fn empty_output_is_no_worktrees() {
        assert!(parse_worktrees("").is_empty());
    }
}
