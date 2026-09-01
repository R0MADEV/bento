//! Where a finished review is kept so it can be reopened, resumed with a
//! follow-up question, or listed as history. One store on disk for the
//! desktop app, the phone and the CLI: they used to keep separate ones — the
//! desktop in the browser's localStorage — so a review run in one was
//! invisible to the others.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Checkpoint {
    pub cwd: String,
    /// The ref this review is filed under: the base branch when reviewing the
    /// working tree (daemon, CLI, phone), the reviewed branch when reviewing
    /// a branch (desktop). It is the key, together with `cwd`.
    pub base: String,
    pub content: String,
    pub saved_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_agent: Option<String>,
    /// The branch that was reviewed, when it isn't the key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The commit the review was made against, so a stale one can be spotted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// Which run this is. Stable across the saves one review makes as it goes,
    /// and different between runs — without it a second review of the same
    /// branch overwrote the first, taking its report and its resumable
    /// session with it. Absent on checkpoints written before this existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CheckpointMeta {
    pub base: String,
    pub saved_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Which run this entry is, so a client can ask for this one rather than
    /// "the latest for this branch". None on entries saved before runs were
    /// told apart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// Whether it can still be asked a follow-up question — the verifier's
    /// session. Listing an entry that cannot be resumed as if it could is
    /// worse than saying so.
    pub resumable: bool,
    /// Whether the ref moved on since the review was made. The commit is
    /// stamped on every checkpoint for exactly this; comparing it here means
    /// the three clients say it the same way instead of each deciding.
    #[serde(default)]
    pub stale: bool,
}

fn checkpoints_dir() -> Option<PathBuf> {
    crate::store::store_dir("review-checkpoints")
}

pub fn checkpoint_path(cwd: &str, base: &str) -> Option<PathBuf> {
    checkpoints_dir().map(|dir| crate::store::entry_path(&dir, cwd, base))
}

/// Where a checkpoint belongs. Runs get their own file; one without a
/// `run_id` keeps the old `cwd:base` location so it stays findable.
pub fn checkpoint_path_for(cp: &Checkpoint) -> Option<PathBuf> {
    match &cp.run_id {
        Some(run) => checkpoints_dir()
            .map(|dir| crate::store::entry_path(&dir, &cp.cwd, &format!("{}:{run}", cp.base))),
        None => checkpoint_path(&cp.cwd, &cp.base),
    }
}

/// All saved checkpoints for `cwd` (one per base branch reviewed), newest
/// first — shared by the HTTP list handler and the daemon's IPC socket
/// (`review.checkpoints`, for the TUI's history view).
pub fn list_checkpoint_metas(cwd: &str) -> Vec<CheckpointMeta> {
    let Some(dir) = checkpoints_dir() else { return Vec::new() };
    if !dir.exists() {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    // Un `rev-parse` por rama, no por review: un proyecto con veinte reviews
    // de la misma rama las resuelve todas con una llamada.
    let mut heads: std::collections::HashMap<String, Option<String>> = std::collections::HashMap::new();
    let mut metas: Vec<CheckpointMeta> = entries
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|raw| serde_json::from_str::<Checkpoint>(&raw).ok())
        .filter(|cp| cp.cwd == cwd)
        .map(|cp| {
            let reference = cp.branch.clone().unwrap_or_else(|| cp.base.clone());
            let head = heads
                .entry(reference.clone())
                .or_insert_with(|| head_of(cwd, &reference))
                .clone();
            CheckpointMeta {
                stale: is_stale(cp.commit.as_deref(), head.as_deref()),
                base: cp.base,
                saved_at: cp.saved_at,
                branch: cp.branch,
                resumable: cp.session_id.is_some(),
                run_id: cp.run_id,
            }
        })
        .collect();
    metas.sort_by(|a, b| time_key(&b.saved_at).cmp(&time_key(&a.saved_at)));
    metas
}

/// Dónde está ahora una rama, o `None` si no se puede saber.
fn head_of(cwd: &str, reference: &str) -> Option<String> {
    crate::vcs::git_cmd(cwd, &["rev-parse", reference])
        .ok()
        .map(|sha| sha.trim().to_string())
        .filter(|sha| !sha.is_empty())
}

/// Si el código se movió desde que se hizo la review. Sin los dos shas no se
/// afirma nada: no haber podido leer uno no es prueba de que algo cambiara.
fn is_stale(saved: Option<&str>, head: Option<&str>) -> bool {
    matches!((saved, head), (Some(saved), Some(head)) if saved != head)
}

