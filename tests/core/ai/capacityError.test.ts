import { describe, expect, it } from 'vitest'
import { isCapacityError } from '../../../src/core/ai/capacityError'

describe('isCapacityError', () => {
  it('flags token / rate / usage limits so we can switch agents', () => {
    for (const message of ['rate limit exceeded', 'usage limit reached', '429 Too Many Requests', 'model overloaded', 'quota exceeded', 'prompt is too long', 'maximum context length exceeded']) {
      expect(isCapacityError(message)).toBe(true)
    }
  })
  it('does not flag unrelated failures', () => {
    for (const message of ['agent timeout', 'executable not found', 'No conversation found', '']) {
      expect(isCapacityError(message)).toBe(false)
    }
  })
})
