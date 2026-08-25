//! Cuándo dos memorias son la misma y qué hacer entonces. Estaba escrito en
//! TypeScript para el panel, mientras que la importación desde Rust solo miraba
//! el `external_id`: la misma operación se comportaba distinto según por dónde
//! entrara, y eso deja duplicados que el panel sí habría fusionado.

use serde::{Deserialize, Serialize};

use crate::sources::ImportedMemoryCandidate;
use crate::MemoryEntry;

/// Cuánto texto del resumen entra en la clave: lo bastante para distinguir dos
/// memorias, no tanto como para que un detalle largo las separe.
const KEY_HEAD: usize = 220;

fn collapse(value: &str) -> String {
    value.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

fn take_chars(value: &str, count: usize) -> String {
    value.chars().take(count).collect()
}

/// Lo que identifica a una memoria sin depender de su id: proyecto, tipo,
/// título y la cabeza de lo que cuenta.
pub fn semantic_key(entry: &MemoryEntry) -> String {
    let head = match entry.summary.is_empty() {
        true => collapse(&entry.details),
        false => collapse(&entry.summary),
    };
    [
        collapse(&entry.project_path),
        collapse(&entry.kind),
        collapse(&entry.title),
        take_chars(&head, KEY_HEAD),
    ]
    .join("|")
}

/// Todo lo que dice una memoria, en una línea, para poder ver si una contiene a
/// la otra.
pub fn identity_text(entry: &MemoryEntry) -> String {
    let mut parts = vec![
        collapse(&entry.title),
        collapse(&entry.summary),
        collapse(&entry.details),
    ];
    parts.extend(entry.files.iter().map(|file| collapse(file)));
    parts.retain(|part| !part.is_empty());
    parts.join(" ")
}

/// Dos memorias son la misma si comparten clave, o si son del mismo proyecto y
/// tipo y una dice todo lo que dice la otra.
pub fn are_similar(left: &MemoryEntry, right: &MemoryEntry) -> bool {
    if semantic_key(left) == semantic_key(right) {
        return true;
    }
    let same_scope = collapse(&left.project_path) == collapse(&right.project_path)
        && collapse(&left.kind) == collapse(&right.kind);
    if !same_scope {
        return false;
    }
    let (a, b) = (identity_text(left), identity_text(right));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a.contains(&b) || b.contains(&a)
}

pub fn find_duplicate<'a>(
    entries: &'a [MemoryEntry],
    candidate: &MemoryEntry,
) -> Option<&'a MemoryEntry> {
    entries.iter().find(|entry| are_similar(entry, candidate))
}

fn uniq(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let value = value.trim().to_string();
        if !value.is_empty() && !out.contains(&value) {
            out.push(value);
        }
    }
    out
}

/// Fusiona varias memorias en una: gana la más reciente, y de las demás se
/// queda lo que añaden.
pub fn merge(entries: &[MemoryEntry]) -> Option<MemoryEntry> {
    let mut ordered = entries.to_vec();
    ordered.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let mut merged = ordered.first()?.clone();
    for entry in ordered.iter().skip(1) {
        if merged.kind == "note" {
            merged.kind = entry.kind.clone();
        }
        if merged.title.is_empty() {
            merged.title = entry.title.clone();
        }
        if entry.summary.len() > merged.summary.len() {
            merged.summary = entry.summary.clone();
        }
        if entry.details.len() > merged.details.len() {
            merged.details = entry.details.clone();
        }
        merged.tags = uniq(merged.tags.iter().chain(&entry.tags).cloned());
        merged.files = uniq(merged.files.iter().chain(&entry.files).cloned());
        if merged.source.is_empty() {
            merged.source = entry.source.clone();
        }
        if merged.external_id.is_empty() {
            merged.external_id = entry.external_id.clone();
        }
        if entry.created_at < merged.created_at {
            merged.created_at = entry.created_at.clone();
        }
        if entry.updated_at > merged.updated_at {
            merged.updated_at = entry.updated_at.clone();
        }
    }
    Some(merged)
}

