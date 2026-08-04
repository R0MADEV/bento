import { describe, it, expect } from 'vitest'
import { AI_PROVIDERS, providerById } from '../../../src/core/ai/providers'

describe('AI providers', () => {
  it('includes the OpenAI-compatible presets and a custom entry', () => {
    const ids = AI_PROVIDERS.map(p => p.id)
    expect(ids).toContain('openai')
    expect(ids).toContain('deepseek')
    expect(ids).toContain('custom')
  })

  it('every HTTP preset has a base URL and at least one model', () => {
    const localIds = new Set(['custom', 'agent'])
    AI_PROVIDERS.filter(p => !localIds.has(p.id)).forEach(p => {
      expect(p.baseUrl).toMatch(/^https:\/\//)
      expect(p.models.length).toBeGreaterThan(0)
    })
  })

  it('looks up a provider by id', () => {
    expect(providerById('deepseek')?.label).toBe('DeepSeek')
    expect(providerById('nope')).toBeUndefined()
  })
})
