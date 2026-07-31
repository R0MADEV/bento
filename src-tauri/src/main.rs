#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
#![cfg_attr(test, allow(dead_code, unused_imports))]

mod command_error;
mod db;
mod docker;
mod git;
mod git_paths;
mod jira;
mod memory;
mod memory_import;
mod memory_sources;
mod notes;
mod pty;
mod scripts;
mod traffic_lights;
mod vault;
mod web_panel;
mod window_prefs;
mod workspace_io;

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

// The E2E runner checks this before touching UI state. This prevents an
// accidentally supplied production binary from sharing the user's WebView data.
#[tauri::command]
fn app_identifier(app: tauri::AppHandle) -> String {
    app.config().identifier.clone()
}

// General HTTP request for the HTTP-client panel (any method, headers, body).
#[tauri::command]
async fn http_request(
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    let m =
        reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
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
    Ok(HttpResponse {
        status,
        status_text,
        headers: resp_headers,
        body,
    })
}

// Fetch a URL with auth headers and return the body as a base64-encoded data URL.
// Used for binary assets (images) that require authentication and can't be loaded
// via a plain <img src> tag in the WebView.
#[tauri::command]
async fn http_fetch_base64(
    url: String,
    headers: Vec<(String, String)>,
) -> Result<String, String> {
    let mut req = reqwest::Client::new().get(&url);
    for (k, v) in &headers {
        if !k.is_empty() {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let mime = res.headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .split(';').next().unwrap_or("image/jpeg")
        .to_string();
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
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

#[cfg(not(test))]
fn main() {
    let context = tauri::generate_context!();
    #[cfg(all(feature = "e2e", target_os = "macos"))]
    let context = {
        let mut context = context;
        for window in &mut context.config_mut().app.windows {
            window.data_store_identifier = Some([
                183, 46, 91, 12, 231, 95, 74, 90, 166, 211, 22, 73, 194, 8, 117, 49,
            ]);
        }
        context
    };
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init());
    // The embedded WebDriver is test-only. Production bundles are built
    // without the `e2e` feature and expose no automation server.
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder
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
            app_identifier,
            http_fetch_base64,
            workspace_io::workspace_load,
            workspace_io::workspace_save,
            workspace_io::workspace_reset,
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
            db::db_docker_redis_set,
            db::db_docker_redis_ttl,
            db::db_docker_redis_command,
            jira::jira_accounts_get,
            jira::jira_account_set,
            jira::jira_account_delete,
            memory_import::memory_import_claude,
            memory_import::memory_import_codex,
            memory::memory_list,
            memory::memory_list_all,
            memory::memory_create,
            memory::memory_update,
            memory::memory_remove,
            memory::memory_migrate,
            memory::memory_transcript_list,
            memory::memory_transcript_create,
            memory::memory_summary_job_list,
            memory::memory_regenerate_summary,
            memory_sources::memory_source_list,
            memory_sources::memory_source_create,
            memory_sources::memory_source_remove,
            memory_sources::memory_source_scan,
            memory_sources::memory_source_scan_path,
            memory_sources::memory_source_import,
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
            git::git_all_remote_branches,
            git::git_current_branch,
            git::git_ref_diff,
            git::git_rev_parse,
            git::gh_pr_view_branch,
            git::gh_pr_comment,
            git::gh_pr_inline_comment,
            git::git_worktree_add,
            git::git_worktree_remove,
            git::git_sync,
            git::git_diff,
            git::git_branch_diff,
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
        .run(context)
        .expect("error while running tauri application");
}

// Unit tests exercise the command modules directly and do not need a desktop
// runtime or compiled frontend assets. Keeping this entry point asset-free
// makes `cargo test` work in a clean checkout before `npm run build`.
#[cfg(test)]
fn main() {}
