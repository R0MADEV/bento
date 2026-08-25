import type { MemoryEntry } from '../../core/memory/MemoryEntry'
import type { ImportedMemoryCandidate } from '../../core/memory/memorySource'
import { planCandidateImport } from '../../core/memory/dedup'
import type { MemoryRepository } from '../../ports/MemoryRepository'

export interface ImportOutcome {
  saved: number
  merged: number
  skipped: number
  /** The entry the caller should reveal: the last one created, merged or skipped. */
  lastAffectedId: string | null
}

/**
 * Imports candidates one by one, deciding each against what the project holds.
 * Entries created along the way join that set, so a repeat within the same run
 * merges instead of landing twice.
 */
export async function runCandidateImport(
  repo: MemoryRepository,
  projectPath: string,
  candidates: ImportedMemoryCandidate[],
  existing: MemoryEntry[],
  onProgress?: (current: number, total: number) => void,
  /** What to stamp as updatedAt for each candidate; defaults to now. */
  updatedAt?: (candidate: ImportedMemoryCandidate) => string,
): Promise<ImportOutcome> {
  const known = [...existing]
  const outcome: ImportOutcome = { saved: 0, merged: 0, skipped: 0, lastAffectedId: null }

  for (const [index, candidate] of candidates.entries()) {
    onProgress?.(index + 1, candidates.length)
    const plan = await planCandidateImport(projectPath, candidate, known, updatedAt?.(candidate))

    if (plan.action === 'skip') {
      outcome.lastAffectedId = plan.entryId
      outcome.skipped++
      continue
    }
    if (plan.action === 'merge') {
      const updated = await repo.update(projectPath, plan.entry.id, plan.patch)
      outcome.lastAffectedId = updated?.id ?? plan.entry.id
      outcome.merged++
      continue
    }
    const created = await repo.create(projectPath, plan.payload)
    known.unshift(created)
    outcome.lastAffectedId = created.id
    outcome.saved++
  }

  return outcome
}
