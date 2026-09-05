//! The `git`/`gh` side of a review: validation of client-supplied refs and
//! paths, the changed-file list and the per-file/PR diffs. Written once here
//! because the desktop app, the daemon (phone remote) and the CLI all need
//! exactly these operations — including `is_safe_branch`, which used to exist
//! in both codebases, so a hardening fix in one never reached the other.

use std::process::Command;

use crate::gh_account;
use std::sync::OnceLock;

use serde_json::{json, Value};

use crate::diff::parse_diff_name_status;

/// macOS GUI apps don't inherit the shell PATH, so a Homebrew-installed
/// `git`/`gh` is invisible to a double-clicked app — resolve it through a
/// login shell once and cache it. On the daemon/CLI the first check hits.
fn resolve_bin(name: &'static str, cache: &'static OnceLock<Option<String>>) -> Option<String> {
    cache
        .get_or_init(|| {
            let on_path = Command::new(name)
                .arg("--version")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if on_path {
                return Some(name.to_string());
            }
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
            let out = Command::new(shell).arg("-lc").arg(format!("command -v {name}")).output().ok()?;
            if !out.status.success() {
                return None;
            }
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if path.is_empty() { None } else { Some(path) }
        })
        .clone()
}

pub fn git_bin() -> Result<String, String> {
    static GIT: OnceLock<Option<String>> = OnceLock::new();
    resolve_bin("git", &GIT).ok_or_else(|| "git not found".to_string())
}

fn gh_bin() -> Result<String, String> {
    static GH: OnceLock<Option<String>> = OnceLock::new();
    resolve_bin("gh", &GH).ok_or_else(|| "gh not found".to_string())
}

