import { describe, expect, it } from 'vitest'
import { AGENT_TYPES, agentLabel, isAgentType, toAgentType } from '../../../src/core/ai/config'

// Qué agentes hay lo decide `bento_review::agents` y el tipo lo genera ts-rs; lo
// que se comprueba aquí es que el panel les da nombre a todos y no acepta otros.
describe('agent catalog', () => {
  it('names every agent the backend declares', () => {
    expect(AGENT_TYPES).toContain('claude')
    expect(AGENT_TYPES).toContain('codex')
    expect(AGENT_TYPES).toContain('opencode')
    for (const agent of AGENT_TYPES) {
      expect(agentLabel(agent), `${agent} no tiene etiqueta`).toBeTruthy()
    }
  })

  it('recognises what is on the list and nothing else', () => {
    expect(isAgentType('claude')).toBe(true)
    expect(isAgentType('gemini')).toBe(false)
    expect(isAgentType(undefined)).toBe(false)
  })

  it('falls back to claude for anything unexpected', () => {
    expect(toAgentType('opencode')).toBe('opencode')
    expect(toAgentType('gemini')).toBe('claude')
    expect(toAgentType('')).toBe('claude')
  })
})
