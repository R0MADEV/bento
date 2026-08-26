//! Las ramas del repositorio: cuál es la principal, cuáles hay en los remotos y
//! cuáles se pueden revisar. Sin UI: lo usan el panel, el daemon y el CLI.

use crate::vcs::{git_cmd, is_safe_branch};

/// Si el directorio es un repositorio de git. Barato y sin efectos: es la
/// primera comprobación de casi todo lo demás.
pub fn is_git_repo(cwd: &str) -> bool {
    git_cmd(cwd, &["rev-parse", "--git-dir"]).is_ok()
}

/// La rama principal del repositorio. Primero `origin/HEAD`; si no lo hay
/// (clones sin remoto, remotos sin HEAD), se prueba `main` y se cae a `master`.
pub fn default_branch(cwd: &str) -> String {
    if let Ok(out) = git_cmd(cwd, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        let branch = out.trim().trim_start_matches("origin/").to_string();
        if !branch.is_empty() {
            return branch;
        }
    }
    if git_cmd(cwd, &["rev-parse", "--verify", "main"]).is_ok() {
        return "main".into();
    }
    "master".into()
}

/// Las ramas de `origin`, sin el prefijo. Es la lista para "¿de dónde sale esta
/// tarea?", donde el remoto se da por supuesto.
pub fn remote_branches(cwd: &str) -> Result<Vec<String>, String> {
    let raw = for_each_ref(cwd, "refs/remotes/origin")?;
    Ok(raw
        .lines()
        .filter_map(|line| line.strip_prefix("origin/"))
        .filter(|branch| *branch != "HEAD" && is_safe_branch(branch))
        .map(str::to_string)
        .collect())
}

/// Las ramas de todos los remotos, cualificadas (`daimoxd/feat/foo`), porque
/// con varios remotos el nombre pelado es ambiguo.
pub fn all_remote_branches(cwd: &str) -> Result<Vec<String>, String> {
    let raw = for_each_ref(cwd, "refs/remotes")?;
    Ok(raw
        .lines()
        .filter(|line| !line.ends_with("/HEAD") && is_safe_branch(line))
        .map(str::to_string)
        .collect())
}

/// Las ramas que se pueden revisar: primero las locales (las tareas), después
/// las remotas cualificadas tipo `origin/main`.
pub fn review_branches(cwd: &str) -> Result<Vec<String>, String> {
    let local = for_each_ref(cwd, "refs/heads")?;
    let remote = for_each_ref(cwd, "refs/remotes")?;
    Ok(parse_review_branches(&local, &remote))
}

fn for_each_ref(cwd: &str, refs: &str) -> Result<String, String> {
    if !is_git_repo(cwd) {
        return Err("not a git repository".into());
    }
    git_cmd(cwd, &["for-each-ref", "--format=%(refname:short)", refs])
}

fn parse_review_branches(local: &str, remote: &str) -> Vec<String> {
    let mut branches = Vec::new();
    for branch in local.lines().chain(remote.lines()) {
        let branch = branch.trim();
        let unusable = branch.is_empty()
            || branch == "HEAD"
            || branch.ends_with("/HEAD")
            || !is_safe_branch(branch);
        if unusable || branches.iter().any(|existing| existing == branch) {
            continue;
        }
        branches.push(branch.to_string());
    }
    branches
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_branches_include_local_tasks_and_qualified_remotes() {
        let branches = parse_review_branches(
            "main\nfeat/NIXON-501\n",
            "origin/HEAD\norigin/main\nupstream/release\n",
        );
        assert_eq!(branches, vec![
            "main",
            "feat/NIXON-501",
            "origin/main",
            "upstream/release",
        ]);
    }

    #[test]
    fn review_branches_drop_duplicates_and_unsafe_names() {
        let branches = parse_review_branches("main\nmain\n--force\n", "origin/main\n");
        assert_eq!(branches, vec!["main", "origin/main"]);
    }
}
