//! Context from the code that is *not* in the diff — who calls what you
//! touched. Lives here rather than in the desktop app so the CLI and the
//! phone client get the same prompt: an agent reviewing a diff blind gives
//! notably worse findings.

use tokio::process::Command;

/// How long lexis gets before the review goes on without it. Context is worth
/// having, never worth blocking a review for.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// Cap on what gets pasted into the prompt.
const BUDGET: usize = 12_000;

/// Asks lexis about `question` in `path`. Returns empty on any failure —
/// lexis not installed, no index, timeout — because context is an
/// improvement, not a requirement.
pub async fn context(path: &str, question: &str) -> String {
    context_from("lexis", path, question).await
}

/// The same, with the binary named explicitly. Separate so the tests can
/// point it somewhere without a process-wide environment variable, which they
/// would race each other over.
pub async fn context_from(binary: &str, path: &str, question: &str) -> String {
    let run = Command::new(binary)
        .args(["ask", "--path", path, "--lang", "en", "--depth", "2", "--topk", "5", question])
        .output();
    let Ok(Ok(output)) = tokio::time::timeout(TIMEOUT, run).await else {
        return String::new();
    };
    if !output.status.success() {
        return String::new();
    }
    String::from_utf8_lossy(&output.stdout).trim().chars().take(BUDGET).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_missing_lexis_yields_no_context_rather_than_failing_the_review() {
        assert!(context_from("/no/existe/lexis", "/repo", "algo").await.is_empty());
    }

    #[tokio::test]
    async fn a_failing_lexis_yields_no_context() {
        // `false` exits non-zero with no output.
        assert!(context_from("/usr/bin/false", "/repo", "algo").await.is_empty());
    }

    #[tokio::test]
    async fn what_lexis_prints_is_what_reaches_the_prompt() {
        let text = context_from("/bin/echo", "/repo", "algo").await;
        assert!(text.contains("--path"), "debería devolver lo que imprimió: {text}");
    }
}
