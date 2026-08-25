//! Las tareas: cada una es un worktree con su rama, lo que lleva sin commitear
//! y cuánto se ha alejado de su upstream. Y las cuatro operaciones que se hacen
//! sobre ellas — crear, borrar, commitear y sincronizar.
//!
//! Es la lógica del panel de tareas del escritorio, sin nada de interfaz, para
//! que el CLI pueda hacer lo mismo sin reimplementarla.

use serde::Serialize;

use crate::vcs::{current_branch, git_cmd, is_safe_branch};
use crate::worktrees::{self, WorktreeInfo};

/// Lo que hay sin commitear en un worktree.
#[derive(Debug, Default, Clone, Serialize)]
pub struct TaskStatus {
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub total: u32,
}

/// Cuánto se ha separado la rama de su upstream, y en qué dirección.
#[derive(Debug, Default, Clone, Serialize)]
pub struct Upstream {
    pub name: Option<String>,
    pub state: String,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Task {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub status: TaskStatus,
    pub upstream: Upstream,
}

/// Cuenta los cambios de `git status --porcelain`. Un archivo a la vez en el
/// índice y modificado cuenta en las dos columnas: es un archivo, pero son dos
/// cosas que hacer con él.
pub fn parse_status(raw: &str) -> TaskStatus {
    let mut status = TaskStatus::default();
    for line in raw.lines().filter(|l| !l.trim().is_empty()) {
        status.total += 1;
        let bytes = line.as_bytes();
        let x = bytes.first().copied().unwrap_or(b' ');
        let y = bytes.get(1).copied().unwrap_or(b' ');
        if x == b'?' && y == b'?' {
            status.untracked += 1;
            continue;
        }
        if x != b' ' {
            status.staged += 1;
        }
        if y != b' ' {
            status.unstaged += 1;
        }
    }
    status
}

/// `rev-list --left-right --count @{u}...HEAD` imprime "detrás<TAB>delante".
pub fn parse_ahead_behind(raw: &str) -> (u32, u32) {
    let mut parts = raw.split_whitespace();
    let behind = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let ahead = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

/// El nombre de lo que te toca hacer: publicar, traer, o resolver las dos.
pub fn sync_state(ahead: u32, behind: u32) -> &'static str {
    match (ahead, behind) {
        (0, 0) => "synced",
        (_, 0) => "ahead",
        (0, _) => "behind",
        _ => "diverged",
    }
}

fn check_message(message: &str) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("el mensaje del commit no puede estar vacío".into());
    }
    Ok(())
}

/// El nombre de una tarea acaba siendo una rama y una carpeta, así que vale lo
/// mismo que para una rama: nada de flags ni de salirse del directorio.
fn check_task_name(name: &str) -> Result<(), String> {
    if !is_safe_branch(name) {
        return Err(format!("nombre de tarea inválido: {name}"));
    }
    Ok(())
}

fn upstream_of(cwd: &str) -> Upstream {
    let Ok(name) = git_cmd(cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) else {
        return Upstream { name: None, state: "unpublished".into(), ahead: 0, behind: 0 };
    };
    let counts = git_cmd(cwd, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]).unwrap_or_default();
    let (ahead, behind) = parse_ahead_behind(&counts);
    Upstream { name: Some(name.trim().to_string()), state: sync_state(ahead, behind).into(), ahead, behind }
}

fn status_of(cwd: &str) -> TaskStatus {
    parse_status(&git_cmd(cwd, &["status", "--porcelain"]).unwrap_or_default())
}

/// Las tareas del repo, cada una con lo que lleva pendiente.
pub fn list(cwd: &str) -> Vec<Task> {
    worktrees::list(cwd)
        .into_iter()
        .map(|WorktreeInfo { path, branch, head, .. }| Task {
            status: status_of(&path),
            upstream: upstream_of(&path),
            path,
            branch,
            head,
        })
        .collect()
}

/// Crea una tarea: una rama nueva desde `base` en su propio worktree, al lado
/// del repo. Devuelve dónde ha quedado.
pub fn create(repo: &str, name: &str, base: &str) -> Result<String, String> {
    check_task_name(name)?;
    if !is_safe_branch(base) {
        return Err(format!("rama base inválida: {base}"));
    }
    let parent = std::path::Path::new(repo)
        .parent()
        .ok_or_else(|| "el repo no tiene carpeta padre".to_string())?;
    let path = parent.join(name.replace('/', "-"));
    if path.exists() {
        return Err(format!("ya existe {}", path.display()));
    }
    let path_text = path.to_string_lossy().to_string();
    git_cmd(repo, &["worktree", "add", "-b", name, &path_text, base])?;
    Ok(path_text)
}

/// Quita una tarea. Sin `force` git se niega si hay trabajo sin guardar, que
/// es exactamente lo que queremos: aquí no hay deshacer.
///
/// Si el `.git` de dentro del worktree se ha roto o se ha ido, git dice "not a
/// working tree" y se planta: entonces se repara el enlace y se reintenta, o
/// la carpeta se queda ahí para siempre.
pub fn remove(repo: &str, path: &str, force: bool) -> Result<(), String> {
    let attempt = |force: bool| {
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(path);
        git_cmd(repo, &args).map(|_| ())
    };
    match attempt(force) {
        Err(e) if is_broken_link(&e) => {
            let _ = git_cmd(repo, &["worktree", "repair", path]);
            attempt(true)
        }
        result => result,
    }
}

