//! El historial: commits de una rama, su grafo, los ficheros que tocó cada uno
//! y sus diffs. Sin UI: lo usan el panel, el daemon y el CLI.

use serde::Serialize;

use crate::branches::is_git_repo;
use crate::vcs::{git_cmd, is_safe_branch};

const LOG_FORMAT: &str = "--format=%H\x1f%h\x1f%s\x1f%ad\x1f%an";

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../src/generated/bindings/"))]
#[serde(rename_all = "camelCase")]
pub struct CommitEntry {
    pub hash: String,
    pub short: String,
    pub subject: String,
    pub date: String,
    pub author: String,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../src/generated/bindings/"))]
pub struct CommitFile {
    pub status: String,
    pub paths: Vec<String>,
}

fn parse_commit_log(raw: String) -> Vec<CommitEntry> {
    raw.lines()
        .filter_map(|line| {
            let mut fields = line.split('\x1f');
            Some(CommitEntry {
                hash: fields.next()?.to_string(),
                short: fields.next().unwrap_or_default().to_string(),
                subject: fields.next().unwrap_or_default().to_string(),
                date: fields.next().unwrap_or_default().to_string(),
                author: fields.next().unwrap_or_default().to_string(),
            })
        })
        .collect()
}

/// Los últimos commits de la rama actual. El límite se acota: la lista es para
/// mirarla, no para volcar el repositorio entero.
pub fn log(cwd: &str, limit: u32, no_merges: bool) -> Result<Vec<CommitEntry>, String> {
    let count = format!("-{}", limit.clamp(1, 200));
    let mut args = vec!["log", &count, LOG_FORMAT, "--date=relative"];
    if no_merges {
        args.push("--no-merges");
    }
    git_cmd(cwd, &args).map(parse_commit_log)
}

/// El grafo de la rama contra su base, tal cual lo pinta git.
pub fn graph(cwd: &str, base: &str) -> Result<String, String> {
    let base_ref = safe_origin_ref(base)?;
    git_cmd(cwd, &[
        "log", "--graph", "--decorate", "--oneline", "--date-order", "--boundary",
        "-100", &base_ref, "HEAD",
    ])
}

/// Los commits propios de la tarea, sin merges y del más viejo al más nuevo:
/// el mismo orden que usa `git rebase -i origin/<base>`.
pub fn rebase_log(cwd: &str, base: &str) -> Result<Vec<CommitEntry>, String> {
    let range = format!("{}..HEAD", safe_origin_ref(base)?);
    git_cmd(cwd, &["log", "--reverse", "--no-merges", LOG_FORMAT, "--date=relative", &range])
        .map(parse_commit_log)
}

/// Los merges que la rama ha traído desde su base.
pub fn merge_log(cwd: &str, base: &str) -> Result<Vec<CommitEntry>, String> {
    let range = format!("{}..HEAD", safe_origin_ref(base)?);
    git_cmd(cwd, &["log", "--reverse", "--merges", LOG_FORMAT, "--date=relative", &range])
        .map(parse_commit_log)
}

/// El diff entre dos referencias cualesquiera (`origin/main` vs `origin/feat/x`).
pub fn ref_diff(cwd: &str, base: &str, target: &str) -> Result<String, String> {
    if !is_safe_branch(base) {
        return Err(format!("unsafe base: {base}"));
    }
    if !is_safe_branch(target) {
        return Err(format!("unsafe target: {target}"));
    }
    if !is_git_repo(cwd) {
        return Err("not a git repository".into());
    }
    diff_between_refs(cwd, base, target)
}

/// El SHA completo de una referencia.
pub fn rev_parse(cwd: &str, reference: &str) -> Result<String, String> {
    // Una referencia que empieza por `-` es una opción de git disfrazada.
    if reference.starts_with('-') {
        return Err(format!("invalid git reference: {reference}"));
    }
    if !is_git_repo(cwd) {
        return Err("not a git repository".into());
    }
    git_cmd(cwd, &["rev-parse", reference]).map(|out| out.trim().to_string())
}

/// Los ficheros que tocó un commit, con su estado (M, A, D, R…).
pub fn show_files(cwd: &str, hash: &str) -> Result<Vec<CommitFile>, String> {
    git_cmd(cwd, &["diff-tree", "--no-commit-id", "-r", "--name-status", hash]).map(|raw| {
        raw.lines()
            .filter_map(|line| {
                let mut fields = line.split('\t');
                let status = fields.next()?.to_string();
                let paths = fields.map(str::to_string).collect::<Vec<_>>();
                if paths.is_empty() {
                    return None;
                }
                Some(CommitFile { status, paths })
            })
            .collect()
    })
}

/// El parche que introdujo un commit, opcionalmente de un solo fichero.
pub fn show_commit_diff(cwd: &str, hash: &str, file: Option<&str>) -> Result<String, String> {
    let mut args = vec!["show", "--format=", "--find-renames", "--no-ext-diff", hash, "--"];
    if let Some(path) = file {
        args.push(path);
    }
    git_cmd(cwd, &args)
}

/// El contenido de un fichero en un commit. Si allí no existe se prueba en su
/// primer padre: un fichero borrado solo existe antes del commit que lo borra.
pub fn show_file(cwd: &str, hash: &str, file: &str) -> Result<String, String> {
    if hash.len() < 7 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid commit hash".into());
    }
    match git_cmd(cwd, &["show", &format!("{hash}:{file}")]) {
        Ok(content) => Ok(content),
        Err(_) => git_cmd(cwd, &["show", &format!("{hash}^:{file}")]),
    }
}

