export type ConflictSegment =
  | { type: 'context'; lines: string[] }
  | { type: 'hunk'; ours: string[]; theirs: string[]; label: string; choice: 'ours' | 'theirs' | 'both' | null }

export function parseConflictFiles(status: string): string[] {
  return status.split('\n').filter(line => /^(UU|AA|DD|AU|UA|DU|UD) /.test(line)).map(line => line.slice(3))
}

export function parseConflictHunks(content: string): ConflictSegment[] {
  const lines = content.split('\n')
  const segments: ConflictSegment[] = []
  let context: string[] = []
  let index = 0
  while (index < lines.length) {
    if (lines[index].startsWith('<<<<<<<')) {
      if (context.length) { segments.push({ type: 'context', lines: context }); context = [] }
      const label = lines[index].slice(8).trim()
      const ours: string[] = []
      const theirs: string[] = []
      index++
      while (index < lines.length && !lines[index].startsWith('=======')) ours.push(lines[index++])
      index++
      while (index < lines.length && !lines[index].startsWith('>>>>>>>')) theirs.push(lines[index++])
      index++
      segments.push({ type: 'hunk', ours, theirs, label, choice: null })
    } else {
      context.push(lines[index++])
    }
  }
  if (context.length) segments.push({ type: 'context', lines: context })
  return segments
}

export function reconstructFromHunks(segments: ConflictSegment[]): string {
  return segments.map(segment => {
    if (segment.type === 'context') return segment.lines.join('\n')
    if (segment.choice === 'ours') return segment.ours.join('\n')
    if (segment.choice === 'theirs') return segment.theirs.join('\n')
    if (segment.choice === 'both') return [...segment.ours, ...segment.theirs].join('\n')
    return ''
  }).join('\n')
}
