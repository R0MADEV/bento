//! A qué commit de la tarea pertenece un cambio: por historial de los ficheros
//! o por blame de las líneas que toca un parche. Sin UI: lo usan el panel, el
//! daemon y el CLI.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::log::{rebase_log, show_files, CommitEntry, CommitFile};
use crate::vcs::{git_cmd, is_safe_branch};

/// Un parche más grande que esto no viene de una revisión: se rechaza antes de
/// recorrerlo entero.
const MAX_PATCH_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../src/generated/bindings/"))]
pub struct CommitRecommendation {
    pub hash: String,
    pub score: u32,
    pub files: Vec<String>,
}

/// Cuenta un acierto de `file` para `hash`, sin repetir el fichero.
type Scores = HashMap<String, (u32, Vec<String>)>;

fn add_hit(scores: &mut Scores, hash: &str, file: &str) {
    let entry = scores.entry(hash.to_string()).or_insert((0, Vec::new()));
    entry.0 += 1;
    if !entry.1.iter().any(|seen| seen == file) {
        entry.1.push(file.to_string());
    }
}

fn ranked(scores: Scores) -> Vec<CommitRecommendation> {
    let mut rows: Vec<_> = scores.into_iter().collect();
    rows.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
    rows.into_iter()
        .map(|(hash, (score, files))| CommitRecommendation { hash, score, files })
        .collect()
}

/// Puntúa los commits de la tarea por cuántas veces salen en el historial de
/// los ficheros elegidos.
pub fn recommend_commits(
    cwd: &str,
    base: &str,
    files: &[String],
) -> Result<Vec<CommitRecommendation>, String> {
    if !is_safe_branch(base) {
        return Err(format!("unsafe base branch: {base}"));
    }
    let range = format!("origin/{base}..HEAD");
    let mut scores = Scores::new();
    for file in files.iter().take(200) {
        let history = git_cmd(cwd, &["log", "--format=%H", &range, "--", file]).unwrap_or_default();
        for hash in history.lines() {
            add_hit(&mut scores, hash, file);
        }
    }
    Ok(ranked(scores))
}

/// Los tramos de línea *originales* que toca un parche, por fichero.
fn touched_ranges(patch: &str) -> Vec<(String, u32, u32)> {
    let mut current_file = String::new();
    let mut ranges = Vec::new();
    for line in patch.lines() {
        if let Some(rest) = line.strip_prefix("diff --git a/") {
            current_file = rest.split(" b/").next().unwrap_or("").to_string();
            continue;
        }
        let is_hunk_header = line.starts_with("@@ -") && !current_file.is_empty();
        if !is_hunk_header {
            continue;
        }
        let old_spec = line
            .split_whitespace()
            .nth(1)
            .unwrap_or("")
            .trim_start_matches('-');
        let mut values = old_spec.split(',');
        let start = values
            .next()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(1)
            .max(1);
        let count = values
            .next()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(1)
            .max(1);
        ranges.push((current_file.clone(), start, start.saturating_add(count - 1)));
    }
    ranges
}

/// Atribuye a los commits de la tarea las líneas originales que toca un parche
/// entrante, usando blame. Mismo formato de salida que `recommend_commits`.
pub fn blame_recommend(
    cwd: &str,
    base: &str,
    patch: &str,
) -> Result<Vec<CommitRecommendation>, String> {
    if !is_safe_branch(base) {
        return Err(format!("unsafe base branch: {base}"));
    }
    if patch.len() > MAX_PATCH_BYTES {
        return Err("patch is too large".into());
    }
    let range = format!("origin/{base}..HEAD");
    let allowed: HashSet<String> = git_cmd(cwd, &["rev-list", &range])?
        .lines()
        .map(str::to_string)
        .collect();

    let mut scores = Scores::new();
    for (file, start, end) in touched_ranges(patch).into_iter().take(500) {
        let line_range = format!("{start},{end}");
        let blame = git_cmd(
            cwd,
            &["blame", "--line-porcelain", "-L", &line_range, "HEAD", "--", &file],
        )
        .unwrap_or_default();
        for line in blame.lines() {
            let hash = line.split_whitespace().next().unwrap_or("");
            let is_task_commit = hash.len() == 40 && line.len() >= 41 && allowed.contains(hash);
            if is_task_commit {
                add_hit(&mut scores, hash, &file);
            }
        }
    }
    Ok(ranked(scores))
}

