//! Running a full review: what gets sent to which agent, in what order, and
//! what the caller hears about it. The transports (the daemon's SSE endpoint
//! and its IPC socket, the CLI, the phone) only translate these events into
//! their own wire format.

use std::future::Future;
use std::pin::Pin;

use tokio::sync::mpsc::Sender;

use crate::diff::{batch_file_diffs, split_diff_into_file_diffs};
use crate::prompt::{build_review_prompt, build_synthesis_prompt, ReviewPromptFile, ReviewPromptInput};
use crate::vcs::{is_safe_branch, review_diff};
use crate::worktree::{prepare_branch_context, release_managed_context_path, set_review_worktree_writable};

/// One agent call is at most this much diff. Bigger changes are split so no
/// single call is asked to hold more than it can actually reason about.
const BATCH_BUDGET: usize = 60_000;

const SYNTHESIS_TAIL: &str = "Escribe el informe final directamente, sin preámbulo. Empieza con:\n\n**Veredicto:**";

/// What the caller learns while a review runs.
#[derive(Debug, PartialEq)]
pub enum ReviewEvent {
    /// Report text, as the agent produces it.
    Content(String),
    /// La herramienta que el agente acaba de usar. Es lo único visible mientras
    /// piensa, y la evidencia de qué miró.
    Tool(String),
    /// Starting stage `index` of `total`. `label` is the stage's own name,
    /// which already distinguishes an agent pass ("Agente 1/3 (codex)") from
    /// a slice of a large diff ("Batch 1/3") — calling both "pass N" claims
    /// three agents ran when one read the diff in three pieces.
    Batch { index: usize, total: usize, label: String },
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
    /// The agent that reads the others' analyses and writes the final report.
    /// It does not analyse itself: with three agents that would be a fourth
    /// call, and an opinion the same agent then grades.
    pub verifier: Option<String>,
}

/// Decides the stages for a review: one per agent when several are compared
/// (each sees the whole change), otherwise one per batch of the diff. Pure,
/// so the decision is testable without running anything.
pub fn plan_stages(diff: &str, agents: &[String]) -> Plan {
    if agents.len() > 1 {
        // The last one is the verifier and does not analyse; the rest each see
        // the whole change.
        let (analysts, verifier) = agents.split_at(agents.len() - 1);
        let total = analysts.len();
        let stages = analysts
            .iter()
            .enumerate()
            .map(|(i, agent)| Stage {
                agent: agent.clone(),
                label: format!("Agente {}/{} ({})", i + 1, total, agent),
                diff: diff.to_string(),
            })
            .collect();
        return Plan { stages, synthesize: true, verifier: verifier.first().cloned() };
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
    Plan { stages, synthesize: total > 1, verifier: None }
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
        Box::pin(async move {
            let tools = tx.clone();
            // El mismo canal que el texto, con marca: el cliente decide si lo
            // enseña como progreso o lo guarda como evidencia.
            let mut on_tool = move |tool: String| { let _ = tools.try_send(format!("[TOOL] {tool}")); };
            crate::agents::run_collecting_with_tools(&agent, &cwd, &prompt, None, true, &tx, &mut on_tool).await
        })
    }
}

/// Reviews `base..branch` (or the working tree against `base`) and streams
/// the result. Validates its refs here rather than trusting the transport.
pub async fn run_review(request: &ReviewRequest, branch: Option<&str>, runner: &dyn AgentRunner, tx: &Sender<ReviewEvent>) {
    run_review_cancellable(request, branch, runner, tx, &CancelToken::default()).await
}

