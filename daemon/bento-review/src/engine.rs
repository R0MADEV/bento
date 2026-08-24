//! Running a full review: what gets sent to which agent, in what order, and
//! what the caller hears about it. The transports (the daemon's SSE endpoint
//! and its IPC socket, the CLI, the phone) only translate these events into
//! their own wire format.

use std::future::Future;
use std::pin::Pin;

use tokio::sync::mpsc::Sender;

use crate::diff::{batch_file_diffs, split_diff_into_file_diffs};
use crate::prompt::{build_review_prompt, build_synthesis_prompt, ReviewPromptInput};
use crate::vcs::{is_safe_branch, review_diff};

/// One agent call is at most this much diff. Bigger changes are split so no
/// single call is asked to hold more than it can actually reason about.
const BATCH_BUDGET: usize = 60_000;
/// How much of each report the consolidating agent gets to read.
const REPORT_BUDGET: usize = 8_000;

const SYNTHESIS_TAIL: &str = "Escribe el informe final directamente, sin preámbulo. Empieza con:\n\n**Veredicto:**";

/// What the caller learns while a review runs.
#[derive(Debug, PartialEq)]
pub enum ReviewEvent {
    /// Report text, as the agent produces it.
    Content(String),
    /// Starting stage `index` of `total`.
    Batch { index: usize, total: usize },
    /// Consolidating the reports into one.
    Synthesis,
    /// The session that can be resumed to ask follow-up questions.
    Session { agent: String, id: String },
    Error(String),
    Done,
}

pub struct ReviewRequest {
    pub cwd: String,
    pub base: String,
    pub context: String,
    pub agents: Vec<String>,
}

/// One agent call.
#[derive(Debug)]
pub struct Stage {
    pub agent: String,
    pub label: String,
    pub diff: String,
}

#[derive(Debug)]
pub struct Plan {
    pub stages: Vec<Stage>,
    pub synthesize: bool,
}

/// Decides the stages for a review: one per agent when several are compared
/// (each sees the whole change), otherwise one per batch of the diff. Pure,
/// so the decision is testable without running anything.
pub fn plan_stages(diff: &str, agents: &[String]) -> Plan {
    if agents.len() > 1 {
        let total = agents.len();
        let stages = agents
            .iter()
            .enumerate()
            .map(|(i, agent)| Stage {
                agent: agent.clone(),
                label: format!("Agente {}/{} ({})", i + 1, total, agent),
                diff: diff.to_string(),
            })
            .collect();
        return Plan { stages, synthesize: true };
    }

    let agent = agents.first().cloned().unwrap_or_else(|| "claude".to_string());
    let batches = batch_file_diffs(split_diff_into_file_diffs(diff), BATCH_BUDGET);
    let total = batches.len();
    let stages = batches
        .into_iter()
        .enumerate()
        .map(|(i, batch)| Stage {
            agent: agent.clone(),
            label: format!("Batch {}/{}", i + 1, total),
            diff: batch,
        })
        .collect();
    Plan { stages, synthesize: total > 1 }
}

/// Only the three agents the app knows how to drive, never client input
/// verbatim.
pub fn parse_agents(raw: &str) -> Vec<String> {
    let known: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|s| matches!(*s, "claude" | "opencode" | "codex"))
        .map(String::from)
        .collect();
    if known.is_empty() { vec!["claude".to_string()] } else { known }
}

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// How the engine runs one agent. Injected so the orchestration can be
/// tested without spawning anything.
pub trait AgentRunner: Send + Sync {
    fn run(&self, agent: &str, cwd: &str, prompt: &str, tx: Sender<String>) -> BoxFuture<'_, Option<(String, Option<String>)>>;
}

/// The real one: the agent CLIs, in read-only review mode.
pub struct Agents;

impl AgentRunner for Agents {
    fn run(&self, agent: &str, cwd: &str, prompt: &str, tx: Sender<String>) -> BoxFuture<'_, Option<(String, Option<String>)>> {
        let (agent, cwd, prompt) = (agent.to_string(), cwd.to_string(), prompt.to_string());
        Box::pin(async move { crate::agents::run_collecting(&agent, &cwd, &prompt, None, true, &tx).await })
    }
}

/// Reviews `base..branch` (or the working tree against `base`) and streams
/// the result. Validates its refs here rather than trusting the transport.
pub async fn run_review(request: &ReviewRequest, branch: Option<&str>, runner: &dyn AgentRunner, tx: &Sender<ReviewEvent>) {
    if !is_safe_branch(&request.base) {
        let _ = tx.send(ReviewEvent::Error("rama base inválida".into())).await;
        return;
    }
    if branch.is_some_and(|b| !is_safe_branch(b)) {
        let _ = tx.send(ReviewEvent::Error("rama inválida".into())).await;
        return;
    }
    let diff = match review_diff(&request.cwd, &request.base, branch) {
        Ok(diff) => diff,
        Err(e) => {
            let _ = tx.send(ReviewEvent::Error(e)).await;
            return;
        }
    };
    if diff.trim().is_empty() {
        let _ = tx.send(ReviewEvent::Error("No hay cambios respecto a la rama base.".into())).await;
        return;
    }
    run_planned(request, &diff, runner, tx).await;
}

