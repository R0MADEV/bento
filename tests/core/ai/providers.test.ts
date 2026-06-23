import { describe, it, expect } from 'vitest'
import { AI_PROVIDERS, providerEnvVar, isAiProvider } from '../../../src/core/ai/providers'

describe('providerEnvVar', () => {
  it('maps a provider id to the env var lexis reads', () => {
    expect(providerEnvVar('deepseek')).toBe('DEEPSEEK_API_KEY')
    expect(providerEnvVar('anthropic')).toBe('ANTHROPIC_API_KEY')
  })

  it('matches every preset provider to its expected env var', () => {
    const expected: Record<string, string> = {
      deepseek: 'DEEPSEEK_API_KEY',
      groq: 'GROQ_API_KEY',
      gemini: 'GEMINI_API_KEY',
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
    }
    AI_PROVIDERS.forEach(p => expect(providerEnvVar(p.id)).toBe(expected[p.id]))
  })
})

describe('AI_PROVIDERS', () => {
  it('has unique ids', () => {
    const ids = AI_PROVIDERS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('includes DeepSeek', () => {
    expect(AI_PROVIDERS.some(p => p.id === 'deepseek')).toBe(true)
  })
})

describe('isAiProvider', () => {
  it('accepts known ids', () => {
    expect(isAiProvider('deepseek')).toBe(true)
  })
  it('rejects unknown ids', () => {
    expect(isAiProvider('nope')).toBe(false)
  })
})
