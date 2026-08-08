import { describe, it, expect } from 'vitest'
import { detectAgentCmd } from '../../../src/panels/agents/detectAgent'

describe('detectAgentCmd', () => {
  it('detects a bare known agent command', () => {
    expect(detectAgentCmd('claude')).toBe('claude')
    expect(detectAgentCmd('opencode')).toBe('opencode')
    expect(detectAgentCmd('codex')).toBe('codex')
  })

  it('ignores arguments after the command', () => {
    expect(detectAgentCmd('claude --resume abc123')).toBe('claude')
    expect(detectAgentCmd('codex resume 019fde20')).toBe('codex')
  })

  it('resolves a full path to its basename', () => {
    expect(detectAgentCmd('/usr/local/bin/claude')).toBe('claude')
    expect(detectAgentCmd('/opt/homebrew/bin/opencode --session x')).toBe('opencode')
  })

  it('skips runner prefixes', () => {
    expect(detectAgentCmd('sudo claude')).toBe('claude')
    expect(detectAgentCmd('npx codex')).toBe('codex')
    expect(detectAgentCmd('command opencode')).toBe('opencode')
  })

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(detectAgentCmd('  CLAUDE  ')).toBe('claude')
  })

  it('returns undefined for unknown or empty commands', () => {
    expect(detectAgentCmd('ls -la')).toBeUndefined()
    expect(detectAgentCmd('echo claude')).toBeUndefined()
    expect(detectAgentCmd('')).toBeUndefined()
    expect(detectAgentCmd('   ')).toBeUndefined()
  })
})