/// Lo que hay que cambiarle a la memoria que ya existe para que absorba a la
/// nueva: la unión de los metadatos y el texto que más cuenta.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePatch {
    pub tags: Vec<String>,
    pub files: Vec<String>,
    pub summary: String,
    pub details: String,
}

fn merge_patch(duplicate: &MemoryEntry, incoming: &MemoryEntry) -> MergePatch {
    let longer = |kept: &str, other: &str| match kept.len() >= other.len() {
        true => kept.to_string(),
        false => other.to_string(),
    };
    MergePatch {
        tags: uniq(duplicate.tags.iter().chain(&incoming.tags).cloned()),
        files: uniq(duplicate.files.iter().chain(&incoming.files).cloned()),
        summary: longer(&duplicate.summary, &incoming.summary),
        details: longer(&duplicate.details, &incoming.details),
    }
}

/// Qué hacer con un candidato: saltarlo porque ya se importó, fusionarlo con
/// una memoria que dice lo mismo, o crearlo.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum ImportDecision {
    Skip {
        #[serde(rename = "entryId")]
        entry_id: String,
    },
    Merge {
        entry: MemoryEntry,
        patch: MergePatch,
    },
    Create {
        payload: MemoryEntry,
    },
}

/// El candidato como memoria guardable. Lo importado siempre es una nota.
pub fn candidate_payload(
    project_path: &str,
    candidate: &ImportedMemoryCandidate,
    updated_at: &str,
) -> MemoryEntry {
    MemoryEntry {
        id: uuid::Uuid::new_v4().to_string(),
        project_path: project_path.trim().to_string(),
        kind: "note".to_string(),
        title: candidate.title.trim().to_string(),
        summary: candidate.summary.trim().to_string(),
        details: candidate.details.trim().to_string(),
        tags: uniq(candidate.tags.clone()),
        files: uniq(candidate.files.clone()),
        source: match candidate.source.trim() {
            "" => "manual".to_string(),
            source => source.to_string(),
        },
        external_id: candidate.external_id.trim().to_string(),
        created_at: candidate.created_at.trim().to_string(),
        updated_at: updated_at.to_string(),
    }
}

