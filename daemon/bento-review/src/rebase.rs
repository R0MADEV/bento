//! El rebase interactivo: validar el plan, respaldarlo antes de tocar nada,
//! ejecutarlo sin abrir un editor, y saber en qué punto se ha quedado si para.
//!
//! Lo delicado es el plan: cada línea acaba dentro del todo de git, así que se
//! comprueba acción por acción y commit por commit contra los que existen de
//! verdad en el rango. Sin eso, el "plan" es un canal para meter lo que sea.

use std::fs;
use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::backup::create_history_backup;
use crate::vcs::{git_bin, git_cmd, is_safe_branch, resolve_git_dir};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStatus {
    pub active: bool,
    pub sha: Option<String>,
    pub short: Option<String>,
    pub subject: Option<String>,
    pub body: Option<String>,
    pub branch: Option<String>,
    pub current: Option<u32>,
    pub total: Option<u32>,
    pub conflicts: Vec<String>,
}

// Writes a temp shell script that copies its first argument to our prepared todo file.
// Used as GIT_SEQUENCE_EDITOR so git uses our todo instead of opening $EDITOR.
fn write_sequence_editor_script(
    todo_content: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let pid = std::process::id();
    let todo_path = std::env::temp_dir().join(format!("bento-rebase-todo-{pid}.txt"));
    let extension = if cfg!(windows) { "cmd" } else { "sh" };
    let script_path = std::env::temp_dir().join(format!("bento-rebase-editor-{pid}.{extension}"));

    fs::write(&todo_path, todo_content).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let script = format!(
        "@echo off\r\ncopy /Y \"{}\" \"%~1\" >NUL\r\n",
        todo_path.display()
    );
    #[cfg(not(windows))]
    let script = format!("#!/bin/sh\ncp '{}' \"$1\"\n", todo_path.display());
    fs::write(&script_path, &script).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }

    Ok((todo_path, script_path))
}

fn sequence_editor_command(path: &Path, windows: bool) -> String {
    let raw = path.to_string_lossy();
    let normalized = if windows {
        raw.replace('\\', "/")
    } else {
        raw.into_owned()
    };
    // Git executes GIT_SEQUENCE_EDITOR through a POSIX-style shell, including
    // Git for Windows. Single-quote the executable and escape embedded quotes.
    format!("'{}'", normalized.replace('\'', "'\"'\"'"))
}


/// Comprueba el plan del rebase contra los commits que existen en el rango.
/// Devuelve el porqué del rechazo, que es lo que verá quien lo escribió.
pub fn check_todo(todo_lines: &[String], allowed_hashes: &str) -> Result<(), String> {
    if todo_lines.is_empty() {
        return Err("nothing to rebase".into());
    }
    for line in todo_lines {
        if line.contains('\n') || line.contains('\r') {
            return Err("invalid rebase instruction".into());
        }
        let mut parts = line.split_whitespace();
        let action = parts.next().unwrap_or("");
        let hash = parts.next().unwrap_or("");
        let known_action = matches!(action, "pick" | "edit" | "squash" | "fixup" | "drop");
        let looks_like_a_hash = hash.len() >= 7 && hash.chars().all(|c| c.is_ascii_hexdigit());
        if !known_action || !looks_like_a_hash || !allowed_hashes.lines().any(|allowed| allowed == hash) {
            return Err("rebase instruction contains an invalid action or commit".into());
        }
    }
    Ok(())
}

