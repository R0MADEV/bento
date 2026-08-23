use super::*;


#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct CommitRecommendation {
    hash: String,
    score: u32,
    files: Vec<String>,
}

// Scores task commits by how often they appear in the selected files' history.
// Format: full-hash<US>score<US>comma-separated-files
#[tauri::command]
pub async fn git_recommend_commits(
    path: String,
    base: String,
    files: Vec<String>,
) -> Result<Vec<CommitRecommendation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_branch(&base) {
            return Err(format!("unsafe base branch: {base}"));
        }
        let range = format!("origin/{base}..HEAD");
        let mut scores = std::collections::HashMap::<String, (u32, Vec<String>)>::new();
        for file in files.iter().take(200) {
            let history =
                git_output(&path, &["log", "--format=%H", &range, "--", file]).unwrap_or_default();
            for hash in history.lines() {
                let entry = scores.entry(hash.to_string()).or_insert((0, Vec::new()));
                entry.0 += 1;
                if !entry.1.contains(file) {
                    entry.1.push(file.clone());
                }
            }
        }
        let mut rows: Vec<_> = scores.into_iter().collect();
        rows.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
        Ok(rows
            .into_iter()
            .map(|(hash, (score, files))| CommitRecommendation { hash, score, files })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Attributes the original line ranges touched by an incoming patch to task
// commits using git blame. Same output format as git_recommend_commits.
#[tauri::command]
pub async fn git_blame_recommend(
    path: String,
    base: String,
    patch: String,
) -> Result<Vec<CommitRecommendation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_branch(&base) {
            return Err(format!("unsafe base branch: {base}"));
        }
        if patch.len() > 16 * 1024 * 1024 {
            return Err("patch is too large".into());
        }
        let range = format!("origin/{base}..HEAD");
        let allowed: std::collections::HashSet<String> = git_output(&path, &["rev-list", &range])?
            .lines()
            .map(str::to_string)
            .collect();
        let mut current_file = String::new();
        let mut ranges = Vec::<(String, u32, u32)>::new();
        for line in patch.lines() {
            if let Some(rest) = line.strip_prefix("diff --git a/") {
                current_file = rest.split(" b/").next().unwrap_or("").to_string();
            } else if line.starts_with("@@ -") && !current_file.is_empty() {
                let old_spec = line
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("")
                    .trim_start_matches('-');
                let mut values = old_spec.split(',');
                let start = values
                    .next()
                    .and_then(|v| v.parse::<u32>().ok())
                    .unwrap_or(1)
                    .max(1);
                let count = values
                    .next()
                    .and_then(|v| v.parse::<u32>().ok())
                    .unwrap_or(1)
                    .max(1);
                ranges.push((current_file.clone(), start, start.saturating_add(count - 1)));
            }
        }

        let mut scores = std::collections::HashMap::<String, (u32, Vec<String>)>::new();
        for (file, start, end) in ranges.into_iter().take(500) {
            let line_range = format!("{start},{end}");
            let blame = git_output(
                &path,
                &[
                    "blame",
                    "--line-porcelain",
                    "-L",
                    &line_range,
                    "HEAD",
                    "--",
                    &file,
                ],
            )
            .unwrap_or_default();
            for line in blame.lines() {
                let hash = line.split_whitespace().next().unwrap_or("");
                if line.len() >= 41 && hash.len() == 40 && allowed.contains(hash) {
                    let entry = scores.entry(hash.to_string()).or_insert((0, Vec::new()));
                    entry.0 += 1;
                    if !entry.1.contains(&file) {
                        entry.1.push(file.clone());
                    }
                }
            }
        }
        let mut rows: Vec<_> = scores.into_iter().collect();
        rows.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
        Ok(rows
            .into_iter()
            .map(|(hash, (score, files))| CommitRecommendation { hash, score, files })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}
