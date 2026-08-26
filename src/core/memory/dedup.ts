import { invoke } from '@tauri-apps/api/core'
import type { MemoryEntry } from './MemoryEntry'
import type { ImportedMemoryCandidate } from './memorySource'

// Cuándo dos memorias son la misma vive en Rust (`bento_memory::dedup`),
// compartido con la importación que corre ahí: antes esa solo miraba el
// `externalId` y el panel además fusionaba, así que el resultado dependía de
// por dónde entrara.

/** Lo que hay que cambiarle a la memoria existente para que absorba a la nueva. */
export interface MergePatch {
  tags: string[]
  files: string[]
  summary: string
  details: string
}

export type ImportDecision =
  | { action: 'skip'; entryId: string }
  | { action: 'merge'; entry: MemoryEntry; patch: MergePatch }
  | { action: 'create'; payload: MemoryEntry }

export const planCandidateImport = (
  projectPath: string,
  candidate: ImportedMemoryCandidate,
  existing: MemoryEntry[],
  updatedAt: string = new Date().toISOString(),
): Promise<ImportDecision> =>
  invoke<ImportDecision>('memory_plan_import', { projectPath, candidate, existing, updatedAt })

/** Funde varias memorias en una; `null` si no se le pasa ninguna. */
export const mergeMemoryEntries = (entries: MemoryEntry[]): Promise<MemoryEntry | null> =>
  invoke<MemoryEntry | null>('memory_merge', { entries })