fn safe_origin_ref(base: &str) -> Result<String, String> {
    if !is_safe_branch(base) {
        return Err(format!("unsafe base branch: {base}"));
    }
    Ok(format!("origin/{base}"))
}

/// Resuelve una referencia a un commit, probando rama local, remota y el nombre
/// tal cual. Si no aparece se hace un fetch y se reintenta: en un worktree
/// recién creado la remota puede no estar todavía.
pub fn resolve_commit_reference(cwd: &str, reference: &str) -> Result<String, String> {
    if !is_safe_branch(reference) {
        return Err(format!("unsafe reference: {reference}"));
    }
    if let Some(commit) = try_resolve(cwd, reference) {
        return Ok(commit);
    }
    let _ = git_cmd(cwd, &["fetch", "--all", "--prune"]);
    try_resolve(cwd, reference).ok_or_else(|| format!("unknown reference: {reference}"))
}

fn try_resolve(cwd: &str, reference: &str) -> Option<String> {
    let candidates = [
        format!("refs/heads/{reference}"),
        format!("refs/remotes/{reference}"),
        reference.to_string(),
    ];
    for candidate in candidates {
        let spec = format!("{candidate}^{{commit}}");
        if let Ok(value) = git_cmd(cwd, &["rev-parse", "--verify", &spec]) {
            return Some(value.trim().to_string());
        }
    }
    None
}

/// El diff entre dos referencias, resolviéndolas antes a commits para que un
/// `origin/x` que también existe como rama local no sea ambiguo.
pub fn diff_between_refs(cwd: &str, base: &str, target: &str) -> Result<String, String> {
    let base_commit = resolve_commit_reference(cwd, base)?;
    let target_commit = resolve_commit_reference(cwd, target)?;
    git_cmd(cwd, &["diff", &format!("{base_commit}...{target_commit}")])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::*;

    #[test]
    fn parses_typed_commit_log() {
        let commits = parse_commit_log("abcdef\x1fabc\x1fSubject\x1fnow\x1fAda\n".into());
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].hash, "abcdef");
        assert_eq!(commits[0].subject, "Subject");
        assert_eq!(commits[0].author, "Ada");
    }

    #[test]
    fn a_reference_that_looks_like_a_flag_is_refused() {
        assert!(rev_parse(".", "--upload-pack=touch /tmp/pwned").is_err());
        assert!(ref_diff(".", "--force", "main").is_err());
    }

    #[test]
    fn diff_between_refs_resolves_commit_ids_before_diffing() {
        let repository = repo("ref-diff");
        commit_file(&repository.0, "base\n", "base");
        run(&repository.0, &["branch", "origin/base"]);
        run(&repository.0, &["checkout", "-qb", "origin/feature"]);
        commit_file(&repository.0, "feature\n", "feature");

        let diff = diff_between_refs(repository.0.to_str().unwrap(), "origin/base", "origin/feature").unwrap();
        assert!(diff.contains("diff --git a/file.txt b/file.txt"), "{diff}");
        assert!(diff.contains("+feature"), "{diff}");
    }
}
