//! Commitear: todo, solo unos ficheros o solo unos trozos (el parche que trae
//! el panel), y meter cambios en un commit anterior con un fixup. Sin UI: lo
//! usan el panel, el daemon y el CLI.

use std::io::Write;
use std::process::{Command, Stdio};

use crate::backup::{backup_ref_for, create_history_backup};
use crate::vcs::{git_bin, git_cmd, is_safe_branch, resolve_git_dir};

/// El mensaje es entrada del usuario: vacío no vale (git abriría un editor que
/// aquí no hay).
pub fn is_valid_message(message: &str) -> bool {
    !message.trim().is_empty()
}

/// Cómo acabó un fixup: el rebase se completó o se quedó parado esperando a que
/// alguien resuelva un conflicto.
const COMPLETED: &str = "completed";
const PAUSED: &str = "paused";

/// Commitea. `files` limita a unas rutas; `patch` limita a unos trozos (tiene
/// prioridad sobre `files`). `amend` con mensaje vacío conserva el original.
pub fn commit(
    cwd: &str,
    message: &str,
    amend: bool,
    files: Option<&[String]>,
    patch: Option<&str>,
) -> Result<String, String> {
    if !amend && !is_valid_message(message) {
        return Err("commit message cannot be empty".into());
    }
    let selected = files.filter(|items| !items.is_empty());
    stage(cwd, selected, patch)?;

    let mut args = vec!["commit"];
    if amend {
        args.push("--amend");
    }
    if is_valid_message(message) {
        args.extend(["-m", message]);
    } else {
        args.push("--no-edit");
    }
    if patch.is_none() {
        if let Some(items) = selected {
            args.push("--only");
            args.push("--");
            args.extend(items.iter().map(String::as_str));
        }
    }
    let result = git_cmd(cwd, &args);
    if result.is_err() && patch.is_some() {
        let _ = git_cmd(cwd, &["reset", "--mixed", "HEAD"]);
    }
    result
}

/// Mete los cambios del worktree en un commit que ya existe: crea un `fixup!` y
/// lo aplasta con un rebase autosquash sobre `origin/<base>`.
///
/// Devuelve "completed" o "paused" (rebase parado en un conflicto). Si el
/// rebase falla sin dejar nada recuperable se vuelve al estado previo con
/// `--mixed`, así que los cambios siguen en el worktree.
pub fn fixup(
    cwd: &str,
    target: &str,
    base: &str,
    files: Option<&[String]>,
    patch: Option<&str>,
) -> Result<String, String> {
    if !is_safe_branch(base) {
        return Err(format!("unsafe base branch: {base}"));
    }
    if target.len() < 7 || !target.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid target commit".into());
    }
    let base_ref = format!("origin/{base}");
    git_cmd(cwd, &["rev-parse", "--verify", &base_ref])?;
    let branch_commits = git_cmd(cwd, &["rev-list", &format!("{base_ref}..HEAD")])?;
    if !branch_commits.lines().any(|hash| hash == target) {
        return Err("target commit is not part of this task branch".into());
    }

    create_history_backup(cwd)?;
    let selected = files.filter(|items| !items.is_empty());
    stage(cwd, selected, patch)?;

    let fixup_arg = format!("--fixup={target}");
    let mut args = vec!["commit", fixup_arg.as_str()];
    if patch.is_none() {
        if let Some(items) = selected {
            args.push("--only");
            args.push("--");
            args.extend(items.iter().map(String::as_str));
        }
    }
    if let Err(error) = git_cmd(cwd, &args) {
        if patch.is_some() {
            let _ = git_cmd(cwd, &["reset", "--mixed", "HEAD"]);
        }
        return Err(format!(
            "{error}\n\nNo se creó el fixup; los cambios siguen en el worktree."
        ));
    }
    autosquash(cwd, &base_ref)
}

/// Renombra la rama actual.
pub fn branch_rename(cwd: &str, new_name: &str) -> Result<(), String> {
    if !is_safe_branch(new_name) {
        return Err(format!("unsafe branch name: {new_name}"));
    }
    git_cmd(cwd, &["branch", "-m", new_name]).map(|_| ())
}

/// Deja en el índice lo que va a entrar en el commit: un parche, unas rutas o
/// todo.
fn stage(cwd: &str, files: Option<&[String]>, patch: Option<&str>) -> Result<(), String> {
    if let Some(patch) = patch {
        return apply_selected_patch(cwd, patch);
    }
    let Some(items) = files else {
        return git_cmd(cwd, &["add", "-A"]).map(|_| ());
    };
    // `add -N` hace que los ficheros nuevos existan para `commit --only`, que
    // así ignora todo lo demás que hubiera ya en el índice.
    let mut args = vec!["add", "-N", "--"];
    args.extend(items.iter().map(String::as_str));
    git_cmd(cwd, &args).map(|_| ())
}

