import type { MemoryEntry, NewMemoryEntry, UpdateMemoryEntry } from './MemoryEntry'

export const trimMemoryText = (value: string | undefined): string => value?.trim() ?? ''

export const uniqMemoryValues = (values: string[] | undefined): string[] => [
  ...new Set((values ?? []).map(value => value.trim()).filter(Boolean)),
]

export const normalizeProjectPath = (projectPath: string | undefined): string => trimMemoryText(projectPath)

export function normalizeNewMemoryEntry(projectPath: string, entry: NewMemoryEntry): MemoryEntry {
  const now = new Date().toISOString()
  const createdAt = trimMemoryText(entry.createdAt) || now
  return {
    id: crypto.randomUUID(),
    projectPath: normalizeProjectPath(projectPath),
    kind: entry.kind,
    title: trimMemoryText(entry.title),
    summary: trimMemoryText(entry.summary),
    details: trimMemoryText(entry.details),
    tags: uniqMemoryValues(entry.tags),
    files: uniqMemoryValues(entry.files),
    source: trimMemoryText(entry.source) || 'manual',
    externalId: trimMemoryText(entry.externalId),
    createdAt,
    updatedAt: trimMemoryText(entry.updatedAt) || createdAt,
  }
}

export function normalizeMemoryPatch(patch: UpdateMemoryEntry): UpdateMemoryEntry {
  return {
    ...patch,
    ...(patch.title !== undefined ? { title: trimMemoryText(patch.title) } : {}),
    ...(patch.summary !== undefined ? { summary: trimMemoryText(patch.summary) } : {}),
    ...(patch.details !== undefined ? { details: trimMemoryText(patch.details) } : {}),
    ...(patch.tags !== undefined ? { tags: uniqMemoryValues(patch.tags) } : {}),
    ...(patch.files !== undefined ? { files: uniqMemoryValues(patch.files) } : {}),
    ...(patch.source !== undefined ? { source: trimMemoryText(patch.source) } : {}),
    ...(patch.externalId !== undefined ? { externalId: trimMemoryText(patch.externalId) } : {}),
  }
}

export const MEMORY_ARCHIVED_TAG = 'archived'
export const MEMORY_PINNED_TAG = 'pinned'
export const MEMORY_VERIFIED_TAG = 'verified'
export const MEMORY_SUPERSEDED_TAG = 'superseded'

export const isArchivedMemory = (entry: MemoryEntry): boolean => (
  entry.tags.includes(MEMORY_ARCHIVED_TAG) || entry.tags.includes(MEMORY_SUPERSEDED_TAG)
)

export const archiveMemoryTags = (entry: MemoryEntry): string[] => uniqMemoryValues([...entry.tags, MEMORY_ARCHIVED_TAG])

export const toggleMemoryTag = (entry: MemoryEntry, tag: string): string[] => (
  entry.tags.includes(tag) ? entry.tags.filter(value => value !== tag) : uniqMemoryValues([...entry.tags, tag])
)
