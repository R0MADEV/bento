import { describe, expect, it } from 'vitest'
import { icon } from '../../src/ui/icons'

describe('icons', () => {
  it('renders the Tech Review icon used by the workspace launcher', () => {
    const markup = icon('review')

    expect(markup).toContain('<svg')
    expect(markup).toContain('<path')
  })
})
