import { diffFileNames } from '../../core/git/commitWorkflow'

export interface DiffFileStat {
  file: string
  additions: number
  deletions: number
  chunk: string
}

export function parseDiffFiles(raw: string): DiffFileStat[] {
  if (!raw.trim()) return []
  return raw.split(/(?=^diff --git )/m).filter(Boolean).map(chunk => {
    const file = diffFileNames(chunk)[0] ?? chunk
    const lines = chunk.split('\n')
    const additions = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length
    const deletions = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length
    return { file, additions, deletions, chunk }
  })
}
