import { parseDiffFiles, type DiffFileStat } from '../diff/diffStats'
import { fileStateMap } from '../tasks/TaskCodeView'

export interface ReviewFile extends DiffFileStat {
  state: string
}

export interface ReviewSummary {
  files: number
  additions: number
  deletions: number
}

export function buildReviewFiles(diffRaw: string, statusRaw: string): ReviewFile[] {
  const stats = parseDiffFiles(diffRaw)
  const states = fileStateMap(statusRaw)
  return stats.map(f => ({ ...f, state: states.get(f.file) ?? '' }))
}

export function reviewSummary(files: ReviewFile[]): ReviewSummary {
  return files.reduce(
    (acc, f) => ({ files: acc.files + 1, additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { files: 0, additions: 0, deletions: 0 },
  )
}