/// The same, stoppable. Callers with a Stop button pass a token and trip it;
/// the agents are killed rather than merely stopped being listened to.
pub async fn run_review_cancellable(
    request: &ReviewRequest,
    branch: Option<&str>,
    runner: &dyn AgentRunner,
    tx: &Sender<ReviewEvent>,
    cancel: &CancelToken,
) {
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

    // Revisar una rama concreta se hace sobre un worktree aparte y de solo
    // lectura: sin él, el agente lee (y podría tocar) el árbol en el que estás
    // trabajando, y lo que revisa cambia bajo sus pies mientras escribes.
    let isolated = branch.and_then(|branch| match prepare_branch_context(&request.cwd, branch, None, false) {
        Ok(context) if context.managed => {
            let _ = set_review_worktree_writable(std::path::Path::new(&context.path), false);
            Some(context)
        }
        Ok(_) => None,
        Err(_) => None,
    });
    let review_cwd = isolated.as_ref().map(|c| c.path.clone()).unwrap_or_else(|| request.cwd.clone());

    let scoped = ReviewRequest { cwd: review_cwd, ..clone_request(request) };
    run_planned_cancellable(&scoped, &diff, runner, tx, cancel).await;

    if let Some(context) = isolated {
        let path = std::path::Path::new(&context.path);
        let _ = set_review_worktree_writable(path, true);
        let _ = release_managed_context_path(path);
    }
}

/// `ReviewRequest` no es `Clone` a propósito (lleva el diff entero en algunos
/// llamantes); esto copia solo lo que necesita la ejecución aislada.
fn clone_request(request: &ReviewRequest) -> ReviewRequest {
    ReviewRequest {
        cwd: request.cwd.clone(),
        base: request.base.clone(),
        context: request.context.clone(),
        agents: request.agents.clone(),
    }
}

