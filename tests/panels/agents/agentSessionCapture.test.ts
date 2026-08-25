import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => null as unknown) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { buildSessionCapture } from '../../../src/panels/agents/agentSessionCapture'
import type { AgentSlot } from '../../../src/panels/agents/AgentsPanel'

function makeSlot(): AgentSlot {
  return { handle: { getPtyId: () => 'pty-1' }, sessionId: null } as unknown as AgentSlot
}

describe('agent session capture', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.invoke.mockReset()
  })

  afterEach(() => { vi.useRealTimers() })

  async function runCapture(slot: AgentSlot, cmd: string, claimed = new Set<string>()) {
    const onCaptured = vi.fn()
    const capture = buildSessionCapture({ slots: () => [slot], claimedSessionIds: claimed, onCaptured })
    const done = capture(slot, cmd, '/repo', 0)
    await vi.advanceTimersByTimeAsync(600_000)
    await done
    return { onCaptured, claimed }
  }

  it('claims the session a socket agent reports', async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => (cmd === 'agent_get_session' ? 'sess-1' : null))
    const slot = makeSlot()
    const { onCaptured, claimed } = await runCapture(slot, 'claude')
    expect(slot.sessionId).toBe('sess-1')
    expect(claimed.has('sess-1')).toBe(true)
    expect(onCaptured).toHaveBeenCalled()
  })

  it('ignores a session another agent in the panel already claimed', async () => {
    // Sin esto, dos agentes abiertos a la vez se quedarían con el mismo id y
    // reanudar uno reanudaría la conversación del otro.
    mocks.invoke.mockImplementation(async () => 'sess-1')
    const slot = makeSlot()
    const { onCaptured } = await runCapture(slot, 'claude', new Set(['sess-1']))
    expect(slot.sessionId).toBeNull()
    expect(onCaptured).not.toHaveBeenCalled()
  })

  it('does nothing for an agent with no way to report its session', async () => {
    const slot = makeSlot()
    await runCapture(slot, 'mi-cli-propio')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('stops polling once the agent is gone from the panel', async () => {
    mocks.invoke.mockImplementation(async () => null)
    const slot = makeSlot()
    const capture = buildSessionCapture({ slots: () => [], claimedSessionIds: new Set(), onCaptured: vi.fn() })
    await capture(slot, 'claude', '/repo', 0)
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('falls back to the file-based lookup for opencode', async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => (cmd === 'agent_find_opencode_session' ? 'ses_9' : null))
    const slot = makeSlot()
    await runCapture(slot, 'opencode')
    expect(slot.sessionId).toBe('ses_9')
  })
})
