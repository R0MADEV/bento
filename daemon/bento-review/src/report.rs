//! El documento de la review: la cabecera, el informe de cada agente y el
//! resumen de la rama que se le manda al revisor. Sin UI, para que el panel,
//! el TUI y el móvil escriban todos el mismo markdown en vez de una versión
//! cada uno.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../src/generated/bindings/"))]
#[serde(rename_all = "camelCase")]
pub struct ReviewRun {
    pub label: String,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    /// El informe en markdown que devolvió el agente.
    #[serde(default)]
    pub report: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../src/generated/bindings/"))]
#[serde(rename_all = "camelCase")]
pub struct ReviewDocumentMeta {
    pub branch: String,
    pub base: String,
    pub commit: String,
    pub compare_agents: bool,
    /// Qué agente poner en la cabecera si no hay ninguna ejecución.
    pub fallback_agent_label: String,
}

/// El markdown completo de la review: cabecera más el informe de cada agente.
/// Se reconstruye igual con ejecuciones parciales, para que una review que se
/// corta a medias siga dejando documento.
pub fn build_document(meta: &ReviewDocumentMeta, runs: &[ReviewRun]) -> String {
    let agents_line = if meta.compare_agents {
        let labels: Vec<&str> = runs.iter().map(|run| run.label.as_str()).collect();
        format!("Agents: {}", labels.join(" + "))
    } else {
        let label = runs
            .first()
            .map(|run| run.label.as_str())
            .unwrap_or(&meta.fallback_agent_label);
        format!("Agent: {label}")
    };
    let short: String = meta.commit.chars().take(7).collect();
    let header = format!(
        "## Revisión: {}\nBase: `{}` · Commit: `{short}`\n{agents_line}",
        meta.branch, meta.base
    );

    let mut sections = vec![header];
    for run in runs {
        let Some(section) = document_section(meta.compare_agents, run) else {
            continue;
        };
        sections.push(section);
    }
    sections.join("\n\n")
}

/// Un error manda sobre el informe: si el agente falló, eso es lo que hay que
/// leer. Con un solo agente el informe va suelto; con varios, cada uno bajo su
/// título.
fn document_section(compare_agents: bool, run: &ReviewRun) -> Option<String> {
    if let Some(error) = &run.error {
        return Some(format!("### {}\n⚠️ {error}", run.label));
    }
    let report = run.report.as_deref()?;
    Some(match compare_agents {
        true => format!("### {}\n{report}", run.label),
        false => report.to_string(),
    })
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../src/generated/bindings/"))]
#[serde(rename_all = "camelCase")]
pub struct FollowUpSession {
    pub session_id: Option<String>,
    pub session_agent: Option<String>,
}

/// Con qué sesión se sigue hablando después de la review: la del último agente
/// que analizó de verdad. `count` deja fuera las etapas posteriores (la
/// síntesis), que responden a otra pregunta.
pub fn follow_up_session(runs: &[ReviewRun], count: usize) -> FollowUpSession {
    let found = runs
        .iter()
        .take(count)
        .rev()
        .find(|run| run.session_id.is_some());
    FollowUpSession {
        session_id: found.and_then(|run| run.session_id.clone()),
        session_agent: found.and_then(|run| run.agent.clone()),
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../src/generated/bindings/"))]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// "A", "M" o "D".
    pub state: String,
    pub file: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub additions: u32,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub deletions: u32,
}

/// Un fichero por línea con su estado y cuánto cambió.
pub fn file_manifest(files: &[ChangedFile]) -> String {
    files
        .iter()
        .map(|f| format!("{} {} (+{}/-{})", f.state, f.file, f.additions, f.deletions))
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../src/generated/bindings/"))]
#[serde(rename_all = "camelCase")]
pub struct OverviewInput {
    pub branch: String,
    pub base: String,
    #[cfg_attr(feature = "ts", ts(type = "number | null"))]
    pub pr_number: Option<u64>,
    #[serde(default)]
    pub pr_title: String,
    #[serde(default)]
    pub pr_body: String,
    /// Lo que el autor quiere que se mire con lupa (opcional).
    #[serde(default)]
    pub author_context: String,
    pub files: Vec<ChangedFile>,
}

/// Lo primero que lee el agente: de dónde sale el cambio, qué dice el autor y
/// qué ficheros toca. Es texto del prompt, así que vive aquí y no en el panel.
pub fn build_overview(input: &OverviewInput) -> String {
    let source = match input.pr_number {
        Some(number) => format!("PR #{number}: {}", input.pr_title),
        None => format!("Branch: {}", input.branch),
    };
    let description = match input.pr_body.trim() {
        "" => String::new(),
        body => format!("\nDescription:\n{body}\n"),
    };
    let author = match input.author_context.trim() {
        "" => String::new(),
        context => {
            format!("\nContexto del autor (qué hace la rama / en qué fijarse):\n{context}\n")
        }
    };
    format!(
        "{source}\nBase: {} <- {}\n{description}{author}Files:\n{}\n\nReview the files in the \
         current batch first. If a file is not included below, read it directly from the worktree \
         before deciding.",
        input.base,
        input.branch,
        file_manifest(&input.files),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(label: &str) -> ReviewRun {
        ReviewRun {
            label: label.into(),
            agent: Some("claude".into()),
            report: Some(format!("{label}: informe en Markdown")),
            ..ReviewRun::default()
        }
    }

    fn meta(compare_agents: bool) -> ReviewDocumentMeta {
        ReviewDocumentMeta {
            branch: "feat/x".into(),
            base: "main".into(),
            commit: "abcdef1234".into(),
            compare_agents,
            fallback_agent_label: "Claude".into(),
        }
    }

    #[test]
    fn the_document_carries_the_branch_base_short_commit_and_each_report() {
        let doc = build_document(&meta(false), &[run("Claude")]);
        assert!(doc.contains("## Revisión: feat/x"), "{doc}");
        assert!(doc.contains("Base: `main`"), "{doc}");
        assert!(doc.contains("`abcdef1`"), "{doc}");
        assert!(doc.contains("Agent: Claude"), "{doc}");
        assert!(doc.contains("Claude: informe en Markdown"), "{doc}");
    }

    #[test]
    fn comparing_agents_labels_each_section_and_keeps_the_failed_ones() {
        let failed = ReviewRun {
            label: "Codex".into(),
            agent: Some("codex".into()),
            error: Some("agent timeout".into()),
            ..ReviewRun::default()
        };
        let doc = build_document(&meta(true), &[run("Claude"), failed]);
        assert!(doc.contains("Agents: Claude + Codex"), "{doc}");
        assert!(doc.contains("### Claude"), "{doc}");
        assert!(doc.contains("### Codex"), "{doc}");
        assert!(doc.contains("⚠️ agent timeout"), "{doc}");
    }

    #[test]
    fn without_any_run_the_header_falls_back_to_the_given_agent() {
        let doc = build_document(&meta(false), &[]);
        assert!(doc.contains("Agent: Claude"), "{doc}");
    }

    #[test]
    fn the_follow_up_keeps_the_last_agent_that_actually_reviewed() {
        let with_session = |label: &str, id: &str| ReviewRun {
            label: label.into(),
            agent: Some("claude".into()),
            session_id: Some(id.into()),
            ..ReviewRun::default()
        };
        let runs = [
            with_session("Orchestrator", "s1"),
            with_session("Synthesis", "s2"),
            with_session("Verification", "verifier-session"),
        ];
        // `count` deja fuera la verificación: se sigue hablando con "s2".
        let session = follow_up_session(&runs, 2);
        assert_eq!(session.session_id.as_deref(), Some("s2"));
        assert_eq!(session.session_agent.as_deref(), Some("claude"));

        let none = follow_up_session(&[run("A")], 1);
        assert_eq!(none.session_id, None);
        assert_eq!(none.session_agent, None);
    }

    fn changed() -> Vec<ChangedFile> {
        vec![
            ChangedFile { state: "M".into(), file: "src/a.ts".into(), additions: 3, deletions: 1 },
            ChangedFile { state: "D".into(), file: "src/b.ts".into(), additions: 1, deletions: 0 },
        ]
    }

    #[test]
    fn the_manifest_is_one_line_per_file_with_its_state_and_counts() {
        assert_eq!(
            file_manifest(&changed()),
            "M src/a.ts (+3/-1)\nD src/b.ts (+1/-0)"
        );
        assert_eq!(file_manifest(&[]), "");
    }

    #[test]
    fn the_overview_names_the_pr_when_there_is_one_and_the_branch_when_not() {
        let base = OverviewInput {
            branch: "feat/x".into(),
            base: "main".into(),
            files: changed(),
            ..OverviewInput::default()
        };
        let without_pr = build_overview(&base);
        assert!(without_pr.starts_with("Branch: feat/x\nBase: main <- feat/x\n"), "{without_pr}");
        assert!(without_pr.contains("Files:\nM src/a.ts (+3/-1)"), "{without_pr}");
        assert!(!without_pr.contains("Description:"), "{without_pr}");

        let with_pr = build_overview(&OverviewInput {
            pr_number: Some(42),
            pr_title: "Arregla el login".into(),
            pr_body: "  cuerpo  ".into(),
            author_context: " mira el rebase ".into(),
            ..base
        });
        assert!(with_pr.starts_with("PR #42: Arregla el login\n"), "{with_pr}");
        assert!(with_pr.contains("\nDescription:\ncuerpo\n"), "{with_pr}");
        assert!(with_pr.contains("Contexto del autor"), "{with_pr}");
        assert!(with_pr.contains("mira el rebase"), "{with_pr}");
    }
}
