import { describe, it, expect } from 'vitest'
import { detectAgentCmd, resolveAgentIdentity } from '../../../src/panels/agents/detectAgent'

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

describe('resolveAgentIdentity', () => {
  // The bug this guards: running opencode then codex in the SAME terminal kept
  // cmd='opencode' while the codex session got captured → `opencode --session
  // <codex-id>` → "Invalid session ID". cmd must always follow the latest agent.
  it('always updates cmd to the latest agent run in the terminal', () => {
    expect(resolveAgentIdentity('OpenCode', 'Agent 1', 'codex').cmd).toBe('codex')
    expect(resolveAgentIdentity('Codex', 'Agent 1', 'opencode').cmd).toBe('opencode')
  })

  it('auto-names only while the slot still has its default name', () => {
    expect(resolveAgentIdentity('Agent 1', 'Agent 1', 'codex')).toEqual({ name: 'Codex', cmd: 'codex' })
    expect(resolveAgentIdentity('My name', 'Agent 1', 'opencode')).toEqual({ name: 'My name', cmd: 'opencode' })
  })

  it('keeps the current name if the detected cmd has no known display name', () => {
    expect(resolveAgentIdentity('Agent 1', 'Agent 1', 'weird')).toEqual({ name: 'Agent 1', cmd: 'weird' })
  })
})
