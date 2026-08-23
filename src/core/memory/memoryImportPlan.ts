import type { MemoryEntry, NewMemoryEntry } from './MemoryEntry'
import { findSemanticallyDuplicate, normalizeNewMemoryEntry, uniqMemoryValues } from './normalize'
import type { ImportedMemoryCandidate } from './memorySource'

/** What importing one candidate should do, given what the project already holds. */
export type ImportDecision =
  | { action: 'skip'; entryId: string }
  | { action: 'merge'; entry: MemoryEntry; patch: Partial<NewMemoryEntry> }
  | { action: 'create'; payload: NewMemoryEntry }

/** A candidate as a storable entry. Imported memories are always notes. */
export const candidatePayload = (candidate: ImportedMemoryCandidate, updatedAt: string): NewMemoryEntry => ({
  kind: 'note',
  title: candidate.title,
  summary: candidate.summary,
  details: candidate.details,
  source: candidate.source,
  externalId: candidate.externalId,
  files: candidate.files,
  tags: candidate.tags,
  createdAt: candidate.createdAt,
  updatedAt,
})

type NormalizedMemory = Pick<MemoryEntry, 'tags' | 'files' | 'summary' | 'details'>

// Merging keeps the richer text and the union of the metadata.
const mergePatch = (duplicate: MemoryEntry, incoming: NormalizedMemory): Partial<NewMemoryEntry> => ({
  tags: uniqMemoryValues([...duplicate.tags, ...incoming.tags]),
  files: uniqMemoryValues([...duplicate.files, ...incoming.files]),
  summary: duplicate.summary.length >= incoming.summary.length ? duplicate.summary : incoming.summary,
  details: duplicate.details.length >= incoming.details.length ? duplicate.details : incoming.details,
})

/**
 * Decides how to import one candidate: skip what was already imported under the
 * same external id, merge into a semantically equal entry, or create a new one.
 */
export const planCandidateImport = (
  projectPath: string, candidate: ImportedMemoryCandidate, existing: MemoryEntry[],
  updatedAt: string = new Date().toISOString(),
): ImportDecision => {
  const payload = candidatePayload(candidate, updatedAt)
  const normalized = normalizeNewMemoryEntry(projectPath, payload)

  const alreadyImported = existing.find(entry => entry.externalId === normalized.externalId)
  if (alreadyImported) return { action: 'skip', entryId: alreadyImported.id }

  const duplicate = findSemanticallyDuplicate(existing, normalized)
  if (duplicate) return { action: 'merge', entry: duplicate, patch: mergePatch(duplicate, normalized) }

  return { action: 'create', payload }
}