/// Un commit de la tarea como candidato a recibir un fixup, con por qué lo es.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../src/generated/bindings/"))]
#[serde(rename_all = "camelCase")]
pub struct FixupTarget {
    pub entry: CommitEntry,
    /// Los ficheros que tocó, para poder abrirlos sin otra consulta.
    pub files: Vec<CommitFile>,
    /// Cuáles de esos ficheros toca también el cambio entrante.
    pub overlap: Vec<String>,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub history: u32,
    /// En qué ficheros sale este commit al mirar su historial.
    pub history_files: Vec<String>,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub blame: u32,
    /// En qué ficheros apunta el blame a este commit.
    pub blame_files: Vec<String>,
}

/// Los ficheros que toca el cambio entrante: los que digan, o los que salgan
/// del propio parche.
fn incoming_files(patch: &str, files: Option<&[String]>) -> Vec<String> {
    let mut names = match files {
        Some(files) if !files.is_empty() => files.to_vec(),
        _ => crate::diff::file_names(patch),
    };
    names.sort();
    names.dedup();
    names
}

/// Manda el solape de ficheros; el blame desempata entre ellos, y el historial
/// desempata al blame. Los pesos los mantienen separados sin tener que comparar
/// campo a campo.
const OVERLAP_WEIGHT: u32 = 10_000;
const BLAME_WEIGHT: u32 = 100;

fn fixup_score(target: &FixupTarget) -> u32 {
    (target.overlap.len() as u32) * OVERLAP_WEIGHT + target.blame * BLAME_WEIGHT + target.history
}

/// A qué commit de la tarea le pega mejor el cambio entrante, el más probable
/// primero. Junta las tres señales —qué ficheros comparten, a quién apunta el
/// blame de esas líneas y cuánto sale cada commit en el historial de esos
/// ficheros— que antes se pedían por separado y se combinaban en el panel.
pub fn fixup_targets(
    cwd: &str,
    base: &str,
    patch: &str,
    files: Option<&[String]>,
) -> Result<Vec<FixupTarget>, String> {
    let incoming = incoming_files(patch, files);
    let commits = rebase_log(cwd, base)?;
    let history = score_by_hash(recommend_commits(cwd, base, &incoming)?);
    let blame = score_by_hash(blame_recommend(cwd, base, patch)?);

    let mut targets: Vec<FixupTarget> = commits
        .into_iter()
        .map(|entry| {
            let files = show_files(cwd, &entry.hash).unwrap_or_default();
            let overlap = files
                .iter()
                .flat_map(|file| file.paths.iter())
                .filter(|path| incoming.contains(path))
                .cloned()
                .collect::<Vec<_>>();
            let (history, history_files) = history.get(&entry.hash).cloned().unwrap_or_default();
            let (blame, blame_files) = blame.get(&entry.hash).cloned().unwrap_or_default();
            FixupTarget { history, history_files, blame, blame_files, overlap, files, entry }
        })
        .collect();

    // Estable: a igualdad de puntuación se conserva el orden en que llegaron.
    targets.sort_by_key(|target| std::cmp::Reverse(fixup_score(target)));
    Ok(targets)
}

