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

const collapse = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ')

export const semanticMemoryKey = (entry: Pick<MemoryEntry, 'projectPath' | 'kind' | 'title' | 'summary' | 'details'>): string => {
  const head = collapse(entry.summary || entry.details)
  return [
    collapse(entry.projectPath),
    collapse(entry.kind),
    collapse(entry.title),
    head.slice(0, 220),
  ].join('|')
}

export const memoryIdentityText = (entry: Pick<MemoryEntry, 'title' | 'summary' | 'details' | 'files'>): string => [
  collapse(entry.title),
  collapse(entry.summary),
  collapse(entry.details),
  ...entry.files.map(collapse),
].filter(Boolean).join(' ')

export function areMemoriesSemanticallySimilar(
  left: Pick<MemoryEntry, 'projectPath' | 'kind' | 'title' | 'summary' | 'details' | 'files'>,
  right: Pick<MemoryEntry, 'projectPath' | 'kind' | 'title' | 'summary' | 'details' | 'files'>,
): boolean {
  if (semanticMemoryKey(left) === semanticMemoryKey(right)) return true
  if (collapse(left.projectPath) !== collapse(right.projectPath) || collapse(left.kind) !== collapse(right.kind)) return false
  const a = memoryIdentityText(left)
  const b = memoryIdentityText(right)
  if (!a || !b) return false
  return a.includes(b) || b.includes(a)
}

export function mergeMemoryEntries(entries: MemoryEntry[]): MemoryEntry {
  const [primary, ...rest] = [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return rest.reduce<MemoryEntry>((merged, entry) => ({
    ...merged,
    kind: merged.kind === 'note' ? entry.kind : merged.kind,
    title: merged.title || entry.title,
    summary: merged.summary.length >= entry.summary.length ? merged.summary : entry.summary,
    details: merged.details.length >= entry.details.length ? merged.details : entry.details,
    tags: uniqMemoryValues([...merged.tags, ...entry.tags]),
    files: uniqMemoryValues([...merged.files, ...entry.files]),
    source: merged.source || entry.source,
    externalId: merged.externalId || entry.externalId,
    createdAt: merged.createdAt.localeCompare(entry.createdAt) <= 0 ? merged.createdAt : entry.createdAt,
    updatedAt: merged.updatedAt.localeCompare(entry.updatedAt) >= 0 ? merged.updatedAt : entry.updatedAt,
  }), primary)
}

export function findSemanticallyDuplicate(entries: MemoryEntry[], candidate: MemoryEntry): MemoryEntry | undefined {
  return entries.find(entry => areMemoriesSemanticallySimilar(entry, candidate))
}
