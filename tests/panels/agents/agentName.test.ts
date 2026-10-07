import { describe, expect, it } from 'vitest'
import { isDefaultAgentName, nextAgentName } from '../../../src/panels/agents/agentName'

describe('nextAgentName', () => {
  it('starts at 1', () => {
    expect(nextAgentName([])).toBe('Agent 1')
  })

  it('continues after the open agents', () => {
    expect(nextAgentName(['Agent 1', 'Agent 2'])).toBe('Agent 3')
  })

  it('reuses the number of an agent that was closed', () => {
    expect(nextAgentName(['Agent 1', 'Agent 3'])).toBe('Agent 2')
    expect(nextAgentName(['Agent 19', 'Agent 21'].concat(Array.from({ length: 18 }, (_, i) => `Agent ${i + 1}`)))).toBe('Agent 20')
  })

  it('ignores agents that were renamed', () => {
    expect(nextAgentName(['livekit', 'Claude Code', 'Agent 1'])).toBe('Agent 2')
  })
})

describe('isDefaultAgentName', () => {
  it('tells a default name from one the user or an agent gave', () => {
    expect(isDefaultAgentName('Agent 14')).toBe(true)
    expect(isDefaultAgentName('Agent 14 backup')).toBe(false)
    expect(isDefaultAgentName('livekit')).toBe(false)
  })
})
