#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
#![cfg_attr(test, allow(dead_code, unused_imports))]

mod agent;
mod app;
mod command_error;
mod db;
mod docker;
mod git;
mod jira;
mod memory;
mod http;
mod notes;
mod pty;
mod review;
mod scripts;
mod vault;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::Manager;

// The E2E runner checks this before touching UI state. This prevents an
// accidentally supplied production binary from sharing the user's WebView data.
#[tauri::command]
fn app_identifier(app: tauri::AppHandle) -> String {
    app.config().identifier.clone()
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
            app.manage(agent::socket::start(app.handle()));
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
            app::menu::install_menu(app)?;
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
        .manage(app::web_panel::WebPanelState::default())
        .manage(docker::LogStreams::default())
        .manage(app::system_metrics::SystemMetricsState::default())
        .manage(vault::VaultState(std::sync::Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            http::http_get,
            http::http_request,
            http::http_fetch_base64,
            app_identifier,
            app::system_metrics::app_memory_usage,
            agent::start_agent,
            agent::cancel_agent,
            agent::sessions::agent_codex_clear_lock,
            agent::sessions::agent_claude_session_exists,
            agent::sessions::agent_codex_session_exists,
            agent::sessions::agent_find_opencode_session,
            agent::history::agent_history_load,
            agent::history::agent_history_save,
            agent::history::agent_history_clear,
            agent::socket::agent_get_session,
            agent::socket::agent_socket_path,
            review::review_branch_context_prepare,
            review::review_branch_context_check,
            review::review_branch_context_update,
            review::review_branch_context_release,
            review::review_lexis_context,
            review::review_snapshot,
            review::review_validate_finding_path,
            review::review_build_prompt,
            review::review_checkpoint_save,
            review::review_checkpoint_get,
            review::review_checkpoints_list,
            review::review_checkpoint_delete,
            review::review_build_synthesis_prompt,
            review::review_build_document,
            review::review_follow_up_session,
            review::review_build_overview,
            review::review_is_retryable,
            app::workspace_io::workspace_load,
            app::workspace_io::workspace_save,
            app::workspace_io::workspace_reset,
            app::settings::settings_get,
            app::settings::settings_set,
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
            app::traffic_lights::set_traffic_lights_visible,
            app::window_prefs::set_decorations,
            app::web_panel::web_panel_navigate,
            app::web_panel::web_panel_set_bounds,
            app::web_panel::web_panel_set_visible,
            app::web_panel::web_panel_close,
            app::web_panel::web_panel_close_all,
            agent::chat_history::chat_history_load,
            agent::chat_history::chat_history_save,
            notes::notes_list,
            notes::notes_write,
            notes::notes_delete,
            scripts::list_scripts,
            db::db_docker_ps,
            db::db_inspect_env,
            db::db_check_ports,
            db::mysql::db_docker_list_mysql,
            db::mongo::db_docker_list_mongo,
            db::mysql::db_docker_mysql_tables,
            db::mysql::db_docker_mysql_rows,
            db::mysql::db_docker_mysql_pk,
            db::mysql::db_docker_mysql_update,
            db::mysql::db_docker_mysql_delete,
            db::mysql::db_docker_mysql_query,
            db::mysql::db_docker_mysql_fks,
            db::mongo::db_docker_mongo_collections,
            db::mongo::db_docker_mongo_docs,
            db::mongo::db_docker_mongo_update,
            db::mongo::db_docker_mongo_delete,
            db::mongo::db_docker_mongo_query,
            db::mongo::db_docker_mongo_refs,
            db::postgres::db_docker_pg_databases,
            db::postgres::db_docker_pg_tables,
            db::postgres::db_docker_pg_rows,
            db::postgres::db_docker_pg_pk,
            db::postgres::db_docker_pg_update,
            db::postgres::db_docker_pg_delete,
            db::postgres::db_docker_pg_query,
            db::postgres::db_docker_pg_fks,
            db::redis::db_docker_redis_dbs,
            db::redis::db_docker_redis_keys,
            db::redis::db_docker_redis_value,
            db::redis::db_docker_redis_set,
            db::redis::db_docker_redis_ttl,
            db::redis::db_docker_redis_command,
            jira::jira_accounts_get,
            jira::jira_account_set,
            jira::jira_account_delete,
            memory::import::memory_import_claude,
            memory::import::memory_import_codex,
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
            memory::sources::memory_source_list,
            memory::sources::memory_source_create,
            memory::sources::memory_source_remove,
            memory::sources::memory_source_scan,
            memory::sources::memory_source_scan_path,
            memory::sources::memory_source_import,
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