/// Shared "stop now" flag for a running review.
///
/// Checked between stages and raced against each agent call. The agents are
/// spawned with `kill_on_drop`, so dropping the call's future is what actually
/// kills the process — aborting only the task that reads them leaves them
/// running and billing while the UI says "cancelado".
#[derive(Clone, Default)]
pub struct CancelToken(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl CancelToken {
    pub fn cancel(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Resolves when cancelled. Polled rather than notified: a review is
    /// minutes long, so a tick of latency costs nothing and this keeps the
    /// token a plain flag anything can read.
    async fn cancelled(&self) {
        while !self.is_cancelled() {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    /// Runs `work` unless cancellation wins the race. Returning None means the
    /// future was dropped, which for an agent call means its process is gone.
    async fn guard<T>(&self, work: impl std::future::Future<Output = T>) -> Option<T> {
        tokio::select! {
            biased;
            _ = self.cancelled() => None,
            result = work => Some(result),
        }
    }
}

/// A text channel for one stage. Its report is accumulated rather than
/// forwarded, so parallel stages cannot interleave their text; tool lines are
/// forwarded live, because progress is the only thing worth seeing while
/// several agents think at once.
fn collect_text(tx: &Sender<ReviewEvent>) -> (tokio::sync::mpsc::Sender<String>, tokio::task::JoinHandle<String>) {
    let (text_tx, mut text_rx) = tokio::sync::mpsc::channel::<String>(64);
    let tool_tx = tx.clone();
    let collecting = tokio::spawn(async move {
        let mut report = String::new();
        while let Some(text) = text_rx.recv().await {
            match text.strip_prefix("[TOOL] ") {
                Some(tool) => {
                    if tool_tx.send(ReviewEvent::Tool(tool.to_string())).await.is_err() {
                        break;
                    }
                }
                None => report.push_str(&text),
            }
        }
        report
    });
    (text_tx, collecting)
}

/// Total characters of file content the prompt may carry, and the floor each
/// file gets regardless of how many there are. Same numbers as the desktop
/// panel, so a review reads the same wherever it was launched from.
const CONTENT_BUDGET: usize = 150_000;
const MIN_FILE_BUDGET: usize = 800;

/// The changed files as the prompt carries them: one entry per file, each cut
/// to its share of the budget. Sending only the diff leaves the agent
/// guessing at everything the hunks do not show.
fn prompt_files(diff: &str) -> Vec<ReviewPromptFile> {
    let chunks = crate::diff::split_diff_into_file_diffs(diff);
    let per_file = (CONTENT_BUDGET / chunks.len().max(1)).max(MIN_FILE_BUDGET);
    chunks
        .into_iter()
        .map(|chunk| {
            let path = chunk
                .lines()
                .find_map(|line| line.strip_prefix("+++ b/"))
                .unwrap_or("(desconocido)")
                .to_string();
            // Truncated with a note rather than silently: half a file handed
            // over as if it were whole is how an agent invents what is missing.
            let content = match chunk.chars().count() > per_file {
                true => format!(
                    "{}\n[truncado; lee el resto en el worktree]",
                    chunk.chars().take(per_file).collect::<String>()
                ),
                false => chunk,
            };
            ReviewPromptFile { path, content }
        })
        .collect()
}

/// What to ask lexis about: the paths the diff touches. Asking about the
/// diff itself would blow past any sane query length and match nothing.
/// Unique per run, so two reviews at once do not overwrite each other's
/// analyses.
fn run_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

fn lexis_question(diff: &str) -> String {
    let mut paths: Vec<&str> = diff
        .lines()
        .filter_map(|line| line.strip_prefix("+++ b/"))
        .collect();
    paths.dedup();
    paths.truncate(20);
    let targets = match paths.is_empty() {
        true => "the recent changes".to_string(),
        false => paths.join(", "),
    };
    // Word for word what the desktop panel asks, so a review gets the same
    // context wherever it was launched from. Bare paths returned whatever
    // lexis thought relevant; this asks for what a reviewer actually needs.
    format!(
        "Build a compact review bundle for: {targets}. \
         Return impact, callers, definitions, tests, risks and likely blast radius. \
         Prefer structured evidence over prose."
    )
}

/// The orchestration itself, over an already-gathered diff.
async fn run_planned_cancellable(
    request: &ReviewRequest,
    diff: &str,
    runner: &dyn AgentRunner,
    tx: &Sender<ReviewEvent>,
    cancel: &CancelToken,
) {
    let plan = plan_stages(diff, &request.agents);
    let total = plan.stages.len();

    let mut reports: Vec<(String, String)> = Vec::new();
    let mut session: Option<(String, String)> = None;

    // Every stage at once, the way the desktop panel does it: three agents one
    // after another take three times as long for the same result. Their text
    // is collected per stage instead of streamed, because three agents writing
    // into one buffer interleave into nonsense; each report is emitted whole,
    // under its own heading, in the order the agents were chosen — not the
    // order they happened to finish.
    // Context from code the diff does not show — who calls what changed.
    // Asked once and shared by every stage: it is the same question, and one
    // lexis call per agent would triple the wait for identical text.
    let lexis_context = crate::lexis::context(&request.cwd, &lexis_question(diff)).await;

    // Taken before the agents start and compared at the end: findings point at
    // line numbers, and a repo edited mid-review moves them. A silent stale
    // report is worse than a slow one.
    let snapshot_before = crate::snapshot::snapshot(&request.cwd).ok();

    let attempts = futures::future::join_all(plan.stages.iter().map(|stage| {
        let mut input = ReviewPromptInput::new(&request.cwd, &request.base, &stage.diff, &request.context);
        input.files = prompt_files(&stage.diff);
        input.lexis_context = lexis_context.clone();
        if !lexis_context.is_empty() {
            input.context_sources.push("lexis".to_string());
        }
        let prompt = build_review_prompt(&input);
        async move {
            let (text_tx, collecting) = collect_text(tx);
            // Un fallo pasajero (límite de peticiones, red) se reintenta una vez:
            // perder veinte minutos de review por un 429 es absurdo. Un timeout no
            // se reintenta — ver `agents::is_retryable`.
            let mut attempt = cancel.guard(runner.run(&stage.agent, &request.cwd, &prompt, text_tx.clone())).await.flatten();
            if attempt.is_none() && !cancel.is_cancelled() {
                let _ = tx.send(ReviewEvent::Tool(format!("reintentando {}", stage.agent))).await;
                attempt = cancel.guard(runner.run(&stage.agent, &request.cwd, &prompt, text_tx.clone())).await.flatten();
            }
            drop(text_tx);
            (attempt, collecting.await.unwrap_or_default())
        }
    }))
    .await;

    if cancel.is_cancelled() {
        let _ = tx.send(ReviewEvent::Error("review cancelada".into())).await;
        return;
    }

    for (i, (stage, (attempt, streamed))) in plan.stages.iter().zip(attempts).enumerate() {
        let _ = tx.send(ReviewEvent::Batch { index: i + 1, total, label: stage.label.clone() }).await;
        match attempt {
            Some((report, sid)) => {
                if let Some(id) = sid {
                    session = Some((stage.agent.clone(), id));
                }
                // The collected stream is what the user sees; the returned
                // report is what the verifier reads. They are the same text
                // when the agent streams it, and the stream is the fallback
                // for one that does not.
                let shown = if streamed.trim().is_empty() { report.clone() } else { streamed };
                let _ = tx.send(ReviewEvent::Content(shown)).await;
                reports.push((stage.label.clone(), report));
            }
            None => {
                let _ = tx.send(ReviewEvent::Error(format!("{} no encontrado o falló", stage.agent))).await;
                return;
            }
        }
    }

    if plan.synthesize && reports.len() >= 2 {
        let _ = tx.send(ReviewEvent::Synthesis).await;
        // Written to disk and handed over as paths: pasting them in meant
        // cutting each analysis to fit one prompt, so the verifier judged on
        // material that stopped mid-sentence.
        let dir = match crate::reports::ReportDir::new(&run_id()) {
            Ok(dir) => dir,
            Err(error) => {
                let _ = tx.send(ReviewEvent::Error(format!("no se pudieron guardar los análisis: {error}"))).await;
                return;
            }
        };
        let mut written: Vec<(String, String)> = Vec::new();
        for (i, (label, report)) in reports.iter().enumerate() {
            match dir.write(i + 1, label, report) {
                Ok(path) => written.push((label.clone(), path.display().to_string())),
                Err(error) => {
                    let _ = tx.send(ReviewEvent::Error(format!("no se pudo guardar {label}: {error}"))).await;
                    return;
                }
            }
        }
        let refs: Vec<(&str, &str)> = written.iter().map(|(l, p)| (l.as_str(), p.as_str())).collect();
        // The verifier gets the whole review prompt, not just the other
        // reports: it did not analyse in the first round, so this is its only
        // sight of the change. Without it, it grades findings it cannot check.
        let mut input = ReviewPromptInput::new(&request.cwd, &request.base, diff, &request.context);
        input.files = prompt_files(diff);
        input.lexis_context = lexis_context.clone();
        if !lexis_context.is_empty() {
            input.context_sources.push("lexis".to_string());
        }
        let review_prompt = build_review_prompt(&input);
        let prompt = build_synthesis_prompt(&refs, &format!("{review_prompt}\n\n{SYNTHESIS_TAIL}"));
        let agent = plan
            .verifier
            .clone()
            .or_else(|| plan.stages.last().map(|s| s.agent.clone()))
            .unwrap_or_default();
        let (text_tx, collecting) = collect_text(tx);
        let attempt = match cancel.guard(runner.run(&agent, &request.cwd, &prompt, text_tx.clone())).await {
            Some(attempt) => attempt,
            None => {
                let _ = tx.send(ReviewEvent::Error("review cancelada".into())).await;
                return;
            }
        };
        drop(text_tx);
        let streamed = collecting.await.unwrap_or_default();
        if !streamed.trim().is_empty() {
            let _ = tx.send(ReviewEvent::Content(streamed)).await;
        }
        match attempt {
            Some((_, Some(id))) => session = Some((agent, id)),
            Some(_) => {}
            None => {
                let _ = tx.send(ReviewEvent::Error("síntesis falló".into())).await;
                return;
            }
        }
    }

    // Only reported when we have both fingerprints: failing to take one is not
    // evidence that anything changed.
    if let Some(before) = snapshot_before {
        if crate::snapshot::snapshot(&request.cwd).ok().is_some_and(|after| after != before) {
            let _ = tx
                .send(ReviewEvent::Tool(
                    "el repositorio cambió durante la review; los hallazgos pueden estar desfasados".into(),
                ))
                .await;
        }
    }
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
        // Three agents: two analyse, the third verifies them.
        let plan = plan_stages(diff, &["claude".into(), "codex".into(), "opencode".into()]);
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
            // The whole prompt: some tests assert on what the agent was told,
            // not just which agent was called.
            self.calls.lock().unwrap().push(format!("{agent}:{prompt}"));
            let next = self.reports.lock().unwrap().remove(0);
            Box::pin(async move {
                if let Some((text, _)) = next.as_ref() {
                    let _ = tx.send(text.clone()).await;
                }
                next
            })
        }
    }

    /// Each agent's text must land between its own Batch marker and the next
    /// one. Forwarding it through a separate task let the markers overtake it,
    /// so the report showed empty headings followed by one wall of text.
    #[tokio::test]
    async fn each_stages_text_arrives_before_the_next_stage_is_announced() {
        let runner = FakeRunner {
            reports: Mutex::new(vec![
                Some(("informe de uno".into(), None)),
                Some(("informe de dos".into(), None)),
                Some(("la sintesis".into(), None)),
            ]),
            calls: Mutex::new(Vec::new()),
        };
        // Two analyses means three agents now, the third being the verifier.
        let agents = vec!["uno".to_string(), "dos".to_string(), "tres".to_string()];

        let (events, _) = collect("diff --git a/x b/x\n+1\n", &agents, runner).await;

        let order: Vec<String> = events
            .iter()
            .filter_map(|e| match e {
                ReviewEvent::Batch { index, .. } => Some(format!("batch{index}")),
                ReviewEvent::Content(text) if text.starts_with("informe") => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            order,
            vec!["batch1", "informe de uno", "batch2", "informe de dos"],
            "el texto de cada pasada tiene que ir bajo su propia cabecera"
        );
    }

    /// Three agents: the first two analyse the whole change and the third
    /// verifies their analyses without producing one of its own.
    #[tokio::test]
    async fn three_agents_analyse_and_the_last_one_verifies_them() {
        let runner = FakeRunner {
            reports: Mutex::new(vec![
                Some(("analisis uno".into(), None)),
                Some(("analisis dos".into(), None)),
                Some(("verificacion".into(), None)),
            ]),
            calls: Mutex::new(Vec::new()),
        };
        let agents = vec!["uno".to_string(), "dos".to_string(), "tres".to_string()];

        let (events, runner) = collect("diff --git a/x b/x\n+1\n", &agents, runner).await;

        let calls = runner.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 3, "dos analisis y una verificacion: {calls:?}");
        assert!(calls[0].starts_with("uno:"));
        assert!(calls[1].starts_with("dos:"));
        assert!(calls[2].starts_with("tres:"), "el tercero solo verifica: {calls:?}");
        assert!(events.iter().any(|e| matches!(e, ReviewEvent::Synthesis)));
    }

    /// Counts how many agents are inside `run` at the same moment. Sequential
    /// orchestration never gets past one.
    struct ConcurrencyProbe {
        in_flight: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        peak: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    impl AgentRunner for ConcurrencyProbe {
        fn run(&self, _agent: &str, _cwd: &str, _prompt: &str, _tx: tokio::sync::mpsc::Sender<String>) -> BoxFuture<'_, AgentResult> {
            use std::sync::atomic::Ordering::SeqCst;
            let (in_flight, peak) = (self.in_flight.clone(), self.peak.clone());
            Box::pin(async move {
                let now = in_flight.fetch_add(1, SeqCst) + 1;
                peak.fetch_max(now, SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                in_flight.fetch_sub(1, SeqCst);
                Some(("informe".to_string(), None))
            })
        }
    }

    /// Desktop runs every analysis at once (`Promise.all`); three agents one
    /// after another take three times as long for the same result.
    #[tokio::test]
    async fn the_analyses_run_at_the_same_time() {
        use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
        let peak = std::sync::Arc::new(AtomicUsize::new(0));
        let runner = ConcurrencyProbe {
            in_flight: std::sync::Arc::new(AtomicUsize::new(0)),
            peak: peak.clone(),
        };
        let agents = vec!["uno".to_string(), "dos".to_string(), "tres".to_string()];

        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let request = ReviewRequest {
            cwd: "/repo".into(), base: "main".into(), context: String::new(),
            agents: agents.clone(),
        };
        let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
        run_planned_cancellable(&request, "diff --git a/x b/x\n+1\n", &runner, &tx, &CancelToken::default()).await;
        drop(tx);
        let _ = drain.await;

        // Two analysts overlap; the third only verifies, afterwards.
        assert_eq!(peak.load(SeqCst), 2, "los análisis tienen que solaparse");
    }

    #[test]
    fn the_lexis_question_names_the_touched_paths() {
        let diff = "diff --git a/src/uno.rs b/src/uno.rs\n--- a/src/uno.rs\n+++ b/src/uno.rs\n+cambio\n\
                    diff --git a/src/dos.rs b/src/dos.rs\n+++ b/src/dos.rs\n+otro\n";
        let question = lexis_question(diff);
        assert!(question.contains("src/uno.rs"));
        assert!(question.contains("src/dos.rs"));
    }

    #[test]
    fn the_lexis_question_asks_for_what_a_reviewer_needs() {
        // Bare paths get whatever lexis considers relevant. The desktop app
        // asks for impact, callers, tests and blast radius, and got better
        // context for it; the engine has to ask for the same or the desktop
        // loses ground by moving onto it.
        let question = lexis_question("diff --git a/x.rs b/x.rs\n+++ b/x.rs\n+y\n").to_lowercase();
        for wanted in ["impact", "caller", "test", "risk"] {
            assert!(question.contains(wanted), "falta '{wanted}' en: {question}");
        }
    }

    #[test]
    fn a_diff_with_no_recognisable_paths_still_asks_something() {
        assert!(lexis_question("").contains("the recent changes"));
    }

    #[test]
    fn every_changed_file_reaches_the_prompt_with_its_own_slice_of_the_budget() {
        let diff = "diff --git a/uno.rs b/uno.rs\n+++ b/uno.rs\n+a\n\
                    diff --git a/dos.rs b/dos.rs\n+++ b/dos.rs\n+b\n";
        let files = prompt_files(diff);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "uno.rs");
        assert_eq!(files[1].path, "dos.rs");
        assert!(files[0].content.contains("+a"));
    }

    #[test]
    fn a_file_over_its_budget_is_cut_and_says_so() {
        // Desktop's rule: truncate and tell the agent the rest is on disk,
        // rather than silently handing it half a file as if it were whole.
        // One file gets the whole budget, so it has to exceed that to be cut.
        let huge = "x".repeat(CONTENT_BUDGET + 500);
        let diff = format!("diff --git a/uno.rs b/uno.rs\n+++ b/uno.rs\n+{huge}\n");
        let files = prompt_files(&diff);
        assert!(files[0].content.len() < huge.len());
        assert!(files[0].content.contains("truncado"));
    }

    #[test]
    fn many_files_still_get_a_readable_minimum_each() {
        // 300 files would divide the budget into slivers; the floor is what
        // keeps each one worth reading.
        let diff: String = (0..300)
            .map(|i| format!("diff --git a/f{i}.rs b/f{i}.rs\n+++ b/f{i}.rs\n+linea\n"))
            .collect();
        let files = prompt_files(&diff);
        assert_eq!(files.len(), 300);
        assert!(files[0].content.contains("linea"));
    }

    /// A repo edited while the agents read it moves every line number in the
    /// findings. Saying nothing turns a stale report into a wrong one.
    #[tokio::test]
    async fn a_repository_edited_mid_review_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| {
            std::process::Command::new("git").args(args).current_dir(dir.path()).output().unwrap();
        };
        run(&["init"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(dir.path().join("uno.txt"), "hola").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "uno"]);

        // The fake writes to the repo while "reviewing", which is exactly the
        // race the snapshot exists to catch.
        struct Meddler(std::path::PathBuf);
        impl AgentRunner for Meddler {
            fn run(&self, _a: &str, _c: &str, _p: &str, _tx: tokio::sync::mpsc::Sender<String>) -> BoxFuture<'_, AgentResult> {
                let path = self.0.clone();
                Box::pin(async move {
                    std::fs::write(path.join("uno.txt"), "editado a mitad").unwrap();
                    Some(("informe".to_string(), None))
                })
            }
        }

        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let request = ReviewRequest {
            cwd: dir.path().to_str().unwrap().to_string(),
            base: "main".into(),
            context: String::new(),
            agents: vec!["uno".into()],
        };
        let collected = tokio::spawn(async move {
            let mut events = Vec::new();
            while let Some(e) = rx.recv().await { events.push(e); }
            events
        });
        run_planned_cancellable(&request, "diff --git a/uno.txt b/uno.txt\n+++ b/uno.txt\n+x\n", &Meddler(dir.path().to_path_buf()), &tx, &CancelToken::default()).await;
        drop(tx);
        let events = collected.await.unwrap();

        assert!(
            events.iter().any(|e| matches!(e, ReviewEvent::Tool(msg) if msg.contains("cambió durante la review"))),
            "tenía que avisar de que el repo cambió: {events:?}"
        );
    }

    #[test]
    fn with_several_agents_the_last_one_only_verifies() {
        // Three agents means two analyses and one verification, not three
        // analyses: the third's job is to judge the other two, and having it
        // also analyse costs a fourth call for an opinion it then grades
        // itself on.
        let plan = plan_stages("diff", &["uno".into(), "dos".into(), "tres".into()]);

        assert_eq!(plan.stages.len(), 2, "solo analizan los dos primeros");
        assert_eq!(plan.stages[0].agent, "uno");
        assert_eq!(plan.stages[1].agent, "dos");
        assert_eq!(plan.verifier.as_deref(), Some("tres"));
    }

    #[test]
    fn with_two_agents_one_analyses_and_the_other_reviews_it() {
        let plan = plan_stages("diff", &["uno".into(), "dos".into()]);

        assert_eq!(plan.stages.len(), 1);
        assert_eq!(plan.stages[0].agent, "uno");
        assert_eq!(plan.verifier.as_deref(), Some("dos"));
    }

    #[test]
    fn a_single_agent_has_nobody_to_verify_it() {
        let plan = plan_stages("diff --git a/x b/x\n+1\n", &["uno".into()]);

        assert!(plan.verifier.is_none());
        assert!(!plan.stages.is_empty());
    }

    /// The verifier no longer analyses in the first round, so the synthesis
    /// call is its only look at the change. Handing it just the other reports
    /// leaves it grading claims it cannot check.
    #[tokio::test]
    async fn the_verifier_is_given_the_change_it_is_judging() {
        let runner = FakeRunner::default();
        *runner.reports.lock().unwrap() =
            vec![report("A", None), report("B", None), report("final", None)];
        let agents = ["uno".into(), "dos".into(), "tres".into()];
        let diff = "diff --git a/marcador.rs b/marcador.rs\n+++ b/marcador.rs\n+cambio\n";

        let (_, runner) = collect(diff, &agents, runner).await;

        let calls = runner.calls.lock().unwrap().clone();
        let verification = calls.last().unwrap();
        assert!(
            verification.contains("Eres un ingeniero"),
            "el verificador tiene que recibir el prompt de review completo: {verification}"
        );
    }

    /// Cancelling has to stop the agents, not just the stream reading them.
    /// Aborting only the reader leaves them running and billing while the UI
    /// says "cancelado".
    #[tokio::test]
    async fn cancelling_stops_the_agents_that_have_not_started() {
        struct Slow(std::sync::Arc<std::sync::atomic::AtomicUsize>);
        impl AgentRunner for Slow {
            fn run(&self, _a: &str, _c: &str, _p: &str, _tx: tokio::sync::mpsc::Sender<String>) -> BoxFuture<'_, AgentResult> {
                let started = self.0.clone();
                Box::pin(async move {
                    started.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    Some(("informe".to_string(), None))
                })
            }
        }

        let started = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cancel = CancelToken::default();
        let request = ReviewRequest {
            cwd: "/repo".into(), base: "main".into(), context: String::new(),
            agents: vec!["uno".into(), "dos".into(), "tres".into()],
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });

        // Cancelled once both analysts are actually running, rather than after
        // a guessed delay: the engine asks lexis for context first, and a timed
        // cancel fired before the agents ever started.
        let token = cancel.clone();
        let watching = started.clone();
        tokio::spawn(async move {
            while watching.load(std::sync::atomic::Ordering::SeqCst) < 2 {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            token.cancel();
        });
        run_planned_cancellable(&request, "diff --git a/x b/x\n+1\n", &Slow(started.clone()), &tx, &cancel).await;
        drop(tx);
        let _ = drain.await;

        // The two analysts start together; the verifier must never be reached.
        assert_eq!(started.load(std::sync::atomic::Ordering::SeqCst), 2, "el verificador no debía llegar a arrancar");
        assert!(cancel.is_cancelled());
    }

    #[tokio::test]
    async fn a_run_that_is_never_cancelled_behaves_as_before() {
        let runner = FakeRunner::default();
        *runner.reports.lock().unwrap() = vec![report("A", None), report("B", None), report("final", None)];
        let (events, _) = collect("diff --git a/x b/x\n+1\n", &["uno".into(), "dos".into(), "tres".into()], runner).await;

        assert!(events.iter().any(|e| matches!(e, ReviewEvent::Synthesis)));
    }

    async fn collect(diff: &str, agents: &[String], runner: FakeRunner) -> (Vec<ReviewEvent>, FakeRunner) {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let request = ReviewRequest {
            cwd: "/repo".into(), base: "main".into(), context: String::new(),
            agents: agents.to_vec(),
        };
        run_planned_cancellable(&request, diff, &runner, &tx, &CancelToken::default()).await;
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
        assert!(matches!(events.first(), Some(ReviewEvent::Batch { index: 1, total: 1, .. })));
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
        // Two analyses and a verification means three agents: the third does
        // not analyse, it judges the other two.
        let agents = ["claude".into(), "codex".into(), "opencode".into()];
        let (events, runner) = collect("diff --git a/a.rs b/a.rs\n+x\n", &agents, runner).await;
        assert!(events.iter().any(|e| matches!(e, ReviewEvent::Synthesis)));
        let calls = runner.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 3, "dos análisis y una verificación");
        assert!(calls[2].starts_with("opencode:"), "verifica el último agente");
        assert!(events.iter().any(|e| matches!(e, ReviewEvent::Session { agent, .. } if agent == "opencode")));
    }

    #[tokio::test]
    async fn a_failed_stage_is_retried_once_before_giving_up() {
        let runner = FakeRunner::default();
        *runner.reports.lock().unwrap() = vec![None, report("a la segunda", None)];
        let (events, runner) = collect("diff --git a/a.rs b/a.rs\n+x\n", &["claude".into()], runner).await;
        assert_eq!(runner.calls.lock().unwrap().len(), 2, "reintenta la misma etapa");
        assert!(events.iter().any(|e| matches!(e, ReviewEvent::Content(t) if t == "a la segunda")));
        assert!(matches!(events.last(), Some(ReviewEvent::Done)));
    }

    #[tokio::test]
    async fn a_failing_agent_reports_the_error_and_stops() {
        let runner = FakeRunner::default();
        *runner.reports.lock().unwrap() = vec![None, None];
        let (events, runner) = collect("diff --git a/a.rs b/a.rs\n+x\n", &["claude".into()], runner).await;
        assert!(events.iter().any(|e| matches!(e, ReviewEvent::Error(m) if m.contains("claude"))));
        assert!(!events.iter().any(|e| matches!(e, ReviewEvent::Done)), "no se anuncia un final que no hubo");
        assert_eq!(runner.calls.lock().unwrap().len(), 2, "solo el reintento, y para");
    }

    #[tokio::test]
    async fn a_failing_synthesis_keeps_the_reports_already_streamed() {
        let runner = FakeRunner::default();
        *runner.reports.lock().unwrap() = vec![report("A", None), report("B", None), None];
        let (events, _) = collect("d\n", &["claude".into(), "codex".into(), "opencode".into()], runner).await;
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
