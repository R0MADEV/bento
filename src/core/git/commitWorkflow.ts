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