pub fn git_cmd(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(git_bin()?)
        .args([&["-C", cwd], args].concat())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Like `git_cmd` but accepts exit code 1 (`git diff --no-index` exits 1 when
/// the files differ, which is the normal case here).
pub fn git_cmd_exit1_ok(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(git_bin()?)
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.code().unwrap_or(2) <= 1 {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Corre `gh` en ese proyecto. Si el repositorio no lo ve la cuenta activa
/// —que en `gh` es una sola para toda la máquina, aunque git cambie con la
/// carpeta— prueba las demás cuentas que ya tiene guardadas y se queda con la
/// que sirva. Sin eso, en un repo de otra organización no hay PRs que revisar
/// hasta cambiar de cuenta a mano, y cambiarla afecta a todo lo demás.
pub fn gh_cmd(cwd: &str, args: &[&str]) -> Result<String, String> {
    let remembered = gh_account::remembered(cwd);
    let error = match run_gh(cwd, args, remembered.as_deref()) {
        Ok(out) => return Ok(out),
        Err(error) => error,
    };
    if !gh_account::is_not_visible(&error) {
        return Err(error);
    }
    with_another_account(cwd, args).ok_or(error)
}

/// Prueba las cuentas de `gh auth status` hasta que una vea el repositorio.
fn with_another_account(cwd: &str, args: &[&str]) -> Option<String> {
    let status = run_gh(cwd, &["auth", "status"], None).ok()?;
    for account in gh_account::accounts_in(&status) {
        let Ok(out) = run_gh(cwd, args, Some(&account)) else { continue };
        gh_account::remember(cwd, &account);
        return Some(out);
    }
    None
}

/// El token nunca se guarda: se le pide a `gh` para esa cuenta y viaja sólo en
/// el entorno del proceso hijo.
fn run_gh(cwd: &str, args: &[&str], account: Option<&str>) -> Result<String, String> {
    let mut command = Command::new(gh_bin()?);
    command.current_dir(cwd).args(args);
    if let Some(account) = account {
        let token = token_of(cwd, account)?;
        command.env("GH_TOKEN", token);
    }
    let out = command.output().map_err(|e| format!("gh not found: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn token_of(cwd: &str, account: &str) -> Result<String, String> {
    let out = Command::new(gh_bin()?)
        .current_dir(cwd)
        .args(["auth", "token", "--user", account])
        .output()
        .map_err(|e| format!("gh not found: {e}"))?;
    if !out.status.success() {
        return Err(format!("gh no da el token de {account}"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// A client-supplied git ref used as a `git diff` argument. Rejects
/// flag-injection and range syntax (`..`).
///
/// El guion inicial es la parte que importa: `--upload-pack=…` ya caía por el
/// `=`, pero `--force` o `-n` pasaban el filtro y git los lee como opciones,
/// no como el nombre de una rama.
pub fn is_safe_branch(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
}

/// A client-supplied file path used to read file contents off disk. Rejects
/// absolute paths and `..` segments so it can't escape `cwd`.
pub fn is_safe_relative_path(path: &str) -> bool {
    !path.is_empty() && !path.starts_with('/') && !path.split('/').any(|seg| seg == "..")
}

pub fn untracked_files(cwd: &str) -> Vec<String> {
    git_cmd(cwd, &["ls-files", "--others", "--exclude-standard"])
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

/// A whole-file diff for a path git doesn't track yet.
pub fn diff_no_index(cwd: &str, path: &str) -> String {
    git_cmd_exit1_ok(cwd, &["diff", "--no-index", "--", "/dev/null", path]).unwrap_or_default()
}

/// La rama actual, o un error si estás en detached HEAD: casi nada de lo que
/// hacemos (respaldar, rebasear, publicar) tiene sentido sin rama.
pub fn current_branch(cwd: &str) -> Result<String, String> {
    let branch = git_cmd(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    if branch.is_empty() || branch == "HEAD" || !is_safe_branch(&branch) {
        return Err("cannot operate on detached HEAD".into());
    }
    Ok(branch)
}

/// El directorio `.git` real. En un worktree `.git` es un fichero que apunta a
/// otro sitio, y ahí es donde git deja el estado de un rebase a medias.
pub fn resolve_git_dir(cwd: &str) -> std::path::PathBuf {
    let git_path = std::path::Path::new(cwd).join(".git");
    if git_path.is_file() {
        if let Ok(content) = std::fs::read_to_string(&git_path) {
            if let Some(gitdir) = content.trim().strip_prefix("gitdir: ") {
                return std::path::PathBuf::from(gitdir.trim());
            }
        }
    }
    git_path
}

/// The most recently committed-to branches, newest first.
pub fn list_branches(cwd: &str) -> Vec<String> {
    git_cmd(cwd, &["branch", "--sort=-committerdate", "--format=%(refname:short)"])
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .take(20)
        .map(String::from)
        .collect()
}

/// Pure merge of `git diff --name-status` entries with their `--numstat`
/// add/delete counts (matched by path — numstat can omit a path entirely,
/// e.g. for binary files, so entries default to 0/0), plus untracked files
/// appended as additions. Split out from `list_files` so the merge logic
/// itself is testable without shelling out to git.
pub fn build_file_list(name_status: &str, numstat: &str, untracked: &[String]) -> Vec<Value> {
    let stats: std::collections::HashMap<String, (i64, i64)> = numstat
        .lines()
        .filter_map(|l| {
            let mut p = l.splitn(3, '\t');
            let a: i64 = p.next()?.parse().unwrap_or(0);
            let d: i64 = p.next()?.parse().unwrap_or(0);
            Some((p.next()?.trim().to_string(), (a, d)))
        })
        .collect();

    let mut list: Vec<_> = parse_diff_name_status(name_status)
        .into_iter()
        .map(|e| {
            let (added, deleted) = stats.get(&e.path).copied().unwrap_or((0, 0));
            let mut v = json!({ "status": e.status, "path": e.path, "added": added, "deleted": deleted });
            if let Some(old) = e.old_path {
                v["old_path"] = json!(old);
            }
            v
        })
        .collect();

    for path in untracked {
        list.push(json!({ "status": "A", "path": path, "added": 0, "deleted": 0 }));
    }
    list
}

/// Every file changed against `base`, untracked files included. `base` is
/// validated here, not at the transport layer, so every caller gets the same
/// flag-injection protection regardless of how it arrived.
pub fn list_files(cwd: &str, base: &str) -> Result<Vec<Value>, String> {
    list_files_of(cwd, base, None)
}

/// Los ficheros que cambian respecto a `base`: los de `branch` si se nombra una,
/// y si no los del árbol de trabajo más lo que esté sin seguir.
///
/// Sin el `branch`, elegir una rama en un cliente enseñaba los cambios sin
/// commitear en vez de los de esa rama — que es lo que enseña el panel del
/// escritorio, y por eso las dos listas no coincidían nunca.
pub fn list_files_of(cwd: &str, base: &str, branch: Option<&str>) -> Result<Vec<Value>, String> {
    if !is_safe_branch(base) {
        return Err("unsafe base".into());
    }
    check_repo(cwd)?;
    let Some(branch) = branch else {
        let name_status = git_cmd(cwd, &["diff", "--name-status", base])?;
        let numstat = git_cmd(cwd, &["diff", "--numstat", base]).unwrap_or_default();
        return Ok(build_file_list(&name_status, &numstat, &untracked_files(cwd)));
    };
    if !is_safe_branch(branch) {
        return Err("rama inválida".into());
    }
    let range = format!("{base}...{branch}");
    let name_status = git_cmd(cwd, &["diff", "--name-status", &range])?;
    let numstat = git_cmd(cwd, &["diff", "--numstat", &range]).unwrap_or_default();
    Ok(build_file_list(&name_status, &numstat, &[]))
}

/// The whole change under review: a branch against `base` (committed work
/// only), or the working tree against `base` plus anything untracked — the
/// case where you review before committing, which is most of them.
/// Que la carpeta sea un repositorio, dicho en una frase. Sin esto git contesta
/// con su `warning: Not a git repository. Use --no-index…usage: git …`, que se
/// acaba pegando tal cual en el panel del cliente que preguntó.
pub fn check_repo(cwd: &str) -> Result<(), String> {
    match crate::branches::is_git_repo(cwd) {
        true => Ok(()),
        false => Err(format!("{cwd} no es un repositorio git")),
    }
}

pub fn review_diff(cwd: &str, base: &str, branch: Option<&str>) -> Result<String, String> {
    check_repo(cwd)?;
    if !is_safe_branch(base) {
        return Err("rama base inválida".into());
    }
    if let Some(branch) = branch {
        if !is_safe_branch(branch) {
            return Err("rama inválida".into());
        }
        // Tres puntos: lo que la rama añade desde que se separó, que es lo que
        // se revisa. Con dos, git enseña además todo lo que la base ganó por su
        // cuenta como si la rama lo hubiera borrado — una rama vieja salía con
        // seiscientos ficheros "eliminados". El panel del escritorio usa tres
        // desde siempre (`log::diff_between_refs`).
        return git_cmd(cwd, &["diff", &format!("{base}...{branch}")]);
    }
    let tracked = git_cmd(cwd, &["diff", base])?;
    let untracked = untracked_files(cwd)
        .iter()
        .map(|path| diff_no_index(cwd, path))
        .filter(|d| !d.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if untracked.is_empty() {
        return Ok(tracked);
    }
    Ok(format!("{tracked}\n{untracked}"))
}

/// The diff for a single file vs `base` (tracked change, or a fully-added
/// diff for an untracked file).
pub fn file_diff(cwd: &str, path: &str, base: &str) -> Result<String, String> {
    file_diff_of(cwd, path, base, None)
}

/// El diff de un fichero: el de `branch` desde que se separó de `base`, o el de
/// tus cambios sin commitear cuando no hay rama.
///
/// Sin la rama, abrir un fichero de la lista de una rama enseñaba el diff del
/// árbol de trabajo — casi siempre vacío, que es peor que un error.
pub fn file_diff_of(cwd: &str, path: &str, base: &str, branch: Option<&str>) -> Result<String, String> {
    if !is_safe_relative_path(path) {
        return Err("ruta insegura".into());
    }
    if !is_safe_branch(base) {
        return Err("rama insegura".into());
    }
    if let Some(branch) = branch {
        if !is_safe_branch(branch) {
            return Err("rama inválida".into());
        }
        // Tres puntos, como el resto de la review.
        return git_cmd(cwd, &["diff", &format!("{base}...{branch}"), "--", path]);
    }
    let diff = git_cmd(cwd, &["diff", base, "--", path]).unwrap_or_default();
    if !diff.is_empty() {
        return Ok(diff);
    }
    Ok(diff_no_index(cwd, path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn is_safe_branch_accepts_normal_names() {
        assert!(is_safe_branch("main"));
        assert!(is_safe_branch("feat/mobile-review-diff"));
        assert!(is_safe_branch("release-1.2.3"));
    }

    #[test]
    fn is_safe_branch_rejects_flag_injection() {
        assert!(!is_safe_branch("--upload-pack=touch /tmp/pwned"));
        assert!(!is_safe_branch("-oProxyCommand=x"));
    }

    #[test]
    fn is_safe_branch_rejects_a_bare_flag() {
        // Sin `=` ni espacios pasaban el filtro, y git los lee como opciones.
        assert!(!is_safe_branch("--force"));
        assert!(!is_safe_branch("-n"));
        assert!(!is_safe_branch("--all"));
    }

    #[test]
    fn is_safe_branch_rejects_range_syntax_and_empty() {
        assert!(!is_safe_branch("main..evil"));
        assert!(!is_safe_branch(""));
    }

    #[test]
    fn is_safe_relative_path_accepts_normal_paths() {
        assert!(is_safe_relative_path("src/main.rs"));
        assert!(is_safe_relative_path("file.txt"));
    }

    #[test]
    fn is_safe_relative_path_rejects_absolute_and_traversal() {
        assert!(!is_safe_relative_path("/etc/passwd"));
        assert!(!is_safe_relative_path("../../etc/passwd"));
        assert!(!is_safe_relative_path("src/../../etc/passwd"));
        assert!(!is_safe_relative_path(""));
    }

    #[test]
    fn build_file_list_matches_stats_to_entries_by_path() {
        let list = build_file_list("M\tfoo.rs\n", "3\t1\tfoo.rs\n", &[]);
        assert_eq!(list, vec![json!({ "status": "M", "path": "foo.rs", "added": 3, "deleted": 1 })]);
    }

    #[test]
    fn build_file_list_includes_old_path_for_renames() {
        let list = build_file_list("R100\told.rs\tnew.rs\n", "0\t0\tnew.rs\n", &[]);
        assert_eq!(
            list,
            vec![json!({ "status": "R", "path": "new.rs", "added": 0, "deleted": 0, "old_path": "old.rs" })]
        );
    }

    #[test]
    fn build_file_list_defaults_missing_numstat_to_zero() {
        // Binary files (or a stat line git omits for other reasons) have no
        // numstat entry — the file should still show up, just with 0/0.
        let list = build_file_list("M\tfoo.bin\n", "", &[]);
        assert_eq!(list, vec![json!({ "status": "M", "path": "foo.bin", "added": 0, "deleted": 0 })]);
    }

    #[test]
    fn build_file_list_appends_untracked_files_as_added() {
        let list = build_file_list("", "", &["new_file.rs".to_string()]);
        assert_eq!(list, vec![json!({ "status": "A", "path": "new_file.rs", "added": 0, "deleted": 0 })]);
    }

    #[test]
    fn list_files_rejects_an_unsafe_base() {
        assert!(list_files("/tmp", "--upload-pack=x").is_err());
    }

    #[test]
    fn file_diff_rejects_an_unsafe_path_or_base() {
        assert!(file_diff("/tmp", "../../etc/passwd", "main").is_err());
        assert!(file_diff("/tmp", "src/a.rs", "main..evil").is_err());
    }

    #[test]
    fn a_folder_that_is_not_a_repo_says_so_instead_of_leaking_gits_error() {
        // Sin esto llega `warning: Not a git repository. Use --no-index…usage:
        // git`, y el cliente lo pega tal cual en su panel.
        let dir = std::env::temp_dir().join(format!("bento-norepo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().to_string();

        let error = list_files(&cwd, "main").expect_err("no hay repositorio");

        assert!(error.contains("no es un repositorio git"), "{error}");
        assert!(!error.contains("--no-index"), "y no el de git: {error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_branch_is_compared_from_where_it_forked_not_against_the_whole_base() {
        // Con dos puntos, todo lo que la base ganó después sale como si la rama
        // lo hubiera borrado: una rama vieja aparecía con cientos de ficheros
        // eliminados que nunca tocó.
        let repository = crate::test_support::repo("tres-puntos");
        let root = &repository.0;
        std::fs::write(root.join("comun.txt"), "uno").unwrap();
        crate::test_support::run(root, &["add", "."]);
        crate::test_support::run(root, &["commit", "-qm", "base"]);
        let principal = crate::branches::default_branch(&root.to_string_lossy());
        crate::test_support::run(root, &["checkout", "-qb", "rama"]);
        std::fs::write(root.join("de-la-rama.txt"), "x").unwrap();
        crate::test_support::run(root, &["add", "."]);
        crate::test_support::run(root, &["commit", "-qm", "rama"]);
        crate::test_support::run(root, &["checkout", "-q", &principal]);
        std::fs::write(root.join("posterior.txt"), "y").unwrap();
        crate::test_support::run(root, &["add", "."]);
        crate::test_support::run(root, &["commit", "-qm", "después"]);

        let cwd = root.to_string_lossy().to_string();
        let files = list_files_of(&cwd, &principal, Some("rama")).expect("los ficheros de la rama");
        let paths: Vec<String> = files
            .iter()
            .filter_map(|f| f.get("path").and_then(Value::as_str).map(String::from))
            .collect();

        assert_eq!(paths, vec!["de-la-rama.txt"], "solo lo que la rama añadió: {paths:?}");
    }

    #[test]
    fn a_file_of_a_branch_shows_that_branchs_diff_and_not_your_working_tree() {
        // Sin la rama salía el diff del árbol de trabajo: casi siempre vacío,
        // que se lee como "este fichero no cambió" cuando sí cambió.
        let repository = crate::test_support::repo("diff-fichero-rama");
        let root = &repository.0;
        std::fs::write(root.join("a.txt"), "uno\n").unwrap();
        crate::test_support::run(root, &["add", "."]);
        crate::test_support::run(root, &["commit", "-qm", "base"]);
        let principal = crate::branches::default_branch(&root.to_string_lossy());
        crate::test_support::run(root, &["checkout", "-qb", "rama"]);
        std::fs::write(root.join("a.txt"), "dos\n").unwrap();
        crate::test_support::run(root, &["add", "."]);
        crate::test_support::run(root, &["commit", "-qm", "en la rama"]);
        crate::test_support::run(root, &["checkout", "-q", &principal]);

        let cwd = root.to_string_lossy().to_string();
        let diff = file_diff_of(&cwd, "a.txt", &principal, Some("rama")).expect("el diff de la rama");

        assert!(diff.contains("+dos"), "el cambio de la rama: {diff}");
        // Y el del árbol de trabajo no lo trae: ahí no hay ningún "dos".
        let working = file_diff_of(&cwd, "a.txt", &principal, None).unwrap();
        assert!(!working.contains("+dos"), "eso es de la rama, no de tu árbol: {working}");
    }
}
