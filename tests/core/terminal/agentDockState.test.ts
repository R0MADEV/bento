// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_ACTIVATE_EVENT, emitAgentActivate } from '../../../src/core/terminal/agentDockState'

describe('emitAgentActivate', () => {
  let handler: ((e: Event) => void) | undefined
  afterEach(() => { if (handler) window.removeEventListener(AGENT_ACTIVATE_EVENT, handler) })

  it('dispatches an activate event carrying the agent id', () => {
    let received: string | undefined
    handler = e => { received = (e as CustomEvent<string>).detail }
    window.addEventListener(AGENT_ACTIVATE_EVENT, handler)
    emitAgentActivate('pty-7')
    expect(received).toBe('pty-7')
  })
})
