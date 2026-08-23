import type { MemoryEntry, NewMemoryEntry } from './MemoryEntry'
import { findSemanticallyDuplicate, normalizeNewMemoryEntry } from './normalize'
import { detailProject, lexisProjectFolder, projectName } from './memoryFormat'
import type { ImportedMemoryCandidate, PreviewCandidateState } from './memorySource'

// Absolute paths that identify a real project rather than the lexis index.
const isAbsoluteProjectPath = (file: string): boolean =>
  file.startsWith('/Users/') || file.startsWith('/private/') || file.startsWith('/var/')

const LEXIS_INDEX_MARKER = '/.lexis/projects/'
const LEXIS_TITLE_PREFIX = /^Lexis snapshot ·\s*/

/**
 * Which project a candidate belongs to, so the preview can group by it. Lexis
 * snapshots hide it in several places, tried here from most to least reliable.
 */
export const candidateProject = (candidate: ImportedMemoryCandidate): string => {
  const isLexisSnapshot = candidate.source.startsWith('source:') && candidate.tags.includes('lexis')
  if (!isLexisSnapshot) return projectName(candidate.files[0] || candidate.externalId)

  const detailed = detailProject(candidate.details)
  if (detailed) return projectName(detailed)

  const absoluteProject = candidate.files.find(isAbsoluteProjectPath)
  if (absoluteProject && !absoluteProject.includes(LEXIS_INDEX_MARKER)) return projectName(absoluteProject)

  const lexisIndex = candidate.files.find(file => file.includes(LEXIS_INDEX_MARKER))
  const folder = lexisIndex ? lexisProjectFolder(lexisIndex) : null
  if (folder) return folder

  const titled = candidate.title.replace(LEXIS_TITLE_PREFIX, '').trim()
  if (titled && titled !== candidate.title) return titled

  return 'Proyecto desconocido'
}

/** Whether importing this candidate would duplicate something already stored. */
export const computePreviewCandidateState = (
  projectPath: string, candidate: ImportedMemoryCandidate, existing: MemoryEntry[],
): PreviewCandidateState => {
  const payload: NewMemoryEntry = {
    kind: 'note',
    title: candidate.title,
    summary: candidate.summary,
    details: candidate.details,
    source: candidate.source,
    externalId: candidate.externalId,
    files: candidate.files,
    tags: candidate.tags,
    createdAt: candidate.createdAt,
    updatedAt: candidate.createdAt,
  }
  const normalized = normalizeNewMemoryEntry(projectPath, payload)
  const duplicateExternal = existing.some(entry => entry.externalId === normalized.externalId)
  const duplicate = duplicateExternal
    ? existing.find(entry => entry.externalId === normalized.externalId)
    : findSemanticallyDuplicate(existing, normalized)
  return {
    duplicateExternal,
    duplicateSemantic: !duplicateExternal && Boolean(duplicate),
    duplicateTitle: duplicate?.title || undefined,
  }
}
