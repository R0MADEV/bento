import { describe, it, expect } from 'vitest'
import { projectName } from '../../../src/core/session/project'

describe('projectName', () => {
  it('returns the last path segment', () => {
    expect(projectName('/Users/r/Desktop/roma/bento')).toBe('bento')
  })

  it('ignores a trailing slash', () => {
    expect(projectName('/Users/r/bento/')).toBe('bento')
  })

  it('handles Windows separators', () => {
    expect(projectName('C:\\Users\\r\\bento')).toBe('bento')
  })

  it('returns empty for empty or root paths', () => {
    expect(projectName('')).toBe('')
    expect(projectName('/')).toBe('')
  })
})
