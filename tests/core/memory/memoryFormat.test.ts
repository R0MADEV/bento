import { describe, expect, it } from 'vitest'
import {
  KIND_LABEL, KIND_OPTIONS, splitList, basename, projectName,
  detailProject, lexisProjectFolder, timeLabel, sourceLabel, canRegenerateSummary,
} from '../../../src/core/memory/memoryFormat'
import type { MemoryEntry, MemoryKind } from '../../../src/core/memory/MemoryEntry'

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: '1', kind: 'note', title: 't', summary: '', details: '', source: '',
  tags: [], files: [], createdAt: '', updatedAt: '', ...over,
} as MemoryEntry)

describe('kinds', () => {
  it('labels every kind', () => {
    const kinds: MemoryKind[] = ['decision', 'fact', 'task', 'note']
    kinds.forEach(k => expect(KIND_LABEL[k]).toBeTruthy())
  })

  it('offers every kind as a filter, plus "all" first', () => {
    expect(KIND_OPTIONS[0]).toBe('all')
    expect(KIND_OPTIONS.slice(1)).toEqual(['decision', 'fact', 'task', 'note'])
  })
})

describe('splitList', () => {
  it('splits on commas and trims', () => {
    expect(splitList('a, b ,c')).toEqual(['a', 'b', 'c'])
  })

  it('drops empties and duplicates', () => {
    expect(splitList('a,,a, ,b')).toEqual(['a', 'b'])
  })

  it('is empty for an empty string', () => {
    expect(splitList('')).toEqual([])
  })
})

describe('basename and projectName', () => {
  it('takes the last segment of a POSIX or Windows path', () => {
    expect(basename('/home/ana/bento')).toBe('bento')
    expect(basename('C:\\Users\\ana\\bento')).toBe('bento')
  })

  it('ignores a trailing separator', () => {
    expect(basename('/home/ana/bento/')).toBe('bento')
  })

  it('falls back to the whole value when there is no path to strip', () => {
    expect(projectName('bento')).toBe('bento')
    expect(projectName('/')).toBe('/')
  })
})

describe('detailProject', () => {
  it('reads the indexed project off its own line', () => {
    expect(detailProject('algo\nProyecto indexado:  /home/ana/bento \notra cosa')).toBe('/home/ana/bento')
  })

  it('is null when the marker is absent', () => {
    expect(detailProject('sin marcador')).toBeNull()
  })
})

describe('lexisProjectFolder', () => {
  it('picks the folder right after the lexis projects marker', () => {
    expect(lexisProjectFolder('/home/ana/.lexis/projects/bento/notes.json')).toBe('bento')
  })

  it('accepts Windows separators', () => {
    expect(lexisProjectFolder('C:\\Users\\ana\\.lexis\\projects\\bento\\notes.json')).toBe('bento')
  })

  it('is null outside a lexis projects path or with nothing after the marker', () => {
    expect(lexisProjectFolder('/home/ana/other/bento')).toBeNull()
    expect(lexisProjectFolder('/home/ana/.lexis/projects/')).toBeNull()
  })
})

describe('timeLabel', () => {
  it('formats a valid timestamp', () => {
    expect(timeLabel('2026-08-23T10:00:00.000Z')).not.toBe('2026-08-23T10:00:00.000Z')
  })

  // The catch was meant to give the raw value back, but Date never throws here:
  // an unparseable timestamp renders as "Invalid Date". Behavior kept as-is.
  it('renders an unparseable timestamp as Invalid Date', () => {
    expect(timeLabel('not a date')).toBe('Invalid Date')
  })
})

describe('sourceLabel', () => {
  it('shows the source when there is one', () => {
    expect(sourceLabel('claude')).toBe('claude')
  })

  it('falls back to a manual label when there is none', () => {
    expect(sourceLabel('')).toBeTruthy()
    expect(sourceLabel('')).not.toBe('')
  })
})

describe('canRegenerateSummary', () => {
  it('is true only for a session-summary entry', () => {
    expect(canRegenerateSummary(entry({ externalId: 'claude:session-summary:abc' }))).toBe(true)
  })

  it('is false for another external entry, a manual one, or none at all', () => {
    expect(canRegenerateSummary(entry({ externalId: 'claude:transcript:abc' }))).toBe(false)
    expect(canRegenerateSummary(entry())).toBe(false)
    expect(canRegenerateSummary(undefined)).toBe(false)
  })
})
