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

/// La rama de git que hay que comparar para ver un PR. La del PR es la de
/// quien lo abrió y en tu copia normalmente no existe: lo que sí está es su
/// remota. Pedir el diff contra el nombre a secas no devuelve ningún fichero,
/// y un PR con sesenta y seis se ve vacío.
pub fn branch_for(branches: &[String], head_ref: &str) -> String {
    let remote = format!("origin/{head_ref}");
    branches
        .iter()
        .find(|b| *b == head_ref || b.ends_with(&format!("/{head_ref}")))
        .cloned()
        .unwrap_or(remote)
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

    #[test]
    fn a_prs_branch_resolves_to_the_remote_one_that_git_has() {
        // La rama de un PR es la de quien lo abrió: en tu copia no existe,
        // sólo su remota. Pedir el diff contra el nombre a secas no devuelve
        // ningún fichero, que es como se ve un PR vacío sin serlo.
        let branches = vec![
            "main".to_string(),
            "origin/main".to_string(),
            "origin/DEITU-1450-rebranding-dashboard".to_string(),
        ];

        assert_eq!(
            super::branch_for(&branches, "DEITU-1450-rebranding-dashboard"),
            "origin/DEITU-1450-rebranding-dashboard",
        );
    }

    #[test]
    fn a_branch_you_do_have_locally_is_used_as_is() {
        let branches = vec!["mi-rama".to_string(), "origin/mi-rama".to_string()];

        assert_eq!(super::branch_for(&branches, "mi-rama"), "mi-rama", "la local va primero");
    }

    #[test]
    fn without_the_branch_listed_it_falls_back_to_origin() {
        // Recién abierto el PR, un fetch viejo puede no tenerla todavía.
        assert_eq!(super::branch_for(&[], "nueva"), "origin/nueva");
    }

    #[test]
    fn a_branch_ending_the_same_is_not_the_same_branch() {
        // "origin/otra-mi-rama" acaba en "mi-rama" pero no es esa rama.
        let branches = vec!["origin/otra-mi-rama".to_string()];

        assert_eq!(super::branch_for(&branches, "mi-rama"), "origin/mi-rama");
    }
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