fn score_by_hash(rows: Vec<CommitRecommendation>) -> HashMap<String, (u32, Vec<String>)> {
    rows.into_iter().map(|row| (row.hash, (row.score, row.files))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::*;
    use std::fs;

    /// Un repo con `origin/main` y dos commits encima, cada uno en su fichero.
    fn task_repo(name: &str) -> TestRepo {
        let repo = repo(name);
        commit_file(&repo.0, "root\n", "root");
        run(&repo.0, &["branch", "-M", "main"]);
        run(&repo.0, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        run(&repo.0, &["checkout", "-qb", "task"]);
        for name in ["one.txt", "two.txt"] {
            fs::write(repo.0.join(name), format!("{name}\n")).unwrap();
            run(&repo.0, &["add", name]);
            run(&repo.0, &["commit", "-qm", name]);
        }
        repo
    }

    #[test]
    fn history_ranks_the_commit_that_touched_the_selected_file() {
        let repo = task_repo("recommend-history");
        let rows = recommend_commits(repo.0.to_str().unwrap(), "main", &["two.txt".into()]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].files, vec!["two.txt".to_string()]);
        assert_eq!(rows[0].score, 1);
    }

    #[test]
    fn blame_attributes_a_patch_hunk_to_the_commit_that_wrote_those_lines() {
        let repo = task_repo("recommend-blame");
        let patch = "diff --git a/two.txt b/two.txt\n@@ -1,1 +1,1 @@\n-two.txt\n+edited\n";
        let rows = blame_recommend(repo.0.to_str().unwrap(), "main", patch).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].files, vec!["two.txt".to_string()]);
        let subject = run(&repo.0, &["log", "-1", "--format=%s", &rows[0].hash]);
        assert_eq!(subject.trim(), "two.txt");
    }

    #[test]
    fn hunk_headers_give_the_original_line_range_per_file() {
        let patch = "diff --git a/a.txt b/a.txt\n@@ -4,3 +4,2 @@\ndiff --git a/b.txt b/b.txt\n@@ -1 +1,4 @@\n";
        assert_eq!(
            touched_ranges(patch),
            vec![("a.txt".into(), 4, 6), ("b.txt".into(), 1, 1)]
        );
    }

    #[test]
    fn the_incoming_files_come_from_the_patch_unless_they_are_given() {
        let patch = "diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\ndiff --git a/b.txt b/b.txt\n@@ -1 +1 @@\n";
        assert_eq!(incoming_files(patch, None), vec!["a.txt".to_string(), "b.txt".to_string()]);
        assert_eq!(
            incoming_files(patch, Some(&["solo.txt".to_string()])),
            vec!["solo.txt".to_string()]
        );
        // Una lista vacía es "no me dijeron nada", no "ningún fichero".
        assert_eq!(incoming_files(patch, Some(&[])).len(), 2);
    }

    #[test]
    fn the_commit_that_touched_the_same_file_is_offered_first() {
        let repo = task_repo("fixup-targets");
        // El cambio entrante toca two.txt, que es de la segunda tarea.
        let patch = "diff --git a/two.txt b/two.txt\n@@ -1,1 +1,1 @@\n-two.txt\n+edited\n";
        let targets = fixup_targets(repo.0.to_str().unwrap(), "main", patch, None).unwrap();
        assert_eq!(targets.len(), 2, "los dos commits de la tarea son candidatos");
        assert_eq!(targets[0].entry.subject, "two.txt");
        assert_eq!(targets[0].overlap, vec!["two.txt".to_string()]);
        assert!(targets[0].blame > 0 || targets[0].history > 0);
        // El otro no comparte nada con el cambio entrante.
        assert!(targets[1].overlap.is_empty());
        assert!(!targets[1].files.is_empty(), "aun así se sabe qué tocó");
    }

    #[test]
    fn without_any_commit_of_its_own_there_is_nothing_to_fix_up() {
        let repo = repo("fixup-empty");
        commit_file(&repo.0, "root\n", "root");
        run(&repo.0, &["branch", "-M", "main"]);
        run(&repo.0, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        assert!(fixup_targets(repo.0.to_str().unwrap(), "main", "", None).unwrap().is_empty());
    }

    #[test]
    fn an_unsafe_base_and_an_oversized_patch_are_refused() {
        let repo = task_repo("recommend-guards");
        let cwd = repo.0.to_str().unwrap();
        assert!(recommend_commits(cwd, "main; rm -rf /", &[]).is_err());
        assert!(blame_recommend(cwd, "../evil", "").is_err());
        let huge = "x".repeat(MAX_PATCH_BYTES + 1);
        assert!(blame_recommend(cwd, "main", &huge).is_err());
        assert!(fixup_targets(cwd, "../evil", "", None).is_err());
    }
}
