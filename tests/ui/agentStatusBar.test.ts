import { describe, expect, it } from 'vitest'
import { formatMemoryUsage } from '../../src/ui/agentStatusBar'

describe('formatMemoryUsage', () => {
  it('formats bytes as whole megabytes', () => {
    expect(formatMemoryUsage(256 * 1024 * 1024)).toBe('256 MB')
  })

  it('uses gigabytes for larger footprints', () => {
    expect(formatMemoryUsage(1536 * 1024 * 1024)).toBe('1.5 GB')
  })

  it('rejects invalid readings', () => {
    expect(formatMemoryUsage(Number.NaN)).toBe('—')
    expect(formatMemoryUsage(-1)).toBe('—')
  })
})
