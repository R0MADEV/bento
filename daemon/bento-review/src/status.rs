//! El estado del worktree: qué hay pendiente, el diff completo (incluidos los
//! ficheros sin trackear) y el informe previo a reescribir el historial. Sin
//! UI: lo usan el panel, el daemon y el CLI.

use serde::Serialize;

use crate::branches::is_git_repo;
use crate::vcs::{current_branch, diff_no_index, git_cmd, is_safe_branch, resolve_git_dir, untracked_files};

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../src/generated/bindings/"))]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// El porcelain crudo: el panel lo usa para pintar la lista de ficheros.
    pub raw: String,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub total: u32,
}

/// El recuento lo hace `tasks::parse_status`; aquí solo se le añade el
/// porcelain crudo.
pub fn parse_status(raw: String) -> GitStatus {
    let counts = crate::tasks::parse_status(&raw);
    GitStatus {
        raw,
        staged: counts.staged,
        unstaged: counts.unstaged,
        untracked: counts.untracked,
        total: counts.total,
    }
}

pub fn status(cwd: &str) -> Result<GitStatus, String> {
    git_cmd(cwd, &["status", "--porcelain"]).map(parse_status)
}

/// Los ficheros sin trackear no salen en `git diff`, pero para revisar sí
/// cuentan: se añaden uno a uno como diff contra /dev/null.
fn append_untracked_diffs(cwd: &str, combined: &mut String) {
    for file in untracked_files(cwd) {
        combined.push_str(&diff_no_index(cwd, &file));
    }
}

/// Todo lo que hay sin commitear, ficheros nuevos incluidos.
pub fn worktree_diff(cwd: &str) -> Result<String, String> {
    let mut combined = git_cmd(cwd, &["diff", "--no-ext-diff", "HEAD"])?;
    append_untracked_diffs(cwd, &mut combined);
    Ok(combined)
}

/// El diff acumulado de la rama contra `base` (rango de tres puntos).
pub fn branch_diff(cwd: &str, base: &str) -> Result<String, String> {
    if !is_safe_branch(base) {
        return Err(format!("unsafe base branch: {base}"));
    }
    if !is_git_repo(cwd) {
        return Err("not a git repository".into());
    }
    // Primero la ref local; si no existe, la de origin. Se conserva el error
    // original para no tragarse un fallo pasajero.
    git_cmd(cwd, &["diff", &format!("{base}...HEAD")]).or_else(|first_error| {
        git_cmd(cwd, &["diff", &format!("origin/{base}...HEAD")]).map_err(|_| first_error)
    })
}

/// Desde `base` hasta el worktree tal cual está: commiteado, en el índice, sin
/// stagear y sin trackear.
pub fn review_worktree_diff(cwd: &str, base: &str) -> Result<String, String> {
    if !is_git_repo(cwd) {
        return Err("not a git repository".into());
    }
    if !is_safe_branch(base) {
        return Err(format!("unsafe base: {base}"));
    }
    let mut combined = git_cmd(cwd, &["diff", "--no-ext-diff", base, "--"])?;
    append_untracked_diffs(cwd, &mut combined);
    Ok(combined)
}

/// Los códigos de `git status --porcelain` en los que las dos partes tocaron el
/// fichero: eso es un conflicto sin resolver.
const CONFLICT_CODES: [&str; 7] = ["UU", "AA", "DD", "AU", "UA", "DU", "UD"];

/// Los ficheros en conflicto de un porcelain ya leído.
pub fn parse_conflicted(porcelain: &str) -> Vec<String> {
    porcelain
        .lines()
        .filter(|line| line.len() >= 2 && CONFLICT_CODES.contains(&&line[..2]))
        .map(|line| line[2..].trim().to_string())
        .collect()
}