/// A `saved_at` that sorts by time rather than by byte. The daemon stamps
/// whole seconds (`…:51Z`), the phone milliseconds (`…:51.123Z`), and as plain
/// text the millisecond one loses because `.` sits below `Z` — so the older
/// review came out on top.
fn time_key(saved_at: &str) -> String {
    match saved_at.strip_suffix('Z') {
        Some(rest) if !rest.contains('.') => format!("{rest}.000Z"),
        _ => saved_at.to_string(),
    }
}

/// The newest checkpoint about `ref_name` in `dir`, whichever run it belongs
/// to. Every file has to be read: the name is a hash of the run, so the run
/// ids of a branch cannot be worked out from the directory listing.
///
/// A review is about the ref it is filed under *and* the branch it names: the
/// desktop files a review of `feat/x` under `feat/x`, while the CLI and the
/// phone file the same review under the base it was compared against and put
/// `feat/x` in `branch`. Matching only the key is what kept each client from
/// ever seeing the other's reviews.
fn latest_in(dir: &std::path::Path, cwd: &str, ref_name: &str) -> Option<Checkpoint> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|raw| serde_json::from_str::<Checkpoint>(&raw).ok())
        .filter(|cp| cp.cwd == cwd && (cp.base == ref_name || cp.branch.as_deref() == Some(ref_name)))
        .max_by_key(|cp| time_key(&cp.saved_at))
}

/// The saved checkpoint to reopen for `(cwd, base)`: the one filed under that
/// pair, or else the most recent run of it.
///
/// The fallback is the whole point. Every client now stamps a run id, so
/// nothing is written to the plain `cwd:base` path any more — and the desktop,
/// which has no history view to pick a run from, could no longer find a single
/// review it had saved.
pub fn get_checkpoint(cwd: &str, base: &str) -> Option<Checkpoint> {
    let path = checkpoint_path(cwd, base)?;
    if let Some(cp) = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Checkpoint>(&raw).ok())
    {
        return Some(cp);
    }
    latest_in(&checkpoints_dir()?, cwd, base)
}

/// One specific run, for a client picking from the history rather than
/// reopening whatever was last.
pub fn get_run(cwd: &str, base: &str, run_id: &str) -> Option<Checkpoint> {
    let dir = checkpoints_dir()?;
    let path = crate::store::entry_path(&dir, cwd, &format!("{base}:{run_id}"));
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Checkpoint>(&raw).ok()
}