/// Decide qué hacer con un candidato contra lo que el proyecto ya tiene.
pub fn plan_import(
    project_path: &str,
    candidate: &ImportedMemoryCandidate,
    existing: &[MemoryEntry],
    updated_at: &str,
) -> ImportDecision {
    let payload = candidate_payload(project_path, candidate, updated_at);

    let already_imported = existing
        .iter()
        .find(|entry| !payload.external_id.is_empty() && entry.external_id == payload.external_id);
    if let Some(entry) = already_imported {
        return ImportDecision::Skip { entry_id: entry.id.clone() };
    }
    match find_duplicate(existing, &payload) {
        Some(duplicate) => ImportDecision::Merge {
            patch: merge_patch(duplicate, &payload),
            entry: duplicate.clone(),
        },
        None => ImportDecision::Create { payload },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> MemoryEntry {
        MemoryEntry {
            id: id.into(),
            project_path: "/p".into(),
            kind: "note".into(),
            title: "A title".into(),
            summary: "short".into(),
            details: "brief".into(),
            tags: Vec::new(),
            files: Vec::new(),
            source: "claude".into(),
            external_id: "claude:old".into(),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    fn candidate() -> ImportedMemoryCandidate {
        ImportedMemoryCandidate {
            title: "A title".into(),
            summary: "short".into(),
            details: "brief".into(),
            source: "claude".into(),
            external_id: "claude:new".into(),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            files: vec!["a.ts".into()],
            tags: vec!["x".into()],
        }
    }

    const NOW: &str = "2026-08-23T00:00:00.000Z";

    #[test]
    fn the_candidate_lands_as_a_note_stamped_with_the_given_time() {
        let payload = candidate_payload("/p", &candidate(), NOW);
        assert_eq!(payload.kind, "note");
        assert_eq!(payload.title, "A title");
        assert_eq!(payload.external_id, "claude:new");
        assert_eq!(payload.created_at, "2026-01-01T00:00:00.000Z");
        assert_eq!(payload.updated_at, NOW);
    }

    #[test]
    fn nothing_like_it_means_creating_it() {
        let decision = plan_import("/p", &candidate(), &[], NOW);
        let ImportDecision::Create { payload } = decision else {
            panic!("debería crearla");
        };
        assert_eq!(payload.external_id, "claude:new");
    }

    #[test]
    fn the_same_external_id_was_already_imported() {
        let mut existing = entry("kept");
        existing.external_id = "claude:same".into();
        let mut candidate = candidate();
        candidate.external_id = "claude:same".into();
        assert_eq!(
            plan_import("/p", &candidate, &[existing], NOW),
            ImportDecision::Skip { entry_id: "kept".into() }
        );
    }

    #[test]
    fn something_that_says_the_same_gets_merged_instead_of_duplicated() {
        let decision = plan_import("/p", &candidate(), &[entry("dup")], NOW);
        let ImportDecision::Merge { entry, patch } = decision else {
            panic!("debería fusionarla");
        };
        assert_eq!(entry.id, "dup");
        // La unión de metadatos, sin repetir.
        assert_eq!(patch.tags, vec!["x".to_string()]);
        assert_eq!(patch.files, vec!["a.ts".to_string()]);
    }

    #[test]
    fn merging_keeps_whichever_text_says_more_and_the_union_of_the_rest() {
        let mut existing = entry("dup");
        existing.tags = vec!["x".into(), "y".into()];
        existing.files = vec!["a.ts".into(), "b.ts".into()];
        existing.details = "brief and then some".into();
        let ImportDecision::Merge { patch, .. } = plan_import("/p", &candidate(), &[existing], NOW)
        else {
            panic!("debería fusionarla");
        };
        assert_eq!(patch.tags, vec!["x".to_string(), "y".to_string()]);
        assert_eq!(patch.files, vec!["a.ts".to_string(), "b.ts".to_string()]);
        assert_eq!(patch.details, "brief and then some");
        // En empate se queda lo que ya había.
        assert_eq!(patch.summary, "short");
    }

    #[test]
    fn the_incoming_text_wins_when_it_says_more() {
        let mut candidate = candidate();
        candidate.details = "brief and then some".into();
        let ImportDecision::Merge { patch, .. } = plan_import("/p", &candidate, &[entry("dup")], NOW)
        else {
            panic!("debería fusionarla");
        };
        assert_eq!(patch.details, "brief and then some");
    }

    #[test]
    fn a_different_project_or_kind_is_never_the_same_memory() {
        let mut other_project = entry("otro");
        other_project.project_path = "/q".into();
        other_project.title = "Otra cosa".into();
        let payload = candidate_payload("/p", &candidate(), NOW);
        assert!(!are_similar(&other_project, &payload));

        let mut other_kind = entry("tipo");
        other_kind.kind = "decision".into();
        other_kind.title = "Otra cosa".into();
        assert!(!are_similar(&other_kind, &payload));
    }

    #[test]
    fn one_that_says_everything_the_other_says_is_the_same_memory() {
        let mut short = entry("corta");
        short.title = "Idéntico".into();
        short.summary = "el resumen".into();
        short.details = String::new();
        let mut long = short.clone();
        long.id = "larga".into();
        long.details = "el resumen, con mucho más detalle".into();
        assert!(are_similar(&short, &long));
    }

    #[test]
    fn merging_entries_keeps_the_newest_and_what_the_rest_add() {
        let mut old = entry("vieja");
        old.tags = vec!["a".into()];
        old.details = "un detalle bastante más largo".into();
        old.created_at = "2025-01-01T00:00:00.000Z".into();
        let mut new = entry("nueva");
        new.updated_at = "2026-09-09T00:00:00.000Z".into();
        new.tags = vec!["b".into()];

        let merged = merge(&[old, new]).unwrap();
        assert_eq!(merged.id, "nueva", "manda la más reciente");
        assert_eq!(merged.tags, vec!["b".to_string(), "a".to_string()]);
        assert_eq!(merged.details, "un detalle bastante más largo");
        assert_eq!(merged.created_at, "2025-01-01T00:00:00.000Z");
        assert_eq!(merged.updated_at, "2026-09-09T00:00:00.000Z");
        assert!(merge(&[]).is_none());
    }
}
