#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod db;
mod docker;
mod git;
mod jira;
mod notes;
mod pty;
mod scripts;
mod traffic_lights;
mod vault;
mod web_panel;
mod window_prefs;

use std::sync::Arc;

// HTTP download from the Rust backend: avoids the WebView's limits with large
// files (the iptv-org API weighs tens of MB).
#[tauri::command]
async fn http_get(url: String) -> Result<String, String> {
    let res = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    res.text().await.map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct HttpResponse {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body: String,
}

// General HTTP request for the HTTP-client panel (any method, headers, body).
#[tauri::command]
async fn http_request(
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let mut req = reqwest::Client::new().request(m, &url);
    for (k, v) in &headers {
        if !k.is_empty() {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    if let Some(b) = body {
        if !b.is_empty() {
            req = req.body(b);
        }
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let status_text = res.status().canonical_reason().unwrap_or("").to_string();
    let resp_headers = res
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(HttpResponse { status, status_text, headers: resp_headers, body })
}

// macOS binds Cmd+Z to the native Edit > Undo menu item, whose undo is broken in
// the WebView (collapses all typing). We build a menu WITHOUT Undo/Redo so Cmd+Z
// falls through to the DOM, where the notes panel handles undo itself.
#[cfg(target_os = "macos")]
fn install_menu(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{MenuBuilder, SubmenuBuilder};
    let app_menu = SubmenuBuilder::new(app, "bento")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .fullscreen()
        .close_window()
        .build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &window_menu])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            install_menu(app)?;
            Ok(())
        })
        .manage(Arc::new(pty::PtyManager::default()))
        .manage(web_panel::WebPanelState::default())
        .manage(docker::LogStreams::default())
        .manage(vault::VaultState(std::sync::Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            http_get,
            http_request,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            traffic_lights::set_traffic_lights_visible,
            window_prefs::set_decorations,
            web_panel::web_panel_navigate,
            web_panel::web_panel_set_bounds,
            web_panel::web_panel_set_visible,
            web_panel::web_panel_close,
            web_panel::web_panel_close_all,
            notes::notes_list,
            notes::notes_write,
            notes::notes_delete,
            scripts::list_scripts,
            db::db_docker_ps,
            db::db_inspect_env,
            db::db_check_ports,
            db::db_docker_list_mysql,
            db::db_docker_list_mongo,
            db::db_docker_mysql_tables,
            db::db_docker_mysql_rows,
            db::db_docker_mysql_pk,
            db::db_docker_mysql_update,
            db::db_docker_mysql_delete,
            db::db_docker_mysql_query,
            db::db_docker_mysql_fks,
            db::db_docker_mongo_collections,
            db::db_docker_mongo_docs,
            db::db_docker_mongo_update,
            db::db_docker_mongo_delete,
            db::db_docker_mongo_query,
            db::db_docker_mongo_refs,
            db::db_docker_pg_databases,
            db::db_docker_pg_tables,
            db::db_docker_pg_rows,
            db::db_docker_pg_pk,
            db::db_docker_pg_update,
            db::db_docker_pg_delete,
            db::db_docker_pg_query,
            db::db_docker_pg_fks,
            db::db_docker_redis_dbs,
            db::db_docker_redis_keys,
            db::db_docker_redis_value,
            db::db_docker_redis_command,
            jira::jira_config_get,
            jira::jira_config_set,
            vault::vault_exists,
            vault::vault_is_unlocked,
            vault::vault_setup,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_list,
            vault::vault_add,
            vault::vault_delete,
            vault::vault_get_password,
            vault::vault_verify_password,
            vault::vault_update,
            docker::docker_list,
            docker::docker_start,
            docker::docker_stop,
            docker::docker_restart,
            docker::docker_logs,
            docker::docker_logs_follow,
            docker::docker_logs_stop,
            docker::docker_exec_argv,
            docker::docker_compose_isolate,
            docker::docker_compose_up,
            docker::docker_compose_down,
            git::git_worktree_list,
            git::git_status,
            git::git_rewrite_preflight,
            git::git_default_branch,
            git::git_remote_branches,
            git::git_worktree_add,
            git::git_worktree_remove,
            git::git_sync,
            git::git_diff,
            git::git_commit,
            git::git_fixup,
            git::git_push,
            git::git_upstream_status,
            git::git_fetch_info,
            git::git_backup_status,
            git::git_backup_list,
            git::git_backup_diff,
            git::git_restore_backup,
            git::git_ahead_behind,
            git::git_create_pr,
            git::git_branch_rename,
            git::git_log,
            git::git_graph,
            git::git_rebase_log,
            git::git_merge_log,
            git::git_pr_status,
            git::git_rebase_start,
            git::git_rebase_preserve_merges,
            git::git_rebase_continue,
            git::git_rebase_abort,
            git::git_rebase_split,
            git::git_rebase_status,
            git::git_show_files,
            git::git_show_commit_diff,
            git::git_show_file,
            git::git_recommend_commits,
            git::git_blame_recommend,
            git::git_resolve_conflict,
            git::git_add_files,
            git::git_read_file,
            git::git_write_file,
            git::git_reset,
            git::open_in_editor,
            docker::docker_compose_logs_follow,
            docker::docker_compose_logs_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