/// Deja en el índice solo los trozos del parche. Se limpia el índice antes (sin
/// tocar el worktree) para que nada que estuviera preparado se cuele en el
/// commit parcial.
fn apply_selected_patch(cwd: &str, patch: &str) -> Result<(), String> {
    if patch.trim().is_empty() || !patch.contains("diff --git ") {
        return Err("selected patch is empty or invalid".into());
    }
    if patch.len() > 16 * 1024 * 1024 {
        return Err("selected patch is too large".into());
    }
    git_cmd(cwd, &["reset", "--mixed", "HEAD"])?;
    let bin = git_bin()?;
    let mut child = Command::new(&bin)
        .arg("-C")
        .arg(cwd)
        .args(["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    child
        .stdin
        .as_mut()
        .ok_or("could not open git apply stdin")?
        .write_all(patch.as_bytes())
        .map_err(|error| error.to_string())?;
    let out = child.wait_with_output().map_err(|error| error.to_string())?;
    if !out.status.success() {
        let _ = git_cmd(cwd, &["reset", "--mixed", "HEAD"]);
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

fn autosquash(cwd: &str, base_ref: &str) -> Result<String, String> {
    let bin = git_bin()?;
    let out = Command::new(&bin)
        .arg("-C")
        .arg(cwd)
        .args(["rebase", "-i", "--autosquash", "--autostash", base_ref])
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env("GIT_EDITOR", "true")
        .output()
        .map_err(|error| error.to_string())?;

    if resolve_git_dir(cwd).join("rebase-merge").exists() {
        return Ok(PAUSED.into());
    }
    if !out.status.success() {
        // El fixup existe pero no hay rebase que retomar: se vuelve al commit
        // previo con --mixed, así que ningún cambio se pierde del worktree.
        let backup_ref = backup_ref_for(cwd)?;
        let _ = git_cmd(cwd, &["reset", "--mixed", &backup_ref]);
        return Err(format!(
            "{}\n\nEl fixup se revirtió automáticamente y los cambios siguen en el worktree.",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(COMPLETED.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::*;
    use std::fs;

    #[test]
    fn partial_patch_stages_only_the_selected_hunk() {
        let repository = repo("partial");
        let original = (1..=12).map(|n| format!("line {n}\n")).collect::<String>();
        commit_file(&repository.0, &original, "base");
        let changed = original
            .replace("line 1\n", "changed one\n")
            .replace("line 12\n", "changed twelve\n");
        fs::write(repository.0.join("file.txt"), changed).unwrap();
        let diff = run(&repository.0, &["diff", "--unified=0"]);
        let second_hunk = diff.match_indices("@@").nth(2).map(|(index, _)| index).unwrap();

        apply_selected_patch(repository.0.to_str().unwrap(), &diff[..second_hunk]).unwrap();

        let staged = run(&repository.0, &["diff", "--cached"]);
        assert!(staged.contains("changed one"));
        assert!(!staged.contains("changed twelve"));
        assert!(run(&repository.0, &["diff"]).contains("changed twelve"));
    }

    #[test]
    fn an_empty_message_is_refused_unless_it_amends() {
        let repository = repo("empty-message");
        commit_file(&repository.0, "base\n", "base");
        assert!(commit(repository.0.to_str().unwrap(), "   ", false, None, None).is_err());
    }

    #[test]
    fn a_fixup_target_outside_the_branch_is_refused() {
        let repository = repo("fixup-guard");
        commit_file(&repository.0, "base\n", "base");
        let path = repository.0.to_str().unwrap();
        assert!(fixup(path, "abc", "main", None, None).is_err());
        assert!(fixup(path, "--force", "main", None, None).is_err());
        assert!(fixup(path, "0123456789abcdef", "--force", None, None).is_err());
    }

    #[test]
    fn autosquash_integrates_fixup_into_selected_commit() {
        let repository = repo("autosquash");
        commit_file(&repository.0, "root\n", "root");
        run(&repository.0, &["branch", "base"]);
        commit_file(&repository.0, "target\n", "target commit");
        let target = run(&repository.0, &["rev-parse", "HEAD"]);
        fs::write(repository.0.join("other.txt"), "later\n").unwrap();
        run(&repository.0, &["add", "other.txt"]);
        run(&repository.0, &["commit", "-qm", "later commit"]);
        fs::write(repository.0.join("file.txt"), "target with fix\n").unwrap();
        run(&repository.0, &["add", "file.txt"]);
        run(&repository.0, &["commit", &format!("--fixup={}", target.trim())]);

        assert_eq!(autosquash(repository.0.to_str().unwrap(), "base").unwrap(), COMPLETED);
        assert_eq!(run(&repository.0, &["rev-list", "--count", "base..HEAD"]).trim(), "2");
        assert_eq!(fs::read_to_string(repository.0.join("file.txt")).unwrap(), "target with fix\n");
        assert!(!run(&repository.0, &["log", "--format=%s", "base..HEAD"]).contains("fixup!"));
    }
}
