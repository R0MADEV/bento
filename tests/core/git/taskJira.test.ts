import { describe, it, expect } from 'vitest'
import { extractIssueKey, parseAheadBehind } from '../../../src/core/git/taskJira'

describe('extractIssueKey', () => {
  it('extracts the ticket from a feat branch', () => {
    expect(extractIssueKey('feat/IVOZ-1234-add-portal')).toBe('IVOZ-1234')
  })

  it('extracts from any prefix', () => {
    expect(extractIssueKey('fix/ABC-7')).toBe('ABC-7')
  })

  it('extracts a bare key', () => {
    expect(extractIssueKey('KAN-42')).toBe('KAN-42')
  })

  it('returns null when there is no key', () => {
    expect(extractIssueKey('feat/add-portal')).toBeNull()
  })

  it('returns null for null/empty', () => {
    expect(extractIssueKey(null)).toBeNull()
    expect(extractIssueKey('')).toBeNull()
  })

  it('ignores lowercase project codes', () => {
    expect(extractIssueKey('feat/abc-12-thing')).toBeNull()
  })

  it('takes the first key when several appear', () => {
    expect(extractIssueKey('feat/IVOZ-1-and-IVOZ-2')).toBe('IVOZ-1')
  })
})

describe('parseAheadBehind', () => {
  it('parses "left<TAB>right" from rev-list --left-right --count', () => {
    // left = behind (commits in base not in HEAD), right = ahead
    expect(parseAheadBehind('3\t2')).toEqual({ behind: 3, ahead: 2 })
  })

  it('handles spaces instead of tab', () => {
    expect(parseAheadBehind('0 5')).toEqual({ behind: 0, ahead: 5 })
  })

  it('returns zeros for empty/garbage', () => {
    expect(parseAheadBehind('')).toEqual({ behind: 0, ahead: 0 })
    expect(parseAheadBehind('nope')).toEqual({ behind: 0, ahead: 0 })
  })
})
