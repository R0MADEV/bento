//! Los comandos de commit. La lógica vive en `bento_review::commit`, que
//! comparten el panel, el daemon y el CLI.

use bento_review::commit;

#[tauri::command]
pub async fn git_commit(
    path: String,
    message: String,
    amend: Option<bool>,
    files: Option<Vec<String>>,
    patch: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        commit::commit(
            &path,
            &message,
            amend.unwrap_or(false),
            files.as_deref(),
            patch.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_fixup(
    path: String,
    target: String,
    base: String,
    files: Option<Vec<String>>,
    patch: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        commit::fixup(&path, &target, &base, files.as_deref(), patch.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_branch_rename(path: String, new_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || commit::branch_rename(&path, &new_name))
        .await
        .map_err(|e| e.to_string())?
}

/// El parche con solo lo elegido: los ficheros marcados enteros y, del resto,
/// los trozos sueltos. Vive junto a quien lo aplica (`apply_selected_patch`,
/// que usa `--unidiff-zero` justo porque los trozos van tal cual): armarlo en
/// un lenguaje y aplicarlo en otro era media regla a cada lado.
#[tauri::command]
pub async fn git_build_patch(
    diff: String,
    whole_files: Vec<String>,
    selected_hunks: std::collections::HashMap<String, Vec<usize>>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(bento_review::diff::build_selected_patch(&diff, &whole_files, &selected_hunks))
    })
    .await
    .map_err(|e: tauri::Error| e.to_string())?
}

/// Un fichero del diff partido en cabecera y trozos, para pintarlo con una
/// casilla por trozo. Lo parte el mismo código que luego arma el parche: si
/// cada lado contara los trozos a su manera, marcarías uno y commitearías otro.
#[tauri::command]
pub fn git_parse_file_patch(chunk: String) -> bento_review::diff::FilePatch {
    bento_review::diff::parse_file_patch(&chunk)
}
