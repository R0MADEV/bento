import type { MemoryEntry } from './MemoryEntry'
import { planCandidateImport } from './dedup'
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

/** Si importar este candidato duplicaría algo que ya está guardado. */
export const computePreviewCandidateState = async (
  projectPath: string, candidate: ImportedMemoryCandidate, existing: MemoryEntry[],
): Promise<PreviewCandidateState> => {
  const decision = await planCandidateImport(projectPath, candidate, existing, candidate.createdAt)
  if (decision.action === 'skip') {
    return {
      duplicateExternal: true,
      duplicateSemantic: false,
      duplicateTitle: existing.find(entry => entry.id === decision.entryId)?.title || undefined,
    }
  }
  if (decision.action === 'merge') {
    return { duplicateExternal: false, duplicateSemantic: true, duplicateTitle: decision.entry.title || undefined }
  }
  return { duplicateExternal: false, duplicateSemantic: false }
}