/// Arranca el rebase interactivo sobre `origin/<base>` con el plan dado.
/// Si git se para en un `edit` o en un conflicto devuelve Ok: hay que mirar
/// `status` después.
pub fn start(cwd: &str, base: &str, todo_lines: &[String]) -> Result<(), String> {
    if !is_safe_branch(base) {
        return Err(format!("unsafe base branch: {base}"));
    }
    let target = format!("origin/{base}");
    git_cmd(cwd, &["rev-parse", "--verify", &target])?;
    let range = format!("{target}..HEAD");
    let allowed_hashes = git_cmd(cwd, &["rev-list", "--no-merges", &range])?;
    check_todo(todo_lines, &allowed_hashes)?;

    create_history_backup(cwd)?;
    let todo_content = todo_lines.join("\n") + "\n";
    let (todo_path, script_path) = write_sequence_editor_script(&todo_content)?;
    let sequence_editor = sequence_editor_command(&script_path, cfg!(windows));

    let out = Command::new(git_bin()?)
        .arg("-C")
        .arg(cwd)
        .args(["rebase", "-i", "--autostash", &target])
        .env("GIT_SEQUENCE_EDITOR", sequence_editor)
        .env("GIT_EDITOR", "true")
        .output()
        .map_err(|e| e.to_string())?;

    let _ = fs::remove_file(&todo_path);
    let _ = fs::remove_file(&script_path);

    // Mirar el directorio antes que el código de salida: git sale 0 o no-0 de
    // forma inconsistente cuando se queda pausado.
    if resolve_git_dir(cwd).join("rebase-merge").exists() {
        return Ok(());
    }
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Rebase conservando la topología de merges. No lleva plan: git decide, y
/// nosotros solo respaldamos antes.
pub fn preserve_merges(cwd: &str, base: &str) -> Result<String, String> {
    if !is_safe_branch(base) {
        return Err(format!("unsafe base branch: {base}"));
    }
    let target = format!("origin/{base}");
    git_cmd(cwd, &["rev-parse", "--verify", &target])?;
    create_history_backup(cwd)?;
    let out = Command::new(git_bin()?)
        .arg("-C")
        .arg(cwd)
        .args(["rebase", "--rebase-merges", "--autostash", &target])
        .env("GIT_EDITOR", "true")
        .output()
        .map_err(|e| e.to_string())?;
    if resolve_git_dir(cwd).join("rebase-merge").exists() {
        return Ok("paused".into());
    }
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok("completed".into())
}

/// Todos los commits del rango como un plan de solo `pick`: rebasar sin
/// reordenar nada, que es el 90% de las veces.
pub fn plain_todo(cwd: &str, base: &str) -> Result<Vec<String>, String> {
    if !is_safe_branch(base) {
        return Err(format!("unsafe base branch: {base}"));
    }
    let range = format!("origin/{base}..HEAD");
    let hashes = git_cmd(cwd, &["rev-list", "--reverse", "--no-merges", &range])?;
    Ok(hashes.lines().filter(|h| !h.is_empty()).map(|h| format!("pick {h}")).collect())
}

/// Sigue tras resolver. Devuelve "paused" si git vuelve a parar.
pub fn continue_rebase(cwd: &str) -> Result<String, String> {
    let bin = git_bin()?;
    let out = Command::new(&bin)
        .arg("-C")
        .arg(cwd)
        .arg("rebase")
        .arg("--continue")
        .env("GIT_EDITOR", "true")
        .output()
        .map_err(|e| e.to_string())?;

    // Same pattern as git_rebase_start: check directory before exit code.
    let rebase_dir = resolve_git_dir(cwd).join("rebase-merge");
    if rebase_dir.exists() {
        return Ok("paused".into());
    }

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn abort(cwd: &str) -> Result<(), String> {
    git_cmd(cwd, &["rebase", "--abort"]).map(|_| ())
}

/// Convierte el commit pausado en un `edit` en cambios sin commitear, para
/// poder partirlo en dos o más.
pub fn split(cwd: &str) -> Result<(), String> {
    let rebase_dir = resolve_git_dir(cwd).join("rebase-merge");
    if !rebase_dir.exists() {
        return Err("no interactive rebase is active".into());
    }
    if !git_cmd(cwd, &["status", "--porcelain"])?
        .trim()
        .is_empty()
    {
        return Err("resolve or commit the current worktree changes before splitting".into());
    }
    git_cmd(cwd, &["reset", "--mixed", "HEAD^"]).map(|_| ())
}

/// En qué punto está el rebase: qué commit, cuántos van, y qué archivos están
/// en conflicto si se ha parado por eso.
pub fn status(cwd: &str) -> Result<RebaseStatus, String> {
    let rebase_dir = resolve_git_dir(cwd).join("rebase-merge");
    if !rebase_dir.exists() {
        return Ok(RebaseStatus {
            active: false,
            sha: None,
            short: None,
            subject: None,
            body: None,
            branch: None,
            current: None,
            total: None,
            conflicts: Vec::new(),
        });
    }
    // Use HEAD directly — more reliable than stopped-sha (not always written by git).
    let sha = git_cmd(cwd, &["rev-parse", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let short = sha.chars().take(7).collect::<String>();
    let head_name = fs::read_to_string(rebase_dir.join("head-name"))
        .unwrap_or_default()
        .trim()
        .trim_start_matches("refs/heads/")
        .to_string();
    let current = fs::read_to_string(rebase_dir.join("msgnum"))
        .unwrap_or_default()
        .trim()
        .parse::<u32>()
        .unwrap_or(0);
    let total = fs::read_to_string(rebase_dir.join("end"))
        .unwrap_or_default()
        .trim()
        .parse::<u32>()
        .unwrap_or(0);
    // Full commit message: subject + body (separated by blank line in git output)
    let full_msg = git_cmd(cwd, &["log", "--format=%B", "-1"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let subject = full_msg.lines().next().unwrap_or("").to_string();
    let body = full_msg.lines().skip(2).collect::<Vec<_>>().join("\n");

    // Detect conflicting files: porcelain status lines where both sides are non-clean (UU, AA, DD, AU, UA, DU, UD).
    let status_out = git_cmd(cwd, &["status", "--porcelain"]).unwrap_or_default();
    let conflicts: Vec<String> = status_out
        .lines()
        .filter(|l| {
            l.len() >= 2 && matches!(&l[..2], "UU" | "AA" | "DD" | "AU" | "UA" | "DU" | "UD")
        })
        .map(|l| l[3..].trim().to_string())
        .collect();

    Ok(RebaseStatus {
        active: true,
        sha: Some(sha),
        short: Some(short),
        subject: Some(subject),
        body: Some(body),
        branch: Some(head_name),
        current: Some(current),
        total: Some(total),
        conflicts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASHES: &str = "abc1234def\nfeed9876543\n";

    #[test]
    fn a_plan_of_known_actions_over_real_commits_is_accepted() {
        let todo = vec!["pick abc1234def".to_string(), "squash feed9876543".to_string()];
        assert!(check_todo(&todo, HASHES).is_ok());
    }

    #[test]
    fn an_empty_plan_is_rejected() {
        assert!(check_todo(&[], HASHES).is_err());
    }

    #[test]
    fn an_unknown_action_is_rejected() {
        // `exec` ejecuta un comando arbitrario: es justo lo que no queremos
        // que se cuele desde fuera.
        let todo = vec!["exec rm -rf /".to_string()];
        assert!(check_todo(&todo, HASHES).is_err());
    }

    #[test]
    fn a_commit_outside_the_range_is_rejected() {
        let todo = vec!["pick 0000000000".to_string()];
        assert!(check_todo(&todo, HASHES).is_err());
    }

    #[test]
    fn a_newline_inside_an_instruction_is_rejected() {
        // Sin esto, una sola línea puede escribir varias en el todo de git.
        let todo = vec!["pick abc1234def\nexec touch /tmp/pwned".to_string()];
        assert!(check_todo(&todo, HASHES).is_err());
    }

    #[test]
    fn something_that_is_not_a_hash_is_rejected() {
        assert!(check_todo(&["pick HEAD".to_string()], HASHES).is_err());
        assert!(check_todo(&["pick abc".to_string()], HASHES).is_err());
    }

    #[test]
    fn the_sequence_editor_is_quoted_for_a_posix_shell() {
        // Git ejecuta GIT_SEQUENCE_EDITOR con un shell, también en Windows.
        let quoted = sequence_editor_command(Path::new("/tmp/con espacio/editor.sh"), false);
        assert_eq!(quoted, "'/tmp/con espacio/editor.sh'");
    }

    #[test]
    fn a_quote_in_the_path_cannot_break_out() {
        let quoted = sequence_editor_command(Path::new("/tmp/o'brien/editor.sh"), false);
        assert_eq!(quoted, "'/tmp/o'\"'\"'brien/editor.sh'");
    }

    #[test]
    fn windows_paths_are_normalised_to_forward_slashes() {
        let quoted = sequence_editor_command(Path::new("C:\\tmp\\editor.cmd"), true);
        assert_eq!(quoted, "'C:/tmp/editor.cmd'");
    }
}

#[cfg(test)]
mod git_tests {
    use super::*;
    use std::process::Command;
    use std::fs;
    use crate::test_support::*;

    #[test]
    fn conflicted_rebase_can_be_aborted_without_losing_the_original_head() {
        let repo = repo("abort");
        commit_file(&repo.0, "shared\n", "root");
        let base_branch = run(&repo.0, &["rev-parse", "--abbrev-ref", "HEAD"]);
        run(&repo.0, &["branch", "task"]);
        commit_file(&repo.0, "base version\n", "base change");
        run(&repo.0, &["checkout", "-q", "task"]);
        commit_file(&repo.0, "task version\n", "task change");
        let original_head = run(&repo.0, &["rev-parse", "HEAD"]);
        let rebase = Command::new("git")
            .arg("-C")
            .arg(&repo.0)
            .args(["rebase", base_branch.trim()])
            .output()
            .unwrap();
        assert!(!rebase.status.success());
        assert!(resolve_git_dir(repo.0.to_str().unwrap())
            .join("rebase-merge")
            .exists());
        run(&repo.0, &["rebase", "--abort"]);
        assert_eq!(
            run(&repo.0, &["rev-parse", "HEAD"]).trim(),
            original_head.trim()
        );
        assert_eq!(
            fs::read_to_string(repo.0.join("file.txt")).unwrap(),
            "task version\n"
        );
    }

    #[test]
    fn split_rebase_returns_paused_commit_to_the_worktree() {
        let repo = repo("split");
        commit_file(&repo.0, "root\n", "root");
        run(&repo.0, &["branch", "base"]);
        commit_file(&repo.0, "changed\n", "change to split");
        let commit = run(&repo.0, &["rev-parse", "HEAD"]);
        let todo = format!("edit {} change to split\n", commit.trim());
        let (todo_path, script_path) = write_sequence_editor_script(&todo).unwrap();
        let out = Command::new("git")
            .arg("-C")
            .arg(&repo.0)
            .args(["rebase", "-i", "base"])
            .env("GIT_SEQUENCE_EDITOR", &script_path)
            .env("GIT_EDITOR", "true")
            .output()
            .unwrap();
        let _ = fs::remove_file(todo_path);
        let _ = fs::remove_file(script_path);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(resolve_git_dir(repo.0.to_str().unwrap())
            .join("rebase-merge")
            .exists());

        split(repo.0.to_str().unwrap()).unwrap();
        let status = run(&repo.0, &["status", "--short"]);
        assert!(status.contains("file.txt"));
        assert_eq!(
            fs::read_to_string(repo.0.join("file.txt")).unwrap(),
            "changed\n"
        );
        run(&repo.0, &["rebase", "--abort"]);
    }

    #[test]
    fn quotes_windows_sequence_editor_for_gits_shell() {
        let path = Path::new(r"C:\Users\Runner Admin\Temp\bento-rebase-editor.cmd");
        assert_eq!(
            sequence_editor_command(path, true),
            "'C:/Users/Runner Admin/Temp/bento-rebase-editor.cmd'"
        );
    }
}
