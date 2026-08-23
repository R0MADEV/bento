#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
#![cfg_attr(test, allow(dead_code, unused_imports))]

mod agent;
mod agent_history;
mod agent_sessions;
mod agent_socket;
mod chat_history;
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
mod review;
mod scripts;
mod settings;
mod system_metrics;
mod traffic_lights;
mod vault;
mod web_panel;
mod window_prefs;
mod workspace_io;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::Manager;

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
            app.manage(agent_socket::start(app.handle()));
            // Terminals live in the bento-daemon; connect and forward its output.
            {
                let pty_manager = app.state::<Arc<pty::PtyManager>>().inner().clone();
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = pty_manager.connect(handle).await {
                        eprintln!("bento: bento-daemon not reachable ({error}); start it to use terminals");
                    }
                });
            }
            #[cfg(target_os = "macos")]
            install_menu(app)?;
            if let Some(window) = app.get_webview_window("main") {
                let manager = app.state::<agent::AgentManager>().inner().clone();
                let pty_manager = app.state::<Arc<pty::PtyManager>>().inner().clone();
                let closing = Arc::new(AtomicBool::new(false));
                let close_window = window.clone();
                window.clone().on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if closing.swap(true, Ordering::SeqCst) {
                            return;
                        }
                        api.prevent_close();
                        let manager = manager.clone();
                        let pty_manager = pty_manager.clone();
                        let window = close_window.clone();
                        tauri::async_runtime::spawn(async move {
                            agent::cancel_all(&manager).await;
                            pty_manager.send_shutdown();
                            pty::kill_all(&pty_manager);
                            let _ = window.close();
                        });
                    }
                });
            }
            Ok(())
        })
        .manage(Arc::new(pty::PtyManager::default()))
        .manage(agent::AgentManager::default())
        .manage(web_panel::WebPanelState::default())
        .manage(docker::LogStreams::default())
        .manage(system_metrics::SystemMetricsState::default())
        .manage(vault::VaultState(std::sync::Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            http_get,
            http_request,
            http_fetch_base64,
            app_identifier,
            system_metrics::app_memory_usage,
            agent::start_agent,
            agent::cancel_agent,
            agent_sessions::agent_codex_clear_lock,
            agent_sessions::agent_claude_session_exists,
            agent_sessions::agent_codex_session_exists,
            agent_sessions::agent_find_opencode_session,
            agent_history::agent_history_load,
            agent_history::agent_history_save,
            agent_history::agent_history_clear,
            agent_socket::agent_get_session,
            agent_socket::agent_socket_path,
            review::review_branch_context_prepare,
            review::review_branch_context_check,
            review::review_branch_context_update,
            review::review_branch_context_release,
            review::review_lexis_context,
            review::review_snapshot,
            review::review_validate_finding_path,
            workspace_io::workspace_load,
            workspace_io::workspace_save,
            workspace_io::workspace_reset,
            settings::settings_get,
            settings::settings_set,
            pty::pty_spawn,
            pty::pty_set_title,
            pty::pty_list,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::remote_start,
            pty::remote_stop,
            pty::remote_status,
            pty::tailscale_detect,
            traffic_lights::set_traffic_lights_visible,
            window_prefs::set_decorations,
            web_panel::web_panel_navigate,
            web_panel::web_panel_set_bounds,
            web_panel::web_panel_set_visible,
            web_panel::web_panel_close,
            web_panel::web_panel_close_all,
            chat_history::chat_history_load,
            chat_history::chat_history_save,
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
            docker::isolate::docker_compose_isolate,
            docker::devcontainer::devcontainer_recipe_preview,
            docker::devcontainer::devcontainer_recipe_create,
            docker::devcontainer::devcontainer_recipe_git,
            docker::devcontainer::devcontainer_recipe_status,
            docker::devcontainer::devcontainer_isolate,
            docker::devcontainer::devcontainer_urls,
            docker::docker_compose_up,
            docker::docker_compose_down,
            git::worktree::git_worktree_list,
            git::status::git_status,
            git::status::git_rewrite_preflight,
            git::branches::git_default_branch,
            git::branches::git_remote_branches,
            git::branches::git_all_remote_branches,
            git::branches::git_review_branches,
            git::git_current_branch,
            git::log::git_ref_diff,
            git::log::git_rev_parse,
            git::pr::gh_pr_view_branch,
            git::pr::gh_pr_diff_number,
            git::pr::gh_pr_comment,
            git::pr::gh_pr_inline_comment,
            git::pr::gh_pr_list_open,
            git::pr::gh_pr_list_discussion,
            git::pr::gh_pr_list_comments,
            git::pr::gh_pr_update_comment,
            git::pr::gh_pr_delete_comment,
            git::pr::gh_pr_reply_comment,
            git::pr::gh_pr_submit_review,
            git::worktree::git_worktree_add,
            git::worktree::git_worktree_remove,
            git::sync::git_sync,
            git::status::git_diff,
            git::status::git_branch_diff,
            git::status::git_review_worktree_diff,
            git::commit::git_commit,
            git::commit::git_fixup,
            git::sync::git_push,
            git::sync::git_upstream_status,
            git::sync::git_fetch_info,
            git::backup::git_backup_status,
            git::backup::git_backup_list,
            git::backup::git_backup_diff,
            git::backup::git_restore_backup,
            git::sync::git_ahead_behind,
            git::pr::git_create_pr,
            git::commit::git_branch_rename,
            git::log::git_log,
            git::log::git_graph,
            git::log::git_rebase_log,
            git::log::git_merge_log,
            git::pr::git_pr_status,
            git::rebase::git_rebase_start,
            git::rebase::git_rebase_preserve_merges,
            git::rebase::git_rebase_continue,
            git::rebase::git_rebase_abort,
            git::rebase::git_rebase_split,
            git::rebase::git_rebase_status,
            git::log::git_show_files,
            git::log::git_show_commit_diff,
            git::log::git_show_file,
            git::recommend::git_recommend_commits,
            git::recommend::git_blame_recommend,
            git::edit::git_resolve_conflict,
            git::edit::git_add_files,
            git::edit::git_read_file,
            git::edit::git_write_file,
            git::edit::git_reset,
            git::edit::open_in_editor,
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
