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
            Some(cwd) => match crate::remote::review::list_branches(cwd) {
                Ok(branches) => send(ok(&req.id, json!(branches))),
                Err(error) => send(fail(&req.id, error)),
            },
            None => send(fail(&req.id, "cwd required".into())),
        },

        "review.files" => match &req.cwd {
            Some(cwd) => {
                let base = req.base.as_deref().unwrap_or("main");
                match bento_review::vcs::list_files_of(cwd, base, req.branch.as_deref()) {
                    Ok(list) => send(ok(&req.id, json!(list))),
                    Err(e) => send(fail(&req.id, e)),
                }
            }
            None => send(fail(&req.id, "cwd required".into())),
        },

        "review.file" => match (&req.cwd, &req.path) {
            (Some(cwd), Some(path)) => {
                let base = req.base.as_deref().unwrap_or("main");
                match bento_review::vcs::file_diff_of(cwd, path, base, req.branch.as_deref()) {
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
                // The branch reviewed, when the client named one; the sha, and
                // the branch when it didn't, are stamped by `save_checkpoint`.
                let cp = crate::remote::review::Checkpoint {
                    cwd: cwd.clone(),
                    base: base.clone(),
                    content: content.clone(),
                    saved_at: crate::remote::review::now_iso8601(),
                    run_id: req.run_id.clone(),
                    branch: req.branch.clone(),
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
            // Without the run id this only ever removed the runless entry, so
            // deleting a review from the history left its file untouched.
            (Some(cwd), Some(base)) => match crate::remote::review::delete_checkpoint(cwd, base, req.run_id.as_deref()) {
                Ok(()) => send(ok(&req.id, Value::Null)),
                Err(e) => send(fail(&req.id, e)),
            },
            _ => send(fail(&req.id, "cwd and base required".into())),
        },

        // Comentar una línea concreta del diff, que es lo que el escritorio
        // sabía hacer y la TUI no. El sha al que se ancla lo resuelve el
        // daemon desde la rama, igual que hace el panel con `git_rev_parse`.
        "review.pr_inline_comment" => match (&req.cwd, req.pr, &req.path, req.line, &req.data) {
            (Some(cwd), Some(pr), Some(path), Some(line), Some(body)) => {
                let reference = req.branch.clone().unwrap_or_else(|| "HEAD".into());
                match bento_review::vcs::git_cmd(cwd, &["rev-parse", &reference]) {
                    Ok(sha) => match crate::remote::review::add_review_comment(
                        cwd, pr, sha.trim(), path, line, req.start_line, body,
                    ) {
                        Ok(url) => send(ok(&req.id, json!(url))),
                        Err(e) => send(fail(&req.id, e)),
                    },
                    Err(e) => send(fail(&req.id, e)),
                }
            }
            _ => send(fail(&req.id, "cwd, pr, path, line and data required".into())),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs one request through the dispatch and returns what it answered.
    /// A client blocks on that answer, so "answered nothing" is a hang.
    fn dispatched(body: Value) -> Vec<Value> {
        let req: Request = serde_json::from_value(body).expect("request");
        let sent = std::sync::Mutex::new(Vec::new());
        let (out, _rx) = mpsc::unbounded_channel();
        let mut tasks = Vec::new();
        dispatch(
            &req.cmd.clone(),
            &req,
            &|line: String| sent.lock().unwrap().push(serde_json::from_str(&line).unwrap()),
            &out,
            &mut tasks,
        );
        sent.into_inner().unwrap()
    }

    fn error_of(body: Value) -> String {
        let answers = dispatched(body);
        assert_eq!(answers.len(), 1, "una respuesta y solo una");
        assert_eq!(answers[0]["ok"], json!(false));
        answers[0]["error"].as_str().unwrap_or_default().to_string()
    }

    #[test]
    fn every_review_command_answers_what_it_is_missing_instead_of_going_quiet() {
        // The socket client waits for the id it sent; a command that answers
        // nothing is a hung panel, not a no-op.
        for cmd in [
            "review.branches",
            "review.files",
            "review.file",
            "review.prs",
            "review.pr_diff",
            "review.ask",
            "review.run",
            "review.checkpoint_save",
            "review.checkpoint_get",
            "review.checkpoint_delete",
            "review.viewed",
            "review.viewed_set",
            "review.checkpoints",
            "review.pr_submit",
        ] {
            let error = error_of(json!({ "id": "1", "cmd": cmd }));
            assert!(error.contains("required"), "{cmd} contesta «{error}»");
        }
    }

    #[test]
    fn an_unknown_review_command_is_named_in_the_error() {
        assert_eq!(
            error_of(json!({ "id": "1", "cmd": "review.inventado" })),
            "unknown command: review.inventado",
        );
    }

    #[test]
    fn the_answer_carries_the_id_it_was_asked_with() {
        // Answers come back over one socket shared by every request; without
        // the id the client cannot tell which is which.
        let answers = dispatched(json!({ "id": "42", "cmd": "review.branches" }));
        assert_eq!(answers[0]["id"], json!("42"));
    }
}
