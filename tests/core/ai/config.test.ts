import { describe, it, expect } from 'vitest'
import { parseConfig, buildChatBody, DEFAULT_AI_CONFIG } from '../../../src/core/ai/config'

describe('parseConfig', () => {
  it('returns defaults for null (nothing saved yet)', () => {
    expect(parseConfig(null)).toEqual(DEFAULT_AI_CONFIG)
  })

  it('returns defaults for malformed JSON instead of throwing', () => {
    expect(parseConfig('{broken')).toEqual(DEFAULT_AI_CONFIG)
  })

  it('merges saved values over defaults (forward-compatible with missing keys)', () => {
    const cfg = parseConfig(JSON.stringify({ providerId: 'deepseek' }))
    expect(cfg.providerId).toBe('deepseek')
    expect(cfg.model).toBe(DEFAULT_AI_CONFIG.model)
  })

  it('never carries an API key in the persisted config (keys live in the keychain)', () => {
    const cfg = parseConfig(JSON.stringify({ providerId: 'openai', apiKey: 'sk-secret' }))
    expect(cfg).not.toHaveProperty('apiKey')
    expect(cfg).not.toHaveProperty('apiKeys')
  })
})

describe('buildChatBody', () => {
  it('builds a streaming chat-completions payload', () => {
    const messages = [{ role: 'user' as const, content: 'hi' }]
    expect(buildChatBody(messages, 'gpt-4o-mini')).toEqual({
      model: 'gpt-4o-mini',
      messages,
      stream: true,
    })
  })
})
