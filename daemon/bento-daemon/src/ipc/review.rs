//! The `review.*` half of the IPC dispatch: branches, files, PRs, the review
//! run itself and its checkpoints. Split out of `ipc/mod.rs` because the two
//! families have nothing to do with each other beyond sharing a socket.

use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::{fail, ok, spawn_review_stream, Request};

/// Handles one `review.*` command. `cmd` is already known to start with
/// `review.`; anything unknown answers like any other unknown command.
pub(crate) fn dispatch(
    cmd: &str,
    req: &Request,
    send: &impl Fn(String),
    out: &mpsc::UnboundedSender<String>,
    review_tasks: &mut Vec<tokio::task::JoinHandle<()>>,
) {
    match cmd {
        "review.branches" => match &req.cwd {
            Some(cwd) => send(ok(&req.id, json!(crate::remote::review::list_branches(cwd)))),
            None => send(fail(&req.id, "cwd required".into())),
        },

        "review.files" => match &req.cwd {
            Some(cwd) => {
                let base = req.base.as_deref().unwrap_or("main");
                match crate::remote::review::list_files(cwd, base) {
                    Ok(list) => send(ok(&req.id, json!(list))),
                    Err(e) => send(fail(&req.id, e)),
                }
            }
            None => send(fail(&req.id, "cwd required".into())),
        },

        "review.file" => match (&req.cwd, &req.path) {
            (Some(cwd), Some(path)) => {
                let base = req.base.as_deref().unwrap_or("main");
                match crate::remote::review::file_diff(cwd, path, base) {
                    Ok(diff) => send(ok(&req.id, json!(diff))),
                    Err(e) => send(fail(&req.id, e)),
                }
            }
            _ => send(fail(&req.id, "cwd and path required".into())),
        },

        "review.prs" => match &req.cwd {
            Some(cwd) => match crate::remote::review::list_prs(cwd) {
                Ok(json_str) => {
                    let data = serde_json::from_str::<Value>(&json_str).unwrap_or(Value::Null);
                    send(ok(&req.id, data));
                }
                Err(e) => send(fail(&req.id, e)),
            },
            None => send(fail(&req.id, "cwd required".into())),
        },

        "review.pr_diff" => match (&req.cwd, req.pr) {
            (Some(cwd), Some(pr)) => match crate::remote::review::pr_diff(cwd, pr) {
                Ok(diff) => send(ok(&req.id, json!(diff))),
                Err(e) => send(fail(&req.id, e)),
            },
            _ => send(fail(&req.id, "cwd and pr required".into())),
        },

        "review.pr_checks" => match (&req.cwd, req.pr) {
            (Some(cwd), Some(pr)) => match bento_review::pr::checks(cwd, pr) {
                Ok(data) => send(ok(&req.id, data)),
                Err(e) => send(fail(&req.id, e)),
            },
            _ => send(fail(&req.id, "cwd and pr required".into())),
        },

        "review.pr_review_comments" => match (&req.cwd, req.pr) {
            (Some(cwd), Some(pr)) => match bento_review::pr::list_review_comments(cwd, pr) {
                Ok(data) => send(ok(&req.id, data)),
                Err(e) => send(fail(&req.id, e)),
            },
            _ => send(fail(&req.id, "cwd and pr required".into())),
        },

        "review.pr_comments" => match (&req.cwd, req.pr) {
            (Some(cwd), Some(pr)) => match crate::remote::review::pr_comments(cwd, pr) {
                Ok(data) => send(ok(&req.id, data)),
                Err(e) => send(fail(&req.id, e)),
            },
            _ => send(fail(&req.id, "cwd and pr required".into())),
        },

        "review.pr_comment_add" => match (&req.cwd, req.pr, &req.data) {
            (Some(cwd), Some(pr), Some(body)) => match crate::remote::review::add_comment(cwd, pr, body) {
                Ok(_) => send(ok(&req.id, Value::Null)),
                Err(e) => send(fail(&req.id, e)),
            },
            _ => send(fail(&req.id, "cwd, pr and data required".into())),
        },

        "review.pr_comment_update" => match (&req.cwd, req.pr, req.comment_id, &req.data) {
            (Some(cwd), Some(pr), Some(id), Some(body)) => {
                match crate::remote::review::update_comment(cwd, pr, id, body) {
                    Ok(()) => send(ok(&req.id, Value::Null)),
                    Err(e) => send(fail(&req.id, e)),
                }
            }
            _ => send(fail(&req.id, "cwd, pr, comment_id and data required".into())),
        },

        "review.pr_comment_delete" => match (&req.cwd, req.pr, req.comment_id) {
            (Some(cwd), Some(pr), Some(id)) => match crate::remote::review::delete_comment(cwd, pr, id) {
                Ok(()) => send(ok(&req.id, Value::Null)),
                Err(e) => send(fail(&req.id, e)),
            },
            _ => send(fail(&req.id, "cwd, pr and comment_id required".into())),
        },

        "review.ask" => match (&req.cwd, &req.question) {
            (Some(cwd), Some(question)) => {
                let cwd = cwd.clone();
                let base = req.base.clone().unwrap_or_else(|| "main".into());
                let agent = req.agent.clone().unwrap_or_else(|| "claude".into());
                let question = question.clone();
                send(ok(&req.id, json!({ "started": true })));
                let tx = spawn_review_stream(out.clone());
                review_tasks.push(tokio::spawn(async move {
                    crate::remote::review::ask(&cwd, &base, &agent, &question, tx).await;
                }));
            }
            _ => send(fail(&req.id, "cwd and question required".into())),
        },

        "review.run" => match &req.cwd {
            Some(cwd) => {
                let cwd = cwd.clone();
                let base = req.base.clone().unwrap_or_else(|| "main".into());
                let branch = req.branch.clone();
                let context = req.context.clone().unwrap_or_default();
                let agents = req.agents.clone().unwrap_or_default();
                send(ok(&req.id, json!({ "started": true })));
                let tx = spawn_review_stream(out.clone());
                review_tasks.push(tokio::spawn(async move {
                    crate::remote::review::run_review(cwd, base, branch, context, agents, tx).await;
                }));
            }
            None => send(fail(&req.id, "cwd required".into())),
        },

        "review.checkpoint_save" => match (&req.cwd, &req.base, &req.content) {
            (Some(cwd), Some(base), Some(content)) => {
                // Sent by the client so the saves one review makes as it
                // goes land on one entry, and two reviews of the same branch
                // do not overwrite each other.
                let cp = crate::remote::review::Checkpoint {
                    cwd: cwd.clone(),
                    base: base.clone(),
                    content: content.clone(),
                    saved_at: crate::remote::review::now_iso8601(),
                    run_id: req.run_id.clone(),
                    branch: None,
                    commit: None,
                    session_id: req.session_id.clone(),
                    session_agent: req.agent.clone(),
                };
                match crate::remote::review::save_checkpoint(&cp) {
                    Ok(()) => send(ok(&req.id, Value::Null)),
                    Err(e) => send(fail(&req.id, e)),
                }
            }
            _ => send(fail(&req.id, "cwd, base and content required".into())),
        },

        "review.viewed" => match (&req.cwd, &req.base) {
            (Some(cwd), Some(base)) => send(ok(&req.id, json!(bento_review::viewed::get(cwd, base)))),
            _ => send(fail(&req.id, "cwd and base required".into())),
        },

        "review.viewed_set" => match (&req.cwd, &req.base, &req.paths) {
            (Some(cwd), Some(base), Some(paths)) => match bento_review::viewed::set(cwd, base, paths) {
                Ok(()) => send(ok(&req.id, Value::Null)),
                Err(e) => send(fail(&req.id, e)),
            },
            _ => send(fail(&req.id, "cwd, base and paths required".into())),
        },

        "review.checkpoints" => match &req.cwd {
            Some(cwd) => send(ok(&req.id, json!(crate::remote::review::list_checkpoint_metas(cwd)))),
            None => send(fail(&req.id, "cwd required".into())),
        },

        "review.checkpoint_get" => match (&req.cwd, &req.base) {
            // With a run id, that specific review; without one, the latest
            // for the branch — which is what a client that predates the
            // history list still asks for.
            (Some(cwd), Some(base)) => {
                let found = match &req.run_id {
                    Some(run) => bento_review::checkpoints::get_run(cwd, base, run),
                    None => crate::remote::review::get_checkpoint(cwd, base),
                };
                match found {
                    Some(cp) => send(ok(&req.id, serde_json::to_value(&cp).unwrap_or(Value::Null))),
                    None => send(fail(&req.id, "no hay checkpoint guardado".into())),
                }
            }
            _ => send(fail(&req.id, "cwd and base required".into())),
        },

        "review.checkpoint_delete" => match (&req.cwd, &req.base) {
            (Some(cwd), Some(base)) => match crate::remote::review::delete_checkpoint(cwd, base) {
                Ok(()) => send(ok(&req.id, Value::Null)),
                Err(e) => send(fail(&req.id, e)),
            },
            _ => send(fail(&req.id, "cwd and base required".into())),
        },

        "review.pr_submit" => match (&req.cwd, req.pr, &req.event) {
            (Some(cwd), Some(pr), Some(event)) => {
                match crate::remote::review::submit_review(cwd, pr, event, req.data.as_deref().unwrap_or_default()) {
                    Ok(_) => send(ok(&req.id, Value::Null)),
                    Err(e) => send(fail(&req.id, e)),
                }
            }
            _ => send(fail(&req.id, "cwd, pr and event required".into())),
        },
        other => send(fail(&req.id, format!("unknown command: {other}"))),
    }
}