/// The orchestration itself, over an already-gathered diff.
async fn run_planned(request: &ReviewRequest, diff: &str, runner: &dyn AgentRunner, tx: &Sender<ReviewEvent>) {
    let plan = plan_stages(diff, &request.agents);
    let total = plan.stages.len();

    // Agent text arrives on its own channel and is forwarded as Content, so
    // the runner doesn't need to know about review events at all.
    let (text_tx, mut text_rx) = tokio::sync::mpsc::channel::<String>(64);
    let forward_tx = tx.clone();
    let forwarding = tokio::spawn(async move {
        while let Some(text) = text_rx.recv().await {
            if forward_tx.send(ReviewEvent::Content(text)).await.is_err() {
                break;
            }
        }
    });

    let mut reports: Vec<(String, String)> = Vec::new();
    let mut session: Option<(String, String)> = None;

    for (i, stage) in plan.stages.iter().enumerate() {
        let _ = tx.send(ReviewEvent::Batch { index: i + 1, total }).await;
        let prompt = build_review_prompt(&ReviewPromptInput::new(&request.cwd, &request.base, &stage.diff, &request.context));
        match runner.run(&stage.agent, &request.cwd, &prompt, text_tx.clone()).await {
            Some((report, sid)) => {
                if let Some(id) = sid {
                    session = Some((stage.agent.clone(), id));
                }
                reports.push((stage.label.clone(), report));
            }
            None => {
                let _ = tx.send(ReviewEvent::Error(format!("{} no encontrado o falló", stage.agent))).await;
                drop(text_tx);
                let _ = forwarding.await;
                return;
            }
        }
    }

    if plan.synthesize && reports.len() >= 2 {
        let _ = tx.send(ReviewEvent::Synthesis).await;
        let truncated: Vec<(String, String)> = reports
            .iter()
            .map(|(label, report)| (label.clone(), report.chars().take(REPORT_BUDGET).collect()))
            .collect();
        let refs: Vec<(&str, &str)> = truncated.iter().map(|(l, r)| (l.as_str(), r.as_str())).collect();
        let prompt = build_synthesis_prompt(&refs, SYNTHESIS_TAIL);
        let agent = plan.stages.last().map(|s| s.agent.clone()).unwrap_or_default();
        match runner.run(&agent, &request.cwd, &prompt, text_tx.clone()).await {
            Some((_, Some(id))) => session = Some((agent, id)),
            Some(_) => {}
            None => {
                let _ = tx.send(ReviewEvent::Error("síntesis falló".into())).await;
                drop(text_tx);
                let _ = forwarding.await;
                return;
            }
        }
    }

    drop(text_tx);
    let _ = forwarding.await;
    if let Some((agent, id)) = session {
        let _ = tx.send(ReviewEvent::Session { agent, id }).await;
    }
    let _ = tx.send(ReviewEvent::Done).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    type AgentResult = Option<(String, Option<String>)>;

    // ── plan_stages: qué se le manda a cada agente ────────────────────────────

    #[test]
    fn one_agent_and_a_small_diff_is_a_single_stage_without_synthesis() {
        let plan = plan_stages("diff --git a/a.rs b/a.rs\n+x\n", &["claude".into()]);
        assert_eq!(plan.stages.len(), 1);
        assert!(!plan.synthesize, "una sola etapa no necesita síntesis");
        assert_eq!(plan.stages[0].agent, "claude");
    }

    #[test]
    fn several_agents_review_the_whole_diff_each() {
        let diff = "diff --git a/a.rs b/a.rs\n+x\n";
        let plan = plan_stages(diff, &["claude".into(), "codex".into()]);
        assert_eq!(plan.stages.len(), 2);
        assert!(plan.synthesize, "con dos informes hay que consolidar");
        assert_eq!(plan.stages[0].agent, "claude");
        assert_eq!(plan.stages[1].agent, "codex");
        assert_eq!(plan.stages[0].diff, diff, "cada agente ve el cambio entero");
        assert_eq!(plan.stages[1].diff, diff);
        assert!(plan.stages[0].label.contains("claude"));
    }

    #[test]
    fn one_agent_and_a_big_diff_is_split_into_batches() {
        let big: String = (0..40)
            .map(|i| format!("diff --git a/f{i}.rs b/f{i}.rs\n{}\n", "+línea de relleno".repeat(200)))
            .collect();
        let plan = plan_stages(&big, &["claude".into()]);
        assert!(plan.stages.len() > 1, "un diff grande no cabe en una sola llamada");
        assert!(plan.synthesize, "varios batches se consolidan al final");
        assert!(plan.stages[0].label.starts_with("Batch"));
        assert!(plan.stages.iter().all(|s| s.agent == "claude"));
    }

    // ── run: la orquestación, con un runner falso ─────────────────────────────

    #[derive(Default)]
    struct FakeRunner {
        reports: Mutex<Vec<AgentResult>>,
        calls: Mutex<Vec<String>>,
    }

    impl AgentRunner for FakeRunner {
        fn run(&self, agent: &str, _cwd: &str, prompt: &str, tx: tokio::sync::mpsc::Sender<String>) -> BoxFuture<'_, AgentResult> {
            self.calls.lock().unwrap().push(format!("{agent}:{}", &prompt[..prompt.len().min(12)]));
            let next = self.reports.lock().unwrap().remove(0);
            Box::pin(async move {
                if let Some((text, _)) = next.as_ref() {
                    let _ = tx.send(text.clone()).await;
                }
                next
            })
        }
    }

    async fn collect(diff: &str, agents: &[String], runner: FakeRunner) -> (Vec<ReviewEvent>, FakeRunner) {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let request = ReviewRequest {
            cwd: "/repo".into(), base: "main".into(), context: String::new(),
            agents: agents.to_vec(),
        };
        run_planned(&request, diff, &runner, &tx).await;
        drop(tx);
        let mut events = Vec::new();
        while let Some(e) = rx.recv().await {
            events.push(e);
        }
        (events, runner)
    }

    fn report(text: &str, session: Option<&str>) -> AgentResult {
        Some((text.to_string(), session.map(String::from)))
    }

    #[tokio::test]
    async fn a_single_stage_streams_its_report_and_finishes() {
        let runner = FakeRunner::default();
        *runner.reports.lock().unwrap() = vec![report("informe", Some("sess-1"))];
        let (events, _) = collect("diff --git a/a.rs b/a.rs\n+x\n", &["claude".into()], runner).await;
        assert!(matches!(events.first(), Some(ReviewEvent::Batch { index: 1, total: 1 })));
        assert!(events.iter().any(|e| matches!(e, ReviewEvent::Content(t) if t == "informe")));
        assert!(events.iter().any(|e| matches!(e, ReviewEvent::Session { agent, id } if agent == "claude" && id == "sess-1")));
        assert!(matches!(events.last(), Some(ReviewEvent::Done)));
        assert!(!events.iter().any(|e| matches!(e, ReviewEvent::Synthesis)));
    }

    #[tokio::test]
    async fn two_agents_are_consolidated_by_the_last_one() {
        let runner = FakeRunner::default();
        *runner.reports.lock().unwrap() = vec![
            report("informe A", None),
            report("informe B", None),
            report("consolidado", Some("sess-9")),
        ];
        let (events, runner) = collect("diff --git a/a.rs b/a.rs\n+x\n", &["claude".into(), "codex".into()], runner).await;
        assert!(events.iter().any(|e| matches!(e, ReviewEvent::Synthesis)));
        let calls = runner.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 3, "dos análisis y una síntesis");
        assert!(calls[2].starts_with("codex:"), "consolida el último agente");
        assert!(events.iter().any(|e| matches!(e, ReviewEvent::Session { agent, .. } if agent == "codex")));
    }

    #[tokio::test]
    async fn a_failing_agent_reports_the_error_and_stops() {
        let runner = FakeRunner::default();
        *runner.reports.lock().unwrap() = vec![None];
        let (events, runner) = collect("diff --git a/a.rs b/a.rs\n+x\n", &["claude".into()], runner).await;
        assert!(events.iter().any(|e| matches!(e, ReviewEvent::Error(m) if m.contains("claude"))));
        assert!(!events.iter().any(|e| matches!(e, ReviewEvent::Done)), "no se anuncia un final que no hubo");
        assert_eq!(runner.calls.lock().unwrap().len(), 1, "no sigue con más etapas");
    }

    #[tokio::test]
    async fn a_failing_synthesis_keeps_the_reports_already_streamed() {
        let runner = FakeRunner::default();
        *runner.reports.lock().unwrap() = vec![report("A", None), report("B", None), None];
        let (events, _) = collect("d\n", &["claude".into(), "codex".into()], runner).await;
        assert!(events.iter().any(|e| matches!(e, ReviewEvent::Content(t) if t == "A")));
        assert!(events.iter().any(|e| matches!(e, ReviewEvent::Error(_))));
    }

    // ── parse_agents ─────────────────────────────────────────────────────────

    #[test]
    fn parse_agents_keeps_only_known_names() {
        assert_eq!(parse_agents("claude,codex"), vec!["claude", "codex"]);
        assert_eq!(parse_agents(" claude , opencode "), vec!["claude", "opencode"]);
    }

    #[test]
    fn parse_agents_drops_anything_else_and_never_returns_empty() {
        assert_eq!(parse_agents("rm -rf /,claude"), vec!["claude"]);
        assert_eq!(parse_agents(""), vec!["claude"]);
        assert_eq!(parse_agents("desconocido"), vec!["claude"]);
    }
}