/// Los ficheros que quedaron en conflicto en el worktree.
pub fn conflicted_files(cwd: &str) -> Result<Vec<String>, String> {
    git_cmd(cwd, &["status", "--porcelain"]).map(|raw| parse_conflicted(&raw))
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../src/generated/bindings/"))]
#[serde(rename_all = "camelCase")]
pub struct RewritePreflight {
    pub branch: String,
    pub base: String,
    pub dirty: bool,
    pub operation: String,
    pub upstream: String,
    pub published_commits: u32,
    pub protected_base: bool,
    pub signing: bool,
    pub hooks: Vec<String>,
}

/// Informe de solo lectura antes de reescribir el historial de una tarea, para
/// poder avisar de cada riesgo antes de que git empiece, no después.
pub fn rewrite_preflight(cwd: &str, base: &str) -> Result<RewritePreflight, String> {
    if !is_safe_branch(base) {
        return Err(format!("unsafe base branch: {base}"));
    }
    let branch = current_branch(cwd)?;
    let dirty = !git_cmd(cwd, &["status", "--porcelain"])?.trim().is_empty();
    let git_dir = resolve_git_dir(cwd);
    let operation = if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists()
    {
        "rebase"
    } else if git_dir.join("MERGE_HEAD").exists() {
        "merge"
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        "cherry-pick"
    } else if git_dir.join("REVERT_HEAD").exists() {
        "revert"
    } else {
        ""
    };
    let upstream = git_cmd(cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let published_commits = if upstream.is_empty() {
        0
    } else {
        git_cmd(cwd, &["rev-list", "--count", &format!("origin/{base}..@{{u}}")])
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
            .unwrap_or(0)
    };
    let hooks = ["pre-rebase", "pre-commit", "commit-msg"]
        .iter()
        .filter(|name| git_dir.join("hooks").join(name).exists())
        .map(|name| name.to_string())
        .collect::<Vec<_>>();
    let signing = git_cmd(cwd, &["config", "--bool", "commit.gpgsign"])
        .map(|value| value.trim() == "true")
        .unwrap_or(false);
    let protected_base = branch == base || matches!(branch.as_str(), "main" | "master");
    Ok(RewritePreflight {
        branch,
        base: base.to_string(),
        dirty,
        operation: operation.into(),
        upstream,
        published_commits,
        protected_base,
        signing,
        hooks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::*;
    use std::fs;

    #[test]
    fn review_worktree_diff_includes_committed_uncommitted_and_untracked_changes() {
        let repo = repo("review-worktree-diff");
        commit_file(&repo.0, "base\n", "base");
        let base = run(&repo.0, &["branch", "--show-current"]).trim().to_string();
        run(&repo.0, &["checkout", "-qb", "feat/task"]);
        commit_file(&repo.0, "committed\n", "task commit");
        fs::write(repo.0.join("file.txt"), "working\n").unwrap();
        fs::write(repo.0.join("new.txt"), "untracked\n").unwrap();

        let diff = review_worktree_diff(repo.0.to_str().unwrap(), &base).unwrap();
        assert!(diff.contains("diff --git a/file.txt b/file.txt"), "{diff}");
        assert!(diff.contains("+working"), "{diff}");
        assert!(diff.contains("diff --git a/new.txt b/new.txt"), "{diff}");
        assert!(diff.contains("+untracked"), "{diff}");
    }

    #[test]
    fn worktree_diff_includes_untracked_files_without_staging_them() {
        let repo = repo("untracked");
        commit_file(&repo.0, "base\n", "base");
        fs::write(repo.0.join("new.txt"), "new content\n").unwrap();
        let diff = worktree_diff(repo.0.to_str().unwrap()).unwrap();
        assert!(diff.contains("diff --git a/new.txt b/new.txt"), "{diff}");
        assert!(diff.contains("+new content"), "{diff}");
        assert_eq!(run(&repo.0, &["status", "--short"]).trim(), "?? new.txt");
    }

    #[test]
    fn a_base_that_is_not_a_branch_name_is_refused() {
        let repo = repo("unsafe-base");
        commit_file(&repo.0, "base\n", "base");
        let cwd = repo.0.to_str().unwrap();
        assert!(branch_diff(cwd, "main; rm -rf /").is_err());
        assert!(review_worktree_diff(cwd, "../evil").is_err());
        assert!(rewrite_preflight(cwd, "--upload-pack=evil").is_err());
    }

    #[test]
    fn rewrite_preflight_reports_dirty_published_signing_and_hooks() {
        let repo = repo("preflight");
        commit_file(&repo.0, "root\n", "root");
        run(&repo.0, &["branch", "-M", "main"]);
        run(&repo.0, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        run(&repo.0, &["checkout", "-qb", "task"]);
        commit_file(&repo.0, "task\n", "task commit");
        run(&repo.0, &["branch", "published", "HEAD"]);
        run(&repo.0, &["branch", "--set-upstream-to=published"]);
        run(&repo.0, &["config", "commit.gpgsign", "true"]);
        let hooks = resolve_git_dir(repo.0.to_str().unwrap()).join("hooks");
        fs::write(hooks.join("pre-rebase"), "#!/bin/sh\n").unwrap();
        fs::write(repo.0.join("dirty.txt"), "dirty\n").unwrap();

        let report = rewrite_preflight(repo.0.to_str().unwrap(), "main").unwrap();
        assert!(report.dirty);
        assert_eq!(report.published_commits, 1);
        assert!(report.signing);
        assert!(report.hooks.contains(&"pre-rebase".to_string()));
    }

    #[test]
    fn every_unmerged_porcelain_code_counts_as_a_conflict() {
        let porcelain = "UU both.txt\nAA added.txt\nDD deleted.txt\nAU a.txt\nUA b.txt\nDU c.txt\nUD d.txt\n M limpio.txt\n?? nuevo.txt\n";
        assert_eq!(
            parse_conflicted(porcelain),
            vec!["both.txt", "added.txt", "deleted.txt", "a.txt", "b.txt", "c.txt", "d.txt"]
        );
        assert!(parse_conflicted(" M solo-modificado.txt\n").is_empty());
        assert!(parse_conflicted("").is_empty());
    }

    #[test]
    fn parses_typed_status_counts_and_preserves_porcelain() {
        let raw = " M a.txt\nM  b.txt\nMM c.txt\n?? d.txt\n".to_string();
        let status = parse_status(raw.clone());
        assert_eq!(status.raw, raw);
        assert_eq!(
            (status.staged, status.unstaged, status.untracked, status.total),
            (2, 2, 1, 4)
        );
    }
}