/// Git se niega por dos motivos muy distintos: porque el enlace del worktree
/// está roto, o porque hay trabajo sin guardar. Solo el primero se repara y se
/// reintenta; el segundo es la protección que queremos conservar.
fn is_broken_link(error: &str) -> bool {
    error.contains("not a working tree") || error.contains("validation failed")
}

/// Commitea todo lo que hay en la tarea.
pub fn commit(cwd: &str, message: &str, amend: bool) -> Result<(), String> {
    check_message(message)?;
    git_cmd(cwd, &["add", "-A"])?;
    let mut args = vec!["commit", "-m", message];
    if amend {
        args.push("--amend");
    }
    git_cmd(cwd, &args).map(|_| ())
}

/// Trae lo del upstream y pone encima lo tuyo. Rebase, no merge: la rama de una
/// tarea es para un PR, y ahí un merge de vuelta solo añade ruido.
pub fn sync(cwd: &str) -> Result<String, String> {
    git_cmd(cwd, &["fetch", "--prune"])?;
    git_cmd(cwd, &["rebase", "--autostash", "@{u}"])
}

/// Publica la rama. `--force-with-lease` nunca pisa lo que no hayas visto.
/// La primera vez se publica con el nombre de la rama, no con HEAD, para que
/// el upstream quede apuntando a algo con nombre.
pub fn push(cwd: &str, force: bool) -> Result<String, String> {
    let branch = current_branch(cwd).map_err(|_| "cannot push: detached HEAD".to_string())?;
    let mut args = vec!["push"];
    if upstream_of(cwd).name.is_none() {
        args.extend(["--set-upstream", "origin", &branch]);
    } else if force {
        args.push("--force-with-lease");
    }
    git_cmd(cwd, &args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_counts_each_kind_of_change() {
        let status = parse_status("M  staged.rs\n M unstaged.rs\n?? nuevo.rs\n");
        assert_eq!(status.staged, 1);
        assert_eq!(status.unstaged, 1);
        assert_eq!(status.untracked, 1);
        assert_eq!(status.total, 3);
    }

    #[test]
    fn a_file_both_staged_and_modified_counts_in_both() {
        // Es un archivo, pero son dos cosas que hacer con él.
        let status = parse_status("MM ambos.rs\n");
        assert_eq!(status.staged, 1);
        assert_eq!(status.unstaged, 1);
        assert_eq!(status.total, 1);
    }

    #[test]
    fn a_clean_worktree_has_nothing() {
        assert_eq!(parse_status("").total, 0);
    }

    #[test]
    fn ahead_behind_reads_the_two_counts_in_order() {
        // `rev-list --left-right --count @{u}...HEAD` da "detrás   delante".
        assert_eq!(parse_ahead_behind("2\t5"), (5, 2));
    }

    #[test]
    fn ahead_behind_of_a_synced_branch_is_zero() {
        assert_eq!(parse_ahead_behind("0\t0"), (0, 0));
    }

    #[test]
    fn ahead_behind_survives_garbage() {
        assert_eq!(parse_ahead_behind(""), (0, 0));
    }

    #[test]
    fn the_state_names_what_you_have_to_do() {
        assert_eq!(sync_state(0, 0), "synced");
        assert_eq!(sync_state(3, 0), "ahead");
        assert_eq!(sync_state(0, 2), "behind");
        assert_eq!(sync_state(3, 2), "diverged");
    }

    #[test]
    fn a_commit_needs_a_real_message() {
        assert!(check_message("arregla el parseo").is_ok());
        assert!(check_message("   ").is_err());
        assert!(check_message("").is_err());
    }

    #[test]
    fn a_task_whose_git_link_broke_can_still_be_removed() {
        use crate::test_support::{commit_file, repo, run};
        let repo = repo("task-remove");
        commit_file(&repo.0, "root\n", "root");
        let root = repo.0.to_str().unwrap();
        let task = repo.0.parent().unwrap().join(format!("{}-task", repo.0.file_name().unwrap().to_string_lossy()));
        run(&repo.0, &["worktree", "add", "-b", "tarea", task.to_str().unwrap()]);
        // Se rompe el enlace: git dirá "not a working tree".
        std::fs::remove_file(task.join(".git")).unwrap();
        remove(root, task.to_str().unwrap(), false).unwrap();
        assert!(!task.exists());
    }

    #[test]
    fn unsaved_work_still_blocks_removing_a_task() {
        use crate::test_support::{commit_file, repo, run};
        let repo = repo("task-dirty");
        commit_file(&repo.0, "root\n", "root");
        let root = repo.0.to_str().unwrap();
        let task = repo.0.parent().unwrap().join(format!("{}-dirty", repo.0.file_name().unwrap().to_string_lossy()));
        run(&repo.0, &["worktree", "add", "-b", "sucia", task.to_str().unwrap()]);
        std::fs::write(task.join("nuevo.txt"), "sin guardar").unwrap();
        assert!(remove(root, task.to_str().unwrap(), false).is_err());
        assert!(task.exists(), "no se borra lo que tiene trabajo sin guardar");
        let _ = remove(root, task.to_str().unwrap(), true);
    }

    #[test]
    fn a_task_name_cannot_smuggle_a_flag_or_a_path() {
        assert!(check_task_name("feat/nueva").is_ok());
        assert!(check_task_name("--force").is_err());
        assert!(check_task_name("../fuera").is_err());
        assert!(check_task_name("").is_err());
    }
}
