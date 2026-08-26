import { describe, expect, it } from 'vitest'
import { icon } from '../../../src/ui/helpers/icons'

describe('icons', () => {
  it.each(['diff', 'review'])('renders the %s icon used by the workspace launcher', name => {
    const markup = icon(name)

    expect(markup).toContain('<svg')
    expect(markup).toContain('<path')
  })
})
