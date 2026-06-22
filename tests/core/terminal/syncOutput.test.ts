import { describe, it, expect } from 'vitest'
import { splitAtSyncBoundary } from '../../../src/core/terminal/syncOutput'

const H = '\x1b[?2026h' // begin synchronized output
const L = '\x1b[?2026l' // end synchronized output

describe('splitAtSyncBoundary', () => {
  it('no markers → flushes everything', () => {
    expect(splitAtSyncBoundary('hello')).toEqual({ flush: 'hello', keep: '' })
  })

  it('a complete frame → flushes everything', () => {
    const buf = `A${H}frame${L}B`
    expect(splitAtSyncBoundary(buf)).toEqual({ flush: buf, keep: '' })
  })

  it('an open frame → flushes before it, keeps from the begin marker', () => {
    expect(splitAtSyncBoundary(`A${H}half`)).toEqual({ flush: 'A', keep: `${H}half` })
  })

  it('a complete frame then an open one → keeps only the open one', () => {
    expect(splitAtSyncBoundary(`${H}one${L}${H}two`)).toEqual({ flush: `${H}one${L}`, keep: `${H}two` })
  })

  it('a partial begin marker at the end → keeps the partial marker', () => {
    expect(splitAtSyncBoundary('A\x1b[?2026')).toEqual({ flush: 'A', keep: '\x1b[?2026' })
  })

  it('a complete frame then a partial marker → keeps the partial marker', () => {
    expect(splitAtSyncBoundary(`${H}one${L}\x1b[?20`)).toEqual({ flush: `${H}one${L}`, keep: '\x1b[?20' })
  })

  it('does not mistake a complete begin marker for a partial', () => {
    expect(splitAtSyncBoundary(`done${H}x${L}`)).toEqual({ flush: `done${H}x${L}`, keep: '' })
  })
})
