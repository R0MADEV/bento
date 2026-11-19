import { describe, expect, it, vi } from 'vitest'
import { createOutputAcks } from '../../../src/core/terminal/outputAcks'

describe('output acks', () => {
  it('holds small paints until they add up to a batch', () => {
    const send = vi.fn()
    const acks = createOutputAcks(send, 100)

    acks.painted(40)
    acks.painted(59)

    expect(send).not.toHaveBeenCalled()
  })

  it('sends the whole accumulated amount once it reaches the batch', () => {
    const send = vi.fn()
    const acks = createOutputAcks(send, 100)

    acks.painted(60)
    acks.painted(70)

    expect(send.mock.calls).toEqual([[130]])
  })

  it('starts a new batch after sending', () => {
    const send = vi.fn()
    const acks = createOutputAcks(send, 100)

    acks.painted(100)
    acks.painted(30)
    acks.painted(80)

    expect(send.mock.calls).toEqual([[100], [110]])
  })
})
