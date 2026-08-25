import { describe, expect, it } from 'vitest'
import { fileStateMap } from '../../../src/core/git/fileState'

describe('fileStateMap', () => {
  it('separates what is staged from what is not', () => {
    const states = fileStateMap('M  staged.ts\n M unstaged.ts\nMM ambos.ts\n')
    expect(states.get('staged.ts')).toBe('staged')
    expect(states.get('unstaged.ts')).toBe('unstaged')
    expect(states.get('ambos.ts')).toBe('staged + modified')
  })

  it('marks untracked files', () => {
    expect(fileStateMap('?? nuevo.ts\n').get('nuevo.ts')).toBe('untracked')
  })

  it('keeps the destination of a rename, not the origin', () => {
    // git escribe `R  viejo.ts -> nuevo.ts`: el archivo que existe es el segundo.
    const states = fileStateMap('R  viejo.ts -> nuevo.ts\n')
    expect(states.has('nuevo.ts')).toBe(true)
    expect(states.has('viejo.ts')).toBe(false)
  })

  it('strips the quotes git adds around paths with spaces', () => {
    expect(fileStateMap('M  "con espacio.ts"\n').has('con espacio.ts')).toBe(true)
  })

  it('ignores empty output', () => {
    expect(fileStateMap('').size).toBe(0)
  })
})
