// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../helpers/localStorage'

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => 256 * 1024 * 1024),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { createAgentStatusBar } from '../../src/ui/agentStatusBar'
import { AGENT_DOCK_EVENT, AGENT_SESSIONS_KEY, type AgentDockEntry } from '../../src/core/terminal/agentDockState'

const emitDock = (entries: AgentDockEntry[]): void => {
  window.dispatchEvent(new CustomEvent(AGENT_DOCK_EVENT, { detail: entries }))
}
const liveEntry = (id: string, name: string): AgentDockEntry => ({ id, name, cwd: '', status: 'idle' })

describe('agent status bar dock', () => {
  beforeEach(() => vi.stubGlobal('localStorage', makeLocalStorage()))
  afterEach(() => {
    vi.unstubAllGlobals()
    invokeMock.mockClear()
  })

  it('starts empty instead of seeding chips from persisted sessions', () => {
    localStorage.setItem(AGENT_SESSIONS_KEY, JSON.stringify([{ name: 'A' }, { name: 'B' }]))
    const bar = createAgentStatusBar({ onOpenAgents: () => {} })
    expect(bar.element.querySelectorAll('.agent-status-chip')).toHaveLength(0)
    bar.dispose()
  })

  it('renders one chip per live agent from the dock event', () => {
    const bar = createAgentStatusBar({ onOpenAgents: () => {} })
    emitDock([liveEntry('pty-1', 'One'), liveEntry('pty-2', 'Two')])
    expect(bar.element.querySelectorAll('.agent-status-chip')).toHaveLength(2)
    bar.dispose()
  })

  it('clicking a chip requests that specific agent by id', () => {
    const opened: (string | undefined)[] = []
    const bar = createAgentStatusBar({ onOpenAgents: id => opened.push(id) })
    emitDock([liveEntry('pty-1', 'One'), liveEntry('pty-2', 'Two')])
    const chips = bar.element.querySelectorAll<HTMLButtonElement>('.agent-status-chip')
    chips[1].click()
    expect(opened).toEqual(['pty-2'])
    bar.dispose()
  })
})
