import { describe, it, expect } from 'vitest'
import { parseBulkIssues } from '../../../src/core/jira/bulk'

describe('parseBulkIssues', () => {
  it('reads one issue per line, summary | description', () => {
    expect(parseBulkIssues('Panel Docker | gestionar contenedores\nSQL runner')).toEqual([
      { summary: 'Panel Docker', description: 'gestionar contenedores' },
      { summary: 'SQL runner', description: '' },
    ])
  })

  it('trims and drops blank lines', () => {
    expect(parseBulkIssues('  A  \n\n  B | d \n')).toEqual([
      { summary: 'A', description: '' },
      { summary: 'B', description: 'd' },
    ])
  })

  it('only splits on the first pipe', () => {
    expect(parseBulkIssues('A | b | c')).toEqual([{ summary: 'A', description: 'b | c' }])
  })

  it('returns empty for empty input', () => {
    expect(parseBulkIssues('')).toEqual([])
  })
})
