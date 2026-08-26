//! Los comandos git del panel de tareas. La lógica vive en `bento_review`,
//! compartida con el daemon y el CLI; aquí solo quedan los envoltorios y lo
//! que es del escritorio (resolver el PATH a mano, porque una app de GUI en
//! macOS no hereda el del shell).

use std::process::Command;

pub(crate) mod worktree;
pub(crate) mod branches;
pub(crate) mod status;
pub(crate) mod backup;
pub(crate) mod commit;
pub(crate) mod log;
pub(crate) mod pr;
pub(crate) mod sync;
pub(crate) mod rebase;
pub(crate) mod recommend;
pub(crate) mod edit;

/// Una app de GUI en macOS no hereda el PATH del shell, así que para encontrar
/// un binario hay que preguntarle a un shell de login.
fn login_shell_output(cmd: &str) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = Command::new(shell).arg("-lc").arg(cmd).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
pub async fn git_current_branch(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || bento_review::vcs::current_branch(&path))
        .await
        .map_err(|e| e.to_string())?
}
