// Extracts paths from a unified diff, preserving its displayed order.
export function diffFileNames(raw: string): string[] {
  return raw.split(/(?=^diff --git )/m).filter(Boolean).map(chunk => {
    const firstLine = chunk.split('\n')[0] ?? ''
    return firstLine.match(/^diff --git a\/(.+) b\//)?.[1] ?? firstLine
  })
}

// Parses `git diff-tree --name-status`, including both sides of renames.
export function changedPaths(raw: string): string[] {
  return raw.trim().split('\n').filter(Boolean).flatMap(line => line.split('\t').slice(1))
}

export function matchingPaths(incoming: Iterable<string>, commitPaths: Iterable<string>): string[] {
  const wanted = new Set(incoming)
  return [...new Set(commitPaths)].filter(path => wanted.has(path))
}

export interface FilePatchParts { file: string; header: string; hunks: string[] }

export function parseFilePatch(chunk: string): FilePatchParts {
  const file = diffFileNames(chunk)[0] ?? ''
  const lines = chunk.split('\n')
  const firstHunk = lines.findIndex(line => line.startsWith('@@'))
  if (firstHunk < 0) return { file, header: chunk, hunks: [] }
  const header = lines.slice(0, firstHunk).join('\n') + '\n'
  const hunks: string[] = []
  let start = firstHunk
  for (let i = firstHunk + 1; i <= lines.length; i++) {
    if (i === lines.length || lines[i]?.startsWith('@@')) {
      hunks.push(lines.slice(start, i).join('\n') + '\n')
      start = i
    }
  }
  return { file, header, hunks }
}

export function buildSelectedPatch(
  raw: string,
  wholeFiles: ReadonlySet<string>,
  selectedHunks: ReadonlyMap<string, ReadonlySet<number>>,
): string {
  return raw.split(/(?=^diff --git )/m).filter(Boolean).flatMap(chunk => {
    const parsed = parseFilePatch(chunk)
    if (wholeFiles.has(parsed.file)) return [chunk.endsWith('\n') ? chunk : `${chunk}\n`]
    const wanted = selectedHunks.get(parsed.file)
    if (!wanted?.size) return []
    return [parsed.header + parsed.hunks.filter((_, index) => wanted.has(index)).join('')]
  }).join('')
}

/** What ranking a commit as a fixup target needs to know about it. */
export interface FixupCandidate {
  /** Incoming files this commit also touched. */
  overlap: string[]
  /** How much `git blame` points at this commit for the incoming lines. */
  blame: { score: number }
  /** How often this commit shows up in the history of the incoming files. */
  history: { score: number }
}

// Overlapping files dominate; blame breaks their ties; history breaks blame's.
// The weights keep the three apart without comparing them field by field.
const OVERLAP_WEIGHT = 10000
const BLAME_WEIGHT = 100

const fixupScore = (candidate: FixupCandidate): number =>
  candidate.overlap.length * OVERLAP_WEIGHT + candidate.blame.score * BLAME_WEIGHT + candidate.history.score

/**
 * Commits ordered by how likely the user meant to fix each one up, best first.
 * Candidates that score the same keep the order they came in (newest first).
 */
export function rankFixupCandidates<T extends FixupCandidate>(candidates: T[]): T[] {
  return candidates
    .map((candidate, originalIndex) => ({ candidate, originalIndex }))
    .sort((a, b) => fixupScore(b.candidate) - fixupScore(a.candidate) || a.originalIndex - b.originalIndex)
    .map(({ candidate }) => candidate)
}
