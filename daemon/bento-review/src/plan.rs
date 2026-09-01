//! Qué se le manda a cada agente: cuántas etapas tiene una review, quién
//! analiza y quién verifica. Sin IO ni async, para poder decidirlo en un test
//! sin arrancar nada. Salió de `engine`, que se pasaba del presupuesto de
//! tamaño con la orquestación dentro.

use crate::diff::{batch_file_diffs, split_diff_into_file_diffs};


/// One agent call is at most this much diff. Bigger changes are split so no
/// single call is asked to hold more than it can actually reason about.
const BATCH_BUDGET: usize = 60_000;

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


#[cfg(test)]
mod tests {
    use super::*;

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