/// Writes `cp` to its checkpoint file — shared by the HTTP `PUT
/// /api/review/checkpoint` handler (the web panel saves incrementally as
/// batches complete) and the daemon's IPC socket (`review.checkpoint_save`,
/// called once after a `review.run` finishes so `review.ask` has something
/// to resume).
///
/// Both of those clients save without saying which branch or which commit they
/// reviewed — a browser and a socket message have no git to ask. Stamping it
/// here, where the cwd is known, is what keeps a reopened review able to say
/// whether the code moved under it. What the caller already knew wins.
pub fn save_checkpoint(cp: &Checkpoint) -> Result<(), String> {
    let dir = checkpoints_dir().ok_or_else(|| "no home dir".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = checkpoint_path_for(cp).ok_or_else(|| "bad checkpoint path".to_string())?;
    let raw = serde_json::to_string(&stamped(cp)).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

/// `cp` with whatever metadata it is missing filled in from its repo.
fn stamped(cp: &Checkpoint) -> Checkpoint {
    let is_already_stamped = cp.branch.is_some() && cp.commit.is_some();
    if is_already_stamped {
        return cp.clone();
    }
    let (branch, commit) = reviewed_at(&cp.cwd, cp.branch.clone());
    Checkpoint { branch, commit: cp.commit.clone().or(commit), ..cp.clone() }
}

/// A JS-`Date`-parseable UTC timestamp with no extra crate: this workspace
/// has no date/time dependency, so this hand-rolls the
/// epoch-seconds → calendar-date conversion (Howard Hinnant's
/// `civil_from_days`) — used when the IPC caller (the TUI, not a browser)
/// has no `Date.toISOString()` of its own to send.
pub fn now_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    iso8601_from_unix_secs(secs)
}

fn iso8601_from_unix_secs(secs: u64) -> String {
    let (days, rem) = (secs / 86400, secs % 86400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// Shared by the HTTP delete handler and the daemon's IPC socket
/// (`review.checkpoint_delete`).
/// What a review was made against: the branch reviewed and the sha at that
/// moment. The desktop already sends both; the daemon's clients (CLI, phone,
/// web) don't, and a checkpoint saved without them reopens with no way to tell
/// whether the code moved under it.
///
/// Best effort by design: a directory that isn't a repo, or a detached HEAD,
/// stamps nothing rather than losing the review over metadata.
pub fn reviewed_at(cwd: &str, branch: Option<String>) -> (Option<String>, Option<String>) {
    let branch = branch.or_else(|| crate::vcs::current_branch(cwd).ok());
    let commit = crate::vcs::git_cmd(cwd, &["rev-parse", "HEAD"])
        .ok()
        .map(|sha| sha.trim().to_string())
        .filter(|sha| !sha.is_empty());
    (branch, commit)
}

/// Removes one saved review: the run named, or the runless entry when none is.
///
/// The run id is what makes this reach anything at all today. Without it only
/// the old `cwd:base` path was ever removed, so deleting a review from the
/// history left its file exactly where it was and the entry came back on the
/// next listing.
pub fn delete_checkpoint(cwd: &str, base: &str, run_id: Option<&str>) -> Result<(), String> {
    let key = match run_id {
        Some(run) => format!("{base}:{run}"),
        None => base.to_string(),
    };
    let dir = checkpoints_dir().ok_or_else(|| "bad checkpoint path".to_string())?;
    std::fs::remove_file(crate::store::entry_path(&dir, cwd, &key)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_checkpoint_written_before_branch_and_commit_existed_still_loads() {
        let old = r#"{"cwd":"/repo","base":"main","content":"informe","saved_at":"2026-08-21T21:29:52Z"}"#;
        let cp: Checkpoint = serde_json::from_str(old).expect("debe leer el formato anterior");
        assert_eq!(cp.base, "main");
        assert!(cp.branch.is_none());
        assert!(cp.commit.is_none());
    }

    #[test]
    fn the_key_is_stable_for_the_same_cwd_and_ref() {
        assert_eq!(checkpoint_path("/repo", "main"), checkpoint_path("/repo", "main"));
        assert_ne!(checkpoint_path("/repo", "main"), checkpoint_path("/repo", "feat/x"));
        assert_ne!(checkpoint_path("/repo", "main"), checkpoint_path("/otro", "main"));
    }

    #[test]
    fn epoch_zero_is_the_unix_epoch_date() {
        assert_eq!(iso8601_from_unix_secs(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn known_timestamp_round_trips_correctly() {
        // 1700000000 is a commonly-cited round Unix timestamp.
        assert_eq!(iso8601_from_unix_secs(1_700_000_000), "2023-11-14T22:13:20Z");
    }

    #[test]
    fn end_of_a_leap_year_day_is_february_29() {
        // 2024-02-29T12:00:00Z (2024 is a leap year).
        assert_eq!(iso8601_from_unix_secs(1_709_208_000), "2024-02-29T12:00:00Z");
    }
}

#[cfg(test)]
mod run_tests {
    use super::*;

    fn checkpoint(base: &str, run: Option<&str>, saved: &str) -> Checkpoint {
        Checkpoint {
            cwd: "/repo".into(),
            base: base.into(),
            content: format!("informe {saved}"),
            saved_at: saved.into(),
            session_id: Some(format!("sess-{saved}")),
            session_agent: Some("opencode".into()),
            branch: None,
            commit: None,
            run_id: run.map(String::from),
        }
    }

    #[test]
    fn two_reviews_of_the_same_branch_do_not_overwrite_each_other() {
        // Filed under cwd+base alone, a second review of `main` replaced the
        // first — its report and, worse, the session you could still ask.
        let first = checkpoint_path_for(&checkpoint("main", Some("run-1"), "2026-08-27T09:00:00Z"));
        let second = checkpoint_path_for(&checkpoint("main", Some("run-2"), "2026-08-27T10:00:00Z"));

        assert_ne!(first, second);
    }

    #[test]
    fn saving_the_same_review_twice_keeps_one_file() {
        // The web panel saves after every stage; those are the same review and
        // must land on the same file, or a run would leave one entry per stage.
        let early = checkpoint_path_for(&checkpoint("main", Some("run-1"), "2026-08-27T09:00:00Z"));
        let late = checkpoint_path_for(&checkpoint("main", Some("run-1"), "2026-08-27T09:05:00Z"));

        assert_eq!(early, late);
    }

    #[test]
    fn a_checkpoint_without_a_run_id_keeps_its_old_location() {
        // Saved by an older client, or by one that does not track runs: it
        // still has to be found where it has always been.
        let legacy = checkpoint_path_for(&checkpoint("main", None, "2026-08-27T09:00:00Z"));

        assert_eq!(legacy, checkpoint_path("/repo", "main"));
    }
}

#[cfg(test)]
mod reopen_tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("bento-reopen-{name}-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &std::path::Path, cwd: &str, base: &str, run: Option<&str>, saved: &str) {
        let cp = Checkpoint {
            cwd: cwd.into(),
            base: base.into(),
            content: format!("report {saved}"),
            saved_at: saved.into(),
            session_id: None,
            session_agent: None,
            branch: None,
            commit: None,
            run_id: run.map(String::from),
        };
        let key = match run {
            Some(run) => format!("{base}:{run}"),
            None => base.to_string(),
        };
        let path = crate::store::entry_path(dir, cwd, &key);
        std::fs::write(path, serde_json::to_string(&cp).unwrap()).unwrap();
    }

    #[test]
    fn reopening_finds_the_newest_run_when_there_is_no_legacy_file() {
        // The desktop always sends a run id, so it never writes the legacy
        // path — and asking for `(cwd, base)` found nothing at all. It saved
        // reviews it could not reopen.
        let dir = temp_dir("newest");
        write(&dir, "/repo", "main", Some("run-1"), "2026-08-27T09:00:00Z");
        write(&dir, "/repo", "main", Some("run-2"), "2026-08-27T11:00:00Z");
        write(&dir, "/repo", "main", Some("run-0"), "2026-08-27T08:00:00Z");

        let found = latest_in(&dir, "/repo", "main").expect("some run of that branch");
        assert_eq!(found.run_id.as_deref(), Some("run-2"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn milliseconds_and_whole_seconds_still_order_by_time() {
        // The daemon stamps whole seconds, the phone milliseconds. Compared as
        // plain text `…:20Z` beats `…:20.500Z`, because `.` sorts below `Z` —
        // so the older one won.
        let dir = temp_dir("mixed");
        write(&dir, "/repo", "main", Some("segundos"), "2026-08-27T09:00:20Z");
        write(&dir, "/repo", "main", Some("milis"), "2026-08-27T09:00:20.500Z");

        assert_eq!(latest_in(&dir, "/repo", "main").unwrap().run_id.as_deref(), Some("milis"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn another_project_or_another_branch_is_not_picked_up() {
        let dir = temp_dir("scope");
        write(&dir, "/repo", "main", Some("mine"), "2026-08-27T09:00:00Z");
        write(&dir, "/otro", "main", Some("otro-repo"), "2026-08-27T23:00:00Z");
        write(&dir, "/repo", "feat/x", Some("otra-rama"), "2026-08-27T23:00:00Z");

        assert_eq!(latest_in(&dir, "/repo", "main").unwrap().run_id.as_deref(), Some("mine"));
        assert!(latest_in(&dir, "/repo", "sin-reviews").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod stamp_tests {
    use super::*;
    use crate::test_support::{repo, run};

    #[test]
    fn stamps_the_branch_and_the_sha_the_review_was_made_at() {
        let git = repo("stamp");
        let cwd = git.0.to_string_lossy().to_string();
        std::fs::write(git.0.join("a.txt"), "uno").unwrap();
        run(&git.0, &["add", "."]);
        run(&git.0, &["commit", "-qm", "uno"]);
        run(&git.0, &["checkout", "-qb", "feat/x"]);

        let (branch, commit) = reviewed_at(&cwd, None);

        assert_eq!(branch.as_deref(), Some("feat/x"));
        let head = run(&git.0, &["rev-parse", "HEAD"]).trim().to_string();
        assert_eq!(commit, Some(head));
    }

    #[test]
    fn the_branch_the_client_names_wins_over_the_checked_out_one() {
        let git = repo("stamp-named");
        let cwd = git.0.to_string_lossy().to_string();
        std::fs::write(git.0.join("a.txt"), "uno").unwrap();
        run(&git.0, &["add", "."]);
        run(&git.0, &["commit", "-qm", "uno"]);

        let (branch, _) = reviewed_at(&cwd, Some("feat/desde-el-movil".into()));

        assert_eq!(branch.as_deref(), Some("feat/desde-el-movil"));
    }

    #[test]
    fn a_directory_that_is_not_a_repo_stamps_nothing_instead_of_failing() {
        let dir = std::env::temp_dir().join(format!("bento-stamp-plain-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let (branch, commit) = reviewed_at(&dir.to_string_lossy(), None);

        assert!(branch.is_none());
        assert!(commit.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
