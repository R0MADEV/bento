import { describe, it, expect } from 'vitest'
import { pickSubtitleTrack } from '../../../src/core/channel/pickSubtitleTrack'

describe('pickSubtitleTrack', () => {
  it('finds the track matching the preferred language', () => {
    expect(pickSubtitleTrack(['en', 'es', 'fr'], 'es')).toBe(1)
  })

  it('matches ISO-639-2 codes (spa) for Spanish', () => {
    expect(pickSubtitleTrack(['eng', 'spa'], 'es')).toBe(1)
  })

  it('matches regional variants (es-ES)', () => {
    expect(pickSubtitleTrack(['es-ES'], 'es')).toBe(0)
  })

  it('returns -1 when no track matches', () => {
    expect(pickSubtitleTrack(['en', 'fr'], 'es')).toBe(-1)
  })
})
